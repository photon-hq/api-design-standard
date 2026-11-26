import { HTTP_METHODS, type RuleIgnoreMatcher } from "../../src/ignore.js";
import {
  createRootRule,
  extractResponseJsonSchemas,
  iterateRootPathItems,
  reportOnce,
} from "../../src/openapi-utils.js";
import {
  ALL_JSON_TYPE_SET,
  ALL_JSON_TYPES,
  EMPTY_TYPE_SET,
  extractNodeDeclaredTypeSets,
  foldSchemaFragments,
  formatAllowedTypes,
  intersectTypeSets,
  isExplicitlyNonObjectNode,
  isRecord,
  type JsonSchemaType,
  jsonTypeOfValue,
  mergeTrackedProperty,
  mergeTrackedPropertyMaps,
  type ResolverFn,
  selectPropertyReportLocation,
  type TrackedProperty,
  type UnknownRecord,
  walkSchemaLattice,
} from "../../src/schema-utils.js";
import { walkSchemaVariants } from "../../src/schema-variants.js";
import type {
  AdsStandardMetadata,
  RedoclyLocation,
  RedoclyOas3Rule,
  RedoclyUserContext,
} from "../../src/types.js";
import { PLUGIN_ID } from "../0001-resource-identifiers/rules.js";

export const ADS_0002_METADATA: AdsStandardMetadata = {
  ads: "0002",
  slug: "ads-0002",
  folder: "0002-top-level-json-response",
  rules: [
    {
      name: "ads-0002-top-level-json-object",
      id: `${PLUGIN_ID}/ads-0002-top-level-json-object`,
      severity: "error",
      summary:
        "Every 2xx JSON response must have a JSON object at the top level rather than a bare array or primitive value.",
    },
    {
      name: "ads-0002-no-single-resource-wrapper",
      id: `${PLUGIN_ID}/ads-0002-no-single-resource-wrapper`,
      severity: "error",
      summary:
        "Single-resource 2xx JSON responses must return resource fields directly at the top level rather than wrapping them in a single-key resource envelope or a generic `data`, `result`, or `payload` envelope.",
    },
    {
      name: "ads-0002-flat-creation-secret",
      id: `${PLUGIN_ID}/ads-0002-flat-creation-secret`,
      severity: "error",
      summary:
        "POST creation responses that return a one-time secret or token must return the resource flat at the top level with the secret as a sibling field rather than wrapping the resource and secret in a two-key envelope.",
    },
  ],
};

const SUCCESS_STATUS_RE = /^2(?:\d\d|XX)$/i;
const GENERIC_ENVELOPE_KEY_RE = /^(?:data|result|payload)$/i;
const SECRET_OR_TOKEN_PROP_RE = /^(?:secret|token|[a-z][a-zA-Z0-9]*(?:Secret|Token))$/;

interface DetailedTypeConstraint {
  readonly allowed: ReadonlySet<JsonSchemaType>;
  readonly explicit: ReadonlySet<JsonSchemaType>;
  readonly conflictNonObject: ReadonlySet<JsonSchemaType>;
}

const UNCONSTRAINED_DETAILED_CONSTRAINT: DetailedTypeConstraint = {
  allowed: ALL_JSON_TYPE_SET,
  explicit: EMPTY_TYPE_SET,
  conflictNonObject: EMPTY_TYPE_SET,
};

const FALSE_DETAILED_CONSTRAINT: DetailedTypeConstraint = {
  allowed: EMPTY_TYPE_SET,
  explicit: EMPTY_TYPE_SET,
  conflictNonObject: EMPTY_TYPE_SET,
};

function combineDetailedAllOf(
  a: DetailedTypeConstraint,
  b: DetailedTypeConstraint,
): DetailedTypeConstraint {
  const allowed = intersectTypeSets(a.allowed, b.allowed);
  const mergedExplicit = new Set<JsonSchemaType>([...a.explicit, ...b.explicit]);
  const explicit = intersectTypeSets(mergedExplicit, allowed);
  const conflictNonObject = new Set<JsonSchemaType>([
    ...a.conflictNonObject,
    ...b.conflictNonObject,
  ]);
  if (a.allowed.size > 0 && b.allowed.size > 0 && allowed.size === 0) {
    for (const t of mergedExplicit) {
      if (t !== "object") {
        conflictNonObject.add(t);
      }
    }
  }
  return { allowed, explicit, conflictNonObject };
}

