import {
  ALL_JSON_TYPE_SET,
  combineTypeConstraintAllOf,
  extractComponentSchemaName,
  extractLocalProperties,
  extractLocalRequired,
  finalizeTypeConstraint,
  formatAllowedTypes,
  getRefIntermediateHops,
  isNonNullObjectConstraint,
  isRecord,
  localTypeConstraint,
  locationKey,
  MAX_OBJECT_VARIANTS,
  mergeTrackedPropertyMaps,
  propertyTypeConstraint,
  type ResolverFn,
  type SchemaFragment,
  safeResolveSchema,
  setNodeCacheEntry,
  type TrackedProperty,
  type TypeConstraint,
  UNCONSTRAINED_TYPE_CONSTRAINT,
  type UnknownRecord,
} from "./schema-utils.js";
import type { RedoclyLocation } from "./types.js";

export interface SchemaVariantWalkResult<T> {
  readonly variants: readonly T[];
  readonly hitCycle: boolean;
  readonly truncated: boolean;
}

export interface SchemaVariantCombineResult<T> {
  readonly variants: T[];
  readonly truncated?: boolean;
}

export interface SchemaVariantCombineContext {
  readonly node: UnknownRecord;
  readonly location: RedoclyLocation | undefined;
  readonly isUnion: boolean;
}

export interface SchemaVariantWalkOps<T> {
  readonly emptyVariant: T;
  readonly onCycle?: "empty" | "empty-seed";
  readonly reverseRefChain?: boolean;
  skipNode?(node: UnknownRecord): boolean;
  initNode?(node: UnknownRecord, location: RedoclyLocation | undefined, followRef: boolean): T;
  extractLocal(
    node: UnknownRecord,
    location: RedoclyLocation | undefined,
    from: string | undefined,
    followRef: boolean,
  ): readonly T[];
  combine(
    current: readonly T[],
    incoming: readonly T[],
    context: SchemaVariantCombineContext,
  ): SchemaVariantCombineResult<T>;
  dedupeUnion?(variants: readonly T[]): readonly T[];
  tagUnionBranch?(
    unionKey: "oneOf" | "anyOf",
    unionLocation: RedoclyLocation | undefined,
    branchIndex: number,
    branchVariants: readonly T[],
    nextAnonymousId: () => string,
  ): readonly T[];
  finalizeNode?(node: UnknownRecord, variants: readonly T[]): readonly T[];
}

