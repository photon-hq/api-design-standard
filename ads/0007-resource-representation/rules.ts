import {
  extractPointerContext,
  isPointerContextIgnored,
  type RuleIgnoreMatcher,
} from "../../src/ignore.js";
import {
  createRootRule,
  extractOperationJsonResponseSchemas,
  extractRequestBodyMediaSchemas,
  type ResponseJsonSchemaEntry,
} from "../../src/openapi-utils.js";
import {
  areComponentRefsSame,
  COMPAT_VARIANT_OPTIONS,
  checkPatchObjectVariantConstraints,
  checkResponseCompatibleWithCanonical,
  checkVariantAgainstCanonicalVariants,
  collectActiveObjectVariants,
  collectIndexedPaths,
  effectiveFragmentsTypeSet,
  extractCollectionInfo,
  extractSingleComponentRef,
  findDirectChildGets,
  findGetsOnStructuralKey,
  findMatchingHoistedGets,
  type HoistedGetCandidate,
  type IndexedPathEntry,
  isCustomActionSubRoute,
  isParamSegment,
  isSchemaOrVariantIgnored,
  looksLikeOperationResourceVariant,
  QUERY_OR_ACTION_POST_SEGMENTS,
  SERVER_MANAGED_CREATE_KEYS,
  SERVER_MANAGED_MUTATION_KEYS,
  type VariantSubsetOptions,
  variantsOverlapForHoistedPairing,
} from "../../src/resource-compat.js";
import {
  ALL_JSON_TYPE_SET,
  formatTypeSummary,
  isRecord,
  isStrictlyNullConstraint,
  MAX_OBJECT_VARIANTS,
  type ResolverFn,
  selectPropertyReportLocation,
  type UnknownRecord,
  unescapeJsonPointerToken,
} from "../../src/schema-utils.js";
import {
  collectFlattenedObjectVariants,
  type FlattenedObjectVariant,
} from "../../src/schema-variants.js";
import type {
  AdsStandardMetadata,
  RedoclyLocation,
  RedoclyOas3Rule,
  RedoclyUserContext,
} from "../../src/types.js";
import { PLUGIN_ID } from "../0001-resource-identifiers/rules.js";

export const PHOTON_RESOURCE_EXTENSION = "x-photon-resource";

export const CANONICAL_RESOURCE_TYPE_RE = /^[a-z][a-z0-9-]*\.[a-z][a-z0-9-]*$/;

export const DERIVED_RESOURCE_ROLES = ["slice", "create", "patch", "replace"] as const;
export type DerivedResourceRole = (typeof DERIVED_RESOURCE_ROLES)[number];

const DERIVED_ROLE_SET = new Set<string>(DERIVED_RESOURCE_ROLES);
const ALLOWED_EXTENSION_KEYS = new Set<string>(["type", "role", "canonical", "nonResourceInputs"]);
const LOCAL_COMPONENT_SCHEMA_REF_RE = /^#\/components\/schemas\/([^/]+)$/;
const SKIP_WALK_KEYS = new Set<string>(["example", "examples", "externalDocs", "info", "servers"]);

export const ADS_0007_METADATA: AdsStandardMetadata = {
  ads: "0007",
  slug: "ads-0007",
  folder: "0007-resource-representation",
  rules: [
    {
      name: "ads-0007-response-representation-consistency",
      id: `${PLUGIN_ID}/ads-0007-response-representation-consistency`,
      severity: "error",
      summary:
        "PATCH 200, PUT 200/201, and synchronous collection POST 200/201 JSON responses must be structurally consistent with the resource's canonical single-resource GET 200 representation.",
    },
    {
      name: "ads-0007-collection-slice-subset",
      id: `${PLUGIN_ID}/ads-0007-collection-slice-subset`,
      severity: "error",
      summary:
        "Collection GET 200 list item schemas must be strict property and type subsets of their corresponding canonical single-resource GET 200 representation.",
    },
    {
      name: "ads-0007-mutation-input-symmetry",
      id: `${PLUGIN_ID}/ads-0007-mutation-input-symmetry`,
      severity: "error",
      summary:
        "PATCH, PUT, and collection POST request body properties overlapping with the canonical GET representation must use compatible types and must not accept server-managed or readOnly fields.",
    },
    {
      name: "ads-0007-resource-annotation-valid",
      id: `${PLUGIN_ID}/ads-0007-resource-annotation-valid`,
      severity: "error",
      summary:
        "Every x-photon-resource extension must declare either a globally unique canonical type (<domain>.<entity>) or a valid derived role (slice, create, patch, replace) referencing an existing canonical component schema, with nonResourceInputs restricted to valid create-only properties.",
    },
    {
      name: "ads-0007-derived-schema-compatibility",
      id: `${PLUGIN_ID}/ads-0007-derived-schema-compatibility`,
      severity: "error",
      summary:
        "Schemas declaring a derived x-photon-resource role (slice, create, patch, or replace) must strictly satisfy that role's field, type, readOnly, and merge-patch compatibility guarantees against their canonical resource schema.",
    },
  ],
};

export function isValidCanonicalResourceType(value: string): boolean {
  return CANONICAL_RESOURCE_TYPE_RE.test(value);
}

export function isValidDerivedResourceRole(value: string): value is DerivedResourceRole {
  return DERIVED_ROLE_SET.has(value);
}

interface CanonicalGetSchemaInfo {
  readonly pathTemplate: string;
  readonly schema: unknown;
  readonly schemaLocation: RedoclyLocation;
  readonly variants: readonly FlattenedObjectVariant[];
  readonly isOperation: boolean;
  readonly truncated: boolean;
}

function isOperationResponseVariants(variants: readonly FlattenedObjectVariant[]): boolean {
  const objVariants = variants.filter(
    (v) => v.typeConstraint.allowed.has("object") && !isStrictlyNullConstraint(v.typeConstraint),
  );
  return objVariants.length > 0 && objVariants.every((v) => looksLikeOperationResourceVariant(v));
}

