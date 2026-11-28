import { describe, expect, it } from "vitest";
import {
  COMPAT_VARIANT_OPTIONS,
  checkPatchObjectVariantConstraints,
  checkResponseCompatibleWithCanonical,
  checkVariantAgainstCanonicalVariants,
  collectArrayItemBranches,
  collectNestedOpenPatchObjectPaths,
  compareFragmentsAgainstTargets,
  extractCollectionInfo,
  isTypeSubset,
  SERVER_MANAGED_CREATE_KEYS,
  SERVER_MANAGED_MUTATION_KEYS,
} from "./resource-compat.js";
import type { ResolverFn } from "./schema-utils.js";
import { collectFlattenedObjectVariants } from "./schema-variants.js";
import type { RedoclyLocation } from "./types.js";

function makeLocation(pointer: string, absoluteRef = "openapi.yaml"): RedoclyLocation {
  const loc: RedoclyLocation = {
    source: { absoluteRef },
    pointer,
    absolutePointer: `${absoluteRef}#${pointer}`,
    child(keys) {
      const parts = Array.isArray(keys) ? keys : [keys];
      const escaped = parts.map((k) => String(k).replaceAll("~", "~0").replaceAll("/", "~1"));
      return makeLocation(`${pointer}/${escaped.join("/")}`, absoluteRef);
    },
    key() {
      return loc;
    },
  };
  return loc;
}

function makeResolver(targets: Record<string, { node: unknown; pointer: string }>): ResolverFn {
  return (<T = unknown>(node: { $ref: string }) => {
    const target = targets[node.$ref];
    if (!target) {
      return { error: new Error(`Unresolved: ${node.$ref}`) };
    }
    return {
      node: target.node as T,
      location: makeLocation(target.pointer),
    };
  }) as ResolverFn;
}

function firstVariant(schema: unknown, resolve: ResolverFn) {
  const variant = collectFlattenedObjectVariants(schema, resolve).variants[0];
  if (!variant) {
    throw new Error("Expected at least one flattened object variant");
  }
  return variant;
}

