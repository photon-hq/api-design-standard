import { HTTP_METHODS, type RuleIgnoreMatcher } from "../../src/ignore.js";
import {
  createRootRule,
  extractOperationJsonResponseSchemas,
  extractResponseJsonSchemas,
  iterateRootPathItems,
  reportOnce,
} from "../../src/openapi-utils.js";
import {
  ALL_JSON_TYPE_SET,
  ALL_JSON_TYPES,
  allowsNonNullConstraint,
  allowsNullConstraint,
  combineTypeConstraintAllOf,
  extractComponentSchemaName,
  foldSchemaFragments,
  formatAllowedTypes,
  isNonNullObjectConstraint,
  isNonNullStringConstraint,
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
  selectPropertyReportLocation,
  someSchemaBranch,
  type TrackedProperty,
  type TypeConstraint,
  type UnknownRecord,
  walkSchemaLattice,
} from "../../src/schema-utils.js";
import {
  collectFlattenedObjectVariants as collectBaseFlattenedObjectVariants,
  collectFragmentsObjectVariants,
  type FlattenedObjectVariant,
  type FlattenedVariantOptions,
} from "../../src/schema-variants.js";
import type {
  AdsStandardMetadata,
  RedoclyLocation,
  RedoclyOas3Rule,
  RedoclyUserContext,
} from "../../src/types.js";
import { PLUGIN_ID } from "../0001-resource-identifiers/rules.js";

export const ADS_0004_METADATA: AdsStandardMetadata = {
  ads: "0004",
  slug: "ads-0004",
  folder: "0004-long-running-operations",
  rules: [
    {
      name: "ads-0004-operation-resource-shape",
      id: `${PLUGIN_ID}/ads-0004-operation-resource-shape`,
      severity: "error",
      summary:
        "Operation responses must be flat JSON objects using the canonical ADS-0004 field names (`id`, `type`, `status`, `createdAt`, `updatedAt`, `completedAt`, `response`, `error`), canonical status values, date-time formats, and RFC 9457 error objects.",
    },
    {
      name: "ads-0004-operation-status-invariants",
      id: `${PLUGIN_ID}/ads-0004-operation-status-invariants`,
      severity: "error",
      summary:
        "Operation status branches must preserve ADS-0004 nullability and nextAction invariants across non-terminal, requires_action, succeeded, failed, and cancelled states without exposing sensitive credentials.",
    },
    {
      name: "ads-0004-accepted-operation-headers",
      id: `${PLUGIN_ID}/ads-0004-accepted-operation-headers`,
      severity: "error",
      summary:
        "Every 202 Accepted response returning an Operation resource must declare a Location response header pointing to the poll URL.",
    },
    {
      name: "ads-0004-operation-cancel-method",
      id: `${PLUGIN_ID}/ads-0004-operation-cancel-method`,
      severity: "error",
      summary:
        "Operation cancellation must use POST .../operations/{operationId}/cancel returning a 200 JSON response and must not use DELETE on operation routes.",
    },
  ],
};

export const CANONICAL_OPERATION_STATUSES = [
  "pending",
  "running",
  "requires_action",
  "succeeded",
  "failed",
  "cancelled",
] as const;

export type CanonicalOperationStatus = (typeof CANONICAL_OPERATION_STATUSES)[number];

const CANONICAL_STATUS_SET = new Set<string>(CANONICAL_OPERATION_STATUSES);
const NON_TERMINAL_STATUS_SET = new Set<string>(["pending", "running", "requires_action"]);
const TERMINAL_STATUS_SET = new Set<string>(["succeeded", "failed", "cancelled"]);

const UNIVERSAL_OPERATION_FIELDS = [
  "id",
  "type",
  "status",
  "createdAt",
  "updatedAt",
  "completedAt",
  "response",
  "error",
] as const;

const RFC9457_CORE_FIELDS = ["type", "title", "status", "code"] as const;

const OPERATION_ITEM_PATH_RE = /(?:^|\/)operations\/\{([^}]+)\}\/?$/;
const OPERATION_CANCEL_PATH_RE = /(?:^|\/)operations\/\{([^}]+)\}\/cancel\/?$/;
const OPERATION_DELETE_PATH_RE = /(?:^|\/)operations\/\{[^}]+\}(?:\/cancel)?\/?$/;
const OPERATION_SCHEMA_NAME_RE =
  /^(?:[A-Za-z0-9._-]*Operation)(?:Response|Status|Resource)?$|^(?:[a-z0-9._-]*[_.-])?operation(?:[_.-](?:response|status|resource))?$/;
const SNAKE_CASE_RE = /^[a-z][a-z0-9]*(?:_[a-z0-9]+)*$/;
const NON_CREDENTIAL_TOKEN_KEY_RE =
  /^(?:next|prev|previous|page|continuation|sync|cursor)(?:_?page)?_?token$/i;
const SENSITIVE_CREDENTIAL_EXACT_RE =
  /^(?:secret|password|passphrase|token|api_?key|private_?key|client_?secret|access_?token|refresh_?token|id_?token|session_?token|auth_?token|bearer_?token|signing_?secret)$/i;
const SENSITIVE_CREDENTIAL_CAMEL_SUFFIX_RE =
  /[a-z0-9](?:Secret|Password|Passphrase|ApiKey|PrivateKey|Token)$/;
const SENSITIVE_CREDENTIAL_SNAKE_SUFFIX_RE =
  /_(?:secret|password|passphrase|api_key|private_key|token)$/i;

const PROHIBITED_CREDENTIAL_PROBES = `
  secret password passphrase token apiKey api_key privateKey private_key
  clientSecret client_secret accessToken access_token refreshToken refresh_token
  idToken id_token sessionToken session_token authToken auth_token
  bearerToken bearer_token signingSecret signing_secret
`
  .trim()
  .split(/\s+/);

const BENIGN_KEY_PROBES = `
  id name value record status type hostname foo exampleKey example_key
`
  .trim()
  .split(/\s+/);

export function isCanonicalOperationStatus(value: string): value is CanonicalOperationStatus {
  return CANONICAL_STATUS_SET.has(value);
}

export function isSnakeCaseActionType(value: string): boolean {
  return SNAKE_CASE_RE.test(value);
}

export function isSensitiveCredentialKey(key: string): boolean {
  if (NON_CREDENTIAL_TOKEN_KEY_RE.test(key)) {
    return false;
  }
  return (
    SENSITIVE_CREDENTIAL_EXACT_RE.test(key) ||
    SENSITIVE_CREDENTIAL_CAMEL_SUFFIX_RE.test(key) ||
    SENSITIVE_CREDENTIAL_SNAKE_SUFFIX_RE.test(key)
  );
}

export function extractOperationItemParam(pathTemplate: string): string | null {
  const match = OPERATION_ITEM_PATH_RE.exec(pathTemplate);
  return match?.[1]?.trim() ?? null;
}

export function extractOperationCancelParam(pathTemplate: string): string | null {
  const match = OPERATION_CANCEL_PATH_RE.exec(pathTemplate);
  return match?.[1]?.trim() ?? null;
}

export function isOperationDeletePath(pathTemplate: string): boolean {
  return OPERATION_DELETE_PATH_RE.test(pathTemplate);
}

export function isOperationSchemaName(schemaName: string): boolean {
  return OPERATION_SCHEMA_NAME_RE.test(schemaName);
}

function isNonNullBooleanConstraint(tc: TypeConstraint): boolean {
  return tc.allowed.size === 1 && tc.allowed.has("boolean");
}

function isNonNullIntegerConstraint(tc: TypeConstraint): boolean {
  return tc.allowed.size === 1 && tc.allowed.has("integer");
}

function allowsOnlyNullOrString(tc: TypeConstraint): boolean {
  if (tc.allowed.size === 0) {
    return false;
  }
  for (const t of tc.allowed) {
    if (t !== "string" && t !== "null") {
      return false;
    }
  }
  return true;
}

function allowsOnlyNullOrObject(tc: TypeConstraint): boolean {
  if (tc.allowed.size === 0) {
    return false;
  }
  for (const t of tc.allowed) {
    if (t !== "object" && t !== "null") {
      return false;
    }
  }
  return true;
}

function nonNullTypesOf(tc: TypeConstraint): JsonSchemaType[] {
  return ALL_JSON_TYPES.filter((t) => t !== "null" && tc.allowed.has(t));
}

type LiteralLattice =
  | { readonly kind: "unconstrained" }
  | {
      readonly kind: "values";
      readonly values: ReadonlySet<string>;
      readonly hasNonString: boolean;
    };

const UNCONSTRAINED_LITERALS: LiteralLattice = { kind: "unconstrained" };
const EMPTY_LITERALS: LiteralLattice = {
  kind: "values",
  values: new Set(),
  hasNonString: false,
};

function combineLiteralsAllOf(a: LiteralLattice, b: LiteralLattice): LiteralLattice {
  if (a.kind === "unconstrained") {
    return b;
  }
  if (b.kind === "unconstrained") {
    return a;
  }
  const values = new Set<string>();
  for (const value of a.values) {
    if (b.values.has(value)) {
      values.add(value);
    }
  }
  return {
    kind: "values",
    values,
    hasNonString: a.hasNonString && b.hasNonString,
  };
}

function combineLiteralsUnion(items: readonly LiteralLattice[]): LiteralLattice {
  if (items.length === 0) {
    return UNCONSTRAINED_LITERALS;
  }
  const values = new Set<string>();
  let hasNonString = false;
  for (const item of items) {
    if (item.kind === "unconstrained") {
      return UNCONSTRAINED_LITERALS;
    }
    for (const value of item.values) {
      values.add(value);
    }
    if (item.hasNonString) {
      hasNonString = true;
    }
  }
  return { kind: "values", values, hasNonString };
}

function localStringLiterals(node: UnknownRecord): LiteralLattice {
  let result: LiteralLattice = UNCONSTRAINED_LITERALS;
  if (node.const !== undefined) {
    if (typeof node.const === "string") {
      result = combineLiteralsAllOf(result, {
        kind: "values",
        values: new Set([node.const]),
        hasNonString: false,
      });
    } else {
      result = combineLiteralsAllOf(result, {
        kind: "values",
        values: new Set(),
        hasNonString: true,
      });
    }
  }
  if (Array.isArray(node.enum) && node.enum.length > 0) {
    const values = new Set<string>();
    let hasNonString = false;
    for (const item of node.enum) {
      if (typeof item === "string") {
        values.add(item);
      } else {
        hasNonString = true;
      }
    }
    result = combineLiteralsAllOf(result, {
      kind: "values",
      values,
      hasNonString,
    });
  }
  return result;
}