function extractCanonicalGetSchemas(
  candidates: readonly HoistedGetCandidate[],
  resolve: ResolverFn,
): CanonicalGetSchemaInfo[] {
  const results: CanonicalGetSchemaInfo[] = [];
  for (const candidate of candidates) {
    const schemas = extractOperationJsonResponseSchemas(
      candidate.getOp,
      candidate.entry.operationLocation("get"),
      resolve,
      ["200", "2XX"],
    );
    for (const entry of schemas) {
      const collected = collectFlattenedObjectVariants(
        entry.schema,
        resolve,
        entry.schemaLocation,
        COMPAT_VARIANT_OPTIONS,
      );
      const nonNull = collected.variants.filter((v) => !isStrictlyNullConstraint(v.typeConstraint));
      results.push({
        pathTemplate: candidate.entry.pathTemplate,
        schema: entry.schema,
        schemaLocation: entry.schemaLocation,
        variants: nonNull,
        isOperation: isOperationResponseVariants(nonNull),
        truncated: collected.truncated,
      });
    }
  }
  return results;
}

function resolveCanonicalPointerFromSchema(
  schema: unknown,
  resolve: ResolverFn,
  from?: string,
): string | undefined {
  if (!isRecord(schema)) {
    return undefined;
  }
  const ext = schema[PHOTON_RESOURCE_EXTENSION];
  if (isRecord(ext) && typeof ext.canonical === "string") {
    return ext.canonical;
  }
  if (typeof schema.$ref === "string") {
    const resolved = resolve<UnknownRecord>({ $ref: schema.$ref }, from);
    if (resolved && !resolved.error && isRecord(resolved.node)) {
      const targetExt = resolved.node[PHOTON_RESOURCE_EXTENSION];
      if (isRecord(targetExt) && typeof targetExt.canonical === "string") {
        return targetExt.canonical;
      }
    }
  }
  return undefined;
}

function schemaPairsWithCanonicalGet(
  sourceSchema: unknown,
  sourceLocation: RedoclyLocation | undefined,
  sourceVariants: readonly FlattenedObjectVariant[],
  canon: CanonicalGetSchemaInfo,
  resolve: ResolverFn,
): boolean {
  const sourceFrom = sourceLocation?.source?.absoluteRef;
  const srcRef = extractSingleComponentRef(sourceSchema, resolve, sourceFrom);
  const canonRef = extractSingleComponentRef(
    canon.schema,
    resolve,
    canon.schemaLocation.source?.absoluteRef,
  );
  if (areComponentRefsSame(srcRef, canonRef)) {
    return true;
  }
  const declaredCanonicalPtr = resolveCanonicalPointerFromSchema(sourceSchema, resolve, sourceFrom);
  if (
    declaredCanonicalPtr &&
    canonRef &&
    declaredCanonicalPtr === `#/components/schemas/${canonRef.name}`
  ) {
    return true;
  }
  return variantsOverlapForHoistedPairing(sourceVariants, canon.variants, resolve);
}

function isNonCollectionPostRoute(
  entry: IndexedPathEntry,
  entries: readonly IndexedPathEntry[],
  byStructuralKey: ReadonlyMap<string, readonly IndexedPathEntry[]>,
  resolve: ResolverFn,
): boolean {
  const lastSegment = entry.segments[entry.segments.length - 1] ?? "";
  if (QUERY_OR_ACTION_POST_SEGMENTS.has(lastSegment.toLowerCase())) {
    return true;
  }
  return isCustomActionSubRoute(entry, entries, byStructuralKey, resolve);
}

function resolveHoistedCanonicalsViaCollectionGet(
  entry: IndexedPathEntry,
  hoistedCanonicals: readonly CanonicalGetSchemaInfo[],
  resolve: ResolverFn,
): CanonicalGetSchemaInfo[] {
  if (!isRecord(entry.pathItem.get) || hoistedCanonicals.length === 0) {
    return [];
  }
  const getSchemas = extractOperationJsonResponseSchemas(
    entry.pathItem.get,
    entry.operationLocation("get"),
    resolve,
    ["200", "2XX"],
  );
  const matched = new Set<CanonicalGetSchemaInfo>();
  for (const gs of getSchemas) {
    const collected = collectFlattenedObjectVariants(
      gs.schema,
      resolve,
      gs.schemaLocation,
      COMPAT_VARIANT_OPTIONS,
    );
    for (const variant of collected.variants) {
      const info = extractCollectionInfo(variant, resolve, {
        requireScalarId: false,
        allowNonObjectMetadata: false,
        variantOptions: COMPAT_VARIANT_OPTIONS,
      });
      if (!info) {
        continue;
      }
      const firstFrag = info.itemBranches[0]?.[0];
      for (const canon of hoistedCanonicals) {
        if (
          schemaPairsWithCanonicalGet(
            firstFrag?.node,
            firstFrag?.location,
            info.itemVariants,
            canon,
            resolve,
          )
        ) {
          matched.add(canon);
        }
      }
    }
  }
  return [...matched];
}

function resolveCollectionCanonicalGets(
  entry: IndexedPathEntry,
  byStructuralKey: ReadonlyMap<string, readonly IndexedPathEntry[]>,
  resolve: ResolverFn,
): {
  readonly isDirect: boolean;
  readonly canonicals: readonly CanonicalGetSchemaInfo[];
  readonly pairedHoisted: readonly CanonicalGetSchemaInfo[];
} {
  const directGets = findDirectChildGets(byStructuralKey, entry.segments);
  if (directGets.length > 0) {
    const canonicals = extractCanonicalGetSchemas(directGets, resolve);
    return { isDirect: true, canonicals, pairedHoisted: canonicals };
  }
  const hoistedGets = findMatchingHoistedGets(byStructuralKey, entry.segments);
  const canonicals = extractCanonicalGetSchemas(hoistedGets, resolve);
  const pairedHoisted = resolveHoistedCanonicalsViaCollectionGet(entry, canonicals, resolve);
  return { isDirect: false, canonicals, pairedHoisted };
}

function resolveSameOrHoistedItemGets(
  entry: IndexedPathEntry,
  isItemPath: boolean,
  byStructuralKey: ReadonlyMap<string, readonly IndexedPathEntry[]>,
  resolve: ResolverFn,
): {
  readonly isDirect: boolean;
  readonly canonicals: readonly CanonicalGetSchemaInfo[];
} {
  const directGets = findGetsOnStructuralKey(byStructuralKey, entry.structuralKey);
  if (directGets.length > 0) {
    return { isDirect: true, canonicals: extractCanonicalGetSchemas(directGets, resolve) };
  }
  if (!isItemPath) {
    return { isDirect: false, canonicals: [] };
  }
  const hoistedGets = findMatchingHoistedGets(byStructuralKey, entry.segments.slice(0, -1));
  return { isDirect: false, canonicals: extractCanonicalGetSchemas(hoistedGets, resolve) };
}

