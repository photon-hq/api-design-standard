import type {
  AdsStandardMetadata,
  RedoclyLocation,
  RedoclyOas3Rule,
  RedoclyResolveResult,
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
const JSON_MEDIA_TYPE_RE = /^application\/(?!problem\+json)(?:[^;]+\+)?json\b/i;
const COMPONENT_SCHEMA_POINTER_RE = /#\/components\/schemas\/([^/]+)$/;

const NON_RESOURCE_SCHEMA_SUFFIXES = [
  "Request",
  "Input",
  "Params",
  "Query",
  "Filter",
  "Error",
  "Problem",
  "ProblemDetails",
  "Payload",
  "Command",
  "Patch",
  "Update",
  "Create",
  "DeleteResponse",
  "ListResponse",
  "Page",
  "Pagination",
  "Summary",
  "Stats",
  "Count",
  "Usage",
  "Availability",
  "Status",
  "Event",
  "Webhook",
  "Envelope",
  "Wrapper",
  "Meta",
  "Metadata",
] as const;

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

type UnknownRecord = Record<string, unknown>;

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function locationKey(location: RedoclyLocation): string {
  return location.absolutePointer ?? `${location.source?.absoluteRef ?? ""}#${location.pointer}`;
}

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

function unescapeJsonPointerToken(token: string): string {
  return token.replaceAll("~1", "/").replaceAll("~0", "~");
}

function extractComponentSchemaNameFromLocation(pointer?: string): string | null {
  if (!pointer) {
    return null;
  }
  const match = COMPONENT_SCHEMA_POINTER_RE.exec(pointer);
  return match?.[1] ? unescapeJsonPointerToken(match[1]) : null;
}

function extractComponentSchemaNameFromRef(ref?: string): string | null {
  if (!ref) {
    return null;
  }
  const match = COMPONENT_SCHEMA_POINTER_RE.exec(ref);
  if (!match?.[1]) {
    return null;
  }
  try {
    return unescapeJsonPointerToken(decodeURIComponent(match[1]));
  } catch {
    return unescapeJsonPointerToken(match[1]);
  }
}

export function deriveResourceStem(schemaName: string): string {
  for (const suffix of RESOURCE_SCHEMA_SUFFIXES) {
    if (schemaName.length > suffix.length && schemaName.endsWith(suffix)) {
      return schemaName.slice(0, -suffix.length);
    }
  }
  return schemaName;
}

interface CollectedProperty {
  schema: unknown;
  location?: RedoclyLocation;
}

type WrapperState =
  | { kind: "none" }
  | { kind: "single"; key: string; props: CollectedProperty[] }
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

interface CollectVariantsResult {
  variants: CollectedVariant[];
  hitCycle: boolean;
}

interface CollectVariantsOptions {
  matchTarget: (propName: string) => boolean;
  trackWrapper: boolean;
}

type ResolverFn = RedoclyUserContext["resolve"];

function safeResolve(
  resolve: ResolverFn,
  node: UnknownRecord,
  from?: string,
): RedoclyResolveResult<UnknownRecord> | null {
  if (typeof node.$ref !== "string") {
    return null;
  }
  try {
    const resolved = resolve<UnknownRecord>({ $ref: node.$ref }, from);
    if (!resolved || resolved.error || !isRecord(resolved.node)) {
      return null;
    }
    return resolved;
  } catch {
    return null;
  }
}

function isExplicitlyNonObjectSchema(node: unknown): boolean {
  if (!isRecord(node)) {
    return false;
  }
  if (typeof node.type === "string") {
    return node.type !== "object";
  }
  if (Array.isArray(node.type)) {
    return !node.type.includes("object");
  }
  return false;
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
  const mergedProps = [...base.props];
  for (const prop of addition.props) {
    if (!mergedProps.some((existing) => existing.schema === prop.schema)) {
      mergedProps.push(prop);
    }
  }
  return { kind: "single", key: base.key, props: mergedProps };
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
    !trackWrapper || isExemptSummary || hasId || matchedTarget
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

function collectObjectVariants(
  schema: unknown,
  resolve: ResolverFn,
  options: CollectVariantsOptions,
  baseLocation?: RedoclyLocation,
): CollectedVariant[] {
  const memo = new Map<object, Map<string, CollectVariantsResult>>();
  const objectIds = new WeakMap<object, number>();
  let nextObjectId = 1;

  const getObjectId = (value: unknown): string => {
    if (typeof value !== "object" || value === null) {
      return String(value);
    }
    const existing = objectIds.get(value);
    if (existing !== undefined) {
      return String(existing);
    }
    const id = nextObjectId;
    nextObjectId += 1;
    objectIds.set(value, id);
    return String(id);
  };

  const variantSignature = (variant: CollectedVariant): string => {
    const objFlag = variant.isObjectLike ? "1" : "0";
    if (variant.isExemptSummary) {
      return `exempt:${objFlag}`;
    }
    if (variant.hasId) {
      return `id:${objFlag}`;
    }
    if (variant.matchedTarget) {
      const targetLoc = variant.matchedTarget.location
        ? locationKey(variant.matchedTarget.location)
        : "";
      return `target:${objFlag}:${variant.matchedTarget.name}:${targetLoc}`;
    }
    if (!options.trackWrapper) {
      return `plain:${objFlag}`;
    }
    if (variant.wrapper.kind === "single") {
      const propIds = variant.wrapper.props.map((prop) => getObjectId(prop.schema)).join(",");
      return `single:${objFlag}:${variant.wrapper.key}:${propIds}`;
    }
    return `plain:${objFlag}:${variant.wrapper.kind}`;
  };

  const dedupeVariants = (list: CollectedVariant[]): CollectedVariant[] => {
    const bySignature = new Map<string, CollectedVariant>();
    for (const variant of list) {
      const sig = variantSignature(variant);
      if (!bySignature.has(sig)) {
        bySignature.set(sig, variant);
      }
    }
    return [...bySignature.values()];
  };

  const combineVariantSets = (
    currentSet: CollectedVariant[],
    incomingSet: CollectedVariant[],
    inheritExemption: boolean,
  ): CollectedVariant[] => {
    if (incomingSet.length === 0) {
      return currentSet;
    }
    const combined: CollectedVariant[] = [];
    for (const current of currentSet) {
      for (const incoming of incomingSet) {
        combined.push(
          mergeCollectedVariants(current, incoming, inheritExemption, options.trackWrapper),
        );
      }
    }
    return dedupeVariants(combined);
  };

  const visit = (
    node: unknown,
    location: RedoclyLocation | undefined,
    seen: ReadonlySet<unknown>,
    followRef: boolean,
  ): CollectVariantsResult => {
    if (!isRecord(node)) {
      return { variants: [], hitCycle: false };
    }
    if (isExplicitlyNonObjectSchema(node)) {
      return { variants: [], hitCycle: false };
    }
    if (seen.has(node)) {
      return { variants: [], hitCycle: true };
    }

    const cacheKey = `${followRef ? 1 : 0}:${location?.source?.absoluteRef ?? ""}#${location?.pointer ?? ""}`;
    const nodeCache = memo.get(node);
    const cached = nodeCache?.get(cacheKey);
    if (cached) {
      return cached;
    }

    const nextSeen = new Set(seen);
    nextSeen.add(node);

    const ownSchemaName =
      extractComponentSchemaNameFromLocation(location?.pointer) ??
      (typeof node.$ref === "string" ? extractComponentSchemaNameFromRef(node.$ref) : null);
    const isOwnExemptSummary =
      ownSchemaName !== null && isNonResourceSummarySchemaName(ownSchemaName);
    const isPureUnion =
      ownSchemaName === null &&
      typeof node.$ref !== "string" &&
      !Array.isArray(node.allOf) &&
      !isRecord(node.properties) &&
      node.type === undefined;

    let hitCycle = false;
    let variants: CollectedVariant[] = [
      {
        isObjectLike: false,
        isExemptSummary: isOwnExemptSummary,
        hasId: false,
        wrapper: { kind: "none" },
      },
    ];

    if (followRef && typeof node.$ref === "string") {
      const resolved = safeResolve(resolve, node, location?.source?.absoluteRef);
      if (resolved) {
        if (resolved.node) {
          const targetResult = visit(resolved.node, resolved.location, nextSeen, true);
          if (targetResult.hitCycle) {
            hitCycle = true;
          }
          if (targetResult.variants.length === 0 && !targetResult.hitCycle) {
            variants = [];
          } else {
            variants = combineVariantSets(variants, targetResult.variants, false);
          }
        }
        for (const hop of resolved.chain ?? []) {
          if (
            variants.length === 0 ||
            !isRecord(hop.node) ||
            hop.node === node ||
            hop.node === resolved.node
          ) {
            continue;
          }
          const hopResult = visit(hop.node, hop.location, nextSeen, false);
          if (hopResult.hitCycle) {
            hitCycle = true;
          }
          if (hopResult.variants.length === 0 && !hopResult.hitCycle) {
            variants = [];
          } else {
            variants = combineVariantSets(variants, hopResult.variants, false);
          }
        }
      }
    }

    if (variants.length > 0 && Array.isArray(node.allOf)) {
      for (const [index, branch] of node.allOf.entries()) {
        const branchResult = visit(branch, location?.child(["allOf", index]), nextSeen, true);
        if (branchResult.hitCycle) {
          hitCycle = true;
        }
        if (branchResult.variants.length === 0 && !branchResult.hitCycle) {
          variants = [];
          break;
        }
        variants = combineVariantSets(variants, branchResult.variants, false);
      }
    }

    if (variants.length > 0) {
      let directObjectLike =
        node.type === "object" || (Array.isArray(node.type) && node.type.includes("object"));
      let directHasId = false;
      let directMatchedTarget: { name: string; location?: RedoclyLocation } | undefined;
      let directWrapper: WrapperState = { kind: "none" };

      if (isRecord(node.properties)) {
        directObjectLike = true;
        const propEntries = Object.entries(node.properties);
        for (const [propName, propSchema] of propEntries) {
          const propLocation = location?.child(["properties", propName]);
          if (propName === "id") {
            directHasId = true;
          } else if (!directMatchedTarget && options.matchTarget(propName)) {
            directMatchedTarget = {
              name: propName,
              ...(propLocation ? { location: propLocation } : {}),
            };
          }
          if (options.trackWrapper) {
            directWrapper = mergeWrapperState(directWrapper, {
              kind: "single",
              key: propName,
              props: [
                {
                  schema: propSchema,
                  ...(propLocation ? { location: propLocation } : {}),
                },
              ],
            });
          }
        }
      }

      if (directObjectLike || directHasId || directMatchedTarget || directWrapper.kind !== "none") {
        variants = combineVariantSets(
          variants,
          [
            {
              isObjectLike: directObjectLike,
              isExemptSummary: false,
              hasId: directHasId,
              ...(directMatchedTarget ? { matchedTarget: directMatchedTarget } : {}),
              wrapper: directWrapper,
            },
          ],
          false,
        );
      }
    }

    if (variants.length > 0) {
      for (const unionKey of ["oneOf", "anyOf"] as const) {
        const branches = node[unionKey];
        if (!Array.isArray(branches) || branches.length === 0) {
          continue;
        }
        const branchVariants: CollectedVariant[] = [];
        let hasObjectCompatibleBranch = false;
        for (const [index, branch] of branches.entries()) {
          if (isExplicitlyNonObjectSchema(branch)) {
            continue;
          }
          hasObjectCompatibleBranch = true;
          const branchResult = visit(branch, location?.child([unionKey, index]), nextSeen, true);
          if (branchResult.hitCycle) {
            hitCycle = true;
          }
          branchVariants.push(...branchResult.variants);
        }
        if (!hasObjectCompatibleBranch) {
          variants = [];
          break;
        }
        if (branchVariants.length > 0) {
          variants = combineVariantSets(variants, dedupeVariants(branchVariants), isPureUnion);
        }
      }
    }

    const result: CollectVariantsResult = { variants, hitCycle };
    if (!hitCycle) {
      let existingCache = memo.get(node);
      if (!existingCache) {
        existingCache = new Map();
        memo.set(node, existingCache);
      }
      existingCache.set(cacheKey, result);
    }
    return result;
  };

  return visit(schema, baseLocation, new Set(), true).variants.filter(
    (variant) => variant.isObjectLike,
  );
}

export const ads0001PathParamNaming: RedoclyOas3Rule = () => {
  const reportedParameters = new Set<string>();

  return {
    Paths: {
      PathItem: {
        enter(_pathItem, ctx) {
          const pathTemplate = String(ctx.key);
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
        const nameLocation = ctx.location.child(["name"]);
        const dedupeKey = `${locationKey(nameLocation)}:${param.name}`;
        if (reportedParameters.has(dedupeKey)) {
          return;
        }
        reportedParameters.add(dedupeKey);
        ctx.report({
          message: error,
          location: nameLocation,
        });
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

export const ads0001PathParamConsistency: RedoclyOas3Rule = () => {
  return {
    Paths: {
      leave(paths, ctx) {
        if (!isRecord(paths)) {
          return;
        }

        const slots = new Map<string, Map<string, string[]>>();

        for (const pathTemplate of Object.keys(paths)) {
          if (!pathTemplate.startsWith("/")) {
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

export const ads0001ResourcePrimaryId: RedoclyOas3Rule = () => {
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
          const normalizedPath = pathTemplate.replace(/\/+$/, "");
          const leafMatch = LEAF_ID_PARAM_RE.exec(normalizedPath);
          if (!leafMatch?.[1]) {
            continue;
          }
          const leafParam = leafMatch[1];

          let pathItemLocation = ctx.location.child(["paths", pathTemplate]);
          let pathItem: unknown = rawPathItem;
          if (isRecord(rawPathItem) && typeof rawPathItem.$ref === "string") {
            const resolved = safeResolve(
              ctx.resolve,
              rawPathItem,
              pathItemLocation.source?.absoluteRef,
            );
            if (!resolved?.node) {
              continue;
            }
            pathItem = resolved.node;
            if (resolved.location) {
              pathItemLocation = resolved.location;
            }
          }

          if (!isRecord(pathItem) || !isRecord(pathItem.get)) {
            continue;
          }

          const getOp = pathItem.get;
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
          const rawSuccessResponse = getOp.responses[responseKey];
          if (!isRecord(rawSuccessResponse)) {
            continue;
          }

          let responseLocation = pathItemLocation.child(["get", "responses", responseKey]);
          let successResponse: UnknownRecord = rawSuccessResponse;
          if (typeof rawSuccessResponse.$ref === "string") {
            const resolved = safeResolve(
              ctx.resolve,
              rawSuccessResponse,
              responseLocation.source?.absoluteRef,
            );
            if (!resolved?.node) {
              continue;
            }
            successResponse = resolved.node;
            if (resolved.location) {
              responseLocation = resolved.location;
            }
          }

          if (!isRecord(successResponse.content)) {
            continue;
          }

          for (const [mediaType, mediaObj] of Object.entries(successResponse.content)) {
            if (!JSON_MEDIA_TYPE_RE.test(mediaType)) {
              continue;
            }
            if (!isRecord(mediaObj) || !isRecord(mediaObj.schema)) {
              continue;
            }

            const schemaLocation = responseLocation.child(["content", mediaType, "schema"]);
            const topVariants = collectObjectVariants(
              mediaObj.schema,
              ctx.resolve,
              { matchTarget: (propName) => propName === leafParam, trackWrapper: true },
              schemaLocation,
            );

            for (const top of topVariants) {
              if (!top.isObjectLike || top.isExemptSummary || top.hasId) {
                continue;
              }

              if (top.matchedTarget) {
                const reportLocation = top.matchedTarget.location
                  ? top.matchedTarget.location.key()
                  : schemaLocation.key();
                reportPrimaryIdOnce(
                  ctx,
                  reportLocation,
                  `GET item endpoint "${pathTemplate}" returns "${leafParam}" without "id". Single-resource responses must use "id" as the resource primary identifier field (ADS-0001).`,
                );
                continue;
              }

              if (top.wrapper.kind === "single") {
                const wrapperKey = top.wrapper.key;
                let innerVariants: CollectedVariant[] = [];
                for (const wrapperProp of top.wrapper.props) {
                  const partVariants = collectObjectVariants(
                    wrapperProp.schema,
                    ctx.resolve,
                    { matchTarget: (propName) => propName === leafParam, trackWrapper: false },
                    wrapperProp.location,
                  );
                  if (innerVariants.length === 0) {
                    innerVariants = partVariants;
                  } else if (partVariants.length > 0) {
                    const combined: CollectedVariant[] = [];
                    for (const current of innerVariants) {
                      for (const part of partVariants) {
                        combined.push(mergeCollectedVariants(current, part, false, false));
                      }
                    }
                    innerVariants = combined;
                  }
                }
                const fallbackLocation =
                  top.wrapper.props[0]?.location?.key() ?? schemaLocation.key();
                for (const inner of innerVariants) {
                  if (!inner.isObjectLike || inner.isExemptSummary || inner.hasId) {
                    continue;
                  }
                  if (inner.matchedTarget) {
                    const reportLocation = inner.matchedTarget.location
                      ? inner.matchedTarget.location.key()
                      : fallbackLocation;
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