function extractSchemaStringLiterals(
  schema: unknown,
  resolve: ResolverFn,
  from?: string,
): LiteralLattice {
  return walkSchemaLattice<LiteralLattice>(schema, resolve, from, {
    falseValue: EMPTY_LITERALS,
    unknownValue: UNCONSTRAINED_LITERALS,
    local: localStringLiterals,
    combineAllOf: combineLiteralsAllOf,
    combineUnion: (values) => combineLiteralsUnion(values),
  });
}

type ExactLiteralLattice =
  | { readonly kind: "unconstrained" }
  | { readonly kind: "values"; readonly values: ReadonlySet<string> };

const UNCONSTRAINED_EXACT_LITERALS: ExactLiteralLattice = { kind: "unconstrained" };
const EMPTY_EXACT_LITERALS: ExactLiteralLattice = { kind: "values", values: new Set() };

function canonicalPrimitiveKey(value: unknown): string | null {
  if (value === null) {
    return "null";
  }
  switch (typeof value) {
    case "string":
      return `s:${value}`;
    case "boolean":
      return value ? "b:true" : "b:false";
    case "number":
      return Number.isFinite(value) ? `n:${Object.is(value, -0) ? 0 : value}` : null;
    default:
      return null;
  }
}

function jsonTypeOfCanonicalPrimitiveKey(key: string): JsonSchemaType {
  if (key === "null") {
    return "null";
  }
  if (key.startsWith("s:")) {
    return "string";
  }
  if (key.startsWith("b:")) {
    return "boolean";
  }
  const num = Number(key.slice(2));
  return Number.isInteger(num) ? "integer" : "number";
}

function canonicalKeyMatchesAllowedTypes(
  key: string,
  allowed: ReadonlySet<JsonSchemaType>,
): boolean {
  const keyType = jsonTypeOfCanonicalPrimitiveKey(key);
  if (allowed.has(keyType)) {
    return true;
  }
  return keyType === "integer" && allowed.has("number");
}

function combineExactLiteralsAllOf(
  a: ExactLiteralLattice,
  b: ExactLiteralLattice,
): ExactLiteralLattice {
  if (a.kind === "unconstrained") {
    return b;
  }
  if (b.kind === "unconstrained") {
    return a;
  }
  const intersection = new Set<string>();
  for (const val of a.values) {
    if (b.values.has(val)) {
      intersection.add(val);
    }
  }
  return { kind: "values", values: intersection };
}

function combineExactLiteralsUnion(values: readonly ExactLiteralLattice[]): ExactLiteralLattice {
  if (values.length === 0) {
    return UNCONSTRAINED_EXACT_LITERALS;
  }
  const union = new Set<string>();
  for (const item of values) {
    if (item.kind === "unconstrained") {
      return UNCONSTRAINED_EXACT_LITERALS;
    }
    for (const val of item.values) {
      union.add(val);
    }
  }
  return { kind: "values", values: union };
}

function localExactLiterals(node: UnknownRecord): ExactLiteralLattice {
  let result: ExactLiteralLattice = UNCONSTRAINED_EXACT_LITERALS;
  if (node.const !== undefined) {
    const key = canonicalPrimitiveKey(node.const);
    if (key !== null) {
      result = combineExactLiteralsAllOf(result, { kind: "values", values: new Set([key]) });
    }
  }
  if (Array.isArray(node.enum) && node.enum.length > 0) {
    const keys = new Set<string>();
    let allPrimitive = true;
    for (const item of node.enum) {
      const key = canonicalPrimitiveKey(item);
      if (key === null) {
        allPrimitive = false;
        break;
      }
      keys.add(key);
    }
    if (allPrimitive) {
      result = combineExactLiteralsAllOf(result, { kind: "values", values: keys });
    }
  }
  return result;
}

function extractSchemaExactLiterals(
  schema: unknown,
  resolve: ResolverFn,
  from?: string,
): ExactLiteralLattice {
  return walkSchemaLattice<ExactLiteralLattice>(schema, resolve, from, {
    falseValue: EMPTY_EXACT_LITERALS,
    unknownValue: UNCONSTRAINED_EXACT_LITERALS,
    local: localExactLiterals,
    combineAllOf: combineExactLiteralsAllOf,
    combineUnion: (values) => combineExactLiteralsUnion(values),
  });
}

const EXTRA_CONSTRAINT_KEYWORDS = [
  "minimum",
  "exclusiveMinimum",
  "maximum",
  "exclusiveMaximum",
  "multipleOf",
  "minLength",
  "maxLength",
  "pattern",
  "minItems",
  "maxItems",
  "uniqueItems",
  "not",
  "if",
  "then",
  "else",
  "dependentRequired",
  "dependentSchemas",
] as const;

function schemaHasExtraConstraints(
  schema: unknown,
  resolve: ResolverFn,
  from: string | undefined,
): boolean {
  return someSchemaBranch(schema, resolve, from, (node) =>
    EXTRA_CONSTRAINT_KEYWORDS.some((kw) => node[kw] !== undefined),
  );
}

type FormatLattice = "yes" | "no" | "null-only" | "unknown";

function checkSchemaStringFormat(
  schema: unknown,
  expectedFormat: string,
  resolve: ResolverFn,
  from?: string,
): FormatLattice {
  return walkSchemaLattice<FormatLattice>(schema, resolve, from, {
    falseValue: "null-only",
    unknownValue: "unknown",
    local(node): FormatLattice {
      const localTc = localTypeConstraint(node);
      if (isStrictlyNullConstraint(localTc)) {
        return "null-only";
      }
      if (node.format === expectedFormat) {
        return "yes";
      }
      if (typeof node.format === "string" && node.format !== expectedFormat) {
        return "no";
      }
      if (localTc.allowed.has("string") && localTc.allowed.size < ALL_JSON_TYPE_SET.size) {
        return "no";
      }
      return "unknown";
    },
    combineAllOf(a, b): FormatLattice {
      if (a === "null-only" || b === "null-only") {
        return "null-only";
      }
      if (a === "yes" || b === "yes") {
        return "yes";
      }
      if (a === "no" || b === "no") {
        return "no";
      }
      return "unknown";
    },
    combineUnion(values): FormatLattice {
      const nonNull = values.filter((v) => v !== "null-only");
      if (nonNull.length === 0) {
        return values.length > 0 ? "null-only" : "unknown";
      }
      if (nonNull.some((v) => v === "no")) {
        return "no";
      }
      if (nonNull.every((v) => v === "yes")) {
        return "yes";
      }
      return "unknown";
    },
  });
}

function isAds0004MergeSatisfiable(
  base: FlattenedObjectVariant,
  addition: FlattenedObjectVariant,
  merged: FlattenedObjectVariant,
  resolve: ResolverFn,
): boolean {
  for (const name of merged.required) {
    const baseProp = base.properties.get(name);
    const addProp = addition.properties.get(name);
    const mergedProp = merged.properties.get(name);
    if (!baseProp || !addProp || !mergedProp) {
      continue;
    }
    const baseTc = propertyTypeConstraint(baseProp, resolve);
    const addTc = propertyTypeConstraint(addProp, resolve);
    const mergedTc = propertyTypeConstraint(mergedProp, resolve);
    if (baseTc.allowed.size > 0 && addTc.allowed.size > 0 && mergedTc.allowed.size === 0) {
      return false;
    }
    const baseExact = propertyExactLiterals(baseProp, resolve);
    const addExact = propertyExactLiterals(addProp, resolve);
    const baseSatisfiable =
      baseExact.kind !== "values" ||
      [...baseExact.values].some((key) => canonicalKeyMatchesAllowedTypes(key, baseTc.allowed));
    const addSatisfiable =
      addExact.kind !== "values" ||
      [...addExact.values].some((key) => canonicalKeyMatchesAllowedTypes(key, addTc.allowed));
    if (baseSatisfiable && addSatisfiable) {
      const mergedExact = propertyExactLiterals(mergedProp, resolve);
      if (
        mergedExact.kind === "values" &&
        ![...mergedExact.values].some((key) =>
          canonicalKeyMatchesAllowedTypes(key, mergedTc.allowed),
        )
      ) {
        return false;
      }
    }
  }
  return true;
}

function propertyStringLiterals(prop: TrackedProperty, resolve: ResolverFn): LiteralLattice {
  return foldSchemaFragments(prop.fragments, UNCONSTRAINED_LITERALS, combineLiteralsAllOf, (frag) =>
    extractSchemaStringLiterals(frag.node, resolve, frag.from),
  );
}

function propertyExactLiterals(prop: TrackedProperty, resolve: ResolverFn): ExactLiteralLattice {
  return foldSchemaFragments(
    prop.fragments,
    UNCONSTRAINED_EXACT_LITERALS,
    combineExactLiteralsAllOf,
    (frag) => extractSchemaExactLiterals(frag.node, resolve, frag.from),
  );
}

function propertyHasExtraConstraints(prop: TrackedProperty, resolve: ResolverFn): boolean {
  return prop.fragments.some((frag) => schemaHasExtraConstraints(frag.node, resolve, frag.from));
}

function propertyStringFormat(
  prop: TrackedProperty,
  expectedFormat: string,
  resolve: ResolverFn,
): FormatLattice {
  return foldSchemaFragments<FormatLattice>(
    prop.fragments,
    "unknown",
    (combined, next) => {
      if (combined === "null-only" || next === "null-only") {
        return "null-only";
      }
      if (combined === "yes" || next === "yes") {
        return "yes";
      }
      if (combined === "no" || next === "no") {
        return "no";
      }
      return combined;
    },
    (frag) => checkSchemaStringFormat(frag.node, expectedFormat, resolve, frag.from),
  );
}

