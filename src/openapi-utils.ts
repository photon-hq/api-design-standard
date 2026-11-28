import { createRuleIgnoreMatcher, type RuleIgnoreMatcher } from "./ignore.js";
import {
  getRefIntermediateHops,
  isRecord,
  locationKey,
  type ResolverFn,
  resolveRecordWithLocation,
  safeResolveRecord,
  type UnknownRecord,
} from "./schema-utils.js";
import type { RedoclyLocation, RedoclyOas3Rule, RedoclyUserContext } from "./types.js";

export const JSON_MEDIA_TYPE_RE =
  /^application\/(?!problem\+json(?:\s*;|$))(?:[^;]+\+)?json(?:\s*;|$)/i;
export const EXACT_2XX_STATUS_RE = /^2\d\d$/;

const STATUS_RANGE_RE = /^([1-5])XX$/i;
const EMPTY_STRING_SET: ReadonlySet<string> = new Set();
const EMPTY_LOCATION_MAP: ReadonlyMap<string, RedoclyLocation> = new Map();

export function reportOnce(
  ctx: RedoclyUserContext,
  reported: Set<string>,
  dedupeTag: string,
  location: RedoclyLocation,
  message: string,
): void {
  const key = `${locationKey(location)}::${dedupeTag}`;
  if (reported.has(key)) {
    return;
  }
  reported.add(key);
  ctx.report({ message, location });
}

export interface RootRuleContext {
  readonly root: UnknownRecord;
  readonly ctx: RedoclyUserContext;
  readonly options: Record<string, unknown>;
  readonly ignoreMatcher: RuleIgnoreMatcher;
  readonly reportOnce: (dedupeTag: string, location: RedoclyLocation, message: string) => void;
}

export function createRootRule(
  run: (context: RootRuleContext) => void,
  ruleOptions?: { readonly requirePaths?: boolean },
): RedoclyOas3Rule {
  const requirePaths = ruleOptions?.requirePaths ?? true;
  return (options = {}) => {
    const ignoreMatcher = createRuleIgnoreMatcher(options);
    return {
      Root: {
        leave(root, ctx) {
          if (!isRecord(root) || (requirePaths && !isRecord(root.paths))) {
            return;
          }
          const reported = new Set<string>();
          run({
            root,
            ctx,
            options,
            ignoreMatcher,
            reportOnce: (dedupeTag, location, message) => {
              reportOnce(ctx, reported, dedupeTag, location, message);
            },
          });
        },
      },
    };
  };
}

export interface ResolvedPathItem {
  readonly pathTemplate: string;
  readonly pathItem: UnknownRecord | undefined;
  readonly pathUsageLocation: RedoclyLocation;
  readonly pathItemLocation: RedoclyLocation;
  readonly pathFromRef: boolean;
  readonly localKeys: ReadonlySet<string>;
  fieldLocation(field: string): RedoclyLocation;
  operationLocation(method: string): RedoclyLocation;
  isOperationFromRef(method: string): boolean;
  operationReportLocation(method: string): RedoclyLocation;
}

