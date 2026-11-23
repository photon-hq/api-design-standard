import { createRuleIgnoreMatcher, HTTP_METHODS } from "../../src/ignore.js";
import {
  isRecord,
  locationKey,
  type ResolverFn,
  resolveRecordWithLocation,
  safeResolveSchema,
  type UnknownRecord,
  walkSchemaLattice,
} from "../../src/schema-utils.js";
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
const JSON_MEDIA_TYPE_RE = /^application\/(?!problem\+json(?:\s*;|$))(?:[^;]+\+)?json(?:\s*;|$)/i;
const GENERIC_ENVELOPE_KEY_RE = /^(?:data|result|payload)$/i;
const SECRET_OR_TOKEN_PROP_RE = /^(?:secret|token|[a-z][a-zA-Z0-9]*(?:Secret|Token))$/;

type JsonSchemaType = "object" | "array" | "string" | "number" | "integer" | "boolean" | "null";

const ALL_JSON_TYPES: readonly JsonSchemaType[] = [
  "object",
  "array",
  "string",
  "number",
  "integer",
  "boolean",
  "null",
];

const ALL_JSON_TYPE_SET: ReadonlySet<JsonSchemaType> = new Set(ALL_JSON_TYPES);
const EMPTY_TYPE_SET: ReadonlySet<JsonSchemaType> = new Set();

function isJsonSchemaType(value: unknown): value is JsonSchemaType {
  return typeof value === "string" && ALL_JSON_TYPE_SET.has(value as JsonSchemaType);
}

function jsonTypeOfValue(value: unknown): JsonSchemaType | null {
  if (value === null) {
    return "null";
  }
  if (Array.isArray(value)) {
    return "array";
  }
  switch (typeof value) {
    case "string":
      return "string";
    case "boolean":
      return "boolean";
    case "number":
      return Number.isInteger(value) ? "integer" : "number";
    case "object":
      return "object";
    default:
      return null;
  }
}

interface TypeConstraint {
  readonly allowed: ReadonlySet<JsonSchemaType>;
  readonly explicit: ReadonlySet<JsonSchemaType>;
  readonly conflictNonObject: ReadonlySet<JsonSchemaType>;
}

const UNCONSTRAINED_TYPE_CONSTRAINT: TypeConstraint = {
  allowed: ALL_JSON_TYPE_SET,
  explicit: EMPTY_TYPE_SET,
  conflictNonObject: EMPTY_TYPE_SET,
};

const FALSE_TYPE_CONSTRAINT: TypeConstraint = {
  allowed: EMPTY_TYPE_SET,
  explicit: EMPTY_TYPE_SET,
  conflictNonObject: EMPTY_TYPE_SET,
};

function intersectTypeSets(
  a: ReadonlySet<JsonSchemaType>,
  b: ReadonlySet<JsonSchemaType>,
): Set<JsonSchemaType> {
  const out = new Set<JsonSchemaType>();
  for (const t of a) {
    if (b.has(t)) {
      out.add(t);
    } else if ((t === "integer" && b.has("number")) || (t === "number" && b.has("integer"))) {
      out.add("integer");
    }
  }
  return out;
}

function combineTypeConstraintAllOf(a: TypeConstraint, b: TypeConstraint): TypeConstraint {
  const allowed = intersectTypeSets(a.allowed, b.allowed);
  const mergedExplicit = new Set<JsonSchemaType>(a.explicit);
  for (const t of b.explicit) {
    mergedExplicit.add(t);
  }
  const explicit = intersectTypeSets(mergedExplicit, allowed);
  const conflictNonObject = new Set<JsonSchemaType>(a.conflictNonObject);
  for (const t of b.conflictNonObject) {
    conflictNonObject.add(t);
  }
  if (a.allowed.size > 0 && b.allowed.size > 0 && allowed.size === 0) {
    for (const t of mergedExplicit) {
      if (t !== "object") {
        conflictNonObject.add(t);
      }
    }
  }
  return { allowed, explicit, conflictNonObject };
}