function variantSignature(variant: FlattenedObjectVariant, resolve: ResolverFn): string {
  const typesSig = formatAllowedTypes(variant.typeConstraint.allowed);
  const reqSig = [...variant.required].sort().join(",");
  const schemaNamesSig = [...variant.schemaNames].sort().join(",");
  const propKeys = [...variant.properties.keys()].sort();
  const propSigs = propKeys.map((key) => {
    const prop = variant.properties.get(key);
    if (!prop) {
      return key;
    }
    const tc = propertyTypeConstraint(prop, resolve);
    const tcSig = formatAllowedTypes(tc.allowed);
    const exact = propertyExactLiterals(prop, resolve);
    const exactSig = exact.kind === "values" ? `[${[...exact.values].sort().join("|")}]` : "";
    const parts = [key, tcSig];
    if (exactSig.length > 0) {
      parts.push(exactSig);
    }
    if (key === "status" || key === "type" || key === "state" || key === "kind") {
      const lit = propertyStringLiterals(prop, resolve);
      const litSig = lit.kind === "values" ? [...lit.values].sort().join("|") : "*";
      parts.push(`str:${litSig}`);
    }
    if (
      key === "createdAt" ||
      key === "updatedAt" ||
      key === "completedAt" ||
      key === "startedAt" ||
      key === "expiresAt"
    ) {
      parts.push(`fmt:${propertyStringFormat(prop, "date-time", resolve)}`);
    } else if (key === "url") {
      parts.push(`fmt:${propertyStringFormat(prop, "uri", resolve)}`);
    }
    if (
      tc.allowed.has("object") ||
      tc.allowed.has("array") ||
      propertyHasExtraConstraints(prop, resolve)
    ) {
      const fragSig = prop.fragments
        .map((frag) => (frag.location ? locationKey(frag.location) : typeof frag.node))
        .sort()
        .join("&");
      parts.push(`f:${fragSig}`);
    }
    return parts.join(":");
  });
  return `${variant.isObjectLike ? "1" : "0"}:${typesSig}:s[${schemaNamesSig}]:r[${reqSig}]:p[${propSigs.join(";")}]`;
}

const ADS_0004_VARIANT_OPTIONS: FlattenedVariantOptions = {
  variantSignature,
  isMergeSatisfiable: isAds0004MergeSatisfiable,
  trackOneOfBranches: true,
};

function collectFlattenedObjectVariants(
  schema: unknown,
  resolve: ResolverFn,
  baseLocation?: RedoclyLocation,
): {
  readonly variants: readonly FlattenedObjectVariant[];
  readonly truncated: boolean;
  readonly sawOperationFingerprint: boolean;
} {
  let sawOperationFingerprint = false;
  const result = collectBaseFlattenedObjectVariants(schema, resolve, baseLocation, {
    ...ADS_0004_VARIANT_OPTIONS,
    onTruncatedVariant: (variant, res) => {
      if (!sawOperationFingerprint && hasOperationStructuralFingerprint([variant], res)) {
        sawOperationFingerprint = true;
      }
    },
  });
  return {
    variants: result.variants,
    truncated: result.truncated,
    sawOperationFingerprint,
  };
}

function collectPropertyObjectVariants(
  prop: TrackedProperty,
  resolve: ResolverFn,
): { readonly variants: FlattenedObjectVariant[]; readonly truncated: boolean } {
  return collectFragmentsObjectVariants(prop.fragments, resolve, ADS_0004_VARIANT_OPTIONS);
}

function collectRootAndDirectBranchSchemaKeys(
  schema: unknown,
  resolve: ResolverFn,
  from: string | undefined,
  outKeys: Set<string>,
  outNodes: Set<unknown>,
  seen: Set<unknown> = new Set(),
): void {
  if (!isRecord(schema) || seen.has(schema)) {
    return;
  }
  seen.add(schema);
  outNodes.add(schema);

  if (typeof schema.$ref === "string") {
    const resolved = safeResolveSchema(resolve, schema, from);
    if (resolved) {
      if (resolved.location) {
        outKeys.add(locationKey(resolved.location));
      }
      if (isRecord(resolved.node)) {
        collectRootAndDirectBranchSchemaKeys(
          resolved.node,
          resolve,
          resolved.location?.source?.absoluteRef,
          outKeys,
          outNodes,
          seen,
        );
      }
    }
  }

  for (const unionKey of ["oneOf", "anyOf"] as const) {
    const branches = schema[unionKey];
    if (!Array.isArray(branches)) {
      continue;
    }
    for (const branch of branches) {
      collectRootAndDirectBranchSchemaKeys(branch, resolve, from, outKeys, outNodes, seen);
    }
  }
}

function schemaReferencesKnownOperation(
  schema: unknown,
  resolve: ResolverFn,
  from: string | undefined,
  knownKeys: ReadonlySet<string>,
  knownNodes: ReadonlySet<unknown>,
): boolean {
  return someSchemaBranch(
    schema,
    resolve,
    from,
    (node, resolved) =>
      knownNodes.has(node) ||
      Boolean(resolved?.location && knownKeys.has(locationKey(resolved.location))),
    { combinators: ["oneOf", "anyOf"], requireRecordRefTarget: true },
  );
}

function schemaHasOperationComponentName(
  schema: unknown,
  resolve: ResolverFn,
  from: string | undefined,
): boolean {
  return someSchemaBranch(
    schema,
    resolve,
    from,
    (node) => {
      if (typeof node.$ref !== "string") {
        return false;
      }
      const name = extractComponentSchemaName(node.$ref);
      return Boolean(name && isOperationSchemaName(name));
    },
    { combinators: ["oneOf", "anyOf"], requireRecordRefTarget: true },
  );
}

function isSingleKeyOperationWrapper(
  variant: FlattenedObjectVariant,
  resolve: ResolverFn,
): TrackedProperty | null {
  if (variant.openAdditionalProperties || variant.properties.size !== 1) {
    return null;
  }
  const opProp = variant.properties.get("operation");
  if (!opProp) {
    return null;
  }
  const tc = propertyTypeConstraint(opProp, resolve);
  if (!tc.allowed.has("object")) {
    return null;
  }
  const nestedVariants = collectPropertyObjectVariants(opProp, resolve).variants;
  const hasStructuredNested = nestedVariants.some(
    (nested) => nested.isObjectLike && (nested.properties.size > 0 || nested.required.size > 0),
  );
  return hasStructuredNested ? opProp : null;
}

function hasOperationStructuralFingerprint(
  variants: readonly FlattenedObjectVariant[],
  resolve: ResolverFn,
): boolean {
  for (const variant of variants) {
    if (!variant.isObjectLike && variant.properties.size === 0) {
      continue;
    }
    if (isSingleKeyOperationWrapper(variant, resolve) !== null) {
      return true;
    }
    const props = variant.properties;
    if (props.has("operationId") && !props.has("id")) {
      return true;
    }
    const hasLifecycleKey = props.has("status") || props.has("state");
    if (!hasLifecycleKey) {
      continue;
    }
    if (
      props.has("completedAt") ||
      props.has("resolvedAt") ||
      props.has("endedAt") ||
      props.has("submittedAt") ||
      props.has("nextAction") ||
      props.has("cancellable")
    ) {
      return true;
    }
    const hasOutcomeKey = props.has("response") || props.has("result");
    const hasErrorKey = props.has("error") || props.has("failure");
    if (hasOutcomeKey && hasErrorKey) {
      return true;
    }
    const hasActionType = props.has("type") || props.has("kind");
    const hasTimestamp = props.has("createdAt") || props.has("updatedAt");
    if (hasErrorKey && hasActionType && hasTimestamp) {
      return true;
    }
  }
  return false;
}

type OperationResponseKind = "poll" | "cancel" | "accepted" | "replay";

interface OperationResponseEntry {
  readonly kind: OperationResponseKind;
  readonly pathTemplate: string;
  readonly method: string;
  readonly statusCode: string;
  readonly mediaType: string;
  readonly responseNode: UnknownRecord;
  readonly responseLocation: RedoclyLocation;
  readonly schema: unknown;
  readonly schemaLocation: RedoclyLocation;
  readonly reportBaseLocation: RedoclyLocation;
  readonly rootSchemaName?: string;
  readonly variants: readonly FlattenedObjectVariant[];
  readonly truncated: boolean;
}

/**
 * Collects Operation responses subject to ADS-0004 rules.
 *
 * Targeting heuristic:
 * - `GET .../operations/{param}` and `POST .../operations/{param}/cancel` `200`/`2XX` JSON
 *   responses are inspected unconditionally.
 * - `202` JSON responses (and companion `200` idempotent replay responses on the same operation)
 *   are inspected only when they match at least one of four deterministic signals:
 *   1. The schema shares a resolved component schema or direct union branch with an operations
 *      poll/cancel endpoint in the same document.
 *   2. A referenced component schema (or direct union branch) is named `*Operation`,
 *      `*OperationResponse`, `*OperationStatus`, or `*OperationResource`.
 *   3. The top-level schema is a single-key `{ operation: <object> }` wrapper.
 *   4. The schema carries an Operation structural fingerprint (`operationId` without `id`, or a
 *      `status`/`state` discriminator paired with operation lifecycle markers).
 *   Lifecycle-bearing resources and fire-and-forget `202` endpoints remain unaffected.
 */
