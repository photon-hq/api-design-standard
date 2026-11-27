import { HTTP_METHODS } from "../../src/ignore.js";
import {
  isRecord,
  resolveRecordWithLocation,
  safeResolveSchema,
  type UnknownRecord,
} from "../../src/schema-utils.js";
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
    {
      name: "ads-0003-idempotency-key-name",
      id: `${PLUGIN_ID}/ads-0003-idempotency-key-name`,
      severity: "error",
      summary:
        "An `Idempotency-Key` header parameter on a `POST` or `PATCH` operation must use the exact canonical name `Idempotency-Key`.",
    },
    {
      name: "ads-0003-idempotency-key-schema",
      id: `${PLUGIN_ID}/ads-0003-idempotency-key-schema`,
      severity: "error",
      summary:
        "An `Idempotency-Key` header parameter on a `POST` or `PATCH` operation must use the schema `type: string`, `minLength: 1`, `maxLength: 255`, `pattern: ^[\\x21-\\x7e]{1,255}$`.",
    },
    {
      name: "ads-0003-idempotency-no-required-problem",
      id: `${PLUGIN_ID}/ads-0003-idempotency-no-required-problem`,
      severity: "error",
      summary:
        "Operation responses must not reference `IdempotencyKeyRequiredProblem` or the `IDEMPOTENCY_KEY_REQUIRED` problem code.",
    },
    {
      name: "ads-0003-idempotent-replayed-header",
      id: `${PLUGIN_ID}/ads-0003-idempotent-replayed-header`,
      severity: "error",
      summary:
        "Only `POST` and `PATCH` operations that declare `Idempotency-Key` may declare an `Idempotent-Replayed` response header.",
    },
    {
      name: "ads-0003-idempotency-problems",
      id: `${PLUGIN_ID}/ads-0003-idempotency-problems`,
      severity: "error",
      summary:
        "`POST` and `PATCH` operations that declare `Idempotency-Key` must document the `400`, `409` (with `Retry-After`), `422`, and `503` idempotency problem responses, and must not use `IdempotencyConflictProblem`.",
    },
  ],
};

const IDEMPOTENCY_KEY_HEADER = "Idempotency-Key";
const KEY_ALLOWED_METHODS = new Set(["post", "patch"]);
const KEY_FORBIDDEN_METHODS = new Set(["get", "head", "options", "put", "delete"]);
const KEY_SCHEMA: Readonly<Record<string, unknown>> = {
  type: "string",
  minLength: 1,
  maxLength: 255,
  pattern: "^[\\x21-\\x7e]{1,255}$",
};
const PROBLEM_MEDIA_TYPE_RE = /^application\/problem\+json(?:\s*;|$)/i;
const COMPONENT_SCHEMA_REF_RE = /\/components\/schemas\/([^/]+)$/;

interface Problem {
  readonly status: string;
  readonly name: string;
  readonly code: string;
}

const REQUIRED_PROBLEM: Problem = {
  status: "400",
  name: "IdempotencyKeyRequiredProblem",
  code: "IDEMPOTENCY_KEY_REQUIRED",
};
const CONFLICT_PROBLEM: Problem = {
  status: "409",
  name: "IdempotencyConflictProblem",
  code: "IDEMPOTENCY_CONFLICT",
};
const IN_PROGRESS_PROBLEM: Problem = {
  status: "409",
  name: "IdempotencyRequestInProgressProblem",
  code: "IDEMPOTENCY_REQUEST_IN_PROGRESS",
};
const EXPECTED_PROBLEMS: readonly Problem[] = [
  { status: "400", name: "IdempotencyKeyInvalidProblem", code: "IDEMPOTENCY_KEY_INVALID" },
  IN_PROGRESS_PROBLEM,
  { status: "422", name: "IdempotencyKeyReusedProblem", code: "IDEMPOTENCY_KEY_REUSED" },
  { status: "503", name: "IdempotencyUnavailableProblem", code: "IDEMPOTENCY_UNAVAILABLE" },
];

