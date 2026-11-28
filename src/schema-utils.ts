import type {
  RedoclyLocation,
  RedoclyResolveChainItem,
  RedoclyResolveResult,
  RedoclyUserContext,
} from "./types.js";

export type UnknownRecord = Record<string, unknown>;
export type ResolverFn = RedoclyUserContext["resolve"];

export type JsonSchemaType =
  | "object"
  | "array"
  | "string"
  | "number"
  | "integer"
  | "boolean"
  | "null";

export const ALL_JSON_TYPES: readonly JsonSchemaType[] = [
  "object",
  "array",
  "string",
  "number",
  "integer",
  "boolean",
  "null",
];

export const ALL_JSON_TYPE_SET: ReadonlySet<JsonSchemaType> = new Set(ALL_JSON_TYPES);
export const EMPTY_TYPE_SET: ReadonlySet<JsonSchemaType> = new Set();
export const MAX_OBJECT_VARIANTS = 256;

const COMPONENT_SCHEMA_POINTER_RE = /#\/components\/schemas\/([^/]+)$/;

export function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function locationKey(location: RedoclyLocation): string {
  return location.absolutePointer ?? `${location.source?.absoluteRef ?? ""}#${location.pointer}`;
}

export function unescapeJsonPointerToken(token: string): string {
  return token.replaceAll("~1", "/").replaceAll("~0", "~");
}

export function extractComponentSchemaName(
  refOrPointer?: string,
  options?: { readonly decodeUri?: boolean },
): string | undefined {
  if (!refOrPointer) {
    return undefined;
  }
  const match = COMPONENT_SCHEMA_POINTER_RE.exec(refOrPointer);
  if (!match?.[1]) {
    return undefined;
  }
  if (options?.decodeUri) {
    try {
      return unescapeJsonPointerToken(decodeURIComponent(match[1]));
    } catch {
      return unescapeJsonPointerToken(match[1]);
    }
  }
  return unescapeJsonPointerToken(match[1]);
}

export function setNodeCacheEntry<T>(
  memo: Map<object, Map<string, T>>,
  node: object,
  cacheKey: string,
  value: T,
): void {
  let nodeCache = memo.get(node);
  if (!nodeCache) {
    nodeCache = new Map();
    memo.set(node, nodeCache);
  }
  nodeCache.set(cacheKey, value);
}

export function isExplicitlyNonObjectNode(
  node: UnknownRecord,
  options?: { readonly treatItemsAsArray?: boolean },
): boolean {
  if (typeof node.type === "string") {
    return node.type !== "object";
  }
  if (Array.isArray(node.type)) {
    return !node.type.includes("object");
  }
  return options?.treatItemsAsArray === true && node.items !== undefined;
}

