import {
  createRootRule,
  EXACT_2XX_STATUS_RE,
  extractOperationJsonResponseSchemas,
  extractRequestBodyMediaSchemas,
  inspectResponseContent,
  iterateRootPathItems,
  resolveOperationParameters,
} from "../../src/openapi-utils.js";
import {
  type AddressableCollectionInfo,
  type ArrayItemBranch,
  areSchemasCompatibleForHoistedGet,
  COMPAT_VARIANT_OPTIONS,
  checkPatchObjectVariantConstraints,
  collectActiveObjectVariants,
  collectIndexedPaths,
  collectNestedOpenPatchObjectPaths,
  computeHoistedCollectionCandidates,
  endsWithPathParam,
  extractAddressableCollection,
  extractSingleComponentRef,
  findMatchingHoistedGets,
  formatSegments,
  getReturnsCollectionEnvelope,
  type HoistedGetCandidate,
  hasAnyGetOnStructuralKey,
  hasAnyOperationOnStructuralKey,
  type IndexedPathEntry,
  isAddressableResourceVariant,
  isCustomActionSubRoute,
  isParamSegment,
  looksLikeOperationResourceVariant,
  looksLikePluralSubCollectionSegment,
  normalizePathTemplate,
  operationReturnsAddressableResource,
  QUERY_OR_ACTION_POST_SEGMENTS,
  splitPathSegments,
  structuralPathKey,
  suggestResourceIdParam,
  wordSet,
} from "../../src/resource-compat.js";
import {
  ALL_JSON_TYPE_SET,
  computeTypeConstraint,
  formatTypeSummary,
  isRecord,
  isStrictlyNullConstraint,
  MAX_OBJECT_VARIANTS,
  type ResolverFn,
  selectPropertyReportLocation,
  type UnknownRecord,
} from "../../src/schema-utils.js";
import {
  collectFlattenedObjectVariants,
  type FlattenedObjectVariant,
} from "../../src/schema-variants.js";
import type { AdsStandardMetadata, RedoclyLocation, RedoclyOas3Rule } from "../../src/types.js";
import { PLUGIN_ID } from "../0001-resource-identifiers/rules.js";

export {
  computeHoistedCollectionCandidates,
  endsWithPathParam,
  looksLikePluralSubCollectionSegment,
  normalizePathTemplate,
  splitPathSegments,
  suggestResourceIdParam,
};

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
        "Endpoints must use standard HTTP method semantics without CRUD verbs in URL segments, without combining PUT and PATCH on the same path, without GET request bodies, without collection-level DELETE request bodies, and without non-deprecated Idempotency-Key headers or state-mutating terminal action verbs on GET or HEAD.",
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
    {
      name: "ads-0005-patch-merge-semantics",
      id: `${PLUGIN_ID}/ads-0005-patch-merge-semantics`,
      severity: "error",
      summary:
        "PATCH operations must use RFC 7396 JSON Merge Patch over JSON without RFC 6902 patch arrays, field/update mask parameters or properties, top-level required properties (outside explicit union discriminators), or open undeclared properties.",
    },
  ],
};

const CUSTOM_METHOD_PARAM_SEGMENT_RE = /^\{([^}]+)\}:(.+)$/;
const LEADING_VERSION_SEGMENT_RE = /^v[0-9]+$/;
const KEBAB_CASE_SEGMENT_RE = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;
const JSON_PATCH_MEDIA_TYPE_RE = /^application\/json-patch\+json(?:\s*;|$)/i;

const CRUD_VERB_EXACT_RE = /^(create|get|list|update|delete|remove|fetch|edit|add)$/i;
const CRUD_VERB_DELIMITED_RE = /^(create|get|list|update|delete|remove|fetch|edit|add)[-_]/i;
const CRUD_VERB_CAMEL_RE =
  /^(create|get|list|update|delete|remove|fetch|edit|add|Create|Get|List|Update|Delete|Remove|Fetch|Edit|Add)(?=[A-Z])/;

const SAFE_HTTP_METHODS = ["get", "head"] as const;

const SAFE_METHOD_DISALLOWED_ACTION_SEGMENTS = wordSet(`
  revoke cancel rotate retry resend archive restore enable disable transfer-ownership
  pay purchase approve reject confirm submit trigger publish unpublish suspend
  unsuspend activate deactivate refund void reset purge invalidate disconnect unlink
  install uninstall deploy rollback pause resume verify
`);

const BANNED_PATCH_MASK_NAMES = wordSet(`
  fieldmask updatemask field_mask update_mask fieldsmask fields_mask
`);

