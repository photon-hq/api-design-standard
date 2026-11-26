import type { RuleIgnoreMatcher } from "../../src/ignore.js";
import {
  createRootRule,
  extractOperationJsonResponseSchemas,
  iterateRootPathItems,
  type ResolvedOperationParameter,
  type ResolvedPathItem,
  type ResponseJsonSchemaEntry,
  resolveOperationParameters,
} from "../../src/openapi-utils.js";
import {
  computeFragmentsMinLength,
  computeIntegerBounds,
  computeMinLength,
  computeTypeConstraint,
  formatAllowedTypes,
  isEmptyIntegerRange,
  isNonNullIntegerConstraint,
  isNonNullStringConstraint,
  isRecord,
  isTrackedPropertyDeprecated,
  type JsonSchemaType,
  propertyTypeConstraint,
  type ResolverFn,
  selectPropertyReportLocation,
  type TrackedProperty,
  type TypeConstraint,
  type UnknownRecord,
} from "../../src/schema-utils.js";
import {
  collectFlattenedObjectVariants,
  collectFragmentsObjectVariants,
  type FlattenedObjectVariant,
} from "../../src/schema-variants.js";
import type {
  AdsStandardMetadata,
  RedoclyLocation,
  RedoclyOas3Rule,
  RedoclyUserContext,
} from "../../src/types.js";
import { PLUGIN_ID } from "../0001-resource-identifiers/rules.js";

export const ADS_0006_METADATA: AdsStandardMetadata = {
  ads: "0006",
  slug: "ads-0006",
  folder: "0006-list-pagination",
  rules: [
    {
      name: "ads-0006-standard-pagination-params",
      id: `${PLUGIN_ID}/ads-0006-standard-pagination-params`,
      severity: "error",
      summary:
        "GET operations must use optional pageSize, pageToken, and top-level nextPageToken symmetrically without non-standard pagination query parameters.",
    },
    {
      name: "ads-0006-page-size-bounds",
      id: `${PLUGIN_ID}/ads-0006-page-size-bounds`,
      severity: "error",
      summary:
        "GET query parameters pageSize (optional non-nullable integer with 1 <= minimum <= maximum <= 1000) and pageToken (optional non-nullable string with minLength >= 1) must declare strict schemas and bounds.",
    },
    {
      name: "ads-0006-pagination-response-shape",
      id: `${PLUGIN_ID}/ads-0006-pagination-response-shape`,
      severity: "error",
      summary:
        "GET 200/2XX JSON responses must declare nextPageToken as an optional non-nullable string with minLength >= 1 at the top level, without legacy pagination properties or nested pagination wrappers.",
    },
  ],
};

export const MAX_ALLOWED_PAGE_SIZE = 1000;

export const BANNED_PAGINATION_QUERY_PARAMS: ReadonlySet<string> = new Set([
  "cursor",
  "limit",
  "offset",
  "page",
  "perPage",
  "per_page",
  "page_size",
  "page_token",
  "pageNumber",
  "page_number",
  "after",
  "before",
  "startingAfter",
  "endingBefore",
  "starting_after",
  "ending_before",
  "nextToken",
  "next_token",
  "continuationToken",
  "continuation_token",
]);

const LEGACY_PAGINATION_SCALAR_PROPERTIES = [
  "nextCursor",
  "next_cursor",
  "prevCursor",
  "prev_cursor",
  "previousCursor",
  "previous_cursor",
  "prevPageToken",
  "prev_page_token",
  "previousPageToken",
  "previous_page_token",
  "nextPage",
  "next_page",
  "hasMore",
  "has_more",
  "hasNextPage",
  "has_next_page",
  "hasPreviousPage",
  "has_previous_page",
  "next_page_token",
] as const;

const LEGACY_PAGINATION_WRAPPER_PROPERTIES = [
  "pageInfo",
  "page_info",
  "pagination",
  "listMetadata",
  "list_metadata",
] as const;

export const BANNED_PAGINATION_RESPONSE_PROPERTIES: ReadonlySet<string> = new Set([
  ...LEGACY_PAGINATION_SCALAR_PROPERTIES,
  ...LEGACY_PAGINATION_WRAPPER_PROPERTIES,
]);