interface ResolvedNode {
  readonly node: UnknownRecord;
  readonly location: RedoclyLocation;
}

export interface OperationEntry {
  readonly pathTemplate: string;
  readonly method: string;
  readonly operation: UnknownRecord;
  readonly location: RedoclyLocation;
  readonly idempotencyKeys: readonly ResolvedNode[];
}

interface ResponseEntry {
  readonly status: string;
  readonly response: UnknownRecord;
  readonly usageLocation: RedoclyLocation;
  readonly location: RedoclyLocation;
}

export function isIdempotencyKeyHeader(parameter: unknown): parameter is UnknownRecord {
  return (
    isRecord(parameter) &&
    parameter.in === "header" &&
    typeof parameter.name === "string" &&
    parameter.name.trim().toLowerCase() === IDEMPOTENCY_KEY_HEADER.toLowerCase()
  );
}

function resolveParameters(
  rawParams: unknown,
  baseLocation: RedoclyLocation,
  ctx: RedoclyUserContext,
): ResolvedNode[] {
  if (!Array.isArray(rawParams)) {
    return [];
  }
  const resolvedParams: ResolvedNode[] = [];
  for (const [index, rawParam] of rawParams.entries()) {
    const location = baseLocation.child(["parameters", index]);
    const resolved = resolveRecordWithLocation(ctx.resolve, rawParam, location);
    if (resolved) {
      resolvedParams.push({ node: resolved.node, location });
    }
  }
  return resolvedParams;
}

const parameterIdentity = ({ node }: ResolvedNode): string =>
  `${String(node.in)}:${String(node.name)}`;

export function collectOperations(paths: unknown, ctx: RedoclyUserContext): OperationEntry[] {
  if (!isRecord(paths)) {
    return [];
  }
  const operations: OperationEntry[] = [];
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
      const location = pathItem.location.child([method]);
      const operationLevel = resolveParameters(operation.parameters, location, ctx);
      // OpenAPI identifies a parameter by its exact name and location; an operation-level one overrides a path-level one.
      const overridden = new Set(operationLevel.map(parameterIdentity));
      const effective = [
        ...operationLevel,
        ...pathLevel.filter((param) => !overridden.has(parameterIdentity(param))),
      ];
      operations.push({
        pathTemplate,
        method,
        operation,
        location,
        idempotencyKeys: effective.filter((param) => isIdempotencyKeyHeader(param.node)),
      });
    }
  }
  return operations;
}

const declaresKey = (entry: OperationEntry): boolean =>
  KEY_ALLOWED_METHODS.has(entry.method) && entry.idempotencyKeys.length > 0;

const label = (entry: OperationEntry): string =>
  `${entry.method.toUpperCase()} "${entry.pathTemplate}"`;

function resolveResponses(entry: OperationEntry, ctx: RedoclyUserContext): ResponseEntry[] {
  const responses = entry.operation.responses;
  if (!isRecord(responses)) {
    return [];
  }
  const resolvedResponses: ResponseEntry[] = [];
  for (const [status, rawResponse] of Object.entries(responses)) {
    const usageLocation = entry.location.child(["responses", status]);
    const resolved = resolveRecordWithLocation(ctx.resolve, rawResponse, usageLocation);
    if (resolved) {
      resolvedResponses.push({
        status,
        response: resolved.node,
        usageLocation,
        location: resolved.location,
      });
    }
  }
  return resolvedResponses;
}