export function walkSchemaVariants<T>(
  schema: unknown,
  resolve: ResolverFn,
  baseLocation: RedoclyLocation | undefined,
  ops: SchemaVariantWalkOps<T>,
  fromOverride?: string,
): SchemaVariantWalkResult<T> {
  const memo = new Map<object, Map<string, SchemaVariantWalkResult<T>>>();
  const onCycle = ops.onCycle ?? "empty";
  const reverseRefChain = ops.reverseRefChain ?? true;
  let anonymousUnionCounter = 0;
  const nextAnonymousId = (): string => `union#${++anonymousUnionCounter}`;

  const visit = (
    node: unknown,
    location: RedoclyLocation | undefined,
    currentFrom: string | undefined,
    seen: ReadonlySet<unknown>,
    followRef: boolean,
  ): SchemaVariantWalkResult<T> => {
    if (node === true) {
      return { variants: [ops.emptyVariant], hitCycle: false, truncated: false };
    }
    if (node === false || !isRecord(node) || ops.skipNode?.(node)) {
      return { variants: [], hitCycle: false, truncated: false };
    }
    if (seen.has(node)) {
      return {
        variants: onCycle === "empty-seed" ? [ops.emptyVariant] : [],
        hitCycle: true,
        truncated: false,
      };
    }

    const locId = location ? locationKey(location) : (currentFrom ?? "");
    const cacheKey = `${followRef ? "1" : "0"}:${locId}`;
    const cached = memo.get(node)?.get(cacheKey);
    if (cached) {
      return cached;
    }

    const nextSeen = new Set(seen);
    nextSeen.add(node);

    let hitCycle = false;
    let truncated = false;
    let variants: readonly T[] = [
      ops.initNode ? ops.initNode(node, location, followRef) : ops.emptyVariant,
    ];

    const combineContext: SchemaVariantCombineContext = { node, location, isUnion: false };
    const applyConjunctive = (res: SchemaVariantWalkResult<T>): void => {
      if (res.hitCycle) {
        hitCycle = true;
      }
      if (res.truncated) {
        truncated = true;
      }
      if (res.variants.length === 0) {
        if (!res.hitCycle) {
          variants = [];
        }
        return;
      }
      const merged = ops.combine(variants, res.variants, combineContext);
      variants = merged.variants;
      if (merged.truncated) {
        truncated = true;
      }
    };

    if (followRef && typeof node.$ref === "string") {
      const resolved = safeResolveSchema(resolve, node, currentFrom);
      if (resolved) {
        if (resolved.node !== undefined) {
          applyConjunctive(
            visit(
              resolved.node,
              resolved.location,
              resolved.location?.source?.absoluteRef,
              nextSeen,
              true,
            ),
          );
        }
        for (const hop of getRefIntermediateHops(node, resolved, { reverse: reverseRefChain })) {
          if (variants.length === 0) {
            break;
          }
          if (nextSeen.has(hop.node)) {
            hitCycle = true;
            continue;
          }
          applyConjunctive(
            visit(hop.node, hop.location, hop.location?.source?.absoluteRef, nextSeen, false),
          );
        }
      }
    }

    if (variants.length > 0 && Array.isArray(node.allOf)) {
      for (const [index, branch] of node.allOf.entries()) {
        applyConjunctive(
          visit(branch, location?.child(["allOf", index]), currentFrom, nextSeen, true),
        );
        if (variants.length === 0) {
          break;
        }
      }
    }

    if (variants.length > 0) {
      const localVariants = ops.extractLocal(node, location, currentFrom, followRef);
      if (localVariants.length > 0) {
        const mergedLocal = ops.combine(variants, localVariants, combineContext);
        variants = mergedLocal.variants;
        if (mergedLocal.truncated) {
          truncated = true;
        }
      }
    }

    if (variants.length > 0) {
      for (const unionKey of ["oneOf", "anyOf"] as const) {
        const branches = node[unionKey];
        if (!Array.isArray(branches) || branches.length === 0) {
          continue;
        }
        const unionLocation = location?.child([unionKey]);
        const unionVariants: T[] = [];
        let branchHitCycle = false;
        for (const [index, branch] of branches.entries()) {
          const branchRes = visit(
            branch,
            location?.child([unionKey, index]),
            currentFrom,
            nextSeen,
            true,
          );
          if (branchRes.hitCycle) {
            hitCycle = true;
            branchHitCycle = true;
          }
          if (branchRes.truncated) {
            truncated = true;
          }
          const tagged = ops.tagUnionBranch
            ? ops.tagUnionBranch(
                unionKey,
                unionLocation,
                index,
                branchRes.variants,
                nextAnonymousId,
              )
            : branchRes.variants;
          unionVariants.push(...tagged);
        }

        if (unionVariants.length === 0) {
          if (!branchHitCycle) {
            variants = [];
            break;
          }
          continue;
        }

        const preparedUnion = ops.dedupeUnion ? ops.dedupeUnion(unionVariants) : unionVariants;
        const mergedUnion = ops.combine(variants, preparedUnion, {
          node,
          location,
          isUnion: true,
        });
        variants = mergedUnion.variants;
        if (mergedUnion.truncated) {
          truncated = true;
        }
        if (variants.length === 0) {
          break;
        }
      }
    }

    if (variants.length > 0 && ops.finalizeNode) {
      variants = ops.finalizeNode(node, variants);
    }

    const result: SchemaVariantWalkResult<T> = { variants, hitCycle, truncated };
    if (!hitCycle) {
      setNodeCacheEntry(memo, node, cacheKey, result);
    }
    return result;
  };

  return visit(
    schema,
    baseLocation,
    fromOverride ?? baseLocation?.source?.absoluteRef,
    new Set(),
    true,
  );
}

