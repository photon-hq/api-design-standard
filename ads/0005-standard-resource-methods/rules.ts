import { HTTP_METHODS } from "../../src/ignore.js";
import {
  createRootRule,
  EXACT_2XX_STATUS_RE,
  extractOperationJsonResponseSchemas,
  hasHeaderCaseInsensitive,
  inspectResponseContent,
  iterateRootPathItems,
  type ResolvedPathItem,
} from "../../src/openapi-utils.js";
import {
  computeTypeConstraint,
  extractComponentSchemaName,
  getRefIntermediateHops,
  intersectTypeSets,
  isRecord,
  isStrictlyNullConstraint,
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
} from "../../src/schema-utils.js";
import {
  collectFlattenedObjectVariants,
  collectFragmentsObjectVariants,
  dedupeFlattenedVariants,
  type FlattenedObjectVariant,
} from "../../src/schema-variants.js";
import type {
  AdsStandardMetadata,
  RedoclyLocation,
  RedoclyOas3Rule,
  RedoclyUserContext,
} from "../../src/types.js";
import { PLUGIN_ID } from "../0001-resource-identifiers/rules.js";

export const ADS_0005_METADATA: AdsStandardMetadata = {
  ads: "0005",
  slug: "ads-0005",
  folder: "0005-standard-resource-methods",
  rules: [
    {
      name: "ads-0005-addressable-resource-read",
      id: `${PLUGIN_ID}/ads-0005-addressable-resource-read`,
      severity: "error",
      summary:
        "Addressable resources that support mutation, custom actions, or collection listing must expose a corresponding single-resource GET endpoint (directly or via a schema-compatible hoisted canonical route).",
    },
    {
      name: "ads-0005-standard-http-methods",
      id: `${PLUGIN_ID}/ads-0005-standard-http-methods`,
      severity: "error",
      summary:
        "Endpoints must use standard HTTP method semantics without CRUD verbs in URL segments, without combining PUT and PATCH on the same path, without GET request bodies, and without collection-level DELETE request bodies.",
    },
    {
      name: "ads-0005-standard-status-codes",
      id: `${PLUGIN_ID}/ads-0005-standard-status-codes`,
      severity: "error",
      summary:
        "Standard resource operations must use canonical 2xx success status codes (200 for GET, 201 or 202 for collection POST creation, 200 with body or 202 for PATCH, and 204 without body or 200/202 for DELETE).",
    },
    {
      name: "ads-0005-url-path-naming",
      id: `${PLUGIN_ID}/ads-0005-url-path-naming`,
      severity: "error",
      summary:
        "Static URL path segments (excluding path parameters and leading version prefixes) must use lowercase kebab-case.",
    },
  ],
};

const FULL_PARAM_SEGMENT_RE = /^\{([^}]+)\}$/;
const CUSTOM_METHOD_PARAM_SEGMENT_RE = /^\{([^}]+)\}:(.+)$/;
const LEADING_VERSION_SEGMENT_RE = /^v[0-9]+$/;
const KEBAB_CASE_SEGMENT_RE = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;

const CRUD_VERB_EXACT_RE = /^(create|get|list|update|delete|remove|fetch|edit|add)$/i;
const CRUD_VERB_DELIMITED_RE = /^(create|get|list|update|delete|remove|fetch|edit|add)[-_]/i;
const CRUD_VERB_CAMEL_RE =
  /^(create|get|list|update|delete|remove|fetch|edit|add|Create|Get|List|Update|Delete|Remove|Fetch|Edit|Add)(?=[A-Z])/;

function wordSet(words: string): ReadonlySet<string> {
  return new Set(words.trim().split(/\s+/));
}

const COLLECTION_METADATA_KEYS = wordSet(`
  nextPageToken prevPageToken previousPageToken pageToken cursor nextCursor prevCursor
  previousCursor hasMore hasNextPage hasPreviousPage totalCount total totalItems totalPages
  count limit offset pageSize perPage page pageInfo pagination meta
`);

const NON_PLURAL_S_WORDS = wordSet(`
  as alias bias bus canvas cors dns gas ios is os plus sms this tls yes
`);