function collectProblemIds(
  schema: unknown,
  ctx: RedoclyUserContext,
  from: string | undefined,
  ids: Set<string>,
  seen: Set<unknown>,
): void {
  if (!isRecord(schema) || seen.has(schema)) {
    return;
  }
  seen.add(schema);
  if (typeof schema.$ref === "string") {
    const name = COMPONENT_SCHEMA_REF_RE.exec(schema.$ref)?.[1];
    if (name) {
      ids.add(name);
    }
    const resolved = safeResolveSchema(ctx.resolve, schema, from);
    collectProblemIds(
      resolved?.node,
      ctx,
      resolved?.location?.source?.absoluteRef ?? from,
      ids,
      seen,
    );
  }
  const code = isRecord(schema.properties) ? schema.properties.code : undefined;
  if (isRecord(code)) {
    for (const value of [code.const, ...(Array.isArray(code.enum) ? code.enum : [])]) {
      if (typeof value === "string") {
        ids.add(value);
      }
    }
  }
  for (const key of ["oneOf", "anyOf", "allOf"] as const) {
    const branches = schema[key];
    if (Array.isArray(branches)) {
      for (const branch of branches) {
        collectProblemIds(branch, ctx, from, ids, seen);
      }
    }
  }
}

function responseProblemIds(
  { response, location }: ResponseEntry,
  ctx: RedoclyUserContext,
  mediaTypeFilter?: RegExp,
): Set<string> {
  const ids = new Set<string>();
  if (!isRecord(response.content)) {
    return ids;
  }
  for (const [mediaType, media] of Object.entries(response.content)) {
    if (isRecord(media) && (!mediaTypeFilter || mediaTypeFilter.test(mediaType))) {
      collectProblemIds(media.schema, ctx, location.source?.absoluteRef, ids, new Set());
    }
  }
  return ids;
}

const hasProblem = (ids: ReadonlySet<string>, problem: Problem): boolean =>
  ids.has(problem.name) || ids.has(problem.code);

function headerNames(response: UnknownRecord): string[] {
  return isRecord(response.headers) ? Object.keys(response.headers) : [];
}

function operationRule(
  check: (entry: OperationEntry, ctx: RedoclyUserContext) => void,
): RedoclyOas3Rule {
  return () => ({
    Paths: {
      leave(paths, ctx) {
        for (const entry of collectOperations(paths, ctx)) {
          check(entry, ctx);
        }
      },
    },
  });
}

export const ads0003IdempotencyKeyMethod = operationRule((entry, ctx) => {
  if (!KEY_FORBIDDEN_METHODS.has(entry.method)) {
    return;
  }
  for (const key of entry.idempotencyKeys) {
    ctx.report({
      message: `${label(entry)} declares an "Idempotency-Key" header parameter. Only POST and PATCH operations may declare "Idempotency-Key"; remove it from this operation (ADS-0003).`,
      location: key.location,
    });
  }
});

export const ads0003IdempotencyKeyOptional = operationRule((entry, ctx) => {
  if (!KEY_ALLOWED_METHODS.has(entry.method)) {
    return;
  }
  for (const key of entry.idempotencyKeys) {
    if (key.node.required === true) {
      ctx.report({
        message: `${label(entry)} requires the "Idempotency-Key" header. "Idempotency-Key" must be optional; remove "required: true" (ADS-0003).`,
        location: key.location,
      });
    }
  }
});

export const ads0003IdempotencyKeyName = operationRule((entry, ctx) => {
  if (!KEY_ALLOWED_METHODS.has(entry.method)) {
    return;
  }
  for (const key of entry.idempotencyKeys) {
    if (key.node.name !== IDEMPOTENCY_KEY_HEADER) {
      ctx.report({
        message: `${label(entry)} declares the idempotency header as "${String(key.node.name)}". Use the exact name "${IDEMPOTENCY_KEY_HEADER}" (ADS-0003).`,
        location: key.location,
      });
    }
  }
});

export const ads0003IdempotencyKeySchema = operationRule((entry, ctx) => {
  if (!KEY_ALLOWED_METHODS.has(entry.method)) {
    return;
  }
  for (const key of entry.idempotencyKeys) {
    const schema = resolveRecordWithLocation(ctx.resolve, key.node.schema, key.location)?.node;
    const mismatches = Object.entries(KEY_SCHEMA)
      .filter(([field, expected]) => schema?.[field] !== expected)
      .map(([field, expected]) =>
        typeof expected === "string" ? `${field}: "${expected}"` : `${field}: ${expected}`,
      );
    if (mismatches.length > 0) {
      ctx.report({
        message: `${label(entry)} declares "Idempotency-Key" with a non-standard schema. Set ${mismatches.join(", ")} (ADS-0003).`,
        location: key.location,
      });
    }
  }
});