export const NESTED_PAGINATION_INDICATOR_PROPERTIES: ReadonlySet<string> = new Set([
  "nextPageToken",
  ...LEGACY_PAGINATION_SCALAR_PROPERTIES,
]);

export function isBannedPaginationQueryParam(name: string): boolean {
  return BANNED_PAGINATION_QUERY_PARAMS.has(name);
}

export function isBannedPaginationResponseProperty(name: string): boolean {
  return BANNED_PAGINATION_RESPONSE_PROPERTIES.has(name);
}

export function isNestedPaginationIndicatorProperty(name: string): boolean {
  return NESTED_PAGINATION_INDICATOR_PROPERTIES.has(name);
}

interface GetJsonResponseVariants {
  readonly response: ResponseJsonSchemaEntry;
  readonly reportBaseLocation: RedoclyLocation;
  readonly variants: readonly FlattenedObjectVariant[];
}

function forEachActiveGetOperation(
  root: UnknownRecord,
  ctx: RedoclyUserContext,
  ignoreMatcher: RuleIgnoreMatcher,
  visitor: (entry: ResolvedPathItem, getOp: UnknownRecord) => void,
): void {
  for (const entry of iterateRootPathItems(root, ctx)) {
    const getOp = entry.pathItem?.get;
    if (!isRecord(getOp)) {
      continue;
    }
    if (ignoreMatcher.isIgnored({ path: entry.pathTemplate, method: "get" })) {
      continue;
    }
    visitor(entry, getOp);
  }
}

function collectActiveQueryParams(
  entry: ResolvedPathItem,
  resolve: ResolverFn,
): Map<string, ResolvedOperationParameter> {
  const params = new Map<string, ResolvedOperationParameter>();
  for (const param of resolveOperationParameters(entry, "get", resolve)) {
    if (param.in === "query" && !param.deprecated) {
      params.set(param.name, param);
    }
  }
  return params;
}

function collectGetJsonResponses(
  entry: ResolvedPathItem,
  getOp: UnknownRecord,
  resolve: ResolverFn,
): GetJsonResponseVariants[] {
  const jsonResponses = extractOperationJsonResponseSchemas(
    getOp,
    entry.operationLocation("get"),
    resolve,
    ["200", "2XX"],
  );
  const opFromRef = entry.isOperationFromRef("get");
  const results: GetJsonResponseVariants[] = [];

  for (const response of jsonResponses) {
    const collected = collectFlattenedObjectVariants(
      response.schema,
      resolve,
      response.schemaLocation,
    );
    const reportBaseLocation =
      opFromRef || response.responseFromRef
        ? entry.operationReportLocation("get")
        : response.schemaLocation;
    results.push({
      response,
      reportBaseLocation,
      variants: collected.variants.filter((variant) => variant.isObjectLike),
    });
  }

  return results;
}

function isVariantIgnoredBySchema(
  variant: FlattenedObjectVariant,
  pathTemplate: string,
  ignoreMatcher: RuleIgnoreMatcher,
): boolean {
  for (const schemaName of variant.schemaNames) {
    if (ignoreMatcher.isIgnored({ path: pathTemplate, method: "get", schema: schemaName })) {
      return true;
    }
  }
  return false;
}

function hasNonDeprecatedNextPageToken(
  variant: FlattenedObjectVariant,
  resolve: ResolverFn,
): boolean {
  const prop = variant.properties.get("nextPageToken");
  return prop !== undefined && !isTrackedPropertyDeprecated(prop, resolve);
}

function formatTypeSummary(allowed: ReadonlySet<JsonSchemaType>): string {
  return allowed.size > 0 ? formatAllowedTypes(allowed) : "never";
}