export function isBannedPatchMaskName(name: string): boolean {
  return BANNED_PATCH_MASK_NAMES.has(name.toLowerCase());
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

export function findMutatingTerminalActionSegment(pathTemplate: string): string | null {
  const segments = splitPathSegments(pathTemplate);
  const last = segments[segments.length - 1];
  if (!last || isParamSegment(last) || last === ".well-known") {
    return null;
  }
  if (findCrudVerbInPathSegment(last) !== null) {
    return null;
  }
  const customMatch = CUSTOM_METHOD_PARAM_SEGMENT_RE.exec(last);
  const target = (customMatch?.[2] ?? last).toLowerCase();
  return SAFE_METHOD_DISALLOWED_ACTION_SEGMENTS.has(target) ? target : null;
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

function isOperationSatisfiedByHoistedGets(
  op: UnknownRecord,
  opLoc: RedoclyLocation,
  hoistedGets: readonly HoistedGetCandidate[],
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

    for (const entry of entries) {
      const { pathTemplate, segments, structuralKey, pathItem } = entry;
      const isItemPath = segments.length > 0 && isParamSegment(segments[segments.length - 1] ?? "");

      // Part A1: Item paths with PATCH, PUT, or DELETE
      if (isItemPath) {
        const parentSegments = segments.slice(0, -1);
        const itemParam = segments[segments.length - 1] ?? "{resourceId}";
        const hasDirectGet = hasAnyGetOnStructuralKey(byStructuralKey, structuralKey);
        const hoistedCandidates = computeHoistedCollectionCandidates(parentSegments);
        const hoistedGets = findMatchingHoistedGets(byStructuralKey, parentSegments);

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
        isCustomActionSubRoute(entry, entries, byStructuralKey, ctx.resolve) &&
        isRecord(pathItem.post) &&
        !ignoreMatcher.isIgnored({ path: pathTemplate, method: "post" })
      ) {
        const postOp = pathItem.post;
        const postLoc = entry.operationLocation("post");
        const parentItemSegments = segments.slice(0, -1);
        const parentItemKey = structuralPathKey(parentItemSegments);
        const parentCollectionSegments = parentItemSegments.slice(0, -1);
        const parentItemParam = parentItemSegments[parentItemSegments.length - 1] ?? "{resourceId}";
        const hasParentGet = hasAnyGetOnStructuralKey(byStructuralKey, parentItemKey);
        const hoistedCandidates = computeHoistedCollectionCandidates(parentCollectionSegments);
        const hoistedGets = findMatchingHoistedGets(byStructuralKey, parentCollectionSegments);
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
      const hoistedGets = findMatchingHoistedGets(byStructuralKey, segments);

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

      // 5 & 6. Safe RFC 9110 GET/HEAD checks: no Idempotency-Key header, no mutating terminal action verb
      const mutatingAction = findMutatingTerminalActionSegment(pathTemplate);
      for (const method of SAFE_HTTP_METHODS) {
        const op = pathItem[method];
        if (!isRecord(op) || ignoreMatcher.isIgnored({ path: pathTemplate, method })) {
          continue;
        }
        const upperMethod = method.toUpperCase();

        // 5. No non-deprecated Idempotency-Key header parameter on GET/HEAD
        for (const param of resolveOperationParameters(pathEntry, method, ctx.resolve)) {
          if (
            param.in === "header" &&
            !param.deprecated &&
            param.name.toLowerCase() === "idempotency-key"
          ) {
            report(
              `safe-method-idempotency-key:${method}`,
              param.reportLocation,
              `${upperMethod} "${pathTemplate}" must not declare a non-deprecated "${param.name}" header parameter. ${upperMethod} operations must be safe and side-effect-free per RFC 9110; use POST, PUT, PATCH, or DELETE for state-changing operations that require idempotency keys (ADS-0005).`,
            );
          }
        }

        // 6. No unmistakable state-mutating terminal action verb on GET/HEAD
        if (mutatingAction !== null) {
          report(
            `safe-method-mutating-action:${method}:${mutatingAction}`,
            pathEntry.operationReportLocation(method),
            `${upperMethod} "${pathTemplate}" uses state-mutating action segment "${mutatingAction}". ${upperMethod} operations must be safe and read-only per RFC 9110; expose state-changing actions with POST instead (ADS-0005).`,
          );
        }
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

export const ads0005PatchMergeSemantics: RedoclyOas3Rule = createRootRule(
  ({ root, ctx, ignoreMatcher, reportOnce: report }) => {
    for (const pathEntry of iterateRootPathItems(root, ctx)) {
      const { pathTemplate, pathItem } = pathEntry;
      if (!pathItem || !isRecord(pathItem.patch)) {
        continue;
      }
      if (ignoreMatcher.isIgnored({ path: pathTemplate, method: "patch" })) {
        continue;
      }

      // 2a. Reject fieldMask / updateMask query parameters on PATCH (no deprecation exemption)
      for (const param of resolveOperationParameters(pathEntry, "patch", ctx.resolve)) {
        if (param.in === "query" && isBannedPatchMaskName(param.name)) {
          report(
            `patch-query-mask:${param.name.toLowerCase()}`,
            param.reportLocation,
            `PATCH "${pathTemplate}" must not declare query parameter "${param.name}". Partial updates must use RFC 7396 JSON Merge Patch semantics without field masks (ADS-0005).`,
          );
        }
      }

      const patchOp = pathItem.patch;
      const patchLoc = pathEntry.operationLocation("patch");
      const opFromRef = pathEntry.isOperationFromRef("patch");
      const mediaEntries = extractRequestBodyMediaSchemas(patchOp, patchLoc, ctx.resolve);
      let hasCompatibleJsonBody = false;
      let reportedJsonPatchMedia = false;

      for (const mediaEntry of mediaEntries) {
        const useOpLocation = opFromRef || mediaEntry.requestBodyFromRef;
        const mediaReportLoc = useOpLocation
          ? pathEntry.operationReportLocation("patch")
          : mediaEntry.mediaTypeLocation.key();
        const schemaReportLoc = useOpLocation
          ? pathEntry.operationReportLocation("patch")
          : mediaEntry.schemaLocation;

        const topLevelRef =
          mediaEntry.schema !== undefined
            ? extractSingleComponentRef(
                mediaEntry.schema,
                ctx.resolve,
                mediaEntry.schemaLocation.source?.absoluteRef,
              )
            : null;
        if (
          topLevelRef &&
          ignoreMatcher.isIgnored({ path: pathTemplate, method: "patch", schema: topLevelRef.name })
        ) {
          if (mediaEntry.isJson && !JSON_PATCH_MEDIA_TYPE_RE.test(mediaEntry.mediaType)) {
            hasCompatibleJsonBody = true;
          }
          continue;
        }

        // 1a. Reject RFC 6902 application/json-patch+json media type
        if (JSON_PATCH_MEDIA_TYPE_RE.test(mediaEntry.mediaType)) {
          reportedJsonPatchMedia = true;
          report(
            `patch-json-patch-media-type:${mediaEntry.mediaType.toLowerCase()}`,
            mediaReportLoc,
            `PATCH "${pathTemplate}" uses "${mediaEntry.mediaType}" (RFC 6902 JSON Patch). Partial updates must use RFC 7396 JSON Merge Patch over "application/json" instead (ADS-0005).`,
          );
          continue;
        }

        if (!mediaEntry.isJson || mediaEntry.schema === undefined) {
          continue;
        }
        hasCompatibleJsonBody = true;

        // 1b. Reject unrestricted and non-object top-level JSON schemas (arrays, scalars, null, {} / true)
        const topTypes = computeTypeConstraint(
          mediaEntry.schema,
          ctx.resolve,
          mediaEntry.schemaLocation.source?.absoluteRef,
        ).allowed;
        if (topTypes.size === ALL_JSON_TYPE_SET.size) {
          report(
            `patch-top-level-unrestricted:${mediaEntry.mediaType}`,
            schemaReportLoc,
            `PATCH "${pathTemplate}" (${mediaEntry.mediaType}) request schema does not restrict the top-level payload to a JSON object. Declare "type: object" for JSON Merge Patch bodies (ADS-0005).`,
          );
        } else {
          if (topTypes.has("array")) {
            report(
              `patch-top-level-array:${mediaEntry.mediaType}`,
              schemaReportLoc,
              `PATCH "${pathTemplate}" (${mediaEntry.mediaType}) accepts a top-level JSON array. Partial updates must use a JSON Merge Patch object (RFC 7396) rather than a patch-operation array (ADS-0005).`,
            );
          }
          const nonObjectScalars = [...topTypes].filter((t) => t !== "object" && t !== "array");
          if (nonObjectScalars.length > 0) {
            report(
              `patch-top-level-non-object:${mediaEntry.mediaType}`,
              schemaReportLoc,
              `PATCH "${pathTemplate}" (${mediaEntry.mediaType}) allows non-object top-level type "${formatTypeSummary(new Set(nonObjectScalars))}". Partial updates must accept a JSON object body (ADS-0005).`,
            );
          }
        }

        const collected = collectActiveObjectVariants(
          mediaEntry.schema,
          mediaEntry.schemaLocation,
          pathTemplate,
          "patch",
          ctx.resolve,
          ignoreMatcher,
          topLevelRef?.name,
          COMPAT_VARIANT_OPTIONS,
        );

        let nestedTruncated = false;
        for (const variant of collected.variants) {
          // 2b. Reject fieldMask / updateMask top-level body properties (no deprecation exemption)
          for (const [propName, prop] of variant.properties.entries()) {
            if (isBannedPatchMaskName(propName)) {
              const propLoc = selectPropertyReportLocation(
                prop,
                mediaEntry.schemaLocation,
                schemaReportLoc,
              );
              report(
                `patch-body-mask:${propName.toLowerCase()}`,
                propLoc,
                `PATCH "${pathTemplate}" (${mediaEntry.mediaType}) must not declare top-level mask property "${propName}". Partial updates must use RFC 7396 JSON Merge Patch semantics without field masks (ADS-0005).`,
              );
            }
          }

          // 3 & 4. No top-level required properties (outside explicit union discriminator) and forbid unknown properties
          for (const violation of checkPatchObjectVariantConstraints(variant)) {
            if (violation.kind === "required" && violation.disallowedRequired) {
              const formatted = violation.disallowedRequired.map((name) => `"${name}"`).join(", ");
              report(
                `patch-required:${formatted}`,
                schemaReportLoc,
                `PATCH "${pathTemplate}" (${mediaEntry.mediaType}) request schema declares required top-level properties (${formatted}). RFC 7396 JSON Merge Patch bodies must make mutable fields optional so callers can update any subset (ADS-0005).`,
              );
            } else if (violation.kind === "additional-properties") {
              report(
                `patch-open-additional-properties:${mediaEntry.mediaType}`,
                schemaReportLoc,
                `PATCH "${pathTemplate}" (${mediaEntry.mediaType}) request schema does not forbid unknown fields. Set "additionalProperties: false" (or "unevaluatedProperties: false" on composed schemas) so unknown properties are rejected (ADS-0005).`,
              );
            }
          }

          // 4b. Check closure recursively on fixed-schema nested objects merged under RFC 7396
          const nestedOpen = collectNestedOpenPatchObjectPaths(variant, ctx.resolve);
          if (nestedOpen.truncated) {
            nestedTruncated = true;
          }
          for (const nestedPath of nestedOpen.openPaths) {
            const topKey = nestedPath.split(".")[0] ?? "";
            const prop = topKey ? variant.properties.get(topKey) : undefined;
            const nestedLoc = selectPropertyReportLocation(
              prop,
              mediaEntry.schemaLocation,
              schemaReportLoc,
            );
            report(
              `patch-nested-open-additional-properties:${mediaEntry.mediaType}:${nestedPath}`,
              nestedLoc,
              `PATCH "${pathTemplate}" (${mediaEntry.mediaType}) nested object "${nestedPath}" does not forbid unknown fields. Set "additionalProperties: false" (or "unevaluatedProperties: false" on composed schemas) on recursively merged objects (ADS-0005).`,
            );
          }
        }

        if (collected.truncated || nestedTruncated) {
          report(
            `patch-variant-cap-exceeded:${mediaEntry.mediaType}`,
            schemaReportLoc,
            `PATCH "${pathTemplate}" (${mediaEntry.mediaType}) request schema exceeds the ${MAX_OBJECT_VARIANTS}-variant union analysis cap and could not be fully verified for RFC 7396 JSON Merge Patch semantics (ADS-0005).`,
          );
        }
      }

      if (!hasCompatibleJsonBody && !reportedJsonPatchMedia) {
        report(
          "patch-missing-json-body",
          pathEntry.operationReportLocation("patch"),
          `PATCH "${pathTemplate}" must declare a JSON request body ("application/json") using JSON Merge Patch semantics (ADS-0005).`,
        );
      }
    }
  },
);

export const ads0005Rules: Record<string, RedoclyOas3Rule> = {
  "ads-0005-addressable-resource-read": ads0005AddressableResourceRead,
  "ads-0005-standard-http-methods": ads0005StandardHttpMethods,
  "ads-0005-standard-status-codes": ads0005StandardStatusCodes,
  "ads-0005-url-path-naming": ads0005UrlPathNaming,
  "ads-0005-patch-merge-semantics": ads0005PatchMergeSemantics,
};