function combineDetailedUnion(
  values: readonly DetailedTypeConstraint[],
  unionKey: "oneOf" | "anyOf",
): DetailedTypeConstraint {
  if (values.length === 0) {
    return UNCONSTRAINED_DETAILED_CONSTRAINT;
  }
  const allowed = new Set<JsonSchemaType>();
  const explicit = new Set<JsonSchemaType>();
  const conflictNonObject = new Set<JsonSchemaType>();
  let explicitNullBranches = 0;

  for (const item of values) {
    for (const t of item.allowed) {
      allowed.add(t);
    }
    for (const t of item.explicit) {
      explicit.add(t);
    }
    for (const t of item.conflictNonObject) {
      conflictNonObject.add(t);
    }
    if (item.explicit.has("null")) {
      explicitNullBranches += 1;
    }
  }

  if (unionKey === "oneOf" && explicitNullBranches >= 2) {
    allowed.delete("null");
    explicit.delete("null");
  }

  return { allowed, explicit, conflictNonObject };
}

function localDetailedTypeConstraint(node: UnknownRecord): DetailedTypeConstraint {
  let result = UNCONSTRAINED_DETAILED_CONSTRAINT;

  for (const types of extractNodeDeclaredTypeSets(node, false)) {
    result = combineDetailedAllOf(result, {
      allowed: types,
      explicit: types,
      conflictNonObject: EMPTY_TYPE_SET,
    });
  }

  if (node.items !== undefined && result.allowed.has("array") && !result.explicit.has("array")) {
    const explicit = new Set<JsonSchemaType>(result.explicit);
    explicit.add("array");
    result = {
      allowed: result.allowed,
      explicit,
      conflictNonObject: result.conflictNonObject,
    };
  }

  return result;
}

function computeDetailedTypeConstraint(
  schema: unknown,
  resolve: ResolverFn,
  from?: string,
): DetailedTypeConstraint {
  return walkSchemaLattice(schema, resolve, from, {
    falseValue: FALSE_DETAILED_CONSTRAINT,
    unknownValue: UNCONSTRAINED_DETAILED_CONSTRAINT,
    local: localDetailedTypeConstraint,
    combineAllOf: combineDetailedAllOf,
    combineUnion: combineDetailedUnion,
    finalize(node, value) {
      if (node.nullable !== true) {
        return value;
      }
      const allowed = new Set<JsonSchemaType>(value.allowed);
      allowed.add("null");
      const explicit = new Set<JsonSchemaType>(value.explicit);
      explicit.add("null");
      return {
        allowed,
        explicit,
        conflictNonObject: value.conflictNonObject,
      };
    },
  });
}

function isNonNullableObjectConstraint(tc: DetailedTypeConstraint): boolean {
  if (!tc.allowed.has("object") || tc.explicit.has("null")) {
    return false;
  }
  for (const t of tc.explicit) {
    if (t !== "object") {
      return false;
    }
  }
  return true;
}

function isStringTypeConstraint(tc: DetailedTypeConstraint): boolean {
  if (!tc.allowed.has("string")) {
    return false;
  }
  for (const t of tc.allowed) {
    if (t !== "string" && t !== "null") {
      return false;
    }
  }
  return true;
}

export function isNullableSchema(schema: unknown, resolve: ResolverFn, from?: string): boolean {
  return computeDetailedTypeConstraint(schema, resolve, from).explicit.has("null");
}

export function isStringTypedSchema(schema: unknown, resolve: ResolverFn, from?: string): boolean {
  return isStringTypeConstraint(computeDetailedTypeConstraint(schema, resolve, from));
}

export function findNonObjectTopLevelKinds(
  schema: unknown,
  resolve: ResolverFn,
  from?: string,
): readonly JsonSchemaType[] {
  const tc = computeDetailedTypeConstraint(schema, resolve, from);
  return ALL_JSON_TYPES.filter(
    (t) => t !== "object" && (tc.explicit.has(t) || tc.conflictNonObject.has(t)),
  );
}

type StructuredObjectKind = "non-object" | "unknown" | "empty-object" | "structured";

function combineStructuredAllOf(
  a: StructuredObjectKind,
  b: StructuredObjectKind,
): StructuredObjectKind {
  if (a === "non-object" || b === "non-object") {
    return "non-object";
  }
  if (a === "structured" || b === "structured") {
    return "structured";
  }
  if (a === "empty-object" || b === "empty-object") {
    return "empty-object";
  }
  return "unknown";
}

