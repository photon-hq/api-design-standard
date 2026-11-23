import { HTTP_METHODS } from "../../src/ignore.js";
import { isRecord, resolveRecordWithLocation, type UnknownRecord } from "../../src/schema-utils.js";
import type {
  AdsStandardMetadata,
  RedoclyLocation,
  RedoclyOas3Rule,
  RedoclyUserContext,
} from "../../src/types.js";
import { PLUGIN_ID } from "../0001-resource-identifiers/rules.js";

export const ADS_0003_METADATA: AdsStandardMetadata = {
  ads: "0003",
  slug: "ads-0003",
  folder: "0003-idempotency-key",
  rules: [
    {
      name: "ads-0003-idempotency-key-method",
      id: `${PLUGIN_ID}/ads-0003-idempotency-key-method`,
      severity: "error",
      summary:
        "`GET`, `HEAD`, `OPTIONS`, `PUT`, and `DELETE` operations must not declare an `Idempotency-Key` header parameter.",
    },
    {
      name: "ads-0003-idempotency-key-optional",
      id: `${PLUGIN_ID}/ads-0003-idempotency-key-optional`,
      severity: "error",
      summary:
        "An `Idempotency-Key` header parameter on a `POST` or `PATCH` operation must be optional, never `required: true`.",
    },
  ],
};

const IDEMPOTENCY_KEY_HEADER = "idempotency-key";
const KEY_ALLOWED_METHODS = new Set(["post", "patch"]);
const KEY_FORBIDDEN_METHODS = new Set(["get", "head", "options", "put", "delete"]);

export interface IdempotencyKeyUsage {
  readonly pathTemplate: string;
  readonly method: string;
  readonly parameter: UnknownRecord;
  readonly location: RedoclyLocation;
}

export function isIdempotencyKeyHeader(parameter: unknown): parameter is UnknownRecord {
  return (
    isRecord(parameter) &&
    parameter.in === "header" &&
    typeof parameter.name === "string" &&
    parameter.name.trim().toLowerCase() === IDEMPOTENCY_KEY_HEADER
  );
}

function findIdempotencyKey(
  rawParams: unknown,
  baseLocation: RedoclyLocation,
  ctx: RedoclyUserContext,
): { parameter: UnknownRecord; location: RedoclyLocation } | undefined {
  if (!Array.isArray(rawParams)) {
    return undefined;
  }
  for (const [index, rawParam] of rawParams.entries()) {
    const location = baseLocation.child(["parameters", index]);
    const resolved = resolveRecordWithLocation(ctx.resolve, rawParam, location);
    if (resolved && isIdempotencyKeyHeader(resolved.node)) {
      return { parameter: resolved.node, location };
    }
  }
  return undefined;
}

export function collectIdempotencyKeyUsages(
  paths: unknown,
  ctx: RedoclyUserContext,
): IdempotencyKeyUsage[] {
  if (!isRecord(paths)) {
    return [];
  }
  const usages: IdempotencyKeyUsage[] = [];
  for (const [pathTemplate, rawPathItem] of Object.entries(paths)) {
    const pathItem = resolveRecordWithLocation(
      ctx.resolve,
      rawPathItem,
      ctx.location.child([pathTemplate]),
    );
    if (!pathItem) {
      continue;
    }
    const pathLevel = findIdempotencyKey(pathItem.node.parameters, pathItem.location, ctx);
    for (const method of HTTP_METHODS) {
      const operation = pathItem.node[method];
      if (!isRecord(operation)) {
        continue;
      }
      // An operation-level parameter overrides a path-level one with the same name and location.
      const usage =
        findIdempotencyKey(operation.parameters, pathItem.location.child([method]), ctx) ??
        pathLevel;
      if (usage) {
        usages.push({ pathTemplate, method, ...usage });
      }
    }
  }
  return usages;
}

export const ads0003IdempotencyKeyMethod: RedoclyOas3Rule = () => ({
  Paths: {
    leave(paths, ctx) {
      for (const usage of collectIdempotencyKeyUsages(paths, ctx)) {
        if (!KEY_FORBIDDEN_METHODS.has(usage.method)) {
          continue;
        }
        ctx.report({
          message: `${usage.method.toUpperCase()} "${usage.pathTemplate}" declares an "Idempotency-Key" header parameter. Only POST and PATCH operations may declare "Idempotency-Key"; remove it from this operation (ADS-0003).`,
          location: usage.location,
        });
      }
    },
  },
});

export const ads0003IdempotencyKeyOptional: RedoclyOas3Rule = () => ({
  Paths: {
    leave(paths, ctx) {
      for (const usage of collectIdempotencyKeyUsages(paths, ctx)) {
        if (!KEY_ALLOWED_METHODS.has(usage.method) || usage.parameter.required !== true) {
          continue;
        }
        ctx.report({
          message: `${usage.method.toUpperCase()} "${usage.pathTemplate}" requires the "Idempotency-Key" header. "Idempotency-Key" must be optional; remove "required: true" (ADS-0003).`,
          location: usage.location,
        });
      }
    },
  },
});

export const ads0003Rules: Record<string, RedoclyOas3Rule> = {
  "ads-0003-idempotency-key-method": ads0003IdempotencyKeyMethod,
  "ads-0003-idempotency-key-optional": ads0003IdempotencyKeyOptional,
};