function collectOperationResponses(
  root: UnknownRecord,
  ctx: RedoclyUserContext,
  ignoreMatcher: RuleIgnoreMatcher,
): OperationResponseEntry[] {
  const pathEntries = iterateRootPathItems(root, ctx);
  const knownOperationKeys = new Set<string>();
  const knownOperationNodes = new Set<unknown>();

  for (const pathEntry of pathEntries) {
    const { pathTemplate, pathItem } = pathEntry;
    if (!pathItem) {
      continue;
    }
    const isPollPath = extractOperationItemParam(pathTemplate) !== null;
    const isCancelPath = extractOperationCancelParam(pathTemplate) !== null;
    if (!isPollPath && !isCancelPath) {
      continue;
    }
    const methodsToInspect = isPollPath ? (["get"] as const) : (["post"] as const);
    for (const method of methodsToInspect) {
      const operation = pathItem[method];
      if (!isRecord(operation) || !isRecord(operation.responses)) {
        continue;
      }
      const opLoc = pathEntry.operationLocation(method);
      for (const statusCode of ["200", "2XX"] as const) {
        for (const jsonEntry of extractResponseJsonSchemas(
          operation.responses[statusCode],
          opLoc.child(["responses", statusCode]),
          ctx.resolve,
        )) {
          collectRootAndDirectBranchSchemaKeys(
            jsonEntry.schema,
            ctx.resolve,
            jsonEntry.responseLocation.source?.absoluteRef,
            knownOperationKeys,
            knownOperationNodes,
          );
        }
      }
    }
  }

  const entries: OperationResponseEntry[] = [];

  for (const pathEntry of pathEntries) {
    const { pathTemplate, pathItem, pathUsageLocation } = pathEntry;
    if (!pathItem) {
      continue;
    }
    const isPollPath = extractOperationItemParam(pathTemplate) !== null;
    const isCancelPath = extractOperationCancelParam(pathTemplate) !== null;

    for (const method of HTTP_METHODS) {
      const operation = pathItem[method];
      if (!isRecord(operation) || !isRecord(operation.responses)) {
        continue;
      }
      if (ignoreMatcher.isIgnored({ path: pathTemplate, method })) {
        continue;
      }
      const operationResponses = operation.responses;
      const opLoc = pathEntry.operationLocation(method);
      const opFromRef = pathEntry.isOperationFromRef(method);

      const inspectStatusResponse = (
        statusCode: string,
        kind: OperationResponseKind,
        requireHeuristic: boolean,
      ): boolean => {
        const rawResponse = operationResponses[statusCode];
        if (!isRecord(rawResponse)) {
          return false;
        }
        const responseUsageLocation = opLoc.child(["responses", statusCode]);
        const operationResponseLocation = opFromRef ? pathUsageLocation : responseUsageLocation;
        const jsonEntries = extractResponseJsonSchemas(
          rawResponse,
          responseUsageLocation,
          ctx.resolve,
        );
        if (jsonEntries.length === 0) {
          return false;
        }

        let matchedAny = false;
        for (const jsonEntry of jsonEntries) {
          const { mediaType, schema, schemaLocation, responseNode, responseLocation } = jsonEntry;
          const reportBaseLocation =
            opFromRef || jsonEntry.responseFromRef ? operationResponseLocation : schemaLocation;
          const rootSchemaName =
            isRecord(schema) && typeof schema.$ref === "string"
              ? extractComponentSchemaName(schema.$ref)
              : undefined;

          if (
            rootSchemaName &&
            ignoreMatcher.isIgnored({ path: pathTemplate, method, schema: rootSchemaName })
          ) {
            continue;
          }

          const collected = collectFlattenedObjectVariants(schema, ctx.resolve, schemaLocation);
          if (requireHeuristic) {
            const from = schemaLocation.source?.absoluteRef;
            const matches =
              schemaReferencesKnownOperation(
                schema,
                ctx.resolve,
                from,
                knownOperationKeys,
                knownOperationNodes,
              ) ||
              schemaHasOperationComponentName(schema, ctx.resolve, from) ||
              collected.sawOperationFingerprint ||
              hasOperationStructuralFingerprint(collected.variants, ctx.resolve);
            if (!matches) {
              continue;
            }
          }

          matchedAny = true;
          entries.push({
            kind,
            pathTemplate,
            method,
            statusCode,
            mediaType,
            responseNode,
            responseLocation,
            schema,
            schemaLocation,
            reportBaseLocation,
            ...(rootSchemaName !== undefined ? { rootSchemaName } : {}),
            variants: collected.variants,
            truncated: collected.truncated,
          });
        }
        return matchedAny;
      };

      if (isPollPath && method === "get") {
        if (isRecord(operationResponses["200"])) {
          inspectStatusResponse("200", "poll", false);
        } else {
          inspectStatusResponse("2XX", "poll", false);
        }
        continue;
      }

      if (isCancelPath && method === "post") {
        if (isRecord(operationResponses["200"])) {
          inspectStatusResponse("200", "cancel", false);
        } else {
          inspectStatusResponse("2XX", "cancel", false);
        }
        continue;
      }

      const matchedAccepted = inspectStatusResponse("202", "accepted", true);
      if (matchedAccepted) {
        inspectStatusResponse("200", "replay", true);
      }
    }
  }

  return entries;
}

function isVariantIgnored(
  variant: FlattenedObjectVariant,
  entry: OperationResponseEntry,
  ignoreMatcher: RuleIgnoreMatcher,
): boolean {
  for (const schemaName of variant.schemaNames) {
    if (
      ignoreMatcher.isIgnored({
        path: entry.pathTemplate,
        method: entry.method,
        schema: schemaName,
      })
    ) {
      return true;
    }
  }
  return false;
}

function entryPrefix(entry: OperationResponseEntry): string {
  return `${entry.method.toUpperCase()} "${entry.pathTemplate}" (${entry.statusCode} ${entry.mediaType})`;
}

interface SensitiveKeyFinding {
  readonly keyName: string;
  readonly pathLabel: string;
  readonly location?: RedoclyLocation;
}

function findProhibitedCredentialMatchForPattern(pattern: string): string | null {
  if (pattern.length === 0 || pattern.length > 256) {
    return null;
  }
  let regex: RegExp;
  try {
    regex = new RegExp(pattern);
  } catch {
    return null;
  }
  for (const benign of BENIGN_KEY_PROBES) {
    if (regex.test(benign)) {
      return null;
    }
  }
  for (const probe of PROHIBITED_CREDENTIAL_PROBES) {
    if (regex.test(probe)) {
      return probe;
    }
  }
  return null;
}

function scanSchemaForSensitiveCredentialKeys(
  node: unknown,
  location: RedoclyLocation | undefined,
  from: string | undefined,
  pathPrefix: string,
  resolve: ResolverFn,
  seenKeys: Set<string>,
  findings: SensitiveKeyFinding[],
  seen: ReadonlySet<unknown> = new Set(),
): void {
  if (!isRecord(node) || seen.has(node)) {
    return;
  }
  const nextSeen = new Set(seen);
  nextSeen.add(node);

  if (typeof node.$ref === "string") {
    const resolved = safeResolveSchema(resolve, node, from);
    if (resolved && isRecord(resolved.node)) {
      scanSchemaForSensitiveCredentialKeys(
        resolved.node,
        resolved.location,
        resolved.location?.source?.absoluteRef,
        pathPrefix,
        resolve,
        seenKeys,
        findings,
        nextSeen,
      );
    }
  }

  if (isRecord(node.properties)) {
    for (const [propName, propSchema] of Object.entries(node.properties)) {
      const propLocation = location?.child(["properties", propName]);
      const fullPath = pathPrefix ? `${pathPrefix}.${propName}` : propName;
      if (isSensitiveCredentialKey(propName) && !seenKeys.has(fullPath)) {
        seenKeys.add(fullPath);
        findings.push({
          keyName: propName,
          pathLabel: fullPath,
          ...(propLocation ? { location: propLocation } : {}),
        });
      }
      scanSchemaForSensitiveCredentialKeys(
        propSchema,
        propLocation,
        from,
        fullPath,
        resolve,
        seenKeys,
        findings,
        nextSeen,
      );
    }
  }

  if (isRecord(node.patternProperties)) {
    for (const [pattern, patternSchema] of Object.entries(node.patternProperties)) {
      const patternLocation = location?.child(["patternProperties", pattern]);
      const matchedProbe = findProhibitedCredentialMatchForPattern(pattern);
      const patternPath = pathPrefix ? `${pathPrefix}[/${pattern}/]` : `[/${pattern}/]`;
      if (matchedProbe !== null) {
        const dedupeKey = pathPrefix ? `${pathPrefix}.${matchedProbe}` : matchedProbe;
        if (!seenKeys.has(dedupeKey)) {
          seenKeys.add(dedupeKey);
          findings.push({
            keyName: matchedProbe,
            pathLabel: patternPath,
            ...(patternLocation ? { location: patternLocation } : {}),
          });
        }
      }
      scanSchemaForSensitiveCredentialKeys(
        patternSchema,
        patternLocation,
        from,
        patternPath,
        resolve,
        seenKeys,
        findings,
        nextSeen,
      );
    }
  }

  if (isRecord(node.items)) {
    scanSchemaForSensitiveCredentialKeys(
      node.items,
      location?.child(["items"]),
      from,
      `${pathPrefix}[]`,
      resolve,
      seenKeys,
      findings,
      nextSeen,
    );
  }

  if (Array.isArray(node.prefixItems)) {
    for (const [index, item] of node.prefixItems.entries()) {
      scanSchemaForSensitiveCredentialKeys(
        item,
        location?.child(["prefixItems", index]),
        from,
        `${pathPrefix}[${index}]`,
        resolve,
        seenKeys,
        findings,
        nextSeen,
      );
    }
  }

  if (isRecord(node.additionalProperties)) {
    scanSchemaForSensitiveCredentialKeys(
      node.additionalProperties,
      location?.child(["additionalProperties"]),
      from,
      `${pathPrefix}.*`,
      resolve,
      seenKeys,
      findings,
      nextSeen,
    );
  }

  for (const combiner of ["allOf", "oneOf", "anyOf"] as const) {
    const branches = node[combiner];
    if (!Array.isArray(branches)) {
      continue;
    }
    for (const [index, branch] of branches.entries()) {
      scanSchemaForSensitiveCredentialKeys(
        branch,
        location?.child([combiner, index]),
        from,
        pathPrefix,
        resolve,
        seenKeys,
        findings,
        nextSeen,
      );
    }
  }
}

function findSensitiveCredentialKeysInFragments(
  fragments: readonly SchemaFragment[],
  resolve: ResolverFn,
): SensitiveKeyFinding[] {
  const findings: SensitiveKeyFinding[] = [];
  const seenKeys = new Set<string>();
  for (const frag of fragments) {
    scanSchemaForSensitiveCredentialKeys(
      frag.node,
      frag.location,
      frag.from,
      "nextAction",
      resolve,
      seenKeys,
      findings,
    );
  }
  return findings;
}

function findSensitiveCredentialKeysInVariant(
  variant: FlattenedObjectVariant,
  resolve: ResolverFn,
): SensitiveKeyFinding[] {
  const findings: SensitiveKeyFinding[] = [];
  const seenKeys = new Set<string>();

  for (const [propName, prop] of variant.properties.entries()) {
    const fullPath = `nextAction.${propName}`;
    if (isSensitiveCredentialKey(propName) && !seenKeys.has(fullPath)) {
      seenKeys.add(fullPath);
      findings.push({
        keyName: propName,
        pathLabel: fullPath,
        ...(prop.location ? { location: prop.location } : {}),
      });
    }
    for (const frag of prop.fragments) {
      scanSchemaForSensitiveCredentialKeys(
        frag.node,
        frag.location,
        frag.from,
        fullPath,
        resolve,
        seenKeys,
        findings,
      );
    }
  }

  return findings;
}

