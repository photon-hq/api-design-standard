import {
  createRuleIgnoreMatcher,
  extractPointerContext,
  isPointerContextIgnored,
} from "../../src/ignore.js";
import { JSON_MEDIA_TYPE_RE } from "../../src/openapi-utils.js";
import {
  extractComponentSchemaName,
  isExplicitlyNonObjectNode,
  isRecord,
  locationKey,
  type ResolverFn,
  resolveRecordWithLocation,
  safeResolveRecord as safeResolve,
  type UnknownRecord,
} from "../../src/schema-utils.js";
import { walkSchemaVariants } from "../../src/schema-variants.js";
import type {
  AdsStandardMetadata,
  RedoclyLocation,
  RedoclyOas3Rule,
  RedoclyUserContext,
} from "../../src/types.js";

export const PLUGIN_ID = "photon-ads";

export const ADS_0001_METADATA: AdsStandardMetadata = {
  ads: "0001",
  slug: "ads-0001",
  folder: "0001-resource-identifiers",
  rules: [
    {
      name: "ads-0001-resource-primary-id",
      id: `${PLUGIN_ID}/ads-0001-resource-primary-id`,
      severity: "error",
      summary:
        "Resource objects must use `id` as their primary identifier field rather than a resource-prefixed key.",
    },
    {
      name: "ads-0001-path-param-naming",
      id: `${PLUGIN_ID}/ads-0001-path-param-naming`,
      severity: "error",
      summary:
        "URL path parameters must use lowerCamelCase, with resource-qualified names for resource identifiers (for example `{projectId}`), never generic `{id}`.",
    },
    {
      name: "ads-0001-path-param-consistency",
      id: `${PLUGIN_ID}/ads-0001-path-param-consistency`,
      severity: "error",
      summary:
        "Routes sharing the same parent resource path prefix must use the same path parameter name.",
    },
  ],
};

const GENERIC_PATH_PARAMS = new Set(["id", "uuid", "uid", "guid", "pk"]);
const LOWER_CAMEL_CASE_RE = /^[a-z][a-zA-Z0-9]*$/;
const UPPERCASE_ID_SEGMENT_RE = /ID(?:$|(?=[A-Z]))/;
const PATH_PARAM_TEMPLATE_RE = /\{([^}]*)\}/g;
const FULL_PARAM_SEGMENT_RE = /^\{([^}]+)\}$/;
const CUSTOM_METHOD_PARAM_SEGMENT_RE = /^\{([^}]+)\}:([a-zA-Z0-9_-]+)$/;
const LEAF_ID_PARAM_RE = /\/\{([a-z][a-zA-Z0-9]*Id)\}$/;

const NON_RESOURCE_SCHEMA_SUFFIXES = `
  Request Input Params Query Filter Error Problem ProblemDetails Payload Command
  Patch Update Create DeleteResponse ListResponse Page Pagination Summary Stats
  Count Usage Availability Status Event Webhook Envelope Wrapper Meta Metadata
`
  .trim()
  .split(/\s+/);

const ENVELOPE_SCHEMA_SUFFIXES = ["Envelope", "Wrapper"] as const;

const RESOURCE_SCHEMA_SUFFIXES = [
  "Resource",
  "Response",
  "Details",
  "Detail",
  "Record",
  "Object",
  "Model",
  "Item",
  "Dto",
  "DTO",
] as const;

export function validatePathParamName(rawName: string): string | null {
  const name = rawName.trim();
  if (name.length === 0) {
    return null;
  }
  if (GENERIC_PATH_PARAMS.has(name.toLowerCase())) {
    return `Path parameter "{${rawName}}" uses generic name "${name}". Use a resource-qualified lowerCamelCase name such as "{projectId}" or "{apiKeyId}" (ADS-0001).`;
  }
  if (!LOWER_CAMEL_CASE_RE.test(name)) {
    return `Path parameter "{${rawName}}" must use lowerCamelCase (for example "{projectId}" or "{eventType}"), without underscores, hyphens, or leading capitals (ADS-0001).`;
  }
  if (UPPERCASE_ID_SEGMENT_RE.test(name)) {
    return `Path parameter "{${rawName}}" uses uppercase "ID". Use lowerCamelCase "Id" instead (for example "{projectId}") (ADS-0001).`;
  }
  return null;
}

