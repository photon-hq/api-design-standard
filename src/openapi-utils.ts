import { createRuleIgnoreMatcher, type RuleIgnoreMatcher } from "./ignore.js";
import {
  isRecord,
  locationKey,
  type ResolverFn,
  resolveRecordWithLocation,
  type UnknownRecord,
} from "./schema-utils.js";
import type { RedoclyLocation, RedoclyOas3Rule, RedoclyUserContext } from "./types.js";

export const JSON_MEDIA_TYPE_RE =
  /^application\/(?!problem\+json(?:\s*;|$))(?:[^;]+\+)?json(?:\s*;|$)/i;
export const EXACT_2XX_STATUS_RE = /^2\d\d$/;

const EMPTY_STRING_SET: ReadonlySet<string> = new Set();

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

export function createRootRule(run: (context: RootRuleContext) => void): RedoclyOas3Rule {
  return (options = {}) => {
    const ignoreMatcher = createRuleIgnoreMatcher(options);
    return {
      Root: {
        leave(root, ctx) {
          if (!isRecord(root) || !isRecord(root.paths)) {
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
  ): ResolvedPathItem => {
    const isOperationFromRef = (method: string): boolean => pathFromRef && !localKeys.has(method);
    const operationLocation = (method: string): RedoclyLocation =>
      localKeys.has(method) ? pathUsageLocation.child([method]) : pathItemLocation.child([method]);
    const operationReportLocation = (method: string): RedoclyLocation =>
      isOperationFromRef(method) ? pathUsageLocation.key() : operationLocation(method).key();

    return {
      pathTemplate,
      pathItem,
      pathUsageLocation,
      pathItemLocation,
      pathFromRef,
      localKeys,
      operationLocation,
      isOperationFromRef,
      operationReportLocation,
    };
  };

  if (!isRecord(rawPathItem)) {
    return buildEntry(undefined, pathUsageLocation, false, EMPTY_STRING_SET);
  }

  if (typeof rawPathItem.$ref !== "string") {
    return buildEntry(rawPathItem, pathUsageLocation, false, EMPTY_STRING_SET);
  }

  const resolved = resolveRecordWithLocation(resolve, rawPathItem, pathUsageLocation);
  const localEntries = Object.entries(rawPathItem).filter(([key]) => key !== "$ref");

  if (!resolved) {
    if (localEntries.length === 0) {
      return buildEntry(undefined, pathUsageLocation, true, EMPTY_STRING_SET);
    }
    const localOnly: UnknownRecord = {};
    const localKeys = new Set<string>();
    for (const [key, value] of localEntries) {
      localOnly[key] = value;
      localKeys.add(key);
    }
    return buildEntry(localOnly, pathUsageLocation, false, localKeys);
  }

  if (localEntries.length === 0) {
    return buildEntry(resolved.node, resolved.location, true, EMPTY_STRING_SET);
  }

  const merged: UnknownRecord = { ...resolved.node };
  const localKeys = new Set<string>();
  for (const [key, value] of localEntries) {
    merged[key] = value;
    localKeys.add(key);
  }
  return buildEntry(merged, resolved.location, true, localKeys);
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
): ResponseJsonSchemaEntry[] {
  if (!isRecord(operation.responses)) {
    return [];
  }
  const results: ResponseJsonSchemaEntry[] = [];
  for (const statusCode of statusCodes) {
    const entries = extractResponseJsonSchemas(
      operation.responses[statusCode],
      operationLocation.child(["responses", statusCode]),
      resolve,
    );
    if (entries.length > 0) {
      results.push(...entries);
      break;
    }
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