function validateErrorProblemDetails(
  errorProp: TrackedProperty,
  entry: OperationResponseEntry,
  ctx: RedoclyUserContext,
  reported: Set<string>,
): void {
  const errorTc = propertyTypeConstraint(errorProp, ctx.resolve);
  if (isStrictlyNullConstraint(errorTc)) {
    return;
  }
  const errorLoc = selectPropertyReportLocation(
    errorProp,
    entry.schemaLocation,
    entry.reportBaseLocation,
  );
  if (!allowsOnlyNullOrObject(errorTc)) {
    const badTypes = nonNullTypesOf(errorTc)
      .filter((t) => t !== "object")
      .map((t) => `"${t}"`)
      .join(", ");
    reportOnce(
      ctx,
      reported,
      "error-non-object",
      errorLoc,
      `${entryPrefix(entry)}: Operation "error" must be an RFC 9457 Problem Details object or null, not ${badTypes || "a non-object type"} (ADS-0004).`,
    );
    return;
  }

  const errorCollected = collectPropertyObjectVariants(errorProp, ctx.resolve);
  if (errorCollected.truncated) {
    reportOnce(
      ctx,
      reported,
      "error-variant-cap-exceeded",
      errorLoc,
      `${entryPrefix(entry)}: Operation "error" schema exceeds the ${MAX_OBJECT_VARIANTS}-variant union analysis cap and could not be fully verified (ADS-0004).`,
    );
  }
  const errorVariants = errorCollected.variants.filter(
    (v) => !isStrictlyNullConstraint(v.typeConstraint),
  );
  if (errorVariants.length === 0) {
    return;
  }

  for (const errVariant of errorVariants) {
    if (
      !errVariant.typeConstraint.allowed.has("object") ||
      !allowsOnlyNullOrObject(errVariant.typeConstraint)
    ) {
      reportOnce(
        ctx,
        reported,
        "error-non-object-variant",
        errorLoc,
        `${entryPrefix(entry)}: Operation "error" must be an RFC 9457 Problem Details object when non-null (ADS-0004).`,
      );
      continue;
    }

    const missingFields: string[] = [];
    const optionalFields: string[] = [];
    for (const field of RFC9457_CORE_FIELDS) {
      const prop = errVariant.properties.get(field);
      if (!prop) {
        missingFields.push(field);
        continue;
      }
      if (!errVariant.required.has(field)) {
        optionalFields.push(field);
      }
      const fieldTc = propertyTypeConstraint(prop, ctx.resolve);
      if (field === "status") {
        if (!isNonNullIntegerConstraint(fieldTc)) {
          reportOnce(
            ctx,
            reported,
            `error-field-type:${field}`,
            errorLoc,
            `${entryPrefix(entry)}: Operation "error.status" must be a non-null integer HTTP status code per RFC 9457 (ADS-0004).`,
          );
        }
      } else if (!isNonNullStringConstraint(fieldTc)) {
        reportOnce(
          ctx,
          reported,
          `error-field-type:${field}`,
          errorLoc,
          `${entryPrefix(entry)}: Operation "error.${field}" must be a non-null string per RFC 9457 (ADS-0004).`,
        );
      }
    }

    if (missingFields.length > 0) {
      reportOnce(
        ctx,
        reported,
        `error-missing-fields:${missingFields.join(",")}`,
        errorLoc,
        `${entryPrefix(entry)}: Non-null Operation "error" must be an RFC 9457 Problem Details object defining required fields "type", "title", "status", and "code" (missing: ${missingFields.map((f) => `"${f}"`).join(", ")}) (ADS-0004).`,
      );
    }
    if (optionalFields.length > 0) {
      reportOnce(
        ctx,
        reported,
        `error-optional-fields:${optionalFields.join(",")}`,
        errorLoc,
        `${entryPrefix(entry)}: Operation "error" must mark RFC 9457 core field(s) ${optionalFields.map((f) => `"${f}"`).join(", ")} as required (ADS-0004).`,
      );
    }
  }
}

export const ads0004OperationResourceShape: RedoclyOas3Rule = createRootRule(
  ({ root, ctx, ignoreMatcher }) => {
    const reported = new Set<string>();

    for (const pathEntry of iterateRootPathItems(root, ctx)) {
      const { pathTemplate, pathItem, pathUsageLocation } = pathEntry;
      if (!pathItem) {
        continue;
      }
      const itemParam = extractOperationItemParam(pathTemplate);
      const cancelParam = extractOperationCancelParam(pathTemplate);
      const param = itemParam ?? cancelParam;
      if (!param || param === "operationId") {
        continue;
      }
      const relevantMethod = itemParam !== null ? "get" : "post";
      if (!isRecord(pathItem[relevantMethod])) {
        continue;
      }
      if (ignoreMatcher.isIgnored({ path: pathTemplate, method: relevantMethod })) {
        continue;
      }
      reportOnce(
        ctx,
        reported,
        `path-param:${param}`,
        pathUsageLocation.key(),
        `Operation route "${pathTemplate}" uses path parameter "{${param}}". Long-running operation routes must use "{operationId}" (ADS-0004).`,
      );
    }

    const entries = collectOperationResponses(root, ctx, ignoreMatcher);
    for (const entry of entries) {
      if (entry.truncated) {
        reportOnce(
          ctx,
          reported,
          "variant-cap-exceeded",
          entry.reportBaseLocation,
          `${entryPrefix(entry)}: Operation schema exceeds the ${MAX_OBJECT_VARIANTS}-variant union analysis cap and could not be fully verified (ADS-0004).`,
        );
      }
      for (const variant of entry.variants) {
        if (isVariantIgnored(variant, entry, ignoreMatcher)) {
          continue;
        }
        if (!isNonNullObjectConstraint(variant.typeConstraint)) {
          reportOnce(
            ctx,
            reported,
            "non-object",
            entry.reportBaseLocation,
            `${entryPrefix(entry)}: Operation response must be a non-null flat top-level JSON object (ADS-0004).`,
          );
          continue;
        }

        const wrapperProp = isSingleKeyOperationWrapper(variant, ctx.resolve);
        if (wrapperProp) {
          reportOnce(
            ctx,
            reported,
            "wrapped-operation",
            selectPropertyReportLocation(
              wrapperProp,
              entry.schemaLocation,
              entry.reportBaseLocation,
            ),
            `${entryPrefix(entry)}: Wraps the Operation resource under top-level key "operation". Return Operation fields directly at the top level (ADS-0004).`,
          );
          continue;
        }

        const props = variant.properties;
        const synonymsFound = new Set<string>();

        const checkSynonym = (
          badKey: string,
          canonicalKey: string,
          customMessage: string,
        ): void => {
          const badProp = props.get(badKey);
          if (!badProp) {
            return;
          }
          synonymsFound.add(canonicalKey);
          reportOnce(
            ctx,
            reported,
            `synonym:${badKey}`,
            selectPropertyReportLocation(badProp, entry.schemaLocation, entry.reportBaseLocation),
            `${entryPrefix(entry)}: ${customMessage} (ADS-0004).`,
          );
        };

        if (props.has("operationId")) {
          checkSynonym(
            "operationId",
            "id",
            props.has("id")
              ? 'Operation schema defines "operationId" alongside "id". Use "id" as the primary identifier and qualify any related operation reference (for example "parentOperationId")'
              : 'Operation schema uses "operationId" as its primary identifier without "id". Operation objects must use "id" as their primary identifier field',
          );
        }
        checkSynonym(
          "kind",
          "type",
          'Operation schema defines non-canonical field "kind". Use "type" in "<resource>.<action>" format instead',
        );
        checkSynonym(
          "state",
          "status",
          'Operation schema defines non-canonical field "state". Use "status" as the lifecycle discriminator instead',
        );
        checkSynonym(
          "submittedAt",
          "createdAt",
          'Operation schema defines non-canonical timestamp field "submittedAt". Use "createdAt" instead',
        );
        checkSynonym(
          "resolvedAt",
          "completedAt",
          'Operation schema defines non-canonical timestamp field "resolvedAt". Use "completedAt" instead',
        );
        checkSynonym(
          "endedAt",
          "completedAt",
          'Operation schema defines non-canonical timestamp field "endedAt". Use "completedAt" instead',
        );
        checkSynonym(
          "result",
          "response",
          'Operation schema defines non-canonical field "result". Use "response" for the operation outcome instead',
        );
        checkSynonym(
          "failure",
          "error",
          'Operation schema defines non-canonical field "failure". Use "error" (RFC 9457 Problem Details) instead',
        );

        for (const field of UNIVERSAL_OPERATION_FIELDS) {
          const prop = props.get(field);
          if (!prop) {
            if (!synonymsFound.has(field)) {
              reportOnce(
                ctx,
                reported,
                `missing-field:${field}`,
                entry.reportBaseLocation,
                `${entryPrefix(entry)}: Operation schema is missing required canonical field "${field}" (ADS-0004).`,
              );
            }
            continue;
          }
          if (!variant.required.has(field)) {
            reportOnce(
              ctx,
              reported,
              `optional-field:${field}`,
              selectPropertyReportLocation(prop, entry.schemaLocation, entry.reportBaseLocation),
              `${entryPrefix(entry)}: Operation schema must mark canonical field "${field}" as required (ADS-0004).`,
            );
          }
        }

        const idProp = props.get("id");
        if (idProp && !isNonNullStringConstraint(propertyTypeConstraint(idProp, ctx.resolve))) {
          reportOnce(
            ctx,
            reported,
            "field-type:id",
            selectPropertyReportLocation(idProp, entry.schemaLocation, entry.reportBaseLocation),
            `${entryPrefix(entry)}: Operation "id" must be a non-null string (ADS-0004).`,
          );
        }

        const typeProp = props.get("type");
        if (typeProp && !isNonNullStringConstraint(propertyTypeConstraint(typeProp, ctx.resolve))) {
          reportOnce(
            ctx,
            reported,
            "field-type:type",
            selectPropertyReportLocation(typeProp, entry.schemaLocation, entry.reportBaseLocation),
            `${entryPrefix(entry)}: Operation "type" must be a non-null string (ADS-0004).`,
          );
        }

        const statusProp = props.get("status");
        if (statusProp) {
          const statusLoc = selectPropertyReportLocation(
            statusProp,
            entry.schemaLocation,
            entry.reportBaseLocation,
          );
          const statusTc = propertyTypeConstraint(statusProp, ctx.resolve);
          if (!isNonNullStringConstraint(statusTc)) {
            reportOnce(
              ctx,
              reported,
              "field-type:status",
              statusLoc,
              `${entryPrefix(entry)}: Operation "status" must be a non-null string (ADS-0004).`,
            );
          } else {
            const literals = propertyStringLiterals(statusProp, ctx.resolve);
            if (literals.kind === "unconstrained") {
              reportOnce(
                ctx,
                reported,
                "status-unconstrained",
                statusLoc,
                `${entryPrefix(entry)}: Operation "status" must declare explicit enum or const value(s) from the canonical vocabulary (${CANONICAL_OPERATION_STATUSES.join(", ")}) (ADS-0004).`,
              );
            } else {
              const invalid = [...literals.values]
                .filter((v) => !isCanonicalOperationStatus(v))
                .sort();
              if (invalid.length > 0 || literals.hasNonString || literals.values.size === 0) {
                const formatted =
                  invalid.length > 0 ? invalid.map((v) => `"${v}"`).join(", ") : "non-string value";
                reportOnce(
                  ctx,
                  reported,
                  `status-invalid:${formatted}`,
                  statusLoc,
                  `${entryPrefix(entry)}: Operation "status" declares non-canonical value(s) ${formatted}. Status values must be a subset of: ${CANONICAL_OPERATION_STATUSES.join(", ")} (ADS-0004).`,
                );
              }
            }
          }
        }

        for (const tsField of ["createdAt", "updatedAt"] as const) {
          const prop = props.get(tsField);
          if (!prop) {
            continue;
          }
          const loc = selectPropertyReportLocation(
            prop,
            entry.schemaLocation,
            entry.reportBaseLocation,
          );
          const tc = propertyTypeConstraint(prop, ctx.resolve);
          if (
            !isNonNullStringConstraint(tc) ||
            propertyStringFormat(prop, "date-time", ctx.resolve) !== "yes"
          ) {
            reportOnce(
              ctx,
              reported,
              `timestamp:${tsField}`,
              loc,
              `${entryPrefix(entry)}: Operation "${tsField}" must be a non-null RFC 3339 timestamp string with "format: date-time" (ADS-0004).`,
            );
          }
        }

        for (const nullableTsField of ["completedAt", "startedAt"] as const) {
          const prop = props.get(nullableTsField);
          if (!prop) {
            continue;
          }
          const tc = propertyTypeConstraint(prop, ctx.resolve);
          if (isStrictlyNullConstraint(tc)) {
            continue;
          }
          const loc = selectPropertyReportLocation(
            prop,
            entry.schemaLocation,
            entry.reportBaseLocation,
          );
          if (
            !allowsOnlyNullOrString(tc) ||
            propertyStringFormat(prop, "date-time", ctx.resolve) !== "yes"
          ) {
            reportOnce(
              ctx,
              reported,
              `timestamp:${nullableTsField}`,
              loc,
              `${entryPrefix(entry)}: Operation "${nullableTsField}" must be an RFC 3339 timestamp string with "format: date-time" when non-null (ADS-0004).`,
            );
          }
        }

        const cancellableProp = props.get("cancellable");
        if (
          cancellableProp &&
          !isNonNullBooleanConstraint(propertyTypeConstraint(cancellableProp, ctx.resolve))
        ) {
          reportOnce(
            ctx,
            reported,
            "field-type:cancellable",
            selectPropertyReportLocation(
              cancellableProp,
              entry.schemaLocation,
              entry.reportBaseLocation,
            ),
            `${entryPrefix(entry)}: Operation "cancellable" must be a non-null boolean (ADS-0004).`,
          );
        }

        const metadataProp = props.get("metadata");
        if (metadataProp) {
          const metaTc = propertyTypeConstraint(metadataProp, ctx.resolve);
          if (!allowsOnlyNullOrObject(metaTc)) {
            reportOnce(
              ctx,
              reported,
              "field-type:metadata",
              selectPropertyReportLocation(
                metadataProp,
                entry.schemaLocation,
                entry.reportBaseLocation,
              ),
              `${entryPrefix(entry)}: Operation "metadata" must be a structured JSON object (ADS-0004).`,
            );
          }
        }

        const errorProp = props.get("error");
        if (errorProp) {
          validateErrorProblemDetails(errorProp, entry, ctx, reported);
        }
      }
    }
  },
);