function snakeToCamelId(name: string): string {
  const parts = name
    .toLowerCase()
    .split("_")
    .filter((part) => part.length > 0);
  if (parts.length <= 1) {
    return "id";
  }
  return parts
    .map((part, index) => (index === 0 ? part : `${part.charAt(0).toUpperCase()}${part.slice(1)}`))
    .join("");
}

export function validateIdPropertyCasing(propName: string): string | null {
  if (propName === "ID" || propName === "Id") {
    return `Property "${propName}" uses invalid identifier casing. Use lowercase "id" for a resource primary identifier (ADS-0001).`;
  }
  if (/_id$/i.test(propName)) {
    const suggested = snakeToCamelId(propName);
    return `Property "${propName}" uses snake_case for an identifier field. Use lowerCamelCase "${suggested}" instead (ADS-0001).`;
  }
  if (propName.endsWith("ID")) {
    const suggested = `${propName.slice(0, -2)}Id`;
    return `Property "${propName}" uses uppercase "ID" suffix. Use lowerCamelCase "${suggested}" instead (ADS-0001).`;
  }
  return null;
}

export interface PathParamSlot {
  prefixKey: string;
  paramName: string;
}

export function extractPathParamSlots(pathTemplate: string): PathParamSlot[] {
  let trimmed = pathTemplate.startsWith("/") ? pathTemplate.slice(1) : pathTemplate;
  if (trimmed.length > 1 && trimmed.endsWith("/") && !trimmed.endsWith("//")) {
    trimmed = trimmed.slice(0, -1);
  }
  if (trimmed.length === 0) {
    return [];
  }

  const segments = trimmed.split("/");
  const normalizedSegments: string[] = [];
  const slots: PathParamSlot[] = [];

  for (const segment of segments) {
    const fullMatch = FULL_PARAM_SEGMENT_RE.exec(segment);
    if (fullMatch?.[1]) {
      const paramName = fullMatch[1].trim();
      if (paramName.length > 0) {
        slots.push({
          prefixKey: `/${[...normalizedSegments, "{*}"].join("/")}`,
          paramName,
        });
      }
      normalizedSegments.push("{*}");
      continue;
    }

    const customMethodMatch = CUSTOM_METHOD_PARAM_SEGMENT_RE.exec(segment);
    if (customMethodMatch?.[1] && customMethodMatch[2]) {
      const paramName = customMethodMatch[1].trim();
      if (paramName.length > 0) {
        slots.push({
          prefixKey: `/${[...normalizedSegments, "{*}"].join("/")}`,
          paramName,
        });
      }
      normalizedSegments.push(`{*}:${customMethodMatch[2]}`);
      continue;
    }

    if (segment.includes("{")) {
      const matches = [...segment.matchAll(PATH_PARAM_TEMPLATE_RE)];
      const normalizedSegment = segment.replace(PATH_PARAM_TEMPLATE_RE, "{*}");
      for (const [index, match] of matches.entries()) {
        const paramName = (match[1] ?? "").trim();
        if (paramName.length > 0) {
          const suffix = matches.length === 1 ? normalizedSegment : `${normalizedSegment}#${index}`;
          slots.push({
            prefixKey: `/${[...normalizedSegments, suffix].join("/")}`,
            paramName,
          });
        }
      }
      normalizedSegments.push(normalizedSegment);
      continue;
    }

    normalizedSegments.push(segment);
  }

  return slots;
}

export function isNonResourceSchemaName(schemaName: string): boolean {
  return NON_RESOURCE_SCHEMA_SUFFIXES.some((suffix) => schemaName.endsWith(suffix));
}

function isNonResourceSummarySchemaName(schemaName: string): boolean {
  return (
    isNonResourceSchemaName(schemaName) &&
    !ENVELOPE_SCHEMA_SUFFIXES.some((suffix) => schemaName.endsWith(suffix))
  );
}

export function deriveResourceStem(schemaName: string): string {
  for (const suffix of RESOURCE_SCHEMA_SUFFIXES) {
    if (schemaName.length > suffix.length && schemaName.endsWith(suffix)) {
      return schemaName.slice(0, -suffix.length);
    }
  }
  return schemaName;
}