export function resolvePathItemWithLocation(
  resolve: ResolverFn,
  pathTemplate: string,
  rawPathItem: unknown,
  pathUsageLocation: RedoclyLocation,
): ResolvedPathItem {
  const buildEntry = (
    pathItem: UnknownRecord | undefined,
    pathItemLocation: RedoclyLocation,
    pathFromRef: boolean,
    localKeys: ReadonlySet<string>,
    fieldLocations: ReadonlyMap<string, RedoclyLocation>,
  ): ResolvedPathItem => {
    const isOperationFromRef = (method: string): boolean => pathFromRef && !localKeys.has(method);
    const fieldLocation = (field: string): RedoclyLocation =>
      (fieldLocations.get(field) ?? pathItemLocation).child([field]);
    const operationLocation = (method: string): RedoclyLocation => fieldLocation(method);
    const operationReportLocation = (method: string): RedoclyLocation =>
      isOperationFromRef(method) ? pathUsageLocation.key() : operationLocation(method).key();

    return {
      pathTemplate,
      pathItem,
      pathUsageLocation,
      pathItemLocation,
      pathFromRef,
      localKeys,
      fieldLocation,
      operationLocation,
      isOperationFromRef,
      operationReportLocation,
    };
  };

  if (!isRecord(rawPathItem)) {
    return buildEntry(undefined, pathUsageLocation, false, EMPTY_STRING_SET, EMPTY_LOCATION_MAP);
  }

  if (typeof rawPathItem.$ref !== "string") {
    return buildEntry(rawPathItem, pathUsageLocation, false, EMPTY_STRING_SET, EMPTY_LOCATION_MAP);
  }

  const resolved = safeResolveRecord(resolve, rawPathItem, pathUsageLocation.source?.absoluteRef);
  const localEntries = Object.entries(rawPathItem).filter(([key]) => key !== "$ref");

  if (!resolved?.node) {
    if (localEntries.length === 0) {
      return buildEntry(undefined, pathUsageLocation, true, EMPTY_STRING_SET, EMPTY_LOCATION_MAP);
    }
    const localOnly: UnknownRecord = {};
    const localKeys = new Set<string>();
    const fieldLocations = new Map<string, RedoclyLocation>();
    for (const [key, value] of localEntries) {
      localOnly[key] = value;
      localKeys.add(key);
      fieldLocations.set(key, pathUsageLocation);
    }
    return buildEntry(localOnly, pathUsageLocation, false, localKeys, fieldLocations);
  }

  const targetLocation = resolved.location ?? pathUsageLocation;
  const intermediateHops = getRefIntermediateHops(rawPathItem, resolved, { reverse: true });

  if (intermediateHops.length === 0 && localEntries.length === 0) {
    return buildEntry(resolved.node, targetLocation, true, EMPTY_STRING_SET, EMPTY_LOCATION_MAP);
  }

  const merged: UnknownRecord = { ...resolved.node };
  const fieldLocations = new Map<string, RedoclyLocation>();
  for (const hop of intermediateHops) {
    const hopLocation = hop.location ?? targetLocation;
    for (const [key, value] of Object.entries(hop.node)) {
      if (key === "$ref") {
        continue;
      }
      merged[key] = value;
      fieldLocations.set(key, hopLocation);
    }
  }

  const localKeys = new Set<string>();
  for (const [key, value] of localEntries) {
    merged[key] = value;
    localKeys.add(key);
    fieldLocations.set(key, pathUsageLocation);
  }
  return buildEntry(merged, targetLocation, true, localKeys, fieldLocations);
}

export interface ResolvedOperationParameter {
  readonly name: string;
  readonly in: string;
  readonly deprecated: boolean;
  readonly node: UnknownRecord;
  readonly source: "path" | "operation";
  readonly usageLocation: RedoclyLocation;
  readonly resolvedLocation: RedoclyLocation;
  readonly resolvedFromRef: boolean;
  readonly reportLocation: RedoclyLocation;
}

function parameterDedupeKey(paramIn: string, name: string): string {
  return paramIn === "header" ? `${paramIn}:${name.toLowerCase()}` : `${paramIn}:${name}`;
}

