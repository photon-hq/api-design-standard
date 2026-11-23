import type { RedoclyLocation, RedoclyResolveResult, RedoclyUserContext } from "./types.js";

export type UnknownRecord = Record<string, unknown>;
export type ResolverFn = RedoclyUserContext["resolve"];

export function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function locationKey(location: RedoclyLocation): string {
  return location.absolutePointer ?? `${location.source?.absoluteRef ?? ""}#${location.pointer}`;
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
        const chain = resolved.chain ?? [];
        for (let index = chain.length - 1; index >= 0; index -= 1) {
          const hop = chain[index];
          if (!hop || !isRecord(hop.node) || hop.node === node || hop.node === resolved.node) {
            continue;
          }
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
      let nodeCache = memo.get(node);
      if (!nodeCache) {
        nodeCache = new Map();
        memo.set(node, nodeCache);
      }
      nodeCache.set(cacheKey, result);
    }
    return result;
  };

  return visit(schema, from, new Set()).value;
}