function validatePaginationQueryParamBase(
  pathTemplate: string,
  param: ResolvedOperationParameter,
  tagPrefix: string,
  expectedTypeLabel: string,
  schemaRequirement: string,
  matchesExpectedType: (tc: TypeConstraint) => boolean,
  resolve: ResolverFn,
  report: (dedupeTag: string, location: RedoclyLocation, message: string) => void,
): TypeConstraint | null {
  if (param.node.required === true) {
    report(
      `${tagPrefix}-required:${pathTemplate}`,
      param.reportLocation,
      `GET "${pathTemplate}" query parameter "${param.name}" must be optional (omit "required" or set "required: false") (ADS-0006).`,
    );
  }

  if (param.node.schema === undefined) {
    report(
      `${tagPrefix}-schema:${pathTemplate}`,
      param.reportLocation,
      `GET "${pathTemplate}" query parameter "${param.name}" must declare ${schemaRequirement} (ADS-0006).`,
    );
    return null;
  }

  const schemaFrom = param.resolvedLocation.source?.absoluteRef;
  const tc = computeTypeConstraint(param.node.schema, resolve, schemaFrom);
  if (!matchesExpectedType(tc)) {
    report(
      `${tagPrefix}-type:${pathTemplate}`,
      param.reportLocation,
      `GET "${pathTemplate}" query parameter "${param.name}" must have a non-nullable "${expectedTypeLabel}" schema (found "${formatTypeSummary(tc.allowed)}") (ADS-0006).`,
    );
  }
  return tc;
}

function validatePageSizeParam(
  pathTemplate: string,
  param: ResolvedOperationParameter,
  resolve: ResolverFn,
  report: (dedupeTag: string, location: RedoclyLocation, message: string) => void,
): void {
  const tc = validatePaginationQueryParamBase(
    pathTemplate,
    param,
    "page-size",
    "integer",
    `a non-nullable integer schema with minimum >= 1 and maximum <= ${MAX_ALLOWED_PAGE_SIZE}`,
    isNonNullIntegerConstraint,
    resolve,
    report,
  );
  if (!tc || (!tc.allowed.has("integer") && !tc.allowed.has("number"))) {
    return;
  }

  const bounds = computeIntegerBounds(
    param.node.schema,
    resolve,
    param.resolvedLocation.source?.absoluteRef,
  );
  if (bounds.kind === "false") {
    report(
      `page-size-range:${pathTemplate}`,
      param.reportLocation,
      `GET "${pathTemplate}" query parameter "pageSize" declares unsatisfiable integer bounds (ADS-0006).`,
    );
    return;
  }

  if (bounds.minimum === null) {
    report(
      `page-size-min:${pathTemplate}`,
      param.reportLocation,
      `GET "${pathTemplate}" query parameter "pageSize" must declare an explicit "minimum" >= 1 (ADS-0006).`,
    );
  } else if (bounds.minimum < 1) {
    report(
      `page-size-min:${pathTemplate}`,
      param.reportLocation,
      `GET "${pathTemplate}" query parameter "pageSize" declares minimum ${bounds.minimum}; minimum must be >= 1 (ADS-0006).`,
    );
  }

  if (bounds.maximum === null) {
    report(
      `page-size-max:${pathTemplate}`,
      param.reportLocation,
      `GET "${pathTemplate}" query parameter "pageSize" must declare an explicit "maximum" <= ${MAX_ALLOWED_PAGE_SIZE} (ADS-0006).`,
    );
  } else if (bounds.maximum > MAX_ALLOWED_PAGE_SIZE) {
    report(
      `page-size-max:${pathTemplate}`,
      param.reportLocation,
      `GET "${pathTemplate}" query parameter "pageSize" declares maximum ${bounds.maximum}; maximum must be <= ${MAX_ALLOWED_PAGE_SIZE} (ADS-0006).`,
    );
  } else if (bounds.maximum < 1) {
    report(
      `page-size-max:${pathTemplate}`,
      param.reportLocation,
      `GET "${pathTemplate}" query parameter "pageSize" declares maximum ${bounds.maximum}; maximum must be >= 1 (ADS-0006).`,
    );
  } else if (isEmptyIntegerRange(bounds.minimum, bounds.maximum)) {
    report(
      `page-size-range:${pathTemplate}`,
      param.reportLocation,
      `GET "${pathTemplate}" query parameter "pageSize" declares invalid bounds (minimum ${bounds.minimum} > maximum ${bounds.maximum}); maximum must be >= minimum and allow at least one integer (ADS-0006).`,
    );
  }
}

