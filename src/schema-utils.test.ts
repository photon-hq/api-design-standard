import { describe, expect, it } from "vitest";
import {
  extractOperationJsonResponseSchemas,
  hasHeaderCaseInsensitive,
  inspectResponseContent,
  resolvePathItemWithLocation,
} from "./openapi-utils.js";
import {
  computeTypeConstraint,
  extractComponentSchemaName,
  intersectTypeSets,
  isNonNullObjectConstraint,
  isNonNullStringConstraint,
  isStrictlyNullConstraint,
  jsonTypeOfValue,
  mergeTrackedProperty,
  type ResolverFn,
  someSchemaBranch,
  unescapeJsonPointerToken,
} from "./schema-utils.js";
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

function makeResolver(
  targets: Record<string, { node: unknown; pointer: string; absoluteRef?: string }>,
): ResolverFn {
  return (<T = unknown>(node: { $ref: string }) => {
    const target = targets[node.$ref];
    if (!target) {
      return { error: new Error(`Unresolved: ${node.$ref}`) };
    }
    return {
      node: target.node as T,
      location: makeLocation(target.pointer, target.absoluteRef ?? "openapi.yaml"),
    };
  }) as ResolverFn;
}

describe("shared schema and OpenAPI utilities", () => {
  it("unescapes JSON pointers and extracts component schema names", () => {
    expect(unescapeJsonPointerToken("a~1b~0c")).toBe("a/b~c");
    expect(extractComponentSchemaName("#/components/schemas/Project")).toBe("Project");
    expect(extractComponentSchemaName("#/components/schemas/My~1Schema")).toBe("My/Schema");
    expect(
      extractComponentSchemaName("#/components/schemas/My%20Schema", { decodeUri: true }),
    ).toBe("My Schema");
    expect(extractComponentSchemaName("#/paths/~1v1~1projects")).toBeUndefined();
  });

  it("computes type constraints across type arrays, nullable, const, enum, allOf, and unions", () => {
    const noopResolve = makeResolver({});
    expect(jsonTypeOfValue(null)).toBe("null");
    expect(jsonTypeOfValue(42)).toBe("integer");
    expect(jsonTypeOfValue(3.14)).toBe("number");
    expect(jsonTypeOfValue([1, 2])).toBe("array");
    expect([...intersectTypeSets(new Set(["number"]), new Set(["integer"]))]).toEqual(["integer"]);

    const strTc = computeTypeConstraint({ type: "string" }, noopResolve);
    expect(isNonNullStringConstraint(strTc)).toBe(true);

    const nullTc = computeTypeConstraint({ enum: [null] }, noopResolve);
    expect(isStrictlyNullConstraint(nullTc)).toBe(true);

    const objTc = computeTypeConstraint(
      {
        allOf: [{ type: ["object", "null"] }, { type: "object" }],
      },
      noopResolve,
    );
    expect(isNonNullObjectConstraint(objTc)).toBe(true);

    const nullableRefResolve = makeResolver({
      "#/components/schemas/Name": {
        node: { type: "string" },
        pointer: "#/components/schemas/Name",
      },
    });
    const nullableRefTc = computeTypeConstraint(
      { $ref: "#/components/schemas/Name", nullable: true },
      nullableRefResolve,
    );
    expect([...nullableRefTc.allowed].sort()).toEqual(["null", "string"]);
  });

  it("merges tracked properties without duplicate fragments and evaluates someSchemaBranch", () => {
    const fragA = { node: { type: "string" }, from: "a.yaml" };
    const fragB = { node: { minLength: 1 }, from: "a.yaml" };
    const merged = mergeTrackedProperty(
      { name: "id", fragments: [fragA] },
      { name: "id", fragments: [fragA, fragB] },
    );
    expect(merged.fragments).toHaveLength(2);

    const resolve = makeResolver({
      "#/components/schemas/Leaf": {
        node: { pattern: "^[a-z]+$" },
        pointer: "#/components/schemas/Leaf",
      },
    });
    expect(
      someSchemaBranch(
        { anyOf: [{ $ref: "#/components/schemas/Leaf" }] },
        resolve,
        undefined,
        (node) => typeof node.pattern === "string",
      ),
    ).toBe(true);
  });

  it("memoizes diamond allOf DAGs in collectFlattenedObjectVariants without exponential blowup", () => {
    const targets: Record<string, { node: unknown; pointer: string }> = {
      "#/components/schemas/D0": {
        node: { type: "object", required: ["id"], properties: { id: { type: "string" } } },
        pointer: "#/components/schemas/D0",
      },
    };
    for (let i = 1; i <= 25; i += 1) {
      targets[`#/components/schemas/D${i}`] = {
        node: {
          allOf: [
            { $ref: `#/components/schemas/D${i - 1}` },
            { $ref: `#/components/schemas/D${i - 1}` },
          ],
        },
        pointer: `#/components/schemas/D${i}`,
      };
    }
    const resolve = makeResolver(targets);
    const start = performance.now();
    const res = collectFlattenedObjectVariants(
      { $ref: "#/components/schemas/D25" },
      resolve,
      makeLocation("#/paths/~1items/get/responses/200/content/application~1json/schema"),
    );
    const elapsedMs = performance.now() - start;

    expect(res.truncated).toBe(false);
    expect(res.variants).toHaveLength(1);
    expect(res.variants[0]?.properties.has("id")).toBe(true);
    expect(elapsedMs).toBeLessThan(1000);
  });

  it("merges local sibling operations on referenced Path Items with accurate source locations", () => {
    const resolve = makeResolver({
      "./shared.yaml": {
        node: {
          get: { operationId: "getShared", responses: { "200": { description: "ok" } } },
        },
        pointer: "#",
        absoluteRef: "shared.yaml",
      },
    });
    const usageLoc = makeLocation("#/paths/~1v1~1profile");
    const resolved = resolvePathItemWithLocation(
      resolve,
      "/v1/profile",
      {
        $ref: "./shared.yaml",
        patch: { operationId: "patchLocal", responses: { "204": { description: "no content" } } },
      },
      usageLoc,
    );

    expect(resolved.pathItem?.get).toBeDefined();
    expect(resolved.pathItem?.patch).toBeDefined();
    expect(resolved.isOperationFromRef("get")).toBe(true);
    expect(resolved.isOperationFromRef("patch")).toBe(false);
    expect(resolved.operationLocation("get").source?.absoluteRef).toBe("shared.yaml");
    expect(resolved.operationLocation("patch").pointer).toBe("#/paths/~1v1~1profile/patch");
  });

  it("extracts JSON response schemas, inspects content presence, and checks headers case-insensitively", () => {
    const resolve = makeResolver({});
    const opLoc = makeLocation("#/paths/~1v1~1items/get");
    const schemas = extractOperationJsonResponseSchemas(
      {
        responses: {
          "200": {
            content: {
              "application/problem+json": { schema: { type: "object" } },
              "application/vnd.photon+json; charset=utf-8": {
                schema: { type: "object", properties: { id: { type: "string" } } },
              },
            },
          },
        },
      },
      opLoc,
      resolve,
      ["200", "2XX"],
    );
    expect(schemas).toHaveLength(1);
    expect(schemas[0]?.mediaType).toBe("application/vnd.photon+json; charset=utf-8");

    const emptyResp = inspectResponseContent(
      { description: "No body" },
      opLoc.child(["responses", "204"]),
      resolve,
    );
    expect(emptyResp?.hasContent).toBe(false);

    expect(hasHeaderCaseInsensitive({ Location: { schema: { type: "string" } } }, "location")).toBe(
      true,
    );
    expect(hasHeaderCaseInsensitive({ "X-Other": {} }, "location")).toBe(false);
  });
});
