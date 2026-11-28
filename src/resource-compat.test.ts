import { describe, expect, it } from "vitest";
import {
  checkPatchObjectVariantConstraints,
  checkResponseCompatibleWithCanonical,
  checkVariantAgainstCanonicalVariants,
  compareFragmentsAgainstTargets,
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
        allowCreationReceiptEnvelope: false,
      }).mismatches,
    ).toEqual([]);

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
        allowCreationReceiptEnvelope: true,
      }).mismatches,
    ).toEqual([]);

    const driftedReceipt = {
      type: "object",
      required: ["apiKey", "secret"],
      properties: {
        apiKey: {
          type: "object",
          required: ["id"],
          properties: { id: { type: "integer" } },
        },
        secret: { type: "string" },
      },
    };
    const driftedResult = checkResponseCompatibleWithCanonical(
      driftedReceipt,
      loc,
      apiKeySchema,
      loc,
      resolve,
      {
        allowCreationSecret: true,
        allowCreationReceiptEnvelope: true,
      },
    );
    expect(driftedResult.mismatches.length).toBeGreaterThan(0);

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
      { allowCreationSecret: false, allowCreationReceiptEnvelope: false },
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
        allowCreationReceiptEnvelope: false,
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
      { allowCreationSecret: false, allowCreationReceiptEnvelope: false },
    ).mismatches;
    expect(mapMismatches.some((m) => m.path === "labels.*")).toBe(true);
  });
});