const ACTION_VERB_PREFIXES = wordSet(`
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

const QUERY_OR_ACTION_POST_SEGMENTS = wordSet(`
  search query preview validate check verify batch export import count stats
  summary health status
`);

const DELETE_RECEIPT_META_KEYS = wordSet(`
  deleted deletedAt object status message
`);

const PURE_REF_ANNOTATION_KEYS = wordSet(`
  $ref title description summary default deprecated readOnly writeOnly
  example examples externalDocs $comment
`);

const SCALAR_ID_TYPES: ReadonlySet<JsonSchemaType> = new Set(["string", "integer", "number"]);

export function normalizePathTemplate(pathTemplate: string): string {
  const trimmed = pathTemplate.trim().replace(/\/+$/, "");
  return trimmed.length === 0 ? "/" : trimmed;
}

function hasTrailingSlash(pathTemplate: string): boolean {
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

function isParamSegment(segment: string): boolean {
  return FULL_PARAM_SEGMENT_RE.test(segment);
}

export function endsWithPathParam(pathTemplate: string): boolean {
  const segments = splitPathSegments(pathTemplate);
  const last = segments[segments.length - 1];
  return last !== undefined && isParamSegment(last);
}

function structuralPathKey(segments: readonly string[], trailingSlash = false): string {
  if (segments.length === 0) {
    return "/";
  }
  const base = `/${segments.map((segment) => (isParamSegment(segment) ? "{}" : segment)).join("/")}`;
  return trailingSlash ? `${base}/` : base;
}

function formatSegments(segments: readonly string[]): string {
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

export function findCrudVerbInPathSegment(segment: string): string | null {
  if (isParamSegment(segment) || segment === ".well-known") {
    return null;
  }
  const customMatch = CUSTOM_METHOD_PARAM_SEGMENT_RE.exec(segment);
  const target = customMatch?.[2] ?? segment;
  const exact = CRUD_VERB_EXACT_RE.exec(target);
  if (exact?.[1]) {
    return exact[1].toLowerCase();
  }
  const delimited = CRUD_VERB_DELIMITED_RE.exec(target);
  if (delimited?.[1]) {
    return delimited[1].toLowerCase();
  }
  const camel = CRUD_VERB_CAMEL_RE.exec(target);
  if (camel?.[1]) {
    return camel[1].toLowerCase();
  }
  return null;
}

export function isValidKebabCasePathSegment(segment: string, index: number): boolean {
  if (isParamSegment(segment) || segment === ".well-known") {
    return true;
  }
  if (index === 0 && LEADING_VERSION_SEGMENT_RE.test(segment)) {
    return true;
  }
  const customMatch = CUSTOM_METHOD_PARAM_SEGMENT_RE.exec(segment);
  if (customMatch?.[2]) {
    return KEBAB_CASE_SEGMENT_RE.test(customMatch[2]);
  }
  return KEBAB_CASE_SEGMENT_RE.test(segment);
}

function isActionVerbSegment(segment: string): boolean {
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

function isScalarIdTypeConstraint(tc: TypeConstraint): boolean {
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

type ArrayItemBranch = readonly SchemaFragment[];

function collectArrayItemBranches(
  fragments: readonly SchemaFragment[],
  resolve: ResolverFn,
): ArrayItemBranch[] {
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
          next.push([...a, ...b]);
          if (next.length >= MAX_OBJECT_VARIANTS) {
            branches = next;
            return;
          }
        }
      }
      branches = next;
    };

    if (isRecord(node.items)) {
      const itemLoc = location?.child(["items"]);
      intersectWith([
        [
          {
            node: node.items,
            ...(from !== undefined ? { from } : {}),
            ...(itemLoc ? { location: itemLoc } : {}),
          },
        ],
      ]);
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
            if (isRecord(hop.node.items)) {
              const hopFrom = hop.location?.source?.absoluteRef;
              const hopItemLoc = hop.location?.child(["items"]);
              intersectWith([
                [
                  {
                    node: hop.node.items,
                    ...(hopFrom !== undefined ? { from: hopFrom } : {}),
                    ...(hopItemLoc ? { location: hopItemLoc } : {}),
                  },
                ],
              ]);
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
      return [];
    }
    const next: ArrayItemBranch[] = [];
    for (const a of combined) {
      for (const b of sub) {
        next.push([...a, ...b]);
        if (next.length >= MAX_OBJECT_VARIANTS) {
          break;
        }
      }
      if (next.length >= MAX_OBJECT_VARIANTS) {
        break;
      }
    }
    combined = next;
  }

  return combined.filter((branch) => branch.length > 0);
}

interface ComponentRefIdentity {
  readonly name: string;
  readonly resolvedKey?: string;
}

function hasSiblingSchemaConstraints(node: UnknownRecord): boolean {
  for (const key of Object.keys(node)) {
    if (!PURE_REF_ANNOTATION_KEYS.has(key) && !key.startsWith("x-")) {
      return true;
    }
  }
  return false;
}

function extractSingleComponentRef(
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
    const name = extractComponentSchemaName(schema.$ref);
    if (!name) {
      return null;
    }
    const resolved = safeResolveSchema(resolve, schema, from);
    const resolvedKey = resolved?.location ? locationKey(resolved.location) : undefined;
    return {
      name,
      ...(resolvedKey !== undefined ? { resolvedKey } : {}),
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

function isAddressableResourceVariant(
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

function isDeletionReceiptVariant(variant: FlattenedObjectVariant): boolean {
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

function looksLikeOperationResourceVariant(variant: FlattenedObjectVariant): boolean {
  const props = variant.properties;
  return (
    props.has("id") &&
    props.has("status") &&
    props.has("type") &&
    props.has("createdAt") &&
    props.has("updatedAt")
  );
}

interface AddressableCollectionInfo {
  readonly arrayPropertyName: string;
  readonly itemBranches: readonly ArrayItemBranch[];
  readonly itemVariants: readonly FlattenedObjectVariant[];
}

function extractAddressableCollection(
  variant: FlattenedObjectVariant,
  resolve: ResolverFn,
): AddressableCollectionInfo | null {
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

  const arrayProps: Array<{ name: string; branches: ArrayItemBranch[] }> = [];
  for (const [propName, prop] of variant.properties.entries()) {
    const tc = propertyTypeConstraint(prop, resolve);
    const itemBranches = tc.allowed.has("array")
      ? collectArrayItemBranches(prop.fragments, resolve)
      : [];
    if (itemBranches.length > 0 && !COLLECTION_METADATA_KEYS.has(propName)) {
      arrayProps.push({ name: propName, branches: itemBranches });
    } else if (!COLLECTION_METADATA_KEYS.has(propName)) {
      return null;
    }
  }

  if (arrayProps.length !== 1) {
    return null;
  }

  const target = arrayProps[0];
  if (!target) {
    return null;
  }

  const itemVariants: FlattenedObjectVariant[] = [];
  for (const branch of target.branches) {
    const res = collectFragmentsObjectVariants(branch, resolve);
    for (const itemVariant of res.variants) {
      if (!isStrictlyNullConstraint(itemVariant.typeConstraint)) {
        itemVariants.push(itemVariant);
      }
    }
  }

  if (itemVariants.length === 0) {
    return null;
  }
  if (!itemVariants.every((itemVariant) => isAddressableResourceVariant(itemVariant, resolve))) {
    return null;
  }

  return {
    arrayPropertyName: target.name,
    itemBranches: target.branches,
    itemVariants: dedupeFlattenedVariants(itemVariants, resolve),
  };
}

function variantsShareCompatibleScalarId(
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

function arePropertyTypeConstraintsCompatible(a: TypeConstraint, b: TypeConstraint): boolean {
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

function areVariantsStructurallyCompatible(
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

function areSchemasCompatibleForHoistedGet(
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
      if (listRef && getRef) {
        if (listRef.resolvedKey !== undefined && listRef.resolvedKey === getRef.resolvedKey) {
          return true;
        }
        if (
          listRef.name === getRef.name &&
          (listRef.resolvedKey === undefined || getRef.resolvedKey === undefined)
        ) {
          return true;
        }
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

function isFireAndForgetAcceptedOnly(
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

function operationReturnsAddressableResource(
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

function getReturnsCollectionEnvelope(
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

interface IndexedPathEntry extends ResolvedPathItem {
  readonly pathItem: UnknownRecord;
  readonly normalizedPath: string;
  readonly segments: readonly string[];
  readonly structuralKey: string;
}

function collectIndexedPaths(
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

function hasMatchingEntryOnStructuralKey(
  byStructuralKey: ReadonlyMap<string, readonly IndexedPathEntry[]>,
  key: string,
  predicate: (entry: IndexedPathEntry) => boolean,
): boolean {
  return byStructuralKey.get(key)?.some(predicate) ?? false;
}

function hasAnyGetOnStructuralKey(
  byStructuralKey: ReadonlyMap<string, readonly IndexedPathEntry[]>,
  key: string,
): boolean {
  return hasMatchingEntryOnStructuralKey(byStructuralKey, key, (entry) =>
    isRecord(entry.pathItem.get),
  );
}

function hasAnyOperationOnStructuralKey(
  byStructuralKey: ReadonlyMap<string, readonly IndexedPathEntry[]>,
  key: string,
): boolean {
  return hasMatchingEntryOnStructuralKey(byStructuralKey, key, (entry) =>
    HTTP_METHODS.some((method) => isRecord(entry.pathItem[method])),
  );
}

function hasAnyStrictDescendant(
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

function isOperationSatisfiedByHoistedGets(
  op: UnknownRecord,
  opLoc: RedoclyLocation,
  hoistedGets: ReadonlyArray<{ entry: IndexedPathEntry; getOp: UnknownRecord }>,
  resolve: ResolverFn,
  options?: { readonly allowDeletionReceipt?: boolean },
): boolean {
  if (hoistedGets.length === 0) {
    return false;
  }
  const has202 = isRecord(op.responses) && isRecord(op.responses["202"]);
  const responseSchemas = extractOperationJsonResponseSchemas(op, opLoc, resolve, [
    "200",
    "201",
    "202",
    "2XX",
  ]);
  const addressableSchemas: Array<{
    branch: ArrayItemBranch;
    variants: readonly FlattenedObjectVariant[];
  }> = [];

  for (const rs of responseSchemas) {
    const collected = collectFlattenedObjectVariants(rs.schema, resolve, rs.schemaLocation);
    const nonNull = collected.variants.filter((v) => !isStrictlyNullConstraint(v.typeConstraint));
    if (nonNull.length === 0 || !nonNull.every((v) => isAddressableResourceVariant(v, resolve))) {
      continue;
    }
    // Async operations declaring 202 alongside 200 idempotent Operation replay return Operation, not the resource.
    if (has202 && nonNull.every((v) => looksLikeOperationResourceVariant(v))) {
      continue;
    }
    const from = rs.schemaLocation.source?.absoluteRef;
    addressableSchemas.push({
      branch: [
        {
          node: rs.schema,
          ...(from !== undefined ? { from } : {}),
          location: rs.schemaLocation,
        },
      ],
      variants: nonNull,
    });
  }

  if (addressableSchemas.length === 0) {
    return true;
  }

  const allowDeletionReceipt = options?.allowDeletionReceipt === true;
  for (const hoisted of hoistedGets) {
    const hoistedGetSchemas = extractOperationJsonResponseSchemas(
      hoisted.getOp,
      hoisted.entry.operationLocation("get"),
      resolve,
      ["200", "2XX"],
    );
    if (
      addressableSchemas.some((ms) =>
        hoistedGetSchemas.some((gs) =>
          areSchemasCompatibleForHoistedGet(
            [ms.branch],
            ms.variants,
            gs.schema,
            gs.schemaLocation,
            resolve,
            allowDeletionReceipt,
          ),
        ),
      )
    ) {
      return true;
    }
  }
  return false;
}

export const ads0005AddressableResourceRead: RedoclyOas3Rule = createRootRule(
  ({ root, ctx, ignoreMatcher, reportOnce: report }) => {
    const { entries, byStructuralKey } = collectIndexedPaths(root, ctx);

    const findMatchingHoistedGets = (
      collectionSegments: readonly string[],
    ): Array<{ entry: IndexedPathEntry; getOp: UnknownRecord }> => {
      const hoistedCollections = computeHoistedCollectionCandidates(collectionSegments);
      const matches: Array<{ entry: IndexedPathEntry; getOp: UnknownRecord }> = [];
      for (const candidate of hoistedCollections) {
        const candidateItemKey = structuralPathKey([...candidate, "{}"]);
        const bucket = byStructuralKey.get(candidateItemKey);
        if (!bucket) {
          continue;
        }
        for (const candidateEntry of bucket) {
          if (isRecord(candidateEntry.pathItem.get)) {
            matches.push({ entry: candidateEntry, getOp: candidateEntry.pathItem.get });
          }
        }
      }
      return matches;
    };

    for (const entry of entries) {
      const { pathTemplate, segments, structuralKey, pathItem } = entry;
      const isItemPath = segments.length > 0 && isParamSegment(segments[segments.length - 1] ?? "");

      // Part A1: Item paths with PATCH, PUT, or DELETE
      if (isItemPath) {
        const parentSegments = segments.slice(0, -1);
        const itemParam = segments[segments.length - 1] ?? "{resourceId}";
        const hasDirectGet = hasAnyGetOnStructuralKey(byStructuralKey, structuralKey);
        const hoistedCandidates = computeHoistedCollectionCandidates(parentSegments);
        const hoistedGets = findMatchingHoistedGets(parentSegments);

        for (const method of ["patch", "put", "delete"] as const) {
          const op = pathItem[method];
          if (!isRecord(op)) {
            continue;
          }
          if (ignoreMatcher.isIgnored({ path: pathTemplate, method })) {
            continue;
          }
          if (hasDirectGet) {
            continue;
          }

          const satisfiedByHoisted = isOperationSatisfiedByHoistedGets(
            op,
            entry.operationLocation(method),
            hoistedGets,
            ctx.resolve,
            { allowDeletionReceipt: method === "delete" },
          );

          if (!satisfiedByHoisted) {
            const hoistedHint =
              hoistedCandidates.length > 0
                ? ` or a schema-compatible hoisted canonical route such as "GET ${formatSegments([...(hoistedCandidates[hoistedCandidates.length - 1] ?? []), itemParam])}"`
                : "";
            report(
              `item-mutation-missing-get:${method}`,
              entry.operationReportLocation(method),
              `${method.toUpperCase()} "${pathTemplate}" mutates an addressable resource without a corresponding GET endpoint. Add "GET ${entry.normalizedPath}"${hoistedHint} (ADS-0005).`,
            );
          }
        }
        continue;
      }

      // Part A2: Singleton paths (non-item) with PATCH, PUT, or bodyless DELETE
      for (const method of ["patch", "put", "delete"] as const) {
        const op = pathItem[method];
        if (!isRecord(op)) {
          continue;
        }
        // Collection-level DELETE with requestBody is flagged by ads-0005-standard-http-methods;
        // do not double-report it here as a missing singleton GET.
        if (method === "delete" && isRecord(op.requestBody)) {
          continue;
        }
        if (ignoreMatcher.isIgnored({ path: pathTemplate, method })) {
          continue;
        }
        if (!hasAnyGetOnStructuralKey(byStructuralKey, structuralKey)) {
          report(
            `singleton-mutation-missing-get:${method}`,
            entry.operationReportLocation(method),
            `${method.toUpperCase()} "${pathTemplate}" mutates a singleton resource without a corresponding GET endpoint on the same path. Add "GET ${entry.normalizedPath}" (ADS-0005).`,
          );
        }
      }

      // Part A3: Custom action sub-route `POST <itemPath>/<staticActionSegment>`
      if (
        isRecord(pathItem.post) &&
        segments.length >= 2 &&
        isParamSegment(segments[segments.length - 2] ?? "")
      ) {
        const actionSegment = segments[segments.length - 1] ?? "";
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
            hasAnyOperationOnStructuralKey(
              byStructuralKey,
              structuralPathKey([...hoistedCol, "{}"]),
            ),
          ) ||
          (isRecord(postOp.responses) && isRecord(postOp.responses["201"])) ||
          looksLikePluralSubCollectionSegment(actionSegment) ||
          (!recognizedAction && isFireAndForgetAcceptedOnly(postOp, postLoc, ctx.resolve));

        if (
          !isSubCollectionOrResource &&
          !ignoreMatcher.isIgnored({ path: pathTemplate, method: "post" })
        ) {
          const parentItemSegments = segments.slice(0, -1);
          const parentItemKey = structuralPathKey(parentItemSegments);
          const parentCollectionSegments = parentItemSegments.slice(0, -1);
          const parentItemParam =
            parentItemSegments[parentItemSegments.length - 1] ?? "{resourceId}";
          const hasParentGet = hasAnyGetOnStructuralKey(byStructuralKey, parentItemKey);
          const hoistedCandidates = computeHoistedCollectionCandidates(parentCollectionSegments);
          const hoistedGets = findMatchingHoistedGets(parentCollectionSegments);
          const satisfiedByHoisted =
            !hasParentGet &&
            isOperationSatisfiedByHoistedGets(postOp, postLoc, hoistedGets, ctx.resolve);

          if (!hasParentGet && !satisfiedByHoisted) {
            const hoistedHint =
              hoistedCandidates.length > 0
                ? ` or a schema-compatible hoisted canonical route such as "GET ${formatSegments([...(hoistedCandidates[hoistedCandidates.length - 1] ?? []), parentItemParam])}"`
                : "";
            report(
              "action-missing-item-get",
              entry.operationReportLocation("post"),
              `POST "${pathTemplate}" performs a custom action on an addressable resource without a corresponding GET endpoint. Add "GET ${formatSegments(parentItemSegments)}"${hoistedHint} (ADS-0005).`,
            );
          }
        }
      }

      // Part B: Addressable collection `GET` -> Direct child `GET` or compatible hoisted canonical `GET`
      const getOp = pathItem.get;
      if (!isRecord(getOp)) {
        continue;
      }
      if (ignoreMatcher.isIgnored({ path: pathTemplate, method: "get" })) {
        continue;
      }

      const getSchemas = extractOperationJsonResponseSchemas(
        getOp,
        entry.operationLocation("get"),
        ctx.resolve,
        ["200", "2XX"],
      );
      if (getSchemas.length === 0) {
        continue;
      }

      const collectionInfos: AddressableCollectionInfo[] = [];
      let anyTruncated = false;
      for (const gs of getSchemas) {
        const collected = collectFlattenedObjectVariants(gs.schema, ctx.resolve, gs.schemaLocation);
        if (collected.truncated) {
          anyTruncated = true;
        }
        for (const variant of collected.variants) {
          const info = extractAddressableCollection(variant, ctx.resolve);
          if (info) {
            collectionInfos.push(info);
          }
        }
      }

      const directChildKey = structuralPathKey([...segments, "{}"]);
      if (hasAnyGetOnStructuralKey(byStructuralKey, directChildKey)) {
        continue;
      }

      if (collectionInfos.length === 0) {
        if (anyTruncated) {
          report(
            "collection-variant-cap-exceeded",
            entry.operationReportLocation("get"),
            `GET "${pathTemplate}" response schema exceeds the ${MAX_OBJECT_VARIANTS}-variant union analysis cap and could not be fully verified for single-resource GET read symmetry (ADS-0005).`,
          );
        }
        continue;
      }

      const hoistedCandidates = computeHoistedCollectionCandidates(segments);
      const hoistedGets = findMatchingHoistedGets(segments);

      const allCollectionsMatched = collectionInfos.every((info) =>
        hoistedGets.some((hoisted) => {
          const hoistedGetSchemas = extractOperationJsonResponseSchemas(
            hoisted.getOp,
            hoisted.entry.operationLocation("get"),
            ctx.resolve,
            ["200", "2XX"],
          );
          return hoistedGetSchemas.some((gs) =>
            areSchemasCompatibleForHoistedGet(
              info.itemBranches,
              info.itemVariants,
              gs.schema,
              gs.schemaLocation,
              ctx.resolve,
            ),
          );
        }),
      );

      if (!allCollectionsMatched) {
        const lastSeg = segments[segments.length - 1] ?? "resources";
        const suggestedParam = `{${suggestResourceIdParam(lastSeg)}}`;
        const directPath = `${entry.normalizedPath === "/" ? "" : entry.normalizedPath}/${suggestedParam}`;
        const hoistedHint =
          hoistedCandidates.length > 0
            ? ` or a schema-compatible hoisted canonical route such as "GET ${formatSegments([...(hoistedCandidates[hoistedCandidates.length - 1] ?? []), suggestedParam])}"`
            : "";
        report(
          "collection-missing-item-get",
          entry.operationReportLocation("get"),
          `GET "${pathTemplate}" lists addressable resources with primary "id" but has no corresponding single-resource GET endpoint. Add "GET ${directPath}"${hoistedHint} (ADS-0005).`,
        );
      } else if (anyTruncated) {
        report(
          "collection-variant-cap-exceeded",
          entry.operationReportLocation("get"),
          `GET "${pathTemplate}" response schema exceeds the ${MAX_OBJECT_VARIANTS}-variant union analysis cap and could not be fully verified for single-resource GET read symmetry (ADS-0005).`,
        );
      }
    }
  },
);

export const ads0005StandardHttpMethods: RedoclyOas3Rule = createRootRule(
  ({ root, ctx, ignoreMatcher, reportOnce: report }) => {
    for (const pathEntry of iterateRootPathItems(root, ctx)) {
      const { pathTemplate, pathItem, pathUsageLocation } = pathEntry;

      // 1. No CRUD verbs in static URL path segments
      if (!ignoreMatcher.areAllPathOperationsIgnored(pathTemplate, pathItem)) {
        for (const segment of splitPathSegments(pathTemplate)) {
          const verb = findCrudVerbInPathSegment(segment);
          if (verb !== null) {
            report(
              `crud-verb:${segment}`,
              pathUsageLocation.key(),
              `Path "${pathTemplate}" embeds CRUD verb "${verb}" in segment "${segment}". Express CRUD operations with standard HTTP methods (GET, POST, PATCH, PUT, DELETE) on noun resource paths instead (ADS-0005).`,
            );
          }
        }
      }

      if (!pathItem) {
        continue;
      }

      // 2. No PUT + PATCH on the same path
      if (isRecord(pathItem.put) && isRecord(pathItem.patch)) {
        const ignored =
          ignoreMatcher.isIgnored({ path: pathTemplate }) ||
          ignoreMatcher.isIgnored({ path: pathTemplate, method: "put" }) ||
          ignoreMatcher.isIgnored({ path: pathTemplate, method: "patch" });
        if (!ignored) {
          report(
            "put-and-patch",
            pathUsageLocation.key(),
            `Path "${pathTemplate}" declares both PUT and PATCH. Choose PATCH for partial updates or PUT for full replacement/idempotent upsert, never both on the same endpoint (ADS-0005).`,
          );
        }
      }

      // 3. No GET with requestBody
      if (
        isRecord(pathItem.get) &&
        isRecord(pathItem.get.requestBody) &&
        !ignoreMatcher.isIgnored({ path: pathTemplate, method: "get" })
      ) {
        const loc = pathEntry.isOperationFromRef("get")
          ? pathUsageLocation.key()
          : pathEntry.operationLocation("get").child(["requestBody"]);
        report(
          "get-request-body",
          loc,
          `GET "${pathTemplate}" must not declare a requestBody. Pass read parameters in the query string or use a dedicated POST query endpoint (ADS-0005).`,
        );
      }

      // 4. No collection-level DELETE with requestBody
      if (
        !endsWithPathParam(pathTemplate) &&
        isRecord(pathItem.delete) &&
        isRecord(pathItem.delete.requestBody) &&
        !ignoreMatcher.isIgnored({ path: pathTemplate, method: "delete" })
      ) {
        const loc = pathEntry.isOperationFromRef("delete")
          ? pathUsageLocation.key()
          : pathEntry.operationLocation("delete").child(["requestBody"]);
        report(
          "collection-delete-request-body",
          loc,
          `DELETE "${pathTemplate}" must not declare a requestBody on a non-item path. Identify single-resource targets in the URL path, or use a dedicated POST batch endpoint for bulk deletions (ADS-0005).`,
        );
      }
    }
  },
);

export const ads0005StandardStatusCodes: RedoclyOas3Rule = createRootRule(
  ({ root, ctx, ignoreMatcher, reportOnce: report }) => {
    const { entries, byStructuralKey } = collectIndexedPaths(root, ctx);

    const statusReportLocation = (
      entry: IndexedPathEntry,
      method: string,
      statusCode: string,
    ): RedoclyLocation =>
      entry.isOperationFromRef(method)
        ? entry.pathUsageLocation.key()
        : entry.operationLocation(method).child(["responses", statusCode]).key();

    const checkDisallowedStatus = (
      entry: IndexedPathEntry,
      method: string,
      responses: UnknownRecord,
      statusCode: string,
      tag: string,
      message: string,
    ): void => {
      if (responses[statusCode] !== undefined) {
        report(tag, statusReportLocation(entry, method, statusCode), message);
      }
    };

    for (const entry of entries) {
      const { pathTemplate, segments, structuralKey, pathItem } = entry;
      const isItemPath = segments.length > 0 && isParamSegment(segments[segments.length - 1] ?? "");

      // 1. GET must not declare 201 or 202
      if (
        isRecord(pathItem.get) &&
        isRecord(pathItem.get.responses) &&
        !ignoreMatcher.isIgnored({ path: pathTemplate, method: "get" })
      ) {
        for (const badStatus of ["201", "202"] as const) {
          checkDisallowedStatus(
            entry,
            "get",
            pathItem.get.responses,
            badStatus,
            `get-bad-status:${badStatus}`,
            `GET "${pathTemplate}" must not declare "${badStatus}". Use "200" (and optional "304" for conditional reads) for GET responses (ADS-0005).`,
          );
        }
      }

      // 2. Collection resource creation POST must include 201 or 202
      if (
        !isItemPath &&
        isRecord(pathItem.post) &&
        isRecord(pathItem.post.responses) &&
        !ignoreMatcher.isIgnored({ path: pathTemplate, method: "post" })
      ) {
        const hasSamePathGet = hasAnyGetOnStructuralKey(byStructuralKey, structuralKey);
        const hasDirectItemRoute = hasAnyOperationOnStructuralKey(
          byStructuralKey,
          structuralPathKey([...segments, "{}"]),
        );
        const lastSegment = segments[segments.length - 1] ?? "";
        const isQueryOrActionSegment = QUERY_OR_ACTION_POST_SEGMENTS.has(lastSegment.toLowerCase());

        let isCollectionCreation = hasDirectItemRoute;
        if (!isCollectionCreation && hasSamePathGet) {
          const getInfo = getReturnsCollectionEnvelope(
            pathItem.get,
            entry.operationLocation("get"),
            ctx.resolve,
          );
          if (isQueryOrActionSegment) {
            if (
              getInfo.isAddressableCollection &&
              !getReturnsCollectionEnvelope(
                pathItem.post,
                entry.operationLocation("post"),
                ctx.resolve,
              ).isCollection
            ) {
              isCollectionCreation = true;
            }
          } else if (getInfo.isCollection) {
            isCollectionCreation = true;
          } else if (!getInfo.hasJsonSchema && looksLikePluralSubCollectionSegment(lastSegment)) {
            isCollectionCreation = true;
          } else if (
            operationReturnsAddressableResource(
              pathItem.post,
              entry.operationLocation("post"),
              ctx.resolve,
              ["200", "201", "2XX"],
            )
          ) {
            isCollectionCreation = true;
          }
        }

        if (isCollectionCreation) {
          const responses = pathItem.post.responses;
          const hasCreatedOrAccepted =
            responses["201"] !== undefined || responses["202"] !== undefined;

          if (!hasCreatedOrAccepted) {
            const declared2xx = Object.keys(responses).filter(
              (code) => EXACT_2XX_STATUS_RE.test(code) || code.toUpperCase() === "2XX",
            );
            const loc = entry.isOperationFromRef("post")
              ? entry.pathUsageLocation.key()
              : entry.operationLocation("post").child(["responses"]).key();
            const suffix =
              declared2xx.length > 0
                ? `, not only ${declared2xx.map((c) => `"${c}"`).join(", ")}`
                : "";
            report(
              "post-collection-missing-201-or-202",
              loc,
              `POST "${pathTemplate}" creates a resource in a collection and must declare "201" (synchronous creation) or "202" (asynchronous creation)${suffix} (ADS-0005).`,
            );
          }
        }
      }

      // 3. PATCH must not use 204, and PATCH 200 must declare response content
      if (
        isRecord(pathItem.patch) &&
        isRecord(pathItem.patch.responses) &&
        !ignoreMatcher.isIgnored({ path: pathTemplate, method: "patch" })
      ) {
        const responses = pathItem.patch.responses;
        checkDisallowedStatus(
          entry,
          "patch",
          responses,
          "204",
          "patch-204",
          `PATCH "${pathTemplate}" must not declare "204 No Content". Return "200" with the updated resource body (or "202" for asynchronous updates) (ADS-0005).`,
        );
        if (responses["200"] !== undefined) {
          const respLoc = entry.operationLocation("patch").child(["responses", "200"]);
          const inspected = inspectResponseContent(responses["200"], respLoc, ctx.resolve);
          if (inspected && !inspected.hasContent) {
            report(
              "patch-200-empty-body",
              statusReportLocation(entry, "patch", "200"),
              `PATCH "${pathTemplate}" declares "200" without a response "content" body. Partial updates must return the updated resource representation (ADS-0005).`,
            );
          }
        }
      }

      // 4. DELETE must not declare 201, and DELETE 204 must not declare response content
      if (
        isRecord(pathItem.delete) &&
        isRecord(pathItem.delete.responses) &&
        !ignoreMatcher.isIgnored({ path: pathTemplate, method: "delete" })
      ) {
        const responses = pathItem.delete.responses;
        checkDisallowedStatus(
          entry,
          "delete",
          responses,
          "201",
          "delete-201",
          `DELETE "${pathTemplate}" must not declare "201 Created". Use "204" without a body, "200" with a resource or receipt body, or "202" for asynchronous deletion (ADS-0005).`,
        );
        if (responses["204"] !== undefined) {
          const respLoc = entry.operationLocation("delete").child(["responses", "204"]);
          const inspected = inspectResponseContent(responses["204"], respLoc, ctx.resolve);
          if (inspected?.hasContent) {
            const loc =
              entry.isOperationFromRef("delete") || inspected.resolvedFromRef
                ? statusReportLocation(entry, "delete", "204")
                : inspected.location.child(["content"]).key();
            report(
              "delete-204-with-body",
              loc,
              `DELETE "${pathTemplate}" declares a response "content" body on "204 No Content". Remove the response body, or use "200" when returning a soft-deleted resource or receipt (ADS-0005).`,
            );
          }
        }
      }
    }
  },
);

export const ads0005UrlPathNaming: RedoclyOas3Rule = createRootRule(
  ({ root, ctx, ignoreMatcher, reportOnce: report }) => {
    for (const pathEntry of iterateRootPathItems(root, ctx)) {
      const { pathTemplate, pathItem, pathUsageLocation } = pathEntry;
      if (ignoreMatcher.areAllPathOperationsIgnored(pathTemplate, pathItem)) {
        continue;
      }
      for (const [index, segment] of splitPathSegments(pathTemplate).entries()) {
        if (!isValidKebabCasePathSegment(segment, index)) {
          report(
            `non-kebab-segment:${index}:${segment}`,
            pathUsageLocation.key(),
            `Path "${pathTemplate}" contains non-kebab-case static segment "${segment}". Static URL path segments must use lowercase kebab-case (for example "api-keys" or "agent-profile") (ADS-0005).`,
          );
        }
      }
    }
  },
);

export const ads0005Rules: Record<string, RedoclyOas3Rule> = {
  "ads-0005-addressable-resource-read": ads0005AddressableResourceRead,
  "ads-0005-standard-http-methods": ads0005StandardHttpMethods,
  "ads-0005-standard-status-codes": ads0005StandardStatusCodes,
  "ads-0005-url-path-naming": ads0005UrlPathNaming,
};