type WrapperState =
  | { kind: "none" }
  | { kind: "single"; key: string; inner: CollectedVariant[]; fallbackLocation?: RedoclyLocation }
  | { kind: "multi" };

interface CollectedVariant {
  isObjectLike: boolean;
  isExemptSummary: boolean;
  hasId: boolean;
  matchedTarget?: {
    name: string;
    location?: RedoclyLocation;
  };
  wrapper: WrapperState;
}

interface CollectVariantsOptions {
  matchTarget: (propName: string) => boolean;
  trackWrapper: boolean;
  dedupeTargetByLocation?: boolean;
}

function variantSignature(
  variant: CollectedVariant,
  trackWrapper: boolean,
  dedupeTargetByLocation: boolean,
): string {
  const prefix = `${variant.isObjectLike ? "1" : "0"}:${variant.isExemptSummary ? "1" : "0"}`;
  if (variant.hasId) {
    return `${prefix}:id`;
  }
  if (variant.matchedTarget) {
    const targetLoc =
      dedupeTargetByLocation && variant.matchedTarget.location
        ? locationKey(variant.matchedTarget.location)
        : "";
    return `${prefix}:target:${variant.matchedTarget.name}:${targetLoc}`;
  }
  if (!trackWrapper) {
    return `${prefix}:plain`;
  }
  if (variant.wrapper.kind === "single") {
    const innerKey = variant.wrapper.inner
      .map((inner) => variantSignature(inner, false, false))
      .sort()
      .join("|");
    return `${prefix}:single:${variant.wrapper.key}:[${innerKey}]`;
  }
  return `${prefix}:plain:${variant.wrapper.kind}`;
}

function dedupeVariants(
  list: readonly CollectedVariant[],
  trackWrapper: boolean,
  dedupeTargetByLocation: boolean,
): CollectedVariant[] {
  const bySignature = new Map<string, CollectedVariant>();
  for (const variant of list) {
    const sig = variantSignature(variant, trackWrapper, dedupeTargetByLocation);
    if (!bySignature.has(sig)) {
      bySignature.set(sig, variant);
    }
  }
  return [...bySignature.values()];
}

function mergeInnerVariants(
  base: CollectedVariant[],
  addition: CollectedVariant[],
): CollectedVariant[] {
  if (base.length === 0 || addition.length === 0) {
    return [];
  }
  const combined: CollectedVariant[] = [];
  for (const current of base) {
    for (const incoming of addition) {
      combined.push(mergeCollectedVariants(current, incoming, false, false));
    }
  }
  return dedupeVariants(combined, false, false);
}

function mergeWrapperState(base: WrapperState, addition: WrapperState): WrapperState {
  if (base.kind === "none") {
    return addition;
  }
  if (addition.kind === "none") {
    return base;
  }
  if (base.kind === "multi" || addition.kind === "multi") {
    return { kind: "multi" };
  }
  if (base.key !== addition.key) {
    return { kind: "multi" };
  }
  const fallbackLocation = base.fallbackLocation ?? addition.fallbackLocation;
  return {
    kind: "single",
    key: base.key,
    inner: mergeInnerVariants(base.inner, addition.inner),
    ...(fallbackLocation ? { fallbackLocation } : {}),
  };
}

function mergeCollectedVariants(
  base: CollectedVariant,
  addition: CollectedVariant,
  inheritExemption: boolean,
  trackWrapper: boolean,
): CollectedVariant {
  const isObjectLike = base.isObjectLike || addition.isObjectLike;
  const isExemptSummary = inheritExemption
    ? base.isExemptSummary || addition.isExemptSummary
    : base.isExemptSummary;
  const hasId = base.hasId || addition.hasId;
  const matchedTarget = base.matchedTarget ?? addition.matchedTarget;
  const wrapper: WrapperState =
    !trackWrapper || hasId || matchedTarget
      ? { kind: "multi" }
      : mergeWrapperState(base.wrapper, addition.wrapper);

  return {
    isObjectLike,
    isExemptSummary,
    hasId,
    ...(matchedTarget ? { matchedTarget } : {}),
    wrapper,
  };
}

const EMPTY_COLLECTED_VARIANT: CollectedVariant = {
  isObjectLike: false,
  isExemptSummary: false,
  hasId: false,
  wrapper: { kind: "none" },
};