function validateRequiresActionNextAction(
  nextActionProp: TrackedProperty,
  entry: OperationResponseEntry,
  ctx: RedoclyUserContext,
  reported: Set<string>,
): void {
  const nextActionLoc = selectPropertyReportLocation(
    nextActionProp,
    entry.schemaLocation,
    entry.reportBaseLocation,
  );
  const nextActionTc = propertyTypeConstraint(nextActionProp, ctx.resolve);
  if (allowsNullConstraint(nextActionTc) || !isNonNullObjectConstraint(nextActionTc)) {
    reportOnce(
      ctx,
      reported,
      "requires-action-next-action-type",
      nextActionLoc,
      `${entryPrefix(entry)}: Operation "requires_action" branch must declare "nextAction" as a non-null structured object (ADS-0004).`,
    );
    return;
  }

  const reportSensitiveFindings = (findings: readonly SensitiveKeyFinding[]): void => {
    for (const finding of findings) {
      const loc =
        finding.location &&
        finding.location.source?.absoluteRef === entry.reportBaseLocation.source?.absoluteRef &&
        finding.location.pointer.startsWith(`${entry.schemaLocation.pointer}/`)
          ? finding.location.key()
          : nextActionLoc;
      reportOnce(
        ctx,
        reported,
        `next-action-sensitive:${finding.pathLabel}`,
        loc,
        `${entryPrefix(entry)}: Operation "nextAction" exposes sensitive credential key "${finding.keyName}" (${finding.pathLabel}). Pollable GET operation responses must not include high-sensitivity credentials (ADS-0004).`,
      );
    }
  };

  reportSensitiveFindings(
    findSensitiveCredentialKeysInFragments(nextActionProp.fragments, ctx.resolve),
  );

  const actionCollected = collectPropertyObjectVariants(nextActionProp, ctx.resolve);
  if (actionCollected.truncated) {
    reportOnce(
      ctx,
      reported,
      "next-action-variant-cap-exceeded",
      nextActionLoc,
      `${entryPrefix(entry)}: Operation "nextAction" schema exceeds the ${MAX_OBJECT_VARIANTS}-variant union analysis cap and could not be fully verified (ADS-0004).`,
    );
  }
  for (const actionVariant of actionCollected.variants) {
    if (!isNonNullObjectConstraint(actionVariant.typeConstraint)) {
      reportOnce(
        ctx,
        reported,
        "next-action-non-object-branch",
        nextActionLoc,
        `${entryPrefix(entry)}: Every "nextAction" variant on "requires_action" must be a non-null structured object (ADS-0004).`,
      );
      continue;
    }

    reportSensitiveFindings(findSensitiveCredentialKeysInVariant(actionVariant, ctx.resolve));

    const actionProps = actionVariant.properties;
    let hasTypeSynonym = false;
    for (const badTypeKey of ["kind", "action"] as const) {
      if (actionProps.has(badTypeKey)) {
        hasTypeSynonym = true;
        reportOnce(
          ctx,
          reported,
          `next-action-type-synonym:${badTypeKey}`,
          nextActionLoc,
          `${entryPrefix(entry)}: Operation "nextAction" uses non-canonical discriminator "${badTypeKey}". Use "type" with a snake_case literal or enum instead (ADS-0004).`,
        );
      }
    }

    const actionTypeProp = actionProps.get("type");
    let actionTypeValues: readonly string[] = [];
    if (!actionTypeProp) {
      if (!hasTypeSynonym) {
        reportOnce(
          ctx,
          reported,
          "next-action-missing-type",
          nextActionLoc,
          `${entryPrefix(entry)}: Operation "nextAction" must declare required "type" discriminator (snake_case string literal or enum) (ADS-0004).`,
        );
      }
    } else {
      if (!actionVariant.required.has("type")) {
        reportOnce(
          ctx,
          reported,
          "next-action-optional-type",
          nextActionLoc,
          `${entryPrefix(entry)}: Operation "nextAction" must mark "type" as required (ADS-0004).`,
        );
      }
      const actionTypeTc = propertyTypeConstraint(actionTypeProp, ctx.resolve);
      if (!isNonNullStringConstraint(actionTypeTc)) {
        reportOnce(
          ctx,
          reported,
          "next-action-type-not-string",
          nextActionLoc,
          `${entryPrefix(entry)}: Operation "nextAction.type" must be a non-null string (ADS-0004).`,
        );
      } else {
        const typeLits = propertyStringLiterals(actionTypeProp, ctx.resolve);
        if (typeLits.kind === "unconstrained") {
          reportOnce(
            ctx,
            reported,
            "next-action-type-unconstrained",
            nextActionLoc,
            `${entryPrefix(entry)}: Operation "nextAction.type" must declare explicit snake_case literal or enum value(s) (ADS-0004).`,
          );
        } else {
          actionTypeValues = [...typeLits.values].sort();
          const badValues = actionTypeValues.filter((v) => !isSnakeCaseActionType(v));
          if (badValues.length > 0 || typeLits.hasNonString || actionTypeValues.length === 0) {
            const formatted =
              badValues.length > 0 ? badValues.map((v) => `"${v}"`).join(", ") : "non-string value";
            reportOnce(
              ctx,
              reported,
              `next-action-type-casing:${formatted}`,
              nextActionLoc,
              `${entryPrefix(entry)}: Operation "nextAction.type" value(s) ${formatted} must use snake_case (for example "redirect", "confirm_payment", or "verify_dns") (ADS-0004).`,
            );
          }
        }
      }
    }

    for (const badExpiryKey of ["deadline", "validUntil"] as const) {
      if (actionProps.has(badExpiryKey)) {
        reportOnce(
          ctx,
          reported,
          `next-action-expiry-synonym:${badExpiryKey}`,
          nextActionLoc,
          `${entryPrefix(entry)}: Operation "nextAction" uses non-canonical expiration field "${badExpiryKey}". Use "expiresAt" with "format: date-time" instead (ADS-0004).`,
        );
      }
    }

    const expiresAtProp = actionProps.get("expiresAt");
    if (expiresAtProp) {
      const expiresAtTc = propertyTypeConstraint(expiresAtProp, ctx.resolve);
      if (
        !isStrictlyNullConstraint(expiresAtTc) &&
        (!allowsOnlyNullOrString(expiresAtTc) ||
          propertyStringFormat(expiresAtProp, "date-time", ctx.resolve) !== "yes")
      ) {
        reportOnce(
          ctx,
          reported,
          "next-action-expires-at-format",
          nextActionLoc,
          `${entryPrefix(entry)}: Operation "nextAction.expiresAt" must be an RFC 3339 timestamp string with "format: date-time" when non-null (ADS-0004).`,
        );
      }
    }

    if (actionProps.has("message")) {
      reportOnce(
        ctx,
        reported,
        "next-action-free-text-message",
        nextActionLoc,
        `${entryPrefix(entry)}: Operation "nextAction" defines free-text field "message". Carry structured machine-readable fields and document static prose in OpenAPI descriptions instead (ADS-0004).`,
      );
    }

    if (actionTypeValues.includes("redirect")) {
      const urlProp = actionProps.get("url");
      if (!urlProp) {
        reportOnce(
          ctx,
          reported,
          "next-action-redirect-missing-url",
          nextActionLoc,
          `${entryPrefix(entry)}: Operation "nextAction" variant "redirect" must declare required "url" string with "format: uri" (ADS-0004).`,
        );
      } else {
        if (!actionVariant.required.has("url")) {
          reportOnce(
            ctx,
            reported,
            "next-action-redirect-optional-url",
            nextActionLoc,
            `${entryPrefix(entry)}: Operation "nextAction" variant "redirect" must mark "url" as required (ADS-0004).`,
          );
        }
        const urlTc = propertyTypeConstraint(urlProp, ctx.resolve);
        if (
          !isNonNullStringConstraint(urlTc) ||
          propertyStringFormat(urlProp, "uri", ctx.resolve) !== "yes"
        ) {
          reportOnce(
            ctx,
            reported,
            "next-action-redirect-url-format",
            nextActionLoc,
            `${entryPrefix(entry)}: Operation "nextAction" variant "redirect" must declare "url" as a non-null string with "format: uri" (ADS-0004).`,
          );
        }
      }
    }
  }
}

