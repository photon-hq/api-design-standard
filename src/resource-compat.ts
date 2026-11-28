import { HTTP_METHODS, type RuleIgnoreMatcher } from "./ignore.js";
import {
  EXACT_2XX_STATUS_RE,
  extractOperationJsonResponseSchemas,
  hasHeaderCaseInsensitive,
  inspectResponseContent,
  iterateRootPathItems,
  type ResolvedPathItem,
} from "./openapi-utils.js";
import {
  computeFragmentsTypeConstraint,
  computeTypeConstraint,
  extractComponentSchemaName,
  formatTypeSummary,
  getRefIntermediateHops,
  intersectTypeSets,
  isRecord,
  isStrictlyNullConstraint,
  isTrackedPropertyReadOnly,
  type JsonSchemaType,
  localTypeConstraint,
  locationKey,
  MAX_OBJECT_VARIANTS,
  propertyTypeConstraint,
  type ResolverFn,
  type SchemaFragment,
  safeResolveSchema,
  type TypeConstraint,
  type UnknownRecord,
} from "./schema-utils.js";
import {
  buildFlattenedVariantSignature,
  collectFlattenedObjectVariants,
  collectFragmentsObjectVariants,
  dedupeFlattenedVariants,
  type FlattenedObjectVariant,
  type FlattenedVariantOptions,
  schemaNodeIdentity,
} from "./schema-variants.js";
import type { RedoclyLocation, RedoclyUserContext } from "./types.js";

const FULL_PARAM_SEGMENT_RE = /^\{([^}]+)\}$/;
const LEADING_VERSION_SEGMENT_RE = /^v[0-9]+$/;

export const MAX_COMPAT_DEPTH = 6;

export const COMPAT_VARIANT_OPTIONS: FlattenedVariantOptions = {
  variantSignature: (variant, resolve) =>
    buildFlattenedVariantSignature(variant, resolve, { preserveNestedObjects: true }),
};

export const SECRET_OR_TOKEN_PROP_RE = /^(?:secret|token|[a-z][a-zA-Z0-9]*(?:Secret|Token))$/;

export function wordSet(words: string): ReadonlySet<string> {
  return new Set(words.trim().split(/\s+/));
}

export const COLLECTION_METADATA_KEYS = wordSet(`
  nextPageToken prevPageToken previousPageToken pageToken cursor nextCursor prevCursor
  previousCursor hasMore hasNextPage hasPreviousPage totalCount total totalItems totalPages
  count limit offset pageSize perPage page pageInfo pagination meta
`);

export const NON_PLURAL_S_WORDS = wordSet(`
  as alias bias bus canvas cors dns gas ios is os plus sms this tls yes
`);

export const ACTION_VERB_PREFIXES = wordSet(`
  abort accept acknowledge activate approve archive assign attach authorize bind
  cancel check claim clear clone close commit complete confirm deactivate
  deauthorize decline deploy detach disable disconnect dismiss duplicate enable
  escalate expire export extend finalize fork import invite leave link lock mark
  merge migrate mute pause pin preview promote publish purge reconnect redeem
  refresh refund reissue reject release renew reopen replay reprocess resend reset
  resolve restart restore resume retry revoke rollback rotate send set share sign
  split start stop submit subscribe suspend sync terminate test transfer trigger
  unarchive unassign unbind undeploy unlink unlock unmute unpin unpublish unshare
  unsubscribe unsuspend validate verify void
`);

export const QUERY_OR_ACTION_POST_SEGMENTS = wordSet(`
  search query preview validate check verify batch export import count stats
  summary health status
`);

export const DELETE_RECEIPT_META_KEYS = wordSet(`
  deleted deletedAt object status message
`);

export const PURE_REF_ANNOTATION_KEYS = wordSet(`
  $ref title description summary default deprecated readOnly writeOnly
  example examples externalDocs $comment
`);

export const SCALAR_ID_TYPES: ReadonlySet<JsonSchemaType> = new Set([
  "string",
  "integer",
  "number",
]);

export const SERVER_MANAGED_MUTATION_KEYS: ReadonlySet<string> = new Set([
  "id",
  "createdAt",
  "updatedAt",
]);

export const SERVER_MANAGED_CREATE_KEYS: ReadonlySet<string> = new Set(["createdAt", "updatedAt"]);

export function normalizePathTemplate(pathTemplate: string): string {
  const trimmed = pathTemplate.trim().replace(/\/+$/, "");
  return trimmed.length === 0 ? "/" : trimmed;
}

export function hasTrailingSlash(pathTemplate: string): boolean {
  const trimmed = pathTemplate.trim();
  return trimmed.length > 1 && trimmed.endsWith("/");
}

export function splitPathSegments(pathTemplate: string): string[] {
  const normalized = normalizePathTemplate(pathTemplate);
  if (normalized === "/") {
    return [];
  }
  return normalized
    .slice(1)
    .split("/")
    .filter((segment) => segment.length > 0);
}

export function isParamSegment(segment: string): boolean {
  return FULL_PARAM_SEGMENT_RE.test(segment);
}

export function endsWithPathParam(pathTemplate: string): boolean {
  const segments = splitPathSegments(pathTemplate);
  const last = segments[segments.length - 1];
  return last !== undefined && isParamSegment(last);
}

export function structuralPathKey(segments: readonly string[], trailingSlash = false): string {
  if (segments.length === 0) {
    return "/";
  }
  const base = `/${segments.map((segment) => (isParamSegment(segment) ? "{}" : segment)).join("/")}`;
  return trailingSlash ? `${base}/` : base;
}

export function formatSegments(segments: readonly string[]): string {
  return segments.length === 0 ? "/" : `/${segments.join("/")}`;
}

export function computeHoistedCollectionCandidates(
  collectionSegments: readonly string[],
): string[][] {
  const hasVersionPrefix =
    collectionSegments.length > 0 && LEADING_VERSION_SEGMENT_RE.test(collectionSegments[0] ?? "");
  const prefix = hasVersionPrefix ? [collectionSegments[0] as string] : [];
  const rest = hasVersionPrefix ? collectionSegments.slice(1) : [...collectionSegments];

  const candidates: string[][] = [];
  let offset = 0;
  while (offset + 2 < rest.length) {
    const scopeSeg = rest[offset];
    const paramSeg = rest[offset + 1];
    if (!scopeSeg || !paramSeg || isParamSegment(scopeSeg) || !isParamSegment(paramSeg)) {
      break;
    }
    offset += 2;
    candidates.push([...prefix, ...rest.slice(offset)]);
  }
  return candidates;
}

export function isActionVerbSegment(segment: string): boolean {
  const lower = segment.toLowerCase();
  if (ACTION_VERB_PREFIXES.has(lower)) {
    return true;
  }
  const first = lower.split("-")[0];
  return first !== undefined && ACTION_VERB_PREFIXES.has(first);
}

export function looksLikePluralSubCollectionSegment(segment: string): boolean {
  const lower = segment.toLowerCase();
  const parts = lower.split("-").filter((part) => part.length > 0);
  if (parts.length === 0) {
    return false;
  }
  const first = parts[0];
  if (parts.length > 1 && first && ACTION_VERB_PREFIXES.has(first)) {
    return false;
  }
  const lastWord = parts[parts.length - 1];
  if (!lastWord || lastWord.length < 3) {
    return false;
  }
  if (
    lastWord.endsWith("ss") ||
    lastWord.endsWith("us") ||
    lastWord.endsWith("is") ||
    NON_PLURAL_S_WORDS.has(lastWord)
  ) {
    return false;
  }
  return lastWord.endsWith("s");
}

function singularizeWord(word: string): string {
  const lower = word.toLowerCase();
  if (lower.length <= 2) {
    return lower;
  }
  if (lower.endsWith("ies") && lower.length > 3) {
    return `${lower.slice(0, -3)}y`;
  }
  if (/(?:ch|sh|x|z|ss)es$/.test(lower) && lower.length > 4) {
    return lower.slice(0, -2);
  }
  if (
    lower.endsWith("s") &&
    !lower.endsWith("ss") &&
    !lower.endsWith("us") &&
    !lower.endsWith("is") &&
    !NON_PLURAL_S_WORDS.has(lower)
  ) {
    return lower.slice(0, -1);
  }
  return lower;
}