function collectRawObjectVariants(
  schema: unknown,
  resolve: ResolverFn,
  options: CollectVariantsOptions,
  baseLocation?: RedoclyLocation,
): CollectedVariant[] {
  const dedupeTargetByLocation = options.dedupeTargetByLocation ?? true;

  const resolveOwnSchemaName = (
    node: Record<string, unknown>,
    location: RedoclyLocation | undefined,
  ): string | undefined =>
    extractComponentSchemaName(location?.pointer) ??
    (typeof node.$ref === "string"
      ? extractComponentSchemaName(node.$ref, { decodeUri: true })
      : undefined);

  const combineVariantSets = (
    currentSet: readonly CollectedVariant[],
    incomingSet: readonly CollectedVariant[],
    inheritExemption: boolean,
  ): CollectedVariant[] => {
    if (incomingSet.length === 0) {
      return [...currentSet];
    }
    const combined: CollectedVariant[] = [];
    for (const current of currentSet) {
      for (const incoming of incomingSet) {
        combined.push(
          mergeCollectedVariants(current, incoming, inheritExemption, options.trackWrapper),
        );
      }
    }
    return dedupeVariants(combined, options.trackWrapper, dedupeTargetByLocation);
  };

  return [
    ...walkSchemaVariants<CollectedVariant>(schema, resolve, baseLocation, {
      emptyVariant: EMPTY_COLLECTED_VARIANT,
      onCycle: "empty",
      reverseRefChain: false,
      skipNode: (node) => isExplicitlyNonObjectNode(node),
      initNode: (node, location) => {
        const ownSchemaName = resolveOwnSchemaName(node, location);
        const isOwnExemptSummary =
          ownSchemaName !== undefined && isNonResourceSummarySchemaName(ownSchemaName);
        return {
          ...EMPTY_COLLECTED_VARIANT,
          isExemptSummary: isOwnExemptSummary,
        };
      },
      extractLocal: (node, location) => {
        let directObjectLike =
          node.type === "object" || (Array.isArray(node.type) && node.type.includes("object"));
        let directHasId = false;
        let directMatchedTarget: { name: string; location?: RedoclyLocation } | undefined;
        let directWrapper: WrapperState = { kind: "none" };

        if (isRecord(node.properties)) {
          directObjectLike = true;
          const propEntries = Object.entries(node.properties);
          for (const [propName] of propEntries) {
            const propLocation = location?.child(["properties", propName]);
            if (propName === "id") {
              directHasId = true;
            } else if (!directMatchedTarget && options.matchTarget(propName)) {
              directMatchedTarget = {
                name: propName,
                ...(propLocation ? { location: propLocation } : {}),
              };
            }
          }
          if (options.trackWrapper && !directHasId && !directMatchedTarget) {
            if (propEntries.length === 1) {
              const singleEntry = propEntries[0];
              if (singleEntry) {
                const [wrapperKey, wrapperSchema] = singleEntry;
                const propLocation = location?.child(["properties", wrapperKey]);
                const inner = collectRawObjectVariants(
                  wrapperSchema,
                  resolve,
                  {
                    matchTarget: options.matchTarget,
                    trackWrapper: false,
                    dedupeTargetByLocation: false,
                  },
                  propLocation,
                );
                directWrapper = {
                  kind: "single",
                  key: wrapperKey,
                  inner,
                  ...(propLocation ? { fallbackLocation: propLocation } : {}),
                };
              }
            } else if (propEntries.length > 1) {
              directWrapper = { kind: "multi" };
            }
          }
        }

        if (
          !directObjectLike &&
          !directHasId &&
          !directMatchedTarget &&
          directWrapper.kind === "none"
        ) {
          return [];
        }
        return [
          {
            isObjectLike: directObjectLike,
            isExemptSummary: false,
            hasId: directHasId,
            ...(directMatchedTarget ? { matchedTarget: directMatchedTarget } : {}),
            wrapper: directWrapper,
          },
        ];
      },
      dedupeUnion: (branchVariants) =>
        dedupeVariants(branchVariants, options.trackWrapper, dedupeTargetByLocation),
      combine: (current, incoming, context) => {
        const isPureUnion =
          context.isUnion &&
          resolveOwnSchemaName(context.node, context.location) === undefined &&
          typeof context.node.$ref !== "string" &&
          !Array.isArray(context.node.allOf) &&
          !isRecord(context.node.properties) &&
          context.node.type === undefined;
        return { variants: combineVariantSets(current, incoming, isPureUnion) };
      },
    }).variants,
  ];
}