function combineStructuredUnion(kinds: readonly StructuredObjectKind[]): StructuredObjectKind {
  if (kinds.length === 0) {
    return "unknown";
  }
  if (kinds.some((kind) => kind === "non-object")) {
    return "non-object";
  }
  if (kinds.every((kind) => kind === "structured")) {
    return "structured";
  }
  if (kinds.every((kind) => kind === "structured" || kind === "empty-object")) {
    return "empty-object";
  }
  return "unknown";
}

function localStructuredKind(node: UnknownRecord): StructuredObjectKind {
  if (typeof node.type === "string" && node.type !== "object") {
    return "non-object";
  }
  if (Array.isArray(node.type) && !node.type.includes("object")) {
    return "non-object";
  }
  if (node.type === undefined && node.items !== undefined) {
    return "non-object";
  }
  if (node.const !== undefined && jsonTypeOfValue(node.const) !== "object") {
    return "non-object";
  }
  if (
    Array.isArray(node.enum) &&
    node.enum.length > 0 &&
    !node.enum.some((value) => jsonTypeOfValue(value) === "object")
  ) {
    return "non-object";
  }
  if (isRecord(node.properties) && Object.keys(node.properties).length > 0) {
    return "structured";
  }
  if (
    node.type === "object" ||
    (Array.isArray(node.type) && node.type.includes("object")) ||
    isRecord(node.properties) ||
    node.additionalProperties !== undefined
  ) {
    return "empty-object";
  }
  return "unknown";
}

function classifyStructuredObject(
  schema: unknown,
  resolve: ResolverFn,
  from?: string,
): StructuredObjectKind {
  return walkSchemaLattice(schema, resolve, from, {
    falseValue: "non-object",
    unknownValue: "unknown",
    isAbsorbing: (value) => value === "non-object",
    local: localStructuredKind,
    combineAllOf: combineStructuredAllOf,
    combineUnion: combineStructuredUnion,
  });
}

export function isNonNullableStructuredObject(
  schema: unknown,
  resolve: ResolverFn,
  from?: string,
): boolean {
  if (!isRecord(schema)) {
    return false;
  }
  if (!isNonNullableObjectConstraint(computeDetailedTypeConstraint(schema, resolve, from))) {
    return false;
  }
  return classifyStructuredObject(schema, resolve, from) === "structured";
}

type PropertiesState =
  | { readonly kind: "exact"; readonly props: ReadonlyMap<string, TrackedProperty> }
  | { readonly kind: "many" };

interface TopLevelObjectSummary {
  readonly isObjectLike: boolean;
  readonly openAdditionalProperties: boolean;
  readonly propertiesState: PropertiesState;
  readonly genericEnvelopeProps: ReadonlyMap<string, TrackedProperty>;
}

function mergePropertiesState(base: PropertiesState, addition: PropertiesState): PropertiesState {
  if (base.kind === "many" || addition.kind === "many") {
    return { kind: "many" };
  }
  const merged = new Map<string, TrackedProperty>(base.props);
  for (const [name, prop] of addition.props.entries()) {
    merged.set(name, mergeTrackedProperty(merged.get(name), prop));
    if (merged.size > 2) {
      return { kind: "many" };
    }
  }
  return { kind: "exact", props: merged };
}

function mergeObjectSummaries(
  base: TopLevelObjectSummary,
  addition: TopLevelObjectSummary,
): TopLevelObjectSummary {
  return {
    isObjectLike: base.isObjectLike || addition.isObjectLike,
    openAdditionalProperties: base.openAdditionalProperties || addition.openAdditionalProperties,
    propertiesState: mergePropertiesState(base.propertiesState, addition.propertiesState),
    genericEnvelopeProps: mergeTrackedPropertyMaps(
      base.genericEnvelopeProps,
      addition.genericEnvelopeProps,
    ),
  };
}

function propertyDetailedTypeConstraint(
  prop: TrackedProperty,
  resolve: ResolverFn,
): DetailedTypeConstraint {
  return foldSchemaFragments(
    prop.fragments,
    UNCONSTRAINED_DETAILED_CONSTRAINT,
    combineDetailedAllOf,
    (frag) => computeDetailedTypeConstraint(frag.node, resolve, frag.from),
  );
}