export function suggestResourceIdParam(collectionSegment: string): string {
  const parts = collectionSegment
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((part) => part.length > 0);
  if (parts.length === 0) {
    return "resourceId";
  }
  const singularParts = parts.map((part, index) =>
    index === parts.length - 1 ? singularizeWord(part) : part,
  );
  const stem = singularParts
    .map((part, index) => (index === 0 ? part : `${part.charAt(0).toUpperCase()}${part.slice(1)}`))
    .join("");
  if (!/^[a-z][a-zA-Z0-9]*$/.test(stem)) {
    return "resourceId";
  }
  return stem.endsWith("Id") ? stem : `${stem}Id`;
}

export interface IndexedPathEntry extends ResolvedPathItem {
  readonly pathItem: UnknownRecord;
  readonly normalizedPath: string;
  readonly segments: readonly string[];
  readonly structuralKey: string;
}

export function collectIndexedPaths(
  root: UnknownRecord,
  ctx: RedoclyUserContext,
): {
  entries: IndexedPathEntry[];
  byStructuralKey: Map<string, IndexedPathEntry[]>;
} {
  const entries: IndexedPathEntry[] = [];
  const byStructuralKey = new Map<string, IndexedPathEntry[]>();

  for (const resolved of iterateRootPathItems(root, ctx)) {
    if (!resolved.pathItem) {
      continue;
    }
    const normalizedPath = normalizePathTemplate(resolved.pathTemplate);
    const segments = splitPathSegments(resolved.pathTemplate);
    const structuralKey = structuralPathKey(segments, hasTrailingSlash(resolved.pathTemplate));
    const entry: IndexedPathEntry = {
      ...resolved,
      pathItem: resolved.pathItem,
      normalizedPath,
      segments,
      structuralKey,
    };
    entries.push(entry);
    const bucket = byStructuralKey.get(structuralKey);
    if (bucket) {
      bucket.push(entry);
    } else {
      byStructuralKey.set(structuralKey, [entry]);
    }
  }

  return { entries, byStructuralKey };
}

export function hasMatchingEntryOnStructuralKey(
  byStructuralKey: ReadonlyMap<string, readonly IndexedPathEntry[]>,
  key: string,
  predicate: (entry: IndexedPathEntry) => boolean,
): boolean {
  return byStructuralKey.get(key)?.some(predicate) ?? false;
}

export function hasAnyGetOnStructuralKey(
  byStructuralKey: ReadonlyMap<string, readonly IndexedPathEntry[]>,
  key: string,
): boolean {
  return hasMatchingEntryOnStructuralKey(byStructuralKey, key, (entry) =>
    isRecord(entry.pathItem.get),
  );
}

export function hasAnyOperationOnStructuralKey(
  byStructuralKey: ReadonlyMap<string, readonly IndexedPathEntry[]>,
  key: string,
): boolean {
  return hasMatchingEntryOnStructuralKey(byStructuralKey, key, (entry) =>
    HTTP_METHODS.some((method) => isRecord(entry.pathItem[method])),
  );
}

export function hasAnyStrictDescendant(
  entries: readonly IndexedPathEntry[],
  prefixStructuralKey: string,
): boolean {
  const prefix = prefixStructuralKey.endsWith("/")
    ? prefixStructuralKey
    : `${prefixStructuralKey}/`;
  return entries.some(
    (entry) =>
      entry.structuralKey.length > prefix.length &&
      entry.structuralKey.startsWith(prefix) &&
      HTTP_METHODS.some((method) => isRecord(entry.pathItem[method])),
  );
}

export interface HoistedGetCandidate {
  readonly entry: IndexedPathEntry;
  readonly getOp: UnknownRecord;
}

export function findGetsOnStructuralKey(
  byStructuralKey: ReadonlyMap<string, readonly IndexedPathEntry[]>,
  key: string,
): HoistedGetCandidate[] {
  const bucket = byStructuralKey.get(key);
  if (!bucket) {
    return [];
  }
  const matches: HoistedGetCandidate[] = [];
  for (const candidateEntry of bucket) {
    if (isRecord(candidateEntry.pathItem.get)) {
      matches.push({ entry: candidateEntry, getOp: candidateEntry.pathItem.get });
    }
  }
  return matches;
}

export function findDirectChildGets(
  byStructuralKey: ReadonlyMap<string, readonly IndexedPathEntry[]>,
  collectionSegments: readonly string[],
): HoistedGetCandidate[] {
  return findGetsOnStructuralKey(byStructuralKey, structuralPathKey([...collectionSegments, "{}"]));
}

export function findMatchingHoistedGets(
  byStructuralKey: ReadonlyMap<string, readonly IndexedPathEntry[]>,
  collectionSegments: readonly string[],
): HoistedGetCandidate[] {
  const hoistedCollections = computeHoistedCollectionCandidates(collectionSegments);
  const matches: HoistedGetCandidate[] = [];
  for (const candidate of hoistedCollections) {
    matches.push(
      ...findGetsOnStructuralKey(byStructuralKey, structuralPathKey([...candidate, "{}"])),
    );
  }
  return matches;
}

export function isScalarIdTypeConstraint(tc: TypeConstraint): boolean {
  if (tc.allowed.size === 0) {
    return false;
  }
  let hasScalar = false;
  for (const t of tc.allowed) {
    if (t === "null") {
      continue;
    }
    if (!SCALAR_ID_TYPES.has(t)) {
      return false;
    }
    hasScalar = true;
  }
  return hasScalar;
}

export type ArrayItemBranch = readonly SchemaFragment[];

export interface ArrayItemBranchCollection {
  readonly branches: ArrayItemBranch[];
  readonly truncated: boolean;
  readonly hasUnconstrainedBranch: boolean;
}