function responseReportLocation(
  entry: IndexedPathEntry,
  method: string,
  resp: ResponseJsonSchemaEntry,
): RedoclyLocation {
  return entry.isOperationFromRef(method) || resp.responseFromRef
    ? entry.operationReportLocation(method)
    : resp.schemaLocation;
}

function findBestCanonicalVariantFailure(
  variant: FlattenedObjectVariant,
  canonicals: readonly CanonicalGetSchemaInfo[],
  resolve: ResolverFn,
  options: VariantSubsetOptions,
): {
  readonly canonPath: string;
  readonly mismatches: readonly { readonly path: string; readonly reason: string }[];
} | null {
  let bestFailure: {
    readonly canonPath: string;
    readonly mismatches: readonly { readonly path: string; readonly reason: string }[];
  } | null = null;

  for (const canon of canonicals) {
    const mismatches = checkVariantAgainstCanonicalVariants(
      variant,
      canon.variants,
      resolve,
      options,
    );
    if (mismatches.length === 0) {
      return null;
    }
    if (!bestFailure || mismatches.length < bestFailure.mismatches.length) {
      bestFailure = { canonPath: canon.pathTemplate, mismatches };
    }
  }
  return bestFailure;
}

function pairCanonicalsByOperationResponses(
  op: UnknownRecord,
  opLoc: RedoclyLocation,
  statusCodes: readonly string[],
  canonicals: readonly CanonicalGetSchemaInfo[],
  resolve: ResolverFn,
): CanonicalGetSchemaInfo[] {
  const respSchemas = extractOperationJsonResponseSchemas(op, opLoc, resolve, statusCodes);
  if (respSchemas.length === 0) {
    return [];
  }
  return canonicals.filter((canon) =>
    respSchemas.some((rs) => {
      const rv = collectFlattenedObjectVariants(
        rs.schema,
        resolve,
        rs.schemaLocation,
        COMPAT_VARIANT_OPTIONS,
      ).variants.filter((v) => !isStrictlyNullConstraint(v.typeConstraint));
      return schemaPairsWithCanonicalGet(rs.schema, rs.schemaLocation, rv, canon, resolve);
    }),
  );
}

function forEachMutationRoute(
  entries: readonly IndexedPathEntry[],
  byStructuralKey: ReadonlyMap<string, readonly IndexedPathEntry[]>,
  resolve: ResolverFn,
  ignoreMatcher: RuleIgnoreMatcher,
  handlers: {
    readonly onItemMutation: (
      entry: IndexedPathEntry,
      method: "patch" | "put",
      op: UnknownRecord,
      itemGetInfo: {
        readonly isDirect: boolean;
        readonly canonicals: readonly CanonicalGetSchemaInfo[];
      },
    ) => void;
    readonly onCollectionPost: (
      entry: IndexedPathEntry,
      postOp: UnknownRecord,
      colGets: {
        readonly isDirect: boolean;
        readonly canonicals: readonly CanonicalGetSchemaInfo[];
        readonly pairedHoisted: readonly CanonicalGetSchemaInfo[];
      },
    ) => void;
  },
): void {
  for (const entry of entries) {
    const { pathTemplate, segments, pathItem } = entry;
    const isItemPath = segments.length > 0 && isParamSegment(segments[segments.length - 1] ?? "");

    const itemGetInfo = resolveSameOrHoistedItemGets(entry, isItemPath, byStructuralKey, resolve);
    if (itemGetInfo.canonicals.length > 0) {
      for (const method of ["patch", "put"] as const) {
        const op = pathItem[method];
        if (!isRecord(op) || ignoreMatcher.isIgnored({ path: pathTemplate, method })) {
          continue;
        }
        handlers.onItemMutation(entry, method, op, itemGetInfo);
      }
    }

    if (
      !isItemPath &&
      isRecord(pathItem.post) &&
      !ignoreMatcher.isIgnored({ path: pathTemplate, method: "post" }) &&
      !isNonCollectionPostRoute(entry, entries, byStructuralKey, resolve)
    ) {
      const colGets = resolveCollectionCanonicalGets(entry, byStructuralKey, resolve);
      if (colGets.canonicals.length > 0) {
        handlers.onCollectionPost(entry, pathItem.post, colGets);
      }
    }
  }
}

