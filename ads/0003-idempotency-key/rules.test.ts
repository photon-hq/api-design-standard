import { execFileSync, spawnSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { stringify as stringifyYaml } from "yaml";
import { ADS_0003_METADATA, isIdempotencyKeyHeader } from "./rules.js";

const REPO_ROOT = resolve(fileURLToPath(new URL("../..", import.meta.url)));
const REDOCLY_BIN = resolve(REPO_ROOT, "node_modules/.bin/redocly");
const REDOCLY_CONFIG = resolve(REPO_ROOT, "redocly.yaml");

interface RedoclyJsonProblem {
  ruleId: string;
  message: string;
  location?: Array<{ pointer?: string }>;
}

let tempDir: string;
let specCounter = 0;

const KEY_PLACEMENT_RULES = [
  "ads-0003-idempotency-key-method",
  "ads-0003-idempotency-key-optional",
];

async function lintAds0003(
  paths: Record<string, unknown>,
  components?: Record<string, unknown>,
  rules: readonly string[] = KEY_PLACEMENT_RULES,
) {
  specCounter += 1;
  const specPath = join(tempDir, `spec-${specCounter}.yaml`);
  const doc = {
    openapi: "3.1.0",
    info: {
      title: "Test API",
      version: "1.0.0",
      description: "Test specification for ADS-0003.",
      license: { name: "Apache-2.0", url: "https://www.apache.org/licenses/LICENSE-2.0" },
    },
    servers: [{ url: "https://api.example.com" }],
    paths,
    ...(components ? { components } : {}),
  };
  await writeFile(specPath, stringifyYaml(doc), "utf8");
  const result = spawnSync(
    REDOCLY_BIN,
    ["lint", specPath, "--config", REDOCLY_CONFIG, "--format=json"],
    {
      cwd: REPO_ROOT,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  if (!result.stdout?.trim()) {
    throw new Error(`Redocly failed without JSON output (exit ${result.status}): ${result.stderr}`);
  }
  const report = JSON.parse(result.stdout) as { problems: RedoclyJsonProblem[] };
  return report.problems
    .map((problem) => ({
      rule: problem.ruleId.replace("photon-ads/", ""),
      pointer: problem.location?.[0]?.pointer,
    }))
    .filter((problem) => rules.includes(problem.rule))
    .sort((a, b) => `${a.rule}${a.pointer}`.localeCompare(`${b.rule}${b.pointer}`));
}

function keyParam(name: string, required?: boolean): Record<string, unknown> {
  return {
    name,
    in: "header",
    ...(required === undefined ? {} : { required }),
    schema: { type: "string" },
  };
}

function op(operationId: string, parameters?: unknown[]): Record<string, unknown> {
  return {
    operationId,
    summary: operationId,
    ...(parameters ? { parameters } : {}),
    responses: { "204": { description: "No content." }, "400": { description: "Bad request." } },
  };
}

const KEY_SCHEMA = {
  type: "string",
  minLength: 1,
  maxLength: 255,
  pattern: "^[\\x21-\\x7e]{1,255}$",
};

function problemSchema(code: string): Record<string, unknown> {
  return {
    type: "object",
    required: ["code"],
    properties: { code: { type: "string", const: code } },
  };
}

function problemResponse(
  schema: unknown,
  headers?: Record<string, unknown>,
): Record<string, unknown> {
  return {
    description: "Problem.",
    ...(headers ? { headers } : {}),
    content: { "application/problem+json": { schema } },
  };
}

const schemaRef = (name: string) => ({ $ref: `#/components/schemas/${name}` });

const PROBLEM_SCHEMAS = {
  IdempotencyKeyInvalidProblem: problemSchema("IDEMPOTENCY_KEY_INVALID"),
  IdempotencyKeyRequiredProblem: problemSchema("IDEMPOTENCY_KEY_REQUIRED"),
  IdempotencyKeyReusedProblem: problemSchema("IDEMPOTENCY_KEY_REUSED"),
  IdempotencyRequestInProgressProblem: problemSchema("IDEMPOTENCY_REQUEST_IN_PROGRESS"),
  IdempotencyConflictProblem: problemSchema("IDEMPOTENCY_CONFLICT"),
  ValidationFailedProblem: problemSchema("VALIDATION_FAILED"),
  CreateThingBadRequestProblem: {
    oneOf: [schemaRef("IdempotencyKeyInvalidProblem"), schemaRef("ValidationFailedProblem")],
  },
};

beforeAll(async () => {
  tempDir = await mkdtemp(join(tmpdir(), "photon-ads-0003-"));
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

describe("ADS-0003 unit helpers", () => {
  it("matches only Idempotency-Key header parameters, case-insensitively", () => {
    expect(isIdempotencyKeyHeader(keyParam("Idempotency-Key"))).toBe(true);
    expect(isIdempotencyKeyHeader(keyParam("idempotency-key"))).toBe(true);
    expect(isIdempotencyKeyHeader(keyParam("IDEMPOTENCY-KEY"))).toBe(true);
    expect(isIdempotencyKeyHeader({ name: "Idempotency-Key", in: "query" })).toBe(false);
    expect(isIdempotencyKeyHeader(keyParam("Idempotency-Key-Hint"))).toBe(false);
    expect(isIdempotencyKeyHeader(null)).toBe(false);
  });

  it("exposes metadata for all ADS-0003 rules", () => {
    expect(ADS_0003_METADATA.ads).toBe("0003");
    expect(ADS_0003_METADATA.rules.map((rule) => [rule.id, rule.severity])).toEqual([
      ["photon-ads/ads-0003-idempotency-key-method", "error"],
      ["photon-ads/ads-0003-idempotency-key-optional", "error"],
      ["photon-ads/ads-0003-idempotency-key-name", "error"],
      ["photon-ads/ads-0003-idempotency-key-schema", "error"],
      ["photon-ads/ads-0003-idempotency-no-required-problem", "error"],
      ["photon-ads/ads-0003-idempotent-replayed-header", "error"],
      ["photon-ads/ads-0003-idempotency-problems", "error"],
    ]);
  });
});

describe("ADS-0003 end-to-end Redocly CLI enforcement", () => {
  it("passes optional keys on POST and PATCH and idempotent methods without a key", async () => {
    expect(
      await lintAds0003({
        "/v1/messages": {
          post: op("sendMessage", [keyParam("Idempotency-Key", false)]),
          get: op("listMessages", [
            { name: "Idempotency-Key", in: "query", schema: { type: "string" } },
          ]),
        },
        "/v1/messages/{messageId}": {
          parameters: [
            { name: "messageId", in: "path", required: true, schema: { type: "string" } },
          ],
          patch: op("updateMessage", [keyParam("idempotency-key")]),
          put: op("replaceMessage"),
          delete: op("deleteMessage"),
        },
        "/v1/drafts": {
          parameters: [keyParam("Idempotency-Key", true)],
          post: op("createDraft", [keyParam("Idempotency-Key", false)]),
        },
      }),
    ).toEqual([]);
  });

  it("rejects Idempotency-Key on GET, HEAD, OPTIONS, PUT, and DELETE at operation and path level", async () => {
    expect(
      await lintAds0003(
        {
          "/v1/items": {
            get: op("listItems", [keyParam("Idempotency-Key")]),
            head: op("headItems", [keyParam("IDEMPOTENCY-KEY", false)]),
            options: op("itemOptions", [keyParam("idempotency-key")]),
          },
          "/v1/items/{itemId}": {
            parameters: [
              { name: "itemId", in: "path", required: true, schema: { type: "string" } },
              keyParam("idempotency-key"),
            ],
            put: op("replaceItem", [{ $ref: "#/components/parameters/IdempotencyKey" }]),
            delete: op("deleteItem"),
            post: op("actOnItem"),
          },
          "/v1/widgets": { $ref: "#/components/pathItems/Widgets" },
        },
        {
          parameters: { IdempotencyKey: keyParam("Idempotency-Key", true) },
          pathItems: { Widgets: { put: op("replaceWidgets", [keyParam("idempotency-key")]) } },
        },
      ),
    ).toEqual([
      {
        rule: "ads-0003-idempotency-key-method",
        pointer: "#/components/pathItems/Widgets/put/parameters/0",
      },
      { rule: "ads-0003-idempotency-key-method", pointer: "#/paths/~1v1~1items/get/parameters/0" },
      { rule: "ads-0003-idempotency-key-method", pointer: "#/paths/~1v1~1items/head/parameters/0" },
      {
        rule: "ads-0003-idempotency-key-method",
        pointer: "#/paths/~1v1~1items/options/parameters/0",
      },
      {
        rule: "ads-0003-idempotency-key-method",
        pointer: "#/paths/~1v1~1items~1{itemId}/parameters/1",
      },
      {
        rule: "ads-0003-idempotency-key-method",
        pointer: "#/paths/~1v1~1items~1{itemId}/parameters/1",
      },
      {
        rule: "ads-0003-idempotency-key-method",
        pointer: "#/paths/~1v1~1items~1{itemId}/put/parameters/0",
      },
    ]);
  });

  it("rejects required Idempotency-Key on POST and PATCH at operation and path level", async () => {
    expect(
      await lintAds0003(
        {
          "/v1/orders": {
            post: op("createOrder", [keyParam("Idempotency-Key", true)]),
          },
          "/v1/orders/{orderId}": {
            parameters: [
              { name: "orderId", in: "path", required: true, schema: { type: "string" } },
              keyParam("idempotency-key", true),
            ],
            patch: op("updateOrder"),
            post: op("cancelOrder", [{ $ref: "#/components/parameters/IdempotencyKey" }]),
            trace: op("traceOrder"),
          },
          "/v1/carts": {
            parameters: [keyParam("Idempotency-Key", true)],
            post: op("createCart", [
              keyParam("Idempotency-Key", false),
              keyParam("idempotency-key", true),
            ]),
            patch: op("updateCarts", [keyParam("idempotency-key", false)]),
          },
        },
        { parameters: { IdempotencyKey: keyParam("IDEMPOTENCY-KEY", true) } },
      ),
    ).toEqual([
      {
        rule: "ads-0003-idempotency-key-optional",
        pointer: "#/paths/~1v1~1carts/parameters/0",
      },
      {
        rule: "ads-0003-idempotency-key-optional",
        pointer: "#/paths/~1v1~1carts/post/parameters/1",
      },
      {
        rule: "ads-0003-idempotency-key-optional",
        pointer: "#/paths/~1v1~1orders/post/parameters/0",
      },
      {
        rule: "ads-0003-idempotency-key-optional",
        pointer: "#/paths/~1v1~1orders~1{orderId}/parameters/1",
      },
      {
        rule: "ads-0003-idempotency-key-optional",
        pointer: "#/paths/~1v1~1orders~1{orderId}/parameters/1",
      },
      {
        rule: "ads-0003-idempotency-key-optional",
        pointer: "#/paths/~1v1~1orders~1{orderId}/post/parameters/0",
      },
    ]);
  });
  it("enforces the canonical Idempotency-Key name and schema on POST and PATCH only", async () => {
    const rules = ["ads-0003-idempotency-key-name", "ads-0003-idempotency-key-schema"];
    expect(
      await lintAds0003(
        {
          "/v1/good": {
            post: op("createGood", [{ $ref: "#/components/parameters/IdempotencyKey" }]),
          },
          "/v1/lowercase": {
            post: op("createLowercase", [
              { name: "idempotency-key", in: "header", schema: KEY_SCHEMA },
            ]),
          },
          "/v1/loose": {
            patch: op("updateLoose", [
              {
                name: "Idempotency-Key",
                in: "header",
                schema: { type: "string", pattern: "^[!-~]{8,128}$" },
              },
            ]),
          },
          "/v1/forbidden": {
            put: op("replaceForbidden", [keyParam("idempotency-key")]),
          },
        },
        {
          parameters: {
            IdempotencyKey: {
              name: "Idempotency-Key",
              in: "header",
              schema: { $ref: "#/components/schemas/IdempotencyKey" },
            },
          },
          schemas: { IdempotencyKey: KEY_SCHEMA },
        },
        rules,
      ),
    ).toEqual([
      {
        rule: "ads-0003-idempotency-key-name",
        pointer: "#/paths/~1v1~1lowercase/post/parameters/0",
      },
      {
        rule: "ads-0003-idempotency-key-schema",
        pointer: "#/paths/~1v1~1loose/patch/parameters/0",
      },
    ]);
  });

  it("rejects IdempotencyKeyRequiredProblem through $ref, oneOf, allOf, problem codes, and $ref responses", async () => {
    expect(
      await lintAds0003(
        {
          "/v1/union": {
            get: {
              ...op("getUnion"),
              responses: {
                "400": problemResponse({
                  oneOf: [
                    schemaRef("IdempotencyKeyRequiredProblem"),
                    schemaRef("ValidationFailedProblem"),
                  ],
                }),
              },
            },
          },
          "/v1/code": {
            post: {
              ...op("createCode"),
              responses: {
                "400": problemResponse({ allOf: [problemSchema("IDEMPOTENCY_KEY_REQUIRED")] }),
              },
            },
          },
          "/v1/shared": {
            post: {
              ...op("createShared"),
              responses: { "400": { $ref: "#/components/responses/KeyRequired" } },
            },
          },
          "/v1/fine": {
            post: {
              ...op("createFine"),
              responses: { "400": problemResponse(schemaRef("CreateThingBadRequestProblem")) },
            },
          },
        },
        {
          schemas: PROBLEM_SCHEMAS,
          responses: { KeyRequired: problemResponse(schemaRef("IdempotencyKeyRequiredProblem")) },
        },
        ["ads-0003-idempotency-no-required-problem"],
      ),
    ).toEqual([
      {
        rule: "ads-0003-idempotency-no-required-problem",
        pointer: "#/paths/~1v1~1code/post/responses/400",
      },
      {
        rule: "ads-0003-idempotency-no-required-problem",
        pointer: "#/paths/~1v1~1shared/post/responses/400",
      },
      {
        rule: "ads-0003-idempotency-no-required-problem",
        pointer: "#/paths/~1v1~1union/get/responses/400",
      },
    ]);
  });

  it("allows Idempotent-Replayed only on POST and PATCH operations that declare Idempotency-Key", async () => {
    const replayed = {
      "Idempotent-Replayed": { $ref: "#/components/headers/Idempotent-Replayed" },
    };
    const withReplayed = (operationId: string, parameters?: unknown[]) => ({
      ...op(operationId, parameters),
      responses: { "200": { description: "OK.", headers: replayed } },
    });
    expect(
      await lintAds0003(
        {
          "/v1/things": {
            get: withReplayed("listThings"),
            post: withReplayed("createThing", [keyParam("Idempotency-Key")]),
            patch: {
              ...op("updateThings"),
              responses: {
                "200": {
                  description: "OK.",
                  headers: { "idempotent-replayed": { schema: { type: "boolean" } } },
                },
              },
            },
          },
          "/v1/things/{thingId}": {
            parameters: [
              { name: "thingId", in: "path", required: true, schema: { type: "string" } },
            ],
            put: withReplayed("replaceThing", [keyParam("Idempotency-Key")]),
            delete: {
              ...op("deleteThing"),
              responses: { "200": { $ref: "#/components/responses/Replayed" } },
            },
          },
        },
        {
          headers: { "Idempotent-Replayed": { schema: { type: "boolean" } } },
          responses: { Replayed: { description: "OK.", headers: replayed } },
        },
        ["ads-0003-idempotent-replayed-header"],
      ),
    ).toEqual([
      {
        rule: "ads-0003-idempotent-replayed-header",
        pointer: "#/components/responses/Replayed/headers/Idempotent-Replayed",
      },
      {
        rule: "ads-0003-idempotent-replayed-header",
        pointer: "#/paths/~1v1~1things/get/responses/200/headers/Idempotent-Replayed",
      },
      {
        rule: "ads-0003-idempotent-replayed-header",
        pointer: "#/paths/~1v1~1things/patch/responses/200/headers/idempotent-replayed",
      },
      {
        rule: "ads-0003-idempotent-replayed-header",
        pointer: "#/paths/~1v1~1things~1{thingId}/put/responses/200/headers/Idempotent-Replayed",
      },
    ]);
  });

  it("requires the 400, 409 with Retry-After, 422, and 503 idempotency problems on keyed POST and PATCH", async () => {
    const retryAfter = { "Retry-After": { $ref: "#/components/headers/Retry-After" } };
    expect(
      await lintAds0003(
        {
          "/v1/complete": {
            post: {
              ...op("createComplete", [keyParam("Idempotency-Key")]),
              responses: {
                "201": { description: "Created." },
                "400": problemResponse(schemaRef("CreateThingBadRequestProblem")),
                "409": problemResponse(
                  { anyOf: [schemaRef("IdempotencyRequestInProgressProblem")] },
                  retryAfter,
                ),
                "422": { $ref: "#/components/responses/KeyReused" },
                "503": problemResponse(problemSchema("IDEMPOTENCY_UNAVAILABLE")),
              },
            },
            get: {
              ...op("listComplete", [keyParam("Idempotency-Key")]),
              responses: { "200": { description: "OK." } },
            },
          },
          "/v1/incomplete": {
            patch: {
              ...op("updateIncomplete", [keyParam("idempotency-key")]),
              responses: {
                "200": { description: "OK." },
                "400": {
                  description: "Problem.",
                  content: {
                    "application/json": { schema: schemaRef("IdempotencyKeyInvalidProblem") },
                  },
                },
                "409": problemResponse(schemaRef("IdempotencyRequestInProgressProblem")),
                "422": problemResponse(schemaRef("IdempotencyConflictProblem")),
              },
            },
          },
        },
        {
          schemas: PROBLEM_SCHEMAS,
          headers: { "Retry-After": { schema: { type: "string" } } },
          responses: { KeyReused: problemResponse(schemaRef("IdempotencyKeyReusedProblem")) },
        },
        ["ads-0003-idempotency-problems"],
      ),
    ).toEqual([
      {
        rule: "ads-0003-idempotency-problems",
        pointer: "#/paths/~1v1~1incomplete/patch/responses",
      },
      {
        rule: "ads-0003-idempotency-problems",
        pointer: "#/paths/~1v1~1incomplete/patch/responses/400",
      },
      {
        rule: "ads-0003-idempotency-problems",
        pointer: "#/paths/~1v1~1incomplete/patch/responses/409",
      },
      {
        rule: "ads-0003-idempotency-problems",
        pointer: "#/paths/~1v1~1incomplete/patch/responses/422",
      },
      {
        rule: "ads-0003-idempotency-problems",
        pointer: "#/paths/~1v1~1incomplete/patch/responses/422",
      },
    ]);
  });
});