function extractActionTypeLiterals(
  variant: FlattenedObjectVariant,
  resolve: ResolverFn,
): ReadonlySet<string> | null {
  const nextActionProp = variant.properties.get("nextAction");
  if (!nextActionProp) {
    return null;
  }
  const actionCollected = collectPropertyObjectVariants(nextActionProp, resolve);
  if (actionCollected.variants.length === 0) {
    return null;
  }
  const types = new Set<string>();
  for (const actionVariant of actionCollected.variants) {
    const typeProp = actionVariant.properties.get("type");
    if (!typeProp) {
      return null;
    }
    const lit = propertyStringLiterals(typeProp, resolve);
    if (lit.kind !== "values" || lit.values.size === 0) {
      return null;
    }
    for (const value of lit.values) {
      types.add(value);
    }
  }
  return types.size > 0 ? types : null;
}

function setsIntersect(a: ReadonlySet<string>, b: ReadonlySet<string>): boolean {
  for (const item of a) {
    if (b.has(item)) {
      return true;
    }
  }
  return false;
}

function areVariantsDisjointOnOtherFields(
  a: FlattenedObjectVariant,
  b: FlattenedObjectVariant,
  resolve: ResolverFn,
): boolean {
  const aTypeProp = a.properties.get("type");
  const bTypeProp = b.properties.get("type");
  if (aTypeProp && bTypeProp) {
    const aTypeLit = propertyStringLiterals(aTypeProp, resolve);
    const bTypeLit = propertyStringLiterals(bTypeProp, resolve);
    if (
      aTypeLit.kind === "values" &&
      bTypeLit.kind === "values" &&
      aTypeLit.values.size > 0 &&
      bTypeLit.values.size > 0 &&
      !setsIntersect(aTypeLit.values, bTypeLit.values)
    ) {
      return true;
    }
  }

  for (const key of a.required) {
    if (key === "status" || !b.required.has(key)) {
      continue;
    }
    const aProp = a.properties.get(key);
    const bProp = b.properties.get(key);
    if (!aProp || !bProp) {
      continue;
    }
    const aTc = propertyTypeConstraint(aProp, resolve);
    const bTc = propertyTypeConstraint(bProp, resolve);
    if (
      aTc.allowed.size > 0 &&
      bTc.allowed.size > 0 &&
      combineTypeConstraintAllOf(aTc, bTc).allowed.size === 0
    ) {
      return true;
    }
    const aExact = propertyExactLiterals(aProp, resolve);
    const bExact = propertyExactLiterals(bProp, resolve);
    if (
      aExact.kind === "values" &&
      bExact.kind === "values" &&
      aExact.values.size > 0 &&
      bExact.values.size > 0 &&
      !setsIntersect(aExact.values, bExact.values)
    ) {
      return true;
    }
  }

  const aActionTypes = extractActionTypeLiterals(a, resolve);
  const bActionTypes = extractActionTypeLiterals(b, resolve);
  if (aActionTypes && bActionTypes && !setsIntersect(aActionTypes, bActionTypes)) {
    return true;
  }

  return false;
}

function shareDifferentOneOfBranch(a: FlattenedObjectVariant, b: FlattenedObjectVariant): boolean {
  for (const [oneOfId, aBranches] of a.oneOfBranches.entries()) {
    const bBranches = b.oneOfBranches.get(oneOfId);
    if (!bBranches) {
      continue;
    }
    for (const aIdx of aBranches) {
      for (const bIdx of bBranches) {
        if (aIdx !== bIdx) {
          return true;
        }
      }
    }
  }
  return false;
}

