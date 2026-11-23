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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function unescapeJsonPointerToken(token: string): string {
  return token.replaceAll("~1", "/").replaceAll("~0", "~");
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

    let path: string | undefined;
    if (rawEntry.path !== undefined) {
      if (typeof rawEntry.path !== "string") {
        continue;
      }
      const normalized = normalizeIgnorePath(rawEntry.path);
      if (normalized.length === 0) {
        continue;
      }
      path = normalized;
    }

    let method: string | undefined;
    if (rawEntry.method !== undefined) {
      if (typeof rawEntry.method !== "string") {
        continue;
      }
      const normalized = normalizeIgnoreMethod(rawEntry.method);
      if (normalized.length === 0) {
        continue;
      }
      method = normalized;
    }

    let schema: string | undefined;
    if (rawEntry.schema !== undefined) {
      if (typeof rawEntry.schema !== "string") {
        continue;
      }
      const normalized = normalizeIgnoreSchema(rawEntry.schema);
      if (normalized.length === 0) {
        continue;
      }
      schema = normalized;
    }

    if (path === undefined && schema === undefined) {
      continue;
    }

    let reason: string | undefined;
    if (typeof rawEntry.reason === "string") {
      const trimmedReason = rawEntry.reason.trim();
      if (trimmedReason.length > 0) {
        reason = trimmedReason;
      }
    }

    entries.push({
      ...(path !== undefined ? { path } : {}),
      ...(method !== undefined ? { method } : {}),
      ...(schema !== undefined ? { schema } : {}),
      ...(reason !== undefined ? { reason } : {}),
    });
  }

  return entries;
}

function entryMatchesTarget(entry: NormalizedIgnoreEntry, target: IgnoreMatchTarget): boolean {
  if (entry.path !== undefined) {
    if (target.path === undefined) {
      return false;
    }
    const normalizedTargetPath = normalizeIgnorePath(target.path);
    if (normalizedTargetPath.length === 0 || normalizedTargetPath !== entry.path) {
      return false;
    }
  }

  if (entry.method !== undefined) {
    if (target.method === undefined) {
      return false;
    }
    const normalizedTargetMethod = normalizeIgnoreMethod(target.method);
    if (normalizedTargetMethod.length === 0 || normalizedTargetMethod !== entry.method) {
      return false;
    }
  }

  if (entry.schema !== undefined) {
    if (target.schema === undefined) {
      return false;
    }
    const normalizedTargetSchema = normalizeIgnoreSchema(target.schema);
    if (normalizedTargetSchema.length === 0 || normalizedTargetSchema !== entry.schema) {
      return false;
    }
  }

  return true;
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
