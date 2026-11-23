import { createRuleIgnoreMatcher, HTTP_METHODS } from "../../src/ignore.js";
import type {
  AdsStandardMetadata,
  RedoclyLocation,
  RedoclyOas3Rule,
  RedoclyResolveResult,
  RedoclyUserContext,
} from "../../src/types.js";
import { PLUGIN_ID } from "../0001-resource-identifiers/rules.js";

export const ADS_0002_METADATA: AdsStandardMetadata = {
  ads: "0002",
  slug: "ads-0002",
  folder: "0002-top-level-json-response",
  rules: [
    {
      name: "ads-0002-top-level-json-object",
      id: `${PLUGIN_ID}/ads-0002-top-level-json-object`,
      severity: "error",
      summary:
        "Every 2xx JSON response must have a JSON object at the top level rather than a bare array or primitive value.",
    },
    {
      name: "ads-0002-no-single-resource-wrapper",
      id: `${PLUGIN_ID}/ads-0002-no-single-resource-wrapper`,
      severity: "error",
      summary:
        "Single-resource 2xx JSON responses must return resource fields directly at the top level rather than wrapping them in a single-key resource envelope or a generic `data`, `result`, or `payload` envelope.",
    },
    {
      name: "ads-0002-flat-creation-secret",
      id: `${PLUGIN_ID}/ads-0002-flat-creation-secret`,
      severity: "error",
      summary:
        "POST creation responses that return a one-time secret or token must return the resource flat at the top level with the secret as a sibling field rather than wrapping the resource and secret in a two-key envelope.",
    },
  ],
};

const SUCCESS_STATUS_RE = /^2(?:\d\d|XX)$/i;
const JSON_MEDIA_TYPE_RE = /^application\/(?!problem\+json)(?:[^;]+\+)?json\b/i;
const GENERIC_ENVELOPE_KEY_RE = /^(?:data|result|payload)$/i;
const SECRET_OR_TOKEN_PROP_RE = /^(?:secret|token|[a-z][a-zA-Z0-9]*(?:Secret|Token))$/;

type UnknownRecord = Record<string, unknown>;
type ResolverFn = RedoclyUserContext["resolve"];
type JsonSchemaType = "object" | "array" | "string" | "number" | "integer" | "boolean" | "null";

const ALL_JSON_TYPES: readonly JsonSchemaType[] = [
  "object",
  "array",
  "string",
  "number",
  "integer",
  "boolean",
  "null",
];

const JSON_TYPE_SET = new Set<string>(ALL_JSON_TYPES);

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isJsonSchemaType(value: unknown): value is JsonSchemaType {
  return typeof value === "string" && JSON_TYPE_SET.has(value);
}

function locationKey(location: RedoclyLocation): string {
  return location.absolutePointer ?? `${location.source?.absoluteRef ?? ""}#${location.pointer}`;
}