export const ads0004OperationStatusInvariants: RedoclyOas3Rule = createRootRule(
  ({ root, ctx, ignoreMatcher }) => {
    const entries = collectOperationResponses(root, ctx, ignoreMatcher);
    const reported = new Set<string>();

    for (const entry of entries) {
      if (entry.truncated) {
        reportOnce(
          ctx,
          reported,
          "variant-cap-exceeded",
          entry.reportBaseLocation,
          `${entryPrefix(entry)}: Operation schema exceeds the ${MAX_OBJECT_VARIANTS}-variant union analysis cap and could not be fully verified (ADS-0004).`,
        );
      }

      const checkedVariants: {
        readonly variant: FlattenedObjectVariant;
        readonly statuses: readonly CanonicalOperationStatus[];
      }[] = [];

      for (const variant of entry.variants) {
        if (isVariantIgnored(variant, entry, ignoreMatcher)) {
          continue;
        }
        if (
          !isNonNullObjectConstraint(variant.typeConstraint) ||
          isSingleKeyOperationWrapper(variant, ctx.resolve)
        ) {
          continue;
        }

        const statusProp = variant.properties.get("status");
        if (!statusProp) {
          continue;
        }
        const statusLits = propertyStringLiterals(statusProp, ctx.resolve);
        if (statusLits.kind !== "values" || statusLits.values.size === 0) {
          continue;
        }
        const statuses = [...statusLits.values]
          .filter((v): v is CanonicalOperationStatus => isCanonicalOperationStatus(v))
          .sort();
        if (statuses.length === 0) {
          continue;
        }

        checkedVariants.push({ variant, statuses });

        for (const branchSet of variant.oneOfBranches.values()) {
          if (branchSet.size >= 2) {
            for (const overlapStatus of statuses) {
              reportOnce(
                ctx,
                reported,
                `oneof-status-overlap:${overlapStatus}`,
                entry.reportBaseLocation,
                `${entryPrefix(entry)}: Operation "oneOf" union matches status "${overlapStatus}" in multiple branches. Each status value in a discriminated "oneOf" union must match at most one branch (ADS-0004).`,
              );
            }
          }
        }

        const hasRequiresAction = statuses.includes("requires_action");
        const hasNonRequiresAction = statuses.some((s) => s !== "requires_action");
        const hasNonTerminal = statuses.some((s) => NON_TERMINAL_STATUS_SET.has(s));
        const hasTerminal = statuses.some((s) => TERMINAL_STATUS_SET.has(s));
        const hasFailed = statuses.includes("failed");
        const hasNonFailedTerminal = statuses.some((s) => s === "succeeded" || s === "cancelled");
        const hasSucceeded = statuses.includes("succeeded");
        const hasCancelled = statuses.includes("cancelled");

        if (hasRequiresAction && hasNonRequiresAction) {
          const others = statuses.filter((s) => s !== "requires_action").join(", ");
          reportOnce(
            ctx,
            reported,
            `mixed-requires-action:${statuses.join(",")}`,
            entry.reportBaseLocation,
            `${entryPrefix(entry)}: Operation variant combines "requires_action" with other status value(s) (${others}). Split "requires_action" into its own discriminated branch so "nextAction" is required and non-null exclusively when status is "requires_action" (ADS-0004).`,
          );
          continue;
        }

        if (hasNonTerminal && hasTerminal) {
          reportOnce(
            ctx,
            reported,
            `mixed-terminal:${statuses.join(",")}`,
            entry.reportBaseLocation,
            `${entryPrefix(entry)}: Operation variant mixes non-terminal and terminal statuses (${statuses.join(", ")}). Model the Operation as a discriminated union on "status" so non-terminal and terminal invariants hold per branch (ADS-0004).`,
          );
          continue;
        }

        if (hasFailed && hasNonFailedTerminal) {
          reportOnce(
            ctx,
            reported,
            `mixed-failed:${statuses.join(",")}`,
            entry.reportBaseLocation,
            `${entryPrefix(entry)}: Operation variant mixes "failed" with other terminal statuses (${statuses.join(", ")}). Split "failed" into its own discriminated branch so "error" is non-null exclusively when status is "failed" (ADS-0004).`,
          );
          continue;
        }

        const completedAtProp = variant.properties.get("completedAt");
        const responseProp = variant.properties.get("response");
        const errorProp = variant.properties.get("error");
        const nextActionProp = variant.properties.get("nextAction");

        if (hasRequiresAction) {
          if (!nextActionProp) {
            reportOnce(
              ctx,
              reported,
              "requires-action-missing-next-action",
              entry.reportBaseLocation,
              `${entryPrefix(entry)}: Operation "requires_action" branch must declare a required non-null "nextAction" object (ADS-0004).`,
            );
          } else {
            if (!variant.required.has("nextAction")) {
              reportOnce(
                ctx,
                reported,
                "requires-action-optional-next-action",
                selectPropertyReportLocation(
                  nextActionProp,
                  entry.schemaLocation,
                  entry.reportBaseLocation,
                ),
                `${entryPrefix(entry)}: Operation "requires_action" branch must mark "nextAction" as required (ADS-0004).`,
              );
            }
            validateRequiresActionNextAction(nextActionProp, entry, ctx, reported);
          }
        } else if (nextActionProp) {
          const nextActionTc = propertyTypeConstraint(nextActionProp, ctx.resolve);
          if (allowsNonNullConstraint(nextActionTc)) {
            reportOnce(
              ctx,
              reported,
              `non-requires-action-next-action:${statuses.join(",")}`,
              selectPropertyReportLocation(
                nextActionProp,
                entry.schemaLocation,
                entry.reportBaseLocation,
              ),
              `${entryPrefix(entry)}: Operation branch (${statuses.join(", ")}) allows non-null "nextAction". "nextAction" must be null (or omitted) on every status other than "requires_action" (ADS-0004).`,
            );
          }
        }

        if (hasNonTerminal) {
          for (const nullField of ["completedAt", "response", "error"] as const) {
            const prop = variant.properties.get(nullField);
            if (!prop) {
              continue;
            }
            const tc = propertyTypeConstraint(prop, ctx.resolve);
            if (allowsNonNullConstraint(tc)) {
              reportOnce(
                ctx,
                reported,
                `non-terminal-non-null:${statuses.join(",")}:${nullField}`,
                selectPropertyReportLocation(prop, entry.schemaLocation, entry.reportBaseLocation),
                `${entryPrefix(entry)}: Non-terminal Operation branch (${statuses.join(", ")}) must constrain "${nullField}" to null (ADS-0004).`,
              );
            }
          }
          continue;
        }

        if (completedAtProp) {
          const completedAtTc = propertyTypeConstraint(completedAtProp, ctx.resolve);
          if (allowsNullConstraint(completedAtTc) || !isNonNullStringConstraint(completedAtTc)) {
            reportOnce(
              ctx,
              reported,
              `terminal-completed-at:${statuses.join(",")}`,
              selectPropertyReportLocation(
                completedAtProp,
                entry.schemaLocation,
                entry.reportBaseLocation,
              ),
              `${entryPrefix(entry)}: Terminal Operation branch (${statuses.join(", ")}) must constrain "completedAt" to a non-null RFC 3339 date-time string (ADS-0004).`,
            );
          }
        }

        if (hasFailed) {
          if (errorProp) {
            const errorTc = propertyTypeConstraint(errorProp, ctx.resolve);
            if (allowsNullConstraint(errorTc) || !isNonNullObjectConstraint(errorTc)) {
              reportOnce(
                ctx,
                reported,
                "failed-error-nullable",
                selectPropertyReportLocation(
                  errorProp,
                  entry.schemaLocation,
                  entry.reportBaseLocation,
                ),
                `${entryPrefix(entry)}: Operation "failed" branch must require a non-null RFC 9457 Problem Details object in "error" (ADS-0004).`,
              );
            }
          }
          if (responseProp) {
            const responseTc = propertyTypeConstraint(responseProp, ctx.resolve);
            if (allowsNonNullConstraint(responseTc)) {
              reportOnce(
                ctx,
                reported,
                "failed-response-non-null",
                selectPropertyReportLocation(
                  responseProp,
                  entry.schemaLocation,
                  entry.reportBaseLocation,
                ),
                `${entryPrefix(entry)}: Operation "failed" branch must constrain "response" to null (ADS-0004).`,
              );
            }
          }
          continue;
        }

        if (errorProp) {
          const errorTc = propertyTypeConstraint(errorProp, ctx.resolve);
          if (allowsNonNullConstraint(errorTc)) {
            reportOnce(
              ctx,
              reported,
              `terminal-error-non-null:${statuses.join(",")}`,
              selectPropertyReportLocation(
                errorProp,
                entry.schemaLocation,
                entry.reportBaseLocation,
              ),
              `${entryPrefix(entry)}: Operation branch (${statuses.join(", ")}) must constrain "error" to null (ADS-0004).`,
            );
          }
        }

        if (hasCancelled && responseProp) {
          const responseTc = propertyTypeConstraint(responseProp, ctx.resolve);
          if (allowsNonNullConstraint(responseTc)) {
            reportOnce(
              ctx,
              reported,
              hasSucceeded ? "mixed-succeeded-cancelled-response" : "cancelled-response-non-null",
              selectPropertyReportLocation(
                responseProp,
                entry.schemaLocation,
                entry.reportBaseLocation,
              ),
              hasSucceeded
                ? `${entryPrefix(entry)}: Operation variant combines "succeeded" and "cancelled" with a non-null "response". Split "cancelled" into its own branch with "response: null" (ADS-0004).`
                : `${entryPrefix(entry)}: Operation "cancelled" branch must constrain "response" to null (ADS-0004).`,
            );
          }
        }
      }

      for (let i = 0; i < checkedVariants.length; i += 1) {
        const left = checkedVariants[i];
        if (!left) {
          continue;
        }
        for (let j = i + 1; j < checkedVariants.length; j += 1) {
          const right = checkedVariants[j];
          if (!right || !shareDifferentOneOfBranch(left.variant, right.variant)) {
            continue;
          }
          const overlappingStatuses = left.statuses.filter((status) =>
            right.statuses.includes(status),
          );
          if (overlappingStatuses.length === 0) {
            continue;
          }
          if (areVariantsDisjointOnOtherFields(left.variant, right.variant, ctx.resolve)) {
            continue;
          }
          for (const overlapStatus of overlappingStatuses) {
            reportOnce(
              ctx,
              reported,
              `oneof-status-overlap:${overlapStatus}`,
              entry.reportBaseLocation,
              `${entryPrefix(entry)}: Operation "oneOf" union matches status "${overlapStatus}" in multiple branches. Each status value in a discriminated "oneOf" union must match at most one branch (ADS-0004).`,
            );
          }
        }
      }
    }
  },
);

function responseHasLocationHeader(responseNode: UnknownRecord): boolean {
  if (!isRecord(responseNode.headers)) {
    return false;
  }
  for (const [headerName, headerDef] of Object.entries(responseNode.headers)) {
    if (headerName.toLowerCase() === "location" && isRecord(headerDef)) {
      return true;
    }
  }
  return false;
}

export const ads0004AcceptedOperationHeaders: RedoclyOas3Rule = createRootRule(
  ({ root, ctx, ignoreMatcher, reportOnce: report }) => {
    const entries = collectOperationResponses(root, ctx, ignoreMatcher);

    for (const entry of entries) {
      if (entry.kind !== "accepted") {
        continue;
      }
      if (
        entry.variants.length > 0 &&
        entry.variants.every((variant) => isVariantIgnored(variant, entry, ignoreMatcher))
      ) {
        continue;
      }
      if (responseHasLocationHeader(entry.responseNode)) {
        continue;
      }
      report(
        `missing-location:${entry.pathTemplate}:${entry.method}`,
        entry.reportBaseLocation,
        `${entryPrefix(entry)}: 202 Accepted Operation response must declare a "Location" header pointing to the canonical poll URL ("GET <scope>/operations/{operationId}") (ADS-0004).`,
      );
    }
  },
);

export const ads0004OperationCancelMethod: RedoclyOas3Rule = createRootRule(
  ({ root, ctx, ignoreMatcher, reportOnce: report }) => {
    for (const pathEntry of iterateRootPathItems(root, ctx)) {
      const { pathTemplate, pathItem } = pathEntry;
      if (!pathItem) {
        continue;
      }
      const isDeleteTarget = isOperationDeletePath(pathTemplate);
      const isCancelTarget = extractOperationCancelParam(pathTemplate) !== null;
      if (!isDeleteTarget && !isCancelTarget) {
        continue;
      }

      if (
        isDeleteTarget &&
        isRecord(pathItem.delete) &&
        !ignoreMatcher.isIgnored({ path: pathTemplate, method: "delete" })
      ) {
        report(
          `forbid-delete:${pathTemplate}`,
          pathEntry.operationReportLocation("delete"),
          `DELETE "${pathTemplate}" is not allowed on operation endpoints. Cancellation must use POST ".../operations/{operationId}/cancel" instead of DELETE (ADS-0004).`,
        );
      }

      if (
        isCancelTarget &&
        isRecord(pathItem.post) &&
        !ignoreMatcher.isIgnored({ path: pathTemplate, method: "post" })
      ) {
        const postOp = pathItem.post;
        const responses = isRecord(postOp.responses) ? postOp.responses : null;
        const postLoc = pathEntry.operationLocation("post");
        const has200Json =
          responses !== null &&
          extractOperationJsonResponseSchemas(
            postOp,
            postLoc,
            ctx.resolve,
            isRecord(responses["200"]) ? ["200"] : ["2XX"],
          ).length > 0;

        if (!has200Json) {
          const postReportLoc = pathEntry.isOperationFromRef("post")
            ? pathEntry.pathUsageLocation.key()
            : responses
              ? postLoc.child(["responses"]).key()
              : postLoc.key();
          report(
            `cancel-missing-200:${pathTemplate}`,
            postReportLoc,
            `POST "${pathTemplate}" must declare a 200 JSON response returning the updated Operation resource (ADS-0004).`,
          );
        }
      }
    }
  },
);

export const ads0004Rules: Record<string, RedoclyOas3Rule> = {
  "ads-0004-operation-resource-shape": ads0004OperationResourceShape,
  "ads-0004-operation-status-invariants": ads0004OperationStatusInvariants,
  "ads-0004-accepted-operation-headers": ads0004AcceptedOperationHeaders,
  "ads-0004-operation-cancel-method": ads0004OperationCancelMethod,
};