export function collectArrayItemBranches(
  fragments: readonly SchemaFragment[],
  resolve: ResolverFn,
): ArrayItemBranchCollection {
  let truncated = false;

  const visitNode = (
    node: unknown,
    location: RedoclyLocation | undefined,
    from: string | undefined,
    seen: ReadonlySet<unknown>,
  ): ArrayItemBranch[] => {
    if (node === false) {
      return [];
    }
    if (!isRecord(node) || seen.has(node)) {
      return [[]];
    }
    if (!localTypeConstraint(node).allowed.has("array")) {
      return [];
    }
    const nextSeen = new Set(seen);
    nextSeen.add(node);

    let branches: ArrayItemBranch[] = [[]];

    const intersectWith = (incoming: ArrayItemBranch[]): void => {
      if (incoming.length === 0) {
        branches = [];
        return;
      }
      const next: ArrayItemBranch[] = [];
      for (const a of branches) {
        for (const b of incoming) {
          if (next.length >= MAX_OBJECT_VARIANTS) {
            truncated = true;
            branches = next;
            return;
          }
          next.push([...a, ...b]);
        }
      }
      branches = next;
    };

    const extractLocalArrayItemBranches = (
      targetNode: UnknownRecord,
      targetLocation: RedoclyLocation | undefined,
      targetFrom: string | undefined,
    ): ArrayItemBranch[] | null => {
      const tuplePrefix =
        Array.isArray(targetNode.prefixItems) && targetNode.prefixItems.length > 0
          ? {
              key: "prefixItems" as const,
              items: targetNode.prefixItems,
              rest: targetNode.items,
              restKey: "items" as const,
            }
          : Array.isArray(targetNode.items) && targetNode.items.length > 0
            ? {
                key: "items" as const,
                items: targetNode.items,
                rest: targetNode.additionalItems,
                restKey: "additionalItems" as const,
              }
            : null;

      if (tuplePrefix) {
        const tupleBranches: ArrayItemBranch[] = [];
        for (const [index, elem] of tuplePrefix.items.entries()) {
          if (isRecord(elem) || elem === false) {
            const elemLoc = targetLocation?.child([tuplePrefix.key, index]);
            tupleBranches.push([
              {
                node: elem,
                ...(targetFrom !== undefined ? { from: targetFrom } : {}),
                ...(elemLoc ? { location: elemLoc } : {}),
              },
            ]);
          } else if (elem === true) {
            tupleBranches.push([]);
          }
        }
        if (isRecord(tuplePrefix.rest)) {
          const restLoc = targetLocation?.child([tuplePrefix.restKey]);
          tupleBranches.push([
            {
              node: tuplePrefix.rest,
              ...(targetFrom !== undefined ? { from: targetFrom } : {}),
              ...(restLoc ? { location: restLoc } : {}),
            },
          ]);
        } else if (tuplePrefix.rest !== false) {
          // Tail elements after prefixItems are unconstrained when rest schema is omitted or true.
          tupleBranches.push([]);
        }
        return tupleBranches.length > 0 ? tupleBranches : null;
      }

      if (isRecord(targetNode.items) || targetNode.items === false) {
        const itemLoc = targetLocation?.child(["items"]);
        return [
          [
            {
              node: targetNode.items,
              ...(targetFrom !== undefined ? { from: targetFrom } : {}),
              ...(itemLoc ? { location: itemLoc } : {}),
            },
          ],
        ];
      }
      return null;
    };

    const localBranches = extractLocalArrayItemBranches(node, location, from);
    if (localBranches) {
      intersectWith(localBranches);
    }

    if (branches.length > 0 && typeof node.$ref === "string") {
      const resolved = safeResolveSchema(resolve, node, from);
      if (resolved) {
        if (resolved.node === false) {
          branches = [];
        } else if (isRecord(resolved.node)) {
          intersectWith(
            visitNode(
              resolved.node,
              resolved.location,
              resolved.location?.source?.absoluteRef,
              nextSeen,
            ),
          );
        }
        if (branches.length > 0) {
          for (const hop of getRefIntermediateHops(node, resolved)) {
            const hopBranches = extractLocalArrayItemBranches(
              hop.node,
              hop.location,
              hop.location?.source?.absoluteRef,
            );
            if (hopBranches) {
              intersectWith(hopBranches);
            }
          }
        }
      }
    }

    if (branches.length > 0 && Array.isArray(node.allOf)) {
      for (const [index, branch] of node.allOf.entries()) {
        intersectWith(visitNode(branch, location?.child(["allOf", index]), from, nextSeen));
        if (branches.length === 0) {
          break;
        }
      }
    }

    if (branches.length > 0) {
      for (const unionKey of ["oneOf", "anyOf"] as const) {
        const unionBranches = node[unionKey];
        if (!Array.isArray(unionBranches) || unionBranches.length === 0) {
          continue;
        }
        const collected: ArrayItemBranch[] = [];
        for (const [index, branch] of unionBranches.entries()) {
          if (!computeTypeConstraint(branch, resolve, from).allowed.has("array")) {
            continue;
          }
          const sub = visitNode(branch, location?.child([unionKey, index]), from, nextSeen);
          for (const item of sub) {
            if (collected.length >= MAX_OBJECT_VARIANTS) {
              truncated = true;
              break;
            }
            collected.push(item);
          }
        }
        intersectWith(collected);
        if (branches.length === 0) {
          break;
        }
      }
    }

    return branches;
  };

  let combined: ArrayItemBranch[] = [[]];
  for (const frag of fragments) {
    const sub = visitNode(frag.node, frag.location, frag.from, new Set());
    if (sub.length === 0) {
      return { branches: [], truncated, hasUnconstrainedBranch: false };
    }
    const next: ArrayItemBranch[] = [];
    let outerTruncated = false;
    for (const a of combined) {
      for (const b of sub) {
        if (next.length >= MAX_OBJECT_VARIANTS) {
          truncated = true;
          outerTruncated = true;
          break;
        }
        next.push([...a, ...b]);
      }
      if (outerTruncated) {
        break;
      }
    }
    combined = next;
  }

  return {
    branches: combined.filter((branch) => branch.length > 0),
    truncated,
    hasUnconstrainedBranch: combined.some((branch) => branch.length === 0),
  };
}

export interface ComponentRefIdentity {
  readonly name: string;
  readonly resolvedKey?: string;
  readonly resolvedNode?: unknown;
}

export function hasSiblingSchemaConstraints(node: UnknownRecord): boolean {
  for (const key of Object.keys(node)) {
    if (!PURE_REF_ANNOTATION_KEYS.has(key) && !key.startsWith("x-")) {
      return true;
    }
  }
  return false;
}

export function extractSingleComponentRef(
  schema: unknown,
  resolve: ResolverFn,
  from: string | undefined,
  seen: ReadonlySet<unknown> = new Set(),
): ComponentRefIdentity | null {
  if (!isRecord(schema) || seen.has(schema)) {
    return null;
  }
  const nextSeen = new Set(seen);
  nextSeen.add(schema);

  if (typeof schema.$ref === "string") {
    if (hasSiblingSchemaConstraints(schema)) {
      return null;
    }
    const name = extractComponentSchemaName(schema.$ref, { decodeUri: true });
    if (!name) {
      return null;
    }
    const resolved = safeResolveSchema(resolve, schema, from);
    const resolvedKey = resolved?.location ? locationKey(resolved.location) : undefined;
    return {
      name,
      ...(resolvedKey !== undefined ? { resolvedKey } : {}),
      ...(resolved?.node !== undefined ? { resolvedNode: resolved.node } : {}),
    };
  }

  if (
    Array.isArray(schema.allOf) &&
    schema.allOf.length === 1 &&
    Object.keys(schema).every(
      (key) => key === "allOf" || PURE_REF_ANNOTATION_KEYS.has(key) || key.startsWith("x-"),
    )
  ) {
    return extractSingleComponentRef(schema.allOf[0], resolve, from, nextSeen);
  }

  return null;
}

export function areComponentRefsSame(
  a: ComponentRefIdentity | null,
  b: ComponentRefIdentity | null,
): boolean {
  if (!a || !b) {
    return false;
  }
  if (a.resolvedNode !== undefined && b.resolvedNode !== undefined) {
    return a.resolvedNode === b.resolvedNode;
  }
  if (a.resolvedKey !== undefined && b.resolvedKey !== undefined) {
    return a.resolvedKey === b.resolvedKey;
  }
  return a.name === b.name;
}

export function isAddressableResourceVariant(
  variant: FlattenedObjectVariant,
  resolve: ResolverFn,
): boolean {
  if (!variant.typeConstraint.allowed.has("object")) {
    return false;
  }
  const idProp = variant.properties.get("id");
  if (!idProp) {
    return false;
  }
  return isScalarIdTypeConstraint(propertyTypeConstraint(idProp, resolve));
}

export function isDeletionReceiptVariant(variant: FlattenedObjectVariant): boolean {
  let hasReceiptMeta = false;
  for (const key of variant.properties.keys()) {
    if (key === "id") {
      continue;
    }
    if (DELETE_RECEIPT_META_KEYS.has(key)) {
      hasReceiptMeta = true;
    } else {
      return false;
    }
  }
  return hasReceiptMeta;
}

export function looksLikeOperationResourceVariant(variant: FlattenedObjectVariant): boolean {
  const props = variant.properties;
  return (
    props.has("id") &&
    props.has("status") &&
    props.has("type") &&
    props.has("createdAt") &&
    props.has("updatedAt")
  );
}

export interface AddressableCollectionInfo {
  readonly arrayPropertyName: string;
  readonly itemBranches: readonly ArrayItemBranch[];
  readonly itemVariants: readonly FlattenedObjectVariant[];
  readonly truncated: boolean;
}