function collectObjectVariants(
  schema: unknown,
  resolve: ResolverFn,
  options: CollectVariantsOptions,
  baseLocation?: RedoclyLocation,
): CollectedVariant[] {
  return collectRawObjectVariants(schema, resolve, options, baseLocation).filter(
    (variant) => variant.isObjectLike,
  );
}

export const ads0001PathParamNaming: RedoclyOas3Rule = (options = {}) => {
  const ignoreMatcher = createRuleIgnoreMatcher(options);
  const reportedInlineParameters = new Set<string>();
  const reusableParamCandidates = new Map<string, { location: RedoclyLocation; message: string }>();
  const reusableParamIgnored = new Set<string>();
  const reusableParamActive = new Set<string>();
  const pathStack: Array<{ path: string; allOpsIgnored: boolean }> = [];
  const methodStack: string[] = [];

  const recordReusableParamRefs = (
    rawParams: unknown,
    ctx: RedoclyUserContext,
    isUsageIgnored: boolean,
  ): void => {
    if (!Array.isArray(rawParams)) {
      return;
    }
    const from = ctx.location.source?.absoluteRef;
    const inComponentPathItem = ctx.location.pointer.startsWith("#/components/pathItems/");
    for (const [index, rawParam] of rawParams.entries()) {
      if (!isRecord(rawParam)) {
        continue;
      }
      let paramNode: UnknownRecord | undefined;
      let paramLocation: RedoclyLocation | undefined;
      if (typeof rawParam.$ref === "string") {
        const resolved = safeResolve(ctx.resolve, rawParam, from);
        paramNode = resolved?.node;
        paramLocation = resolved?.location;
      } else if (inComponentPathItem) {
        paramNode = rawParam;
        paramLocation = ctx.location.child(["parameters", index]);
      }
      if (
        !paramNode ||
        !paramLocation ||
        paramNode.in !== "path" ||
        typeof paramNode.name !== "string"
      ) {
        continue;
      }
      const nameLocation = paramLocation.child(["name"]);
      const dedupeKey = `${locationKey(nameLocation)}:${paramNode.name}`;
      if (isUsageIgnored) {
        reusableParamIgnored.add(dedupeKey);
      } else {
        reusableParamActive.add(dedupeKey);
      }
    }
  };

  return {
    Paths: {
      PathItem: {
        enter(pathItem, ctx) {
          const pathTemplate = String(ctx.key);
          const allOpsIgnored = ignoreMatcher.areAllPathOperationsIgnored(pathTemplate, pathItem);
          pathStack.push({ path: pathTemplate, allOpsIgnored });
          if (isRecord(pathItem)) {
            recordReusableParamRefs(pathItem.parameters, ctx, allOpsIgnored);
          }
          if (allOpsIgnored) {
            return;
          }
          for (const match of pathTemplate.matchAll(PATH_PARAM_TEMPLATE_RE)) {
            const paramName = match[1] ?? "";
            const error = validatePathParamName(paramName);
            if (error) {
              ctx.report({
                message: error,
                location: (ctx.rawLocation ?? ctx.location).key(),
              });
            }
          }
        },
        leave() {
          pathStack.pop();
        },
        Operation: {
          enter(operation, ctx) {
            const method = String(ctx.key).toLowerCase();
            methodStack.push(method);
            const currentPathItem = pathStack[pathStack.length - 1];
            if (currentPathItem !== undefined && isRecord(operation)) {
              const opIgnored = ignoreMatcher.isIgnored({ path: currentPathItem.path, method });
              recordReusableParamRefs(operation.parameters, ctx, opIgnored);
            }
          },
          leave() {
            methodStack.pop();
          },
        },
      },
    },
    Parameter: {
      leave(param, ctx) {
        if (!isRecord(param) || param.in !== "path" || typeof param.name !== "string") {
          return;
        }
        const error = validatePathParamName(param.name);
        if (!error) {
          return;
        }

        const pointerCtx = extractPointerContext(ctx.location.pointer);
        const currentPathItem = pathStack[pathStack.length - 1];
        const currentMethod = methodStack[methodStack.length - 1];
        const nameLocation = ctx.location.child(["name"]);
        const dedupeKey = `${locationKey(nameLocation)}:${param.name}`;

        if (pointerCtx.path !== undefined) {
          if (
            isPointerContextIgnored(ignoreMatcher, pointerCtx) ||
            (pointerCtx.method === undefined &&
              currentPathItem !== undefined &&
              currentPathItem.path === pointerCtx.path &&
              currentPathItem.allOpsIgnored)
          ) {
            return;
          }
          if (reportedInlineParameters.has(dedupeKey)) {
            return;
          }
          reportedInlineParameters.add(dedupeKey);
          ctx.report({
            message: error,
            location: nameLocation,
          });
          return;
        }

        if (!reusableParamCandidates.has(dedupeKey)) {
          reusableParamCandidates.set(dedupeKey, { location: nameLocation, message: error });
        }
        if (currentPathItem !== undefined) {
          const usageIgnored =
            currentMethod !== undefined
              ? ignoreMatcher.isIgnored({ path: currentPathItem.path, method: currentMethod })
              : currentPathItem.allOpsIgnored;
          if (usageIgnored) {
            reusableParamIgnored.add(dedupeKey);
          } else {
            reusableParamActive.add(dedupeKey);
          }
        }
      },
    },
    Root: {
      leave(_root, ctx) {
        for (const [dedupeKey, candidate] of reusableParamCandidates.entries()) {
          if (reusableParamIgnored.has(dedupeKey) && !reusableParamActive.has(dedupeKey)) {
            continue;
          }
          ctx.report({
            message: candidate.message,
            location: candidate.location,
          });
        }
      },
    },
  };
};

