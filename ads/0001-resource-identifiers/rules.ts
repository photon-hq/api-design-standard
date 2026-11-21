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
        "URL path parameters must use lowerCamelCase resource-qualified names (for example `{projectId}`), never generic `{id}`.",
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
  const segments = pathTemplate.split("/").filter((segment) => segment.length > 0);
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

interface CollectedObjectSchema {
  isObjectLike: boolean;
  properties: Map<string, CollectedProperty>;
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

function isNullTypeSchema(node: unknown): boolean {
  return isRecord(node) && node.type === "null";
}

function unwrapNullableUnion(
  branches: unknown[],
  baseLocation: RedoclyLocation | undefined,
  unionKey: "oneOf" | "anyOf",
): { schema: unknown; location?: RedoclyLocation } | null {
  if (branches.length !== 2) {
    return null;
  }
  const firstIsNull = isNullTypeSchema(branches[0]);
  const secondIsNull = isNullTypeSchema(branches[1]);
  if (firstIsNull === secondIsNull) {
    return null;
  }
  const targetIndex = firstIsNull ? 1 : 0;
  return {
    schema: branches[targetIndex],
    ...(baseLocation ? { location: baseLocation.child([unionKey, targetIndex]) } : {}),
  };
}

function collectObjectProperties(
  schema: unknown,
  resolve: ResolverFn,
  baseLocation?: RedoclyLocation,
  seen: Set<unknown> = new Set(),
): CollectedObjectSchema {
  const properties = new Map<string, CollectedProperty>();
  let isObjectLike = false;

  const visit = (node: unknown, loc?: RedoclyLocation): void => {
    if (!isRecord(node) || seen.has(node)) {
      return;
    }
    seen.add(node);

    if (typeof node.$ref === "string") {
      const resolved = safeResolve(resolve, node, loc?.source?.absoluteRef);
      if (resolved?.node) {
        visit(resolved.node, resolved.location);
      }
    }

    if (Array.isArray(node.allOf)) {
      for (const [index, branch] of node.allOf.entries()) {
        visit(branch, loc?.child(["allOf", index]));
      }
    }

    if (Array.isArray(node.oneOf)) {
      const unwrapped = unwrapNullableUnion(node.oneOf, loc, "oneOf");
      if (unwrapped) {
        visit(unwrapped.schema, unwrapped.location);
      }
    }

    if (Array.isArray(node.anyOf)) {
      const unwrapped = unwrapNullableUnion(node.anyOf, loc, "anyOf");
      if (unwrapped) {
        visit(unwrapped.schema, unwrapped.location);
      }
    }

    if (node.type === "object" || (Array.isArray(node.type) && node.type.includes("object"))) {
      isObjectLike = true;
    }

    if (isRecord(node.properties)) {
      isObjectLike = true;
      for (const [propName, propSchema] of Object.entries(node.properties)) {
        const propLocation = loc?.child(["properties", propName]);
        properties.set(propName, {
          schema: propSchema,
          ...(propLocation ? { location: propLocation } : {}),
        });
      }
    }
  };

  visit(schema, baseLocation);
  return { isObjectLike, properties };
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
                location: ctx.location.key(),
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
            const { isObjectLike, properties } = collectObjectProperties(
              rawSchema,
              ctx.resolve,
              schemaLocation,
            );
            if (!isObjectLike || properties.has("id")) {
              continue;
            }

            const normalizedStem = stem.toLowerCase();
            for (const [propName, propEntry] of properties.entries()) {
              if (
                propName.length > 2 &&
                propName.endsWith("Id") &&
                propName.slice(0, -2).toLowerCase() === normalizedStem
              ) {
                const reportLocation = propEntry.location
                  ? propEntry.location.key()
                  : schemaLocation.key();
                reportPrimaryIdOnce(
                  ctx,
                  reportLocation,
                  `Resource schema "${schemaName}" defines resource-prefixed identifier "${propName}" without "id". Resource objects must use "id" as their primary identifier field (ADS-0001).`,
                );
              }
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

          const rawResponse200 = getOp.responses["200"];
          if (!isRecord(rawResponse200)) {
            continue;
          }

          let responseLocation = pathItemLocation.child(["get", "responses", "200"]);
          let response200: UnknownRecord = rawResponse200;
          if (typeof rawResponse200.$ref === "string") {
            const resolved = safeResolve(
              ctx.resolve,
              rawResponse200,
              responseLocation.source?.absoluteRef,
            );
            if (!resolved?.node) {
              continue;
            }
            response200 = resolved.node;
            if (resolved.location) {
              responseLocation = resolved.location;
            }
          }

          if (!isRecord(response200.content)) {
            continue;
          }

          for (const [mediaType, mediaObj] of Object.entries(response200.content)) {
            if (!JSON_MEDIA_TYPE_RE.test(mediaType)) {
              continue;
            }
            if (!isRecord(mediaObj) || !isRecord(mediaObj.schema)) {
              continue;
            }

            const schemaLocation = responseLocation.child(["content", mediaType, "schema"]);
            const top = collectObjectProperties(mediaObj.schema, ctx.resolve, schemaLocation);
            if (!top.isObjectLike) {
              continue;
            }

            if (!top.properties.has("id") && top.properties.has(leafParam)) {
              const propEntry = top.properties.get(leafParam);
              const reportLocation = propEntry?.location
                ? propEntry.location.key()
                : schemaLocation.key();
              reportPrimaryIdOnce(
                ctx,
                reportLocation,
                `GET item endpoint "${pathTemplate}" returns "${leafParam}" without "id". Single-resource responses must use "id" as the resource primary identifier field (ADS-0001).`,
              );
              continue;
            }

            if (!top.properties.has("id") && top.properties.size === 1) {
              const entry = [...top.properties.entries()][0];
              if (!entry) {
                continue;
              }
              const [wrapperKey, wrapperProp] = entry;
              const inner = collectObjectProperties(
                wrapperProp.schema,
                ctx.resolve,
                wrapperProp.location,
              );
              if (
                inner.isObjectLike &&
                !inner.properties.has("id") &&
                inner.properties.has(leafParam)
              ) {
                const innerProp = inner.properties.get(leafParam);
                const reportLocation = innerProp?.location
                  ? innerProp.location.key()
                  : (wrapperProp.location?.key() ?? schemaLocation.key());
                reportPrimaryIdOnce(
                  ctx,
                  reportLocation,
                  `GET item endpoint "${pathTemplate}" returns wrapped resource "${wrapperKey}" with "${leafParam}" instead of "id". Resource objects must use "id" as their primary identifier field (ADS-0001).`,
                );
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