export function resolveOperationParameters(
  pathEntry: ResolvedPathItem,
  method: string,
  resolve: ResolverFn,
): ResolvedOperationParameter[] {
  const pathItem = pathEntry.pathItem;
  const op = pathItem?.[method];
  if (!isRecord(pathItem) || !isRecord(op)) {
    return [];
  }

  const effectiveByKey = new Map<string, ResolvedOperationParameter>();
  const collectFrom = (
    rawParams: unknown,
    listLocation: RedoclyLocation,
    source: "path" | "operation",
    makeReportLocation: (usageLocation: RedoclyLocation) => RedoclyLocation,
  ): void => {
    if (!Array.isArray(rawParams)) {
      return;
    }
    for (const [index, rawParam] of rawParams.entries()) {
      const usageLocation = listLocation.child([index]);
      const resolved = resolveRecordWithLocation(resolve, rawParam, usageLocation);
      if (
        !resolved ||
        typeof resolved.node.name !== "string" ||
        typeof resolved.node.in !== "string"
      ) {
        continue;
      }
      const key = parameterDedupeKey(resolved.node.in, resolved.node.name);
      effectiveByKey.set(key, {
        name: resolved.node.name,
        in: resolved.node.in,
        deprecated: resolved.node.deprecated === true,
        node: resolved.node,
        source,
        usageLocation,
        resolvedLocation: resolved.location,
        resolvedFromRef: resolved.resolvedFromRef,
        reportLocation: makeReportLocation(usageLocation),
      });
    }
  };

  collectFrom(pathItem.parameters, pathEntry.fieldLocation("parameters"), "path", () =>
    pathEntry.operationReportLocation(method),
  );
  collectFrom(
    op.parameters,
    pathEntry.operationLocation(method).child(["parameters"]),
    "operation",
    (usageLocation) =>
      pathEntry.isOperationFromRef(method) ? pathEntry.pathUsageLocation.key() : usageLocation,
  );

  return [...effectiveByKey.values()];
}

export function iterateRootPathItems(
  root: UnknownRecord,
  ctx: RedoclyUserContext,
): ResolvedPathItem[] {
  if (!isRecord(root.paths)) {
    return [];
  }
  const entries: ResolvedPathItem[] = [];
  for (const [pathTemplate, rawPathItem] of Object.entries(root.paths)) {
    if (!pathTemplate.startsWith("/")) {
      continue;
    }
    const pathUsageLocation = ctx.location.child(["paths", pathTemplate]);
    entries.push(
      resolvePathItemWithLocation(ctx.resolve, pathTemplate, rawPathItem, pathUsageLocation),
    );
  }
  return entries;
}

export interface ResponseJsonSchemaEntry {
  readonly statusCode?: string;
  readonly mediaType: string;
  readonly schema: unknown;
  readonly schemaLocation: RedoclyLocation;
  readonly responseNode: UnknownRecord;
  readonly responseLocation: RedoclyLocation;
  readonly responseFromRef: boolean;
}

export function extractResponseJsonSchemas(
  rawResponse: unknown,
  responseUsageLocation: RedoclyLocation,
  resolve: ResolverFn,
  statusCode?: string,
): ResponseJsonSchemaEntry[] {
  if (!isRecord(rawResponse)) {
    return [];
  }
  const resolved = resolveRecordWithLocation(resolve, rawResponse, responseUsageLocation);
  if (!resolved || !isRecord(resolved.node.content)) {
    return [];
  }
  const results: ResponseJsonSchemaEntry[] = [];
  for (const [mediaType, mediaObj] of Object.entries(resolved.node.content)) {
    if (!JSON_MEDIA_TYPE_RE.test(mediaType)) {
      continue;
    }
    if (!isRecord(mediaObj) || mediaObj.schema === undefined) {
      continue;
    }
    results.push({
      ...(statusCode !== undefined ? { statusCode } : {}),
      mediaType,
      schema: mediaObj.schema,
      schemaLocation: resolved.location.child(["content", mediaType, "schema"]),
      responseNode: resolved.node,
      responseLocation: resolved.location,
      responseFromRef: resolved.resolvedFromRef,
    });
  }
  return results;
}