function propertyStructuredKind(prop: TrackedProperty, resolve: ResolverFn): StructuredObjectKind {
  return foldSchemaFragments<StructuredObjectKind>(
    prop.fragments,
    "unknown",
    combineStructuredAllOf,
    (frag) => classifyStructuredObject(frag.node, resolve, frag.from),
    (acc) => acc === "non-object",
  );
}

function isPropertyNonNullableStructuredObject(
  prop: TrackedProperty,
  resolve: ResolverFn,
): boolean {
  if (prop.fragments.length === 0) {
    return false;
  }
  if (!isNonNullableObjectConstraint(propertyDetailedTypeConstraint(prop, resolve))) {
    return false;
  }
  return propertyStructuredKind(prop, resolve) === "structured";
}

function isPropertyStringTyped(prop: TrackedProperty, resolve: ResolverFn): boolean {
  if (prop.fragments.length === 0) {
    return false;
  }
  return isStringTypeConstraint(propertyDetailedTypeConstraint(prop, resolve));
}

function propertySignature(prop: TrackedProperty, resolve: ResolverFn): string {
  const structKind = propertyStructuredKind(prop, resolve);
  const tc = propertyDetailedTypeConstraint(prop, resolve);
  const allowedSig = formatAllowedTypes(tc.allowed);
  const explicitSig = formatAllowedTypes(tc.explicit);
  return `${prop.name}:${structKind}:${allowedSig}:${explicitSig}`;
}

function summarySignature(summary: TopLevelObjectSummary, resolve: ResolverFn): string {
  const prefix = `${summary.isObjectLike ? "1" : "0"}:${summary.openAdditionalProperties ? "1" : "0"}`;
  const genericSig = [...summary.genericEnvelopeProps.values()]
    .map((prop) => propertySignature(prop, resolve))
    .sort()
    .join(",");
  if (summary.propertiesState.kind === "many") {
    return `${prefix}:many:[${genericSig}]`;
  }
  const propSig = [...summary.propertiesState.props.values()]
    .map((prop) => propertySignature(prop, resolve))
    .sort()
    .join(",");
  return `${prefix}:exact:[${propSig}]:[${genericSig}]`;
}

function dedupeSummaries(
  list: readonly TopLevelObjectSummary[],
  resolve: ResolverFn,
): TopLevelObjectSummary[] {
  const bySignature = new Map<string, TopLevelObjectSummary>();
  for (const summary of list) {
    const sig = summarySignature(summary, resolve);
    if (!bySignature.has(sig)) {
      bySignature.set(sig, summary);
    }
  }
  return [...bySignature.values()];
}

const EMPTY_OBJECT_SUMMARY: TopLevelObjectSummary = {
  isObjectLike: false,
  openAdditionalProperties: false,
  propertiesState: { kind: "exact", props: new Map() },
  genericEnvelopeProps: new Map(),
};

function collectTopLevelObjectSummaries(
  schema: unknown,
  resolve: ResolverFn,
  baseLocation: RedoclyLocation,
): readonly TopLevelObjectSummary[] {
  const combineSets = (
    currentSet: readonly TopLevelObjectSummary[],
    incomingSet: readonly TopLevelObjectSummary[],
  ): TopLevelObjectSummary[] => {
    if (incomingSet.length === 0) {
      return [...currentSet];
    }
    const combined: TopLevelObjectSummary[] = [];
    for (const current of currentSet) {
      for (const incoming of incomingSet) {
        combined.push(mergeObjectSummaries(current, incoming));
      }
    }
    return dedupeSummaries(combined, resolve);
  };

  return walkSchemaVariants<TopLevelObjectSummary>(schema, resolve, baseLocation, {
    emptyVariant: EMPTY_OBJECT_SUMMARY,
    onCycle: "empty",
    reverseRefChain: false,
    skipNode: (node) => isExplicitlyNonObjectNode(node, { treatItemsAsArray: true }),
    extractLocal: (node, location, from) => {
      const openAdditionalProperties =
        node.additionalProperties === true || isRecord(node.additionalProperties);
      const hasObjectType =
        node.type === "object" || (Array.isArray(node.type) && node.type.includes("object"));
      const directProps = new Map<string, TrackedProperty>();
      const directGeneric = new Map<string, TrackedProperty>();
      let directPropsMany = false;

      if (isRecord(node.properties)) {
        const entries = Object.entries(node.properties);
        if (entries.length > 2) {
          directPropsMany = true;
        }
        for (const [propName, propSchema] of entries) {
          const propLocation = location?.child(["properties", propName]);
          const tracked: TrackedProperty = {
            name: propName,
            fragments: [{ node: propSchema, ...(from !== undefined ? { from } : {}) }],
            ...(propLocation ? { location: propLocation } : {}),
          };
          if (!directPropsMany) {
            directProps.set(propName, tracked);
          }
          if (GENERIC_ENVELOPE_KEY_RE.test(propName)) {
            directGeneric.set(propName, tracked);
          }
        }
      }

      const directObjectLike =
        hasObjectType || isRecord(node.properties) || node.additionalProperties !== undefined;
      if (!directObjectLike) {
        return [];
      }
      return [
        {
          isObjectLike: true,
          openAdditionalProperties,
          propertiesState: directPropsMany
            ? { kind: "many" }
            : { kind: "exact", props: directProps },
          genericEnvelopeProps: directGeneric,
        },
      ];
    },
    dedupeUnion: (branchSummaries) => dedupeSummaries(branchSummaries, resolve),
    combine: (current, incoming) => ({ variants: combineSets(current, incoming) }),
  }).variants.filter((summary) => summary.isObjectLike);
}