function formatRouteSummary(routes: readonly string[]): string {
  if (routes.length <= 2) {
    return routes.join(", ");
  }
  const remaining = routes.length - 2;
  return `${routes[0]}, ${routes[1]}, and ${remaining} more`;
}

export const ads0001PathParamConsistency: RedoclyOas3Rule = (options = {}) => {
  const ignoreMatcher = createRuleIgnoreMatcher(options);

  return {
    Paths: {
      leave(paths, ctx) {
        if (!isRecord(paths)) {
          return;
        }

        const slots = new Map<string, Map<string, string[]>>();

        for (const [pathTemplate, rawPathItem] of Object.entries(paths)) {
          if (!pathTemplate.startsWith("/")) {
            continue;
          }
          let pathItem: unknown = rawPathItem;
          if (isRecord(rawPathItem) && typeof rawPathItem.$ref === "string") {
            const resolved = safeResolve(
              ctx.resolve,
              rawPathItem,
              ctx.location.child([pathTemplate]).source?.absoluteRef,
            );
            if (resolved?.node) {
              pathItem = resolved.node;
            }
          }
          if (ignoreMatcher.areAllPathOperationsIgnored(pathTemplate, pathItem)) {
            continue;
          }
          for (const { prefixKey, paramName } of extractPathParamSlots(pathTemplate)) {
            let byParam = slots.get(prefixKey);
            if (!byParam) {
              byParam = new Map<string, string[]>();
              slots.set(prefixKey, byParam);
            }
            const routes = byParam.get(paramName) ?? [];
            routes.push(pathTemplate);
            byParam.set(paramName, routes);
          }
        }

        for (const [prefixKey, byParam] of slots.entries()) {
          if (byParam.size <= 1) {
            continue;
          }

          const entries = [...byParam.entries()].map(([name, routes], order) => ({
            name,
            routes,
            order,
            valid: validatePathParamName(name) === null,
          }));

          entries.sort((a, b) => {
            if (a.valid !== b.valid) {
              return a.valid ? -1 : 1;
            }
            if (a.routes.length !== b.routes.length) {
              return b.routes.length - a.routes.length;
            }
            return a.order - b.order;
          });

          const canonical = entries[0];
          if (!canonical) {
            continue;
          }

          const allVariants = entries
            .map((entry) => `"{${entry.name}}" (${formatRouteSummary(entry.routes)})`)
            .join(" vs ");

          for (const conflict of entries.slice(1)) {
            for (const route of conflict.routes) {
              ctx.report({
                message: `Inconsistent path parameter "{${conflict.name}}" for prefix "${prefixKey}"; conflicts with "{${canonical.name}}" used in "${canonical.routes[0]}". Conflicting definitions: ${allVariants} (ADS-0001).`,
                location: ctx.location.child([route]).key(),
              });
            }
          }
        }
      },
    },
  };
};