function validatePageTokenParam(
  pathTemplate: string,
  param: ResolvedOperationParameter,
  resolve: ResolverFn,
  report: (dedupeTag: string, location: RedoclyLocation, message: string) => void,
): void {
  const tc = validatePaginationQueryParamBase(
    pathTemplate,
    param,
    "page-token",
    "string",
    'a non-nullable "string" schema with minLength >= 1',
    isNonNullStringConstraint,
    resolve,
    report,
  );
  if (!tc?.allowed.has("string")) {
    return;
  }

  const minLen = computeMinLength(
    param.node.schema,
    resolve,
    param.resolvedLocation.source?.absoluteRef,
  );
  if (minLen.kind === "value" && (minLen.minLength === null || minLen.minLength < 1)) {
    report(
      `page-token-min-length:${pathTemplate}`,
      param.reportLocation,
      `GET "${pathTemplate}" query parameter "pageToken" must declare an explicit "minLength" >= 1 (ADS-0006).`,
    );
  }
}

function validateNextPageTokenProperty(
  pathTemplate: string,
  variant: FlattenedObjectVariant,
  prop: TrackedProperty,
  propLocation: RedoclyLocation,
  resolve: ResolverFn,
  report: (dedupeTag: string, location: RedoclyLocation, message: string) => void,
): void {
  if (variant.required.has("nextPageToken")) {
    report(
      `next-page-token-required:${pathTemplate}`,
      propLocation,
      `GET "${pathTemplate}" response property "nextPageToken" must be optional (not in "required") because it must be omitted on the final page (ADS-0006).`,
    );
  }

  const tc = propertyTypeConstraint(prop, resolve);
  if (!isNonNullStringConstraint(tc)) {
    report(
      `next-page-token-type:${pathTemplate}`,
      propLocation,
      `GET "${pathTemplate}" response property "nextPageToken" must be a non-nullable "string" (found "${formatTypeSummary(tc.allowed)}"); omit it on the final page instead of returning null (ADS-0006).`,
    );
  }

  if (!tc.allowed.has("string")) {
    return;
  }

  const minLen = computeFragmentsMinLength(prop.fragments, resolve);
  if (minLen.kind === "value" && (minLen.minLength === null || minLen.minLength < 1)) {
    report(
      `next-page-token-min-length:${pathTemplate}`,
      propLocation,
      `GET "${pathTemplate}" response property "nextPageToken" must declare an explicit "minLength" >= 1 so empty strings are never returned (ADS-0006).`,
    );
  }
}

function checkNestedPaginationWrapper(
  pathTemplate: string,
  propName: string,
  prop: TrackedProperty,
  propLocation: RedoclyLocation,
  resolve: ResolverFn,
  report: (dedupeTag: string, location: RedoclyLocation, message: string) => void,
): void {
  const tc = propertyTypeConstraint(prop, resolve);
  if (!tc.allowed.has("object")) {
    return;
  }

  const nested = collectFragmentsObjectVariants(prop.fragments, resolve);
  for (const nestedVariant of nested.variants) {
    if (!nestedVariant.isObjectLike) {
      continue;
    }
    for (const [nestedName, nestedProp] of nestedVariant.properties.entries()) {
      if (!NESTED_PAGINATION_INDICATOR_PROPERTIES.has(nestedName)) {
        continue;
      }
      if (isTrackedPropertyDeprecated(nestedProp, resolve)) {
        continue;
      }
      report(
        `nested-wrapper:${pathTemplate}:${propName}:${nestedName}`,
        propLocation,
        `GET "${pathTemplate}" nests pagination field "${nestedName}" inside top-level object property "${propName}". Place optional non-nullable "nextPageToken" directly at the top level (ADS-0006).`,
      );
    }
  }
}