export function extractCollectionInfo(
  variant: FlattenedObjectVariant,
  resolve: ResolverFn,
  options?: {
    readonly requireScalarId?: boolean;
    readonly allowNonObjectMetadata?: boolean;
    readonly variantOptions?: FlattenedVariantOptions;
  },
): AddressableCollectionInfo | null {
  const requireScalarId = options?.requireScalarId ?? true;
  const allowNonObjectMetadata = options?.allowNonObjectMetadata ?? false;
  const variantOptions = options?.variantOptions;

  if (
    !variant.typeConstraint.allowed.has("object") ||
    variant.properties.size === 0 ||
    variant.hasSchemaAdditionalProperties
  ) {
    return null;
  }
  if (variant.properties.has("id")) {
    return null;
  }

  const arrayProps: Array<{
    name: string;
    branches: ArrayItemBranch[];
    itemVariants: FlattenedObjectVariant[];
    truncated: boolean;
  }> = [];

  for (const [propName, prop] of variant.properties.entries()) {
    const tc = propertyTypeConstraint(prop, resolve);
    const itemCollection = tc.allowed.has("array")
      ? collectArrayItemBranches(prop.fragments, resolve)
      : { branches: [], truncated: false, hasUnconstrainedBranch: false };
    const itemBranches = itemCollection.branches;

    if (
      !itemCollection.hasUnconstrainedBranch &&
      itemBranches.length > 0 &&
      !COLLECTION_METADATA_KEYS.has(propName)
    ) {
      const collectedVariants: FlattenedObjectVariant[] = [];
      let truncated = itemCollection.truncated;
      for (const branch of itemBranches) {
        const res = collectFragmentsObjectVariants(branch, resolve, variantOptions);
        if (res.truncated) {
          truncated = true;
        }
        for (const itemVariant of res.variants) {
          if (!isStrictlyNullConstraint(itemVariant.typeConstraint)) {
            collectedVariants.push(itemVariant);
          }
        }
      }
      const isObjectItemArray =
        collectedVariants.length > 0 &&
        collectedVariants.every(
          (itemVariant) =>
            itemVariant.typeConstraint.allowed.has("object") && itemVariant.properties.size > 0,
        );
      if (isObjectItemArray) {
        arrayProps.push({
          name: propName,
          branches: itemBranches,
          itemVariants: dedupeFlattenedVariants(collectedVariants, resolve, variantOptions),
          truncated,
        });
      } else if (!allowNonObjectMetadata) {
        return null;
      }
    } else if (!COLLECTION_METADATA_KEYS.has(propName)) {
      if (!allowNonObjectMetadata || tc.allowed.has("object")) {
        return null;
      }
    }
  }

  if (arrayProps.length !== 1) {
    return null;
  }

  const target = arrayProps[0];
  if (!target) {
    return null;
  }

  if (
    requireScalarId &&
    !target.itemVariants.every((itemVariant) => isAddressableResourceVariant(itemVariant, resolve))
  ) {
    return null;
  }

  return {
    arrayPropertyName: target.name,
    itemBranches: target.branches,
    itemVariants: target.itemVariants,
    truncated: target.truncated,
  };
}

export function extractAddressableCollection(
  variant: FlattenedObjectVariant,
  resolve: ResolverFn,
): AddressableCollectionInfo | null {
  return extractCollectionInfo(variant, resolve, {
    requireScalarId: true,
    allowNonObjectMetadata: false,
  });
}

export function variantsShareCompatibleScalarId(
  sourceVariant: FlattenedObjectVariant,
  getVariant: FlattenedObjectVariant,
  resolve: ResolverFn,
): boolean {
  if (
    !sourceVariant.typeConstraint.allowed.has("object") ||
    !getVariant.typeConstraint.allowed.has("object")
  ) {
    return false;
  }
  const sourceId = sourceVariant.properties.get("id");
  const getId = getVariant.properties.get("id");
  if (!sourceId || !getId) {
    return false;
  }
  const idOverlap = intersectTypeSets(
    propertyTypeConstraint(sourceId, resolve).allowed,
    propertyTypeConstraint(getId, resolve).allowed,
  );
  for (const t of idOverlap) {
    if (SCALAR_ID_TYPES.has(t)) {
      return true;
    }
  }
  return false;
}

export function arePropertyTypeConstraintsCompatible(
  a: TypeConstraint,
  b: TypeConstraint,
): boolean {
  const overlap = intersectTypeSets(a.allowed, b.allowed);
  if (overlap.size === 0) {
    return false;
  }
  const aNonNull = new Set([...a.allowed].filter((t) => t !== "null"));
  const bNonNull = new Set([...b.allowed].filter((t) => t !== "null"));
  if (aNonNull.size > 0 && bNonNull.size > 0) {
    return intersectTypeSets(aNonNull, bNonNull).size > 0;
  }
  return true;
}

export function areVariantsStructurallyCompatible(
  listVariant: FlattenedObjectVariant,
  getVariant: FlattenedObjectVariant,
  resolve: ResolverFn,
  allowDeletionReceipt = false,
): boolean {
  if (!variantsShareCompatibleScalarId(listVariant, getVariant, resolve)) {
    return false;
  }

  if (allowDeletionReceipt && isDeletionReceiptVariant(listVariant)) {
    return true;
  }

  for (const reqName of listVariant.required) {
    const getProp = getVariant.properties.get(reqName);
    if (!getProp) {
      return false;
    }
    const listProp = listVariant.properties.get(reqName);
    if (
      listProp &&
      !arePropertyTypeConstraintsCompatible(
        propertyTypeConstraint(listProp, resolve),
        propertyTypeConstraint(getProp, resolve),
      )
    ) {
      return false;
    }
  }

  const listNonIdKeys = [...listVariant.properties.keys()].filter((k) => k !== "id");
  const getNonIdKeys = [...getVariant.properties.keys()].filter((k) => k !== "id");
  if (listNonIdKeys.length === 0) {
    return getNonIdKeys.length === 0;
  }

  let hasCompatibleSharedField = false;
  for (const key of listNonIdKeys) {
    const listProp = listVariant.properties.get(key);
    const getProp = getVariant.properties.get(key);
    if (!listProp || !getProp) {
      continue;
    }
    if (
      !arePropertyTypeConstraintsCompatible(
        propertyTypeConstraint(listProp, resolve),
        propertyTypeConstraint(getProp, resolve),
      )
    ) {
      return false;
    }
    hasCompatibleSharedField = true;
  }

  return hasCompatibleSharedField;
}

export function areSchemasCompatibleForHoistedGet(
  sourceItemBranches: readonly ArrayItemBranch[],
  sourceVariants: readonly FlattenedObjectVariant[],
  getSchema: unknown,
  getSchemaLocation: RedoclyLocation,
  resolve: ResolverFn,
  allowDeletionReceipt = false,
): boolean {
  const getFrom = getSchemaLocation.source?.absoluteRef;
  if (sourceItemBranches.length === 1 && sourceItemBranches[0]?.length === 1) {
    const singleFrag = sourceItemBranches[0][0];
    if (singleFrag) {
      const listRef = extractSingleComponentRef(singleFrag.node, resolve, singleFrag.from);
      const getRef = extractSingleComponentRef(getSchema, resolve, getFrom);
      if (areComponentRefsSame(listRef, getRef)) {
        return true;
      }
    }
  }

  const getCollected = collectFlattenedObjectVariants(getSchema, resolve, getSchemaLocation);
  const getVariants = getCollected.variants.filter(
    (variant) => !isStrictlyNullConstraint(variant.typeConstraint),
  );
  if (getVariants.length === 0 || sourceVariants.length === 0) {
    return false;
  }

  return sourceVariants.every((listVariant) =>
    getVariants.some((getVariant) =>
      areVariantsStructurallyCompatible(listVariant, getVariant, resolve, allowDeletionReceipt),
    ),
  );
}

export function variantsOverlapForHoistedPairing(
  sourceVariants: readonly FlattenedObjectVariant[],
  getVariants: readonly FlattenedObjectVariant[],
  resolve: ResolverFn,
): boolean {
  for (const sv of sourceVariants) {
    if (!sv.typeConstraint.allowed.has("object") || sv.properties.size === 0) {
      continue;
    }
    for (const gv of getVariants) {
      if (!gv.typeConstraint.allowed.has("object") || gv.properties.size === 0) {
        continue;
      }
      if (variantsShareCompatibleScalarId(sv, gv, resolve)) {
        const svNonId = [...sv.properties.keys()].filter((k) => k !== "id");
        const gvNonId = [...gv.properties.keys()].filter((k) => k !== "id");
        if (svNonId.length === 0 && gvNonId.length === 0) {
          return true;
        }
        if (svNonId.some((k) => gv.properties.has(k))) {
          return true;
        }
        continue;
      }
      // Legacy resources using `<entity>Id` instead of `id`: require shared ID-like key + another shared key.
      let sharedCount = 0;
      let sharedIdLike = false;
      for (const k of sv.properties.keys()) {
        if (!gv.properties.has(k)) {
          continue;
        }
        sharedCount += 1;
        if (k === "id" || k.endsWith("Id")) {
          sharedIdLike = true;
        }
      }
      if (sharedIdLike && sharedCount >= 2) {
        return true;
      }
    }
  }
  return false;
}

export function isFireAndForgetAcceptedOnly(
  operation: UnknownRecord,
  operationLocation: RedoclyLocation,
  resolve: ResolverFn,
): boolean {
  if (!isRecord(operation.responses)) {
    return false;
  }
  const twoXxKeys = Object.keys(operation.responses).filter(
    (code) => EXACT_2XX_STATUS_RE.test(code) || code.toUpperCase() === "2XX",
  );
  if (twoXxKeys.length !== 1 || twoXxKeys[0] !== "202") {
    return false;
  }
  const inspected = inspectResponseContent(
    operation.responses["202"],
    operationLocation.child(["responses", "202"]),
    resolve,
  );
  if (!inspected) {
    return true;
  }
  return !hasHeaderCaseInsensitive(inspected.node.headers, "location");
}

