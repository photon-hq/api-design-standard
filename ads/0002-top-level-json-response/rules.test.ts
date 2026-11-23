import { execFileSync, spawnSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { stringify as stringifyYaml } from "yaml";
import type { RedoclyResolveResult } from "../../src/types.js";
import {
  ADS_0002_METADATA,
  findNonObjectTopLevelKinds,
  isNonNullableStructuredObject,
  isNullableSchema,
  isStringTypedSchema,
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
  paths?: Record<string, unknown>;
  components?: Record<string, unknown>;
}): Record<string, unknown> {
  return {
    openapi: "3.1.0",
    info: {
      title: "Test API",
      version: "1.0.0",
      description: "Test specification for ADS-0002.",
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

function adsProblems(report: RedoclyJsonReport): RedoclyJsonProblem[] {
  return report.problems.filter((problem) => problem.ruleId.startsWith("photon-ads/"));
}

function ads0002Problems(report: RedoclyJsonReport): RedoclyJsonProblem[] {
  return report.problems.filter((problem) => problem.ruleId.startsWith("photon-ads/ads-0002-"));
}

function makeFakeResolver(schemas: Record<string, unknown>) {
  return <T = unknown>(node: { $ref: string }): RedoclyResolveResult<T> => {
    const match = /^#\/components\/schemas\/([^/]+)$/.exec(node.$ref);
    if (!match?.[1] || !(match[1] in schemas)) {
      return { error: new Error(`Unresolved ref: ${node.$ref}`) };
    }
    return {
      node: schemas[match[1]] as T,
    };
  };
}

beforeAll(async () => {
  tempDir = await mkdtemp(join(tmpdir(), "photon-ads-0002-"));
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

describe("ADS-0002 unit helpers", () => {
  it("exports metadata with three error-level rules", () => {
    expect(ADS_0002_METADATA.ads).toBe("0002");
    expect(ADS_0002_METADATA.slug).toBe("ads-0002");
    expect(ADS_0002_METADATA.folder).toBe("0002-top-level-json-response");
    expect(ADS_0002_METADATA.rules.map((rule) => rule.id)).toEqual([
      "photon-ads/ads-0002-top-level-json-object",
      "photon-ads/ads-0002-no-single-resource-wrapper",
      "photon-ads/ads-0002-flat-creation-secret",
    ]);
    expect(ADS_0002_METADATA.rules.every((rule) => rule.severity === "error")).toBe(true);
  });

  it("identifies nullable schemas across OpenAPI 3.0 and 3.1 idioms", () => {
    const resolveRef = makeFakeResolver({
      Sub: { type: "object", properties: { id: { type: "string" } } },
      NullableSub: { anyOf: [{ $ref: "#/components/schemas/Sub" }, { type: "null" }] },
      CycleA: { $ref: "#/components/schemas/CycleB" },
      CycleB: { $ref: "#/components/schemas/CycleA" },
    });

    expect(isNullableSchema({ type: "object", nullable: true }, resolveRef)).toBe(true);
    expect(isNullableSchema({ type: "null" }, resolveRef)).toBe(true);
    expect(isNullableSchema({ type: ["object", "null"] }, resolveRef)).toBe(true);
    expect(
      isNullableSchema(
        { nullable: true, allOf: [{ $ref: "#/components/schemas/Sub" }] },
        resolveRef,
      ),
    ).toBe(true);
    expect(isNullableSchema({ $ref: "#/components/schemas/NullableSub" }, resolveRef)).toBe(true);
    expect(isNullableSchema({ $ref: "#/components/schemas/Sub", nullable: true }, resolveRef)).toBe(
      true,
    );

    expect(isNullableSchema({ $ref: "#/components/schemas/Sub" }, resolveRef)).toBe(false);
    expect(
      isNullableSchema(
        {
          allOf: [
            { type: ["object", "null"], properties: { id: { type: "string" } } },
            { type: "object" },
          ],
        },
        resolveRef,
      ),
    ).toBe(false);
    expect(isNullableSchema({ $ref: "#/components/schemas/CycleA" }, resolveRef)).toBe(false);
  });

  it("classifies non-nullable structured objects and string types accurately", () => {
    const resolveRef = makeFakeResolver({
      Project: { type: "object", properties: { id: { type: "string" } } },
      ApiKey: { type: "object", properties: { id: { type: "string" }, name: { type: "string" } } },
      NullableProject: { anyOf: [{ $ref: "#/components/schemas/Project" }, { type: "null" }] },
      SecretString: { type: "string" },
      SelfCycle: { $ref: "#/components/schemas/SelfCycle" },
    });

    expect(
      isNonNullableStructuredObject({ $ref: "#/components/schemas/Project" }, resolveRef),
    ).toBe(true);
    expect(
      isNonNullableStructuredObject(
        {
          oneOf: [
            { $ref: "#/components/schemas/Project" },
            { $ref: "#/components/schemas/ApiKey" },
          ],
        },
        resolveRef,
      ),
    ).toBe(true);
    expect(
      isNonNullableStructuredObject(
        {
          allOf: [
            { type: ["object", "null"], properties: { id: { type: "string" } } },
            { type: "object" },
          ],
        },
        resolveRef,
      ),
    ).toBe(true);

    expect(
      isNonNullableStructuredObject({ $ref: "#/components/schemas/NullableProject" }, resolveRef),
    ).toBe(false);
    expect(
      isNonNullableStructuredObject(
        { type: "object", additionalProperties: { type: "string" } },
        resolveRef,
      ),
    ).toBe(false);
    expect(isNonNullableStructuredObject({ type: "object" }, resolveRef)).toBe(false);
    expect(
      isNonNullableStructuredObject(
        { type: "array", items: { $ref: "#/components/schemas/Project" } },
        resolveRef,
      ),
    ).toBe(false);
    expect(
      isNonNullableStructuredObject(
        { oneOf: [{ $ref: "#/components/schemas/Project" }, { type: "string" }] },
        resolveRef,
      ),
    ).toBe(false);
    expect(
      isNonNullableStructuredObject({ $ref: "#/components/schemas/SelfCycle" }, resolveRef),
    ).toBe(false);

    expect(isStringTypedSchema({ type: "string" }, resolveRef)).toBe(true);
    expect(isStringTypedSchema({ type: ["string", "null"] }, resolveRef)).toBe(true);
    expect(isStringTypedSchema({ anyOf: [{ type: "string" }, { type: "null" }] }, resolveRef)).toBe(
      true,
    );
    expect(isStringTypedSchema({ enum: ["tok_a", "tok_b"] }, resolveRef)).toBe(true);
    expect(isStringTypedSchema({ $ref: "#/components/schemas/SecretString" }, resolveRef)).toBe(
      true,
    );
    expect(isStringTypedSchema({ type: "integer" }, resolveRef)).toBe(false);
    expect(isStringTypedSchema({ type: "array", items: { type: "string" } }, resolveRef)).toBe(
      false,
    );
    expect(isStringTypedSchema({ $ref: "#/components/schemas/Project" }, resolveRef)).toBe(false);
  });

  it("finds non-object top-level schema types including unions, nullable refs, and deep diamond DAGs", () => {
    const schemas: Record<string, unknown> = {
      Project: { type: "object", properties: { id: { type: "string" } } },
      ProjectList: { type: "array", items: { $ref: "#/components/schemas/Project" } },
      Level0: { type: "object", properties: { id: { type: "string" } } },
    };
    for (let i = 1; i <= 24; i += 1) {
      schemas[`Level${i}`] = {
        allOf: [
          { $ref: `#/components/schemas/Level${i - 1}` },
          { $ref: `#/components/schemas/Level${i - 1}` },
        ],
      };
    }
    const resolveRef = makeFakeResolver(schemas);

    expect(
      findNonObjectTopLevelKinds({ $ref: "#/components/schemas/Project" }, resolveRef),
    ).toEqual([]);
    expect(
      findNonObjectTopLevelKinds({ $ref: "#/components/schemas/Level24" }, resolveRef),
    ).toEqual([]);
    expect(
      findNonObjectTopLevelKinds({ $ref: "#/components/schemas/ProjectList" }, resolveRef),
    ).toEqual(["array"]);
    expect(
      findNonObjectTopLevelKinds(
        { oneOf: [{ $ref: "#/components/schemas/Project" }, { type: "null" }] },
        resolveRef,
      ),
    ).toEqual(["null"]);
    expect(
      findNonObjectTopLevelKinds(
        { nullable: true, allOf: [{ $ref: "#/components/schemas/Project" }] },
        resolveRef,
      ),
    ).toEqual(["null"]);
    expect(findNonObjectTopLevelKinds({ items: { type: "string" } }, resolveRef)).toEqual([
      "array",
    ]);
  });
});

describe("ADS-0002 Redocly CLI end-to-end linting", () => {
  it("passes the repository valid OpenAPI fixture with zero errors", () => {
    const { exitCode, report } = runRedoclyLint(VALID_FIXTURE);
    expect(exitCode).toBe(0);
    expect(adsProblems(report)).toEqual([]);
  });

  it("allows valid flat resources, flat creation secrets, collections, maps, utilities, composites, nullable sub-objects, 204, and non-JSON responses", async () => {
    const doc = baseOpenApi({
      paths: {
        "/v1/projects/{projectId}/api-keys": {
          parameters: [
            {
              name: "projectId",
              in: "path",
              required: true,
              schema: { type: "string" },
            },
          ],
          get: {
            operationId: "listApiKeys",
            summary: "List API keys",
            responses: {
              "200": {
                description: "Collection wrapper object",
                content: {
                  "application/json": {
                    schema: {
                      type: "object",
                      properties: {
                        items: {
                          type: "array",
                          items: { $ref: "#/components/schemas/ApiKey" },
                        },
                        nextCursor: { type: ["string", "null"] },
                      },
                    },
                  },
                },
              },
            },
          },
          post: {
            operationId: "createApiKey",
            summary: "Create an API key",
            responses: {
              "201": {
                description: "Flat resource with sibling secret",
                content: {
                  "application/json": {
                    schema: {
                      allOf: [
                        { $ref: "#/components/schemas/ApiKey" },
                        {
                          type: "object",
                          required: ["secret"],
                          properties: {
                            secret: { type: "string" },
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
        "/v1/projects/{projectId}/records": {
          parameters: [
            {
              name: "projectId",
              in: "path",
              required: true,
              schema: { type: "string" },
            },
          ],
          get: {
            operationId: "listDataArray",
            summary: "List records under data array",
            responses: {
              "200": {
                description: "Collection using data array",
                content: {
                  "application/json": {
                    schema: {
                      type: "object",
                      properties: {
                        data: {
                          type: "array",
                          items: { $ref: "#/components/schemas/ApiKey" },
                        },
                        hasMore: { type: "boolean" },
                      },
                    },
                  },
                },
              },
            },
          },
        },
        "/v1/projects/{projectId}/labels": {
          parameters: [
            {
              name: "projectId",
              in: "path",
              required: true,
              schema: { type: "string" },
            },
          ],
          get: {
            operationId: "getLabels",
            summary: "Get open key-value map",
            responses: {
              "200": {
                description: "Dictionary response",
                content: {
                  "application/json": {
                    schema: {
                      type: "object",
                      additionalProperties: { type: "string" },
                    },
                  },
                },
              },
            },
          },
        },
        "/v1/projects/{projectId}/open-map-with-default": {
          parameters: [
            {
              name: "projectId",
              in: "path",
              required: true,
              schema: { type: "string" },
            },
          ],
          get: {
            operationId: "getOpenMapWithDefault",
            summary: "Get open map with one named property",
            responses: {
              "200": {
                description: "Open map",
                content: {
                  "application/json": {
                    schema: {
                      type: "object",
                      properties: {
                        default: { $ref: "#/components/schemas/ApiKey" },
                      },
                      additionalProperties: { $ref: "#/components/schemas/ApiKey" },
                    },
                  },
                },
              },
            },
          },
        },
        "/v1/projects/{projectId}/count": {
          parameters: [
            {
              name: "projectId",
              in: "path",
              required: true,
              schema: { type: "string" },
            },
          ],
          get: {
            operationId: "getCount",
            summary: "Get scalar count",
            responses: {
              "200": {
                description: "Scalar count object",
                content: {
                  "application/json": {
                    schema: {
                      type: "object",
                      properties: {
                        count: { type: "integer" },
                      },
                    },
                  },
                },
              },
            },
          },
        },
        "/v1/projects/{projectId}/subscription": {
          parameters: [
            {
              name: "projectId",
              in: "path",
              required: true,
              schema: { type: "string" },
            },
          ],
          get: {
            operationId: "getSubscription",
            summary: "Get nullable sub-object",
            responses: {
              "200": {
                description: "Single nullable property",
                content: {
                  "application/json": {
                    schema: {
                      type: "object",
                      properties: {
                        subscription: {
                          anyOf: [{ $ref: "#/components/schemas/Subscription" }, { type: "null" }],
                        },
                      },
                    },
                  },
                },
              },
            },
          },
        },
        "/v1/projects/{projectId}/subscription-with-meta": {
          parameters: [
            {
              name: "projectId",
              in: "path",
              required: true,
              schema: { type: "string" },
            },
          ],
          get: {
            operationId: "getSubscriptionWithMeta",
            summary: "Get nullable sub-object with metadata",
            responses: {
              "200": {
                description: "Nullable sub-object paired with sibling metadata",
                content: {
                  "application/json": {
                    schema: {
                      type: "object",
                      properties: {
                        subscription: {
                          nullable: true,
                          allOf: [{ $ref: "#/components/schemas/Subscription" }],
                        },
                        timeZone: { type: "string" },
                      },
                    },
                  },
                },
              },
            },
          },
        },
        "/v1/projects/{projectId}/exports": {
          parameters: [
            {
              name: "projectId",
              in: "path",
              required: true,
              schema: { type: "string" },
            },
          ],
          post: {
            operationId: "createExport",
            summary: "Create export returning composite entities",
            responses: {
              "202": {
                description: "Composite response",
                content: {
                  "application/json": {
                    schema: {
                      type: "object",
                      properties: {
                        operation: { $ref: "#/components/schemas/Operation" },
                        resource: { $ref: "#/components/schemas/ApiKey" },
                      },
                    },
                  },
                },
              },
            },
          },
        },
        "/v1/projects/{projectId}/download": {
          parameters: [
            {
              name: "projectId",
              in: "path",
              required: true,
              schema: { type: "string" },
            },
          ],
          get: {
            operationId: "downloadBinary",
            summary: "Download binary file",
            responses: {
              "200": {
                description: "Binary stream",
                content: {
                  "application/octet-stream": {
                    schema: { type: "string", format: "binary" },
                  },
                  "text/plain": {
                    schema: { type: "string" },
                  },
                },
              },
            },
          },
          delete: {
            operationId: "deleteDownload",
            summary: "Delete export artifact",
            responses: {
              "204": {
                description: "No content",
              },
              "404": {
                description: "Not found",
                content: {
                  "application/problem+json": {
                    schema: {
                      type: "object",
                      properties: {
                        type: { type: "string" },
                        title: { type: "string" },
                        status: { type: "integer" },
                      },
                    },
                  },
                },
              },
            },
          },
        },
        "/v1/projects/{projectId}/tree": {
          parameters: [
            {
              name: "projectId",
              in: "path",
              required: true,
              schema: { type: "string" },
            },
          ],
          get: {
            operationId: "getTree",
            summary: "Get recursive tree node",
            responses: {
              "200": {
                description: "Recursive tree node",
                content: {
                  "application/json": {
                    schema: { $ref: "#/components/schemas/TreeNode" },
                  },
                },
              },
            },
          },
        },
      },
      components: {
        schemas: {
          ApiKey: {
            type: "object",
            properties: {
              id: { type: "string" },
              projectId: { type: "string" },
              name: { type: "string" },
            },
          },
          Subscription: {
            type: "object",
            properties: {
              id: { type: "string" },
              plan: { type: "string" },
            },
          },
          Operation: {
            type: "object",
            properties: {
              id: { type: "string" },
              status: { type: "string" },
            },
          },
          TreeNode: {
            type: "object",
            properties: {
              id: { type: "string" },
              parent: {
                anyOf: [{ $ref: "#/components/schemas/TreeNode" }, { type: "null" }],
              },
            },
          },
        },
      },
    });

    const { report } = await lintOpenApi(doc);
    expect(adsProblems(report)).toEqual([]);
  });

  it("enforces ads-0002-top-level-json-object across arrays, primitives, null, unions, and +json media types", async () => {
    const doc = baseOpenApi({
      paths: {
        "/v1/bare-array": {
          get: {
            operationId: "getBareArray",
            summary: "Returns bare array",
            responses: {
              "200": {
                description: "Array",
                content: {
                  "application/json": {
                    schema: {
                      type: "array",
                      items: { type: "object", properties: { id: { type: "string" } } },
                    },
                  },
                },
              },
            },
          },
        },
        "/v1/implicit-array": {
          get: {
            operationId: "getImplicitArray",
            summary: "Returns implicit array via items",
            responses: {
              "200": {
                description: "Implicit array",
                content: {
                  "application/json": {
                    schema: {
                      items: { type: "string" },
                    },
                  },
                },
              },
            },
          },
        },
        "/v1/bare-string": {
          get: {
            operationId: "getBareString",
            summary: "Returns bare string",
            responses: {
              "200": {
                description: "String",
                content: {
                  "application/json": {
                    schema: { type: "string" },
                  },
                },
              },
            },
          },
        },
        "/v1/bare-boolean": {
          get: {
            operationId: "getBareBoolean",
            summary: "Returns bare boolean",
            responses: {
              "200": {
                description: "Boolean",
                content: {
                  "application/vnd.photon+json": {
                    schema: { type: "boolean" },
                  },
                },
              },
            },
          },
        },
        "/v1/bare-number": {
          get: {
            operationId: "getBareNumber",
            summary: "Returns bare integer",
            responses: {
              "200": {
                description: "Integer",
                content: {
                  "application/json": {
                    schema: { type: "integer" },
                  },
                },
              },
            },
          },
        },
        "/v1/nullable-root": {
          get: {
            operationId: "getNullableRoot",
            summary: "Returns nullable root",
            responses: {
              "200": {
                description: "Nullable root object",
                content: {
                  "application/json": {
                    schema: {
                      type: ["object", "null"],
                      properties: { id: { type: "string" } },
                    },
                  },
                },
              },
            },
          },
        },
        "/v1/union-with-array": {
          get: {
            operationId: "getUnionWithArray",
            summary: "Returns union with array branch",
            responses: {
              "2XX": {
                description: "Union",
                content: {
                  "application/json": {
                    schema: {
                      oneOf: [
                        { type: "object", properties: { id: { type: "string" } } },
                        { $ref: "#/components/schemas/ArrayAlias" },
                      ],
                    },
                  },
                },
              },
            },
          },
        },
      },
      components: {
        schemas: {
          ArrayAlias: {
            type: "array",
            items: { type: "string" },
          },
        },
      },
    });

    const { exitCode, report } = await lintOpenApi(doc);
    expect(exitCode).toBe(1);
    const rule1Errors = ads0002Problems(report).filter(
      (problem) => problem.ruleId === "photon-ads/ads-0002-top-level-json-object",
    );
    expect(rule1Errors).toHaveLength(7);
    const messages = rule1Errors.map((problem) => problem.message);
    expect(messages.some((msg) => msg.includes("/v1/bare-array") && msg.includes('"array"'))).toBe(
      true,
    );
    expect(
      messages.some((msg) => msg.includes("/v1/implicit-array") && msg.includes('"array"')),
    ).toBe(true);
    expect(
      messages.some((msg) => msg.includes("/v1/bare-string") && msg.includes('"string"')),
    ).toBe(true);
    expect(
      messages.some((msg) => msg.includes("/v1/bare-boolean") && msg.includes('"boolean"')),
    ).toBe(true);
    expect(
      messages.some((msg) => msg.includes("/v1/bare-number") && msg.includes('"integer"')),
    ).toBe(true);
    expect(
      messages.some((msg) => msg.includes("/v1/nullable-root") && msg.includes('"null"')),
    ).toBe(true);
    expect(
      messages.some((msg) => msg.includes("/v1/union-with-array") && msg.includes('"array"')),
    ).toBe(true);
  });

  it("enforces ads-0002-no-single-resource-wrapper for resource envelopes and generic data/result/payload keys without double-reporting", async () => {
    const doc = baseOpenApi({
      paths: {
        "/v1/projects/{projectId}": {
          parameters: [
            { name: "projectId", in: "path", required: true, schema: { type: "string" } },
          ],
          get: {
            operationId: "getWrappedProject",
            summary: "Returns single-key resource envelope",
            responses: {
              "200": {
                description: "Wrapped project",
                content: {
                  "application/json": {
                    schema: {
                      type: "object",
                      additionalProperties: false,
                      properties: {
                        project: { $ref: "#/components/schemas/Project" },
                      },
                    },
                  },
                },
              },
            },
          },
          patch: {
            operationId: "patchDataEnvelope",
            summary: "Returns generic data envelope alone",
            responses: {
              "200": {
                description: "Data envelope",
                content: {
                  "application/json": {
                    schema: {
                      type: "object",
                      properties: {
                        data: { $ref: "#/components/schemas/Project" },
                      },
                    },
                  },
                },
              },
            },
          },
        },
        "/v1/organizations/{organizationId}": {
          parameters: [
            { name: "organizationId", in: "path", required: true, schema: { type: "string" } },
          ],
          get: {
            operationId: "getDataWithMeta",
            summary: "Returns generic data envelope paired with meta",
            responses: {
              "200": {
                description: "Data plus meta",
                content: {
                  "application/json": {
                    schema: {
                      type: "object",
                      properties: {
                        data: { $ref: "#/components/schemas/Project" },
                        meta: {
                          type: "object",
                          properties: { requestId: { type: "string" } },
                        },
                      },
                    },
                  },
                },
              },
            },
          },
          put: {
            operationId: "putResultEnvelope",
            summary: "Returns generic result envelope",
            responses: {
              "200": {
                description: "Result plus ok flag",
                content: {
                  "application/json": {
                    schema: {
                      type: "object",
                      properties: {
                        result: {
                          oneOf: [
                            { $ref: "#/components/schemas/Project" },
                            { $ref: "#/components/schemas/ApiKey" },
                          ],
                        },
                        ok: { type: "boolean" },
                      },
                    },
                  },
                },
              },
            },
          },
          delete: {
            operationId: "deletePayloadEnvelope",
            summary: "Returns generic payload envelope",
            responses: {
              "200": {
                description: "Payload envelope",
                content: {
                  "application/json": {
                    schema: {
                      allOf: [
                        {
                          type: "object",
                          properties: {
                            payload: { $ref: "#/components/schemas/Project" },
                          },
                        },
                        {
                          type: "object",
                          properties: {
                            deleted: { type: "boolean" },
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
      },
      components: {
        schemas: {
          Project: {
            type: "object",
            properties: {
              id: { type: "string" },
              name: { type: "string" },
            },
          },
          ApiKey: {
            type: "object",
            properties: {
              id: { type: "string" },
              projectId: { type: "string" },
            },
          },
        },
      },
    });

    const { exitCode, report } = await lintOpenApi(doc);
    expect(exitCode).toBe(1);
    const rule2Errors = ads0002Problems(report).filter(
      (problem) => problem.ruleId === "photon-ads/ads-0002-no-single-resource-wrapper",
    );
    expect(rule2Errors).toHaveLength(5);
    const messages = rule2Errors.map((problem) => problem.message);
    expect(
      messages.some(
        (msg) => msg.includes('GET "/v1/projects/{projectId}"') && msg.includes('"project"'),
      ),
    ).toBe(true);
    expect(messages.filter((msg) => msg.includes('PATCH "/v1/projects/{projectId}"'))).toHaveLength(
      1,
    );
    expect(
      messages.some(
        (msg) => msg.includes('GET "/v1/organizations/{organizationId}"') && msg.includes('"data"'),
      ),
    ).toBe(true);
    expect(
      messages.some(
        (msg) =>
          msg.includes('PUT "/v1/organizations/{organizationId}"') && msg.includes('"result"'),
      ),
    ).toBe(true);
    expect(
      messages.some(
        (msg) =>
          msg.includes('DELETE "/v1/organizations/{organizationId}"') && msg.includes('"payload"'),
      ),
    ).toBe(true);
  });

  it("enforces ads-0002-flat-creation-secret on POST 2xx two-key resource-and-secret wrappers only", async () => {
    const doc = baseOpenApi({
      paths: {
        "/v1/projects/{projectId}/api-keys": {
          parameters: [
            { name: "projectId", in: "path", required: true, schema: { type: "string" } },
          ],
          post: {
            operationId: "createWrappedApiKey",
            summary: "Returns split apiKey and secret wrapper",
            responses: {
              "201": {
                description: "Wrapped creation response",
                content: {
                  "application/json": {
                    schema: {
                      type: "object",
                      additionalProperties: false,
                      properties: {
                        apiKey: { $ref: "#/components/schemas/ApiKey" },
                        secret: { type: "string" },
                      },
                    },
                  },
                },
              },
            },
          },
          get: {
            operationId: "getNotPost",
            summary: "GET with two keys should not trigger POST-only rule",
            responses: {
              "200": {
                description: "Non-POST response",
                content: {
                  "application/json": {
                    schema: {
                      type: "object",
                      properties: {
                        apiKey: { $ref: "#/components/schemas/ApiKey" },
                        secret: { type: "string" },
                      },
                    },
                  },
                },
              },
            },
          },
        },
        "/v1/projects/{projectId}/destinations": {
          parameters: [
            { name: "projectId", in: "path", required: true, schema: { type: "string" } },
          ],
          post: {
            operationId: "createWrappedDestination",
            summary: "Returns split destination and signingSecret via allOf",
            responses: {
              "200": {
                description: "Wrapped destination creation response",
                content: {
                  "application/json": {
                    schema: {
                      allOf: [
                        {
                          type: "object",
                          properties: {
                            destination: { $ref: "#/components/schemas/Destination" },
                          },
                        },
                        {
                          type: "object",
                          properties: {
                            signingSecret: { anyOf: [{ type: "string" }, { type: "null" }] },
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
        "/v1/projects/{projectId}/tokens": {
          parameters: [
            { name: "projectId", in: "path", required: true, schema: { type: "string" } },
          ],
          post: {
            operationId: "createSessionToken",
            summary: "Returns split session and accessToken inside oneOf branch",
            responses: {
              "201": {
                description: "Union with wrapped creation branch",
                content: {
                  "application/json": {
                    schema: {
                      oneOf: [
                        {
                          type: "object",
                          properties: {
                            session: { $ref: "#/components/schemas/Destination" },
                            accessToken: { type: ["string", "null"] },
                          },
                        },
                        { $ref: "#/components/schemas/Destination" },
                      ],
                    },
                  },
                },
              },
            },
          },
        },
        "/v1/projects/{projectId}/non-secret-pair": {
          parameters: [
            { name: "projectId", in: "path", required: true, schema: { type: "string" } },
          ],
          post: {
            operationId: "createNonSecretPair",
            summary: "Returns resource plus non-secret string field",
            responses: {
              "201": {
                description: "Allowed two-key non-secret pair",
                content: {
                  "application/json": {
                    schema: {
                      type: "object",
                      properties: {
                        destination: { $ref: "#/components/schemas/Destination" },
                        statusMessage: { type: "string" },
                      },
                    },
                  },
                },
              },
            },
          },
        },
      },
      components: {
        schemas: {
          ApiKey: {
            type: "object",
            properties: {
              id: { type: "string" },
              name: { type: "string" },
            },
          },
          Destination: {
            type: "object",
            properties: {
              id: { type: "string" },
              url: { type: "string" },
            },
          },
        },
      },
    });

    const { exitCode, report } = await lintOpenApi(doc);
    expect(exitCode).toBe(1);
    const rule3Errors = ads0002Problems(report).filter(
      (problem) => problem.ruleId === "photon-ads/ads-0002-flat-creation-secret",
    );
    expect(rule3Errors).toHaveLength(3);
    const messages = rule3Errors.map((problem) => problem.message);
    expect(
      messages.some(
        (msg) =>
          msg.includes("/v1/projects/{projectId}/api-keys") &&
          msg.includes('"apiKey"') &&
          msg.includes('"secret"'),
      ),
    ).toBe(true);
    expect(
      messages.some(
        (msg) =>
          msg.includes("/v1/projects/{projectId}/destinations") &&
          msg.includes('"destination"') &&
          msg.includes('"signingSecret"'),
      ),
    ).toBe(true);
    expect(
      messages.some(
        (msg) =>
          msg.includes("/v1/projects/{projectId}/tokens") &&
          msg.includes('"session"') &&
          msg.includes('"accessToken"'),
      ),
    ).toBe(true);
  });

  it("preserves exact property lattice states across allOf + oneOf refinement merges", async () => {
    const doc = baseOpenApi({
      paths: {
        "/v1/refined-envelope": {
          get: {
            operationId: "getRefinedEnvelope",
            summary: "Refines a oneOf object branch into a structured data envelope via allOf",
            responses: {
              "200": {
                description: "Refined data envelope",
                content: {
                  "application/json": {
                    schema: {
                      allOf: [
                        {
                          oneOf: [
                            { type: "object", properties: { data: { type: "integer" } } },
                            { type: "object", properties: { data: { type: "object" } } },
                          ],
                        },
                        {
                          type: "object",
                          properties: {
                            data: {
                              properties: { id: { type: "string" } },
                            },
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
      },
    });

    const { exitCode, report } = await lintOpenApi(doc);
    expect(exitCode).toBe(1);
    const rule2Errors = ads0002Problems(report).filter(
      (problem) => problem.ruleId === "photon-ads/ads-0002-no-single-resource-wrapper",
    );
    expect(rule2Errors).toHaveLength(1);
    expect(rule2Errors[0]?.message).toContain('"data"');
  });

  it("handles 20-mixin allOf/oneOf schemas without exponential blowup", async () => {
    const mixins = Array.from({ length: 20 }, (_, i) => ({
      oneOf: [
        { type: "object", properties: { [`a${i}`]: { type: "string" } } },
        { type: "object", properties: { [`b${i}`]: { type: "string" } } },
      ],
    }));

    const doc = baseOpenApi({
      paths: {
        "/v1/complex": {
          post: {
            operationId: "createComplex",
            summary: "Returns deeply composed object",
            responses: {
              "200": {
                description: "Complex object",
                content: {
                  "application/json": {
                    schema: { allOf: mixins },
                  },
                },
              },
            },
          },
        },
      },
    });

    const { exitCode, report } = await lintOpenApi(doc);
    expect(exitCode).toBe(0);
    expect(adsProblems(report)).toEqual([]);
  });
});

describe("Declarative rule-level ignore options across ADS-0001 and ADS-0002", () => {
  it("supports path and optional method ignores across all ADS-0002 rules", async () => {
    const configPath = await writeRedoclyConfig({
      "photon-ads/ads-0002-top-level-json-object": {
        severity: "error",
        ignore: [
          {
            path: "/v1/legacy/list/",
            method: "GET",
            reason: "Legacy bare-array endpoint",
          },
        ],
      },
      "photon-ads/ads-0002-no-single-resource-wrapper": {
        severity: "error",
        ignore: [
          {
            path: "/v1/legacy/items/{itemId}",
            method: "get",
            reason: "Legacy GET envelope only",
          },
          {
            path: "/v1/legacy/all-methods/{itemId}",
            reason: "Waive all methods on this path",
          },
        ],
      },
      "photon-ads/ads-0002-flat-creation-secret": {
        severity: "error",
        ignore: [
          {
            path: "/v1/legacy/keys/",
            method: "POST",
            reason: "Legacy split creation wrapper",
          },
        ],
      },
    });

    const doc = baseOpenApi({
      paths: {
        "/v1/legacy/list": {
          get: {
            operationId: "legacyList",
            summary: "Ignored bare array",
            responses: {
              "200": {
                description: "Array",
                content: {
                  "application/json": {
                    schema: { type: "array", items: { type: "string" } },
                  },
                },
              },
            },
          },
        },
        "/v1/active/list": {
          get: {
            operationId: "activeList",
            summary: "Non-ignored bare array",
            responses: {
              "200": {
                description: "Array",
                content: {
                  "application/json": {
                    schema: { type: "array", items: { type: "string" } },
                  },
                },
              },
            },
          },
        },
        "/v1/legacy/items/{itemId}": {
          parameters: [{ name: "itemId", in: "path", required: true, schema: { type: "string" } }],
          get: {
            operationId: "legacyGetItem",
            summary: "Ignored GET wrapper",
            responses: {
              "200": {
                description: "Wrapped",
                content: {
                  "application/json": {
                    schema: {
                      type: "object",
                      properties: { item: { $ref: "#/components/schemas/Item" } },
                    },
                  },
                },
              },
            },
          },
          patch: {
            operationId: "legacyPatchItem",
            summary: "Non-ignored PATCH wrapper on same path",
            responses: {
              "200": {
                description: "Wrapped",
                content: {
                  "application/json": {
                    schema: {
                      type: "object",
                      properties: { item: { $ref: "#/components/schemas/Item" } },
                    },
                  },
                },
              },
            },
          },
        },
        "/v1/legacy/all-methods/{itemId}": {
          parameters: [{ name: "itemId", in: "path", required: true, schema: { type: "string" } }],
          get: {
            operationId: "allMethodsGet",
            summary: "Ignored GET wrapper via method-less ignore",
            responses: {
              "200": {
                description: "Wrapped",
                content: {
                  "application/json": {
                    schema: {
                      type: "object",
                      properties: { item: { $ref: "#/components/schemas/Item" } },
                    },
                  },
                },
              },
            },
          },
          patch: {
            operationId: "allMethodsPatch",
            summary: "Ignored PATCH wrapper via method-less ignore",
            responses: {
              "200": {
                description: "Wrapped",
                content: {
                  "application/json": {
                    schema: {
                      type: "object",
                      properties: { item: { $ref: "#/components/schemas/Item" } },
                    },
                  },
                },
              },
            },
          },
        },
        "/v1/legacy/keys": {
          post: {
            operationId: "legacyCreateKey",
            summary: "Ignored split secret wrapper",
            responses: {
              "201": {
                description: "Wrapped secret",
                content: {
                  "application/json": {
                    schema: {
                      type: "object",
                      properties: {
                        apiKey: { $ref: "#/components/schemas/Item" },
                        secret: { type: "string" },
                      },
                    },
                  },
                },
              },
            },
          },
        },
        "/v1/active/keys": {
          post: {
            operationId: "activeCreateKey",
            summary: "Non-ignored split secret wrapper",
            responses: {
              "201": {
                description: "Wrapped secret",
                content: {
                  "application/json": {
                    schema: {
                      type: "object",
                      properties: {
                        apiKey: { $ref: "#/components/schemas/Item" },
                        secret: { type: "string" },
                      },
                    },
                  },
                },
              },
            },
          },
        },
      },
      components: {
        schemas: {
          Item: {
            type: "object",
            properties: {
              id: { type: "string" },
              name: { type: "string" },
            },
          },
        },
      },
    });

    const { exitCode, report } = await lintOpenApi(doc, configPath);
    expect(exitCode).toBe(1);
    const errors = ads0002Problems(report);
    expect(errors).toHaveLength(3);
    expect(
      errors.some(
        (problem) =>
          problem.ruleId === "photon-ads/ads-0002-top-level-json-object" &&
          problem.message.includes("/v1/active/list"),
      ),
    ).toBe(true);
    expect(
      errors.some(
        (problem) =>
          problem.ruleId === "photon-ads/ads-0002-no-single-resource-wrapper" &&
          problem.message.includes('PATCH "/v1/legacy/items/{itemId}"'),
      ),
    ).toBe(true);
    expect(
      errors.some(
        (problem) =>
          problem.ruleId === "photon-ads/ads-0002-flat-creation-secret" &&
          problem.message.includes("/v1/active/keys"),
      ),
    ).toBe(true);
  });

  it("supports schema, path, and method ignores across all ADS-0001 rules", async () => {
    const configPath = await writeRedoclyConfig({
      "photon-ads/ads-0001-resource-primary-id": {
        severity: "error",
        ignore: [
          { schema: "LegacyProject", reason: "Existing component schema" },
          {
            path: "/v1/legacy/keys/{apiKeyId}",
            method: "get",
            reason: "Existing inline GET response",
          },
        ],
      },
      "photon-ads/ads-0001-path-param-naming": {
        severity: "error",
        ignore: [
          { path: "/v1/legacy/items/{id}", reason: "Waive entire path and path-level params" },
          {
            path: "/v1/legacy/single/{id}",
            method: "get",
            reason: "Waive single-method route",
          },
          {
            path: "/v1/legacy/mixed/{id}",
            method: "get",
            reason: "Waive GET only; POST must still fail",
          },
        ],
      },
      "photon-ads/ads-0001-path-param-consistency": {
        severity: "error",
        ignore: [
          { path: "/v1/projects/{id}", reason: "Exclude legacy route from consistency check" },
        ],
      },
      "photon-ads/ads-0002-no-single-resource-wrapper": "off",
    });

    const doc = baseOpenApi({
      paths: {
        "/v1/legacy/projects/{legacyProjectId}": {
          parameters: [
            { name: "legacyProjectId", in: "path", required: true, schema: { type: "string" } },
          ],
          get: {
            operationId: "getLegacyProject",
            summary: "References ignored LegacyProject schema",
            responses: {
              "200": {
                description: "Legacy project",
                content: {
                  "application/json": {
                    schema: { $ref: "#/components/schemas/LegacyProject" },
                  },
                },
              },
            },
          },
        },
        "/v1/legacy/keys/{apiKeyId}": {
          parameters: [
            { name: "apiKeyId", in: "path", required: true, schema: { type: "string" } },
          ],
          get: {
            operationId: "getLegacyInlineKey",
            summary: "Ignored inline response with apiKeyId and snake_case",
            responses: {
              "200": {
                description: "Inline key",
                content: {
                  "application/json": {
                    schema: {
                      type: "object",
                      properties: {
                        apiKeyId: { type: "string" },
                        project_id: { type: "string" },
                      },
                    },
                  },
                },
              },
            },
          },
          post: {
            operationId: "postUnignoredInlineKey",
            summary: "Non-ignored POST inline bad casing on same path",
            responses: {
              "200": {
                description: "Inline post",
                content: {
                  "application/json": {
                    schema: {
                      type: "object",
                      properties: {
                        id: { type: "string" },
                        owner_id: { type: "string" },
                      },
                    },
                  },
                },
              },
            },
          },
        },
        "/v1/legacy/items/{id}": {
          parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
          get: {
            operationId: "getLegacyItem",
            summary: "Ignored path",
            responses: { "204": { description: "No content" } },
          },
        },
        "/v1/legacy/single/{id}": {
          parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
          get: {
            operationId: "getLegacySingle",
            summary: "Ignored single-method path",
            responses: { "204": { description: "No content" } },
          },
        },
        "/v1/legacy/mixed/{id}": {
          get: {
            operationId: "getLegacyMixed",
            summary: "Ignored GET param",
            parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
            responses: { "204": { description: "No content" } },
          },
          post: {
            operationId: "postLegacyMixed",
            summary: "Non-ignored POST param",
            parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
            responses: { "204": { description: "No content" } },
          },
        },
        "/v1/projects/{id}": {
          parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
          get: {
            operationId: "getLegacyProjectRoute",
            summary: "Ignored for consistency",
            responses: { "204": { description: "No content" } },
          },
        },
        "/v1/projects/{projectId}/api-keys": {
          parameters: [
            { name: "projectId", in: "path", required: true, schema: { type: "string" } },
          ],
          get: {
            operationId: "listProjectApiKeys",
            summary: "Canonical projectId route",
            responses: { "204": { description: "No content" } },
          },
        },
      },
      components: {
        schemas: {
          LegacyProject: {
            type: "object",
            properties: {
              legacyProjectId: { type: "string" },
              org_id: { type: "string" },
            },
          },
          ActiveProject: {
            type: "object",
            properties: {
              activeProjectId: { type: "string" },
            },
          },
        },
      },
    });

    const { exitCode, report } = await lintOpenApi(doc, configPath);
    expect(exitCode).toBe(1);
    const problems = adsProblems(report);

    const primaryIdProblems = problems.filter(
      (problem) => problem.ruleId === "photon-ads/ads-0001-resource-primary-id",
    );
    expect(primaryIdProblems).toHaveLength(2);
    expect(primaryIdProblems.some((p) => p.message.includes('"ActiveProject"'))).toBe(true);
    expect(primaryIdProblems.some((p) => p.message.includes('"owner_id"'))).toBe(true);
    expect(primaryIdProblems.some((p) => p.message.includes("LegacyProject"))).toBe(false);
    expect(primaryIdProblems.some((p) => p.message.includes("project_id"))).toBe(false);

    const namingProblems = problems.filter(
      (problem) => problem.ruleId === "photon-ads/ads-0001-path-param-naming",
    );
    expect(
      namingProblems.some((p) =>
        p.location?.some((loc) => loc.pointer?.includes("~1v1~1legacy~1items~1{id}")),
      ),
    ).toBe(false);
    expect(
      namingProblems.some((p) =>
        p.location?.some((loc) => loc.pointer?.includes("~1v1~1legacy~1single~1{id}")),
      ),
    ).toBe(false);
    expect(
      namingProblems.some((p) =>
        p.location?.some((loc) => loc.pointer?.includes("~1v1~1legacy~1mixed~1{id}/get/")),
      ),
    ).toBe(false);
    expect(
      namingProblems.some((p) =>
        p.location?.some((loc) => loc.pointer?.includes("~1v1~1legacy~1mixed~1{id}/post/")),
      ),
    ).toBe(true);

    const consistencyProblems = problems.filter(
      (problem) => problem.ruleId === "photon-ads/ads-0001-path-param-consistency",
    );
    expect(consistencyProblems).toEqual([]);
  });

  it("never crashes Redocly when ignore config is malformed or empty", async () => {
    const configPath = await writeRedoclyConfig({
      "photon-ads/ads-0002-top-level-json-object": {
        severity: "error",
        ignore: "invalid-non-array",
      },
      "photon-ads/ads-0002-no-single-resource-wrapper": {
        severity: "error",
        ignore: [null, {}, { reason: "empty" }, { path: "/v1/wrapped", method: 123 }],
      },
    });

    const doc = baseOpenApi({
      paths: {
        "/v1/list": {
          get: {
            operationId: "listItems",
            summary: "Bare array still fails",
            responses: {
              "200": {
                description: "Array",
                content: {
                  "application/json": {
                    schema: { type: "array", items: { type: "string" } },
                  },
                },
              },
            },
          },
        },
        "/v1/wrapped": {
          get: {
            operationId: "getWrapped",
            summary: "Malformed ignore does not waive wrapper",
            responses: {
              "200": {
                description: "Wrapped",
                content: {
                  "application/json": {
                    schema: {
                      type: "object",
                      properties: {
                        item: {
                          type: "object",
                          properties: { id: { type: "string" } },
                        },
                      },
                    },
                  },
                },
              },
            },
          },
        },
      },
    });

    const { exitCode, report } = await lintOpenApi(doc, configPath);
    expect(exitCode).toBe(1);
    expect(ads0002Problems(report)).toHaveLength(2);
  });
});