export interface FlattenedObjectVariant {
  readonly typeConstraint: TypeConstraint;
  readonly isObjectLike: boolean;
  readonly openAdditionalProperties: boolean;
  readonly hasSchemaAdditionalProperties: boolean;
  readonly properties: ReadonlyMap<string, TrackedProperty>;
  readonly required: ReadonlySet<string>;
  readonly schemaNames: ReadonlySet<string>;
  readonly oneOfBranches: ReadonlyMap<string, ReadonlySet<number>>;
}

export const EMPTY_SEED_VARIANT: FlattenedObjectVariant = {
  typeConstraint: UNCONSTRAINED_TYPE_CONSTRAINT,
  isObjectLike: false,
  openAdditionalProperties: false,
  hasSchemaAdditionalProperties: false,
  properties: new Map(),
  required: new Set(),
  schemaNames: new Set(),
  oneOfBranches: new Map(),
};

export function mergeOneOfBranchMaps(
  left: ReadonlyMap<string, ReadonlySet<number>>,
  right: ReadonlyMap<string, ReadonlySet<number>>,
): Map<string, Set<number>> {
  const merged = new Map<string, Set<number>>();
  for (const [id, branches] of left.entries()) {
    merged.set(id, new Set(branches));
  }
  for (const [id, branches] of right.entries()) {
    const existing = merged.get(id);
    if (existing) {
      for (const index of branches) {
        existing.add(index);
      }
    } else {
      merged.set(id, new Set(branches));
    }
  }
  return merged;
}

const schemaObjectIds = new WeakMap<object, number>();
let nextSchemaObjectId = 1;

export function schemaNodeIdentity(node: unknown): string {
  if (typeof node === "object" && node !== null) {
    let id = schemaObjectIds.get(node);
    if (id === undefined) {
      id = nextSchemaObjectId;
      nextSchemaObjectId += 1;
      schemaObjectIds.set(node, id);
    }
    return `obj#${id}`;
  }
  return `${typeof node}:${String(node)}`;
}

export function defaultFlattenedVariantSignature(
  variant: FlattenedObjectVariant,
  resolve: ResolverFn,
): string {
  const types = formatAllowedTypes(variant.typeConstraint.allowed, ",");
  const propKeys = [...variant.properties.keys()]
    .sort()
    .map((key) => {
      const prop = variant.properties.get(key);
      const tc = prop ? propertyTypeConstraint(prop, resolve) : UNCONSTRAINED_TYPE_CONSTRAINT;
      const pTypes = formatAllowedTypes(tc.allowed, ",");
      if (prop && tc.allowed.has("array")) {
        const fragIds = prop.fragments
          .map((frag) =>
            frag.location ? locationKey(frag.location) : schemaNodeIdentity(frag.node),
          )
          .sort()
          .join("+");
        return `${key}:${pTypes}[${fragIds}]`;
      }
      return `${key}:${pTypes}`;
    })
    .join("|");
  const reqKeys = [...variant.required].sort().join(",");
  return `${types};${variant.isObjectLike ? 1 : 0};${variant.hasSchemaAdditionalProperties ? 1 : 0};${propKeys};${reqKeys}`;
}

export interface FlattenedVariantOptions {
  readonly variantSignature?: (variant: FlattenedObjectVariant, resolve: ResolverFn) => string;
  readonly isMergeSatisfiable?: (
    base: FlattenedObjectVariant,
    addition: FlattenedObjectVariant,
    merged: FlattenedObjectVariant,
    resolve: ResolverFn,
  ) => boolean;
  readonly trackOneOfBranches?: boolean;
  readonly onTruncatedVariant?: (variant: FlattenedObjectVariant, resolve: ResolverFn) => void;
}

