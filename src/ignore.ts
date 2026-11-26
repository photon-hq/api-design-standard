import { isRecord, unescapeJsonPointerToken } from "./schema-utils.js";
import type { AdsRuleOptions } from "./types.js";

export const HTTP_METHODS = [
  "get",
  "put",
  "post",
  "delete",
  "options",
  "head",
  "patch",
  "trace",
] as const;

export type HttpMethod = (typeof HTTP_METHODS)[number];

const HTTP_METHOD_SET = new Set<string>(HTTP_METHODS);
const COMPONENT_SCHEMA_ROOT_RE = /^#?\/components\/schemas\/([^/]+)(?:\/|$)/;
const PATH_POINTER_RE = /^#?\/paths\/([^/]+)(?:\/([^/]+)(?:\/|$))?/;

export interface NormalizedIgnoreEntry {
  readonly path?: string;
  readonly method?: string;
  readonly schema?: string;
  readonly reason?: string;
}

export interface IgnoreMatchTarget {
  readonly path?: string;
  readonly method?: string;
  readonly schema?: string;
}

export interface PointerContext {
  readonly schema?: string;
  readonly path?: string;
  readonly method?: string;
}

export interface RuleIgnoreMatcher {
  readonly entries: readonly NormalizedIgnoreEntry[];
  isIgnored(target: IgnoreMatchTarget): boolean;
  areAllPathOperationsIgnored(path: string, pathItem: unknown): boolean;
}

export function isPointerContextIgnored(
  ignoreMatcher: RuleIgnoreMatcher,
  pointerCtx: PointerContext,
): boolean {
  if (pointerCtx.schema !== undefined) {
    return ignoreMatcher.isIgnored({ schema: pointerCtx.schema });
  }
  if (pointerCtx.path !== undefined) {
    if (pointerCtx.method !== undefined) {
      return ignoreMatcher.isIgnored({ path: pointerCtx.path, method: pointerCtx.method });
    }
    return ignoreMatcher.isIgnored({ path: pointerCtx.path });
  }
  return false;
}

export function normalizeIgnorePath(rawPath: string): string {
  const trimmed = rawPath.trim();
  if (trimmed.length === 0) {
    return "";
  }
  const withoutTrailing = trimmed.replace(/\/+$/, "");
  return withoutTrailing.length === 0 ? "/" : withoutTrailing;
}

export function normalizeIgnoreMethod(rawMethod: string): string {
  return rawMethod.trim().toLowerCase();
}

export function normalizeIgnoreSchema(rawSchema: string): string {
  return rawSchema.trim();
}

export function extractPointerContext(pointer?: string): PointerContext {
  if (!pointer) {
    return {};
  }

  const schemaMatch = COMPONENT_SCHEMA_ROOT_RE.exec(pointer);
  if (schemaMatch?.[1]) {
    return { schema: unescapeJsonPointerToken(schemaMatch[1]) };
  }

  const pathMatch = PATH_POINTER_RE.exec(pointer);
  if (pathMatch?.[1]) {
    const path = unescapeJsonPointerToken(pathMatch[1]);
    const rawSegment = pathMatch[2] ? unescapeJsonPointerToken(pathMatch[2]).toLowerCase() : "";
    if (rawSegment.length > 0 && HTTP_METHOD_SET.has(rawSegment)) {
      return { path, method: rawSegment };
    }
    return { path };
  }

  return {};
}

type OptionalFieldParse = { readonly ok: true; readonly value?: string } | { readonly ok: false };

function parseOptionalSelector(
  raw: unknown,
  normalize: (value: string) => string,
): OptionalFieldParse {
  if (raw === undefined) {
    return { ok: true };
  }
  if (typeof raw !== "string") {
    return { ok: false };
  }
  const normalized = normalize(raw);
  return normalized.length > 0 ? { ok: true, value: normalized } : { ok: false };
}

export function parseRuleIgnoreEntries(options?: unknown): readonly NormalizedIgnoreEntry[] {
  if (!isRecord(options)) {
    return [];
  }

  const rawIgnore = (options as AdsRuleOptions & Record<string, unknown>).ignore;
  if (!Array.isArray(rawIgnore)) {
    return [];
  }

  const entries: NormalizedIgnoreEntry[] = [];

  for (const rawEntry of rawIgnore) {
    if (!isRecord(rawEntry)) {
      continue;
    }

    const parsedPath = parseOptionalSelector(rawEntry.path, normalizeIgnorePath);
    const parsedMethod = parseOptionalSelector(rawEntry.method, normalizeIgnoreMethod);
    const parsedSchema = parseOptionalSelector(rawEntry.schema, normalizeIgnoreSchema);
    if (!parsedPath.ok || !parsedMethod.ok || !parsedSchema.ok) {
      continue;
    }

    const path = parsedPath.value;
    const method = parsedMethod.value;
    const schema = parsedSchema.value;
    if (path === undefined && schema === undefined) {
      continue;
    }

    const reason =
      typeof rawEntry.reason === "string" && rawEntry.reason.trim().length > 0
        ? rawEntry.reason.trim()
        : undefined;

    entries.push({
      ...(path !== undefined ? { path } : {}),
      ...(method !== undefined ? { method } : {}),
      ...(schema !== undefined ? { schema } : {}),
      ...(reason !== undefined ? { reason } : {}),
    });
  }

  return entries;
}

function selectorMatches(
  expected: string | undefined,
  actual: string | undefined,
  normalize: (value: string) => string,
): boolean {
  if (expected === undefined) {
    return true;
  }
  if (actual === undefined) {
    return false;
  }
  const normalized = normalize(actual);
  return normalized.length > 0 && normalized === expected;
}

function entryMatchesTarget(entry: NormalizedIgnoreEntry, target: IgnoreMatchTarget): boolean {
  return (
    selectorMatches(entry.path, target.path, normalizeIgnorePath) &&
    selectorMatches(entry.method, target.method, normalizeIgnoreMethod) &&
    selectorMatches(entry.schema, target.schema, normalizeIgnoreSchema)
  );
}

export function createRuleIgnoreMatcher(options?: unknown): RuleIgnoreMatcher {
  const entries = parseRuleIgnoreEntries(options);

  const isIgnored = (target: IgnoreMatchTarget): boolean => {
    if (entries.length === 0) {
      return false;
    }
    for (const entry of entries) {
      if (entryMatchesTarget(entry, target)) {
        return true;
      }
    }
    return false;
  };

  const areAllPathOperationsIgnored = (path: string, pathItem: unknown): boolean => {
    if (entries.length === 0) {
      return false;
    }
    if (isIgnored({ path })) {
      return true;
    }
    if (!isRecord(pathItem)) {
      return false;
    }
    const presentMethods = HTTP_METHODS.filter((method) => isRecord(pathItem[method]));
    if (presentMethods.length === 0) {
      return false;
    }
    return presentMethods.every((method) => isIgnored({ path, method }));
  };

  return {
    entries,
    isIgnored,
    areAllPathOperationsIgnored,
  };
}