export const ads0007ResponseRepresentationConsistency: RedoclyOas3Rule = createRootRule(
  ({ root, ctx, ignoreMatcher, reportOnce: report }) => {
    const { entries, byStructuralKey } = collectIndexedPaths(root, ctx);

    const checkResponsesAgainstCanonicals = (
      entry: IndexedPathEntry,
      method: "patch" | "put" | "post",
      responses: readonly ResponseJsonSchemaEntry[],
      canonicals: readonly CanonicalGetSchemaInfo[],
      isDirect: boolean,
      allowHoistedPairingFilter: boolean,
    ): void => {
      for (const resp of responses) {
        const statusCode = resp.statusCode ?? "200";
        const reportLoc = responseReportLocation(entry, method, resp);
        const topRef = extractSingleComponentRef(
          resp.schema,
          ctx.resolve,
          resp.schemaLocation.source?.absoluteRef,
        );
        if (
          topRef &&
          ignoreMatcher.isIgnored({ path: entry.pathTemplate, method, schema: topRef.name })
        ) {
          continue;
        }

        const respCollected = collectFlattenedObjectVariants(
          resp.schema,
          ctx.resolve,
          resp.schemaLocation,
          COMPAT_VARIANT_OPTIONS,
        );
        const respNonNull = respCollected.variants.filter(
          (v) => !isStrictlyNullConstraint(v.typeConstraint),
        );
        if (respNonNull.length === 0) {
          continue;
        }
        if (
          respNonNull.every((v) =>
            isSchemaOrVariantIgnored(ignoreMatcher, entry.pathTemplate, method, v, topRef?.name),
          )
        ) {
          continue;
        }

        const respIsOp = isOperationResponseVariants(respNonNull);
        const activeCanonicals = canonicals.filter((c) => !(respIsOp && !c.isOperation));
        if (activeCanonicals.length === 0) {
          continue;
        }

        const targetCanonicals =
          isDirect || !allowHoistedPairingFilter
            ? activeCanonicals
            : activeCanonicals.filter((c) =>
                schemaPairsWithCanonicalGet(
                  resp.schema,
                  resp.schemaLocation,
                  respNonNull,
                  c,
                  ctx.resolve,
                ),
              );
        if (targetCanonicals.length === 0) {
          continue;
        }

        const isCreation = method === "post" || (method === "put" && statusCode === "201");
        let matchedAny = false;
        let bestFailure: {
          canonPath: string;
          mismatches: readonly { path: string; reason: string }[];
        } | null = null;

        for (const canon of targetCanonicals) {
          const result = checkResponseCompatibleWithCanonical(
            resp.schema,
            resp.schemaLocation,
            canon.schema,
            canon.schemaLocation,
            ctx.resolve,
            {
              allowCreationSecret: isCreation,
              allowCreationReceiptEnvelope: isCreation,
            },
          );
          if (result.mismatches.length === 0) {
            matchedAny = true;
            break;
          }
          if (!bestFailure || result.mismatches.length < bestFailure.mismatches.length) {
            bestFailure = { canonPath: canon.pathTemplate, mismatches: result.mismatches };
          }
        }

        if (!matchedAny && bestFailure) {
          const first = bestFailure.mismatches[0];
          if (first) {
            const detail =
              first.path === "(root)" ? first.reason : `property "${first.path}" ${first.reason}`;
            report(
              `resp-inconsistent:${method}:${statusCode}:${first.path}`,
              reportLoc,
              `${method.toUpperCase()} "${entry.pathTemplate}" (${statusCode} ${resp.mediaType}) response representation is inconsistent with canonical GET "${bestFailure.canonPath}": ${detail} (ADS-0007).`,
            );
          }
        }
      }
    };

    forEachMutationRoute(entries, byStructuralKey, ctx.resolve, ignoreMatcher, {
      onItemMutation(entry, method, op, itemGetInfo) {
        const statusCodes = method === "patch" ? ["200", "2XX"] : ["200", "201", "2XX"];
        const responses = extractOperationJsonResponseSchemas(
          op,
          entry.operationLocation(method),
          ctx.resolve,
          statusCodes,
          { firstMatchingOnly: false },
        );
        checkResponsesAgainstCanonicals(
          entry,
          method,
          responses,
          itemGetInfo.canonicals,
          itemGetInfo.isDirect,
          !itemGetInfo.isDirect,
        );
      },
      onCollectionPost(entry, postOp, colGets) {
        const responses = extractOperationJsonResponseSchemas(
          postOp,
          entry.operationLocation("post"),
          ctx.resolve,
          ["201", "200"],
          { firstMatchingOnly: false },
        );
        if (responses.length === 0) {
          return;
        }
        const hasPairedHoisted = !colGets.isDirect && colGets.pairedHoisted.length > 0;
        checkResponsesAgainstCanonicals(
          entry,
          "post",
          responses,
          hasPairedHoisted ? colGets.pairedHoisted : colGets.canonicals,
          colGets.isDirect || hasPairedHoisted,
          !colGets.isDirect && !hasPairedHoisted,
        );
      },
    });
  },
);

export const ads0007CollectionSliceSubset: RedoclyOas3Rule = createRootRule(
  ({ root, ctx, ignoreMatcher, reportOnce: report }) => {
    const { entries, byStructuralKey } = collectIndexedPaths(root, ctx);

    for (const entry of entries) {
      const { pathTemplate, segments, pathItem } = entry;
      const isItemPath = segments.length > 0 && isParamSegment(segments[segments.length - 1] ?? "");
      if (isItemPath || !isRecord(pathItem.get)) {
        continue;
      }
      if (ignoreMatcher.isIgnored({ path: pathTemplate, method: "get" })) {
        continue;
      }

      const colGets = resolveCollectionCanonicalGets(entry, byStructuralKey, ctx.resolve);
      if (colGets.canonicals.length === 0) {
        continue;
      }

      const getSchemas = extractOperationJsonResponseSchemas(
        pathItem.get,
        entry.operationLocation("get"),
        ctx.resolve,
        ["200", "2XX"],
      );

      for (const gs of getSchemas) {
        const reportLoc = responseReportLocation(entry, "get", gs);
        const topRef = extractSingleComponentRef(
          gs.schema,
          ctx.resolve,
          gs.schemaLocation.source?.absoluteRef,
        );
        if (
          topRef &&
          ignoreMatcher.isIgnored({ path: pathTemplate, method: "get", schema: topRef.name })
        ) {
          continue;
        }

        const collected = collectFlattenedObjectVariants(
          gs.schema,
          ctx.resolve,
          gs.schemaLocation,
          COMPAT_VARIANT_OPTIONS,
        );
        for (const variant of collected.variants) {
          if (isSchemaOrVariantIgnored(ignoreMatcher, pathTemplate, "get", variant, topRef?.name)) {
            continue;
          }
          const info = extractCollectionInfo(variant, ctx.resolve, {
            requireScalarId: false,
            allowNonObjectMetadata: colGets.isDirect,
            variantOptions: COMPAT_VARIANT_OPTIONS,
          });
          if (!info) {
            continue;
          }

          const firstFrag = info.itemBranches[0]?.[0];
          const targetCanonicals = colGets.isDirect
            ? colGets.canonicals
            : colGets.canonicals.filter((canon) =>
                schemaPairsWithCanonicalGet(
                  firstFrag?.node,
                  firstFrag?.location,
                  info.itemVariants,
                  canon,
                  ctx.resolve,
                ),
              );
          if (targetCanonicals.length === 0) {
            continue;
          }

          // Fast path: single identical component schema ref
          if (info.itemBranches.length === 1 && info.itemBranches[0]?.length === 1 && firstFrag) {
            const itemRef = extractSingleComponentRef(firstFrag.node, ctx.resolve, firstFrag.from);
            if (
              itemRef &&
              targetCanonicals.some((canon) =>
                areComponentRefsSame(
                  itemRef,
                  extractSingleComponentRef(
                    canon.schema,
                    ctx.resolve,
                    canon.schemaLocation.source?.absoluteRef,
                  ),
                ),
              )
            ) {
              continue;
            }
          }

          for (const itemVariant of info.itemVariants) {
            if (isSchemaOrVariantIgnored(ignoreMatcher, pathTemplate, "get", itemVariant)) {
              continue;
            }

            const bestFailure = findBestCanonicalVariantFailure(
              itemVariant,
              targetCanonicals,
              ctx.resolve,
              { forbidReadOnly: false },
            );

            if (bestFailure) {
              for (const mismatch of bestFailure.mismatches) {
                const detail =
                  mismatch.path === "(root)"
                    ? mismatch.reason
                    : `property "${mismatch.path}" ${mismatch.reason}`;
                report(
                  `slice-mismatch:${info.arrayPropertyName}:${mismatch.path}`,
                  reportLoc,
                  `GET "${pathTemplate}" collection item in "${info.arrayPropertyName}" is not a strict subset of canonical GET "${bestFailure.canonPath}": ${detail} (ADS-0007).`,
                );
              }
            }
          }
        }
      }
    }
  },
);

