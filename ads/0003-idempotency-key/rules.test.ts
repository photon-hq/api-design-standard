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

async function lintAds0003(paths: Record<string, unknown>, components?: Record<string, unknown>) {
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
    .filter((problem) => problem.ruleId.startsWith("photon-ads/ads-0003-"))
    .map((problem) => ({
      rule: problem.ruleId.replace("photon-ads/", ""),
      pointer: problem.location?.[0]?.pointer,
    }))
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

  it("exposes metadata for both ADS-0003 rules", () => {
    expect(ADS_0003_METADATA.ads).toBe("0003");
    expect(ADS_0003_METADATA.rules.map((rule) => [rule.id, rule.severity])).toEqual([
      ["photon-ads/ads-0003-idempotency-key-method", "error"],
      ["photon-ads/ads-0003-idempotency-key-optional", "error"],
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
});