export function isCustomActionSubRoute(
  entry: IndexedPathEntry,
  entries: readonly IndexedPathEntry[],
  byStructuralKey: ReadonlyMap<string, readonly IndexedPathEntry[]>,
  resolve: ResolverFn,
): boolean {
  const { segments, structuralKey, pathItem } = entry;
  if (
    !isRecord(pathItem.post) ||
    segments.length < 2 ||
    !isParamSegment(segments[segments.length - 2] ?? "")
  ) {
    return false;
  }
  const actionSegment = segments[segments.length - 1] ?? "";
  if (isParamSegment(actionSegment)) {
    return false;
  }
  const postOp = pathItem.post;
  const postLoc = entry.operationLocation("post");
  const recognizedAction = isActionVerbSegment(actionSegment);

  const isSubCollectionOrResource =
    isRecord(pathItem.get) ||
    isRecord(pathItem.patch) ||
    isRecord(pathItem.put) ||
    isRecord(pathItem.delete) ||
    (!recognizedAction && hasAnyStrictDescendant(entries, structuralKey)) ||
    computeHoistedCollectionCandidates(segments).some((hoistedCol) =>
      hasAnyOperationOnStructuralKey(byStructuralKey, structuralPathKey([...hoistedCol, "{}"])),
    ) ||
    (isRecord(postOp.responses) && isRecord(postOp.responses["201"])) ||
    looksLikePluralSubCollectionSegment(actionSegment) ||
    (!recognizedAction && isFireAndForgetAcceptedOnly(postOp, postLoc, resolve));

  return !isSubCollectionOrResource;
}

export function operationReturnsAddressableResource(
  operation: UnknownRecord,
  operationLocation: RedoclyLocation,
  resolve: ResolverFn,
  statusCodes: readonly string[],
): boolean {
  const schemas = extractOperationJsonResponseSchemas(
    operation,
    operationLocation,
    resolve,
    statusCodes,
  );
  for (const entry of schemas) {
    const collected = collectFlattenedObjectVariants(entry.schema, resolve, entry.schemaLocation);
    const nonNull = collected.variants.filter((v) => !isStrictlyNullConstraint(v.typeConstraint));
    if (nonNull.length > 0 && nonNull.every((v) => isAddressableResourceVariant(v, resolve))) {
      return true;
    }
  }
  return false;
}

export function getReturnsCollectionEnvelope(
  getOp: unknown,
  getLoc: RedoclyLocation,
  resolve: ResolverFn,
): {
  readonly hasJsonSchema: boolean;
  readonly isCollection: boolean;
  readonly isAddressableCollection: boolean;
} {
  if (!isRecord(getOp)) {
    return { hasJsonSchema: false, isCollection: false, isAddressableCollection: false };
  }
  const schemas = extractOperationJsonResponseSchemas(getOp, getLoc, resolve, ["200", "2XX"]);
  if (schemas.length === 0) {
    return { hasJsonSchema: false, isCollection: false, isAddressableCollection: false };
  }
  let isCollection = false;
  for (const entry of schemas) {
    const collected = collectFlattenedObjectVariants(entry.schema, resolve, entry.schemaLocation);
    for (const variant of collected.variants) {
      if (extractAddressableCollection(variant, resolve) !== null) {
        return { hasJsonSchema: true, isCollection: true, isAddressableCollection: true };
      }
      if (variant.typeConstraint.allowed.has("array")) {
        isCollection = true;
        continue;
      }
      if (!variant.typeConstraint.allowed.has("object") || variant.properties.has("id")) {
        continue;
      }
      for (const [propName, prop] of variant.properties.entries()) {
        if (
          !COLLECTION_METADATA_KEYS.has(propName) &&
          propertyTypeConstraint(prop, resolve).allowed.has("array")
        ) {
          isCollection = true;
        }
      }
    }
  }
  return { hasJsonSchema: true, isCollection, isAddressableCollection: false };
}

export function isSchemaOrVariantIgnored(
  ignoreMatcher: RuleIgnoreMatcher,
  pathTemplate: string | undefined,
  method: string | undefined,
  variant?: FlattenedObjectVariant,
  topLevelSchemaName?: string,
): boolean {
  const check = (schema: string): boolean =>
    ignoreMatcher.isIgnored({
      ...(pathTemplate !== undefined ? { path: pathTemplate } : {}),
      ...(method !== undefined ? { method } : {}),
      schema,
    });

  if (topLevelSchemaName && check(topLevelSchemaName)) {
    return true;
  }
  if (variant) {
    for (const schemaName of variant.schemaNames) {
      if (check(schemaName)) {
        return true;
      }
    }
  }
  return false;
}

export interface PatchVariantViolation {
  readonly kind: "required" | "additional-properties";
  readonly disallowedRequired?: readonly string[];
  readonly path?: string;
}

export function checkPatchObjectVariantConstraints(
  variant: FlattenedObjectVariant,
): PatchVariantViolation[] {
  if (!variant.typeConstraint.allowed.has("object")) {
    return [];
  }
  const violations: PatchVariantViolation[] = [];

  const disallowedRequired = [...variant.required]
    .filter((key) => !variant.discriminatorProperties.has(key))
    .sort((a, b) => a.localeCompare(b, "en"));
  if (disallowedRequired.length > 0) {
    violations.push({ kind: "required", disallowedRequired });
  }

  // Open-dictionary maps (no fixed properties, typed schema additionalProperties) are allowed.
  const isOpenDictionaryMap =
    variant.properties.size === 0 && variant.hasSchemaAdditionalProperties;
  if (!isOpenDictionaryMap && !variant.forbidsAdditionalProperties) {
    violations.push({ kind: "additional-properties" });
  }

  return violations;
}

export interface NestedOpenPatchObjectResult {
  readonly openPaths: string[];
  readonly truncated: boolean;
}

export function collectNestedOpenPatchObjectPaths(
  variant: FlattenedObjectVariant,
  resolve: ResolverFn,
  maxDepth = MAX_COMPAT_DEPTH,
): NestedOpenPatchObjectResult {
  const openPaths: string[] = [];
  const reported = new Set<string>();
  let truncated = false;

  const walk = (
    current: FlattenedObjectVariant,
    prefix: string,
    depth: number,
    seenFragments: ReadonlySet<string>,
  ): void => {
    if (depth >= maxDepth) {
      return;
    }
    const sortedKeys = [...current.properties.keys()].sort((a, b) => a.localeCompare(b, "en"));
    for (const key of sortedKeys) {
      const prop = current.properties.get(key);
      if (!prop) {
        continue;
      }
      const tc = propertyTypeConstraint(prop, resolve);
      if (!tc.allowed.has("object")) {
        continue;
      }
      const fragKey = fragmentListKey(prop.fragments);
      if (seenFragments.has(fragKey)) {
        continue;
      }
      const nextSeen = new Set(seenFragments);
      nextSeen.add(fragKey);

      const fieldPath = joinFieldPath(prefix, key);
      const subCollected = collectFragmentsObjectVariants(
        prop.fragments,
        resolve,
        COMPAT_VARIANT_OPTIONS,
      );
      if (subCollected.truncated) {
        truncated = true;
      }
      for (const sub of subCollected.variants) {
        if (
          !sub.typeConstraint.allowed.has("object") ||
          isStrictlyNullConstraint(sub.typeConstraint)
        ) {
          continue;
        }
        // Only typed open-dictionary maps (no fixed properties, typed schema additionalProperties)
        // replace wholesale; untyped open objects and fixed-schema sub-objects must forbid extras.
        if (sub.properties.size === 0 && sub.hasSchemaAdditionalProperties) {
          continue;
        }
        if (!sub.forbidsAdditionalProperties && !reported.has(fieldPath)) {
          reported.add(fieldPath);
          openPaths.push(fieldPath);
        }
        walk(sub, fieldPath, depth + 1, nextSeen);
      }
    }
  };

  walk(variant, "", 0, new Set());
  return { openPaths, truncated };
}