interface SuccessJsonResponseEntry {
  readonly pathTemplate: string;
  readonly method: string;
  readonly statusCode: string;
  readonly mediaType: string;
  readonly schema: unknown;
  readonly schemaLocation: RedoclyLocation;
  readonly reportBaseLocation: RedoclyLocation;
}

function collectSuccessJsonResponses(
  root: UnknownRecord,
  ctx: RedoclyUserContext,
  ignoreMatcher: RuleIgnoreMatcher,
  methodFilter?: (method: string) => boolean,
): SuccessJsonResponseEntry[] {
  const results: SuccessJsonResponseEntry[] = [];

  for (const pathEntry of iterateRootPathItems(root, ctx)) {
    const { pathTemplate, pathItem } = pathEntry;
    if (!pathItem) {
      continue;
    }

    for (const method of HTTP_METHODS) {
      if (methodFilter && !methodFilter(method)) {
        continue;
      }
      const operation = pathItem[method];
      if (!isRecord(operation) || !isRecord(operation.responses)) {
        continue;
      }
      if (ignoreMatcher.isIgnored({ path: pathTemplate, method })) {
        continue;
      }

      const opLocation = pathEntry.operationLocation(method);
      for (const [statusCode, rawResponse] of Object.entries(operation.responses)) {
        if (statusCode === "204" || !SUCCESS_STATUS_RE.test(statusCode)) {
          continue;
        }
        const operationResponseLocation = opLocation.child(["responses", statusCode]);
        for (const entry of extractResponseJsonSchemas(
          rawResponse,
          operationResponseLocation,
          ctx.resolve,
        )) {
          const reportBaseLocation = entry.responseFromRef
            ? operationResponseLocation
            : entry.schemaLocation;
          results.push({
            pathTemplate,
            method,
            statusCode,
            mediaType: entry.mediaType,
            schema: entry.schema,
            schemaLocation: entry.schemaLocation,
            reportBaseLocation,
          });
        }
      }
    }
  }

  return results;
}

export const ads0002TopLevelJsonObject: RedoclyOas3Rule = createRootRule(
  ({ root, ctx, ignoreMatcher }) => {
    const responses = collectSuccessJsonResponses(root, ctx, ignoreMatcher);
    for (const entry of responses) {
      const disallowed = findNonObjectTopLevelKinds(
        entry.schema,
        ctx.resolve,
        entry.schemaLocation.source?.absoluteRef,
      );
      if (disallowed.length === 0) {
        continue;
      }
      const formatted = disallowed.map((kind) => `"${kind}"`).join(", ");
      ctx.report({
        message: `${entry.method.toUpperCase()} "${entry.pathTemplate}" (${entry.statusCode} ${entry.mediaType}) allows non-object top-level JSON type (${formatted}). Every 2xx JSON response must have a JSON object at the root (ADS-0002).`,
        location: entry.reportBaseLocation,
      });
    }
  },
);