function safeResolveRecord(
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

function safeResolveSchema(
  resolve: ResolverFn,
  node: UnknownRecord,
  from?: string,
): RedoclyResolveResult<UnknownRecord | boolean> | null {
  if (typeof node.$ref !== "string") {
    return null;
  }
  try {
    const resolved = resolve<UnknownRecord | boolean>({ $ref: node.$ref }, from);
    if (
      !resolved ||
      resolved.error ||
      (!isRecord(resolved.node) && typeof resolved.node !== "boolean")
    ) {
      return null;
    }
    return resolved;
  } catch {
    return null;
  }
}

function jsonTypeOfValue(value: unknown): JsonSchemaType | null {
  if (value === null) {
    return "null";
  }
  if (Array.isArray(value)) {
    return "array";
  }
  switch (typeof value) {
    case "string":
      return "string";
    case "boolean":
      return "boolean";
    case "number":
      return Number.isInteger(value) ? "integer" : "number";
    case "object":
      return "object";
    default:
      return null;
  }
}

function isExplicitlyNonNullType(type: unknown): boolean {
  if (typeof type === "string") {
    return type !== "null";
  }
  if (Array.isArray(type)) {
    return type.length > 0 && !type.includes("null");
  }
  return false;
}

function schemaForbidsNull(
  schema: unknown,
  resolve: ResolverFn,
  from: string | undefined,
  seen: ReadonlySet<unknown> = new Set(),
  memo: Map<object, Map<string, { value: boolean; hitCycle: boolean }>> = new Map(),
): boolean {
  const visit = (
    node: unknown,
    currentFrom: string | undefined,
    currentSeen: ReadonlySet<unknown>,
  ): { value: boolean; hitCycle: boolean } => {
    if (node === false) {
      return { value: true, hitCycle: false };
    }
    if (node === true || !isRecord(node)) {
      return { value: false, hitCycle: false };
    }
    if (currentSeen.has(node)) {
      return { value: false, hitCycle: true };
    }

    const cacheKey = currentFrom ?? "";
    const cached = memo.get(node)?.get(cacheKey);
    if (cached) {
      return cached;
    }

    if (node.nullable === true) {
      return { value: false, hitCycle: false };
    }
    if (node.type === "null" || (Array.isArray(node.type) && node.type.includes("null"))) {
      return { value: false, hitCycle: false };
    }
    if (isExplicitlyNonNullType(node.type)) {
      return { value: true, hitCycle: false };
    }
    if (node.const !== undefined) {
      return { value: node.const !== null, hitCycle: false };
    }
    if (Array.isArray(node.enum) && node.enum.length > 0) {
      return { value: !node.enum.includes(null), hitCycle: false };
    }

    const nextSeen = new Set(currentSeen);
    nextSeen.add(node);
    let hitCycle = false;
    let value = false;

    if (typeof node.$ref === "string") {
      const resolved = safeResolveSchema(resolve, node, currentFrom);
      if (resolved) {
        if (resolved.node !== undefined) {
          const targetRes = visit(resolved.node, resolved.location?.source?.absoluteRef, nextSeen);
          if (targetRes.hitCycle) {
            hitCycle = true;
          }
          if (targetRes.value) {
            value = true;
          }
        }
        if (!value) {
          for (const hop of resolved.chain ?? []) {
            if (!isRecord(hop.node) || hop.node === node || hop.node === resolved.node) {
              continue;
            }
            const hopRes = visit(
              { ...hop.node, $ref: undefined },
              hop.location?.source?.absoluteRef,
              nextSeen,
            );
            if (hopRes.hitCycle) {
              hitCycle = true;
            }
            if (hopRes.value) {
              value = true;
              break;
            }
          }
        }
      }
    }

    if (!value && Array.isArray(node.allOf)) {
      for (const branch of node.allOf) {
        const branchRes = visit(branch, currentFrom, nextSeen);
        if (branchRes.hitCycle) {
          hitCycle = true;
        }
        if (branchRes.value) {
          value = true;
          break;
        }
      }
    }

    if (!value) {
      for (const unionKey of ["oneOf", "anyOf"] as const) {
        const branches = node[unionKey];
        if (!Array.isArray(branches) || branches.length === 0) {
          continue;
        }
        let allForbid = true;
        for (const branch of branches) {
          const branchRes = visit(branch, currentFrom, nextSeen);
          if (branchRes.hitCycle) {
            hitCycle = true;
          }
          if (!branchRes.value) {
            allForbid = false;
          }
        }
        if (allForbid) {
          value = true;
          break;
        }
      }
    }

    const result = { value, hitCycle };
    if (!hitCycle) {
      let nodeCache = memo.get(node);
      if (!nodeCache) {
        nodeCache = new Map();
        memo.set(node, nodeCache);
      }
      nodeCache.set(cacheKey, result);
    }
    return result;
  };

  return visit(schema, from, seen).value;
}

export function isNullableSchema(
  schema: unknown,
  resolve: ResolverFn,
  from?: string,
  seen: ReadonlySet<unknown> = new Set(),
): boolean {
  const memo = new Map<object, Map<string, { value: boolean; hitCycle: boolean }>>();
  const forbidsMemo = new Map<object, Map<string, { value: boolean; hitCycle: boolean }>>();

  const visit = (
    node: unknown,
    currentFrom: string | undefined,
    currentSeen: ReadonlySet<unknown>,
  ): { value: boolean; hitCycle: boolean } => {
    if (!isRecord(node)) {
      return { value: false, hitCycle: false };
    }
    if (currentSeen.has(node)) {
      return { value: false, hitCycle: true };
    }

    const cacheKey = currentFrom ?? "";
    const cached = memo.get(node)?.get(cacheKey);
    if (cached) {
      return cached;
    }

    if (node.nullable === true) {
      return { value: true, hitCycle: false };
    }
    if (node.type === "null") {
      return { value: true, hitCycle: false };
    }
    if (Array.isArray(node.type) && node.type.includes("null")) {
      return { value: true, hitCycle: false };
    }
    if (node.const === null) {
      return { value: true, hitCycle: false };
    }
    if (Array.isArray(node.enum) && node.enum.includes(null)) {
      return { value: true, hitCycle: false };
    }
    if (isExplicitlyNonNullType(node.type)) {
      return { value: false, hitCycle: false };
    }
    if (node.const !== undefined) {
      return { value: false, hitCycle: false };
    }
    if (Array.isArray(node.enum) && node.enum.length > 0) {
      return { value: false, hitCycle: false };
    }

    const nextSeen = new Set(currentSeen);
    nextSeen.add(node);
    let hitCycle = false;
    let value = false;

    if (typeof node.$ref === "string") {
      const resolved = safeResolveSchema(resolve, node, currentFrom);
      if (resolved) {
        if (resolved.node !== undefined) {
          const targetRes = visit(resolved.node, resolved.location?.source?.absoluteRef, nextSeen);
          if (targetRes.hitCycle) {
            hitCycle = true;
          }
          if (targetRes.value) {
            value = true;
          }
        }
        if (!value) {
          for (const hop of resolved.chain ?? []) {
            if (!isRecord(hop.node) || hop.node === node || hop.node === resolved.node) {
              continue;
            }
            const hopRes = visit(
              { ...hop.node, $ref: undefined },
              hop.location?.source?.absoluteRef,
              nextSeen,
            );
            if (hopRes.hitCycle) {
              hitCycle = true;
            }
            if (hopRes.value) {
              value = true;
              break;
            }
          }
        }
      }
    }

    if (!value) {
      for (const unionKey of ["oneOf", "anyOf"] as const) {
        const branches = node[unionKey];
        if (!Array.isArray(branches) || branches.length === 0) {
          continue;
        }
        for (const branch of branches) {
          const branchRes = visit(branch, currentFrom, nextSeen);
          if (branchRes.hitCycle) {
            hitCycle = true;
          }
          if (branchRes.value) {
            value = true;
            break;
          }
        }
        if (value) {
          break;
        }
      }
    }

    if (!value && Array.isArray(node.allOf) && node.allOf.length > 0) {
      let anyNullable = false;
      let anyForbidsNull = false;
      for (const branch of node.allOf) {
        if (schemaForbidsNull(branch, resolve, currentFrom, nextSeen, forbidsMemo)) {
          anyForbidsNull = true;
          break;
        }
        const branchRes = visit(branch, currentFrom, nextSeen);
        if (branchRes.hitCycle) {
          hitCycle = true;
        }
        if (branchRes.value) {
          anyNullable = true;
        }
      }
      if (anyNullable && !anyForbidsNull) {
        value = true;
      }
    }

    const result = { value, hitCycle };
    if (!hitCycle) {
      let nodeCache = memo.get(node);
      if (!nodeCache) {
        nodeCache = new Map();
        memo.set(node, nodeCache);
      }
      nodeCache.set(cacheKey, result);
    }
    return result;
  };

  return visit(schema, from, seen).value;
}

type StructuredObjectKind = "non-object" | "unknown" | "empty-object" | "structured";

function combineStructuredAllOf(
  a: StructuredObjectKind,
  b: StructuredObjectKind,
): StructuredObjectKind {
  if (a === "non-object" || b === "non-object") {
    return "non-object";
  }
  if (a === "structured" || b === "structured") {
    return "structured";
  }
  if (a === "empty-object" || b === "empty-object") {
    return "empty-object";
  }
  return "unknown";
}

function combineStructuredUnion(kinds: readonly StructuredObjectKind[]): StructuredObjectKind {
  if (kinds.length === 0) {
    return "unknown";
  }
  if (kinds.some((kind) => kind === "non-object")) {
    return "non-object";
  }
  if (kinds.every((kind) => kind === "structured")) {
    return "structured";
  }
  if (kinds.every((kind) => kind === "structured" || kind === "empty-object")) {
    return "empty-object";
  }
  return "unknown";
}

function localStructuredKind(node: UnknownRecord): StructuredObjectKind {
  if (typeof node.type === "string") {
    if (node.type !== "object") {
      return "non-object";
    }
  } else if (Array.isArray(node.type)) {
    const nonNullTypes = node.type.filter((item) => item !== "null");
    if (nonNullTypes.length === 0 || nonNullTypes.some((item) => item !== "object")) {
      return "non-object";
    }
  } else if (node.items !== undefined) {
    return "non-object";
  } else if (node.const !== undefined) {
    return jsonTypeOfValue(node.const) === "object" ? "empty-object" : "non-object";
  } else if (Array.isArray(node.enum) && node.enum.length > 0) {
    return node.enum.every((value) => jsonTypeOfValue(value) === "object")
      ? "empty-object"
      : "non-object";
  }

  if (isRecord(node.properties) && Object.keys(node.properties).length > 0) {
    return "structured";
  }
  if (
    node.type === "object" ||
    (Array.isArray(node.type) && node.type.includes("object")) ||
    isRecord(node.properties) ||
    node.additionalProperties !== undefined
  ) {
    return "empty-object";
  }
  return "unknown";
}

function classifyStructuredObject(
  schema: unknown,
  resolve: ResolverFn,
  from: string | undefined,
): StructuredObjectKind {
  const memo = new Map<object, Map<string, { kind: StructuredObjectKind; hitCycle: boolean }>>();

  const visit = (
    node: unknown,
    currentFrom: string | undefined,
    seen: ReadonlySet<unknown>,
    followRef: boolean,
  ): { kind: StructuredObjectKind; hitCycle: boolean } => {
    if (node === false) {
      return { kind: "non-object", hitCycle: false };
    }
    if (node === true || !isRecord(node)) {
      return { kind: "unknown", hitCycle: false };
    }
    if (seen.has(node)) {
      return { kind: "unknown", hitCycle: true };
    }

    const cacheKey = `${followRef ? 1 : 0}:${currentFrom ?? ""}`;
    const cached = memo.get(node)?.get(cacheKey);
    if (cached) {
      return cached;
    }

    const nextSeen = new Set(seen);
    nextSeen.add(node);

    let hitCycle = false;
    let kind = localStructuredKind(node);
    if (kind === "non-object") {
      return { kind: "non-object", hitCycle: false };
    }

    if (followRef && typeof node.$ref === "string") {
      const resolved = safeResolveSchema(resolve, node, currentFrom);
      if (resolved) {
        if (resolved.node !== undefined) {
          const targetRes = visit(
            resolved.node,
            resolved.location?.source?.absoluteRef,
            nextSeen,
            true,
          );
          if (targetRes.hitCycle) {
            hitCycle = true;
          }
          kind = combineStructuredAllOf(kind, targetRes.kind);
        }
        for (const hop of resolved.chain ?? []) {
          if (
            kind === "non-object" ||
            !isRecord(hop.node) ||
            hop.node === node ||
            hop.node === resolved.node
          ) {
            continue;
          }
          const hopRes = visit(hop.node, hop.location?.source?.absoluteRef, nextSeen, false);
          if (hopRes.hitCycle) {
            hitCycle = true;
          }
          kind = combineStructuredAllOf(kind, hopRes.kind);
        }
      }
    }

    if (kind !== "non-object" && Array.isArray(node.allOf)) {
      for (const branch of node.allOf) {
        const branchRes = visit(branch, currentFrom, nextSeen, true);
        if (branchRes.hitCycle) {
          hitCycle = true;
        }
        kind = combineStructuredAllOf(kind, branchRes.kind);
        if (kind === "non-object") {
          break;
        }
      }
    }

    if (kind !== "non-object") {
      for (const unionKey of ["oneOf", "anyOf"] as const) {
        const branches = node[unionKey];
        if (!Array.isArray(branches) || branches.length === 0) {
          continue;
        }
        const branchKinds: StructuredObjectKind[] = [];
        for (const branch of branches) {
          const branchRes = visit(branch, currentFrom, nextSeen, true);
          if (branchRes.hitCycle) {
            hitCycle = true;
          }
          branchKinds.push(branchRes.kind);
        }
        kind = combineStructuredAllOf(kind, combineStructuredUnion(branchKinds));
        if (kind === "non-object") {
          break;
        }
      }
    }

    const result = { kind, hitCycle };
    if (!hitCycle) {
      let nodeCache = memo.get(node);
      if (!nodeCache) {
        nodeCache = new Map();
        memo.set(node, nodeCache);
      }
      nodeCache.set(cacheKey, result);
    }
    return result;
  };

  return visit(schema, from, new Set(), true).kind;
}

export function isNonNullableStructuredObject(
  schema: unknown,
  resolve: ResolverFn,
  from?: string,
): boolean {
  if (!isRecord(schema)) {
    return false;
  }
  if (isNullableSchema(schema, resolve, from)) {
    return false;
  }
  return classifyStructuredObject(schema, resolve, from) === "structured";
}

type StringTypeKind = "string" | "null" | "non-string" | "unknown";

function combineStringAllOf(a: StringTypeKind, b: StringTypeKind): StringTypeKind {
  if (a === "non-string" || b === "non-string") {
    return "non-string";
  }
  if ((a === "string" && b === "null") || (a === "null" && b === "string")) {
    return "non-string";
  }
  if (a === "string" || b === "string") {
    return "string";
  }
  if (a === "null" || b === "null") {
    return "null";
  }
  return "unknown";
}

function combineStringUnion(kinds: readonly StringTypeKind[]): StringTypeKind {
  if (kinds.length === 0) {
    return "unknown";
  }
  if (kinds.some((kind) => kind === "non-string" || kind === "unknown")) {
    return "non-string";
  }
  if (kinds.some((kind) => kind === "string")) {
    return "string";
  }
  return "null";
}

function localStringKind(node: UnknownRecord): StringTypeKind {
  if (typeof node.type === "string") {
    if (node.type === "string") {
      return "string";
    }
    if (node.type === "null") {
      return "null";
    }
    return "non-string";
  }

  if (Array.isArray(node.type)) {
    if (node.type.length === 0) {
      return "non-string";
    }
    let hasString = false;
    for (const item of node.type) {
      if (item === "string") {
        hasString = true;
      } else if (item !== "null") {
        return "non-string";
      }
    }
    return hasString ? "string" : "null";
  }

  if (
    isRecord(node.properties) ||
    node.items !== undefined ||
    node.additionalProperties !== undefined
  ) {
    return "non-string";
  }

  if (node.const !== undefined) {
    if (typeof node.const === "string") {
      return "string";
    }
    if (node.const === null) {
      return "null";
    }
    return "non-string";
  }

  if (Array.isArray(node.enum) && node.enum.length > 0) {
    let hasString = false;
    for (const item of node.enum) {
      if (typeof item === "string") {
        hasString = true;
      } else if (item !== null) {
        return "non-string";
      }
    }
    return hasString ? "string" : "null";
  }

  return "unknown";
}

function classifyStringType(
  schema: unknown,
  resolve: ResolverFn,
  from: string | undefined,
): StringTypeKind {
  const memo = new Map<object, Map<string, { kind: StringTypeKind; hitCycle: boolean }>>();

  const visit = (
    node: unknown,
    currentFrom: string | undefined,
    seen: ReadonlySet<unknown>,
    followRef: boolean,
  ): { kind: StringTypeKind; hitCycle: boolean } => {
    if (node === false) {
      return { kind: "non-string", hitCycle: false };
    }
    if (node === true || !isRecord(node)) {
      return { kind: "unknown", hitCycle: false };
    }
    if (seen.has(node)) {
      return { kind: "unknown", hitCycle: true };
    }

    const cacheKey = `${followRef ? 1 : 0}:${currentFrom ?? ""}`;
    const cached = memo.get(node)?.get(cacheKey);
    if (cached) {
      return cached;
    }

    const nextSeen = new Set(seen);
    nextSeen.add(node);

    let hitCycle = false;
    let kind = localStringKind(node);
    if (kind === "non-string") {
      return { kind: "non-string", hitCycle: false };
    }

    if (followRef && typeof node.$ref === "string") {
      const resolved = safeResolveSchema(resolve, node, currentFrom);
      if (resolved) {
        if (resolved.node !== undefined) {
          const targetRes = visit(
            resolved.node,
            resolved.location?.source?.absoluteRef,
            nextSeen,
            true,
          );
          if (targetRes.hitCycle) {
            hitCycle = true;
          }
          kind = combineStringAllOf(kind, targetRes.kind);
        }
        for (const hop of resolved.chain ?? []) {
          if (
            kind === "non-string" ||
            !isRecord(hop.node) ||
            hop.node === node ||
            hop.node === resolved.node
          ) {
            continue;
          }
          const hopRes = visit(hop.node, hop.location?.source?.absoluteRef, nextSeen, false);
          if (hopRes.hitCycle) {
            hitCycle = true;
          }
          kind = combineStringAllOf(kind, hopRes.kind);
        }
      }
    }

    if (kind !== "non-string" && Array.isArray(node.allOf)) {
      for (const branch of node.allOf) {
        const branchRes = visit(branch, currentFrom, nextSeen, true);
        if (branchRes.hitCycle) {
          hitCycle = true;
        }
        kind = combineStringAllOf(kind, branchRes.kind);
        if (kind === "non-string") {
          break;
        }
      }
    }

    if (kind !== "non-string") {
      for (const unionKey of ["oneOf", "anyOf"] as const) {
        const branches = node[unionKey];
        if (!Array.isArray(branches) || branches.length === 0) {
          continue;
        }
        const branchKinds: StringTypeKind[] = [];
        for (const branch of branches) {
          const branchRes = visit(branch, currentFrom, nextSeen, true);
          if (branchRes.hitCycle) {
            hitCycle = true;
          }
          branchKinds.push(branchRes.kind);
        }
        kind = combineStringAllOf(kind, combineStringUnion(branchKinds));
        if (kind === "non-string") {
          break;
        }
      }
    }

    const result = { kind, hitCycle };
    if (!hitCycle) {
      let nodeCache = memo.get(node);
      if (!nodeCache) {
        nodeCache = new Map();
        memo.set(node, nodeCache);
      }
      nodeCache.set(cacheKey, result);
    }
    return result;
  };

  return visit(schema, from, new Set(), true).kind;
}

export function isStringTypedSchema(schema: unknown, resolve: ResolverFn, from?: string): boolean {
  return classifyStringType(schema, resolve, from) === "string";
}

interface AllowedTypesResult {
  readonly constrained: boolean;
  readonly types: ReadonlySet<JsonSchemaType>;
  readonly hitCycle: boolean;
}

function intersectTypeSets(
  a: ReadonlySet<JsonSchemaType>,
  b: ReadonlySet<JsonSchemaType>,
): Set<JsonSchemaType> {
  const out = new Set<JsonSchemaType>();
  for (const t of a) {
    if (b.has(t)) {
      out.add(t);
    } else if (t === "integer" && b.has("number")) {
      out.add("integer");
    } else if (t === "number" && b.has("integer")) {
      out.add("integer");
    }
  }
  return out;
}

function localAllowedTypes(node: UnknownRecord): {
  constrained: boolean;
  types: Set<JsonSchemaType>;
} {
  const types = new Set<JsonSchemaType>();
  let constrained = false;

  if (typeof node.type === "string" && isJsonSchemaType(node.type)) {
    constrained = true;
    types.add(node.type);
  } else if (Array.isArray(node.type)) {
    const validTypes = node.type.filter(isJsonSchemaType);
    if (validTypes.length > 0) {
      constrained = true;
      for (const item of validTypes) {
        types.add(item);
      }
    }
  } else if (node.items !== undefined) {
    constrained = true;
    types.add("array");
  } else if (isRecord(node.properties) || node.additionalProperties !== undefined) {
    constrained = true;
    types.add("object");
  } else if (node.const !== undefined) {
    const constType = jsonTypeOfValue(node.const);
    if (constType !== null) {
      constrained = true;
      types.add(constType);
    }
  } else if (Array.isArray(node.enum) && node.enum.length > 0) {
    for (const item of node.enum) {
      const enumType = jsonTypeOfValue(item);
      if (enumType !== null) {
        constrained = true;
        types.add(enumType);
      }
    }
  }

  return { constrained, types };
}

export function findNonObjectTopLevelKinds(
  schema: unknown,
  resolve: ResolverFn,
  from?: string,
): readonly JsonSchemaType[] {
  const memo = new Map<object, Map<string, AllowedTypesResult>>();

  const visit = (
    node: unknown,
    currentFrom: string | undefined,
    seen: ReadonlySet<unknown>,
    followRef: boolean,
  ): AllowedTypesResult => {
    if (node === true || node === false || !isRecord(node)) {
      return { constrained: false, types: new Set(), hitCycle: false };
    }
    if (seen.has(node)) {
      return { constrained: false, types: new Set(), hitCycle: true };
    }

    const cacheKey = `${followRef ? 1 : 0}:${currentFrom ?? ""}`;
    const cached = memo.get(node)?.get(cacheKey);
    if (cached) {
      return cached;
    }

    const nextSeen = new Set(seen);
    nextSeen.add(node);

    let hitCycle = false;
    const local = localAllowedTypes(node);
    let constrained = local.constrained;
    let allowed = local.types;
    const extraNonObjectFromConflict = new Set<JsonSchemaType>();

    const applyConstraint = (incoming: AllowedTypesResult): void => {
      if (incoming.hitCycle) {
        hitCycle = true;
      }
      if (!incoming.constrained) {
        return;
      }
      if (!constrained) {
        constrained = true;
        allowed = new Set(incoming.types);
        return;
      }
      const intersected = intersectTypeSets(allowed, incoming.types);
      if (intersected.size === 0) {
        for (const t of incoming.types) {
          if (t !== "object") {
            extraNonObjectFromConflict.add(t);
          }
        }
        for (const t of allowed) {
          if (t !== "object") {
            extraNonObjectFromConflict.add(t);
          }
        }
      }
      allowed = intersected;
    };

    if (followRef && typeof node.$ref === "string") {
      const resolved = safeResolveSchema(resolve, node, currentFrom);
      if (resolved) {
        if (resolved.node !== undefined) {
          applyConstraint(
            visit(resolved.node, resolved.location?.source?.absoluteRef, nextSeen, true),
          );
        }
        for (const hop of resolved.chain ?? []) {
          if (!isRecord(hop.node) || hop.node === node || hop.node === resolved.node) {
            continue;
          }
          applyConstraint(visit(hop.node, hop.location?.source?.absoluteRef, nextSeen, false));
        }
      }
    }

    if (Array.isArray(node.allOf)) {
      for (const branch of node.allOf) {
        applyConstraint(visit(branch, currentFrom, nextSeen, true));
      }
    }

    for (const unionKey of ["oneOf", "anyOf"] as const) {
      const branches = node[unionKey];
      if (!Array.isArray(branches) || branches.length === 0) {
        continue;
      }
      const unionTypes = new Set<JsonSchemaType>();
      let anyConstrained = false;
      for (const branch of branches) {
        const branchResult = visit(branch, currentFrom, nextSeen, true);
        if (branchResult.hitCycle) {
          hitCycle = true;
        }
        if (branchResult.constrained) {
          anyConstrained = true;
          for (const t of branchResult.types) {
            unionTypes.add(t);
          }
        }
      }
      if (anyConstrained) {
        applyConstraint({ constrained: true, types: unionTypes, hitCycle: false });
      }
    }

    if (node.nullable === true) {
      constrained = true;
      allowed.add("null");
    }

    for (const conflictType of extraNonObjectFromConflict) {
      constrained = true;
      allowed.add(conflictType);
    }

    const result: AllowedTypesResult = { constrained, types: allowed, hitCycle };
    if (!hitCycle) {
      let nodeCache = memo.get(node);
      if (!nodeCache) {
        nodeCache = new Map();
        memo.set(node, nodeCache);
      }
      nodeCache.set(cacheKey, result);
    }
    return result;
  };

  const result = visit(schema, from, new Set(), true);
  if (!result.constrained) {
    return [];
  }
  return ALL_JSON_TYPES.filter((t) => t !== "object" && result.types.has(t));
}

interface SchemaFragment {
  readonly node: unknown;
  readonly from?: string;
}

interface TrackedProperty {
  readonly name: string;
  readonly fragments: readonly SchemaFragment[];
  readonly location?: RedoclyLocation;
}

type PropertiesState =
  | { readonly kind: "exact"; readonly props: ReadonlyMap<string, TrackedProperty> }
  | { readonly kind: "many" };

interface TopLevelObjectSummary {
  readonly isObjectLike: boolean;
  readonly openAdditionalProperties: boolean;
  readonly propertiesState: PropertiesState;
  readonly genericEnvelopeProps: ReadonlyMap<string, TrackedProperty>;
}

interface CollectSummariesResult {
  readonly summaries: readonly TopLevelObjectSummary[];
  readonly hitCycle: boolean;
}

function mergeTrackedProperty(
  existing: TrackedProperty | undefined,
  incoming: TrackedProperty,
): TrackedProperty {
  if (!existing) {
    return incoming;
  }
  const fragments: SchemaFragment[] = [...existing.fragments];
  for (const frag of incoming.fragments) {
    if (!fragments.some((prev) => prev.node === frag.node && prev.from === frag.from)) {
      fragments.push(frag);
    }
  }
  const location = existing.location ?? incoming.location;
  return {
    name: existing.name,
    fragments,
    ...(location ? { location } : {}),
  };
}

function mergePropertiesState(base: PropertiesState, addition: PropertiesState): PropertiesState {
  if (base.kind === "many" || addition.kind === "many") {
    return { kind: "many" };
  }
  const merged = new Map<string, TrackedProperty>(base.props);
  for (const [name, prop] of addition.props.entries()) {
    merged.set(name, mergeTrackedProperty(merged.get(name), prop));
    if (merged.size > 2) {
      return { kind: "many" };
    }
  }
  return { kind: "exact", props: merged };
}

function mergeGenericMap(
  base: ReadonlyMap<string, TrackedProperty>,
  addition: ReadonlyMap<string, TrackedProperty>,
): Map<string, TrackedProperty> {
  const merged = new Map<string, TrackedProperty>(base);
  for (const [name, prop] of addition.entries()) {
    merged.set(name, mergeTrackedProperty(merged.get(name), prop));
  }
  return merged;
}

function mergeObjectSummaries(
  base: TopLevelObjectSummary,
  addition: TopLevelObjectSummary,
): TopLevelObjectSummary {
  return {
    isObjectLike: base.isObjectLike || addition.isObjectLike,
    openAdditionalProperties: base.openAdditionalProperties || addition.openAdditionalProperties,
    propertiesState: mergePropertiesState(base.propertiesState, addition.propertiesState),
    genericEnvelopeProps: mergeGenericMap(base.genericEnvelopeProps, addition.genericEnvelopeProps),
  };
}

function propertyNullabilityState(
  prop: TrackedProperty,
  resolve: ResolverFn,
): { nullable: boolean; forbidsNull: boolean } {
  let anyNullable = false;
  let anyForbidsNull = false;
  for (const frag of prop.fragments) {
    if (schemaForbidsNull(frag.node, resolve, frag.from, new Set())) {
      anyForbidsNull = true;
    }
    if (isNullableSchema(frag.node, resolve, frag.from)) {
      anyNullable = true;
    }
  }
  return {
    nullable: anyNullable && !anyForbidsNull,
    forbidsNull: anyForbidsNull,
  };
}

function propertyStructuredKind(prop: TrackedProperty, resolve: ResolverFn): StructuredObjectKind {
  let combined: StructuredObjectKind = "unknown";
  for (const frag of prop.fragments) {
    const fragKind = classifyStructuredObject(frag.node, resolve, frag.from);
    combined = combineStructuredAllOf(combined, fragKind);
    if (combined === "non-object") {
      return "non-object";
    }
  }
  return combined;
}

function propertyStringKind(prop: TrackedProperty, resolve: ResolverFn): StringTypeKind {
  let combined: StringTypeKind = "unknown";
  for (const frag of prop.fragments) {
    const fragKind = classifyStringType(frag.node, resolve, frag.from);
    combined = combineStringAllOf(combined, fragKind);
    if (combined === "non-string") {
      return "non-string";
    }
  }
  return combined;
}

function isPropertyNonNullableStructuredObject(
  prop: TrackedProperty,
  resolve: ResolverFn,
): boolean {
  if (prop.fragments.length === 0) {
    return false;
  }
  if (prop.fragments.length === 1) {
    const first = prop.fragments[0];
    return first ? isNonNullableStructuredObject(first.node, resolve, first.from) : false;
  }
  const { nullable } = propertyNullabilityState(prop, resolve);
  if (nullable) {
    return false;
  }
  return propertyStructuredKind(prop, resolve) === "structured";
}

function isPropertyStringTyped(prop: TrackedProperty, resolve: ResolverFn): boolean {
  if (prop.fragments.length === 0) {
    return false;
  }
  return propertyStringKind(prop, resolve) === "string";
}

function propertySignature(prop: TrackedProperty, resolve: ResolverFn): string {
  const structKind = propertyStructuredKind(prop, resolve);
  const strKind = propertyStringKind(prop, resolve);
  const { nullable, forbidsNull } = propertyNullabilityState(prop, resolve);
  return `${prop.name}:${structKind}:${strKind}:${nullable ? "1" : "0"}:${forbidsNull ? "1" : "0"}`;
}

function summarySignature(summary: TopLevelObjectSummary, resolve: ResolverFn): string {
  const prefix = `${summary.isObjectLike ? "1" : "0"}:${summary.openAdditionalProperties ? "1" : "0"}`;
  const genericSig = [...summary.genericEnvelopeProps.values()]
    .map((prop) => propertySignature(prop, resolve))
    .sort()
    .join(",");
  if (summary.propertiesState.kind === "many") {
    return `${prefix}:many:[${genericSig}]`;
  }
  const propSig = [...summary.propertiesState.props.values()]
    .map((prop) => propertySignature(prop, resolve))
    .sort()
    .join(",");
  return `${prefix}:exact:[${propSig}]:[${genericSig}]`;
}

function dedupeSummaries(
  list: readonly TopLevelObjectSummary[],
  resolve: ResolverFn,
): TopLevelObjectSummary[] {
  const bySignature = new Map<string, TopLevelObjectSummary>();
  for (const summary of list) {
    const sig = summarySignature(summary, resolve);
    if (!bySignature.has(sig)) {
      bySignature.set(sig, summary);
    }
  }
  return [...bySignature.values()];
}

function isExplicitlyNonObjectNode(node: UnknownRecord): boolean {
  if (typeof node.type === "string") {
    return node.type !== "object";
  }
  if (Array.isArray(node.type)) {
    return !node.type.includes("object");
  }
  return node.items !== undefined;
}

function collectTopLevelObjectSummaries(
  schema: unknown,
  resolve: ResolverFn,
  baseLocation: RedoclyLocation,
): readonly TopLevelObjectSummary[] {
  const memo = new Map<object, Map<string, CollectSummariesResult>>();

  const emptySummary: TopLevelObjectSummary = {
    isObjectLike: false,
    openAdditionalProperties: false,
    propertiesState: { kind: "exact", props: new Map() },
    genericEnvelopeProps: new Map(),
  };

  const combineSets = (
    currentSet: readonly TopLevelObjectSummary[],
    incomingSet: readonly TopLevelObjectSummary[],
  ): TopLevelObjectSummary[] => {
    if (incomingSet.length === 0) {
      return [...currentSet];
    }
    const combined: TopLevelObjectSummary[] = [];
    for (const current of currentSet) {
      for (const incoming of incomingSet) {
        combined.push(mergeObjectSummaries(current, incoming));
      }
    }
    return dedupeSummaries(combined, resolve);
  };

  const visit = (
    node: unknown,
    location: RedoclyLocation | undefined,
    seen: ReadonlySet<unknown>,
    followRef: boolean,
  ): CollectSummariesResult => {
    if (node === true) {
      return { summaries: [emptySummary], hitCycle: false };
    }
    if (node === false || !isRecord(node) || isExplicitlyNonObjectNode(node)) {
      return { summaries: [], hitCycle: false };
    }
    if (seen.has(node)) {
      return { summaries: [], hitCycle: true };
    }

    const cacheKey = `${followRef ? 1 : 0}:${location?.source?.absoluteRef ?? ""}#${location?.pointer ?? ""}`;
    const cached = memo.get(node)?.get(cacheKey);
    if (cached) {
      return cached;
    }

    const nextSeen = new Set(seen);
    nextSeen.add(node);

    let hitCycle = false;
    let summaries: TopLevelObjectSummary[] = [emptySummary];

    if (followRef && typeof node.$ref === "string") {
      const resolved = safeResolveSchema(resolve, node, location?.source?.absoluteRef);
      if (resolved) {
        if (resolved.node !== undefined) {
          const targetResult = visit(resolved.node, resolved.location, nextSeen, true);
          if (targetResult.hitCycle) {
            hitCycle = true;
          }
          if (targetResult.summaries.length === 0 && !targetResult.hitCycle) {
            summaries = [];
          } else {
            summaries = combineSets(summaries, targetResult.summaries);
          }
        }
        for (const hop of resolved.chain ?? []) {
          if (
            summaries.length === 0 ||
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
          if (hopResult.summaries.length === 0 && !hopResult.hitCycle) {
            summaries = [];
          } else {
            summaries = combineSets(summaries, hopResult.summaries);
          }
        }
      }
    }

    if (summaries.length > 0 && Array.isArray(node.allOf)) {
      for (const [index, branch] of node.allOf.entries()) {
        const branchResult = visit(branch, location?.child(["allOf", index]), nextSeen, true);
        if (branchResult.hitCycle) {
          hitCycle = true;
        }
        if (branchResult.summaries.length === 0 && !branchResult.hitCycle) {
          summaries = [];
          break;
        }
        summaries = combineSets(summaries, branchResult.summaries);
      }
    }

    if (summaries.length > 0) {
      const openAdditionalProperties =
        node.additionalProperties === true || isRecord(node.additionalProperties);
      const hasObjectType =
        node.type === "object" || (Array.isArray(node.type) && node.type.includes("object"));
      const directProps = new Map<string, TrackedProperty>();
      const directGeneric = new Map<string, TrackedProperty>();
      let directPropsMany = false;

      if (isRecord(node.properties)) {
        const entries = Object.entries(node.properties);
        const from = location?.source?.absoluteRef;
        if (entries.length > 2) {
          directPropsMany = true;
        }
        for (const [propName, propSchema] of entries) {
          const propLocation = location?.child(["properties", propName]);
          const tracked: TrackedProperty = {
            name: propName,
            fragments: [{ node: propSchema, ...(from !== undefined ? { from } : {}) }],
            ...(propLocation ? { location: propLocation } : {}),
          };
          if (!directPropsMany) {
            directProps.set(propName, tracked);
          }
          if (GENERIC_ENVELOPE_KEY_RE.test(propName)) {
            directGeneric.set(propName, tracked);
          }
        }
      }

      const directObjectLike =
        hasObjectType || isRecord(node.properties) || node.additionalProperties !== undefined;

      if (directObjectLike) {
        summaries = combineSets(summaries, [
          {
            isObjectLike: true,
            openAdditionalProperties,
            propertiesState: directPropsMany
              ? { kind: "many" }
              : { kind: "exact", props: directProps },
            genericEnvelopeProps: directGeneric,
          },
        ]);
      }
    }

    if (summaries.length > 0) {
      for (const unionKey of ["oneOf", "anyOf"] as const) {
        const branches = node[unionKey];
        if (!Array.isArray(branches) || branches.length === 0) {
          continue;
        }
        const branchSummaries: TopLevelObjectSummary[] = [];
        let branchHitCycle = false;
        for (const [index, branch] of branches.entries()) {
          const branchResult = visit(branch, location?.child([unionKey, index]), nextSeen, true);
          if (branchResult.hitCycle) {
            hitCycle = true;
            branchHitCycle = true;
          }
          branchSummaries.push(...branchResult.summaries);
        }
        if (branchSummaries.length === 0) {
          if (!branchHitCycle) {
            summaries = [];
            break;
          }
        } else {
          summaries = combineSets(summaries, dedupeSummaries(branchSummaries, resolve));
        }
      }
    }

    const result: CollectSummariesResult = { summaries, hitCycle };
    if (!hitCycle) {
      let nodeCache = memo.get(node);
      if (!nodeCache) {
        nodeCache = new Map();
        memo.set(node, nodeCache);
      }
      nodeCache.set(cacheKey, result);
    }
    return result;
  };

  return visit(schema, baseLocation, new Set(), true).summaries.filter(
    (summary) => summary.isObjectLike,
  );
}

interface SuccessJsonResponseEntry {
  readonly pathTemplate: string;
  readonly method: string;
  readonly statusCode: string;
  readonly mediaType: string;
  readonly schema: unknown;
  readonly schemaLocation: RedoclyLocation;
  readonly reportBaseLocation: RedoclyLocation;
}

function collectSuccessJsonResponses(
  root: unknown,
  ctx: RedoclyUserContext,
  options: Record<string, unknown>,
  methodFilter?: (method: string) => boolean,
): SuccessJsonResponseEntry[] {
  if (!isRecord(root) || !isRecord(root.paths)) {
    return [];
  }

  const ignoreMatcher = createRuleIgnoreMatcher(options);
  const results: SuccessJsonResponseEntry[] = [];

  for (const [pathTemplate, rawPathItem] of Object.entries(root.paths)) {
    if (!pathTemplate.startsWith("/")) {
      continue;
    }

    let pathItemLocation = ctx.location.child(["paths", pathTemplate]);
    let pathItem: unknown = rawPathItem;
    if (isRecord(rawPathItem) && typeof rawPathItem.$ref === "string") {
      const resolved = safeResolveRecord(
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

    if (!isRecord(pathItem)) {
      continue;
    }

    for (const method of HTTP_METHODS) {
      if (methodFilter && !methodFilter(method)) {
        continue;
      }
      const operation = pathItem[method];
      if (!isRecord(operation) || !isRecord(operation.responses)) {
        continue;
      }
      if (ignoreMatcher.isIgnored({ path: pathTemplate, method })) {
        continue;
      }

      for (const [statusCode, rawResponse] of Object.entries(operation.responses)) {
        if (statusCode === "204" || !SUCCESS_STATUS_RE.test(statusCode)) {
          continue;
        }
        if (!isRecord(rawResponse)) {
          continue;
        }

        const operationResponseLocation = pathItemLocation.child([method, "responses", statusCode]);
        let responseLocation = operationResponseLocation;
        let response: UnknownRecord = rawResponse;
        let resolvedFromRef = false;
        if (typeof rawResponse.$ref === "string") {
          const resolved = safeResolveRecord(
            ctx.resolve,
            rawResponse,
            operationResponseLocation.source?.absoluteRef,
          );
          if (!resolved?.node) {
            continue;
          }
          response = resolved.node;
          resolvedFromRef = true;
          if (resolved.location) {
            responseLocation = resolved.location;
          }
        }

        if (!isRecord(response.content)) {
          continue;
        }

        for (const [mediaType, mediaObj] of Object.entries(response.content)) {
          if (!JSON_MEDIA_TYPE_RE.test(mediaType)) {
            continue;
          }
          if (!isRecord(mediaObj) || mediaObj.schema === undefined) {
            continue;
          }
          const schemaLocation = responseLocation.child(["content", mediaType, "schema"]);
          const reportBaseLocation = resolvedFromRef ? operationResponseLocation : schemaLocation;
          results.push({
            pathTemplate,
            method,
            statusCode,
            mediaType,
            schema: mediaObj.schema,
            schemaLocation,
            reportBaseLocation,
          });
        }
      }
    }
  }

  return results;
}

function selectPropertyReportLocation(
  prop: TrackedProperty,
  schemaLocation: RedoclyLocation,
  reportBaseLocation: RedoclyLocation,
): RedoclyLocation {
  if (
    prop.location &&
    prop.location.source?.absoluteRef === reportBaseLocation.source?.absoluteRef &&
    prop.location.pointer.startsWith(`${schemaLocation.pointer}/`)
  ) {
    return prop.location.key();
  }
  return reportBaseLocation;
}

export const ads0002TopLevelJsonObject: RedoclyOas3Rule = (options = {}) => {
  return {
    Root: {
      leave(root, ctx) {
        const responses = collectSuccessJsonResponses(root, ctx, options);
        for (const entry of responses) {
          const disallowed = findNonObjectTopLevelKinds(
            entry.schema,
            ctx.resolve,
            entry.schemaLocation.source?.absoluteRef,
          );
          if (disallowed.length === 0) {
            continue;
          }
          const formatted = disallowed.map((kind) => `"${kind}"`).join(", ");
          ctx.report({
            message: `${entry.method.toUpperCase()} "${entry.pathTemplate}" (${entry.statusCode} ${entry.mediaType}) allows non-object top-level JSON type (${formatted}). Every 2xx JSON response must have a JSON object at the root (ADS-0002).`,
            location: entry.reportBaseLocation,
          });
        }
      },
    },
  };
};

export const ads0002NoSingleResourceWrapper: RedoclyOas3Rule = (options = {}) => {
  return {
    Root: {
      leave(root, ctx) {
        const responses = collectSuccessJsonResponses(root, ctx, options);
        for (const entry of responses) {
          const summaries = collectTopLevelObjectSummaries(
            entry.schema,
            ctx.resolve,
            entry.schemaLocation,
          );
          const reportedProps = new Set<string>();

          for (const summary of summaries) {
            const singleKeyProp =
              !summary.openAdditionalProperties &&
              summary.propertiesState.kind === "exact" &&
              summary.propertiesState.props.size === 1
                ? [...summary.propertiesState.props.values()][0]
                : undefined;

            for (const [propName, prop] of summary.genericEnvelopeProps.entries()) {
              if (!isPropertyNonNullableStructuredObject(prop, ctx.resolve)) {
                continue;
              }
              const reportLocation = selectPropertyReportLocation(
                prop,
                entry.schemaLocation,
                entry.reportBaseLocation,
              );
              const dedupeKey = `${locationKey(reportLocation)}:${propName}`;
              if (reportedProps.has(dedupeKey)) {
                continue;
              }
              reportedProps.add(dedupeKey);
              ctx.report({
                message: `${entry.method.toUpperCase()} "${entry.pathTemplate}" (${entry.statusCode} ${entry.mediaType}) wraps a structured object under generic envelope key "${propName}". Return single-resource fields directly at the top level instead of using a generic "${propName}" envelope (ADS-0002).`,
                location: reportLocation,
              });
            }

            if (
              singleKeyProp &&
              !GENERIC_ENVELOPE_KEY_RE.test(singleKeyProp.name) &&
              isPropertyNonNullableStructuredObject(singleKeyProp, ctx.resolve)
            ) {
              const reportLocation = selectPropertyReportLocation(
                singleKeyProp,
                entry.schemaLocation,
                entry.reportBaseLocation,
              );
              const dedupeKey = `${locationKey(reportLocation)}:${singleKeyProp.name}`;
              if (reportedProps.has(dedupeKey)) {
                continue;
              }
              reportedProps.add(dedupeKey);
              ctx.report({
                message: `${entry.method.toUpperCase()} "${entry.pathTemplate}" (${entry.statusCode} ${entry.mediaType}) wraps a single resource inside top-level key "${singleKeyProp.name}". Return resource fields directly at the top level instead of using a single-key wrapper envelope (ADS-0002).`,
                location: reportLocation,
              });
            }
          }
        }
      },
    },
  };
};

export const ads0002FlatCreationSecret: RedoclyOas3Rule = (options = {}) => {
  return {
    Root: {
      leave(root, ctx) {
        const responses = collectSuccessJsonResponses(
          root,
          ctx,
          options,
          (method) => method === "post",
        );

        for (const entry of responses) {
          const summaries = collectTopLevelObjectSummaries(
            entry.schema,
            ctx.resolve,
            entry.schemaLocation,
          );
          const reportedPairs = new Set<string>();

          for (const summary of summaries) {
            if (
              summary.openAdditionalProperties ||
              summary.propertiesState.kind !== "exact" ||
              summary.propertiesState.props.size !== 2
            ) {
              continue;
            }

            const [first, second] = [...summary.propertiesState.props.values()];
            if (!first || !second) {
              continue;
            }

            let resourceProp: TrackedProperty | undefined;
            let secretProp: TrackedProperty | undefined;

            if (
              isPropertyNonNullableStructuredObject(first, ctx.resolve) &&
              SECRET_OR_TOKEN_PROP_RE.test(second.name) &&
              isPropertyStringTyped(second, ctx.resolve)
            ) {
              resourceProp = first;
              secretProp = second;
            } else if (
              isPropertyNonNullableStructuredObject(second, ctx.resolve) &&
              SECRET_OR_TOKEN_PROP_RE.test(first.name) &&
              isPropertyStringTyped(first, ctx.resolve)
            ) {
              resourceProp = second;
              secretProp = first;
            }

            if (!resourceProp || !secretProp) {
              continue;
            }

            const pairKey = `${locationKey(entry.reportBaseLocation)}:${resourceProp.name}:${secretProp.name}`;
            if (reportedPairs.has(pairKey)) {
              continue;
            }
            reportedPairs.add(pairKey);
            ctx.report({
              message: `POST "${entry.pathTemplate}" (${entry.statusCode} ${entry.mediaType}) wraps created resource "${resourceProp.name}" alongside one-time secret field "${secretProp.name}". Return the resource fields flat at the top level with "${secretProp.name}" as a sibling top-level property (ADS-0002).`,
              location: entry.reportBaseLocation,
            });
          }
        }
      },
    },
  };
};

export const ads0002Rules: Record<string, RedoclyOas3Rule> = {
  "ads-0002-top-level-json-object": ads0002TopLevelJsonObject,
  "ads-0002-no-single-resource-wrapper": ads0002NoSingleResourceWrapper,
  "ads-0002-flat-creation-secret": ads0002FlatCreationSecret,
};