export const ads0003IdempotencyNoRequiredProblem = operationRule((entry, ctx) => {
  for (const response of resolveResponses(entry, ctx)) {
    if (hasProblem(responseProblemIds(response, ctx), REQUIRED_PROBLEM)) {
      ctx.report({
        message: `${label(entry)} ${response.status} response references "${REQUIRED_PROBLEM.name}". "Idempotency-Key" is never required, so remove "${REQUIRED_PROBLEM.code}" from the contract (ADS-0003).`,
        location: response.usageLocation,
      });
    }
  }
});

export const ads0003IdempotentReplayedHeader = operationRule((entry, ctx) => {
  if (declaresKey(entry)) {
    return;
  }
  for (const response of resolveResponses(entry, ctx)) {
    for (const name of headerNames(response.response)) {
      if (name.toLowerCase() === "idempotent-replayed") {
        ctx.report({
          message: `${label(entry)} ${response.status} response declares "${name}" but the operation does not accept "Idempotency-Key". Remove the header (ADS-0003).`,
          location: response.location.child(["headers", name]),
        });
      }
    }
  }
});

export const ads0003IdempotencyProblems = operationRule((entry, ctx) => {
  if (!declaresKey(entry)) {
    return;
  }
  const responses = resolveResponses(entry, ctx);
  for (const response of responses) {
    if (
      (response.status === "409" || response.status === "422") &&
      hasProblem(responseProblemIds(response, ctx), CONFLICT_PROBLEM)
    ) {
      ctx.report({
        message: `${label(entry)} ${response.status} response uses "${CONFLICT_PROBLEM.name}", which is not a registry problem. Use "IdempotencyKeyReusedProblem" (422) or "${IN_PROGRESS_PROBLEM.name}" (409) (ADS-0003).`,
        location: response.usageLocation,
      });
    }
  }
  for (const problem of EXPECTED_PROBLEMS) {
    const response = responses.find((candidate) => candidate.status === problem.status);
    if (!response) {
      ctx.report({
        message: `${label(entry)} declares "Idempotency-Key" but documents no ${problem.status} response. Add a ${problem.status} application/problem+json response that includes "${problem.name}" (ADS-0003).`,
        location: entry.location.child(["responses"]),
      });
      continue;
    }
    if (!hasProblem(responseProblemIds(response, ctx, PROBLEM_MEDIA_TYPE_RE), problem)) {
      ctx.report({
        message: `${label(entry)} ${problem.status} response does not include "${problem.name}" (code "${problem.code}") in its application/problem+json schema (ADS-0003).`,
        location: response.usageLocation,
      });
    }
    if (
      problem === IN_PROGRESS_PROBLEM &&
      !headerNames(response.response).some((name) => name.toLowerCase() === "retry-after")
    ) {
      ctx.report({
        message: `${label(entry)} 409 response does not declare a "Retry-After" header. Document "Retry-After" (seconds) for "${problem.name}" (ADS-0003).`,
        location: response.usageLocation,
      });
    }
  }
});

export const ads0003Rules: Record<string, RedoclyOas3Rule> = {
  "ads-0003-idempotency-key-method": ads0003IdempotencyKeyMethod,
  "ads-0003-idempotency-key-optional": ads0003IdempotencyKeyOptional,
  "ads-0003-idempotency-key-name": ads0003IdempotencyKeyName,
  "ads-0003-idempotency-key-schema": ads0003IdempotencyKeySchema,
  "ads-0003-idempotency-no-required-problem": ads0003IdempotencyNoRequiredProblem,
  "ads-0003-idempotent-replayed-header": ads0003IdempotentReplayedHeader,
  "ads-0003-idempotency-problems": ads0003IdempotencyProblems,
};