function combineTypeConstraintUnion(
  values: readonly TypeConstraint[],
  unionKey: "oneOf" | "anyOf",
): TypeConstraint {
  if (values.length === 0) {
    return UNCONSTRAINED_TYPE_CONSTRAINT;
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

function localTypeConstraint(node: UnknownRecord): TypeConstraint {
  let result = UNCONSTRAINED_TYPE_CONSTRAINT;

  if (typeof node.type === "string" && isJsonSchemaType(node.type)) {
    const types = new Set<JsonSchemaType>([node.type]);
    result = combineTypeConstraintAllOf(result, {
      allowed: types,
      explicit: types,
      conflictNonObject: EMPTY_TYPE_SET,
    });
  } else if (Array.isArray(node.type)) {
    const validTypes = node.type.filter(isJsonSchemaType);
    if (validTypes.length > 0) {
      const types = new Set<JsonSchemaType>(validTypes);
      result = combineTypeConstraintAllOf(result, {
        allowed: types,
        explicit: types,
        conflictNonObject: EMPTY_TYPE_SET,
      });
    }
  }

  if (node.const !== undefined) {
    const constType = jsonTypeOfValue(node.const);
    if (constType !== null) {
      const types = new Set<JsonSchemaType>([constType]);
      result = combineTypeConstraintAllOf(result, {
        allowed: types,
        explicit: types,
        conflictNonObject: EMPTY_TYPE_SET,
      });
    }
  }

  if (Array.isArray(node.enum) && node.enum.length > 0) {
    const enumTypes = new Set<JsonSchemaType>();
    for (const item of node.enum) {
      const itemType = jsonTypeOfValue(item);
      if (itemType !== null) {
        enumTypes.add(itemType);
      }
    }
    if (enumTypes.size > 0) {
      result = combineTypeConstraintAllOf(result, {
        allowed: enumTypes,
        explicit: enumTypes,
        conflictNonObject: EMPTY_TYPE_SET,
      });
    }
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

function computeTypeConstraint(
  schema: unknown,
  resolve: ResolverFn,
  from?: string,
): TypeConstraint {
  return walkSchemaLattice(schema, resolve, from, {
    falseValue: FALSE_TYPE_CONSTRAINT,
    unknownValue: UNCONSTRAINED_TYPE_CONSTRAINT,
    local: localTypeConstraint,
    combineAllOf: combineTypeConstraintAllOf,
    combineUnion: combineTypeConstraintUnion,
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

function isNonNullableObjectConstraint(tc: TypeConstraint): boolean {
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

function isStringTypeConstraint(tc: TypeConstraint): boolean {
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
  return computeTypeConstraint(schema, resolve, from).explicit.has("null");
}

export function isStringTypedSchema(schema: unknown, resolve: ResolverFn, from?: string): boolean {
  return isStringTypeConstraint(computeTypeConstraint(schema, resolve, from));
}

export function findNonObjectTopLevelKinds(
  schema: unknown,
  resolve: ResolverFn,
  from?: string,
): readonly JsonSchemaType[] {
  const tc = computeTypeConstraint(schema, resolve, from);
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
  if (!isNonNullableObjectConstraint(computeTypeConstraint(schema, resolve, from))) {
    return false;
  }
  return classifyStructuredObject(schema, resolve, from) === "structured";
}

interface SchemaFragment {
  readonly node: unknown;
  readonly from?: string;
}

interface TrackedProperty {
  readonly name: string;
  readonly fragments: readonly SchemaFragment[];
  readonly location?: RedoclyLocation;
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

interface CollectSummariesResult {
  readonly summaries: readonly TopLevelObjectSummary[];
  readonly hitCycle: boolean;
}

function mergeTrackedProperty(
  existing: TrackedProperty | undefined,
  incoming: TrackedProperty,
): TrackedProperty {
  if (!existing) {
    return incoming;
  }
  const fragments: SchemaFragment[] = [...existing.fragments];
  for (const frag of incoming.fragments) {
    if (!fragments.some((prev) => prev.node === frag.node && prev.from === frag.from)) {
      fragments.push(frag);
    }
  }
  const location = existing.location ?? incoming.location;
  return {
    name: existing.name,
    fragments,
    ...(location ? { location } : {}),
  };
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

function mergeGenericMap(
  base: ReadonlyMap<string, TrackedProperty>,
  addition: ReadonlyMap<string, TrackedProperty>,
): Map<string, TrackedProperty> {
  const merged = new Map<string, TrackedProperty>(base);
  for (const [name, prop] of addition.entries()) {
    merged.set(name, mergeTrackedProperty(merged.get(name), prop));
  }
  return merged;
}

function mergeObjectSummaries(
  base: TopLevelObjectSummary,
  addition: TopLevelObjectSummary,
): TopLevelObjectSummary {
  return {
    isObjectLike: base.isObjectLike || addition.isObjectLike,
    openAdditionalProperties: base.openAdditionalProperties || addition.openAdditionalProperties,
    propertiesState: mergePropertiesState(base.propertiesState, addition.propertiesState),
    genericEnvelopeProps: mergeGenericMap(base.genericEnvelopeProps, addition.genericEnvelopeProps),
  };
}

function propertyTypeConstraint(prop: TrackedProperty, resolve: ResolverFn): TypeConstraint {
  let combined = UNCONSTRAINED_TYPE_CONSTRAINT;
  for (const frag of prop.fragments) {
    combined = combineTypeConstraintAllOf(
      combined,
      computeTypeConstraint(frag.node, resolve, frag.from),
    );
  }
  return combined;
}

function propertyStructuredKind(prop: TrackedProperty, resolve: ResolverFn): StructuredObjectKind {
  let combined: StructuredObjectKind = "unknown";
  for (const frag of prop.fragments) {
    combined = combineStructuredAllOf(
      combined,
      classifyStructuredObject(frag.node, resolve, frag.from),
    );
    if (combined === "non-object") {
      return "non-object";
    }
  }
  return combined;
}

function isPropertyNonNullableStructuredObject(
  prop: TrackedProperty,
  resolve: ResolverFn,
): boolean {
  if (prop.fragments.length === 0) {
    return false;
  }
  if (!isNonNullableObjectConstraint(propertyTypeConstraint(prop, resolve))) {
    return false;
  }
  return propertyStructuredKind(prop, resolve) === "structured";
}

function isPropertyStringTyped(prop: TrackedProperty, resolve: ResolverFn): boolean {
  if (prop.fragments.length === 0) {
    return false;
  }
  return isStringTypeConstraint(propertyTypeConstraint(prop, resolve));
}

function propertySignature(prop: TrackedProperty, resolve: ResolverFn): string {
  const structKind = propertyStructuredKind(prop, resolve);
  const tc = propertyTypeConstraint(prop, resolve);
  const allowedSig = ALL_JSON_TYPES.filter((t) => tc.allowed.has(t)).join("|");
  const explicitSig = ALL_JSON_TYPES.filter((t) => tc.explicit.has(t)).join("|");
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

function isExplicitlyNonObjectNode(node: UnknownRecord): boolean {
  if (typeof node.type === "string") {
    return node.type !== "object";
  }
  if (Array.isArray(node.type)) {
    return !node.type.includes("object");
  }
  return node.items !== undefined;
}

function collectTopLevelObjectSummaries(
  schema: unknown,
  resolve: ResolverFn,
  baseLocation: RedoclyLocation,
): readonly TopLevelObjectSummary[] {
  const memo = new Map<object, Map<string, CollectSummariesResult>>();

  const emptySummary: TopLevelObjectSummary = {
    isObjectLike: false,
    openAdditionalProperties: false,
    propertiesState: { kind: "exact", props: new Map() },
    genericEnvelopeProps: new Map(),
  };

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

  const visit = (
    node: unknown,
    location: RedoclyLocation | undefined,
    seen: ReadonlySet<unknown>,
    followRef: boolean,
  ): CollectSummariesResult => {
    if (node === true) {
      return { summaries: [emptySummary], hitCycle: false };
    }
    if (node === false || !isRecord(node) || isExplicitlyNonObjectNode(node)) {
      return { summaries: [], hitCycle: false };
    }
    if (seen.has(node)) {
      return { summaries: [], hitCycle: true };
    }

    const cacheKey = `${followRef ? 1 : 0}:${location?.source?.absoluteRef ?? ""}#${location?.pointer ?? ""}`;
    const cached = memo.get(node)?.get(cacheKey);
    if (cached) {
      return cached;
    }

    const nextSeen = new Set(seen);
    nextSeen.add(node);

    let hitCycle = false;
    let summaries: TopLevelObjectSummary[] = [emptySummary];

    const applyConjunctiveResult = (res: CollectSummariesResult): void => {
      if (res.hitCycle) {
        hitCycle = true;
      }
      if (res.summaries.length === 0 && !res.hitCycle) {
        summaries = [];
      } else {
        summaries = combineSets(summaries, res.summaries);
      }
    };

    if (followRef && typeof node.$ref === "string") {
      const resolved = safeResolveSchema(resolve, node, location?.source?.absoluteRef);
      if (resolved) {
        if (resolved.node !== undefined) {
          applyConjunctiveResult(visit(resolved.node, resolved.location, nextSeen, true));
        }
        for (const hop of resolved.chain ?? []) {
          if (
            summaries.length === 0 ||
            !isRecord(hop.node) ||
            hop.node === node ||
            hop.node === resolved.node
          ) {
            continue;
          }
          applyConjunctiveResult(visit(hop.node, hop.location, nextSeen, false));
        }
      }
    }

    if (summaries.length > 0 && Array.isArray(node.allOf)) {
      for (const [index, branch] of node.allOf.entries()) {
        applyConjunctiveResult(visit(branch, location?.child(["allOf", index]), nextSeen, true));
        if (summaries.length === 0) {
          break;
        }
      }
    }

    if (summaries.length > 0) {
      const openAdditionalProperties =
        node.additionalProperties === true || isRecord(node.additionalProperties);
      const hasObjectType =
        node.type === "object" || (Array.isArray(node.type) && node.type.includes("object"));
      const directProps = new Map<string, TrackedProperty>();
      const directGeneric = new Map<string, TrackedProperty>();
      let directPropsMany = false;

      if (isRecord(node.properties)) {
        const entries = Object.entries(node.properties);
        const from = location?.source?.absoluteRef;
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

      if (directObjectLike) {
        summaries = combineSets(summaries, [
          {
            isObjectLike: true,
            openAdditionalProperties,
            propertiesState: directPropsMany
              ? { kind: "many" }
              : { kind: "exact", props: directProps },
            genericEnvelopeProps: directGeneric,
          },
        ]);
      }
    }

    if (summaries.length > 0) {
      for (const unionKey of ["oneOf", "anyOf"] as const) {
        const branches = node[unionKey];
        if (!Array.isArray(branches) || branches.length === 0) {
          continue;
        }
        const branchSummaries: TopLevelObjectSummary[] = [];
        let branchHitCycle = false;
        for (const [index, branch] of branches.entries()) {
          const branchResult = visit(branch, location?.child([unionKey, index]), nextSeen, true);
          if (branchResult.hitCycle) {
            hitCycle = true;
            branchHitCycle = true;
          }
          branchSummaries.push(...branchResult.summaries);
        }
        if (branchSummaries.length === 0) {
          if (!branchHitCycle) {
            summaries = [];
            break;
          }
        } else {
          summaries = combineSets(summaries, dedupeSummaries(branchSummaries, resolve));
        }
      }
    }

    const result: CollectSummariesResult = { summaries, hitCycle };
    if (!hitCycle) {
      let nodeCache = memo.get(node);
      if (!nodeCache) {
        nodeCache = new Map();
        memo.set(node, nodeCache);
      }
      nodeCache.set(cacheKey, result);
    }
    return result;
  };

  return visit(schema, baseLocation, new Set(), true).summaries.filter(
    (summary) => summary.isObjectLike,
  );
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
  root: unknown,
  ctx: RedoclyUserContext,
  options: Record<string, unknown>,
  methodFilter?: (method: string) => boolean,
): SuccessJsonResponseEntry[] {
  if (!isRecord(root) || !isRecord(root.paths)) {
    return [];
  }

  const ignoreMatcher = createRuleIgnoreMatcher(options);
  const results: SuccessJsonResponseEntry[] = [];

  for (const [pathTemplate, rawPathItem] of Object.entries(root.paths)) {
    if (!pathTemplate.startsWith("/")) {
      continue;
    }

    const resolvedPathItem = resolveRecordWithLocation(
      ctx.resolve,
      rawPathItem,
      ctx.location.child(["paths", pathTemplate]),
    );
    if (!resolvedPathItem) {
      continue;
    }

    const { node: pathItem, location: pathItemLocation } = resolvedPathItem;

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

      for (const [statusCode, rawResponse] of Object.entries(operation.responses)) {
        if (statusCode === "204" || !SUCCESS_STATUS_RE.test(statusCode)) {
          continue;
        }
        const operationResponseLocation = pathItemLocation.child([method, "responses", statusCode]);
        const resolvedResponse = resolveRecordWithLocation(
          ctx.resolve,
          rawResponse,
          operationResponseLocation,
        );
        if (!resolvedResponse || !isRecord(resolvedResponse.node.content)) {
          continue;
        }

        const { location: responseLocation, resolvedFromRef } = resolvedResponse;
        const responseContent = resolvedResponse.node.content;

        for (const [mediaType, mediaObj] of Object.entries(responseContent)) {
          if (!JSON_MEDIA_TYPE_RE.test(mediaType)) {
            continue;
          }
          if (!isRecord(mediaObj) || mediaObj.schema === undefined) {
            continue;
          }
          const schemaLocation = responseLocation.child(["content", mediaType, "schema"]);
          const reportBaseLocation = resolvedFromRef ? operationResponseLocation : schemaLocation;
          results.push({
            pathTemplate,
            method,
            statusCode,
            mediaType,
            schema: mediaObj.schema,
            schemaLocation,
            reportBaseLocation,
          });
        }
      }
    }
  }

  return results;
}

function selectPropertyReportLocation(
  prop: TrackedProperty,
  schemaLocation: RedoclyLocation,
  reportBaseLocation: RedoclyLocation,
): RedoclyLocation {
  if (
    prop.location &&
    prop.location.source?.absoluteRef === reportBaseLocation.source?.absoluteRef &&
    prop.location.pointer.startsWith(`${schemaLocation.pointer}/`)
  ) {
    return prop.location.key();
  }
  return reportBaseLocation;
}

export const ads0002TopLevelJsonObject: RedoclyOas3Rule = (options = {}) => {
  return {
    Root: {
      leave(root, ctx) {
        const responses = collectSuccessJsonResponses(root, ctx, options);
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
    },
  };
};

export const ads0002NoSingleResourceWrapper: RedoclyOas3Rule = (options = {}) => {
  return {
    Root: {
      leave(root, ctx) {
        const responses = collectSuccessJsonResponses(root, ctx, options);
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
            const dedupeKey = `${locationKey(reportLocation)}:${prop.name}`;
            if (reportedProps.has(dedupeKey)) {
              return;
            }
            reportedProps.add(dedupeKey);
            ctx.report({ message, location: reportLocation });
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
    },
  };
};

export const ads0002FlatCreationSecret: RedoclyOas3Rule = (options = {}) => {
  return {
    Root: {
      leave(root, ctx) {
        const responses = collectSuccessJsonResponses(
          root,
          ctx,
          options,
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

            const pairKey = `${locationKey(entry.reportBaseLocation)}:${resourceProp.name}:${secretProp.name}`;
            if (reportedPairs.has(pairKey)) {
              continue;
            }
            reportedPairs.add(pairKey);
            ctx.report({
              message: `POST "${entry.pathTemplate}" (${entry.statusCode} ${entry.mediaType}) wraps created resource "${resourceProp.name}" alongside one-time secret field "${secretProp.name}". Return the resource fields flat at the top level with "${secretProp.name}" as a sibling top-level property (ADS-0002).`,
              location: entry.reportBaseLocation,
            });
          }
        }
      },
    },
  };
};

export const ads0002Rules: Record<string, RedoclyOas3Rule> = {
  "ads-0002-top-level-json-object": ads0002TopLevelJsonObject,
  "ads-0002-no-single-resource-wrapper": ads0002NoSingleResourceWrapper,
  "ads-0002-flat-creation-secret": ads0002FlatCreationSecret,
};