export function safeResolveRecord(
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

export function safeResolveSchema(
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

export function getRefIntermediateHops(
  node: UnknownRecord,
  resolved: RedoclyResolveResult<UnknownRecord | boolean>,
  options?: { readonly reverse?: boolean },
): Array<RedoclyResolveChainItem<UnknownRecord> & { readonly node: UnknownRecord }> {
  const chain = resolved.chain;
  if (!chain || chain.length === 0) {
    return [];
  }
  const reverse = options?.reverse ?? true;
  const hops: Array<RedoclyResolveChainItem<UnknownRecord> & { readonly node: UnknownRecord }> = [];
  const start = reverse ? chain.length - 1 : 0;
  const step = reverse ? -1 : 1;
  for (let index = start; reverse ? index >= 0 : index < chain.length; index += step) {
    const hop = chain[index];
    if (!hop || !isRecord(hop.node) || hop.node === node || hop.node === resolved.node) {
      continue;
    }
    hops.push({ ...hop, node: hop.node });
  }
  return hops;
}

export function resolveRecordWithLocation(
  resolve: ResolverFn,
  rawNode: unknown,
  fallbackLocation: RedoclyLocation,
): { node: UnknownRecord; location: RedoclyLocation; resolvedFromRef: boolean } | null {
  if (!isRecord(rawNode)) {
    return null;
  }
  if (typeof rawNode.$ref !== "string") {
    return { node: rawNode, location: fallbackLocation, resolvedFromRef: false };
  }
  const resolved = safeResolveRecord(resolve, rawNode, fallbackLocation.source?.absoluteRef);
  if (!resolved?.node) {
    return null;
  }
  return {
    node: resolved.node,
    location: resolved.location ?? fallbackLocation,
    resolvedFromRef: true,
  };
}

export function isJsonSchemaType(value: unknown): value is JsonSchemaType {
  return typeof value === "string" && ALL_JSON_TYPE_SET.has(value as JsonSchemaType);
}

export function jsonTypeOfValue(value: unknown): JsonSchemaType | null {
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

export function intersectTypeSets(
  a: ReadonlySet<JsonSchemaType>,
  b: ReadonlySet<JsonSchemaType>,
): Set<JsonSchemaType> {
  const out = new Set<JsonSchemaType>();
  for (const t of a) {
    if (b.has(t)) {
      out.add(t);
    } else if ((t === "integer" && b.has("number")) || (t === "number" && b.has("integer"))) {
      out.add("integer");
    }
  }
  return out;
}

export function formatAllowedTypes(allowed: ReadonlySet<JsonSchemaType>, separator = "|"): string {
  return ALL_JSON_TYPES.filter((t) => allowed.has(t)).join(separator);
}

export function formatTypeSummary(allowed: ReadonlySet<JsonSchemaType>): string {
  return allowed.size > 0 ? formatAllowedTypes(allowed) : "never";
}

export function extractNodeDeclaredTypeSets(
  node: UnknownRecord,
  includeNullableOnType = false,
): ReadonlySet<JsonSchemaType>[] {
  const sets: ReadonlySet<JsonSchemaType>[] = [];

  if (typeof node.type === "string" && isJsonSchemaType(node.type)) {
    const types = new Set<JsonSchemaType>([node.type]);
    if (includeNullableOnType && node.nullable === true) {
      types.add("null");
    }
    sets.push(types);
  } else if (Array.isArray(node.type)) {
    const validTypes = node.type.filter(isJsonSchemaType);
    if (validTypes.length > 0) {
      const types = new Set<JsonSchemaType>(validTypes);
      if (includeNullableOnType && node.nullable === true) {
        types.add("null");
      }
      sets.push(types);
    }
  }

  if (node.const !== undefined) {
    const constType = jsonTypeOfValue(node.const);
    if (constType !== null) {
      sets.push(new Set<JsonSchemaType>([constType]));
    }
  }

  if (Array.isArray(node.enum) && node.enum.length > 0) {
    const enumTypes = new Set<JsonSchemaType>();
    for (const item of node.enum) {
      const itemType = jsonTypeOfValue(item);
      if (itemType !== null) {
        enumTypes.add(itemType);
      }
    }
    if (enumTypes.size > 0) {
      sets.push(enumTypes);
    }
  }

  return sets;
}

export interface TypeConstraint {
  readonly allowed: ReadonlySet<JsonSchemaType>;
}

export const UNCONSTRAINED_TYPE_CONSTRAINT: TypeConstraint = {
  allowed: ALL_JSON_TYPE_SET,
};

export const FALSE_TYPE_CONSTRAINT: TypeConstraint = {
  allowed: EMPTY_TYPE_SET,
};

export function combineTypeConstraintAllOf(a: TypeConstraint, b: TypeConstraint): TypeConstraint {
  return { allowed: intersectTypeSets(a.allowed, b.allowed) };
}

export function combineTypeConstraintUnion(values: readonly TypeConstraint[]): TypeConstraint {
  if (values.length === 0) {
    return UNCONSTRAINED_TYPE_CONSTRAINT;
  }
  const allowed = new Set<JsonSchemaType>();
  for (const item of values) {
    for (const t of item.allowed) {
      allowed.add(t);
    }
  }
  return { allowed };
}

export function localTypeConstraint(node: UnknownRecord): TypeConstraint {
  let result = UNCONSTRAINED_TYPE_CONSTRAINT;
  for (const types of extractNodeDeclaredTypeSets(node, true)) {
    result = combineTypeConstraintAllOf(result, { allowed: types });
  }
  return result;
}

export function finalizeTypeConstraint(node: UnknownRecord, value: TypeConstraint): TypeConstraint {
  if (node.nullable !== true) {
    return value;
  }
  if (node.type !== undefined) {
    return value;
  }
  if (node.const !== undefined && node.const !== null) {
    return value;
  }
  if (Array.isArray(node.enum) && node.enum.length > 0 && !node.enum.includes(null)) {
    return value;
  }
  const allowed = new Set<JsonSchemaType>(value.allowed);
  allowed.add("null");
  return { allowed };
}

export function computeTypeConstraint(
  schema: unknown,
  resolve: ResolverFn,
  from?: string,
): TypeConstraint {
  return walkSchemaLattice<TypeConstraint>(schema, resolve, from, {
    falseValue: FALSE_TYPE_CONSTRAINT,
    unknownValue: UNCONSTRAINED_TYPE_CONSTRAINT,
    local: localTypeConstraint,
    combineAllOf: combineTypeConstraintAllOf,
    combineUnion: (values) => combineTypeConstraintUnion(values),
    finalize: finalizeTypeConstraint,
  });
}

export function isStrictlyNullConstraint(tc: TypeConstraint): boolean {
  return tc.allowed.size === 1 && tc.allowed.has("null");
}

export function allowsNullConstraint(tc: TypeConstraint): boolean {
  return tc.allowed.has("null");
}

export function allowsNonNullConstraint(tc: TypeConstraint): boolean {
  for (const t of tc.allowed) {
    if (t !== "null") {
      return true;
    }
  }
  return false;
}

export function isNonNullStringConstraint(tc: TypeConstraint): boolean {
  return tc.allowed.size === 1 && tc.allowed.has("string");
}

export function isNonNullIntegerConstraint(tc: TypeConstraint): boolean {
  return tc.allowed.size === 1 && tc.allowed.has("integer");
}

export function isNonNullObjectConstraint(tc: TypeConstraint): boolean {
  return tc.allowed.size === 1 && tc.allowed.has("object");
}

export interface SchemaFragment {
  readonly node: unknown;
  readonly from?: string;
  readonly location?: RedoclyLocation;
}

export interface TrackedProperty {
  readonly name: string;
  readonly fragments: readonly SchemaFragment[];
  readonly location?: RedoclyLocation;
}

export function mergeTrackedProperty(
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

export function mergeTrackedPropertyMaps(
  base: ReadonlyMap<string, TrackedProperty>,
  addition: ReadonlyMap<string, TrackedProperty>,
): Map<string, TrackedProperty> {
  const merged = new Map<string, TrackedProperty>(base);
  for (const [name, prop] of addition.entries()) {
    merged.set(name, mergeTrackedProperty(merged.get(name), prop));
  }
  return merged;
}

export function extractLocalProperties(
  node: UnknownRecord,
  location: RedoclyLocation | undefined,
  from: string | undefined,
): Map<string, TrackedProperty> {
  const properties = new Map<string, TrackedProperty>();
  if (!isRecord(node.properties)) {
    return properties;
  }
  for (const [propName, propSchema] of Object.entries(node.properties)) {
    const propLocation = location?.child(["properties", propName]);
    properties.set(propName, {
      name: propName,
      fragments: [
        {
          node: propSchema,
          ...(from !== undefined ? { from } : {}),
          ...(propLocation ? { location: propLocation } : {}),
        },
      ],
      ...(propLocation ? { location: propLocation } : {}),
    });
  }
  return properties;
}

export function extractLocalRequired(node: UnknownRecord): Set<string> {
  const required = new Set<string>();
  if (!Array.isArray(node.required)) {
    return required;
  }
  for (const item of node.required) {
    if (typeof item === "string") {
      required.add(item);
    }
  }
  return required;
}

export function foldSchemaFragments<T>(
  fragments: readonly SchemaFragment[],
  initial: T,
  combine: (acc: T, next: T) => T,
  evaluate: (frag: SchemaFragment) => T,
  stopWhen?: (acc: T) => boolean,
): T {
  let acc = initial;
  for (const frag of fragments) {
    acc = combine(acc, evaluate(frag));
    if (stopWhen?.(acc)) {
      return acc;
    }
  }
  return acc;
}

export function computeFragmentsTypeConstraint(
  fragments: readonly SchemaFragment[],
  resolve: ResolverFn,
): TypeConstraint {
  return foldSchemaFragments(
    fragments,
    UNCONSTRAINED_TYPE_CONSTRAINT,
    combineTypeConstraintAllOf,
    (frag) => computeTypeConstraint(frag.node, resolve, frag.from),
  );
}

export function propertyTypeConstraint(prop: TrackedProperty, resolve: ResolverFn): TypeConstraint {
  return computeFragmentsTypeConstraint(prop.fragments, resolve);
}

export function selectPropertyReportLocation(
  prop: TrackedProperty | undefined,
  schemaLocation: RedoclyLocation,
  reportBaseLocation: RedoclyLocation,
): RedoclyLocation {
  if (
    prop?.location &&
    prop.location.source?.absoluteRef === reportBaseLocation.source?.absoluteRef &&
    prop.location.pointer.startsWith(`${schemaLocation.pointer}/`)
  ) {
    return prop.location.key();
  }
  return reportBaseLocation;
}

export function someSchemaBranch(
  schema: unknown,
  resolve: ResolverFn,
  from: string | undefined,
  predicate: (
    node: UnknownRecord,
    resolved: RedoclyResolveResult<UnknownRecord | boolean> | null,
  ) => boolean,
  options?: {
    readonly combinators?: readonly ("allOf" | "oneOf" | "anyOf")[];
    readonly requireRecordRefTarget?: boolean;
  },
): boolean {
  const combinators = options?.combinators ?? (["allOf", "oneOf", "anyOf"] as const);
  const requireRecordRefTarget = options?.requireRecordRefTarget ?? false;
  const seen = new Set<unknown>();

  const visit = (node: unknown, currentFrom: string | undefined): boolean => {
    if (!isRecord(node) || seen.has(node)) {
      return false;
    }
    seen.add(node);

    const resolved =
      typeof node.$ref === "string" ? safeResolveSchema(resolve, node, currentFrom) : null;

    if (predicate(node, resolved)) {
      return true;
    }

    if (resolved && (!requireRecordRefTarget || isRecord(resolved.node))) {
      if (visit(resolved.node, resolved.location?.source?.absoluteRef)) {
        return true;
      }
    }

    for (const key of combinators) {
      const branches = node[key];
      if (!Array.isArray(branches)) {
        continue;
      }
      for (const branch of branches) {
        if (visit(branch, currentFrom)) {
          return true;
        }
      }
    }

    return false;
  };

  return visit(schema, from);
}

export interface SchemaLatticeOps<T> {
  readonly falseValue: T;
  readonly unknownValue: T;
  isAbsorbing?(value: T): boolean;
  local(node: UnknownRecord): T;
  combineAllOf(a: T, b: T): T;
  combineUnion(values: readonly T[], unionKey: "oneOf" | "anyOf"): T;
  finalize?(node: UnknownRecord, value: T): T;
}

export function walkSchemaLattice<T>(
  schema: unknown,
  resolve: ResolverFn,
  from: string | undefined,
  ops: SchemaLatticeOps<T>,
): T {
  const memo = new Map<object, Map<string, { value: T; hitCycle: boolean }>>();
  const isAbsorbing = ops.isAbsorbing ?? (() => false);

  const visitBody = (
    node: UnknownRecord,
    currentFrom: string | undefined,
    nextSeen: ReadonlySet<unknown>,
    followRef: boolean,
  ): { value: T; hitCycle: boolean } => {
    let hitCycle = false;
    let value = ops.local(node);
    if (isAbsorbing(value)) {
      return { value, hitCycle: false };
    }

    if (followRef && typeof node.$ref === "string") {
      const resolved = safeResolveSchema(resolve, node, currentFrom);
      if (resolved) {
        let refValue: T | undefined;
        let hasRefValue = false;
        if (resolved.node !== undefined) {
          const targetRes = visit(resolved.node, resolved.location?.source?.absoluteRef, nextSeen);
          if (targetRes.hitCycle) {
            hitCycle = true;
          }
          refValue = targetRes.value;
          hasRefValue = true;
        }
        for (const hop of getRefIntermediateHops(node, resolved)) {
          if (nextSeen.has(hop.node)) {
            hitCycle = true;
            continue;
          }
          const hopSeen = new Set(nextSeen);
          hopSeen.add(hop.node);
          const hopBody = visitBody(hop.node, hop.location?.source?.absoluteRef, hopSeen, false);
          if (hopBody.hitCycle) {
            hitCycle = true;
          }
          let combinedHop = hasRefValue
            ? ops.combineAllOf(refValue as T, hopBody.value)
            : hopBody.value;
          if (ops.finalize) {
            combinedHop = ops.finalize(hop.node, combinedHop);
          }
          refValue = combinedHop;
          hasRefValue = true;
        }
        if (hasRefValue) {
          value = ops.combineAllOf(value, refValue as T);
        }
      }
    }

    if (!isAbsorbing(value) && Array.isArray(node.allOf)) {
      for (const branch of node.allOf) {
        const branchRes = visit(branch, currentFrom, nextSeen);
        if (branchRes.hitCycle) {
          hitCycle = true;
        }
        value = ops.combineAllOf(value, branchRes.value);
        if (isAbsorbing(value)) {
          break;
        }
      }
    }

    if (!isAbsorbing(value)) {
      for (const unionKey of ["oneOf", "anyOf"] as const) {
        const branches = node[unionKey];
        if (!Array.isArray(branches) || branches.length === 0) {
          continue;
        }
        const branchValues: T[] = [];
        for (const branch of branches) {
          const branchRes = visit(branch, currentFrom, nextSeen);
          if (branchRes.hitCycle) {
            hitCycle = true;
          }
          branchValues.push(branchRes.value);
        }
        value = ops.combineAllOf(value, ops.combineUnion(branchValues, unionKey));
        if (isAbsorbing(value)) {
          break;
        }
      }
    }

    return { value, hitCycle };
  };

  const visit = (
    node: unknown,
    currentFrom: string | undefined,
    seen: ReadonlySet<unknown>,
  ): { value: T; hitCycle: boolean } => {
    if (node === false) {
      return { value: ops.falseValue, hitCycle: false };
    }
    if (node === true || !isRecord(node)) {
      return { value: ops.unknownValue, hitCycle: false };
    }
    if (seen.has(node)) {
      return { value: ops.unknownValue, hitCycle: true };
    }

    const cacheKey = currentFrom ?? "";
    const cached = memo.get(node)?.get(cacheKey);
    if (cached) {
      return cached;
    }

    const nextSeen = new Set(seen);
    nextSeen.add(node);

    const bodyRes = visitBody(node, currentFrom, nextSeen, true);
    const value = ops.finalize ? ops.finalize(node, bodyRes.value) : bodyRes.value;
    const result = { value, hitCycle: bodyRes.hitCycle };
    if (!result.hitCycle) {
      setNodeCacheEntry(memo, node, cacheKey, result);
    }
    return result;
  };

  return visit(schema, from, new Set()).value;
}

export type MinLengthConstraint =
  | { readonly kind: "false" }
  | { readonly kind: "value"; readonly minLength: number | null };

const FALSE_MIN_LENGTH: MinLengthConstraint = { kind: "false" };
const UNCONSTRAINED_MIN_LENGTH: MinLengthConstraint = { kind: "value", minLength: null };

function combineMinLengthAllOf(
  a: MinLengthConstraint,
  b: MinLengthConstraint,
): MinLengthConstraint {
  if (a.kind === "false" || b.kind === "false") {
    return FALSE_MIN_LENGTH;
  }
  if (a.minLength === null) {
    return b;
  }
  if (b.minLength === null) {
    return a;
  }
  return { kind: "value", minLength: Math.max(a.minLength, b.minLength) };
}

function combineMinLengthUnion(values: readonly MinLengthConstraint[]): MinLengthConstraint {
  if (values.length === 0) {
    return UNCONSTRAINED_MIN_LENGTH;
  }
  const active = values.filter(
    (item): item is Extract<MinLengthConstraint, { kind: "value" }> => item.kind === "value",
  );
  if (active.length === 0) {
    return FALSE_MIN_LENGTH;
  }
  let lowest: number | null = null;
  for (const item of active) {
    if (item.minLength === null) {
      return UNCONSTRAINED_MIN_LENGTH;
    }
    if (lowest === null || item.minLength < lowest) {
      lowest = item.minLength;
    }
  }
  return { kind: "value", minLength: lowest };
}

export function computeMinLength(
  schema: unknown,
  resolve: ResolverFn,
  from?: string,
): MinLengthConstraint {
  return walkSchemaLattice<MinLengthConstraint>(schema, resolve, from, {
    falseValue: FALSE_MIN_LENGTH,
    unknownValue: UNCONSTRAINED_MIN_LENGTH,
    isAbsorbing: (value) => value.kind === "false",
    local: (node) => {
      if (!localTypeConstraint(node).allowed.has("string")) {
        return FALSE_MIN_LENGTH;
      }
      return typeof node.minLength === "number" && Number.isFinite(node.minLength)
        ? { kind: "value", minLength: node.minLength }
        : UNCONSTRAINED_MIN_LENGTH;
    },
    combineAllOf: combineMinLengthAllOf,
    combineUnion: combineMinLengthUnion,
  });
}

export function computeFragmentsMinLength(
  fragments: readonly SchemaFragment[],
  resolve: ResolverFn,
): MinLengthConstraint {
  return foldSchemaFragments(
    fragments,
    UNCONSTRAINED_MIN_LENGTH,
    combineMinLengthAllOf,
    (frag) => computeMinLength(frag.node, resolve, frag.from),
    (acc) => acc.kind === "false",
  );
}

export type NumericBoundsConstraint =
  | { readonly kind: "false" }
  | {
      readonly kind: "bounds";
      readonly minimum: number | null;
      readonly maximum: number | null;
    };

const FALSE_NUMERIC_BOUNDS: NumericBoundsConstraint = { kind: "false" };
const UNCONSTRAINED_NUMERIC_BOUNDS: NumericBoundsConstraint = {
  kind: "bounds",
  minimum: null,
  maximum: null,
};

function tightenBound(
  a: number | null,
  b: number | null,
  pick: (x: number, y: number) => number,
): number | null {
  if (a === null) {
    return b;
  }
  if (b === null) {
    return a;
  }
  return pick(a, b);
}

function localIntegerBounds(node: UnknownRecord): NumericBoundsConstraint {
  const localTypes = localTypeConstraint(node).allowed;
  if (!localTypes.has("integer") && !localTypes.has("number")) {
    return FALSE_NUMERIC_BOUNDS;
  }

  let minimum: number | null = null;
  let maximum: number | null = null;

  if (typeof node.minimum === "number" && Number.isFinite(node.minimum)) {
    minimum = node.exclusiveMinimum === true ? Math.floor(node.minimum) + 1 : node.minimum;
  }
  if (typeof node.exclusiveMinimum === "number" && Number.isFinite(node.exclusiveMinimum)) {
    minimum = tightenBound(minimum, Math.floor(node.exclusiveMinimum) + 1, Math.max);
  }
  if (typeof node.maximum === "number" && Number.isFinite(node.maximum)) {
    maximum = node.exclusiveMaximum === true ? Math.ceil(node.maximum) - 1 : node.maximum;
  }
  if (typeof node.exclusiveMaximum === "number" && Number.isFinite(node.exclusiveMaximum)) {
    maximum = tightenBound(maximum, Math.ceil(node.exclusiveMaximum) - 1, Math.min);
  }

  return { kind: "bounds", minimum, maximum };
}

function combineIntegerBoundsAllOf(
  a: NumericBoundsConstraint,
  b: NumericBoundsConstraint,
): NumericBoundsConstraint {
  if (a.kind === "false" || b.kind === "false") {
    return FALSE_NUMERIC_BOUNDS;
  }
  return {
    kind: "bounds",
    minimum: tightenBound(a.minimum, b.minimum, Math.max),
    maximum: tightenBound(a.maximum, b.maximum, Math.min),
  };
}

export function isEmptyIntegerRange(minimum: number | null, maximum: number | null): boolean {
  return (
    minimum !== null &&
    maximum !== null &&
    (maximum < minimum || Math.ceil(minimum) > Math.floor(maximum))
  );
}

function combineIntegerBoundsUnion(
  values: readonly NumericBoundsConstraint[],
): NumericBoundsConstraint {
  if (values.length === 0) {
    return UNCONSTRAINED_NUMERIC_BOUNDS;
  }
  let hasSatisfiable = false;
  let minimum: number | null = null;
  let maximum: number | null = null;
  let unboundedMin = false;
  let unboundedMax = false;

  for (const item of values) {
    if (item.kind === "false" || isEmptyIntegerRange(item.minimum, item.maximum)) {
      continue;
    }
    hasSatisfiable = true;
    if (item.minimum === null) {
      unboundedMin = true;
    } else if (minimum === null || item.minimum < minimum) {
      minimum = item.minimum;
    }
    if (item.maximum === null) {
      unboundedMax = true;
    } else if (maximum === null || item.maximum > maximum) {
      maximum = item.maximum;
    }
  }

  if (!hasSatisfiable) {
    return FALSE_NUMERIC_BOUNDS;
  }
  return {
    kind: "bounds",
    minimum: unboundedMin ? null : minimum,
    maximum: unboundedMax ? null : maximum,
  };
}

export function computeIntegerBounds(
  schema: unknown,
  resolve: ResolverFn,
  from?: string,
): NumericBoundsConstraint {
  return walkSchemaLattice<NumericBoundsConstraint>(schema, resolve, from, {
    falseValue: FALSE_NUMERIC_BOUNDS,
    unknownValue: UNCONSTRAINED_NUMERIC_BOUNDS,
    isAbsorbing: (value) => value.kind === "false",
    local: localIntegerBounds,
    combineAllOf: combineIntegerBoundsAllOf,
    combineUnion: combineIntegerBoundsUnion,
  });
}

function hasBooleanSchemaAnnotation(
  schema: unknown,
  resolve: ResolverFn,
  from: string | undefined,
  key: "deprecated" | "readOnly" | "writeOnly",
): boolean {
  const seen = new Set<unknown>();
  const memo = new Map<object, Map<string, boolean>>();

  type AnnotResult = { readonly value: boolean; readonly hitCycle: boolean };

  const hasInCombinators = (node: UnknownRecord, currentFrom: string | undefined): AnnotResult => {
    let hitCycle = false;
    if (Array.isArray(node.allOf)) {
      for (const branch of node.allOf) {
        const res = visit(branch, currentFrom);
        if (res.value) {
          return { value: true, hitCycle: false };
        }
        if (res.hitCycle) {
          hitCycle = true;
        }
      }
    }
    for (const unionKey of ["anyOf", "oneOf"] as const) {
      const branches = node[unionKey];
      if (!Array.isArray(branches) || branches.length === 0) {
        continue;
      }
      let allTrue = true;
      for (const branch of branches) {
        const res = visit(branch, currentFrom);
        if (res.hitCycle) {
          hitCycle = true;
        }
        if (!res.value) {
          allTrue = false;
          break;
        }
      }
      if (allTrue) {
        return { value: true, hitCycle: false };
      }
    }
    return { value: false, hitCycle };
  };

  const visit = (node: unknown, currentFrom: string | undefined): AnnotResult => {
    if (!isRecord(node)) {
      return { value: false, hitCycle: false };
    }
    if (seen.has(node)) {
      return { value: false, hitCycle: true };
    }
    const cacheKey = currentFrom ?? "";
    const cached = memo.get(node)?.get(cacheKey);
    if (cached !== undefined) {
      return { value: cached, hitCycle: false };
    }

    seen.add(node);
    let result: AnnotResult = { value: false, hitCycle: false };
    try {
      const direct = node[key];
      if (typeof direct === "boolean") {
        result = { value: direct, hitCycle: false };
        return result;
      }

      let hitCycle = false;
      if (typeof node.$ref === "string") {
        const resolved = safeResolveSchema(resolve, node, currentFrom);
        if (resolved) {
          let refDecided = false;
          for (const hop of getRefIntermediateHops(node, resolved, { reverse: false })) {
            const hopValue = hop.node[key];
            if (typeof hopValue === "boolean") {
              if (hopValue) {
                result = { value: true, hitCycle: false };
                return result;
              }
              refDecided = true;
              break;
            }
            const hopComb = hasInCombinators(hop.node, hop.location?.source?.absoluteRef);
            if (hopComb.value) {
              result = { value: true, hitCycle: false };
              return result;
            }
            if (hopComb.hitCycle) {
              hitCycle = true;
            }
          }
          if (!refDecided) {
            const targetRes = visit(resolved.node, resolved.location?.source?.absoluteRef);
            if (targetRes.value) {
              result = { value: true, hitCycle: false };
              return result;
            }
            if (targetRes.hitCycle) {
              hitCycle = true;
            }
          }
        }
      }

      const combRes = hasInCombinators(node, currentFrom);
      result = combRes.value
        ? { value: true, hitCycle: false }
        : { value: false, hitCycle: hitCycle || combRes.hitCycle };
      return result;
    } finally {
      seen.delete(node);
      if (result.value || !result.hitCycle) {
        setNodeCacheEntry(memo, node, cacheKey, result.value);
      }
    }
  };

  return visit(schema, from).value;
}

export function isSchemaDeprecated(schema: unknown, resolve: ResolverFn, from?: string): boolean {
  return hasBooleanSchemaAnnotation(schema, resolve, from, "deprecated");
}

export function isSchemaReadOnly(schema: unknown, resolve: ResolverFn, from?: string): boolean {
  return hasBooleanSchemaAnnotation(schema, resolve, from, "readOnly");
}

export function isTrackedPropertyDeprecated(prop: TrackedProperty, resolve: ResolverFn): boolean {
  return prop.fragments.some((frag) => isSchemaDeprecated(frag.node, resolve, frag.from));
}

export function isTrackedPropertyReadOnly(prop: TrackedProperty, resolve: ResolverFn): boolean {
  return prop.fragments.some((frag) => isSchemaReadOnly(frag.node, resolve, frag.from));
}