export function mergeFlattenedVariants(
  base: FlattenedObjectVariant,
  addition: FlattenedObjectVariant,
  resolve: ResolverFn,
  options?: FlattenedVariantOptions,
): FlattenedObjectVariant | null {
  const typeConstraint = combineTypeConstraintAllOf(base.typeConstraint, addition.typeConstraint);
  if (typeConstraint.allowed.size === 0) {
    return null;
  }
  const properties = mergeTrackedPropertyMaps(base.properties, addition.properties);
  const required = new Set<string>(base.required);
  for (const name of addition.required) {
    required.add(name);
  }
  const schemaNames = new Set<string>(base.schemaNames);
  for (const name of addition.schemaNames) {
    schemaNames.add(name);
  }
  const isObjectLike =
    typeConstraint.allowed.has("object") &&
    (base.isObjectLike || addition.isObjectLike || isNonNullObjectConstraint(typeConstraint));
  const merged: FlattenedObjectVariant = {
    typeConstraint,
    isObjectLike,
    openAdditionalProperties: base.openAdditionalProperties || addition.openAdditionalProperties,
    hasSchemaAdditionalProperties:
      base.hasSchemaAdditionalProperties || addition.hasSchemaAdditionalProperties,
    properties,
    required,
    schemaNames,
    oneOfBranches:
      base.oneOfBranches.size > 0 || addition.oneOfBranches.size > 0
        ? mergeOneOfBranchMaps(base.oneOfBranches, addition.oneOfBranches)
        : new Map(),
  };

  if (options?.isMergeSatisfiable && !options.isMergeSatisfiable(base, addition, merged, resolve)) {
    return null;
  }

  return merged;
}

export function combineFlattenedVariantSets(
  left: readonly FlattenedObjectVariant[],
  right: readonly FlattenedObjectVariant[],
  resolve: ResolverFn,
  options?: FlattenedVariantOptions,
): { readonly variants: FlattenedObjectVariant[]; readonly truncated: boolean } {
  if (left.length === 0 || right.length === 0) {
    return { variants: [], truncated: false };
  }
  const getSignature = options?.variantSignature ?? defaultFlattenedVariantSignature;
  const indexBySig = new Map<string, number>();
  const out: FlattenedObjectVariant[] = [];
  let truncated = false;

  for (const a of left) {
    for (const b of right) {
      const merged = mergeFlattenedVariants(a, b, resolve, options);
      if (!merged) {
        continue;
      }
      const sig = getSignature(merged, resolve);
      const existingIndex = indexBySig.get(sig);
      if (existingIndex !== undefined) {
        const existing = out[existingIndex];
        if (existing && merged.oneOfBranches.size > 0) {
          out[existingIndex] = {
            ...existing,
            oneOfBranches: mergeOneOfBranchMaps(existing.oneOfBranches, merged.oneOfBranches),
          };
        }
        continue;
      }
      if (out.length >= MAX_OBJECT_VARIANTS) {
        truncated = true;
        options?.onTruncatedVariant?.(merged, resolve);
        continue;
      }
      indexBySig.set(sig, out.length);
      out.push(merged);
    }
  }

  return { variants: out, truncated };
}

export function dedupeFlattenedVariants(
  list: readonly FlattenedObjectVariant[],
  resolve: ResolverFn,
  options?: FlattenedVariantOptions,
): FlattenedObjectVariant[] {
  const getSignature = options?.variantSignature ?? defaultFlattenedVariantSignature;
  const seen = new Map<string, FlattenedObjectVariant>();
  for (const variant of list) {
    const sig = getSignature(variant, resolve);
    if (!seen.has(sig)) {
      seen.set(sig, variant);
    }
  }
  return [...seen.values()];
}

