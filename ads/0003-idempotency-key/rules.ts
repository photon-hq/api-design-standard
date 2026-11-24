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

interface ResolvedParameter {
  readonly parameter: UnknownRecord;
  readonly location: RedoclyLocation;
}

function resolveParameters(
  rawParams: unknown,
  baseLocation: RedoclyLocation,
  ctx: RedoclyUserContext,
): ResolvedParameter[] {
  if (!Array.isArray(rawParams)) {
    return [];
  }
  const resolvedParams: ResolvedParameter[] = [];
  for (const [index, rawParam] of rawParams.entries()) {
    const location = baseLocation.child(["parameters", index]);
    const resolved = resolveRecordWithLocation(ctx.resolve, rawParam, location);
    if (resolved) {
      resolvedParams.push({ parameter: resolved.node, location });
    }
  }
  return resolvedParams;
}

const parameterIdentity = ({ parameter }: ResolvedParameter): string =>
  `${String(parameter.in)}:${String(parameter.name)}`;

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
    const pathLevel = resolveParameters(pathItem.node.parameters, pathItem.location, ctx);
    for (const method of HTTP_METHODS) {
      const operation = pathItem.node[method];
      if (!isRecord(operation)) {
        continue;
      }
      const operationLevel = resolveParameters(
        operation.parameters,
        pathItem.location.child([method]),
        ctx,
      );
      // OpenAPI identifies a parameter by its exact name and location; an operation-level one overrides a path-level one.
      const overridden = new Set(operationLevel.map(parameterIdentity));
      const effective = [
        ...operationLevel,
        ...pathLevel.filter((param) => !overridden.has(parameterIdentity(param))),
      ];
      for (const param of effective) {
        if (isIdempotencyKeyHeader(param.parameter)) {
          usages.push({ pathTemplate, method, ...param });
        }
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