export function isTypeSubset(
  source: ReadonlySet<JsonSchemaType>,
  target: ReadonlySet<JsonSchemaType>,
): boolean {
  if (source.size === 0) {
    return false;
  }
  for (const t of source) {
    if (target.has(t)) {
      continue;
    }
    if (t === "integer" && target.has("number")) {
      continue;
    }
    return false;
  }
  return true;
}

export interface SchemaMismatch {
  readonly path: string;
  readonly reason: string;
}

function joinFieldPath(prefix: string, field: string): string {
  return prefix.length > 0 ? `${prefix}.${field}` : field;
}

function fragmentListKey(fragments: readonly SchemaFragment[]): string {
  return fragments
    .map((frag) => (frag.location ? locationKey(frag.location) : schemaNodeIdentity(frag.node)))
    .sort()
    .join(",");
}

export interface PropertyCompatOptions {
  readonly path: string;
  readonly forbidReadOnly?: boolean;
  readonly requireCanonicalRequired?: boolean;
  readonly depth?: number;
  readonly seenPairs?: Set<string>;
}

export function compareFragmentsAgainstTargets(
  sourceFragments: readonly SchemaFragment[],
  targetFragmentsList: readonly (readonly SchemaFragment[])[],
  resolve: ResolverFn,
  options: PropertyCompatOptions,
): SchemaMismatch | null {
  const depth = options.depth ?? 0;
  const seenPairs = options.seenPairs ?? new Set<string>();

  const sourceTypes = computeFragmentsTypeConstraint(sourceFragments, resolve).allowed;
  const unionTargetTypes = new Set<JsonSchemaType>();
  for (const tf of targetFragmentsList) {
    for (const t of computeFragmentsTypeConstraint(tf, resolve).allowed) {
      unionTargetTypes.add(t);
    }
  }

  // An unsatisfiable source branch (for example `items: false`, permitting only empty arrays)
  // admits no values that could violate the canonical schema.
  if (sourceTypes.size === 0) {
    return null;
  }

  if (unionTargetTypes.size === 0) {
    return {
      path: options.path,
      reason: `type "${formatTypeSummary(sourceTypes)}" is incompatible with canonical schema forbidding values`,
    };
  }

  if (!isTypeSubset(sourceTypes, unionTargetTypes)) {
    return {
      path: options.path,
      reason: `type "${formatTypeSummary(sourceTypes)}" is incompatible with canonical type "${formatTypeSummary(unionTargetTypes)}"`,
    };
  }

  if (depth >= MAX_COMPAT_DEPTH) {
    return null;
  }

  const pairKey = `${fragmentListKey(sourceFragments)}=>${targetFragmentsList.map(fragmentListKey).sort().join("|")}`;
  if (seenPairs.has(pairKey)) {
    return null;
  }
  seenPairs.add(pairKey);

  try {
    if (sourceTypes.has("object") && unionTargetTypes.has("object")) {
      const sourceObjVariants = collectFragmentsObjectVariants(
        sourceFragments,
        resolve,
        COMPAT_VARIANT_OPTIONS,
      ).variants.filter(
        (v) =>
          v.typeConstraint.allowed.has("object") &&
          !isStrictlyNullConstraint(v.typeConstraint) &&
          (options.requireCanonicalRequired === true ||
            v.properties.size > 0 ||
            v.additionalPropertiesSchemas.length > 0 ||
            v.openAdditionalProperties ||
            !v.forbidsAdditionalProperties),
      );
      const targetObjVariants: FlattenedObjectVariant[] = [];
      for (const tf of targetFragmentsList) {
        for (const tv of collectFragmentsObjectVariants(tf, resolve, COMPAT_VARIANT_OPTIONS)
          .variants) {
          if (
            tv.typeConstraint.allowed.has("object") &&
            !isStrictlyNullConstraint(tv.typeConstraint)
          ) {
            targetObjVariants.push(tv);
          }
        }
      }

      const hasConstrainedTarget = targetObjVariants.some(
        (tv) =>
          tv.properties.size > 0 ||
          tv.required.size > 0 ||
          tv.additionalPropertiesSchemas.length > 0 ||
          tv.forbidsAdditionalProperties,
      );
      if (sourceObjVariants.length > 0 && hasConstrainedTarget) {
        for (const sv of sourceObjVariants) {
          const nestedMismatches = checkVariantAgainstCanonicalVariants(
            sv,
            targetObjVariants,
            resolve,
            {
              pathPrefix: options.path,
              forbidReadOnly: options.forbidReadOnly === true,
              requireCanonicalRequired: options.requireCanonicalRequired === true,
              depth: depth + 1,
              seenPairs,
            },
          );
          if (nestedMismatches[0]) {
            return nestedMismatches[0];
          }
        }
      }
    }

    if (sourceTypes.has("array") && unionTargetTypes.has("array")) {
      const sourceItems = collectArrayItemBranches(sourceFragments, resolve);
      const targetBranches: ArrayItemBranch[] = [];
      let targetTruncated = false;
      let targetHasUnconstrained = false;
      for (const tf of targetFragmentsList) {
        const res = collectArrayItemBranches(tf, resolve);
        if (res.truncated) {
          targetTruncated = true;
        }
        if (res.hasUnconstrainedBranch) {
          targetHasUnconstrained = true;
        }
        targetBranches.push(...res.branches);
      }
      if (sourceItems.truncated || targetTruncated) {
        return {
          path: `${options.path}[]`,
          reason: `array item schema exceeds the ${MAX_OBJECT_VARIANTS}-branch union analysis cap and could not be fully verified`,
        };
      }
      if (!targetHasUnconstrained && targetBranches.length > 0) {
        const sourceBranchesToCheck: ArrayItemBranch[] = [
          ...sourceItems.branches,
          ...(sourceItems.hasUnconstrainedBranch ? [[{ node: {} }]] : []),
        ];
        for (const srcBranch of sourceBranchesToCheck) {
          const itemMismatch = compareFragmentsAgainstTargets(srcBranch, targetBranches, resolve, {
            path: `${options.path}[]`,
            forbidReadOnly: options.forbidReadOnly === true,
            requireCanonicalRequired: options.requireCanonicalRequired === true,
            depth: depth + 1,
            seenPairs,
          });
          if (itemMismatch) {
            return itemMismatch;
          }
        }
      }
    }

    return null;
  } finally {
    seenPairs.delete(pairKey);
  }
}

export interface VariantSubsetOptions {
  readonly pathPrefix?: string;
  readonly excludedKeys?: ReadonlySet<string>;
  readonly forbidReadOnly?: boolean;
  readonly requireCanonicalRequired?: boolean;
  readonly serverManagedKeys?: ReadonlySet<string>;
  readonly onlyOverlapping?: boolean;
  readonly depth?: number;
  readonly seenPairs?: Set<string>;
}

function canonicalPropertyTargetForKey(
  cv: FlattenedObjectVariant,
  key: string,
  depth: number,
): readonly SchemaFragment[] | "any" | null {
  const prop = cv.properties.get(key);
  if (prop) {
    return prop.fragments;
  }
  if (cv.additionalPropertiesSchemas.length > 0) {
    return cv.additionalPropertiesSchemas;
  }
  if (depth > 0 && cv.properties.size === 0 && !cv.forbidsAdditionalProperties) {
    return "any";
  }
  return null;
}

