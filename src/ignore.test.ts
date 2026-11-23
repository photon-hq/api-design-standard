import { describe, expect, it } from "vitest";
import {
  createRuleIgnoreMatcher,
  extractPointerContext,
  normalizeIgnoreMethod,
  normalizeIgnorePath,
  normalizeIgnoreSchema,
  parseRuleIgnoreEntries,
} from "./ignore.js";

describe("shared rule-level ignore helpers", () => {
  it("normalizes paths, HTTP methods, and schema names", () => {
    expect(normalizeIgnorePath("/v1/projects/{projectId}/")).toBe("/v1/projects/{projectId}");
    expect(normalizeIgnorePath("  /v1/projects/{projectId}///  ")).toBe("/v1/projects/{projectId}");
    expect(normalizeIgnorePath("/")).toBe("/");
    expect(normalizeIgnorePath("///")).toBe("/");
    expect(normalizeIgnorePath("   ")).toBe("");

    expect(normalizeIgnoreMethod(" GET ")).toBe("get");
    expect(normalizeIgnoreMethod("PoSt")).toBe("post");
    expect(normalizeIgnoreMethod("   ")).toBe("");

    expect(normalizeIgnoreSchema("  LegacyProject  ")).toBe("LegacyProject");
    expect(normalizeIgnoreSchema("   ")).toBe("");
  });

  it("extracts schema, path, and method context from Redocly JSON pointers", () => {
    expect(extractPointerContext("#/components/schemas/LegacyProject")).toEqual({
      schema: "LegacyProject",
    });
    expect(
      extractPointerContext("#/components/schemas/LegacyProject/allOf/1/properties/projectId"),
    ).toEqual({
      schema: "LegacyProject",
    });
    expect(extractPointerContext("#/components/schemas/Weird~1Name~01")).toEqual({
      schema: "Weird/Name~1",
    });
    expect(extractPointerContext("#/components/schemas/Pct%25Schema")).toEqual({
      schema: "Pct%25Schema",
    });
    expect(
      extractPointerContext(
        "#/paths/~1v1~1projects~1{projectId}/get/responses/200/content/application~1json/schema",
      ),
    ).toEqual({
      path: "/v1/projects/{projectId}",
      method: "get",
    });
    expect(extractPointerContext("#/paths/~1v1~1projects~1{projectId}/parameters/0")).toEqual({
      path: "/v1/projects/{projectId}",
    });
    expect(extractPointerContext("#/info/title")).toEqual({});
    expect(extractPointerContext(undefined)).toEqual({});
  });

  it("safely ignores malformed or empty options without crashing", () => {
    expect(parseRuleIgnoreEntries(undefined)).toEqual([]);
    expect(parseRuleIgnoreEntries(null)).toEqual([]);
    expect(parseRuleIgnoreEntries("invalid")).toEqual([]);
    expect(parseRuleIgnoreEntries([])).toEqual([]);
    expect(parseRuleIgnoreEntries({ ignore: "not-an-array" })).toEqual([]);
    expect(
      parseRuleIgnoreEntries({
        ignore: [
          null,
          42,
          "str",
          {},
          { reason: "missing target selector" },
          { method: "get", reason: "method alone without path or schema" },
          { path: "" },
          { path: "   " },
          { path: "/v1/ok", method: 123 },
          { path: "/v1/ok", method: "" },
          { schema: "" },
          { schema: 456 },
          { path: "/v1/valid/", method: "POST", reason: "Valid entry" },
        ],
      }),
    ).toEqual([
      {
        path: "/v1/valid",
        method: "post",
        reason: "Valid entry",
      },
    ]);
  });

  it("matches path, optional method, and schema entries accurately", () => {
    const matcher = createRuleIgnoreMatcher({
      ignore: [
        { path: "/v1/all-methods/", reason: "Waive entire path" },
        { path: "/v1/single-method/{itemId}", method: "GET" },
        { schema: "LegacyProject" },
        { path: "/v1/scoped/{projectId}", method: "get", schema: "ScopedProject" },
      ],
    });

    expect(matcher.isIgnored({ path: "/v1/all-methods" })).toBe(true);
    expect(matcher.isIgnored({ path: "/v1/all-methods/", method: "delete" })).toBe(true);
    expect(matcher.isIgnored({ schema: "SomeSchema" })).toBe(false);

    expect(matcher.isIgnored({ path: "/v1/single-method/{itemId}", method: "get" })).toBe(true);
    expect(matcher.isIgnored({ path: "/v1/single-method/{itemId}/", method: "GET" })).toBe(true);
    expect(matcher.isIgnored({ path: "/v1/single-method/{itemId}", method: "post" })).toBe(false);
    expect(matcher.isIgnored({ path: "/v1/single-method/{itemId}" })).toBe(false);

    expect(matcher.isIgnored({ schema: "LegacyProject" })).toBe(true);
    expect(
      matcher.isIgnored({
        path: "/v1/any/{projectId}",
        method: "get",
        schema: "LegacyProject",
      }),
    ).toBe(true);
    expect(matcher.isIgnored({ schema: "OtherProject" })).toBe(false);

    expect(matcher.isIgnored({ schema: "ScopedProject" })).toBe(false);
    expect(
      matcher.isIgnored({
        path: "/v1/scoped/{projectId}",
        method: "get",
        schema: "ScopedProject",
      }),
    ).toBe(true);
    expect(
      matcher.isIgnored({
        path: "/v1/scoped/{projectId}",
        method: "post",
        schema: "ScopedProject",
      }),
    ).toBe(false);
  });

  it("evaluates whether all operations on a PathItem are ignored", () => {
    const matcher = createRuleIgnoreMatcher({
      ignore: [
        { path: "/v1/all/{id}" },
        { path: "/v1/get-only/{id}", method: "get" },
        { path: "/v1/partial/{id}", method: "get" },
      ],
    });

    expect(matcher.areAllPathOperationsIgnored("/v1/all/{id}", {})).toBe(true);
    expect(matcher.areAllPathOperationsIgnored("/v1/all/{id}", { get: {}, post: {} })).toBe(true);

    expect(matcher.areAllPathOperationsIgnored("/v1/get-only/{id}", { get: {} })).toBe(true);
    expect(matcher.areAllPathOperationsIgnored("/v1/get-only/{id}", {})).toBe(false);

    expect(matcher.areAllPathOperationsIgnored("/v1/partial/{id}", { get: {}, post: {} })).toBe(
      false,
    );
  });
});