describe("shared resource compatibility helpers", () => {
  it("evaluates JSON type subsetting including integer <= number and nullability", () => {
    expect(isTypeSubset(new Set(["integer"]), new Set(["number"]))).toBe(true);
    expect(isTypeSubset(new Set(["string"]), new Set(["string", "null"]))).toBe(true);
    expect(isTypeSubset(new Set(["string", "null"]), new Set(["string"]))).toBe(false);
    expect(isTypeSubset(new Set(["number"]), new Set(["integer"]))).toBe(false);
    expect(isTypeSubset(new Set(), new Set(["string"]))).toBe(false);
  });

  it("checks RFC 7396 PATCH constraints on object variants", () => {
    const resolve = makeResolver({});

    expect(
      checkPatchObjectVariantConstraints(
        firstVariant(
          {
            type: "object",
            additionalProperties: false,
            properties: { name: { type: "string" } },
          },
          resolve,
        ),
      ),
    ).toEqual([]);

    expect(
      checkPatchObjectVariantConstraints(
        firstVariant({ type: "object", additionalProperties: { type: "string" } }, resolve),
      ),
    ).toEqual([]);

    expect(
      checkPatchObjectVariantConstraints(
        firstVariant(
          {
            oneOf: [
              {
                type: "object",
                unevaluatedProperties: false,
                required: ["kind"],
                properties: { kind: { type: "string", const: "sms" }, sender: { type: "string" } },
              },
            ],
            discriminator: { propertyName: "kind" },
          },
          resolve,
        ),
      ),
    ).toEqual([]);

    expect(
      checkPatchObjectVariantConstraints(
        firstVariant(
          {
            type: "object",
            required: ["name"],
            properties: { name: { type: "string" } },
          },
          resolve,
        ),
      ),
    ).toEqual([
      { kind: "required", disallowedRequired: ["name"] },
      { kind: "additional-properties" },
    ]);
  });

  it("compares nested objects, array items, typed additionalProperties, readOnly, and cycles", () => {
    const cyclicNode: Record<string, unknown> = {
      type: "object",
      properties: {
        name: { type: "string" },
        child: { $ref: "#/components/schemas/Node" },
      },
    };
    const resolve = makeResolver({
      "#/components/schemas/Node": {
        node: cyclicNode,
        pointer: "#/components/schemas/Node",
      },
    });

    const cyclicMismatch = compareFragmentsAgainstTargets(
      [{ node: cyclicNode }],
      [[{ node: cyclicNode }]],
      resolve,
      { path: "node", forbidReadOnly: false, depth: 0 },
    );
    expect(cyclicMismatch).toBeNull();

    const canonicalMetadata = collectFlattenedObjectVariants(
      {
        type: "object",
        properties: {
          metadata: {
            type: "object",
            properties: {
              email: { type: "object", properties: { subject: { type: "string" } } },
            },
            additionalProperties: { type: "object", additionalProperties: {} },
          },
          tags: { type: "array", items: { type: "string" } },
          id: { type: "string", readOnly: true },
        },
      },
      resolve,
    ).variants;

    const okMetadataSource = firstVariant(
      {
        type: "object",
        properties: {
          metadata: {
            type: "object",
            properties: {
              caption: { type: "object", properties: { text: { type: "string" } } },
            },
          },
          tags: { type: "array", items: { type: "string" } },
        },
      },
      resolve,
    );
    expect(
      checkVariantAgainstCanonicalVariants(okMetadataSource, canonicalMetadata, resolve, {
        forbidReadOnly: true,
        serverManagedKeys: SERVER_MANAGED_MUTATION_KEYS,
      }),
    ).toEqual([]);

    const badMetadataSource = firstVariant(
      {
        type: "object",
        properties: {
          metadata: {
            type: "object",
            properties: { caption: { type: "integer" } },
          },
          tags: { type: "array", items: { type: "integer" } },
          id: { type: "string" },
        },
      },
      resolve,
    );
    const mismatches = checkVariantAgainstCanonicalVariants(
      badMetadataSource,
      canonicalMetadata,
      resolve,
      {
        forbidReadOnly: true,
        serverManagedKeys: SERVER_MANAGED_CREATE_KEYS,
      },
    );
    expect(mismatches.map((m) => m.path)).toEqual(["id", "metadata.caption", "tags[]"]);
  });

  it("validates response compatibility for flat creation secrets and creation receipt envelopes", () => {
    const apiKeySchema = {
      type: "object",
      required: ["id", "name"],
      properties: {
        id: { type: "string" },
        name: { type: "string" },
      },
    };
    const resolve = makeResolver({
      "#/components/schemas/ApiKey": {
        node: apiKeySchema,
        pointer: "#/components/schemas/ApiKey",
      },
    });
    const loc = makeLocation("#/test");

    const flatSecret = {
      allOf: [
        { $ref: "#/components/schemas/ApiKey" },
        { type: "object", required: ["secret"], properties: { secret: { type: "string" } } },
      ],
    };
    expect(
      checkResponseCompatibleWithCanonical(flatSecret, loc, apiKeySchema, loc, resolve, {
        allowCreationSecret: true,
      }).mismatches,
    ).toEqual([]);

    // Split two-key receipt envelopes are forbidden per ADS-0002 §3 / ADS-0007 §3
    const receiptEnvelope = {
      type: "object",
      required: ["apiKey", "secret"],
      properties: {
        apiKey: { $ref: "#/components/schemas/ApiKey" },
        secret: { type: "string" },
      },
    };
    expect(
      checkResponseCompatibleWithCanonical(receiptEnvelope, loc, apiKeySchema, loc, resolve, {
        allowCreationSecret: true,
      }).mismatches.length,
    ).toBeGreaterThan(0);

    // Optionalizing canonical required properties must be rejected
    const optionalizedResp = {
      type: "object",
      properties: {
        id: { type: "string" },
        name: { type: "string" },
      },
    };
    const optResult = checkResponseCompatibleWithCanonical(
      optionalizedResp,
      loc,
      apiKeySchema,
      loc,
      resolve,
      { allowCreationSecret: false },
    );
    expect(optResult.mismatches.some((m) => m.reason.includes("optional"))).toBe(true);

    // Canonical with no required properties must allow valid narrower responses
    const allOptionalCanon = {
      type: "object",
      properties: {
        a: { type: "string" },
        b: { type: "string" },
      },
    };
    const narrowerResp = {
      type: "object",
      properties: { a: { type: "string" } },
    };
    expect(
      checkResponseCompatibleWithCanonical(narrowerResp, loc, allOptionalCanon, loc, resolve, {
        allowCreationSecret: false,
      }).mismatches,
    ).toEqual([]);

    // Dictionary value types (property-free additionalProperties) are recursively checked
    const stringMapCanon = {
      type: "object",
      properties: {
        labels: { type: "object", additionalProperties: { type: "string" } },
      },
    };
    const intMapSource = {
      type: "object",
      properties: {
        labels: { type: "object", additionalProperties: { type: "integer" } },
      },
    };
    const mapMismatches = checkResponseCompatibleWithCanonical(
      intMapSource,
      loc,
      stringMapCanon,
      loc,
      resolve,
      { allowCreationSecret: false },
    ).mismatches;
    expect(mapMismatches.some((m) => m.path === "labels.*")).toBe(true);

    // Free-form { type: "object" } and explicit additionalProperties: true fail against typed dictionary and closed canonical
    const freeformSource = {
      type: "object",
      properties: { labels: { type: "object" } },
    };
    expect(
      checkResponseCompatibleWithCanonical(freeformSource, loc, stringMapCanon, loc, resolve, {
        allowCreationSecret: false,
      }).mismatches.some((m) => m.path === "labels.*"),
    ).toBe(true);

    const closedCanon = {
      type: "object",
      properties: {
        meta: {
          type: "object",
          additionalProperties: false,
          properties: { tag: { type: "string" } },
        },
      },
    };
    const openExtraSource = {
      type: "object",
      properties: {
        meta: {
          type: "object",
          additionalProperties: true,
          properties: { tag: { type: "string" } },
        },
      },
    };
    expect(
      checkResponseCompatibleWithCanonical(openExtraSource, loc, closedCanon, loc, resolve, {
        allowCreationSecret: false,
      }).mismatches.some((m) => m.path === "meta.*"),
    ).toBe(true);

    // Canonical union with an unconstrained object alternative accepts arbitrary nested properties
    const unionWithOpenCanon = {
      type: "object",
      properties: {
        details: {
          anyOf: [{ type: "object" }, { type: "object", properties: { name: { type: "string" } } }],
        },
      },
    };
    const intDetailsSource = {
      type: "object",
      properties: {
        details: { type: "object", properties: { name: { type: "integer" } } },
      },
    };
    expect(
      checkResponseCompatibleWithCanonical(
        intDetailsSource,
        loc,
        unionWithOpenCanon,
        loc,
        resolve,
        { allowCreationSecret: false },
      ).mismatches,
    ).toEqual([]);

    // Full response cannot combine types from one canonical union branch with required keys from another
    const twoBranchCanon = {
      anyOf: [
        {
          type: "object",
          required: ["id", "value", "region"],
          properties: {
            id: { type: "string" },
            value: { type: "string" },
            region: { type: "string" },
            zone: { type: "string" },
          },
        },
        {
          type: "object",
          required: ["id", "value", "zone"],
          properties: {
            id: { type: "string" },
            value: { type: "integer" },
            region: { type: "string" },
            zone: { type: "string" },
          },
        },
      ],
    };
    const mixedBranchResp = {
      type: "object",
      required: ["id", "value", "zone"],
      properties: {
        id: { type: "string" },
        value: { type: "string" },
        zone: { type: "string" },
      },
    };
    expect(
      checkResponseCompatibleWithCanonical(mixedBranchResp, loc, twoBranchCanon, loc, resolve, {
        allowCreationSecret: false,
      }).mismatches.length,
    ).toBeGreaterThan(0);
  });

  it("handles nested collection deduplication, untyped properties, items: false, array branch cap, and nested open PATCH objects", () => {
    const resolve = makeResolver({});
    const loc = makeLocation("#/test");

    // extractCollectionInfo retains distinct nested object item variants when COMPAT_VARIANT_OPTIONS is passed
    const colVariant = collectFlattenedObjectVariants(
      {
        type: "object",
        required: ["items"],
        properties: {
          items: {
            type: "array",
            items: {
              anyOf: [
                {
                  type: "object",
                  properties: {
                    name: { type: "string" },
                    payload: { type: "object", properties: { value: { type: "integer" } } },
                  },
                },
                {
                  type: "object",
                  properties: {
                    name: { type: "string" },
                    payload: { type: "object", properties: { value: { type: "string" } } },
                  },
                },
              ],
            },
          },
        },
      },
      resolve,
      loc,
      COMPAT_VARIANT_OPTIONS,
    ).variants[0];
    expect(colVariant).toBeDefined();
    if (colVariant) {
      const info = extractCollectionInfo(colVariant, resolve, {
        requireScalarId: false,
        allowNonObjectMetadata: false,
        variantOptions: COMPAT_VARIANT_OPTIONS,
      });
      expect(info?.itemVariants).toHaveLength(2);
    }

    // properties without explicit type: object must not narrow source to object-only
    expect(
      compareFragmentsAgainstTargets(
        [{ node: { properties: { enabled: { type: "boolean" } } } }],
        [[{ node: { type: "object", properties: { enabled: { type: "boolean" } } } }]],
        resolve,
        { path: "settings" },
      ),
    ).not.toBeNull();

    // items: false prohibits elements; string or unconstrained arrays fail while items: false passes
    expect(
      compareFragmentsAgainstTargets(
        [{ node: { type: "array", items: { type: "string" } } }],
        [[{ node: { type: "array", items: false } }]],
        resolve,
        { path: "tags" },
      ),
    ).not.toBeNull();
    expect(
      compareFragmentsAgainstTargets(
        [{ node: { type: "array" } }],
        [[{ node: { type: "array", items: false } }]],
        resolve,
        { path: "tags" },
      ),
    ).not.toBeNull();
    expect(
      compareFragmentsAgainstTargets(
        [{ node: { type: "array", items: false } }],
        [[{ node: { type: "array", items: false } }]],
        resolve,
        { path: "tags" },
      ),
    ).toBeNull();

    // Array item union exceeding 256 branches reports incomplete analysis instead of silently passing
    const largeAnyOf = Array.from({ length: 260 }, (_, idx) => ({
      type: "array",
      items: { type: idx < 256 ? "string" : "integer" },
    }));
    const truncMismatch = compareFragmentsAgainstTargets(
      [{ node: { anyOf: largeAnyOf } }],
      [[{ node: { type: "array", items: { type: "string" } } }]],
      resolve,
      { path: "bigList" },
    );
    expect(truncMismatch?.reason).toContain("cap");

    // Untyped open PATCH object with zero properties is flagged, and nested fixed-schema objects are checked
    const openZeroProp = collectFlattenedObjectVariants({ type: "object" }, resolve).variants[0];
    expect(openZeroProp).toBeDefined();
    if (openZeroProp) {
      expect(checkPatchObjectVariantConstraints(openZeroProp)).toEqual([
        { kind: "additional-properties" },
      ]);
    }
    const nestedPatch = collectFlattenedObjectVariants(
      {
        type: "object",
        additionalProperties: false,
        properties: {
          notifications: {
            type: "object",
            properties: { emailEnabled: { type: "boolean" } },
          },
          labels: {
            type: "object",
            additionalProperties: { type: "string" },
          },
          tags: {
            type: "array",
            items: { type: "object", properties: { name: { type: "string" } } },
          },
        },
      },
      resolve,
      loc,
      COMPAT_VARIANT_OPTIONS,
    ).variants[0];
    expect(nestedPatch).toBeDefined();
    if (nestedPatch) {
      expect(collectNestedOpenPatchObjectPaths(nestedPatch, resolve).openPaths).toEqual([
        "notifications",
      ]);
    }
  });
  it("scopes unevaluatedProperties closures, propagates nested response required keys, handles tuples, and reports untyped nested PATCH objects", () => {
    const resolve = makeResolver({});
    const loc = makeLocation("#/test");

    // A closed allOf branch is not reopened by a sibling branch's additionalProperties: true
    const scopedClosure = collectFlattenedObjectVariants(
      {
        allOf: [
          {
            type: "object",
            properties: { name: { type: "string" } },
            unevaluatedProperties: false,
          },
          { type: "object", additionalProperties: true },
        ],
      },
      resolve,
      loc,
    ).variants[0];
    expect(scopedClosure?.forbidsAdditionalProperties).toBe(true);
    if (scopedClosure) {
      expect(checkPatchObjectVariantConstraints(scopedClosure)).toEqual([]);
    }

    // Adjacent additionalProperties: true still keeps unevaluatedProperties: false open
    const adjacentOpen = collectFlattenedObjectVariants(
      { type: "object", additionalProperties: true, unevaluatedProperties: false },
      resolve,
      loc,
    ).variants[0];
    expect(adjacentOpen?.forbidsAdditionalProperties).toBe(false);

    // Full responses must keep nested canonical required properties required
    const nestedCanon = {
      type: "object",
      required: ["profile"],
      properties: {
        profile: {
          type: "object",
          required: ["name"],
          properties: { name: { type: "string" } },
        },
      },
    };
    const nestedOptionalResp = {
      type: "object",
      required: ["profile"],
      properties: {
        profile: { type: "object", properties: { name: { type: "string" } } },
      },
    };
    expect(
      checkResponseCompatibleWithCanonical(nestedOptionalResp, loc, nestedCanon, loc, resolve, {
        allowCreationSecret: false,
      }).mismatches.some((m) => m.path === "profile" && m.reason.includes("optional")),
    ).toBe(true);
    expect(
      checkResponseCompatibleWithCanonical(nestedCanon, loc, nestedCanon, loc, resolve, {
        allowCreationSecret: false,
      }).mismatches,
    ).toEqual([]);

    // Tuple arrays with items: false are constrained by prefixItems, not treated as empty arrays
    const tuple = collectArrayItemBranches(
      [{ node: { type: "array", prefixItems: [{ type: "string" }], items: false } }],
      resolve,
    );
    expect(tuple.branches).toHaveLength(1);
    expect(tuple.hasUnconstrainedBranch).toBe(false);

    // An array property with an unconstrained item branch is not an addressable collection
    const looseArray = collectFlattenedObjectVariants(
      {
        type: "object",
        properties: {
          items: {
            type: "array",
            anyOf: [
              {
                items: {
                  type: "object",
                  required: ["id"],
                  properties: { id: { type: "string" } },
                },
              },
              {},
            ],
          },
        },
      },
      resolve,
      loc,
    ).variants[0];
    expect(looseArray).toBeDefined();
    if (looseArray) {
      expect(extractCollectionInfo(looseArray, resolve)).toBeNull();
    }

    // Untyped nested objects merge recursively and must be closed; typed maps replace wholesale
    const untypedNested = collectFlattenedObjectVariants(
      {
        type: "object",
        additionalProperties: false,
        properties: {
          meta: { type: "object" },
          labels: { type: "object", additionalProperties: { type: "string" } },
        },
      },
      resolve,
      loc,
    ).variants[0];
    expect(untypedNested).toBeDefined();
    if (untypedNested) {
      expect(collectNestedOpenPatchObjectPaths(untypedNested, resolve)).toEqual({
        openPaths: ["meta"],
        truncated: false,
      });
    }
  });
});
