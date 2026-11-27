import { execFileSync, spawnSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { stringify as stringifyYaml } from "yaml";
import {
  ADS_0006_METADATA,
  BANNED_PAGINATION_QUERY_PARAMS,
  BANNED_PAGINATION_RESPONSE_PROPERTIES,
  isBannedPaginationQueryParam,
  isBannedPaginationResponseProperty,
  isNestedPaginationIndicatorProperty,
  MAX_ALLOWED_PAGE_SIZE,
  NESTED_PAGINATION_INDICATOR_PROPERTIES,
} from "./rules.js";

const REPO_ROOT = resolve(fileURLToPath(new URL("../..", import.meta.url)));
const REDOCLY_BIN = resolve(REPO_ROOT, "node_modules/.bin/redocly");
const REDOCLY_CONFIG = resolve(REPO_ROOT, "redocly.yaml");
const PLUGIN_DIST = resolve(REPO_ROOT, "dist/src/redocly-plugin.js");
const VALID_FIXTURE = resolve(REPO_ROOT, "test/fixtures/valid-openapi.yaml");

interface RedoclyJsonProblem {
  ruleId: string;
  severity: "error" | "warn";
  message: string;
  location?: Array<{
    pointer?: string;
    reportOnKey?: boolean;
  }>;
}

interface RedoclyJsonReport {
  totals: {
    errors: number;
    warnings: number;
    ignored: number;
  };
  problems: RedoclyJsonProblem[];
}

let tempDir: string;
let specCounter = 0;
let configCounter = 0;

function runRedoclyLint(
  specPath: string,
  configPath: string = REDOCLY_CONFIG,
  cwd: string = REPO_ROOT,
): {
  exitCode: number;
  stderr: string;
  report: RedoclyJsonReport;
} {
  const result = spawnSync(
    REDOCLY_BIN,
    ["lint", specPath, "--config", configPath, "--format=json"],
    {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  if (result.error) {
    throw result.error;
  }
  const stdout = result.stdout ?? "";
  const stderr = result.stderr ?? "";
  const exitCode = result.status ?? 1;
  if (!stdout.trim()) {
    throw new Error(`Redocly failed without JSON output (exit ${exitCode}): ${stderr}`);
  }
  return {
    exitCode,
    stderr,
    report: JSON.parse(stdout) as RedoclyJsonReport,
  };
}

async function lintOpenApi(doc: Record<string, unknown>, configPath?: string, cwd?: string) {
  specCounter += 1;
  const specPath = join(tempDir, `spec-${specCounter}.yaml`);
  await writeFile(specPath, stringifyYaml(doc), "utf8");
  return runRedoclyLint(specPath, configPath, cwd);
}

async function writeRedoclyConfig(rules: Record<string, unknown>): Promise<string> {
  configCounter += 1;
  const configPath = join(tempDir, `redocly-${configCounter}.yaml`);
  await writeFile(
    configPath,
    stringifyYaml({
      plugins: [PLUGIN_DIST],
      extends: ["recommended", "photon-ads/recommended"],
      rules: {
        "security-defined": "off",
        "no-server-example.com": "off",
        ...rules,
      },
    }),
    "utf8",
  );
  return configPath;
}

function baseOpenApi(overrides: {
  openapi?: string;
  paths?: Record<string, unknown>;
  components?: Record<string, unknown>;
}): Record<string, unknown> {
  return {
    openapi: overrides.openapi ?? "3.1.0",
    info: {
      title: "Test API",
      version: "1.0.0",
      description: "Test specification for ADS-0006.",
      license: {
        name: "Apache-2.0",
        url: "https://www.apache.org/licenses/LICENSE-2.0",
      },
    },
    servers: [{ url: "https://api.example.com" }],
    paths: overrides.paths ?? {},
    ...(overrides.components ? { components: overrides.components } : {}),
  };
}

function pageSizeParam(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    name: "pageSize",
    in: "query",
    description: "Maximum items per page. Defaults to 20.",
    schema: { type: "integer", minimum: 1, maximum: 100 },
    ...overrides,
  };
}

function pageTokenParam(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    name: "pageToken",
    in: "query",
    description: "Opaque continuation token.",
    schema: { type: "string", minLength: 1 },
    ...overrides,
  };
}

function listResponse(
  properties: Record<string, unknown> = {
    items: { type: "array", items: { type: "object", properties: { name: { type: "string" } } } },
    nextPageToken: { type: "string", minLength: 1 },
  },
  required: string[] = ["items"],
  mediaType = "application/json",
): Record<string, unknown> {
  return {
    description: "OK",
    content: {
      [mediaType]: {
        schema: {
          type: "object",
          required,
          properties,
        },
      },
    },
  };
}

function ads0006Problems(report: RedoclyJsonReport): RedoclyJsonProblem[] {
  return report.problems.filter((problem) => problem.ruleId.startsWith("photon-ads/ads-0006-"));
}

function ads0006ProblemsFor(report: RedoclyJsonReport, ruleName: string): RedoclyJsonProblem[] {
  return report.problems.filter((problem) => problem.ruleId === `photon-ads/${ruleName}`);
}

beforeAll(async () => {
  tempDir = await mkdtemp(join(tmpdir(), "photon-ads-0006-"));
  execFileSync(resolve(REPO_ROOT, "node_modules/.bin/tsc"), ["-p", "tsconfig.build.json"], {
    cwd: REPO_ROOT,
    stdio: "inherit",
  });
});

afterAll(async () => {
  if (tempDir) {
    await rm(tempDir, { recursive: true, force: true });
  }
});

describe("ADS-0006 unit helpers", () => {
  it("exports metadata for all three error-level ADS-0006 rules", () => {
    expect(ADS_0006_METADATA.ads).toBe("0006");
    expect(ADS_0006_METADATA.slug).toBe("ads-0006");
    expect(ADS_0006_METADATA.folder).toBe("0006-list-pagination");
    expect(ADS_0006_METADATA.rules.map((r) => r.id)).toEqual([
      "photon-ads/ads-0006-standard-pagination-params",
      "photon-ads/ads-0006-page-size-bounds",
      "photon-ads/ads-0006-pagination-response-shape",
    ]);
    expect(ADS_0006_METADATA.rules.every((r) => r.severity === "error")).toBe(true);
    expect(MAX_ALLOWED_PAGE_SIZE).toBe(1000);
  });

  it("classifies banned query params, banned response properties, and nested indicators", () => {
    for (const banned of [
      "cursor",
      "limit",
      "offset",
      "page",
      "perPage",
      "per_page",
      "page_size",
      "page_token",
      "pageNumber",
      "page_number",
      "after",
      "before",
      "startingAfter",
      "endingBefore",
      "starting_after",
      "ending_before",
      "nextToken",
      "next_token",
      "continuationToken",
      "continuation_token",
    ]) {
      expect(isBannedPaginationQueryParam(banned), banned).toBe(true);
    }
    expect(BANNED_PAGINATION_QUERY_PARAMS.size).toBe(20);
    expect(isBannedPaginationQueryParam("pageSize")).toBe(false);
    expect(isBannedPaginationQueryParam("pageToken")).toBe(false);
    expect(isBannedPaginationQueryParam("orderBy")).toBe(false);

    for (const bannedProp of [
      "nextCursor",
      "next_cursor",
      "prevCursor",
      "prev_cursor",
      "previousCursor",
      "previous_cursor",
      "prevPageToken",
      "prev_page_token",
      "previousPageToken",
      "previous_page_token",
      "nextPage",
      "next_page",
      "hasMore",
      "has_more",
      "hasNextPage",
      "has_next_page",
      "hasPreviousPage",
      "has_previous_page",
      "pageInfo",
      "page_info",
      "pagination",
      "listMetadata",
      "list_metadata",
      "next_page_token",
    ]) {
      expect(isBannedPaginationResponseProperty(bannedProp), bannedProp).toBe(true);
    }
    expect(BANNED_PAGINATION_RESPONSE_PROPERTIES.size).toBe(24);
    expect(isBannedPaginationResponseProperty("nextPageToken")).toBe(false);
    expect(isBannedPaginationResponseProperty("items")).toBe(false);

    for (const indicator of [
      "nextPageToken",
      "next_page_token",
      "nextCursor",
      "next_cursor",
      "prevPageToken",
      "prevCursor",
      "hasMore",
      "has_more",
      "hasNextPage",
      "hasPreviousPage",
      "nextPage",
    ]) {
      expect(isNestedPaginationIndicatorProperty(indicator), indicator).toBe(true);
      expect(NESTED_PAGINATION_INDICATOR_PROPERTIES.has(indicator), indicator).toBe(true);
    }
    expect(isNestedPaginationIndicatorProperty("requestId")).toBe(false);
  });
});

describe("ADS-0006 Redocly CLI end-to-end linting", () => {
  it("passes the repository valid OpenAPI fixture with zero errors and zero warnings", () => {
    const { exitCode, report } = runRedoclyLint(VALID_FIXTURE);
    expect(exitCode).toBe(0);
    expect(report.totals.errors).toBe(0);
    expect(report.totals.warnings).toBe(0);
    expect(ads0006Problems(report)).toEqual([]);
  });

  it("accepts valid paginated GETs, unpaginated GETs, non-GET methods, $ref compositions, 2XX fallback, and deprecated migration fields", async () => {
    const doc = baseOpenApi({
      paths: {
        "/v1/items": {
          parameters: [{ $ref: "#/components/parameters/SharedPageSize" }],
          get: {
            operationId: "listItems",
            summary: "Paginated collection using path-level and operation-level $ref params",
            parameters: [
              { $ref: "#/components/parameters/SharedPageToken" },
              {
                name: "cursor",
                in: "query",
                deprecated: true,
                description: "Legacy deprecated cursor",
                schema: { type: "string" },
              },
            ],
            responses: {
              "200": { $ref: "#/components/responses/ItemListResponse" },
            },
          },
          post: {
            operationId: "queryItems",
            summary: "Non-GET operations are unaffected",
            parameters: [{ name: "limit", in: "query", schema: { type: "integer" } }],
            responses: {
              "200": listResponse({
                items: { type: "array", items: { type: "string" } },
                hasMore: { type: "boolean" },
              }),
            },
          },
        },
        "/v1/streams": {
          get: {
            operationId: "listStreamEvents",
            summary: "High-throughput stream with exclusiveMinimum, maximum 1000, and 2XX +json",
            parameters: [
              pageSizeParam({
                schema: {
                  allOf: [{ type: "integer", exclusiveMinimum: 0 }, { maximum: 1000 }],
                },
              }),
              pageTokenParam({
                schema: {
                  allOf: [{ type: "string" }, { minLength: 4 }],
                },
              }),
            ],
            responses: {
              "2XX": listResponse(
                {
                  events: { type: "array", items: { type: "string" } },
                  nextPageToken: {
                    allOf: [{ type: "string" }, { minLength: 1 }],
                  },
                  meta: {
                    type: "object",
                    properties: {
                      requestId: { type: "string" },
                    },
                  },
                },
                ["events"],
                "application/vnd.example+json",
              ),
            },
          },
        },
        "/v1/override-deprecated": {
          parameters: [
            { name: "cursor", in: "query", schema: { type: "string" } },
            pageSizeParam({ schema: { type: "integer", minimum: 0 } }),
          ],
          get: {
            operationId: "listWithOverrides",
            summary:
              "Operation overrides path-level cursor as deprecated and fixes pageSize bounds",
            parameters: [
              { name: "cursor", in: "query", deprecated: true, schema: { type: "string" } },
              pageSizeParam({ schema: { type: "integer", minimum: 1, maximum: 50 } }),
              pageTokenParam(),
            ],
            responses: {
              "200": listResponse({
                items: { type: "array", items: { type: "string" } },
                nextPageToken: { type: "string", minLength: 1 },
                nextCursor: { type: "string", deprecated: true },
                page: {
                  type: "object",
                  properties: {
                    nextCursor: { type: "string", deprecated: true },
                  },
                },
                legacyMeta: {
                  type: "object",
                  deprecated: true,
                  properties: {
                    hasMore: { type: "boolean" },
                  },
                },
              }),
            },
          },
        },
        "/v1/scopes": {
          get: {
            operationId: "listScopes",
            summary: "Unpaginated static reference catalog",
            parameters: [
              { name: "cursor", in: "header", schema: { type: "string" } },
              { name: "pageSize", in: "query", deprecated: true, schema: { type: "string" } },
            ],
            responses: {
              "200": listResponse({
                items: { type: "array", items: { type: "string" } },
                nextPageToken: { type: "string", deprecated: true },
              }),
            },
          },
        },
      },
      components: {
        parameters: {
          SharedPageSize: {
            name: "pageSize",
            in: "query",
            description: "Max items per page. Defaults to 25.",
            schema: { type: "integer", minimum: 1, maximum: 200 },
          },
          SharedPageToken: {
            name: "pageToken",
            in: "query",
            description: "Opaque continuation token.",
            schema: { type: "string", minLength: 1 },
          },
        },
        responses: {
          ItemListResponse: {
            description: "Page of items",
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/ItemList" },
              },
            },
          },
        },
        schemas: {
          ItemList: {
            type: "object",
            required: ["items"],
            properties: {
              items: { type: "array", items: { type: "string" } },
              nextPageToken: { type: "string", minLength: 1 },
            },
          },
        },
      },
    });

    const { report } = await lintOpenApi(doc);
    expect(ads0006Problems(report)).toEqual([]);
  });

  it("enforces ads-0006-standard-pagination-params for all 20 banned query params, PathItem $refs, and symmetry", async () => {
    const allBanned = [...BANNED_PAGINATION_QUERY_PARAMS];
    const doc = baseOpenApi({
      paths: {
        "/v1/all-banned": {
          get: {
            operationId: "listAllBanned",
            summary: "Declares every banned query parameter",
            parameters: allBanned.map((name) => ({
              name,
              in: "query",
              schema: { type: "string" },
            })),
            responses: {
              "200": listResponse({
                items: { type: "array", items: { type: "string" } },
              }),
            },
          },
        },
        "/v1/ref-banned": {
          $ref: "#/components/pathItems/LegacyCursorPath",
        },
        "/v1/path-deprecated-overridden": {
          parameters: [
            { name: "limit", in: "query", deprecated: true, schema: { type: "integer" } },
          ],
          get: {
            operationId: "listOverriddenToActive",
            summary: "Operation overrides deprecated path param with non-deprecated limit",
            parameters: [{ name: "limit", in: "query", schema: { type: "integer" } }],
            responses: {
              "200": listResponse({
                items: { type: "array", items: { type: "string" } },
              }),
            },
          },
        },
        "/v1/only-page-size": {
          get: {
            operationId: "listOnlyPageSize",
            summary: "Missing pageToken and nextPageToken",
            parameters: [pageSizeParam()],
            responses: {
              "200": listResponse({ items: { type: "array", items: { type: "string" } } }),
            },
          },
        },
        "/v1/only-page-token": {
          get: {
            operationId: "listOnlyPageToken",
            summary: "Missing pageSize and nextPageToken",
            parameters: [pageTokenParam()],
            responses: {
              "200": listResponse({ items: { type: "array", items: { type: "string" } } }),
            },
          },
        },
        "/v1/only-next-page-token": {
          get: {
            operationId: "listOnlyNextPageToken",
            summary: "Missing pageSize and pageToken",
            responses: {
              "200": listResponse(),
            },
          },
        },
        "/v1/params-without-response-token": {
          get: {
            operationId: "listParamsWithoutNextToken",
            summary: "Has pageSize and pageToken but only deprecated nextPageToken in response",
            parameters: [pageSizeParam(), pageTokenParam()],
            responses: {
              "200": listResponse({
                items: { type: "array", items: { type: "string" } },
                nextPageToken: { type: "string", minLength: 1, deprecated: true },
              }),
            },
          },
        },
        "/v1/params-with-204": {
          get: {
            operationId: "listParamsWith204",
            summary: "Has pageSize and pageToken but returns 204 instead of 200 JSON nextPageToken",
            parameters: [pageSizeParam(), pageTokenParam()],
            responses: {
              "204": { description: "No content" },
            },
          },
        },
        "/v1/ref-unsupported-deprecated-sibling": {
          get: {
            operationId: "listRefUnsupportedDeprecatedSibling",
            summary:
              "Per OpenAPI 3.1, unsupported deprecated: true sibling next to Parameter $ref is ignored",
            parameters: [{ $ref: "#/components/parameters/LegacyOffset", deprecated: true }],
            responses: {
              "200": listResponse({ items: { type: "array", items: { type: "string" } } }),
            },
          },
        },
        "/v1/ref-target-deprecated": {
          get: {
            operationId: "listRefTargetDeprecated",
            summary:
              "Component Parameter with deprecated: true on the target itself is skipped even with sibling deprecated: false",
            parameters: [
              { $ref: "#/components/parameters/DeprecatedLegacyCursor", deprecated: false },
            ],
            responses: {
              "200": listResponse({ items: { type: "array", items: { type: "string" } } }),
            },
          },
        },
      },
      components: {
        pathItems: {
          LegacyCursorPath: {
            parameters: [{ $ref: "#/components/parameters/LegacyOffset" }],
            get: {
              operationId: "listRefBanned",
              summary: "Uses $ref PathItem with $ref banned param",
              responses: {
                "200": listResponse({ items: { type: "array", items: { type: "string" } } }),
              },
            },
          },
        },
        parameters: {
          LegacyOffset: {
            name: "offset",
            in: "query",
            schema: { type: "integer" },
          },
          DeprecatedLegacyCursor: {
            name: "cursor",
            in: "query",
            deprecated: true,
            schema: { type: "string" },
          },
        },
      },
    });

    const { report } = await lintOpenApi(doc);
    const paramErrors = ads0006ProblemsFor(report, "ads-0006-standard-pagination-params");

    for (const banned of allBanned) {
      expect(
        paramErrors.some(
          (p) => p.message.includes('GET "/v1/all-banned"') && p.message.includes(`"${banned}"`),
        ),
        `expected banned query param ${banned} to be reported`,
      ).toBe(true);
    }
    expect(
      paramErrors.some(
        (p) => p.message.includes('GET "/v1/ref-banned"') && p.message.includes('"offset"'),
      ),
    ).toBe(true);
    expect(
      paramErrors.some(
        (p) =>
          p.message.includes('GET "/v1/path-deprecated-overridden"') &&
          p.message.includes('"limit"'),
      ),
    ).toBe(true);
    expect(
      paramErrors.some(
        (p) =>
          p.message.includes('GET "/v1/ref-unsupported-deprecated-sibling"') &&
          p.message.includes('"offset"'),
      ),
    ).toBe(true);
    expect(paramErrors.some((p) => p.message.includes('GET "/v1/ref-target-deprecated"'))).toBe(
      false,
    );

    for (const partialPath of [
      "/v1/only-page-size",
      "/v1/only-page-token",
      "/v1/only-next-page-token",
      "/v1/params-without-response-token",
      "/v1/params-with-204",
    ]) {
      expect(
        paramErrors.some(
          (p) =>
            p.message.includes(`GET "${partialPath}"`) &&
            p.message.includes("declares partial pagination"),
        ),
        `expected symmetry violation on ${partialPath}`,
      ).toBe(true);
    }
    expect(paramErrors).toHaveLength(allBanned.length + 3 + 5);
  });

  it("enforces ads-0006-page-size-bounds on pageSize and pageToken (optionality, type, nullability, bounds, minLength)", async () => {
    const doc = baseOpenApi({
      paths: {
        "/v1/required-and-zero-min": {
          get: {
            operationId: "listRequiredAndZeroMin",
            summary: "Required params, minimum 0, and missing minLength",
            parameters: [
              pageSizeParam({
                required: true,
                schema: { type: "integer", minimum: 0, maximum: 100 },
              }),
              pageTokenParam({
                required: true,
                schema: { type: "string" },
              }),
            ],
            responses: { "200": listResponse() },
          },
        },
        "/v1/unbounded-and-zero-minlength": {
          get: {
            operationId: "listUnboundedAndZeroMinLength",
            summary: "Omitted min/max and minLength 0",
            parameters: [
              pageSizeParam({ schema: { type: "integer" } }),
              pageTokenParam({ schema: { type: "string", minLength: 0 } }),
            ],
            responses: { "200": listResponse() },
          },
        },
        "/v1/pseudo-max-and-nullable": {
          get: {
            operationId: "listPseudoMaxAndNullable",
            summary: "MAX_SAFE_INTEGER max and nullable types via oneOf",
            parameters: [
              pageSizeParam({
                schema: {
                  oneOf: [
                    { type: "integer", minimum: 1, maximum: 9007199254740991 },
                    { type: "null" },
                  ],
                },
              }),
              pageTokenParam({
                schema: {
                  oneOf: [{ type: "string", minLength: 1 }, { type: "null" }],
                },
              }),
            ],
            responses: { "200": listResponse() },
          },
        },
        "/v1/inverted-and-wrong-types": {
          get: {
            operationId: "listInvertedAndWrongTypes",
            summary: "Inverted range and non-integer/non-string types",
            parameters: [
              pageSizeParam({ schema: { type: "number", minimum: 50, maximum: 10 } }),
              pageTokenParam({ schema: { type: "integer" } }),
            ],
            responses: { "200": listResponse() },
          },
        },
        "/v1/negative-and-over-cap": {
          get: {
            operationId: "listNegativeAndOverCap",
            summary: "Negative minimum and maximum 1001",
            parameters: [
              pageSizeParam({ schema: { type: "integer", minimum: -5, maximum: 1001 } }),
              pageTokenParam({ schema: { type: ["string", "null"], minLength: 1 } }),
            ],
            responses: { "200": listResponse() },
          },
        },
        "/v1/ref-bad-bounds": {
          get: {
            operationId: "listRefBadBounds",
            summary: "Bad bounds behind component parameter $ref",
            parameters: [
              { $ref: "#/components/parameters/BadPageSize" },
              { $ref: "#/components/parameters/BadPageToken" },
            ],
            responses: { "200": listResponse() },
          },
        },
      },
      components: {
        parameters: {
          BadPageSize: {
            name: "pageSize",
            in: "query",
            schema: { type: "string" },
          },
          BadPageToken: {
            name: "pageToken",
            in: "query",
            schema: { type: "string", nullable: true },
          },
        },
      },
    });

    const { report } = await lintOpenApi(doc);
    const boundsErrors = ads0006ProblemsFor(report, "ads-0006-page-size-bounds");

    expect(
      boundsErrors.some(
        (p) =>
          p.message.includes('GET "/v1/required-and-zero-min"') &&
          p.message.includes('"pageSize" must be optional'),
      ),
    ).toBe(true);
    expect(
      boundsErrors.some(
        (p) =>
          p.message.includes('GET "/v1/required-and-zero-min"') &&
          p.message.includes("declares minimum 0"),
      ),
    ).toBe(true);
    expect(
      boundsErrors.some(
        (p) =>
          p.message.includes('GET "/v1/required-and-zero-min"') &&
          p.message.includes('"pageToken" must be optional'),
      ),
    ).toBe(true);
    expect(
      boundsErrors.some(
        (p) =>
          p.message.includes('GET "/v1/required-and-zero-min"') &&
          p.message.includes('"pageToken" must declare an explicit "minLength" >= 1'),
      ),
    ).toBe(true);

    expect(
      boundsErrors.some(
        (p) =>
          p.message.includes('GET "/v1/unbounded-and-zero-minlength"') &&
          p.message.includes('explicit "minimum" >= 1'),
      ),
    ).toBe(true);
    expect(
      boundsErrors.some(
        (p) =>
          p.message.includes('GET "/v1/unbounded-and-zero-minlength"') &&
          p.message.includes('explicit "maximum" <= 1000'),
      ),
    ).toBe(true);
    expect(
      boundsErrors.some(
        (p) =>
          p.message.includes('GET "/v1/unbounded-and-zero-minlength"') &&
          p.message.includes('"pageToken" must declare an explicit "minLength" >= 1'),
      ),
    ).toBe(true);

    // Nullable oneOf where string/integer branch HAS minLength: 1 should NOT emit spurious minLength errors.
    const pseudoMaxTokenErrors = boundsErrors.filter(
      (p) =>
        p.message.includes('GET "/v1/pseudo-max-and-nullable"') &&
        p.message.includes('"pageToken"'),
    );
    expect(pseudoMaxTokenErrors).toHaveLength(1);
    expect(pseudoMaxTokenErrors[0]?.message).toContain('non-nullable "string"');

    expect(
      boundsErrors.some(
        (p) =>
          p.message.includes('GET "/v1/pseudo-max-and-nullable"') &&
          p.message.includes("declares maximum 9007199254740991"),
      ),
    ).toBe(true);
    expect(
      boundsErrors.some(
        (p) =>
          p.message.includes('GET "/v1/inverted-and-wrong-types"') &&
          p.message.includes('non-nullable "integer"') &&
          p.message.includes('"number|integer"'),
      ),
    ).toBe(true);
    expect(
      boundsErrors.some(
        (p) =>
          p.message.includes('GET "/v1/inverted-and-wrong-types"') &&
          p.message.includes("invalid bounds"),
      ),
    ).toBe(true);
    expect(
      boundsErrors.some(
        (p) =>
          p.message.includes('GET "/v1/negative-and-over-cap"') &&
          p.message.includes("declares minimum -5"),
      ),
    ).toBe(true);
    expect(
      boundsErrors.some(
        (p) =>
          p.message.includes('GET "/v1/negative-and-over-cap"') &&
          p.message.includes("declares maximum 1001"),
      ),
    ).toBe(true);
    expect(
      boundsErrors.some(
        (p) =>
          p.message.includes('GET "/v1/ref-bad-bounds"') &&
          p.message.includes('"pageSize"') &&
          p.message.includes('"string"'),
      ),
    ).toBe(true);
    expect(
      boundsErrors.some(
        (p) =>
          p.message.includes('GET "/v1/ref-bad-bounds"') &&
          p.message.includes('"pageToken"') &&
          p.message.includes("minLength"),
      ),
    ).toBe(true);
  });

  it("enforces ads-0006-pagination-response-shape on nextPageToken, all 24 banned properties, and nested wrappers", async () => {
    const allBannedProps = [...BANNED_PAGINATION_RESPONSE_PROPERTIES];
    const bannedSchemaProps: Record<string, unknown> = {
      items: { type: "array", items: { type: "string" } },
    };
    for (const propName of allBannedProps) {
      bannedSchemaProps[propName] = { type: "string" };
    }

    const doc = baseOpenApi({
      paths: {
        "/v1/required-nullable-empty-token": {
          get: {
            operationId: "listBadNextPageToken",
            summary: "Required nullable nextPageToken without minLength",
            parameters: [pageSizeParam(), pageTokenParam()],
            responses: {
              "200": listResponse(
                {
                  items: { type: "array", items: { type: "string" } },
                  nextPageToken: { type: ["string", "null"] },
                },
                ["items", "nextPageToken"],
              ),
            },
          },
        },
        "/v1/oas30-nullable-and-zero-minlength": {
          get: {
            operationId: "listNullableAndZeroMinLength",
            summary: "nullable: true and minLength: 0 on nextPageToken",
            parameters: [pageSizeParam(), pageTokenParam()],
            responses: {
              "200": listResponse({
                items: { type: "array", items: { type: "string" } },
                nextPageToken: { type: "string", nullable: true, minLength: 0 },
              }),
            },
          },
        },
        "/v1/oneof-null-token": {
          get: {
            operationId: "listOneOfNullToken",
            summary: "oneOf with null branch on nextPageToken",
            parameters: [pageSizeParam(), pageTokenParam()],
            responses: {
              "200": listResponse({
                items: { type: "array", items: { type: "string" } },
                nextPageToken: {
                  oneOf: [{ type: "string", minLength: 1 }, { type: "null" }],
                },
              }),
            },
          },
        },
        "/v1/all-banned-response-props": {
          get: {
            operationId: "listAllBannedResponseProps",
            summary: "Every banned top-level pagination property",
            responses: {
              "200": listResponse(bannedSchemaProps),
            },
          },
        },
        "/v1/nested-wrappers": {
          get: {
            operationId: "listNestedWrappers",
            summary: "Nested pagination indicators inside custom wrapper objects",
            responses: {
              "200": listResponse({
                items: { type: "array", items: { type: "string" } },
                page: {
                  type: "object",
                  properties: {
                    nextPageToken: { type: "string", minLength: 1 },
                  },
                },
                meta: { $ref: "#/components/schemas/PagingMeta" },
                envelope: {
                  anyOf: [
                    {
                      type: "object",
                      properties: {
                        hasNextPage: { type: "boolean" },
                      },
                    },
                    { type: "null" },
                  ],
                },
              }),
            },
          },
        },
        "/v1/explicit-200-overrides-2xx": {
          get: {
            operationId: "listExplicit200",
            summary: "Valid explicit 200 prevents invalid 2XX fallback from firing",
            parameters: [pageSizeParam(), pageTokenParam()],
            responses: {
              "200": listResponse(),
              "2XX": listResponse({
                items: { type: "array", items: { type: "string" } },
                hasMore: { type: "boolean" },
              }),
            },
          },
        },
      },
      components: {
        schemas: {
          PagingMeta: {
            allOf: [
              { type: "object", properties: { requestId: { type: "string" } } },
              { type: "object", properties: { nextCursor: { type: "string" } } },
            ],
          },
        },
      },
    });

    const { report } = await lintOpenApi(doc);
    const shapeErrors = ads0006ProblemsFor(report, "ads-0006-pagination-response-shape");

    expect(
      shapeErrors.some(
        (p) =>
          p.message.includes('GET "/v1/required-nullable-empty-token"') &&
          p.message.includes('not in "required"'),
      ),
    ).toBe(true);
    expect(
      shapeErrors.some(
        (p) =>
          p.message.includes('GET "/v1/required-nullable-empty-token"') &&
          p.message.includes('non-nullable "string"'),
      ),
    ).toBe(true);
    expect(
      shapeErrors.some(
        (p) =>
          p.message.includes('GET "/v1/required-nullable-empty-token"') &&
          p.message.includes('"minLength" >= 1'),
      ),
    ).toBe(true);

    expect(
      shapeErrors.some(
        (p) =>
          p.message.includes('GET "/v1/oas30-nullable-and-zero-minlength"') &&
          p.message.includes('non-nullable "string"'),
      ),
    ).toBe(true);
    expect(
      shapeErrors.some(
        (p) =>
          p.message.includes('GET "/v1/oas30-nullable-and-zero-minlength"') &&
          p.message.includes('"minLength" >= 1'),
      ),
    ).toBe(true);

    const oneOfErrors = shapeErrors.filter((p) => p.message.includes('GET "/v1/oneof-null-token"'));
    expect(oneOfErrors).toHaveLength(1);
    expect(oneOfErrors[0]?.message).toContain('non-nullable "string"');

    for (const bannedProp of allBannedProps) {
      expect(
        shapeErrors.some(
          (p) =>
            p.message.includes('GET "/v1/all-banned-response-props"') &&
            p.message.includes(`"${bannedProp}"`),
        ),
        `expected banned response property ${bannedProp} to be reported`,
      ).toBe(true);
    }

    expect(
      shapeErrors.some(
        (p) =>
          p.message.includes('GET "/v1/nested-wrappers"') &&
          p.message.includes('"nextPageToken"') &&
          p.message.includes('"page"'),
      ),
    ).toBe(true);
    expect(
      shapeErrors.some(
        (p) =>
          p.message.includes('GET "/v1/nested-wrappers"') &&
          p.message.includes('"nextCursor"') &&
          p.message.includes('"meta"'),
      ),
    ).toBe(true);
    expect(
      shapeErrors.some(
        (p) =>
          p.message.includes('GET "/v1/nested-wrappers"') &&
          p.message.includes('"hasNextPage"') &&
          p.message.includes('"envelope"'),
      ),
    ).toBe(true);

    expect(
      shapeErrors.some((p) => p.message.includes('GET "/v1/explicit-200-overrides-2xx"')),
    ).toBe(false);
  });

  it("supports declarative rule-level ignore options across all three ADS-0006 rules", async () => {
    const configPath = await writeRedoclyConfig({
      "photon-ads/ads-0006-standard-pagination-params": {
        severity: "error",
        ignore: [
          {
            path: "/v1/legacy/cursor/",
            method: "GET",
            reason: "Legacy cursor endpoint",
          },
          {
            path: "/v1/still-flagged",
            method: "post",
            reason: "POST ignore must not suppress GET",
          },
        ],
      },
      "photon-ads/ads-0006-page-size-bounds": {
        severity: "error",
        ignore: [
          {
            path: "/v1/legacy/bounds",
            reason: "Legacy unbounded pageSize",
          },
        ],
      },
      "photon-ads/ads-0006-pagination-response-shape": {
        severity: "error",
        ignore: [
          {
            schema: "LegacyCursorList",
            reason: "Legacy response schema pending migration",
          },
        ],
      },
    });

    const doc = baseOpenApi({
      paths: {
        "/v1/legacy/cursor": {
          get: {
            operationId: "listLegacyCursor",
            summary: "Ignored legacy cursor route",
            parameters: [{ name: "cursor", in: "query", schema: { type: "string" } }],
            responses: {
              "200": {
                description: "Legacy response",
                content: {
                  "application/json": {
                    schema: { $ref: "#/components/schemas/LegacyCursorList" },
                  },
                },
              },
            },
          },
        },
        "/v1/legacy/bounds": {
          get: {
            operationId: "listLegacyBounds",
            summary: "Ignored legacy bounds route",
            parameters: [
              pageSizeParam({ schema: { type: "integer", minimum: 0 } }),
              pageTokenParam({ schema: { type: "string" } }),
            ],
            responses: { "200": listResponse() },
          },
        },
        "/v1/still-flagged": {
          get: {
            operationId: "listStillFlagged",
            summary: "Not ignored because ignore entry targets POST only",
            parameters: [{ name: "limit", in: "query", schema: { type: "integer" } }],
            responses: {
              "200": listResponse({
                items: { type: "array", items: { type: "string" } },
              }),
            },
          },
        },
      },
      components: {
        schemas: {
          LegacyCursorList: {
            type: "object",
            properties: {
              items: { type: "array", items: { type: "string" } },
              nextCursor: { type: "string" },
            },
          },
        },
      },
    });

    const { report } = await lintOpenApi(doc, configPath);
    const problems = ads0006Problems(report);
    expect(problems).toHaveLength(1);
    expect(problems[0]?.ruleId).toBe("photon-ads/ads-0006-standard-pagination-params");
    expect(problems[0]?.message).toContain('GET "/v1/still-flagged"');
  });

  it("preserves distinct anyOf branches differing in minLength, deprecation, or nested wrappers regardless of branch order", async () => {
    const validTokenBranch = {
      type: "object",
      properties: {
        nextPageToken: { type: "string", minLength: 1 },
      },
    };
    const emptyTokenBranch = {
      type: "object",
      properties: {
        nextPageToken: { type: "string", minLength: 0 },
      },
    };
    const deprecatedCursorBranch = {
      type: "object",
      properties: {
        nextCursor: { type: "string", deprecated: true },
      },
    };
    const activeCursorBranch = {
      type: "object",
      properties: {
        nextCursor: { type: "string" },
      },
    };
    const benignMetaBranch = {
      type: "object",
      properties: {
        meta: {
          type: "object",
          properties: {
            requestId: { type: "string" },
          },
        },
      },
    };
    const nestedWrapperMetaBranch = {
      type: "object",
      properties: {
        meta: {
          type: "object",
          properties: {
            nextCursor: { type: "string" },
          },
        },
      },
    };

    const makeUnionResponse = (branches: unknown[]) => ({
      description: "OK",
      content: {
        "application/json": {
          schema: {
            type: "object",
            required: ["items"],
            properties: {
              items: { type: "array", items: { type: "string" } },
            },
            anyOf: branches,
          },
        },
      },
    });

    const doc = baseOpenApi({
      paths: {
        "/v1/minlen-valid-first": {
          get: {
            operationId: "listMinLenValidFirst",
            parameters: [pageSizeParam(), pageTokenParam()],
            responses: { "200": makeUnionResponse([validTokenBranch, emptyTokenBranch]) },
          },
        },
        "/v1/minlen-invalid-first": {
          get: {
            operationId: "listMinLenInvalidFirst",
            parameters: [pageSizeParam(), pageTokenParam()],
            responses: { "200": makeUnionResponse([emptyTokenBranch, validTokenBranch]) },
          },
        },
        "/v1/deprecated-first": {
          get: {
            operationId: "listDeprecatedFirst",
            responses: { "200": makeUnionResponse([deprecatedCursorBranch, activeCursorBranch]) },
          },
        },
        "/v1/active-first": {
          get: {
            operationId: "listActiveFirst",
            responses: { "200": makeUnionResponse([activeCursorBranch, deprecatedCursorBranch]) },
          },
        },
        "/v1/wrapper-benign-first": {
          get: {
            operationId: "listWrapperBenignFirst",
            responses: {
              "200": makeUnionResponse([benignMetaBranch, nestedWrapperMetaBranch]),
            },
          },
        },
        "/v1/wrapper-bad-first": {
          get: {
            operationId: "listWrapperBadFirst",
            responses: {
              "200": makeUnionResponse([nestedWrapperMetaBranch, benignMetaBranch]),
            },
          },
        },
        "/v1/nested-deprecated-first": {
          get: {
            operationId: "listNestedDeprecatedFirst",
            responses: {
              "200": listResponse({
                items: { type: "array", items: { type: "string" } },
                meta: {
                  anyOf: [deprecatedCursorBranch, activeCursorBranch],
                },
              }),
            },
          },
        },
        "/v1/nested-active-first": {
          get: {
            operationId: "listNestedActiveFirst",
            responses: {
              "200": listResponse({
                items: { type: "array", items: { type: "string" } },
                meta: {
                  anyOf: [activeCursorBranch, deprecatedCursorBranch],
                },
              }),
            },
          },
        },
      },
    });

    const { report } = await lintOpenApi(doc);
    const shapeErrors = ads0006ProblemsFor(report, "ads-0006-pagination-response-shape");

    for (const path of ["/v1/minlen-valid-first", "/v1/minlen-invalid-first"]) {
      expect(
        shapeErrors.some(
          (p) => p.message.includes(`GET "${path}"`) && p.message.includes('"minLength" >= 1'),
        ),
        `expected minLength error on ${path}`,
      ).toBe(true);
    }
    for (const path of ["/v1/deprecated-first", "/v1/active-first"]) {
      expect(
        shapeErrors.some(
          (p) =>
            p.message.includes(`GET "${path}"`) &&
            p.message.includes('non-standard pagination response property "nextCursor"'),
        ),
        `expected banned nextCursor error on ${path}`,
      ).toBe(true);
    }
    for (const path of [
      "/v1/wrapper-benign-first",
      "/v1/wrapper-bad-first",
      "/v1/nested-deprecated-first",
      "/v1/nested-active-first",
    ]) {
      expect(
        shapeErrors.some(
          (p) =>
            p.message.includes(`GET "${path}"`) &&
            p.message.includes(
              'nests pagination field "nextCursor" inside top-level object property "meta"',
            ),
        ),
        `expected nested wrapper error on ${path}`,
      ).toBe(true);
    }
    expect(shapeErrors).toHaveLength(8);
  });

  it("rejects open anyOf variants omitting nextPageToken, collapses unrelated binary unions, and surfaces genuine variant-cap truncation", async () => {
    const unrelatedBinaryAnyOfs = Array.from({ length: 9 }, (_, index) => ({
      anyOf: [
        { type: "object", properties: { [`a${index}`]: { type: "string" } } },
        { type: "object", properties: { [`b${index}`]: { type: "string" } } },
      ],
    }));

    const distinctPaginationProps = [
      "nextCursor",
      "prevCursor",
      "hasMore",
      "hasNextPage",
      "nextPage",
      "prevPageToken",
      "previousPageToken",
      "next_cursor",
      "has_more",
    ];
    const paginationOverflowAllOf = distinctPaginationProps.map((prop) => ({
      anyOf: [
        { type: "object", properties: { [`ok_${prop}`]: { type: "string" } } },
        { type: "object", properties: { [prop]: { type: "string" } } },
      ],
    }));

    const doc = baseOpenApi({
      paths: {
        "/v1/polymorphic-valid": {
          get: {
            operationId: "listPolymorphicValid",
            parameters: [pageSizeParam(), pageTokenParam()],
            responses: {
              "200": {
                description: "All object variants declare valid optional nextPageToken",
                content: {
                  "application/json": {
                    schema: {
                      oneOf: [
                        {
                          type: "object",
                          required: ["items"],
                          properties: {
                            kind: { const: "a" },
                            items: { type: "array", items: { type: "string" } },
                            nextPageToken: { type: "string", minLength: 1 },
                          },
                        },
                        {
                          type: "object",
                          required: ["items"],
                          properties: {
                            kind: { const: "b" },
                            items: { type: "array", items: { type: "string" } },
                            nextPageToken: { type: "string", minLength: 1 },
                          },
                        },
                      ],
                    },
                  },
                },
              },
            },
          },
        },
        "/v1/open-anyof-missing-token": {
          get: {
            operationId: "listOpenAnyOfMissingToken",
            parameters: [pageSizeParam(), pageTokenParam()],
            responses: {
              "200": {
                description: "Second object variant omits nextPageToken and stays open",
                content: {
                  "application/json": {
                    schema: {
                      anyOf: [
                        {
                          type: "object",
                          required: ["items"],
                          properties: {
                            items: { type: "array", items: { type: "string" } },
                            nextPageToken: { type: "string", minLength: 1 },
                          },
                        },
                        {
                          type: "object",
                          required: ["items"],
                          properties: {
                            items: { type: "array", items: { type: "string" } },
                          },
                        },
                      ],
                    },
                  },
                },
              },
            },
          },
        },
        "/v1/unconstrained-anyof-branch": {
          get: {
            operationId: "listUnconstrainedAnyOfBranch",
            parameters: [pageSizeParam(), pageTokenParam()],
            responses: {
              "200": {
                description: "Unconstrained empty schema branch can accept empty nextPageToken",
                content: {
                  "application/json": {
                    schema: {
                      anyOf: [
                        {
                          type: "object",
                          required: ["items"],
                          properties: {
                            items: { type: "array", items: { type: "string" } },
                            nextPageToken: { type: "string", minLength: 1 },
                          },
                        },
                        {},
                      ],
                    },
                  },
                },
              },
            },
          },
        },
        "/v1/unrelated-union-with-next-cursor": {
          get: {
            operationId: "listUnrelatedUnionWithNextCursor",
            responses: {
              "200": {
                description:
                  "9 unrelated binary anyOf groups must not hide a nextCursor branch behind truncation",
                content: {
                  "application/json": {
                    schema: {
                      allOf: [
                        {
                          anyOf: [
                            { type: "object", properties: { ok: { type: "string" } } },
                            { type: "object", properties: { nextCursor: { type: "string" } } },
                          ],
                        },
                        ...unrelatedBinaryAnyOfs,
                      ],
                    },
                  },
                },
              },
            },
          },
        },
        "/v1/pagination-variant-cap-overflow": {
          get: {
            operationId: "listPaginationVariantCapOverflow",
            responses: {
              "200": {
                description: "512 distinct pagination combinations exceed 256-variant cap",
                content: {
                  "application/json": {
                    schema: { allOf: paginationOverflowAllOf },
                  },
                },
              },
            },
          },
        },
        "/v1/nested-variant-cap-overflow": {
          get: {
            operationId: "listNestedVariantCapOverflow",
            responses: {
              "200": listResponse({
                items: { type: "array", items: { type: "string" } },
                meta: {
                  type: "object",
                  allOf: paginationOverflowAllOf,
                },
              }),
            },
          },
        },
      },
    });

    const { report } = await lintOpenApi(doc);
    const paramErrors = ads0006ProblemsFor(report, "ads-0006-standard-pagination-params");
    const shapeErrors = ads0006ProblemsFor(report, "ads-0006-pagination-response-shape");

    expect(
      ads0006Problems(report).some((p) => p.message.includes('GET "/v1/polymorphic-valid"')),
    ).toBe(false);

    for (const path of ["/v1/open-anyof-missing-token", "/v1/unconstrained-anyof-branch"]) {
      expect(
        paramErrors.some(
          (p) =>
            p.message.includes(`GET "${path}"`) &&
            p.message.includes("on every object response variant"),
        ),
        `expected partial-variant symmetry error on ${path}`,
      ).toBe(true);
    }

    expect(
      shapeErrors.some(
        (p) =>
          p.message.includes('GET "/v1/unrelated-union-with-next-cursor"') &&
          p.message.includes('non-standard pagination response property "nextCursor"'),
      ),
    ).toBe(true);
    expect(
      ads0006Problems(report).some(
        (p) =>
          p.message.includes('GET "/v1/unrelated-union-with-next-cursor"') &&
          p.message.includes("variant union analysis cap"),
      ),
    ).toBe(false);

    expect(
      paramErrors.some(
        (p) =>
          p.message.includes('GET "/v1/pagination-variant-cap-overflow"') &&
          p.message.includes("256-variant union analysis cap"),
      ),
    ).toBe(true);
    expect(
      shapeErrors.some(
        (p) =>
          p.message.includes('GET "/v1/pagination-variant-cap-overflow"') &&
          p.message.includes("256-variant union analysis cap"),
      ),
    ).toBe(true);
    expect(
      shapeErrors.some(
        (p) =>
          p.message.includes('GET "/v1/nested-variant-cap-overflow"') &&
          p.message.includes('property "meta"') &&
          p.message.includes("256-variant union analysis cap"),
      ),
    ).toBe(true);
  });
});