function extractLocalFlattenedVariant(
  node: UnknownRecord,
  location: RedoclyLocation | undefined,
  from: string | undefined,
  followRef: boolean,
): FlattenedObjectVariant {
  const typeConstraint = localTypeConstraint(node);
  const properties = extractLocalProperties(node, location, from);
  const required = extractLocalRequired(node);

  const schemaNames = new Set<string>();
  const pointerName = extractComponentSchemaName(location?.pointer);
  if (pointerName) {
    schemaNames.add(pointerName);
  }
  if (followRef && typeof node.$ref === "string") {
    const refName = extractComponentSchemaName(node.$ref);
    if (refName) {
      schemaNames.add(refName);
    }
  }

  const hasSchemaAdditionalProperties = isRecord(node.additionalProperties);
  const openAdditionalProperties =
    node.additionalProperties === true || hasSchemaAdditionalProperties;
  const hasObjectShape =
    properties.size > 0 ||
    node.additionalProperties !== undefined ||
    required.size > 0 ||
    isNonNullObjectConstraint(typeConstraint) ||
    (typeConstraint.allowed.has("object") &&
      typeConstraint.allowed.size < ALL_JSON_TYPE_SET.size &&
      (node.type === "object" || (Array.isArray(node.type) && node.type.includes("object"))));

  return {
    typeConstraint,
    isObjectLike: hasObjectShape,
    openAdditionalProperties,
    hasSchemaAdditionalProperties,
    properties,
    required,
    schemaNames,
    oneOfBranches: new Map(),
  };
}

export function collectFlattenedObjectVariants(
  schema: unknown,
  resolve: ResolverFn,
  baseLocation?: RedoclyLocation,
  options?: FlattenedVariantOptions,
  fromOverride?: string,
): { readonly variants: readonly FlattenedObjectVariant[]; readonly truncated: boolean } {
  const result = walkSchemaVariants<FlattenedObjectVariant>(
    schema,
    resolve,
    baseLocation,
    {
      emptyVariant: EMPTY_SEED_VARIANT,
      onCycle: "empty-seed",
      reverseRefChain: true,
      extractLocal: (node, location, from, followRef) => [
        extractLocalFlattenedVariant(node, location, from, followRef),
      ],
      combine: (current, incoming) =>
        combineFlattenedVariantSets(current, incoming, resolve, options),
      ...(options?.trackOneOfBranches
        ? {
            tagUnionBranch: (
              unionKey,
              unionLocation,
              branchIndex,
              branchVariants,
              nextAnonymousId,
            ) => {
              if (unionKey !== "oneOf") {
                return branchVariants;
              }
              const oneOfId = unionLocation ? locationKey(unionLocation) : nextAnonymousId();
              const branchTag = new Map<string, ReadonlySet<number>>([
                [oneOfId, new Set([branchIndex])],
              ]);
              return branchVariants.map((variant) => ({
                ...variant,
                oneOfBranches: mergeOneOfBranchMaps(variant.oneOfBranches, branchTag),
              }));
            },
          }
        : {}),
      finalizeNode: (node, currentVariants) =>
        node.nullable === true
          ? currentVariants.map((variant) => ({
              ...variant,
              typeConstraint: finalizeTypeConstraint(node, variant.typeConstraint),
            }))
          : currentVariants,
    },
    fromOverride,
  );

  return {
    variants: result.variants,
    truncated: result.truncated,
  };
}

export function collectFragmentsObjectVariants(
  fragments: readonly SchemaFragment[],
  resolve: ResolverFn,
  options?: FlattenedVariantOptions,
): { readonly variants: FlattenedObjectVariant[]; readonly truncated: boolean } {
  let variants: FlattenedObjectVariant[] = [EMPTY_SEED_VARIANT];
  let truncated = false;
  for (const frag of fragments) {
    const fragResult = collectFlattenedObjectVariants(
      frag.node,
      resolve,
      frag.location,
      options,
      frag.from,
    );
    if (fragResult.truncated) {
      truncated = true;
    }
    const merged = combineFlattenedVariantSets(variants, fragResult.variants, resolve, options);
    variants = merged.variants;
    if (merged.truncated) {
      truncated = true;
    }
    if (variants.length === 0) {
      break;
    }
  }
  return { variants, truncated };
}
