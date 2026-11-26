import { createRuleIgnoreMatcher, HTTP_METHODS } from "../../src/ignore.js";
import {
  isRecord,
  locationKey,
  type ResolverFn,
  resolveRecordWithLocation,
  safeResolveSchema,
  type UnknownRecord,
  walkSchemaLattice,
} from "../../src/schema-utils.js";
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
const JSON_MEDIA_TYPE_RE = /^application\/(?!problem\+json(?:\s*;|$))(?:[^;]+\+)?json(?:\s*;|$)/i;
const COMPONENT_SCHEMA_REF_RE = /#\/components\/schemas\/([^/]+)$/;
const EXACT_2XX_STATUS_RE = /^2\d\d$/;

const CRUD_VERB_EXACT_RE = /^(create|get|list|update|delete|remove|fetch|edit|add)$/i;
const CRUD_VERB_DELIMITED_RE = /^(create|get|list|update|delete|remove|fetch|edit|add)[-_]/i;
const CRUD_VERB_CAMEL_RE =
  /^(create|get|list|update|delete|remove|fetch|edit|add|Create|Get|List|Update|Delete|Remove|Fetch|Edit|Add)(?=[A-Z])/;

const COLLECTION_METADATA_KEYS = new Set([
  "nextPageToken",
  "prevPageToken",
  "previousPageToken",
  "pageToken",
  "cursor",
  "nextCursor",
  "prevCursor",
  "previousCursor",
  "hasMore",
  "hasNextPage",
  "hasPreviousPage",
  "totalCount",
  "total",
  "totalItems",
  "totalPages",
  "count",
  "limit",
  "offset",
  "pageSize",
  "perPage",
  "page",
  "pageInfo",
  "pagination",
  "meta",
]);

const NON_PLURAL_S_WORDS = new Set([
  "as",
  "alias",
  "bias",
  "bus",
  "canvas",
  "cors",
  "dns",
  "gas",
  "ios",
  "is",
  "os",
  "plus",
  "sms",
  "this",
  "tls",
  "yes",
]);

const ACTION_VERB_PREFIXES = new Set([
  "abort",
  "accept",
  "acknowledge",
  "activate",
  "approve",
  "archive",
  "assign",
  "attach",
  "authorize",
  "bind",
  "cancel",
  "check",
  "claim",
  "clear",
  "clone",
  "close",
  "commit",
  "complete",
  "confirm",
  "deactivate",
  "deauthorize",
  "decline",
  "deploy",
  "detach",
  "disable",
  "disconnect",
  "dismiss",
  "duplicate",
  "enable",
  "escalate",
  "expire",
  "export",
  "extend",
  "finalize",
  "fork",
  "import",
  "invite",
  "leave",
  "link",
  "lock",
  "mark",
  "merge",
  "migrate",
  "mute",
  "pause",
  "pin",
  "preview",
  "promote",
  "publish",
  "purge",
  "reconnect",
  "redeem",
  "refresh",
  "refund",
  "reissue",
  "reject",
  "release",
  "renew",
  "reopen",
  "replay",
  "reprocess",
  "resend",
  "reset",
  "resolve",
  "restart",
  "restore",
  "resume",
  "retry",
  "revoke",
  "rollback",
  "rotate",
  "send",
  "set",
  "share",
  "sign",
  "split",
  "start",
  "stop",
  "submit",
  "subscribe",
  "suspend",
  "sync",
  "terminate",
  "test",
  "transfer",
  "trigger",
  "unarchive",
  "unassign",
  "unbind",
  "undeploy",
  "unlink",
  "unlock",
  "unmute",
  "unpin",
  "unpublish",
  "unshare",
  "unsubscribe",
  "unsuspend",
  "validate",
  "verify",
  "void",
]);

const MAX_OBJECT_VARIANTS = 256;

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

const ALL_JSON_TYPE_SET: ReadonlySet<JsonSchemaType> = new Set(ALL_JSON_TYPES);
const EMPTY_TYPE_SET: ReadonlySet<JsonSchemaType> = new Set();
const SCALAR_ID_TYPES: ReadonlySet<JsonSchemaType> = new Set(["string", "integer", "number"]);