export function extractOperationJsonResponseSchemas(
  operation: UnknownRecord,
  operationLocation: RedoclyLocation,
  resolve: ResolverFn,
  statusCodes: readonly string[],
  options?: { readonly firstMatchingOnly?: boolean },
): ResponseJsonSchemaEntry[] {
  if (!isRecord(operation.responses)) {
    return [];
  }
  const firstMatchingOnly = options?.firstMatchingOnly ?? true;
  const responses = operation.responses;
  const declaredExplicitClasses = new Set<string>();
  const requestedExplicitByClass = new Map<string, string[]>();
  for (const statusCode of statusCodes) {
    if (!STATUS_RANGE_RE.test(statusCode)) {
      const statusClass = statusCode[0];
      if (statusClass) {
        const list = requestedExplicitByClass.get(statusClass);
        if (list) {
          list.push(statusCode);
        } else {
          requestedExplicitByClass.set(statusClass, [statusCode]);
        }
        if (responses[statusCode] !== undefined) {
          declaredExplicitClasses.add(statusClass);
        }
      }
    }
  }
  const results: ResponseJsonSchemaEntry[] = [];
  for (const statusCode of statusCodes) {
    const rangeMatch = STATUS_RANGE_RE.exec(statusCode);
    if (rangeMatch?.[1]) {
      if (firstMatchingOnly) {
        if (declaredExplicitClasses.has(rangeMatch[1])) {
          continue;
        }
      } else {
        const requestedInClass = requestedExplicitByClass.get(rangeMatch[1]);
        if (
          requestedInClass &&
          requestedInClass.length > 0 &&
          requestedInClass.every((code) => responses[code] !== undefined)
        ) {
          continue;
        }
      }
    }
    const entries = extractResponseJsonSchemas(
      responses[statusCode],
      operationLocation.child(["responses", statusCode]),
      resolve,
      statusCode,
    );
    if (entries.length > 0) {
      results.push(...entries);
      if (firstMatchingOnly) {
        break;
      }
    }
  }
  return results;
}

export interface RequestBodyMediaSchemaEntry {
  readonly mediaType: string;
  readonly isJson: boolean;
  readonly schema: unknown;
  readonly mediaTypeLocation: RedoclyLocation;
  readonly schemaLocation: RedoclyLocation;
  readonly requestBodyNode: UnknownRecord;
  readonly requestBodyLocation: RedoclyLocation;
  readonly requestBodyFromRef: boolean;
}

export function extractRequestBodyMediaSchemas(
  operation: UnknownRecord,
  operationLocation: RedoclyLocation,
  resolve: ResolverFn,
): RequestBodyMediaSchemaEntry[] {
  if (!isRecord(operation.requestBody)) {
    return [];
  }
  const usageLocation = operationLocation.child(["requestBody"]);
  const resolved = resolveRecordWithLocation(resolve, operation.requestBody, usageLocation);
  if (!resolved || !isRecord(resolved.node.content)) {
    return [];
  }
  const results: RequestBodyMediaSchemaEntry[] = [];
  for (const [mediaType, mediaObj] of Object.entries(resolved.node.content)) {
    const mediaTypeLocation = resolved.location.child(["content", mediaType]);
    const schema = isRecord(mediaObj) ? mediaObj.schema : undefined;
    results.push({
      mediaType,
      isJson: JSON_MEDIA_TYPE_RE.test(mediaType),
      schema,
      mediaTypeLocation,
      schemaLocation: mediaTypeLocation.child(["schema"]),
      requestBodyNode: resolved.node,
      requestBodyLocation: resolved.location,
      requestBodyFromRef: resolved.resolvedFromRef,
    });
  }
  return results;
}

export function inspectResponseContent(
  rawResponse: unknown,
  responseUsageLocation: RedoclyLocation,
  resolve: ResolverFn,
): {
  readonly node: UnknownRecord;
  readonly location: RedoclyLocation;
  readonly resolvedFromRef: boolean;
  readonly hasContent: boolean;
} | null {
  const resolved = resolveRecordWithLocation(resolve, rawResponse, responseUsageLocation);
  if (!resolved) {
    return null;
  }
  const hasContent =
    isRecord(resolved.node.content) && Object.keys(resolved.node.content).length > 0;
  return {
    ...resolved,
    hasContent,
  };
}

export function hasHeaderCaseInsensitive(headers: unknown, targetLower: string): boolean {
  if (!isRecord(headers)) {
    return false;
  }
  for (const key of Object.keys(headers)) {
    if (key.toLowerCase() === targetLower) {
      return true;
    }
  }
  return false;
}