const standardPaginationParamsRule: RedoclyOas3Rule = createRootRule(
  ({ root, ctx, ignoreMatcher, reportOnce: report }) => {
    forEachActiveGetOperation(root, ctx, ignoreMatcher, (entry, getOp) => {
      const { pathTemplate } = entry;
      const queryParams = collectActiveQueryParams(entry, ctx.resolve);

      for (const [paramName, param] of queryParams.entries()) {
        if (BANNED_PAGINATION_QUERY_PARAMS.has(paramName)) {
          report(
            `banned-param:${pathTemplate}:${paramName}`,
            param.reportLocation,
            `GET "${pathTemplate}" declares non-standard pagination query parameter "${paramName}". Use optional "pageSize" and "pageToken" instead, or mark legacy migration parameters "deprecated: true" (ADS-0006).`,
          );
        }
      }

      const hasPageSize = queryParams.has("pageSize");
      const hasPageToken = queryParams.has("pageToken");
      const jsonResponses = collectGetJsonResponses(entry, getOp, ctx.resolve);
      const anyNextPageToken = jsonResponses.some((item) =>
        item.variants.some((variant) => hasNonDeprecatedNextPageToken(variant, ctx.resolve)),
      );
      const allResponsesHaveNextPageToken =
        jsonResponses.length > 0 &&
        jsonResponses.every((item) =>
          item.variants.some((variant) => hasNonDeprecatedNextPageToken(variant, ctx.resolve)),
        );

      if (!hasPageSize && !hasPageToken && !anyNextPageToken) {
        return;
      }

      const missing: string[] = [];
      if (!hasPageSize) {
        missing.push('query parameter "pageSize"');
      }
      if (!hasPageToken) {
        missing.push('query parameter "pageToken"');
      }
      if (!allResponsesHaveNextPageToken) {
        missing.push('top-level 200/2XX JSON response property "nextPageToken"');
      }

      if (missing.length > 0) {
        const declared: string[] = [];
        if (hasPageSize) {
          declared.push('"pageSize"');
        }
        if (hasPageToken) {
          declared.push('"pageToken"');
        }
        if (anyNextPageToken) {
          declared.push('"nextPageToken"');
        }
        report(
          `symmetry:${pathTemplate}`,
          entry.operationReportLocation("get"),
          `GET "${pathTemplate}" declares partial pagination (${declared.join(", ")}) and must also declare ${missing.join(", ")} (ADS-0006).`,
        );
      }
    });
  },
);

const pageSizeBoundsRule: RedoclyOas3Rule = createRootRule(
  ({ root, ctx, ignoreMatcher, reportOnce: report }) => {
    forEachActiveGetOperation(root, ctx, ignoreMatcher, (entry) => {
      const queryParams = collectActiveQueryParams(entry, ctx.resolve);
      const pageSizeParam = queryParams.get("pageSize");
      if (pageSizeParam) {
        validatePageSizeParam(entry.pathTemplate, pageSizeParam, ctx.resolve, report);
      }
      const pageTokenParam = queryParams.get("pageToken");
      if (pageTokenParam) {
        validatePageTokenParam(entry.pathTemplate, pageTokenParam, ctx.resolve, report);
      }
    });
  },
);

const paginationResponseShapeRule: RedoclyOas3Rule = createRootRule(
  ({ root, ctx, ignoreMatcher, reportOnce: report }) => {
    forEachActiveGetOperation(root, ctx, ignoreMatcher, (entry, getOp) => {
      const { pathTemplate } = entry;
      const jsonResponses = collectGetJsonResponses(entry, getOp, ctx.resolve);

      for (const item of jsonResponses) {
        for (const variant of item.variants) {
          if (isVariantIgnoredBySchema(variant, pathTemplate, ignoreMatcher)) {
            continue;
          }

          for (const [propName, prop] of variant.properties.entries()) {
            if (isTrackedPropertyDeprecated(prop, ctx.resolve)) {
              continue;
            }
            const propLocation = selectPropertyReportLocation(
              prop,
              item.response.schemaLocation,
              item.reportBaseLocation,
            );

            if (propName === "nextPageToken") {
              validateNextPageTokenProperty(
                pathTemplate,
                variant,
                prop,
                propLocation,
                ctx.resolve,
                report,
              );
              continue;
            }

            if (BANNED_PAGINATION_RESPONSE_PROPERTIES.has(propName)) {
              report(
                `banned-response-prop:${pathTemplate}:${propName}`,
                propLocation,
                `GET "${pathTemplate}" declares non-standard pagination response property "${propName}". Use optional non-nullable top-level "nextPageToken" instead, or mark legacy migration properties "deprecated: true" (ADS-0006).`,
              );
              continue;
            }

            checkNestedPaginationWrapper(
              pathTemplate,
              propName,
              prop,
              propLocation,
              ctx.resolve,
              report,
            );
          }
        }
      }
    });
  },
);

export const ads0006Rules: Record<string, RedoclyOas3Rule> = {
  "ads-0006-standard-pagination-params": standardPaginationParamsRule,
  "ads-0006-page-size-bounds": pageSizeBoundsRule,
  "ads-0006-pagination-response-shape": paginationResponseShapeRule,
};
