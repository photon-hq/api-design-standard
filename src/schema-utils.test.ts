import { describe, expect, it } from "vitest";
import {
  extractOperationJsonResponseSchemas,
  hasHeaderCaseInsensitive,
  inspectResponseContent,
  resolveOperationParameters,
  resolvePathItemWithLocation,
} from "./openapi-utils.js";
import {
  computeFragmentsMinLength,
  computeIntegerBounds,
  computeMinLength,
  computeTypeConstraint,
  extractComponentSchemaName,
  intersectTypeSets,
  isNonNullIntegerConstraint,
  isNonNullObjectConstraint,
  isNonNullStringConstraint,
  isSchemaDeprecated,
  isStrictlyNullConstraint,
  isTrackedPropertyDeprecated,
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
  targets: Record<
    string,
    {
      node: unknown;
      pointer: string;
      absoluteRef?: string;
      chain?: Array<{ node: unknown; pointer: string; absoluteRef?: string }>;
    }
  >,
): ResolverFn {
  return (<T = unknown>(node: { $ref: string }) => {
    const target = targets[node.$ref];
    if (!target) {
      return { error: new Error(`Unresolved: ${node.$ref}`) };
    }
    return {
      node: target.node as T,
      location: makeLocation(target.pointer, target.absoluteRef ?? "openapi.yaml"),
      ...(target.chain
        ? {
            chain: target.chain.map((hop) => ({
              node: hop.node,
              location: makeLocation(hop.pointer, hop.absoluteRef ?? "openapi.yaml"),
            })),
          }
        : {}),
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

  it("assigns one shared anonymous group ID across branches of a location-free oneOf", () => {
    const resolve = makeResolver({});
    const res = collectFlattenedObjectVariants(
      {
        oneOf: [
          { type: "object", properties: { id: { type: "string" }, a: { type: "string" } } },
          { type: "object", properties: { id: { type: "string" }, b: { type: "string" } } },
        ],
      },
      resolve,
      undefined,
      { trackOneOfBranches: true },
    );

    expect(res.variants).toHaveLength(2);
    const firstKeys = [...(res.variants[0]?.oneOfBranches.keys() ?? [])];
    const secondKeys = [...(res.variants[1]?.oneOfBranches.keys() ?? [])];
    expect(firstKeys).toHaveLength(1);
    expect(secondKeys).toEqual(firstKeys);
    expect([...(res.variants[0]?.oneOfBranches.get(firstKeys[0] ?? "") ?? [])]).toEqual([0]);
    expect([...(res.variants[1]?.oneOfBranches.get(secondKeys[0] ?? "") ?? [])]).toEqual([1]);
  });

  it("keeps variants distinct when required or property names contain commas or delimiters", () => {
    const resolve = makeResolver({});
    const res = collectFlattenedObjectVariants(
      {
        oneOf: [
          {
            type: "object",
            required: ["id", "city", "country"],
            properties: {
              id: { type: "string" },
              city: { type: "string" },
              country: { type: "string" },
              "city,country": { type: "string" },
            },
          },
          {
            type: "object",
            required: ["id", "city,country"],
            properties: {
              id: { type: "string" },
              city: { type: "string" },
              country: { type: "string" },
              "city,country": { type: "string" },
            },
          },
        ],
      },
      resolve,
    );

    expect(res.variants).toHaveLength(2);
  });

  it("gives declared explicit status codes precedence over 2XX in extractOperationJsonResponseSchemas", () => {
    const resolve = makeResolver({});
    const opLoc = makeLocation("#/paths/~1v1~1items~1{itemId}/get");

    const text200With2xx = extractOperationJsonResponseSchemas(
      {
        responses: {
          "200": { content: { "text/plain": { schema: { type: "string" } } } },
          "2XX": {
            content: { "application/json": { schema: { type: "object", properties: {} } } },
          },
        },
      },
      opLoc,
      resolve,
      ["200", "2XX"],
    );
    expect(text200With2xx).toHaveLength(0);

    const text200WithJson201 = extractOperationJsonResponseSchemas(
      {
        responses: {
          "200": { content: { "text/plain": { schema: { type: "string" } } } },
          "201": {
            content: { "application/json": { schema: { type: "object", properties: {} } } },
          },
        },
      },
      opLoc,
      resolve,
      ["200", "201", "2XX"],
    );
    expect(text200WithJson201).toHaveLength(1);
    expect(text200WithJson201[0]?.responseLocation.pointer).toContain("/responses/201");
  });

  it("preserves intermediate Path Item operations and declaring locations across chained $refs", () => {
    const targetB = {
      put: { operationId: "putItem", responses: { "200": { description: "ok" } } },
    };
    const hopA = {
      $ref: "./b.yaml",
      patch: { operationId: "patchItem", responses: { "200": { description: "ok" } } },
    };
    const rootPathItem = { $ref: "./a.yaml" };
    const resolve = makeResolver({
      "./a.yaml": {
        node: targetB,
        pointer: "#",
        absoluteRef: "b.yaml",
        chain: [
          {
            node: rootPathItem,
            pointer: "#/paths/~1v1~1items~1{itemId}",
            absoluteRef: "root.yaml",
          },
          { node: hopA, pointer: "#", absoluteRef: "a.yaml" },
          { node: targetB, pointer: "#", absoluteRef: "b.yaml" },
        ],
      },
    });

    const usageLoc = makeLocation("#/paths/~1v1~1items~1{itemId}", "root.yaml");
    const resolved = resolvePathItemWithLocation(
      resolve,
      "/v1/items/{itemId}",
      rootPathItem,
      usageLoc,
    );

    expect(resolved.pathItem?.put).toBeDefined();
    expect(resolved.pathItem?.patch).toBeDefined();
    expect(resolved.isOperationFromRef("put")).toBe(true);
    expect(resolved.isOperationFromRef("patch")).toBe(true);
    expect(resolved.operationLocation("put").source?.absoluteRef).toBe("b.yaml");
    expect(resolved.operationLocation("patch").source?.absoluteRef).toBe("a.yaml");
  });

  it("merges path-level and operation-level parameters with $ref resolution, ignoring unsupported Reference Object siblings", () => {
    const idempotencyTarget = {
      name: "Idempotency-Key",
      in: "header",
      schema: { type: "string" },
    };
    const deprecatedTarget = {
      name: "Idempotency-Key",
      in: "header",
      deprecated: true,
      schema: { type: "string" },
    };
    const chainedAlias = {
      $ref: "#/components/parameters/IdempotencyKey",
      deprecated: true,
    };
    const resolve = makeResolver({
      "#/components/parameters/IdempotencyKey": {
        node: idempotencyTarget,
        pointer: "#/components/parameters/IdempotencyKey",
      },
      "#/components/parameters/DeprecatedIdempotencyKey": {
        node: deprecatedTarget,
        pointer: "#/components/parameters/DeprecatedIdempotencyKey",
      },
      "#/components/parameters/IdempotencyAlias": {
        node: idempotencyTarget,
        pointer: "#/components/parameters/IdempotencyKey",
        chain: [
          { node: chainedAlias, pointer: "#/components/parameters/IdempotencyAlias" },
          { node: idempotencyTarget, pointer: "#/components/parameters/IdempotencyKey" },
        ],
      },
    });

    // Path-level Idempotency-Key overridden by a full operation-level Parameter Object on GET
    // (case-insensitive header match), inherited on HEAD, while Reference Object siblings like
    // deprecated: true/false on $ref or intermediate hops are ignored per OpenAPI 3.1.
    const rawPathItem = {
      parameters: [
        { $ref: "#/components/parameters/IdempotencyKey" },
        { name: "Filter", in: "query", schema: { type: "string" } },
      ],
      get: {
        operationId: "listItems",
        parameters: [
          { name: "idempotency-key", in: "header", deprecated: true, schema: { type: "string" } },
          { name: "filter", in: "query", schema: { type: "string" } },
        ],
      },
      head: {
        operationId: "headItems",
      },
      post: {
        operationId: "postWithUnsupportedRefSibling",
        parameters: [{ $ref: "#/components/parameters/IdempotencyAlias", deprecated: true }],
      },
      put: {
        operationId: "putWithUnsupportedFalseSibling",
        parameters: [
          { $ref: "#/components/parameters/DeprecatedIdempotencyKey", deprecated: false },
        ],
      },
    };
    const pathEntry = resolvePathItemWithLocation(
      resolve,
      "/v1/items",
      rawPathItem,
      makeLocation("#/paths/~1v1~1items"),
    );

    const getParams = resolveOperationParameters(pathEntry, "get", resolve);
    expect(getParams).toHaveLength(3);
    const getHeader = getParams.find((p) => p.in === "header");
    expect(getHeader?.name).toBe("idempotency-key");
    expect(getHeader?.deprecated).toBe(true);
    expect(getHeader?.source).toBe("operation");
    expect(getHeader?.reportLocation.pointer).toBe("#/paths/~1v1~1items/get/parameters/0");
    expect(getParams.filter((p) => p.in === "query").map((p) => p.name)).toEqual([
      "Filter",
      "filter",
    ]);

    const headParams = resolveOperationParameters(pathEntry, "head", resolve);
    expect(headParams).toHaveLength(2);
    const headHeader = headParams.find((p) => p.in === "header");
    expect(headHeader?.name).toBe("Idempotency-Key");
    expect(headHeader?.deprecated).toBe(false);
    expect(headHeader?.source).toBe("path");
    expect(headHeader?.resolvedFromRef).toBe(true);
    expect(headHeader?.reportLocation.pointer).toBe("#/paths/~1v1~1items/head");

    const postHeader = resolveOperationParameters(pathEntry, "post", resolve).find(
      (p) => p.in === "header",
    );
    expect(postHeader?.name).toBe("Idempotency-Key");
    expect(postHeader?.deprecated).toBe(false);
    expect(postHeader?.resolvedFromRef).toBe(true);

    const putHeader = resolveOperationParameters(pathEntry, "put", resolve).find(
      (p) => p.in === "header",
    );
    expect(putHeader?.name).toBe("Idempotency-Key");
    expect(putHeader?.deprecated).toBe(true);
    expect(putHeader?.resolvedFromRef).toBe(true);
  });

  it("computes integer bounds, string minLength, and deprecation across $ref, allOf, and unions", () => {
    const posInt = { type: "integer", minimum: 1 };
    const nonEmpty = { type: "string", minLength: 1 };
    const nullSchema = { type: "null" };
    const deprecatedTarget = { type: "string", deprecated: true };
    const hopOverride = { $ref: "#/components/schemas/DeprecatedTarget", deprecated: false };
    const resolve = makeResolver({
      "#/components/schemas/PosInt": { node: posInt, pointer: "#/components/schemas/PosInt" },
      "#/components/schemas/NonEmpty": { node: nonEmpty, pointer: "#/components/schemas/NonEmpty" },
      "#/components/schemas/NullSchema": {
        node: nullSchema,
        pointer: "#/components/schemas/NullSchema",
      },
      "#/components/schemas/DeprecatedTarget": {
        node: deprecatedTarget,
        pointer: "#/components/schemas/DeprecatedTarget",
      },
      "#/components/schemas/HopOverride": {
        node: deprecatedTarget,
        pointer: "#/components/schemas/DeprecatedTarget",
        chain: [
          { node: { $ref: "#/components/schemas/HopOverride" }, pointer: "#/root" },
          { node: hopOverride, pointer: "#/components/schemas/HopOverride" },
          { node: deprecatedTarget, pointer: "#/components/schemas/DeprecatedTarget" },
        ],
      },
    });

    expect(isNonNullIntegerConstraint(computeTypeConstraint({ type: "integer" }, resolve))).toBe(
      true,
    );
    expect(
      isNonNullIntegerConstraint(computeTypeConstraint({ type: ["integer", "null"] }, resolve)),
    ).toBe(false);

    expect(
      computeIntegerBounds(
        { allOf: [{ $ref: "#/components/schemas/PosInt" }, { maximum: 100 }] },
        resolve,
      ),
    ).toEqual({ kind: "bounds", minimum: 1, maximum: 100 });
    expect(
      computeIntegerBounds(
        { type: "integer", exclusiveMinimum: 0, exclusiveMaximum: 101 },
        resolve,
      ),
    ).toEqual({ kind: "bounds", minimum: 1, maximum: 100 });
    expect(
      computeIntegerBounds(
        { type: "integer", minimum: 0, exclusiveMinimum: true, maximum: 50 },
        resolve,
      ),
    ).toEqual({ kind: "bounds", minimum: 1, maximum: 50 });
    expect(
      computeIntegerBounds(
        {
          oneOf: [
            { type: "integer", minimum: 1, maximum: 50 },
            { $ref: "#/components/schemas/NullSchema" },
          ],
        },
        resolve,
      ),
    ).toEqual({ kind: "bounds", minimum: 1, maximum: 50 });
    expect(
      computeIntegerBounds(
        {
          oneOf: [
            { type: "integer", minimum: 1, maximum: 50 },
            { type: "integer", maximum: 100 },
          ],
        },
        resolve,
      ),
    ).toEqual({ kind: "bounds", minimum: null, maximum: 100 });
    expect(
      computeIntegerBounds(
        {
          oneOf: [
            { type: "integer", minimum: 100, maximum: 50 },
            { type: "integer", minimum: 200, maximum: 150 },
          ],
        },
        resolve,
      ),
    ).toEqual({ kind: "false" });
    expect(
      computeIntegerBounds(
        {
          oneOf: [
            { type: "integer", minimum: 100, maximum: 50 },
            { type: "integer", minimum: 1, maximum: 50 },
          ],
        },
        resolve,
      ),
    ).toEqual({ kind: "bounds", minimum: 1, maximum: 50 });

    expect(computeMinLength({ $ref: "#/components/schemas/NonEmpty" }, resolve)).toEqual({
      kind: "value",
      minLength: 1,
    });
    expect(
      computeMinLength(
        {
          oneOf: [{ type: "string", minLength: 2 }, { $ref: "#/components/schemas/NullSchema" }],
        },
        resolve,
      ),
    ).toEqual({ kind: "value", minLength: 2 });
    expect(
      computeFragmentsMinLength(
        [{ node: { type: "string" } }, { node: { minLength: 3 } }],
        resolve,
      ),
    ).toEqual({ kind: "value", minLength: 3 });

    expect(isSchemaDeprecated({ $ref: "#/components/schemas/DeprecatedTarget" }, resolve)).toBe(
      true,
    );
    expect(
      isSchemaDeprecated(
        { $ref: "#/components/schemas/DeprecatedTarget", deprecated: false },
        resolve,
      ),
    ).toBe(false);
    expect(isSchemaDeprecated({ $ref: "#/components/schemas/HopOverride" }, resolve)).toBe(false);
    expect(
      isSchemaDeprecated(
        { allOf: [{ type: "string" }, { $ref: "#/components/schemas/DeprecatedTarget" }] },
        resolve,
      ),
    ).toBe(true);
    expect(
      isTrackedPropertyDeprecated(
        {
          name: "nextCursor",
          fragments: [{ node: { type: "string" } }, { node: { deprecated: true } }],
        },
        resolve,
      ),
    ).toBe(true);
  });
});