export function normalizePathTemplate(pathTemplate: string): string {
  const trimmed = pathTemplate.trim().replace(/\/+$/, "");
  return trimmed.length === 0 ? "/" : trimmed;
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

function structuralPathKey(segments: readonly string[]): string {
  if (segments.length === 0) {
    return "/";
  }
  return `/${segments.map((segment) => (isParamSegment(segment) ? "{}" : segment)).join("/")}`;
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

function isJsonSchemaType(value: unknown): value is JsonSchemaType {
  return typeof value === "string" && ALL_JSON_TYPE_SET.has(value as JsonSchemaType);
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

interface TypeConstraint {
  readonly allowed: ReadonlySet<JsonSchemaType>;
}

const UNCONSTRAINED_TYPE_CONSTRAINT: TypeConstraint = {
  allowed: ALL_JSON_TYPE_SET,
};

const FALSE_TYPE_CONSTRAINT: TypeConstraint = {
  allowed: EMPTY_TYPE_SET,
};

function intersectTypeSets(
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

function combineTypeConstraintAllOf(a: TypeConstraint, b: TypeConstraint): TypeConstraint {
  return { allowed: intersectTypeSets(a.allowed, b.allowed) };
}

function combineTypeConstraintUnion(values: readonly TypeConstraint[]): TypeConstraint {
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

function localTypeConstraint(node: UnknownRecord): TypeConstraint {
  let result = UNCONSTRAINED_TYPE_CONSTRAINT;

  if (typeof node.type === "string" && isJsonSchemaType(node.type)) {
    const types = new Set<JsonSchemaType>([node.type]);
    if (node.nullable === true) {
      types.add("null");
    }
    result = combineTypeConstraintAllOf(result, { allowed: types });
  } else if (Array.isArray(node.type)) {
    const validTypes = node.type.filter(isJsonSchemaType);
    if (validTypes.length > 0) {
      const types = new Set<JsonSchemaType>(validTypes);
      if (node.nullable === true) {
        types.add("null");
      }
      result = combineTypeConstraintAllOf(result, { allowed: types });
    }
  }

  if (node.const !== undefined) {
    const constType = jsonTypeOfValue(node.const);
    if (constType !== null) {
      result = combineTypeConstraintAllOf(result, { allowed: new Set([constType]) });
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
      result = combineTypeConstraintAllOf(result, { allowed: enumTypes });
    }
  }

  return result;
}

function finalizeTypeConstraint(node: UnknownRecord, value: TypeConstraint): TypeConstraint {
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

function computeTypeConstraint(
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

function isStrictlyNullConstraint(tc: TypeConstraint): boolean {
  return tc.allowed.size === 1 && tc.allowed.has("null");
}

function isScalarIdTypeConstraint(tc: TypeConstraint): boolean {
  if (tc.allowed.size === 0) {
    return false;
  }
  let hasScalarId = false;
  for (const t of tc.allowed) {
    if (t === "object" || t === "array" || t === "boolean") {
      return false;
    }
    if (SCALAR_ID_TYPES.has(t)) {
      hasScalarId = true;
    }
  }
  return hasScalarId;
}

interface SchemaFragment {
  readonly node: unknown;
  readonly from?: string;
  readonly location?: RedoclyLocation;
}

interface TrackedProperty {
  readonly name: string;
  readonly fragments: readonly SchemaFragment[];
  readonly location?: RedoclyLocation;
}

interface FlattenedObjectVariant {
  readonly typeConstraint: TypeConstraint;
  readonly isObjectLike: boolean;
  readonly hasSchemaAdditionalProperties: boolean;
  readonly properties: ReadonlyMap<string, TrackedProperty>;
  readonly required: ReadonlySet<string>;
}

const EMPTY_SEED_VARIANT: FlattenedObjectVariant = {
  typeConstraint: UNCONSTRAINED_TYPE_CONSTRAINT,
  isObjectLike: false,
  hasSchemaAdditionalProperties: false,
  properties: new Map(),
  required: new Set(),
};

const schemaObjectIds = new WeakMap<object, number>();
let nextSchemaObjectId = 1;

function schemaNodeIdentity(node: unknown): string {
  if (typeof node === "object" && node !== null) {
    let id = schemaObjectIds.get(node);
    if (id === undefined) {
      id = nextSchemaObjectId;
      nextSchemaObjectId += 1;
      schemaObjectIds.set(node, id);
    }
    return `#${id}`;
  }
  return String(node);
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

function propertyTypeConstraint(prop: TrackedProperty, resolve: ResolverFn): TypeConstraint {
  let combined = UNCONSTRAINED_TYPE_CONSTRAINT;
  for (const frag of prop.fragments) {
    combined = combineTypeConstraintAllOf(
      combined,
      computeTypeConstraint(frag.node, resolve, frag.from),
    );
  }
  return combined;
}

function mergeVariants(
  base: FlattenedObjectVariant,
  addition: FlattenedObjectVariant,
): FlattenedObjectVariant | null {
  const typeConstraint = combineTypeConstraintAllOf(base.typeConstraint, addition.typeConstraint);
  if (typeConstraint.allowed.size === 0) {
    return null;
  }
  const properties = new Map<string, TrackedProperty>(base.properties);
  for (const [name, prop] of addition.properties.entries()) {
    properties.set(name, mergeTrackedProperty(properties.get(name), prop));
  }
  const required = new Set<string>(base.required);
  for (const req of addition.required) {
    required.add(req);
  }
  return {
    typeConstraint,
    isObjectLike: base.isObjectLike || addition.isObjectLike,
    hasSchemaAdditionalProperties:
      base.hasSchemaAdditionalProperties || addition.hasSchemaAdditionalProperties,
    properties,
    required,
  };
}

function variantSignature(variant: FlattenedObjectVariant, resolve: ResolverFn): string {
  const types = ALL_JSON_TYPES.filter((t) => variant.typeConstraint.allowed.has(t)).join(",");
  const propKeys = [...variant.properties.keys()]
    .sort()
    .map((key) => {
      const prop = variant.properties.get(key);
      const tc = prop ? propertyTypeConstraint(prop, resolve) : UNCONSTRAINED_TYPE_CONSTRAINT;
      const pTypes = ALL_JSON_TYPES.filter((t) => tc.allowed.has(t)).join(",");
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

function dedupeVariants(
  list: readonly FlattenedObjectVariant[],
  resolve: ResolverFn,
): FlattenedObjectVariant[] {
  const seen = new Map<string, FlattenedObjectVariant>();
  for (const variant of list) {
    const sig = variantSignature(variant, resolve);
    if (!seen.has(sig)) {
      seen.set(sig, variant);
    }
  }
  return [...seen.values()];
}

function combineVariantSets(
  baseSet: readonly FlattenedObjectVariant[],
  additionSet: readonly FlattenedObjectVariant[],
  resolve: ResolverFn,
): { variants: FlattenedObjectVariant[]; truncated: boolean } {
  if (baseSet.length === 0 || additionSet.length === 0) {
    return { variants: [], truncated: false };
  }
  const combined: FlattenedObjectVariant[] = [];
  let truncated = false;
  for (const base of baseSet) {
    for (const addition of additionSet) {
      const merged = mergeVariants(base, addition);
      if (merged) {
        combined.push(merged);
        if (combined.length >= MAX_OBJECT_VARIANTS) {
          truncated = true;
          break;
        }
      }
    }
    if (truncated) {
      break;
    }
  }
  return { variants: dedupeVariants(combined, resolve), truncated };
}

function extractLocalVariant(
  node: UnknownRecord,
  location: RedoclyLocation | undefined,
  from: string | undefined,
): FlattenedObjectVariant {
  const typeConstraint = localTypeConstraint(node);
  const properties = new Map<string, TrackedProperty>();
  if (isRecord(node.properties)) {
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
  }
  const required = new Set<string>();
  if (Array.isArray(node.required)) {
    for (const item of node.required) {
      if (typeof item === "string") {
        required.add(item);
      }
    }
  }
  const isObjectLike =
    typeConstraint.allowed.has("object") &&
    (node.type === "object" ||
      (Array.isArray(node.type) && node.type.includes("object")) ||
      properties.size > 0 ||
      required.size > 0 ||
      node.additionalProperties !== undefined);
  return {
    typeConstraint,
    isObjectLike,
    hasSchemaAdditionalProperties: isRecord(node.additionalProperties),
    properties,
    required,
  };
}

interface CollectVariantsResult {
  readonly variants: readonly FlattenedObjectVariant[];
  readonly truncated: boolean;
}

function collectFlattenedObjectVariants(
  schema: unknown,
  resolve: ResolverFn,
  location?: RedoclyLocation,
  fromOverride?: string,
): CollectVariantsResult {
  const visitBody = (
    node: UnknownRecord,
    currentLocation: RedoclyLocation | undefined,
    currentFrom: string | undefined,
    seen: ReadonlySet<unknown>,
    followRef: boolean,
  ): CollectVariantsResult => {
    let variants: FlattenedObjectVariant[] = [
      extractLocalVariant(node, currentLocation, currentFrom),
    ];
    let truncated = false;

    if (followRef && typeof node.$ref === "string") {
      const resolved = safeResolveSchema(resolve, node, currentFrom);
      if (resolved) {
        let refVariants: FlattenedObjectVariant[] | null = null;
        if (resolved.node !== undefined) {
          const targetRes = visit(
            resolved.node,
            resolved.location,
            resolved.location?.source?.absoluteRef,
            seen,
          );
          if (targetRes.truncated) {
            truncated = true;
          }
          refVariants = [...targetRes.variants];
        }
        const chain = resolved.chain ?? [];
        for (let index = chain.length - 1; index >= 0; index -= 1) {
          const hop = chain[index];
          if (!hop || !isRecord(hop.node) || hop.node === node || hop.node === resolved.node) {
            continue;
          }
          if (seen.has(hop.node)) {
            continue;
          }
          const hopSeen = new Set(seen);
          hopSeen.add(hop.node);
          const hopRes = visitBody(
            hop.node,
            hop.location,
            hop.location?.source?.absoluteRef,
            hopSeen,
            false,
          );
          if (hopRes.truncated) {
            truncated = true;
          }
          if (refVariants === null) {
            refVariants = [...hopRes.variants];
          } else {
            const combined = combineVariantSets(refVariants, hopRes.variants, resolve);
            refVariants = combined.variants;
            if (combined.truncated) {
              truncated = true;
            }
          }
        }
        if (refVariants !== null) {
          const combined = combineVariantSets(variants, refVariants, resolve);
          variants = combined.variants;
          if (combined.truncated) {
            truncated = true;
          }
        }
      }
    }

    if (Array.isArray(node.allOf)) {
      for (const [index, branch] of node.allOf.entries()) {
        const branchRes = visit(
          branch,
          currentLocation?.child(["allOf", index]),
          currentFrom,
          seen,
        );
        if (branchRes.truncated) {
          truncated = true;
        }
        const combined = combineVariantSets(variants, branchRes.variants, resolve);
        variants = combined.variants;
        if (combined.truncated) {
          truncated = true;
        }
        if (variants.length === 0) {
          break;
        }
      }
    }

    for (const unionKey of ["oneOf", "anyOf"] as const) {
      const branches = node[unionKey];
      if (!Array.isArray(branches) || branches.length === 0) {
        continue;
      }
      const unionVariants: FlattenedObjectVariant[] = [];
      for (const [index, branch] of branches.entries()) {
        const branchRes = visit(
          branch,
          currentLocation?.child([unionKey, index]),
          currentFrom,
          seen,
        );
        if (branchRes.truncated) {
          truncated = true;
        }
        for (const variant of branchRes.variants) {
          unionVariants.push(variant);
          if (unionVariants.length >= MAX_OBJECT_VARIANTS) {
            truncated = true;
            break;
          }
        }
        if (unionVariants.length >= MAX_OBJECT_VARIANTS) {
          break;
        }
      }
      const combined = combineVariantSets(variants, unionVariants, resolve);
      variants = combined.variants;
      if (combined.truncated) {
        truncated = true;
      }
      if (variants.length === 0) {
        break;
      }
    }

    if (
      node.nullable === true &&
      node.type === undefined &&
      !(node.const !== undefined && node.const !== null) &&
      !(Array.isArray(node.enum) && node.enum.length > 0 && !node.enum.includes(null))
    ) {
      variants = variants.map((variant) => {
        const allowed = new Set<JsonSchemaType>(variant.typeConstraint.allowed);
        allowed.add("null");
        return {
          ...variant,
          typeConstraint: { allowed },
        };
      });
    }

    return { variants: dedupeVariants(variants, resolve), truncated };
  };

  const visit = (
    node: unknown,
    currentLocation: RedoclyLocation | undefined,
    currentFrom: string | undefined,
    seen: ReadonlySet<unknown>,
  ): CollectVariantsResult => {
    if (node === false) {
      return { variants: [], truncated: false };
    }
    if (node === true || !isRecord(node) || seen.has(node)) {
      return { variants: [EMPTY_SEED_VARIANT], truncated: false };
    }
    const nextSeen = new Set(seen);
    nextSeen.add(node);
    return visitBody(node, currentLocation, currentFrom, nextSeen, true);
  };

  return visit(schema, location, fromOverride ?? location?.source?.absoluteRef, new Set());
}

function collectFragmentsObjectVariants(
  fragments: readonly SchemaFragment[],
  resolve: ResolverFn,
): CollectVariantsResult {
  let variants: FlattenedObjectVariant[] = [EMPTY_SEED_VARIANT];
  let truncated = false;
  for (const frag of fragments) {
    const res = collectFlattenedObjectVariants(frag.node, resolve, frag.location, frag.from);
    if (res.truncated) {
      truncated = true;
    }
    const merged = combineVariantSets(variants, res.variants, resolve);
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
    if (!isRecord(node) || seen.has(node)) {
      return [];
    }
    const nextSeen = new Set(seen);
    nextSeen.add(node);

    let branches: ArrayItemBranch[] = [[]];

    const intersectWith = (incoming: ArrayItemBranch[]): void => {
      if (incoming.length === 0) {
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

    if (typeof node.$ref === "string") {
      const resolved = safeResolveSchema(resolve, node, from);
      if (resolved) {
        if (isRecord(resolved.node)) {
          intersectWith(
            visitNode(
              resolved.node,
              resolved.location,
              resolved.location?.source?.absoluteRef,
              nextSeen,
            ),
          );
        }
        const chain = resolved.chain ?? [];
        for (let index = chain.length - 1; index >= 0; index -= 1) {
          const hop = chain[index];
          if (!hop || !isRecord(hop.node) || hop.node === node || hop.node === resolved.node) {
            continue;
          }
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

    if (Array.isArray(node.allOf)) {
      for (const [index, branch] of node.allOf.entries()) {
        intersectWith(visitNode(branch, location?.child(["allOf", index]), from, nextSeen));
      }
    }

    for (const unionKey of ["oneOf", "anyOf"] as const) {
      const unionBranches = node[unionKey];
      if (!Array.isArray(unionBranches) || unionBranches.length === 0) {
        continue;
      }
      const collected: ArrayItemBranch[] = [];
      for (const [index, branch] of unionBranches.entries()) {
        const sub = visitNode(branch, location?.child([unionKey, index]), from, nextSeen);
        for (const item of sub) {
          if (item.length > 0) {
            collected.push(item);
          }
        }
      }
      intersectWith(collected);
    }

    return branches.filter((branch) => branch.length > 0);
  };

  let combined: ArrayItemBranch[] = [[]];
  for (const frag of fragments) {
    const sub = visitNode(frag.node, frag.location, frag.from, new Set());
    if (sub.length === 0) {
      continue;
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

function extractComponentSchemaName(ref: string): string | undefined {
  const match = COMPONENT_SCHEMA_REF_RE.exec(ref);
  return match?.[1];
}

interface ComponentRefIdentity {
  readonly name: string;
  readonly resolvedKey?: string;
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
    !isRecord(schema.properties) &&
    !Array.isArray(schema.oneOf) &&
    !Array.isArray(schema.anyOf)
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
  const idTc = propertyTypeConstraint(idProp, resolve);
  return isScalarIdTypeConstraint(idTc);
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
    itemVariants: dedupeVariants(itemVariants, resolve),
  };
}

function areVariantsStructurallyCompatible(
  listVariant: FlattenedObjectVariant,
  getVariant: FlattenedObjectVariant,
  resolve: ResolverFn,
): boolean {
  if (
    !listVariant.typeConstraint.allowed.has("object") ||
    !getVariant.typeConstraint.allowed.has("object")
  ) {
    return false;
  }

  const listId = listVariant.properties.get("id");
  const getId = getVariant.properties.get("id");
  if (!listId || !getId) {
    return false;
  }
  const idOverlap = intersectTypeSets(
    propertyTypeConstraint(listId, resolve).allowed,
    propertyTypeConstraint(getId, resolve).allowed,
  );
  let hasScalarIdOverlap = false;
  for (const t of idOverlap) {
    if (SCALAR_ID_TYPES.has(t)) {
      hasScalarIdOverlap = true;
      break;
    }
  }
  if (!hasScalarIdOverlap) {
    return false;
  }

  for (const reqName of listVariant.required) {
    const getProp = getVariant.properties.get(reqName);
    if (!getProp) {
      return false;
    }
    const listProp = listVariant.properties.get(reqName);
    if (listProp) {
      const overlap = intersectTypeSets(
        propertyTypeConstraint(listProp, resolve).allowed,
        propertyTypeConstraint(getProp, resolve).allowed,
      );
      if (overlap.size === 0) {
        return false;
      }
    }
  }

  const listNonIdKeys = [...listVariant.properties.keys()].filter((k) => k !== "id");
  const getNonIdKeys = [...getVariant.properties.keys()].filter((k) => k !== "id");
  if (listNonIdKeys.length === 0) {
    return getNonIdKeys.length === 0;
  }

  for (const key of listNonIdKeys) {
    const listProp = listVariant.properties.get(key);
    const getProp = getVariant.properties.get(key);
    if (!listProp || !getProp) {
      continue;
    }
    const overlap = intersectTypeSets(
      propertyTypeConstraint(listProp, resolve).allowed,
      propertyTypeConstraint(getProp, resolve).allowed,
    );
    if (overlap.size > 0) {
      return true;
    }
  }

  return false;
}

function areSchemasCompatibleForHoistedGet(
  sourceItemBranches: readonly ArrayItemBranch[],
  sourceVariants: readonly FlattenedObjectVariant[],
  getSchema: unknown,
  getSchemaLocation: RedoclyLocation,
  resolve: ResolverFn,
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
      areVariantsStructurallyCompatible(listVariant, getVariant, resolve),
    ),
  );
}

interface JsonResponseSchemaEntry {
  readonly schema: unknown;
  readonly schemaLocation: RedoclyLocation;
}

function extractOperationJsonResponseSchemas(
  operation: UnknownRecord,
  operationLocation: RedoclyLocation,
  resolve: ResolverFn,
  statusCodes: readonly string[],
): JsonResponseSchemaEntry[] {
  if (!isRecord(operation.responses)) {
    return [];
  }
  const responses = operation.responses;
  const results: JsonResponseSchemaEntry[] = [];

  for (const statusCode of statusCodes) {
    const rawResponse = responses[statusCode];
    if (!isRecord(rawResponse)) {
      continue;
    }
    const resolved = resolveRecordWithLocation(
      resolve,
      rawResponse,
      operationLocation.child(["responses", statusCode]),
    );
    if (!resolved || !isRecord(resolved.node.content)) {
      continue;
    }
    for (const [mediaType, mediaObj] of Object.entries(resolved.node.content)) {
      if (!JSON_MEDIA_TYPE_RE.test(mediaType)) {
        continue;
      }
      if (!isRecord(mediaObj) || mediaObj.schema === undefined) {
        continue;
      }
      results.push({
        schema: mediaObj.schema,
        schemaLocation: resolved.location.child(["content", mediaType, "schema"]),
      });
    }
    if (results.length > 0) {
      break;
    }
  }

  return results;
}

function hasHeaderCaseInsensitive(headers: unknown, targetLower: string): boolean {
  if (!isRecord(headers)) {
    return false;
  }
  for (const key of Object.keys(headers)) {
    if (key.toLowerCase() === targetLower) {
      return true;
    }
  }
  return false;
}

function isFireAndForgetAcceptedOnly(
  operation: UnknownRecord,
  operationLocation: RedoclyLocation,
  resolve: ResolverFn,
): boolean {
  if (!isRecord(operation.responses)) {
    return false;
  }
  const responseKeys = Object.keys(operation.responses);
  const twoXxKeys = responseKeys.filter(
    (code) => EXACT_2XX_STATUS_RE.test(code) || code.toUpperCase() === "2XX",
  );
  if (twoXxKeys.length !== 1 || twoXxKeys[0] !== "202") {
    return false;
  }
  const raw202 = operation.responses["202"];
  const resolved = resolveRecordWithLocation(
    resolve,
    raw202,
    operationLocation.child(["responses", "202"]),
  );
  if (!resolved) {
    return true;
  }
  return !hasHeaderCaseInsensitive(resolved.node.headers, "location");
}

interface ResolvedPathEntry {
  readonly pathTemplate: string;
  readonly normalizedPath: string;
  readonly segments: readonly string[];
  readonly structuralKey: string;
  readonly pathItem: UnknownRecord;
  readonly pathUsageLocation: RedoclyLocation;
  readonly pathItemLocation: RedoclyLocation;
  readonly pathFromRef: boolean;
}

function collectResolvedPaths(
  root: UnknownRecord,
  ctx: RedoclyUserContext,
): {
  entries: ResolvedPathEntry[];
  byStructuralKey: Map<string, ResolvedPathEntry[]>;
} {
  const entries: ResolvedPathEntry[] = [];
  const byStructuralKey = new Map<string, ResolvedPathEntry[]>();

  if (!isRecord(root.paths)) {
    return { entries, byStructuralKey };
  }

  for (const [pathTemplate, rawPathItem] of Object.entries(root.paths)) {
    if (!pathTemplate.startsWith("/")) {
      continue;
    }
    const pathUsageLocation = ctx.location.child(["paths", pathTemplate]);
    const resolved = resolveRecordWithLocation(ctx.resolve, rawPathItem, pathUsageLocation);
    if (!resolved) {
      continue;
    }
    const normalizedPath = normalizePathTemplate(pathTemplate);
    const segments = splitPathSegments(pathTemplate);
    const structuralKey = structuralPathKey(segments);
    const entry: ResolvedPathEntry = {
      pathTemplate,
      normalizedPath,
      segments,
      structuralKey,
      pathItem: resolved.node,
      pathUsageLocation,
      pathItemLocation: resolved.location,
      pathFromRef: resolved.resolvedFromRef,
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

function hasAnyGetOnStructuralKey(
  byStructuralKey: ReadonlyMap<string, readonly ResolvedPathEntry[]>,
  key: string,
): boolean {
  const bucket = byStructuralKey.get(key);
  if (!bucket) {
    return false;
  }
  return bucket.some((entry) => isRecord(entry.pathItem.get));
}

function hasAnyOperationOnStructuralKey(
  byStructuralKey: ReadonlyMap<string, readonly ResolvedPathEntry[]>,
  key: string,
): boolean {
  const bucket = byStructuralKey.get(key);
  if (!bucket) {
    return false;
  }
  return bucket.some((entry) => HTTP_METHODS.some((method) => isRecord(entry.pathItem[method])));
}

function hasAnyStrictDescendant(
  entries: readonly ResolvedPathEntry[],
  prefixStructuralKey: string,
): boolean {
  const prefix = prefixStructuralKey === "/" ? "/" : `${prefixStructuralKey}/`;
  return entries.some(
    (entry) =>
      entry.structuralKey.startsWith(prefix) &&
      HTTP_METHODS.some((method) => isRecord(entry.pathItem[method])),
  );
}

function reportOnce(
  ctx: RedoclyUserContext,
  reported: Set<string>,
  dedupeTag: string,
  location: RedoclyLocation,
  message: string,
): void {
  const key = `${locationKey(location)}::${dedupeTag}`;
  if (reported.has(key)) {
    return;
  }
  reported.add(key);
  ctx.report({ message, location });
}

function operationReportLocation(entry: ResolvedPathEntry, method: string): RedoclyLocation {
  return entry.pathFromRef
    ? entry.pathUsageLocation.key()
    : entry.pathItemLocation.child([method]).key();
}

export const ads0005AddressableResourceRead: RedoclyOas3Rule = (options = {}) => {
  const ignoreMatcher = createRuleIgnoreMatcher(options);

  return {
    Root: {
      leave(root, ctx) {
        if (!isRecord(root) || !isRecord(root.paths)) {
          return;
        }
        const { entries, byStructuralKey } = collectResolvedPaths(root, ctx);
        const reported = new Set<string>();

        const findMatchingHoistedGets = (
          collectionSegments: readonly string[],
        ): Array<{ entry: ResolvedPathEntry; getOp: UnknownRecord }> => {
          const hoistedCollections = computeHoistedCollectionCandidates(collectionSegments);
          const matches: Array<{ entry: ResolvedPathEntry; getOp: UnknownRecord }> = [];
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
          const isItemPath =
            segments.length > 0 && isParamSegment(segments[segments.length - 1] ?? "");

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

              let satisfiedByHoisted = false;
              if (hoistedGets.length > 0) {
                if (method === "delete") {
                  satisfiedByHoisted = true;
                } else {
                  const opLoc = entry.pathItemLocation.child([method]);
                  const mutationSchemas = extractOperationJsonResponseSchemas(
                    op,
                    opLoc,
                    ctx.resolve,
                    ["200", "201", "2XX"],
                  );
                  const addressableMutationSchemas: Array<{
                    branch: ArrayItemBranch;
                    variants: readonly FlattenedObjectVariant[];
                  }> = [];
                  for (const ms of mutationSchemas) {
                    const collected = collectFlattenedObjectVariants(
                      ms.schema,
                      ctx.resolve,
                      ms.schemaLocation,
                    );
                    const nonNull = collected.variants.filter(
                      (v) => !isStrictlyNullConstraint(v.typeConstraint),
                    );
                    if (
                      nonNull.length > 0 &&
                      nonNull.every((v) => isAddressableResourceVariant(v, ctx.resolve))
                    ) {
                      const from = ms.schemaLocation.source?.absoluteRef;
                      addressableMutationSchemas.push({
                        branch: [
                          {
                            node: ms.schema,
                            ...(from !== undefined ? { from } : {}),
                            location: ms.schemaLocation,
                          },
                        ],
                        variants: nonNull,
                      });
                    }
                  }

                  if (addressableMutationSchemas.length === 0) {
                    satisfiedByHoisted = true;
                  } else {
                    for (const hoisted of hoistedGets) {
                      const hoistedGetSchemas = extractOperationJsonResponseSchemas(
                        hoisted.getOp,
                        hoisted.entry.pathItemLocation.child(["get"]),
                        ctx.resolve,
                        ["200", "2XX"],
                      );
                      if (
                        addressableMutationSchemas.some((ms) =>
                          hoistedGetSchemas.some((gs) =>
                            areSchemasCompatibleForHoistedGet(
                              [ms.branch],
                              ms.variants,
                              gs.schema,
                              gs.schemaLocation,
                              ctx.resolve,
                            ),
                          ),
                        )
                      ) {
                        satisfiedByHoisted = true;
                        break;
                      }
                    }
                  }
                }
              }

              if (!satisfiedByHoisted) {
                const hoistedHint =
                  hoistedCandidates.length > 0
                    ? ` or a schema-compatible hoisted canonical route such as "GET ${formatSegments([...(hoistedCandidates[hoistedCandidates.length - 1] ?? []), itemParam])}"`
                    : "";
                reportOnce(
                  ctx,
                  reported,
                  `item-mutation-missing-get:${method}`,
                  operationReportLocation(entry, method),
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
              reportOnce(
                ctx,
                reported,
                `singleton-mutation-missing-get:${method}`,
                operationReportLocation(entry, method),
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
            const postLoc = entry.pathItemLocation.child(["post"]);

            const isSubCollectionOrResource =
              isRecord(pathItem.get) ||
              isRecord(pathItem.patch) ||
              isRecord(pathItem.put) ||
              isRecord(pathItem.delete) ||
              hasAnyStrictDescendant(entries, structuralKey) ||
              computeHoistedCollectionCandidates(segments).some((hoistedCol) =>
                hasAnyOperationOnStructuralKey(
                  byStructuralKey,
                  structuralPathKey([...hoistedCol, "{}"]),
                ),
              ) ||
              (isRecord(postOp.responses) && isRecord(postOp.responses["201"])) ||
              looksLikePluralSubCollectionSegment(actionSegment) ||
              isFireAndForgetAcceptedOnly(postOp, postLoc, ctx.resolve);

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
              const hoistedCandidates =
                computeHoistedCollectionCandidates(parentCollectionSegments);
              const hasHoistedGet = findMatchingHoistedGets(parentCollectionSegments).length > 0;

              if (!hasParentGet && !hasHoistedGet) {
                const hoistedHint =
                  hoistedCandidates.length > 0
                    ? ` or a hoisted canonical route such as "GET ${formatSegments([...(hoistedCandidates[hoistedCandidates.length - 1] ?? []), parentItemParam])}"`
                    : "";
                reportOnce(
                  ctx,
                  reported,
                  "action-missing-item-get",
                  operationReportLocation(entry, "post"),
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
            entry.pathItemLocation.child(["get"]),
            ctx.resolve,
            ["200", "2XX"],
          );
          if (getSchemas.length === 0) {
            continue;
          }

          const collectionInfos: AddressableCollectionInfo[] = [];
          for (const gs of getSchemas) {
            const collected = collectFlattenedObjectVariants(
              gs.schema,
              ctx.resolve,
              gs.schemaLocation,
            );
            for (const variant of collected.variants) {
              const info = extractAddressableCollection(variant, ctx.resolve);
              if (info) {
                collectionInfos.push(info);
              }
            }
          }

          if (collectionInfos.length === 0) {
            continue;
          }

          const directChildKey = structuralPathKey([...segments, "{}"]);
          if (hasAnyGetOnStructuralKey(byStructuralKey, directChildKey)) {
            continue;
          }

          const hoistedCandidates = computeHoistedCollectionCandidates(segments);
          const hoistedGets = findMatchingHoistedGets(segments);

          const allCollectionsMatched = collectionInfos.every((info) =>
            hoistedGets.some((hoisted) => {
              const hoistedGetSchemas = extractOperationJsonResponseSchemas(
                hoisted.getOp,
                hoisted.entry.pathItemLocation.child(["get"]),
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
            reportOnce(
              ctx,
              reported,
              "collection-missing-item-get",
              operationReportLocation(entry, "get"),
              `GET "${pathTemplate}" lists addressable resources with primary "id" but has no corresponding single-resource GET endpoint. Add "GET ${directPath}"${hoistedHint} (ADS-0005).`,
            );
          }
        }
      },
    },
  };
};

export const ads0005StandardHttpMethods: RedoclyOas3Rule = (options = {}) => {
  const ignoreMatcher = createRuleIgnoreMatcher(options);

  return {
    Root: {
      leave(root, ctx) {
        if (!isRecord(root) || !isRecord(root.paths)) {
          return;
        }
        const reported = new Set<string>();

        for (const [pathTemplate, rawPathItem] of Object.entries(root.paths)) {
          if (!pathTemplate.startsWith("/")) {
            continue;
          }
          const pathUsageLocation = ctx.location.child(["paths", pathTemplate]);
          const resolved = resolveRecordWithLocation(ctx.resolve, rawPathItem, pathUsageLocation);
          const pathItem = resolved?.node;
          const pathItemLocation = resolved?.location ?? pathUsageLocation;
          const pathFromRef = resolved?.resolvedFromRef ?? false;

          // 1. No CRUD verbs in static URL path segments
          if (!ignoreMatcher.areAllPathOperationsIgnored(pathTemplate, pathItem)) {
            const segments = splitPathSegments(pathTemplate);
            for (const segment of segments) {
              const verb = findCrudVerbInPathSegment(segment);
              if (verb !== null) {
                reportOnce(
                  ctx,
                  reported,
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
              reportOnce(
                ctx,
                reported,
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
            const loc = pathFromRef
              ? pathUsageLocation.key()
              : pathItemLocation.child(["get", "requestBody"]);
            reportOnce(
              ctx,
              reported,
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
            const loc = pathFromRef
              ? pathUsageLocation.key()
              : pathItemLocation.child(["delete", "requestBody"]);
            reportOnce(
              ctx,
              reported,
              "collection-delete-request-body",
              loc,
              `DELETE "${pathTemplate}" must not declare a requestBody on a non-item path. Identify single-resource targets in the URL path, or use a dedicated POST batch endpoint for bulk deletions (ADS-0005).`,
            );
          }
        }
      },
    },
  };
};

export const ads0005StandardStatusCodes: RedoclyOas3Rule = (options = {}) => {
  const ignoreMatcher = createRuleIgnoreMatcher(options);

  return {
    Root: {
      leave(root, ctx) {
        if (!isRecord(root) || !isRecord(root.paths)) {
          return;
        }
        const { entries, byStructuralKey } = collectResolvedPaths(root, ctx);
        const reported = new Set<string>();

        for (const entry of entries) {
          const { pathTemplate, segments, structuralKey, pathItem, pathItemLocation, pathFromRef } =
            entry;
          const isItemPath =
            segments.length > 0 && isParamSegment(segments[segments.length - 1] ?? "");

          // 1. GET must not declare 201 or 202
          if (
            isRecord(pathItem.get) &&
            isRecord(pathItem.get.responses) &&
            !ignoreMatcher.isIgnored({ path: pathTemplate, method: "get" })
          ) {
            for (const badStatus of ["201", "202"] as const) {
              if (pathItem.get.responses[badStatus] !== undefined) {
                const loc = pathFromRef
                  ? entry.pathUsageLocation.key()
                  : pathItemLocation.child(["get", "responses", badStatus]).key();
                reportOnce(
                  ctx,
                  reported,
                  `get-bad-status:${badStatus}`,
                  loc,
                  `GET "${pathTemplate}" must not declare "${badStatus}". Use "200" (and optional "304" for conditional reads) for GET responses (ADS-0005).`,
                );
              }
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

            if (hasSamePathGet || hasDirectItemRoute) {
              const responses = pathItem.post.responses;
              const responseCodes = Object.keys(responses);
              const declared2xx = responseCodes.filter(
                (code) => EXACT_2XX_STATUS_RE.test(code) || code.toUpperCase() === "2XX",
              );
              const hasCreatedOrAccepted =
                responses["201"] !== undefined || responses["202"] !== undefined;

              if (declared2xx.length > 0 && !hasCreatedOrAccepted) {
                const loc = pathFromRef
                  ? entry.pathUsageLocation.key()
                  : pathItemLocation.child(["post", "responses"]).key();
                reportOnce(
                  ctx,
                  reported,
                  "post-collection-missing-201-or-202",
                  loc,
                  `POST "${pathTemplate}" creates a resource in a collection and must declare "201" (synchronous creation) or "202" (asynchronous creation), not only ${declared2xx.map((c) => `"${c}"`).join(", ")} (ADS-0005).`,
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
            if (responses["204"] !== undefined) {
              const loc = pathFromRef
                ? entry.pathUsageLocation.key()
                : pathItemLocation.child(["patch", "responses", "204"]).key();
              reportOnce(
                ctx,
                reported,
                "patch-204",
                loc,
                `PATCH "${pathTemplate}" must not declare "204 No Content". Return "200" with the updated resource body (or "202" for asynchronous updates) (ADS-0005).`,
              );
            }
            if (responses["200"] !== undefined) {
              const respLoc = pathItemLocation.child(["patch", "responses", "200"]);
              const resolved200 = resolveRecordWithLocation(ctx.resolve, responses["200"], respLoc);
              if (
                resolved200 &&
                (!isRecord(resolved200.node.content) ||
                  Object.keys(resolved200.node.content).length === 0)
              ) {
                const loc = pathFromRef ? entry.pathUsageLocation.key() : respLoc.key();
                reportOnce(
                  ctx,
                  reported,
                  "patch-200-empty-body",
                  loc,
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
            if (responses["201"] !== undefined) {
              const loc = pathFromRef
                ? entry.pathUsageLocation.key()
                : pathItemLocation.child(["delete", "responses", "201"]).key();
              reportOnce(
                ctx,
                reported,
                "delete-201",
                loc,
                `DELETE "${pathTemplate}" must not declare "201 Created". Use "204" without a body, "200" with a resource or receipt body, or "202" for asynchronous deletion (ADS-0005).`,
              );
            }
            if (responses["204"] !== undefined) {
              const respLoc = pathItemLocation.child(["delete", "responses", "204"]);
              const resolved204 = resolveRecordWithLocation(ctx.resolve, responses["204"], respLoc);
              if (
                resolved204 &&
                isRecord(resolved204.node.content) &&
                Object.keys(resolved204.node.content).length > 0
              ) {
                const loc =
                  pathFromRef || resolved204.resolvedFromRef
                    ? pathFromRef
                      ? entry.pathUsageLocation.key()
                      : respLoc.key()
                    : resolved204.location.child(["content"]).key();
                reportOnce(
                  ctx,
                  reported,
                  "delete-204-with-body",
                  loc,
                  `DELETE "${pathTemplate}" declares a response "content" body on "204 No Content". Remove the response body, or use "200" when returning a soft-deleted resource or receipt (ADS-0005).`,
                );
              }
            }
          }
        }
      },
    },
  };
};

export const ads0005UrlPathNaming: RedoclyOas3Rule = (options = {}) => {
  const ignoreMatcher = createRuleIgnoreMatcher(options);

  return {
    Root: {
      leave(root, ctx) {
        if (!isRecord(root) || !isRecord(root.paths)) {
          return;
        }
        const reported = new Set<string>();

        for (const [pathTemplate, rawPathItem] of Object.entries(root.paths)) {
          if (!pathTemplate.startsWith("/")) {
            continue;
          }
          const pathUsageLocation = ctx.location.child(["paths", pathTemplate]);
          const resolved = resolveRecordWithLocation(ctx.resolve, rawPathItem, pathUsageLocation);
          if (ignoreMatcher.areAllPathOperationsIgnored(pathTemplate, resolved?.node)) {
            continue;
          }

          const segments = splitPathSegments(pathTemplate);
          for (const [index, segment] of segments.entries()) {
            if (!isValidKebabCasePathSegment(segment, index)) {
              reportOnce(
                ctx,
                reported,
                `non-kebab-segment:${index}:${segment}`,
                pathUsageLocation.key(),
                `Path "${pathTemplate}" contains non-kebab-case static segment "${segment}". Static URL path segments must use lowercase kebab-case (for example "api-keys" or "agent-profile") (ADS-0005).`,
              );
            }
          }
        }
      },
    },
  };
};

export const ads0005Rules: Record<string, RedoclyOas3Rule> = {
  "ads-0005-addressable-resource-read": ads0005AddressableResourceRead,
  "ads-0005-standard-http-methods": ads0005StandardHttpMethods,
  "ads-0005-standard-status-codes": ads0005StandardStatusCodes,
  "ads-0005-url-path-naming": ads0005UrlPathNaming,
};