export const ads0007MutationInputSymmetry: RedoclyOas3Rule = createRootRule(
  ({ root, ctx, ignoreMatcher, reportOnce: report }) => {
    const { entries, byStructuralKey } = collectIndexedPaths(root, ctx);

    const checkRequestBodyAgainstCanonicals = (
      entry: IndexedPathEntry,
      method: "patch" | "put" | "post",
      op: UnknownRecord,
      canonicals: readonly CanonicalGetSchemaInfo[],
      serverManagedKeys: ReadonlySet<string>,
    ): void => {
      if (canonicals.length === 0) {
        return;
      }
      const opLoc = entry.operationLocation(method);
      const opFromRef = entry.isOperationFromRef(method);
      const mediaEntries = extractRequestBodyMediaSchemas(op, opLoc, ctx.resolve);

      for (const mediaEntry of mediaEntries) {
        if (!mediaEntry.isJson || mediaEntry.schema === undefined) {
          continue;
        }
        const reportBaseLoc =
          opFromRef || mediaEntry.requestBodyFromRef
            ? entry.operationReportLocation(method)
            : mediaEntry.schemaLocation;
        const topRef = extractSingleComponentRef(
          mediaEntry.schema,
          ctx.resolve,
          mediaEntry.schemaLocation.source?.absoluteRef,
        );
        if (
          topRef &&
          ignoreMatcher.isIgnored({ path: entry.pathTemplate, method, schema: topRef.name })
        ) {
          continue;
        }

        const activeVariants = collectActiveObjectVariants(
          mediaEntry.schema,
          mediaEntry.schemaLocation,
          entry.pathTemplate,
          method,
          ctx.resolve,
          ignoreMatcher,
          topRef?.name,
          COMPAT_VARIANT_OPTIONS,
        ).variants;
        for (const variant of activeVariants) {
          const bestFailure = findBestCanonicalVariantFailure(variant, canonicals, ctx.resolve, {
            onlyOverlapping: true,
            forbidReadOnly: true,
            serverManagedKeys,
          });

          if (bestFailure) {
            for (const mismatch of bestFailure.mismatches) {
              const topKey = mismatch.path.split(/[.[]/)[0] ?? "";
              const prop = topKey ? variant.properties.get(topKey) : undefined;
              const loc = selectPropertyReportLocation(
                prop,
                mediaEntry.schemaLocation,
                reportBaseLoc,
              );
              report(
                `mutation-input:${method}:${mismatch.path}`,
                loc,
                `${method.toUpperCase()} "${entry.pathTemplate}" request property "${mismatch.path}" ${mismatch.reason} (canonical: GET "${bestFailure.canonPath}") (ADS-0007).`,
              );
            }
          }
        }
      }
    };

    forEachMutationRoute(entries, byStructuralKey, ctx.resolve, ignoreMatcher, {
      onItemMutation(entry, method, op, itemGetInfo) {
        const targetCanonicals = itemGetInfo.isDirect
          ? itemGetInfo.canonicals
          : pairCanonicalsByOperationResponses(
              op,
              entry.operationLocation(method),
              ["200", "201", "2XX"],
              itemGetInfo.canonicals,
              ctx.resolve,
            );
        checkRequestBodyAgainstCanonicals(
          entry,
          method,
          op,
          targetCanonicals,
          SERVER_MANAGED_MUTATION_KEYS,
        );
      },
      onCollectionPost(entry, postOp, colGets) {
        let postCanonicals = colGets.isDirect ? colGets.canonicals : colGets.pairedHoisted;
        if (!colGets.isDirect && postCanonicals.length === 0) {
          postCanonicals = pairCanonicalsByOperationResponses(
            postOp,
            entry.operationLocation("post"),
            ["201", "200"],
            colGets.canonicals,
            ctx.resolve,
          );
        }
        checkRequestBodyAgainstCanonicals(
          entry,
          "post",
          postOp,
          postCanonicals,
          SERVER_MANAGED_CREATE_KEYS,
        );
      },
    });
  },
);

interface DiscoveredResourceAnnotation {
  readonly schemaNode: UnknownRecord;
  readonly schemaLocation: RedoclyLocation;
  readonly extValue: unknown;
  readonly extLocation: RedoclyLocation;
  readonly componentSchemaName?: string;
  readonly label: string;
}

function collectResourceAnnotations(
  root: UnknownRecord,
  ctx: RedoclyUserContext,
): DiscoveredResourceAnnotation[] {
  const discovered: DiscoveredResourceAnnotation[] = [];
  const visited = new Set<object>();

  const walk = (node: unknown, loc: RedoclyLocation, componentSchemaName?: string): void => {
    if (Array.isArray(node)) {
      if (visited.has(node)) {
        return;
      }
      visited.add(node);
      for (const [index, item] of node.entries()) {
        walk(item, loc.child([index]));
      }
      return;
    }

    if (!isRecord(node) || visited.has(node)) {
      return;
    }
    visited.add(node);

    if (Object.hasOwn(node, PHOTON_RESOURCE_EXTENSION)) {
      const label = componentSchemaName
        ? `Component schema "${componentSchemaName}"`
        : `Schema at "${loc.pointer}"`;
      discovered.push({
        schemaNode: node,
        schemaLocation: loc,
        extValue: node[PHOTON_RESOURCE_EXTENSION],
        extLocation: loc.child([PHOTON_RESOURCE_EXTENSION]),
        ...(componentSchemaName !== undefined ? { componentSchemaName } : {}),
        label,
      });
    }

    for (const [key, value] of Object.entries(node)) {
      if (key === PHOTON_RESOURCE_EXTENSION || SKIP_WALK_KEYS.has(key)) {
        continue;
      }
      walk(value, loc.child([key]));
    }
  };

  // Walk components.schemas first with explicit component names in deterministic order.
  if (isRecord(root.components) && isRecord(root.components.schemas)) {
    const schemasLoc = ctx.location.child(["components", "schemas"]);
    for (const [name, schema] of Object.entries(root.components.schemas)) {
      walk(schema, schemasLoc.child([name]), name);
    }
  }

  for (const [key, value] of Object.entries(root)) {
    if (SKIP_WALK_KEYS.has(key)) {
      continue;
    }
    walk(value, ctx.location.child([key]));
  }

  return discovered;
}

function lookupLocalComponentSchema(
  root: UnknownRecord,
  pointer: string,
): { readonly name: string; readonly node: UnknownRecord } | null {
  const match = LOCAL_COMPONENT_SCHEMA_REF_RE.exec(pointer);
  if (!match?.[1] || !isRecord(root.components) || !isRecord(root.components.schemas)) {
    return null;
  }
  const schemas = root.components.schemas;
  const rawName = unescapeJsonPointerToken(match[1]);
  if (Object.hasOwn(schemas, rawName) && isRecord(schemas[rawName])) {
    return { name: rawName, node: schemas[rawName] };
  }
  try {
    const decoded = unescapeJsonPointerToken(decodeURIComponent(match[1]));
    if (Object.hasOwn(schemas, decoded) && isRecord(schemas[decoded])) {
      return { name: decoded, node: schemas[decoded] };
    }
  } catch {
    // Malformed percent encoding; treat as unresolved.
  }
  return null;
}

function isValidCanonicalExtensionObject(ext: unknown): ext is { readonly type: string } {
  if (!isRecord(ext)) {
    return false;
  }
  const keys = Object.keys(ext);
  return (
    keys.length === 1 &&
    keys[0] === "type" &&
    typeof ext.type === "string" &&
    isValidCanonicalResourceType(ext.type)
  );
}

interface ParsedDerivedResource {
  readonly entry: DiscoveredResourceAnnotation;
  readonly role: DerivedResourceRole;
  readonly canonicalName: string;
  readonly canonicalNode: UnknownRecord;
  readonly canonicalLocation: RedoclyLocation;
  readonly nonResourceInputs: readonly string[];
}

function analyzeResourceAnnotations(
  root: UnknownRecord,
  ctx: RedoclyUserContext,
  ignoreMatcher: RuleIgnoreMatcher,
  reportAnnotationError?: (dedupeTag: string, location: RedoclyLocation, message: string) => void,
): ParsedDerivedResource[] {
  const discovered = collectResourceAnnotations(root, ctx);
  const seenCanonicalTypes = new Map<string, DiscoveredResourceAnnotation>();
  const validDerived: ParsedDerivedResource[] = [];

  for (const entry of discovered) {
    const pointerCtx = extractPointerContext(entry.schemaLocation.pointer);
    const isIgnored = isPointerContextIgnored(ignoreMatcher, pointerCtx);
    const emit = (tag: string, loc: RedoclyLocation, message: string): void => {
      if (!isIgnored && reportAnnotationError) {
        reportAnnotationError(tag, loc, message);
      }
    };

    const { extValue, extLocation, label } = entry;
    if (!isRecord(extValue)) {
      emit(
        "ext-not-object",
        extLocation,
        `${label} declares an invalid "${PHOTON_RESOURCE_EXTENSION}" value. Expected an object with either "{ type }" (canonical) or "{ role, canonical }" (derived) (ADS-0007).`,
      );
      continue;
    }

    const keys = Object.keys(extValue);
    const unknownKeys = keys.filter((k) => !ALLOWED_EXTENSION_KEYS.has(k));
    if (unknownKeys.length > 0) {
      const formatted = unknownKeys.map((k) => `"${k}"`).join(", ");
      emit(
        `ext-unknown-keys:${unknownKeys.join(",")}`,
        extLocation,
        `${label} "${PHOTON_RESOURCE_EXTENSION}" contains unsupported keys (${formatted}). Allowed keys are "type" (canonical) or "role", "canonical", and optional "nonResourceInputs" (derived) (ADS-0007).`,
      );
    }

    const hasType = Object.hasOwn(extValue, "type");
    const hasDerivedKey =
      Object.hasOwn(extValue, "role") ||
      Object.hasOwn(extValue, "canonical") ||
      Object.hasOwn(extValue, "nonResourceInputs");

    if (hasType && hasDerivedKey) {
      emit(
        "ext-mixed-form",
        extLocation,
        `${label} "${PHOTON_RESOURCE_EXTENSION}" cannot combine canonical "type" with derived keys ("role", "canonical", "nonResourceInputs") (ADS-0007).`,
      );
      continue;
    }

    if (!hasType && !hasDerivedKey) {
      emit(
        "ext-empty",
        extLocation,
        `${label} "${PHOTON_RESOURCE_EXTENSION}" must declare either canonical "type" or derived "role" and "canonical" (ADS-0007).`,
      );
      continue;
    }

    // Canonical form
    if (hasType) {
      const rawType = extValue.type;
      if (typeof rawType !== "string" || !isValidCanonicalResourceType(rawType)) {
        emit(
          "canonical-type-format",
          extLocation.child(["type"]),
          `${label} "${PHOTON_RESOURCE_EXTENSION}.type" must match "<domain>.<entity>" in lowercase kebab-case (pattern "^[a-z][a-z0-9-]*\\.[a-z][a-z0-9-]*$"), found ${JSON.stringify(rawType)} (ADS-0007).`,
        );
        continue;
      }

      const existing = seenCanonicalTypes.get(rawType);
      if (existing && existing.schemaNode !== entry.schemaNode) {
        emit(
          `canonical-type-duplicate:${rawType}`,
          extLocation.child(["type"]),
          `${label} declares duplicate canonical "${PHOTON_RESOURCE_EXTENSION}.type" "${rawType}", already declared by ${existing.label} (ADS-0007).`,
        );
      } else if (!existing) {
        seenCanonicalTypes.set(rawType, entry);
      }
      continue;
    }

    // Derived form
    let derivedHeaderValid = true;
    const rawRole = extValue.role;
    let role: DerivedResourceRole | null = null;
    if (typeof rawRole !== "string" || !isValidDerivedResourceRole(rawRole)) {
      derivedHeaderValid = false;
      emit(
        "derived-role-invalid",
        extLocation.child(["role"]),
        `${label} "${PHOTON_RESOURCE_EXTENSION}.role" must be one of "slice", "create", "patch", or "replace", found ${JSON.stringify(rawRole)} (ADS-0007).`,
      );
    } else {
      role = rawRole;
    }

    const rawCanonical = extValue.canonical;
    let canonicalTarget: { readonly name: string; readonly node: UnknownRecord } | null = null;
    if (typeof rawCanonical !== "string" || !LOCAL_COMPONENT_SCHEMA_REF_RE.test(rawCanonical)) {
      derivedHeaderValid = false;
      emit(
        "derived-canonical-format",
        extLocation.child(["canonical"]),
        `${label} "${PHOTON_RESOURCE_EXTENSION}.canonical" must be a local component schema pointer "#/components/schemas/<SchemaName>", found ${JSON.stringify(rawCanonical)} (ADS-0007).`,
      );
    } else {
      const found = lookupLocalComponentSchema(root, rawCanonical);
      if (!found) {
        derivedHeaderValid = false;
        emit(
          "derived-canonical-dangling",
          extLocation.child(["canonical"]),
          `${label} "${PHOTON_RESOURCE_EXTENSION}.canonical" points to "${rawCanonical}", which does not exist under components.schemas (ADS-0007).`,
        );
      } else if (found.node === entry.schemaNode) {
        derivedHeaderValid = false;
        emit(
          "derived-canonical-self",
          extLocation.child(["canonical"]),
          `${label} "${PHOTON_RESOURCE_EXTENSION}.canonical" must not reference itself (ADS-0007).`,
        );
      } else if (!isValidCanonicalExtensionObject(found.node[PHOTON_RESOURCE_EXTENSION])) {
        derivedHeaderValid = false;
        emit(
          "derived-canonical-not-canonical",
          extLocation.child(["canonical"]),
          `${label} "${PHOTON_RESOURCE_EXTENSION}.canonical" references "${found.name}", which must itself declare canonical "${PHOTON_RESOURCE_EXTENSION}: { type }" (ADS-0007).`,
        );
      } else {
        canonicalTarget = found;
      }
    }

    const nonResourceInputs: string[] = [];
    if (extValue.nonResourceInputs !== undefined) {
      const nriLoc = extLocation.child(["nonResourceInputs"]);
      if (role !== null && role !== "create") {
        emit(
          "non-resource-inputs-wrong-role",
          nriLoc,
          `${label} declares "${PHOTON_RESOURCE_EXTENSION}.nonResourceInputs" on role "${role}". "nonResourceInputs" is allowed only on role "create" (ADS-0007).`,
        );
      } else if (
        !Array.isArray(extValue.nonResourceInputs) ||
        extValue.nonResourceInputs.length === 0
      ) {
        emit(
          "non-resource-inputs-empty",
          nriLoc,
          `${label} "${PHOTON_RESOURCE_EXTENSION}.nonResourceInputs" must be a non-empty array of unique property names (ADS-0007).`,
        );
      } else {
        const seenInputs = new Set<string>();
        for (const item of extValue.nonResourceInputs) {
          if (typeof item !== "string" || item.trim().length === 0) {
            emit(
              "non-resource-inputs-item-type",
              nriLoc,
              `${label} "${PHOTON_RESOURCE_EXTENSION}.nonResourceInputs" must contain only non-empty property name strings (ADS-0007).`,
            );
            continue;
          }
          if (seenInputs.has(item)) {
            emit(
              `non-resource-inputs-duplicate:${item}`,
              nriLoc,
              `${label} "${PHOTON_RESOURCE_EXTENSION}.nonResourceInputs" contains duplicate property name "${item}" (ADS-0007).`,
            );
            continue;
          }
          seenInputs.add(item);
          nonResourceInputs.push(item);
        }
      }
    }

    if (derivedHeaderValid && role !== null && canonicalTarget !== null) {
      const canonicalLocation = ctx.location.child(["components", "schemas", canonicalTarget.name]);

      // Validate that each declared nonResourceInput exists on D and does NOT already exist on C.
      if (
        role === "create" &&
        nonResourceInputs.length > 0 &&
        reportAnnotationError &&
        !isIgnored
      ) {
        const dVariants = collectFlattenedObjectVariants(
          entry.schemaNode,
          ctx.resolve,
          entry.schemaLocation,
          COMPAT_VARIANT_OPTIONS,
        ).variants.filter((v) => v.typeConstraint.allowed.has("object"));
        const cVariants = collectFlattenedObjectVariants(
          canonicalTarget.node,
          ctx.resolve,
          canonicalLocation,
          COMPAT_VARIANT_OPTIONS,
        ).variants.filter((v) => v.typeConstraint.allowed.has("object"));

        for (const inputName of nonResourceInputs) {
          if (!dVariants.some((dv) => dv.properties.has(inputName))) {
            emit(
              `non-resource-input-missing:${inputName}`,
              extLocation.child(["nonResourceInputs"]),
              `${label} lists "${inputName}" in "${PHOTON_RESOURCE_EXTENSION}.nonResourceInputs", but "${inputName}" is not a declared property on ${label} (ADS-0007).`,
            );
          }
          if (cVariants.some((cv) => cv.properties.has(inputName))) {
            emit(
              `non-resource-input-on-canonical:${inputName}`,
              extLocation.child(["nonResourceInputs"]),
              `${label} lists "${inputName}" in "${PHOTON_RESOURCE_EXTENSION}.nonResourceInputs", but "${inputName}" already exists on canonical schema "${canonicalTarget.name}" (ADS-0007).`,
            );
          }
        }
      }

      if (unknownKeys.length === 0) {
        validDerived.push({
          entry,
          role,
          canonicalName: canonicalTarget.name,
          canonicalNode: canonicalTarget.node,
          canonicalLocation,
          nonResourceInputs,
        });
      }
    }
  }

  return validDerived;
}

export const ads0007ResourceAnnotationValid: RedoclyOas3Rule = createRootRule(
  ({ root, ctx, ignoreMatcher, reportOnce: report }) => {
    analyzeResourceAnnotations(root, ctx, ignoreMatcher, report);
  },
  { requirePaths: false },
);

export const ads0007DerivedSchemaCompatibility: RedoclyOas3Rule = createRootRule(
  ({ root, ctx, ignoreMatcher, reportOnce: report }) => {
    const derivedList = analyzeResourceAnnotations(root, ctx, ignoreMatcher);

    for (const item of derivedList) {
      const { entry, role, canonicalName, canonicalNode, canonicalLocation, nonResourceInputs } =
        item;
      const pointerCtx = extractPointerContext(entry.schemaLocation.pointer);
      if (isPointerContextIgnored(ignoreMatcher, pointerCtx)) {
        continue;
      }

      const topTypes = effectiveFragmentsTypeSet(
        [
          {
            node: entry.schemaNode,
            ...(entry.schemaLocation.source?.absoluteRef !== undefined
              ? { from: entry.schemaLocation.source.absoluteRef }
              : {}),
            location: entry.schemaLocation,
          },
        ],
        ctx.resolve,
      );
      const nonObjectNonNull = [...topTypes].filter((t) => t !== "object" && t !== "null");
      if (topTypes.size < ALL_JSON_TYPE_SET.size && nonObjectNonNull.length > 0) {
        report(
          `derived-non-object:${role}`,
          entry.schemaLocation,
          `${entry.label} declares "${PHOTON_RESOURCE_EXTENSION}.role" "${role}" but allows non-object type "${formatTypeSummary(topTypes)}" (ADS-0007).`,
        );
        continue;
      }

      const dCollected = collectFlattenedObjectVariants(
        entry.schemaNode,
        ctx.resolve,
        entry.schemaLocation,
        COMPAT_VARIANT_OPTIONS,
      );
      const cCollected = collectFlattenedObjectVariants(
        canonicalNode,
        ctx.resolve,
        canonicalLocation,
        COMPAT_VARIANT_OPTIONS,
      );

      if (dCollected.truncated || cCollected.truncated) {
        report(
          `derived-variant-cap-exceeded:${role}`,
          entry.schemaLocation,
          `${entry.label} or canonical schema "${canonicalName}" exceeds the ${MAX_OBJECT_VARIANTS}-variant union analysis cap and could not be fully verified for "${role}" compatibility (ADS-0007).`,
        );
      }

      const dObjVariants = dCollected.variants.filter(
        (v) =>
          v.typeConstraint.allowed.has("object") && !isStrictlyNullConstraint(v.typeConstraint),
      );
      const cObjVariants = cCollected.variants.filter(
        (v) =>
          v.typeConstraint.allowed.has("object") && !isStrictlyNullConstraint(v.typeConstraint),
      );

      if (dObjVariants.length === 0) {
        report(
          `derived-no-object-variant:${role}`,
          entry.schemaLocation,
          `${entry.label} declares "${PHOTON_RESOURCE_EXTENSION}.role" "${role}" but resolves to no concrete object variant (ADS-0007).`,
        );
        continue;
      }
      if (cObjVariants.length === 0) {
        continue;
      }

      const nonResourceSet = role === "create" ? new Set<string>(nonResourceInputs) : undefined;
      const forbidReadOnly = role !== "slice";
      const serverManagedKeys =
        role === "create"
          ? SERVER_MANAGED_CREATE_KEYS
          : role === "patch" || role === "replace"
            ? SERVER_MANAGED_MUTATION_KEYS
            : undefined;

      for (const dv of dObjVariants) {
        const mismatches = checkVariantAgainstCanonicalVariants(dv, cObjVariants, ctx.resolve, {
          ...(nonResourceSet ? { excludedKeys: nonResourceSet } : {}),
          forbidReadOnly,
          ...(serverManagedKeys ? { serverManagedKeys } : {}),
        });

        for (const mismatch of mismatches) {
          const topKey = mismatch.path.split(/[.[]/)[0] ?? "";
          const prop = topKey ? dv.properties.get(topKey) : undefined;
          const loc = selectPropertyReportLocation(
            prop,
            entry.schemaLocation,
            entry.schemaLocation,
          );
          const extraHint =
            role === "create" && mismatch.reason === "does not exist on the canonical schema"
              ? ` (declare it in "${PHOTON_RESOURCE_EXTENSION}.nonResourceInputs" if it is an intentional non-resource creation input)`
              : "";
          const detail =
            mismatch.path === "(root)"
              ? mismatch.reason
              : `property "${mismatch.path}" ${mismatch.reason}`;
          report(
            `derived-compat:${role}:${mismatch.path}`,
            loc,
            `${entry.label} (role "${role}", canonical "${canonicalName}"): ${detail}${extraHint} (ADS-0007).`,
          );
        }

        if (role === "patch") {
          for (const violation of checkPatchObjectVariantConstraints(dv)) {
            if (violation.kind === "required" && violation.disallowedRequired) {
              const formatted = violation.disallowedRequired.map((name) => `"${name}"`).join(", ");
              report(
                `derived-patch-required:${formatted}`,
                entry.schemaLocation,
                `${entry.label} (role "patch", canonical "${canonicalName}") declares required top-level properties (${formatted}). Patch schemas must make mutable fields optional per RFC 7396 (ADS-0007).`,
              );
            } else if (violation.kind === "additional-properties") {
              report(
                "derived-patch-additional-properties",
                entry.schemaLocation,
                `${entry.label} (role "patch", canonical "${canonicalName}") declares properties without forbidding unknown fields. Set "additionalProperties: false" (or "unevaluatedProperties: false") (ADS-0007).`,
              );
            }
          }
        }
      }
    }
  },
  { requirePaths: false },
);

export const ads0007Rules: Record<string, RedoclyOas3Rule> = {
  "ads-0007-response-representation-consistency": ads0007ResponseRepresentationConsistency,
  "ads-0007-collection-slice-subset": ads0007CollectionSliceSubset,
  "ads-0007-mutation-input-symmetry": ads0007MutationInputSymmetry,
  "ads-0007-resource-annotation-valid": ads0007ResourceAnnotationValid,
  "ads-0007-derived-schema-compatibility": ads0007DerivedSchemaCompatibility,
};