export const ads0001ResourcePrimaryId: RedoclyOas3Rule = (options = {}) => {
  const ignoreMatcher = createRuleIgnoreMatcher(options);
  const reportedCasing = new Set<string>();
  const reportedPrimaryIds = new Set<string>();

  const reportPrimaryIdOnce = (
    ctx: RedoclyUserContext,
    reportLocation: RedoclyLocation,
    message: string,
  ): void => {
    const key = locationKey(reportLocation);
    if (reportedPrimaryIds.has(key)) {
      return;
    }
    reportedPrimaryIds.add(key);
    ctx.report({
      message,
      location: reportLocation,
    });
  };

  return {
    Schema: {
      enter(schema, ctx) {
        if (!isRecord(schema) || !isRecord(schema.properties)) {
          return;
        }
        const pointerCtx = extractPointerContext(ctx.location.pointer);
        if (isPointerContextIgnored(ignoreMatcher, pointerCtx)) {
          return;
        }

        for (const propName of Object.keys(schema.properties)) {
          const error = validateIdPropertyCasing(propName);
          if (!error) {
            continue;
          }
          const propLocation = ctx.location.child(["properties", propName]).key();
          const dedupeKey = `${locationKey(propLocation)}:${propName}`;
          if (reportedCasing.has(dedupeKey)) {
            continue;
          }
          reportedCasing.add(dedupeKey);
          ctx.report({
            message: error,
            location: propLocation,
          });
        }
      },
    },
    Root: {
      leave(root, ctx) {
        if (!isRecord(root)) {
          return;
        }

        const components = isRecord(root.components) ? root.components : null;
        const schemas = components && isRecord(components.schemas) ? components.schemas : null;

        if (schemas) {
          for (const [schemaName, rawSchema] of Object.entries(schemas)) {
            if (isNonResourceSchemaName(schemaName)) {
              continue;
            }
            if (ignoreMatcher.isIgnored({ schema: schemaName })) {
              continue;
            }
            const stem = deriveResourceStem(schemaName);
            if (stem.length === 0) {
              continue;
            }
            const schemaLocation = ctx.location.child(["components", "schemas", schemaName]);
            const normalizedStem = stem.toLowerCase();
            const variants = collectObjectVariants(
              rawSchema,
              ctx.resolve,
              {
                matchTarget: (propName) =>
                  propName.length > 2 &&
                  propName.endsWith("Id") &&
                  propName.slice(0, -2).toLowerCase() === normalizedStem,
                trackWrapper: false,
              },
              schemaLocation,
            );

            for (const variant of variants) {
              if (!variant.isObjectLike || variant.hasId || !variant.matchedTarget) {
                continue;
              }
              const reportLocation = variant.matchedTarget.location
                ? variant.matchedTarget.location.key()
                : schemaLocation.key();
              const targetSchema = extractPointerContext(reportLocation.pointer).schema;
              if (targetSchema !== undefined && ignoreMatcher.isIgnored({ schema: targetSchema })) {
                continue;
              }
              reportPrimaryIdOnce(
                ctx,
                reportLocation,
                `Resource schema "${schemaName}" defines resource-prefixed identifier "${variant.matchedTarget.name}" without "id". Resource objects must use "id" as their primary identifier field (ADS-0001).`,
              );
            }
          }
        }

        const paths = isRecord(root.paths) ? root.paths : null;
        if (!paths) {
          return;
        }

        for (const [pathTemplate, rawPathItem] of Object.entries(paths)) {
          if (!pathTemplate.startsWith("/")) {
            continue;
          }
          if (ignoreMatcher.isIgnored({ path: pathTemplate, method: "get" })) {
            continue;
          }
          const normalizedPath = pathTemplate.replace(/\/+$/, "");
          const leafMatch = LEAF_ID_PARAM_RE.exec(normalizedPath);
          if (!leafMatch?.[1]) {
            continue;
          }
          const leafParam = leafMatch[1];

          const resolvedPathItem = resolveRecordWithLocation(
            ctx.resolve,
            rawPathItem,
            ctx.location.child(["paths", pathTemplate]),
          );
          if (!resolvedPathItem || !isRecord(resolvedPathItem.node.get)) {
            continue;
          }

          const pathItemLocation = resolvedPathItem.location;
          const getOp = resolvedPathItem.node.get;
          if (!isRecord(getOp.responses)) {
            continue;
          }

          const responseKey = isRecord(getOp.responses["200"])
            ? "200"
            : isRecord(getOp.responses["2XX"])
              ? "2XX"
              : null;
          if (!responseKey) {
            continue;
          }
          const resolvedResponse = resolveRecordWithLocation(
            ctx.resolve,
            getOp.responses[responseKey],
            pathItemLocation.child(["get", "responses", responseKey]),
          );
          if (!resolvedResponse || !isRecord(resolvedResponse.node.content)) {
            continue;
          }

          const responseLocation = resolvedResponse.location;
          const successContent = resolvedResponse.node.content;

          for (const [mediaType, mediaObj] of Object.entries(successContent)) {
            if (!JSON_MEDIA_TYPE_RE.test(mediaType)) {
              continue;
            }
            if (!isRecord(mediaObj) || !isRecord(mediaObj.schema)) {
              continue;
            }

            const topRefSchema =
              typeof mediaObj.schema.$ref === "string"
                ? (extractComponentSchemaName(mediaObj.schema.$ref, { decodeUri: true }) ?? null)
                : null;
            if (
              topRefSchema !== null &&
              ignoreMatcher.isIgnored({ path: pathTemplate, method: "get", schema: topRefSchema })
            ) {
              continue;
            }

            const schemaLocation = responseLocation.child(["content", mediaType, "schema"]);
            const topVariants = collectObjectVariants(
              mediaObj.schema,
              ctx.resolve,
              { matchTarget: (propName) => propName === leafParam, trackWrapper: true },
              schemaLocation,
            );

            const isIgnoredGetReport = (reportLocation: RedoclyLocation): boolean => {
              const reportSchema = extractPointerContext(reportLocation.pointer).schema;
              return (
                reportSchema !== undefined &&
                ignoreMatcher.isIgnored({ path: pathTemplate, method: "get", schema: reportSchema })
              );
            };

            for (const top of topVariants) {
              if (!top.isObjectLike || top.isExemptSummary || top.hasId) {
                continue;
              }

              if (top.matchedTarget) {
                const reportLocation = top.matchedTarget.location
                  ? top.matchedTarget.location.key()
                  : schemaLocation.key();
                if (isIgnoredGetReport(reportLocation)) {
                  continue;
                }
                reportPrimaryIdOnce(
                  ctx,
                  reportLocation,
                  `GET item endpoint "${pathTemplate}" returns "${leafParam}" without "id". Single-resource responses must use "id" as the resource primary identifier field (ADS-0001).`,
                );
                continue;
              }

              if (top.wrapper.kind === "single") {
                const wrapperKey = top.wrapper.key;
                const fallbackLocation =
                  top.wrapper.fallbackLocation?.key() ?? schemaLocation.key();
                for (const inner of top.wrapper.inner) {
                  if (!inner.isObjectLike || inner.isExemptSummary || inner.hasId) {
                    continue;
                  }
                  if (inner.matchedTarget) {
                    const reportLocation = inner.matchedTarget.location
                      ? inner.matchedTarget.location.key()
                      : fallbackLocation;
                    if (isIgnoredGetReport(reportLocation)) {
                      continue;
                    }
                    reportPrimaryIdOnce(
                      ctx,
                      reportLocation,
                      `GET item endpoint "${pathTemplate}" returns wrapped resource "${wrapperKey}" with "${leafParam}" instead of "id". Resource objects must use "id" as their primary identifier field (ADS-0001).`,
                    );
                  }
                }
              }
            }
          }
        }
      },
    },
  };
};

export const ads0001Rules: Record<string, RedoclyOas3Rule> = {
  "ads-0001-resource-primary-id": ads0001ResourcePrimaryId,
  "ads-0001-path-param-naming": ads0001PathParamNaming,
  "ads-0001-path-param-consistency": ads0001PathParamConsistency,
};