function evaluateKeysAgainstCanonicals(
  sourceVariant: FlattenedObjectVariant,
  keysToCheck: readonly string[],
  canonicals: readonly FlattenedObjectVariant[],
  resolve: ResolverFn,
  options: VariantSubsetOptions,
): SchemaMismatch[] {
  const pathPrefix = options.pathPrefix ?? "";
  const depth = options.depth ?? 0;
  const mismatches: SchemaMismatch[] = [];

  for (const key of keysToCheck) {
    const srcProp = sourceVariant.properties.get(key);
    if (!srcProp) {
      continue;
    }
    const fieldPath = joinFieldPath(pathPrefix, key);

    if (depth === 0 && options.serverManagedKeys?.has(key)) {
      mismatches.push({
        path: fieldPath,
        reason: "is a server-managed field and must not be accepted in mutation payloads",
      });
      continue;
    }

    const matchingTargets: Array<{
      readonly cv: FlattenedObjectVariant;
      readonly target: readonly SchemaFragment[] | "any";
    }> = [];
    for (const cv of canonicals) {
      const target = canonicalPropertyTargetForKey(cv, key, depth);
      if (target !== null) {
        matchingTargets.push({ cv, target });
      }
    }
    if (matchingTargets.length === 0) {
      continue;
    }

    if (
      options.forbidReadOnly &&
      matchingTargets.every(({ cv }) => {
        const targetProp = cv.properties.get(key);
        return targetProp !== undefined && isTrackedPropertyReadOnly(targetProp, resolve);
      })
    ) {
      mismatches.push({
        path: fieldPath,
        reason:
          "is marked readOnly on the canonical schema and must not be accepted in write payloads",
      });
      continue;
    }

    if (matchingTargets.some(({ target }) => target === "any")) {
      continue;
    }

    const targetFragmentsList = matchingTargets.flatMap(({ target }) =>
      target === "any" ? [] : [target],
    );

    const mismatch = compareFragmentsAgainstTargets(
      srcProp.fragments,
      targetFragmentsList,
      resolve,
      {
        path: fieldPath,
        forbidReadOnly: options.forbidReadOnly === true,
        requireCanonicalRequired: options.requireCanonicalRequired === true,
        depth,
        ...(options.seenPairs ? { seenPairs: options.seenPairs } : {}),
      },
    );
    if (mismatch) {
      mismatches.push(mismatch);
    }
  }

  return mismatches;
}

function compareAdditionalPropertiesAgainstCanonicals(
  sourceVariant: FlattenedObjectVariant,
  canonicals: readonly FlattenedObjectVariant[],
  resolve: ResolverFn,
  options: VariantSubsetOptions,
): SchemaMismatch | null {
  const isFreeFormOpenSource =
    sourceVariant.properties.size === 0 && !sourceVariant.forbidsAdditionalProperties;
  const sourceAllowsExtra =
    sourceVariant.additionalPropertiesSchemas.length > 0 ||
    sourceVariant.openAdditionalProperties ||
    isFreeFormOpenSource;
  if (!sourceAllowsExtra) {
    return null;
  }
  const allowsAnyTarget = canonicals.some(
    (cv) =>
      (cv.openAdditionalProperties && cv.additionalPropertiesSchemas.length === 0) ||
      (cv.properties.size === 0 &&
        cv.additionalPropertiesSchemas.length === 0 &&
        !cv.forbidsAdditionalProperties),
  );
  if (allowsAnyTarget) {
    return null;
  }

  const pathPrefix = options.pathPrefix ?? "";
  const depth = options.depth ?? 0;
  const targetAddPropList = canonicals
    .filter((cv) => cv.additionalPropertiesSchemas.length > 0)
    .map((cv) => cv.additionalPropertiesSchemas);

  if (targetAddPropList.length === 0) {
    if (canonicals.every((cv) => cv.forbidsAdditionalProperties)) {
      return {
        path: joinFieldPath(pathPrefix, "*"),
        reason: "allows additional properties while the canonical schema forbids them",
      };
    }
    return null;
  }

  const sourceAddPropFragments: readonly SchemaFragment[] =
    sourceVariant.additionalPropertiesSchemas.length > 0
      ? sourceVariant.additionalPropertiesSchemas
      : [{ node: {} }];

  return compareFragmentsAgainstTargets(sourceAddPropFragments, targetAddPropList, resolve, {
    path: joinFieldPath(pathPrefix, "*"),
    forbidReadOnly: options.forbidReadOnly === true,
    requireCanonicalRequired: options.requireCanonicalRequired === true,
    depth: depth + 1,
    ...(options.seenPairs ? { seenPairs: options.seenPairs } : {}),
  });
}

export function checkVariantAgainstCanonicalVariants(
  sourceVariant: FlattenedObjectVariant,
  canonicalVariants: readonly FlattenedObjectVariant[],
  resolve: ResolverFn,
  options: VariantSubsetOptions = {},
): SchemaMismatch[] {
  const objCanonicals = canonicalVariants.filter(
    (cv) => cv.typeConstraint.allowed.has("object") && !isStrictlyNullConstraint(cv.typeConstraint),
  );
  if (objCanonicals.length === 0) {
    return [];
  }

  const depth = options.depth ?? 0;
  const pathPrefix = options.pathPrefix ?? "";
  const allSortedKeys = [...sourceVariant.properties.keys()].sort((a, b) =>
    a.localeCompare(b, "en"),
  );

  // Reserved server-managed keys at root are always forbidden regardless of excludedKeys or GET overlap.
  const serverManagedMismatches: SchemaMismatch[] = [];
  if (depth === 0 && options.serverManagedKeys && options.serverManagedKeys.size > 0) {
    for (const key of allSortedKeys) {
      if (options.serverManagedKeys.has(key)) {
        serverManagedMismatches.push({
          path: joinFieldPath(pathPrefix, key),
          reason: "is a server-managed field and must not be accepted in mutation payloads",
        });
      }
    }
  }

  const keysToCheck = allSortedKeys.filter(
    (k) => !(depth === 0 && options.serverManagedKeys?.has(k)) && !options.excludedKeys?.has(k),
  );

  if (options.onlyOverlapping) {
    const propMismatches = evaluateKeysAgainstCanonicals(
      sourceVariant,
      keysToCheck,
      objCanonicals,
      resolve,
      options,
    );
    const addPropMismatch = compareAdditionalPropertiesAgainstCanonicals(
      sourceVariant,
      objCanonicals,
      resolve,
      options,
    );
    return [
      ...serverManagedMismatches,
      ...propMismatches,
      ...(addPropMismatch ? [addPropMismatch] : []),
    ];
  }

  // If canonical is an unconstrained open dictionary (no declared properties, no required keys,
  // and no schema additionalProperties), allow arbitrary keys.
  if (
    objCanonicals.every(
      (cv) =>
        cv.properties.size === 0 &&
        cv.required.size === 0 &&
        cv.additionalPropertiesSchemas.length === 0 &&
        !cv.forbidsAdditionalProperties,
    )
  ) {
    return serverManagedMismatches;
  }

  const coveringCanonicals = objCanonicals.filter((cv) =>
    keysToCheck.every((key) => canonicalPropertyTargetForKey(cv, key, depth) !== null),
  );

  if (coveringCanonicals.length === 0) {
    const missing: SchemaMismatch[] = [];
    const presentKeys: string[] = [];
    for (const key of keysToCheck) {
      if (!objCanonicals.some((cv) => canonicalPropertyTargetForKey(cv, key, depth) !== null)) {
        missing.push({
          path: joinFieldPath(pathPrefix, key),
          reason: "does not exist on the canonical schema",
        });
      } else {
        presentKeys.push(key);
      }
    }
    if (missing.length > 0) {
      const presentMismatches =
        presentKeys.length > 0
          ? evaluateKeysAgainstCanonicals(
              sourceVariant,
              presentKeys,
              objCanonicals,
              resolve,
              options,
            )
          : [];
      const addPropMismatch = compareAdditionalPropertiesAgainstCanonicals(
        sourceVariant,
        objCanonicals,
        resolve,
        options,
      );
      return [
        ...serverManagedMismatches,
        ...missing,
        ...presentMismatches,
        ...(addPropMismatch ? [addPropMismatch] : []),
      ];
    }
    return [
      ...serverManagedMismatches,
      {
        path: pathPrefix || "(root)",
        reason: "combines properties from mutually exclusive canonical union variants",
      },
    ];
  }

  // Try matching any single canonical variant first; if multiple variants cover all keys
  // (e.g. a collapsed summary over a discriminated union), fall back to their union unless
  // full-response required-property matching is active.
  let bestSingleFailure: SchemaMismatch[] | null = null;
  let bestRequiredFailure: SchemaMismatch[] | null = null;

  for (const cv of coveringCanonicals) {
    const singleMismatches = evaluateKeysAgainstCanonicals(
      sourceVariant,
      keysToCheck,
      [cv],
      resolve,
      options,
    );
    const singleAddPropMismatch =
      singleMismatches.length === 0
        ? compareAdditionalPropertiesAgainstCanonicals(sourceVariant, [cv], resolve, options)
        : null;
    if (singleMismatches.length === 0 && !singleAddPropMismatch) {
      if (options.requireCanonicalRequired && depth > 0) {
        const reqGaps = collectRequiredPropertyGaps(sourceVariant, cv, pathPrefix);
        if (reqGaps.length === 0) {
          return serverManagedMismatches;
        }
        if (bestRequiredFailure === null || reqGaps.length < bestRequiredFailure.length) {
          bestRequiredFailure = reqGaps;
        }
        continue;
      }
      return serverManagedMismatches;
    }
    if (options.requireCanonicalRequired && depth > 0) {
      const combined = [
        ...singleMismatches,
        ...(singleAddPropMismatch ? [singleAddPropMismatch] : []),
      ];
      if (bestSingleFailure === null || combined.length < bestSingleFailure.length) {
        bestSingleFailure = combined;
      }
    }
  }

  if (options.requireCanonicalRequired && depth > 0) {
    return [...serverManagedMismatches, ...(bestRequiredFailure ?? bestSingleFailure ?? [])];
  }

  const unionPropMismatches = evaluateKeysAgainstCanonicals(
    sourceVariant,
    keysToCheck,
    coveringCanonicals,
    resolve,
    options,
  );
  const unionAddPropMismatch = compareAdditionalPropertiesAgainstCanonicals(
    sourceVariant,
    coveringCanonicals,
    resolve,
    options,
  );
  return [
    ...serverManagedMismatches,
    ...unionPropMismatches,
    ...(unionAddPropMismatch ? [unionAddPropMismatch] : []),
  ];
}