export const ads0002NoSingleResourceWrapper: RedoclyOas3Rule = createRootRule(
  ({ root, ctx, ignoreMatcher }) => {
    const responses = collectSuccessJsonResponses(root, ctx, ignoreMatcher);
    for (const entry of responses) {
      const summaries = collectTopLevelObjectSummaries(
        entry.schema,
        ctx.resolve,
        entry.schemaLocation,
      );
      const reportedProps = new Set<string>();
      const reportWrappedProp = (prop: TrackedProperty, message: string): void => {
        const reportLocation = selectPropertyReportLocation(
          prop,
          entry.schemaLocation,
          entry.reportBaseLocation,
        );
        reportOnce(ctx, reportedProps, prop.name, reportLocation, message);
      };

      for (const summary of summaries) {
        const singleKeyProp =
          !summary.openAdditionalProperties &&
          summary.propertiesState.kind === "exact" &&
          summary.propertiesState.props.size === 1
            ? [...summary.propertiesState.props.values()][0]
            : undefined;

        for (const [propName, prop] of summary.genericEnvelopeProps.entries()) {
          if (!isPropertyNonNullableStructuredObject(prop, ctx.resolve)) {
            continue;
          }
          reportWrappedProp(
            prop,
            `${entry.method.toUpperCase()} "${entry.pathTemplate}" (${entry.statusCode} ${entry.mediaType}) wraps a structured object under generic envelope key "${propName}". Return single-resource fields directly at the top level instead of using a generic "${propName}" envelope (ADS-0002).`,
          );
        }

        if (
          singleKeyProp &&
          !GENERIC_ENVELOPE_KEY_RE.test(singleKeyProp.name) &&
          isPropertyNonNullableStructuredObject(singleKeyProp, ctx.resolve)
        ) {
          reportWrappedProp(
            singleKeyProp,
            `${entry.method.toUpperCase()} "${entry.pathTemplate}" (${entry.statusCode} ${entry.mediaType}) wraps a single resource inside top-level key "${singleKeyProp.name}". Return resource fields directly at the top level instead of using a single-key wrapper envelope (ADS-0002).`,
          );
        }
      }
    }
  },
);

export const ads0002FlatCreationSecret: RedoclyOas3Rule = createRootRule(
  ({ root, ctx, ignoreMatcher }) => {
    const responses = collectSuccessJsonResponses(
      root,
      ctx,
      ignoreMatcher,
      (method) => method === "post",
    );

    for (const entry of responses) {
      const summaries = collectTopLevelObjectSummaries(
        entry.schema,
        ctx.resolve,
        entry.schemaLocation,
      );
      const reportedPairs = new Set<string>();

      for (const summary of summaries) {
        if (
          summary.openAdditionalProperties ||
          summary.propertiesState.kind !== "exact" ||
          summary.propertiesState.props.size !== 2
        ) {
          continue;
        }

        const [first, second] = [...summary.propertiesState.props.values()];
        if (!first || !second) {
          continue;
        }

        let resourceProp: TrackedProperty | undefined;
        let secretProp: TrackedProperty | undefined;

        if (
          isPropertyNonNullableStructuredObject(first, ctx.resolve) &&
          SECRET_OR_TOKEN_PROP_RE.test(second.name) &&
          isPropertyStringTyped(second, ctx.resolve)
        ) {
          resourceProp = first;
          secretProp = second;
        } else if (
          isPropertyNonNullableStructuredObject(second, ctx.resolve) &&
          SECRET_OR_TOKEN_PROP_RE.test(first.name) &&
          isPropertyStringTyped(first, ctx.resolve)
        ) {
          resourceProp = second;
          secretProp = first;
        }

        if (!resourceProp || !secretProp) {
          continue;
        }

        reportOnce(
          ctx,
          reportedPairs,
          `${resourceProp.name}:${secretProp.name}`,
          entry.reportBaseLocation,
          `POST "${entry.pathTemplate}" (${entry.statusCode} ${entry.mediaType}) wraps created resource "${resourceProp.name}" alongside one-time secret field "${secretProp.name}". Return the resource fields flat at the top level with "${secretProp.name}" as a sibling top-level property (ADS-0002).`,
        );
      }
    }
  },
);

export const ads0002Rules: Record<string, RedoclyOas3Rule> = {
  "ads-0002-top-level-json-object": ads0002TopLevelJsonObject,
  "ads-0002-no-single-resource-wrapper": ads0002NoSingleResourceWrapper,
  "ads-0002-flat-creation-secret": ads0002FlatCreationSecret,
};