function collectRequiredPropertyGaps(
  mv: FlattenedObjectVariant,
  cv: FlattenedObjectVariant,
  pathPrefix: string,
): SchemaMismatch[] {
  const missing: string[] = [];
  const optionalized: string[] = [];
  for (const reqKey of cv.required) {
    if (!mv.properties.has(reqKey)) {
      missing.push(reqKey);
    } else if (!mv.required.has(reqKey)) {
      optionalized.push(reqKey);
    }
  }
  missing.sort((a, b) => a.localeCompare(b, "en"));
  optionalized.sort((a, b) => a.localeCompare(b, "en"));
  const gaps: SchemaMismatch[] = [];
  if (missing.length > 0) {
    const formatted = missing.map((k) => `"${joinFieldPath(pathPrefix, k)}"`).join(", ");
    gaps.push({
      path: pathPrefix || "(root)",
      reason: `omits canonical required properties ${formatted}`,
    });
  }
  if (optionalized.length > 0) {
    const formatted = optionalized.map((k) => `"${joinFieldPath(pathPrefix, k)}"`).join(", ");
    gaps.push({
      path: pathPrefix || "(root)",
      reason: `makes canonical required properties ${formatted} optional`,
    });
  }
  return gaps;
}

function checkResponseVariantAgainstCanonicals(
  mv: FlattenedObjectVariant,
  canonObjVariants: readonly FlattenedObjectVariant[],
  resolve: ResolverFn,
  allowCreationSecret: boolean,
  pathPrefix = "",
): SchemaMismatch[] {
  const allowedNonNull = [...mv.typeConstraint.allowed].filter((t) => t !== "null");
  if (!mv.typeConstraint.allowed.has("object") || allowedNonNull.some((t) => t !== "object")) {
    return [
      {
        path: pathPrefix || "(root)",
        reason: `response type "${formatTypeSummary(mv.typeConstraint.allowed)}" is incompatible with canonical object representation`,
      },
    ];
  }

  const secretExtraKeys = new Set<string>();
  if (allowCreationSecret) {
    for (const [key, prop] of mv.properties.entries()) {
      if (canonObjVariants.some((cv) => cv.properties.has(key))) {
        continue;
      }
      if (!SECRET_OR_TOKEN_PROP_RE.test(key)) {
        continue;
      }
      const types = computeFragmentsTypeConstraint(prop.fragments, resolve).allowed;
      if (isTypeSubset(types, new Set(["string", "null"]))) {
        secretExtraKeys.add(key);
      }
    }
  }

  // Every full response variant must satisfy both property/type compatibility and required-property
  // guarantees against the same canonical variant (not by mixing types from one branch and required
  // properties from another).
  let bestSubsetFailure: SchemaMismatch[] | null = null;
  let bestRequiredFailure: SchemaMismatch[] | null = null;

  for (const cv of canonObjVariants) {
    const subsetMismatches = checkVariantAgainstCanonicalVariants(mv, [cv], resolve, {
      pathPrefix,
      ...(secretExtraKeys.size > 0 ? { excludedKeys: secretExtraKeys } : {}),
      forbidReadOnly: false,
      requireCanonicalRequired: true,
    });
    if (subsetMismatches.length > 0) {
      if (bestSubsetFailure === null || subsetMismatches.length < bestSubsetFailure.length) {
        bestSubsetFailure = subsetMismatches;
      }
      continue;
    }

    const reqGaps = collectRequiredPropertyGaps(mv, cv, pathPrefix);
    if (reqGaps.length === 0) {
      return [];
    }
    if (bestRequiredFailure === null || reqGaps.length < bestRequiredFailure.length) {
      bestRequiredFailure = reqGaps;
    }
  }

  if (bestRequiredFailure) {
    return bestRequiredFailure;
  }
  return bestSubsetFailure ?? [];
}

export function checkResponseVariantsCompatibleWithCanonical(
  respVariants: readonly FlattenedObjectVariant[],
  canonObjVariants: readonly FlattenedObjectVariant[],
  resolve: ResolverFn,
  options: { readonly allowCreationSecret: boolean },
): SchemaMismatch[] {
  if (canonObjVariants.length === 0 || respVariants.length === 0) {
    return [];
  }
  const mismatches: SchemaMismatch[] = [];
  for (const mv of respVariants) {
    mismatches.push(
      ...checkResponseVariantAgainstCanonicals(
        mv,
        canonObjVariants,
        resolve,
        options.allowCreationSecret,
      ),
    );
  }
  return mismatches;
}

export function checkResponseCompatibleWithCanonical(
  responseSchema: unknown,
  responseLocation: RedoclyLocation,
  canonicalSchema: unknown,
  canonicalLocation: RedoclyLocation,
  resolve: ResolverFn,
  options: { readonly allowCreationSecret: boolean },
): { readonly mismatches: SchemaMismatch[]; readonly truncated: boolean } {
  const respRef = extractSingleComponentRef(
    responseSchema,
    resolve,
    responseLocation.source?.absoluteRef,
  );
  const canonRef = extractSingleComponentRef(
    canonicalSchema,
    resolve,
    canonicalLocation.source?.absoluteRef,
  );
  if (areComponentRefsSame(respRef, canonRef)) {
    return { mismatches: [], truncated: false };
  }

  const respCollected = collectFlattenedObjectVariants(
    responseSchema,
    resolve,
    responseLocation,
    COMPAT_VARIANT_OPTIONS,
  );
  const canonCollected = collectFlattenedObjectVariants(
    canonicalSchema,
    resolve,
    canonicalLocation,
    COMPAT_VARIANT_OPTIONS,
  );
  const truncated = respCollected.truncated || canonCollected.truncated;

  const respVariants = respCollected.variants.filter(
    (v) => !isStrictlyNullConstraint(v.typeConstraint),
  );
  const canonObjVariants = canonCollected.variants.filter(
    (v) => v.typeConstraint.allowed.has("object") && !isStrictlyNullConstraint(v.typeConstraint),
  );

  return {
    mismatches: checkResponseVariantsCompatibleWithCanonical(
      respVariants,
      canonObjVariants,
      resolve,
      options,
    ),
    truncated,
  };
}

export function collectActiveObjectVariants(
  schema: unknown,
  schemaLocation: RedoclyLocation,
  pathTemplate: string,
  method: string,
  resolve: ResolverFn,
  ignoreMatcher: RuleIgnoreMatcher,
  topRefName?: string,
  options?: FlattenedVariantOptions,
): { readonly variants: readonly FlattenedObjectVariant[]; readonly truncated: boolean } {
  const collected = collectFlattenedObjectVariants(schema, resolve, schemaLocation, options);
  const active: FlattenedObjectVariant[] = [];
  for (const variant of collected.variants) {
    if (
      !variant.typeConstraint.allowed.has("object") ||
      isStrictlyNullConstraint(variant.typeConstraint)
    ) {
      continue;
    }
    if (isSchemaOrVariantIgnored(ignoreMatcher, pathTemplate, method, variant, topRefName)) {
      continue;
    }
    active.push(variant);
  }
  return { variants: active, truncated: collected.truncated };
}
