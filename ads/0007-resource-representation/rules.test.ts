import { spawnSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { stringify as stringifyYaml } from "yaml";
import {
  ADS_0007_METADATA,
  isValidCanonicalResourceType,
  isValidDerivedResourceRole,
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
      description: "Test specification for ADS-0007.",
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

function pathParam(name: string): Record<string, unknown> {
  return {
    name,
    in: "path",
    required: true,
    description: `Identifier ${name}`,
    schema: { type: "string" },
  };
}

function jsonResponse(
  schema: Record<string, unknown>,
  description = "OK",
): Record<string, unknown> {
  return {
    description,
    content: {
      "application/json": {
        schema,
      },
    },
  };
}

function jsonRequestBody(schema: Record<string, unknown>): Record<string, unknown> {
  return {
    required: true,
    content: {
      "application/json": {
        schema,
      },
    },
  };
}

function ads0007Problems(report: RedoclyJsonReport): RedoclyJsonProblem[] {
  return report.problems.filter((problem) => problem.ruleId.startsWith("photon-ads/ads-0007-"));
}

function ads0007ProblemsFor(report: RedoclyJsonReport, ruleName: string): RedoclyJsonProblem[] {
  return report.problems.filter((problem) => problem.ruleId === `photon-ads/${ruleName}`);
}

beforeAll(async () => {
  tempDir = await mkdtemp(join(tmpdir(), "photon-ads-0007-"));
});

afterAll(async () => {
  if (tempDir) {
    await rm(tempDir, { recursive: true, force: true });
  }
});

describe("ADS-0007 unit helpers", () => {
  it("exports metadata for all five error-level ADS-0007 rules", () => {
    expect(ADS_0007_METADATA.ads).toBe("0007");
    expect(ADS_0007_METADATA.slug).toBe("ads-0007");
    expect(ADS_0007_METADATA.folder).toBe("0007-resource-representation");
    expect(ADS_0007_METADATA.rules.map((r) => r.id)).toEqual([
      "photon-ads/ads-0007-response-representation-consistency",
      "photon-ads/ads-0007-collection-slice-subset",
      "photon-ads/ads-0007-mutation-input-symmetry",
      "photon-ads/ads-0007-resource-annotation-valid",
      "photon-ads/ads-0007-derived-schema-compatibility",
    ]);
    expect(ADS_0007_METADATA.rules.every((r) => r.severity === "error")).toBe(true);
  });

  it("validates canonical resource types and derived resource roles", () => {
    expect(isValidCanonicalResourceType("projects.project")).toBe(true);
    expect(isValidCanonicalResourceType("projects.api-key")).toBe(true);
    expect(isValidCanonicalResourceType("billing.operation")).toBe(true);
    expect(isValidCanonicalResourceType("billing-v2.line-item")).toBe(true);

    expect(isValidCanonicalResourceType("projects")).toBe(false);
    expect(isValidCanonicalResourceType("Projects.project")).toBe(false);
    expect(isValidCanonicalResourceType("projects.api_key")).toBe(false);
    expect(isValidCanonicalResourceType("a.b.c")).toBe(false);
    expect(isValidCanonicalResourceType("1a.project")).toBe(false);

    expect(isValidDerivedResourceRole("slice")).toBe(true);
    expect(isValidDerivedResourceRole("create")).toBe(true);
    expect(isValidDerivedResourceRole("patch")).toBe(true);
    expect(isValidDerivedResourceRole("replace")).toBe(true);
    expect(isValidDerivedResourceRole("canonical")).toBe(false);
    expect(isValidDerivedResourceRole("update")).toBe(false);
  });
});

describe("ADS-0007 Redocly rules", () => {
  it("passes the repository valid OpenAPI fixture with zero errors and zero warnings", () => {
    const { exitCode, report } = runRedoclyLint(VALID_FIXTURE);
    expect(exitCode).toBe(0);
    expect(report.totals.errors).toBe(0);
    expect(report.totals.warnings).toBe(0);
    expect(ads0007Problems(report)).toEqual([]);
  });

  it("validates hoisted canonical GET, flat creation secrets, slices, and per-service Operation canonical resources", async () => {
    const doc = baseOpenApi({
      paths: {
        // Hoisted canonical GET + scoped collection with strict slice + POST 201
        "/v1/organizations/{organizationId}/projects": {
          parameters: [pathParam("organizationId")],
          get: {
            operationId: "listOrgProjects",
            summary: "List projects via slice paired with hoisted GET /v1/projects/{projectId}",
            responses: {
              "200": jsonResponse({
                type: "object",
                required: ["items"],
                properties: {
                  items: { type: "array", items: { $ref: "#/components/schemas/ProjectSummary" } },
                },
              }),
            },
          },
          post: {
            operationId: "createOrgProject",
            summary: "Create project returning canonical Project",
            requestBody: jsonRequestBody({ $ref: "#/components/schemas/CreateProjectRequest" }),
            responses: { "201": jsonResponse({ $ref: "#/components/schemas/Project" }, "Created") },
          },
        },
        "/v1/projects/{projectId}": {
          parameters: [pathParam("projectId")],
          get: {
            operationId: "getProject",
            summary: "Hoisted canonical GET",
            responses: { "200": jsonResponse({ $ref: "#/components/schemas/Project" }) },
          },
          patch: {
            operationId: "patchProject",
            summary: "RFC 7396 merge patch returning canonical Project",
            requestBody: jsonRequestBody({ $ref: "#/components/schemas/PatchProjectRequest" }),
            responses: { "200": jsonResponse({ $ref: "#/components/schemas/Project" }) },
          },
        },
        // Creation with flat sibling secret (normative ADS-0002 §3)
        "/v1/projects/{projectId}/api-keys": {
          parameters: [pathParam("projectId")],
          get: {
            operationId: "listApiKeys",
            summary: "List API keys",
            responses: {
              "200": jsonResponse({
                type: "object",
                required: ["items"],
                properties: {
                  items: { type: "array", items: { $ref: "#/components/schemas/ApiKey" } },
                },
              }),
            },
          },
          post: {
            operationId: "createApiKeyFlat",
            summary: "Create API key with flat one-time secret",
            requestBody: jsonRequestBody({
              type: "object",
              required: ["name"],
              properties: { name: { type: "string" } },
            }),
            responses: {
              "201": jsonResponse({ $ref: "#/components/schemas/CreatedApiKeyFlat" }, "Created"),
            },
          },
        },
        "/v1/projects/{projectId}/api-keys/{apiKeyId}": {
          parameters: [pathParam("projectId"), pathParam("apiKeyId")],
          get: {
            operationId: "getApiKey",
            summary: "Get API key",
            responses: { "200": jsonResponse({ $ref: "#/components/schemas/ApiKey" }) },
          },
        },
        // Per-service Operation canonical resource (billing.operation)
        "/v1/projects/{projectId}/billing/operations": {
          parameters: [pathParam("projectId")],
          get: {
            operationId: "listBillingOperations",
            summary: "List billing operations via slice",
            responses: {
              "200": jsonResponse({
                type: "object",
                required: ["items"],
                properties: {
                  items: {
                    type: "array",
                    items: { $ref: "#/components/schemas/BillingOperationSummary" },
                  },
                },
              }),
            },
          },
        },
        "/v1/projects/{projectId}/billing/operations/{operationId}": {
          parameters: [pathParam("projectId"), pathParam("operationId")],
          get: {
            operationId: "getBillingOperation",
            summary: "Get billing operation",
            responses: { "200": jsonResponse({ $ref: "#/components/schemas/BillingOperation" }) },
          },
        },
      },
      components: {
        schemas: {
          Project: {
            "x-photon-resource": { type: "projects.project" },
            type: "object",
            required: ["id", "name", "createdAt"],
            properties: {
              id: { type: "string", readOnly: true },
              name: { type: "string" },
              description: { type: ["string", "null"] },
              createdAt: { type: "string", format: "date-time", readOnly: true },
            },
          },
          ProjectSummary: {
            "x-photon-resource": {
              role: "slice",
              canonical: "#/components/schemas/Project",
            },
            type: "object",
            required: ["id", "name"],
            properties: {
              id: { type: "string", readOnly: true },
              name: { type: "string" },
            },
          },
          CreateProjectRequest: {
            "x-photon-resource": {
              role: "create",
              canonical: "#/components/schemas/Project",
              nonResourceInputs: ["templateId"],
            },
            type: "object",
            required: ["name"],
            properties: {
              name: { type: "string" },
              description: { type: ["string", "null"] },
              templateId: { type: "string" },
            },
          },
          PatchProjectRequest: {
            "x-photon-resource": {
              role: "patch",
              canonical: "#/components/schemas/Project",
            },
            type: "object",
            additionalProperties: false,
            minProperties: 1,
            properties: {
              name: { type: "string" },
              description: { type: ["string", "null"] },
            },
          },
          ApiKey: {
            "x-photon-resource": { type: "projects.api-key" },
            type: "object",
            required: ["id", "name"],
            properties: {
              id: { type: "string", readOnly: true },
              name: { type: "string" },
            },
          },
          CreatedApiKeyFlat: {
            allOf: [
              { $ref: "#/components/schemas/ApiKey" },
              {
                type: "object",
                required: ["secret"],
                properties: { secret: { type: "string" } },
              },
            ],
          },
          BillingOperation: {
            "x-photon-resource": { type: "billing.operation" },
            type: "object",
            required: [
              "id",
              "type",
              "status",
              "createdAt",
              "updatedAt",
              "completedAt",
              "response",
              "error",
            ],
            properties: {
              id: { type: "string", readOnly: true },
              type: { type: "string", const: "billing.checkout" },
              status: { type: "string", enum: ["pending", "succeeded", "failed"] },
              createdAt: { type: "string", format: "date-time", readOnly: true },
              updatedAt: { type: "string", format: "date-time", readOnly: true },
              completedAt: { type: ["string", "null"], format: "date-time", readOnly: true },
              response: {
                type: ["object", "null"],
                properties: { invoiceId: { type: "string" } },
              },
              error: {
                type: ["object", "null"],
                properties: { title: { type: "string" } },
              },
            },
          },
          BillingOperationSummary: {
            "x-photon-resource": {
              role: "slice",
              canonical: "#/components/schemas/BillingOperation",
            },
            type: "object",
            required: ["id", "status"],
            properties: {
              id: { type: "string", readOnly: true },
              status: { type: "string", enum: ["pending", "succeeded", "failed"] },
            },
          },
          NestedUnionCanonical: {
            "x-photon-resource": { type: "events.nested-union" },
            anyOf: [
              {
                type: "object",
                required: ["id", "payload"],
                properties: {
                  id: { type: "string", readOnly: true },
                  payload: {
                    type: "object",
                    required: ["value"],
                    properties: { value: { type: "string" } },
                  },
                },
              },
              {
                type: "object",
                required: ["id", "payload"],
                properties: {
                  id: { type: "string", readOnly: true },
                  payload: {
                    type: "object",
                    required: ["value"],
                    properties: { value: { type: "integer" } },
                  },
                },
              },
            ],
          },
          NestedUnionIntegerSlice: {
            "x-photon-resource": {
              role: "slice",
              canonical: "#/components/schemas/NestedUnionCanonical",
            },
            type: "object",
            required: ["id", "payload"],
            properties: {
              id: { type: "string", readOnly: true },
              payload: {
                type: "object",
                required: ["value"],
                properties: { value: { type: "integer" } },
              },
            },
          },
        },
      },
    });

    const { report } = await lintOpenApi(doc);
    expect(ads0007Problems(report)).toEqual([]);
  });

  it("enforces ads-0007-response-representation-consistency on PATCH, PUT, POST, and drifted receipt envelopes", async () => {
    const doc = baseOpenApi({
      paths: {
        "/v1/projects/{projectId}": {
          parameters: [pathParam("projectId")],
          get: {
            operationId: "getProject",
            summary: "Canonical GET",
            responses: { "200": jsonResponse({ $ref: "#/components/schemas/Project" }) },
          },
          patch: {
            operationId: "patchDriftedProject",
            summary: "PATCH returning mismatched representation",
            requestBody: jsonRequestBody({
              type: "object",
              additionalProperties: false,
              properties: { name: { type: "string" } },
            }),
            responses: {
              "200": jsonResponse({
                type: "object",
                required: ["id", "extraOnly"],
                properties: {
                  id: { type: "string" },
                  extraOnly: { type: "string" },
                },
              }),
            },
          },
        },
        "/v1/projects/{projectId}/settings": {
          parameters: [pathParam("projectId")],
          get: {
            operationId: "getSettings",
            summary: "Canonical singleton GET",
            responses: {
              "200": jsonResponse({
                type: "object",
                required: ["enabled"],
                properties: { enabled: { type: "boolean" } },
              }),
            },
          },
          put: {
            operationId: "putSettingsMismatch",
            summary: "PUT returning different type for enabled",
            requestBody: jsonRequestBody({
              type: "object",
              properties: { enabled: { type: "boolean" } },
            }),
            responses: {
              "200": jsonResponse({
                type: "object",
                required: ["enabled"],
                properties: { enabled: { type: "string" } },
              }),
            },
          },
        },
        "/v1/projects/{projectId}/api-keys": {
          parameters: [pathParam("projectId")],
          post: {
            operationId: "createApiKeyDriftedEnvelope",
            summary: "POST returning receipt envelope with drifted embedded ApiKey",
            requestBody: jsonRequestBody({
              type: "object",
              properties: { name: { type: "string" } },
            }),
            responses: {
              "201": jsonResponse(
                {
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
                },
                "Created",
              ),
            },
          },
        },
        "/v1/projects/{projectId}/api-keys/{apiKeyId}": {
          parameters: [pathParam("projectId"), pathParam("apiKeyId")],
          get: {
            operationId: "getApiKey",
            summary: "Canonical GET",
            responses: {
              "200": jsonResponse({
                type: "object",
                required: ["id", "name"],
                properties: {
                  id: { type: "string" },
                  name: { type: "string" },
                },
              }),
            },
          },
        },
      },
      components: {
        schemas: {
          Project: {
            type: "object",
            required: ["id", "name"],
            properties: {
              id: { type: "string" },
              name: { type: "string" },
            },
          },
        },
      },
    });

    const { report } = await lintOpenApi(doc);
    const errors = ads0007ProblemsFor(report, "ads-0007-response-representation-consistency");
    const messages = errors.map((e) => e.message);

    expect(errors).toHaveLength(3);
    expect(messages.some((m) => m.includes('PATCH "/v1/projects/{projectId}"'))).toBe(true);
    expect(messages.some((m) => m.includes('PUT "/v1/projects/{projectId}/settings"'))).toBe(true);
    expect(messages.some((m) => m.includes('POST "/v1/projects/{projectId}/api-keys"'))).toBe(true);
  });

  it("enforces ads-0007-collection-slice-subset for extra fields, type drift, and hoisted collections", async () => {
    const doc = baseOpenApi({
      paths: {
        "/v1/organizations/{organizationId}/projects": {
          parameters: [pathParam("organizationId")],
          get: {
            operationId: "listDriftedProjects",
            summary: "Hoisted collection with extra field and type drift",
            responses: {
              "200": jsonResponse({
                type: "object",
                required: ["items"],
                properties: {
                  items: {
                    type: "array",
                    items: {
                      type: "object",
                      required: ["id", "name"],
                      properties: {
                        id: { type: "string" },
                        name: { type: "string" },
                        memberCount: { type: "string" },
                        listOnlyBadge: { type: "string" },
                      },
                    },
                  },
                },
              }),
            },
          },
        },
        "/v1/projects/{projectId}": {
          parameters: [pathParam("projectId")],
          get: {
            operationId: "getProject",
            summary: "Hoisted canonical GET",
            responses: {
              "200": jsonResponse({
                type: "object",
                required: ["id", "name", "memberCount"],
                properties: {
                  id: { type: "string" },
                  name: { type: "string" },
                  memberCount: { type: "integer" },
                },
              }),
            },
          },
        },
      },
    });

    const { report } = await lintOpenApi(doc);
    const errors = ads0007ProblemsFor(report, "ads-0007-collection-slice-subset");
    const messages = errors.map((e) => e.message);

    expect(errors).toHaveLength(2);
    expect(messages.some((m) => m.includes('property "listOnlyBadge" does not exist'))).toBe(true);
    expect(
      messages.some((m) => m.includes('property "memberCount" type "string" is incompatible')),
    ).toBe(true);
  });

  it("enforces ads-0007-mutation-input-symmetry for type drift, server-managed keys, and readOnly properties", async () => {
    const doc = baseOpenApi({
      paths: {
        "/v1/projects": {
          post: {
            operationId: "createProjectBadInput",
            summary: "POST accepting createdAt, readOnly field, and wrong overlapping type",
            requestBody: jsonRequestBody({
              type: "object",
              properties: {
                name: { type: "integer" },
                createdAt: { type: "string", format: "date-time" },
                computedSlug: { type: "string" },
                templateId: { type: "string" },
              },
            }),
            responses: {
              "201": jsonResponse({ $ref: "#/components/schemas/Project" }, "Created"),
            },
          },
        },
        "/v1/projects/{projectId}": {
          parameters: [pathParam("projectId")],
          get: {
            operationId: "getProject",
            summary: "Canonical GET",
            responses: { "200": jsonResponse({ $ref: "#/components/schemas/Project" }) },
          },
          patch: {
            operationId: "patchProjectBadInput",
            summary: "PATCH accepting id, readOnly field, and mismatched nested type",
            requestBody: jsonRequestBody({
              type: "object",
              additionalProperties: false,
              properties: {
                id: { type: "string" },
                computedSlug: { type: "string" },
                settings: {
                  type: "object",
                  properties: { retries: { type: "string" } },
                },
              },
            }),
            responses: { "200": jsonResponse({ $ref: "#/components/schemas/Project" }) },
          },
        },
      },
      components: {
        schemas: {
          Project: {
            type: "object",
            required: ["id", "name", "createdAt"],
            properties: {
              id: { type: "string", readOnly: true },
              name: { type: "string" },
              createdAt: { type: "string", format: "date-time", readOnly: true },
              computedSlug: { type: "string", readOnly: true },
              settings: {
                type: "object",
                properties: { retries: { type: "integer" } },
              },
            },
          },
        },
      },
    });

    const { report } = await lintOpenApi(doc);
    const errors = ads0007ProblemsFor(report, "ads-0007-mutation-input-symmetry");
    const messages = errors.map((e) => e.message);

    expect(errors).toHaveLength(6);
    expect(messages.some((m) => m.includes('POST "/v1/projects" request property "name"'))).toBe(
      true,
    );
    expect(
      messages.some((m) => m.includes('POST "/v1/projects" request property "createdAt"')),
    ).toBe(true);
    expect(
      messages.some((m) => m.includes('POST "/v1/projects" request property "computedSlug"')),
    ).toBe(true);
    // templateId is non-overlapping on POST and allowed in Tier 1
    expect(messages.some((m) => m.includes("templateId"))).toBe(false);

    expect(
      messages.some((m) => m.includes('PATCH "/v1/projects/{projectId}" request property "id"')),
    ).toBe(true);
    expect(
      messages.some((m) =>
        m.includes('PATCH "/v1/projects/{projectId}" request property "computedSlug"'),
      ),
    ).toBe(true);
    expect(
      messages.some((m) =>
        m.includes('PATCH "/v1/projects/{projectId}" request property "settings.retries"'),
      ),
    ).toBe(true);
  });

  it("enforces ads-0007-resource-annotation-valid across canonical and derived x-photon-resource errors", async () => {
    const doc = baseOpenApi({
      components: {
        schemas: {
          Project: {
            "x-photon-resource": { type: "projects.project" },
            type: "object",
            properties: { id: { type: "string" }, name: { type: "string" } },
          },
          DuplicateProject: {
            "x-photon-resource": { type: "projects.project" },
            type: "object",
            properties: { id: { type: "string" } },
          },
          BadTypeFormat: {
            "x-photon-resource": { type: "Projects_Bad" },
            type: "object",
          },
          MixedForm: {
            "x-photon-resource": {
              type: "projects.mixed",
              role: "slice",
              canonical: "#/components/schemas/Project",
            },
            type: "object",
          },
          NotObjectExt: {
            "x-photon-resource": "projects.string",
            type: "object",
          },
          DanglingCanonical: {
            "x-photon-resource": {
              role: "slice",
              canonical: "#/components/schemas/DoesNotExist",
            },
            type: "object",
          },
          SelfRefDerived: {
            "x-photon-resource": {
              role: "slice",
              canonical: "#/components/schemas/SelfRefDerived",
            },
            type: "object",
          },
          UnannotatedTarget: {
            type: "object",
            properties: { id: { type: "string" } },
          },
          DerivedPointingToUnannotated: {
            "x-photon-resource": {
              role: "slice",
              canonical: "#/components/schemas/UnannotatedTarget",
            },
            type: "object",
          },
          ValidSlice: {
            "x-photon-resource": {
              role: "slice",
              canonical: "#/components/schemas/Project",
            },
            type: "object",
            properties: { id: { type: "string" } },
          },
          ChainedDerived: {
            "x-photon-resource": {
              role: "slice",
              canonical: "#/components/schemas/ValidSlice",
            },
            type: "object",
          },
          WrongRoleNonResourceInputs: {
            "x-photon-resource": {
              role: "patch",
              canonical: "#/components/schemas/Project",
              nonResourceInputs: ["extra"],
            },
            type: "object",
            additionalProperties: false,
            properties: { name: { type: "string" } },
          },
          BadCreateNonResourceInputs: {
            "x-photon-resource": {
              role: "create",
              canonical: "#/components/schemas/Project",
              nonResourceInputs: ["missingProp", "name", "missingProp"],
            },
            type: "object",
            properties: { name: { type: "string" } },
          },
        },
      },
    });

    const { report } = await lintOpenApi(doc);
    const errors = ads0007ProblemsFor(report, "ads-0007-resource-annotation-valid");
    const messages = errors.map((e) => e.message);

    expect(messages.some((m) => m.includes('duplicate canonical "x-photon-resource.type"'))).toBe(
      true,
    );
    expect(messages.some((m) => m.includes('Component schema "BadTypeFormat"'))).toBe(true);
    expect(messages.some((m) => m.includes("cannot combine canonical"))).toBe(true);
    expect(messages.some((m) => m.includes('Component schema "NotObjectExt"'))).toBe(true);
    expect(messages.some((m) => m.includes("does not exist under components.schemas"))).toBe(true);
    expect(messages.some((m) => m.includes("must not reference itself"))).toBe(true);
    expect(
      messages.some(
        (m) =>
          m.includes('Component schema "DerivedPointingToUnannotated"') &&
          m.includes("must itself declare canonical"),
      ),
    ).toBe(true);
    expect(
      messages.some(
        (m) =>
          m.includes('Component schema "ChainedDerived"') &&
          m.includes("must itself declare canonical"),
      ),
    ).toBe(true);
    expect(messages.some((m) => m.includes('allowed only on role "create"'))).toBe(true);
    expect(
      messages.some((m) =>
        m.includes('not a declared property on Component schema "BadCreateNonResourceInputs"'),
      ),
    ).toBe(true);
    expect(messages.some((m) => m.includes('already exists on canonical schema "Project"'))).toBe(
      true,
    );
    expect(messages.some((m) => m.includes('contains duplicate property name "missingProp"'))).toBe(
      true,
    );
  });

  it("enforces ads-0007-derived-schema-compatibility across slice, create, patch, and replace roles", async () => {
    const doc = baseOpenApi({
      components: {
        schemas: {
          Project: {
            "x-photon-resource": { type: "projects.project" },
            type: "object",
            required: ["id", "name", "createdAt"],
            properties: {
              id: { type: "string", readOnly: true },
              name: { type: "string" },
              createdAt: { type: "string", format: "date-time", readOnly: true },
            },
          },
          BadSlice: {
            "x-photon-resource": { role: "slice", canonical: "#/components/schemas/Project" },
            type: "object",
            properties: {
              id: { type: "integer" },
              extraBadge: { type: "string" },
            },
          },
          BadCreate: {
            "x-photon-resource": { role: "create", canonical: "#/components/schemas/Project" },
            type: "object",
            properties: {
              name: { type: "string" },
              createdAt: { type: "string" },
              undeclaredExtra: { type: "string" },
            },
          },
          BadPatch: {
            "x-photon-resource": { role: "patch", canonical: "#/components/schemas/Project" },
            type: "object",
            required: ["name"],
            properties: {
              id: { type: "string" },
              name: { type: "string" },
            },
          },
          BadReplace: {
            "x-photon-resource": { role: "replace", canonical: "#/components/schemas/Project" },
            type: "object",
            properties: {
              id: { type: "string" },
              name: { type: "string" },
            },
          },
          NonObjectDerived: {
            "x-photon-resource": { role: "slice", canonical: "#/components/schemas/Project" },
            type: "string",
          },
        },
      },
    });

    const { report } = await lintOpenApi(doc);
    const errors = ads0007ProblemsFor(report, "ads-0007-derived-schema-compatibility");
    const messages = errors.map((e) => e.message);

    expect(
      messages.some((m) => m.includes('Component schema "BadSlice"') && m.includes("extraBadge")),
    ).toBe(true);
    expect(
      messages.some(
        (m) => m.includes('Component schema "BadCreate"') && m.includes("undeclaredExtra"),
      ),
    ).toBe(true);
    expect(
      messages.some(
        (m) =>
          m.includes('Component schema "BadPatch"') &&
          m.includes('required top-level properties ("name")'),
      ),
    ).toBe(true);
    expect(
      messages.some(
        (m) =>
          m.includes('Component schema "BadPatch"') && m.includes("does not forbid unknown fields"),
      ),
    ).toBe(true);
    expect(
      messages.some(
        (m) => m.includes('Component schema "BadPatch"') && m.includes('property "id"'),
      ),
    ).toBe(true);
    expect(
      messages.some(
        (m) => m.includes('Component schema "BadReplace"') && m.includes('property "id"'),
      ),
    ).toBe(true);
    expect(
      messages.some(
        (m) => m.includes('Component schema "NonObjectDerived"') && m.includes("non-object type"),
      ),
    ).toBe(true);
  });

  it("supports declarative path, method, and schema ignore options across all five ADS-0007 rules", async () => {
    const configPath = await writeRedoclyConfig({
      "photon-ads/ads-0007-response-representation-consistency": {
        severity: "error",
        ignore: [{ path: "/v1/projects/{projectId}", method: "patch", reason: "Legacy response" }],
      },
      "photon-ads/ads-0007-collection-slice-subset": {
        severity: "error",
        ignore: [{ path: "/v1/projects", method: "get", reason: "Legacy list" }],
      },
      "photon-ads/ads-0007-mutation-input-symmetry": {
        severity: "error",
        ignore: [
          { path: "/v1/projects/{projectId}", method: "patch", reason: "Legacy patch input" },
        ],
      },
      "photon-ads/ads-0007-resource-annotation-valid": {
        severity: "error",
        ignore: [{ schema: "IgnoredBadAnnotation", reason: "Legacy annotation" }],
      },
      "photon-ads/ads-0007-derived-schema-compatibility": {
        severity: "error",
        ignore: [{ schema: "IgnoredBadSlice", reason: "Legacy slice" }],
      },
    });

    const doc = baseOpenApi({
      paths: {
        "/v1/projects": {
          get: {
            operationId: "listLegacyProjects",
            summary: "Ignored list",
            responses: {
              "200": jsonResponse({
                type: "object",
                required: ["items"],
                properties: {
                  items: {
                    type: "array",
                    items: {
                      type: "object",
                      properties: { id: { type: "string" }, legacyExtra: { type: "string" } },
                    },
                  },
                },
              }),
            },
          },
        },
        "/v1/projects/{projectId}": {
          parameters: [pathParam("projectId")],
          get: {
            operationId: "getProject",
            summary: "Canonical GET",
            responses: { "200": jsonResponse({ $ref: "#/components/schemas/Project" }) },
          },
          patch: {
            operationId: "patchLegacyProject",
            summary: "Ignored PATCH",
            requestBody: jsonRequestBody({
              type: "object",
              additionalProperties: false,
              properties: { id: { type: "string" } },
            }),
            responses: {
              "200": jsonResponse({
                type: "object",
                properties: { different: { type: "string" } },
              }),
            },
          },
        },
      },
      components: {
        schemas: {
          Project: {
            "x-photon-resource": { type: "projects.project" },
            type: "object",
            required: ["id", "name"],
            properties: { id: { type: "string", readOnly: true }, name: { type: "string" } },
          },
          IgnoredBadAnnotation: {
            "x-photon-resource": { type: "INVALID_FORMAT" },
            type: "object",
          },
          IgnoredBadSlice: {
            "x-photon-resource": { role: "slice", canonical: "#/components/schemas/Project" },
            type: "object",
            properties: { extra: { type: "string" } },
          },
        },
      },
    });

    const { report } = await lintOpenApi(doc, configPath);
    expect(ads0007Problems(report)).toEqual([]);
  });

  it("enforces edge cases across 2XX responses, ignored union branches, actions, explicit pointers, hoisted 202 inputs, reserved keys, and schema-only annotation walking", async () => {
    const configPath = await writeRedoclyConfig({
      "photon-ads/ads-0007-response-representation-consistency": {
        severity: "error",
        ignore: [{ schema: "LegacyProject", reason: "Legacy response union branch" }],
      },
      "photon-ads/ads-0007-collection-slice-subset": "error",
      "photon-ads/ads-0007-mutation-input-symmetry": "error",
      "photon-ads/ads-0007-resource-annotation-valid": "error",
      "photon-ads/ads-0007-derived-schema-compatibility": "error",
    });

    const doc = baseOpenApi({
      paths: {
        // 1. Collection POST with only 2XX response must be checked
        "/v1/projects/{projectId}/widgets": {
          parameters: [pathParam("projectId")],
          post: {
            operationId: "createWidget2xx",
            summary: "POST returning mismatched 2XX",
            requestBody: jsonRequestBody({
              type: "object",
              properties: { name: { type: "string" } },
            }),
            responses: {
              "2XX": jsonResponse({
                type: "object",
                required: ["id", "bogus"],
                properties: { id: { type: "string" }, bogus: { type: "string" } },
              }),
            },
          },
        },
        "/v1/projects/{projectId}/widgets/{widgetId}": {
          parameters: [pathParam("projectId"), pathParam("widgetId")],
          get: {
            operationId: "getWidget",
            summary: "Canonical widget GET",
            responses: {
              "200": jsonResponse({
                type: "object",
                required: ["id", "name"],
                properties: { id: { type: "string" }, name: { type: "string" } },
              }),
            },
          },
          // 2. PUT with explicit 201 and 2XX must check 2XX (covering 200) too
          put: {
            operationId: "putWidget201And2xx",
            summary: "PUT with valid 201 and invalid 2XX",
            requestBody: jsonRequestBody({
              type: "object",
              properties: { name: { type: "string" } },
            }),
            responses: {
              "201": jsonResponse({
                type: "object",
                required: ["id", "name"],
                properties: { id: { type: "string" }, name: { type: "string" } },
              }),
              "2XX": jsonResponse({
                type: "object",
                required: ["id", "name"],
                properties: { id: { type: "string" }, name: { type: "integer" } },
              }),
            },
          },
        },
        // 3. Ignored union branch in PATCH 200 must not trigger error when non-ignored branch matches
        "/v1/projects/{projectId}": {
          parameters: [pathParam("projectId")],
          get: {
            operationId: "getProject",
            summary: "Canonical Project GET",
            responses: { "200": jsonResponse({ $ref: "#/components/schemas/Project" }) },
          },
          patch: {
            operationId: "patchProjectWithIgnoredBranch",
            summary: "PATCH returning oneOf[LegacyProject, Project]",
            requestBody: jsonRequestBody({
              type: "object",
              additionalProperties: false,
              properties: { name: { type: "string" } },
            }),
            responses: {
              "200": jsonResponse({
                oneOf: [
                  { $ref: "#/components/schemas/LegacyProject" },
                  { $ref: "#/components/schemas/Project" },
                ],
              }),
            },
          },
        },
        // 4. Custom action returning drifted parent resource is checked; receipt-only action is exempt
        "/v1/projects/{projectId}/archive": {
          parameters: [pathParam("projectId")],
          post: {
            operationId: "archiveProjectDrifted",
            summary: "Action returning drifted Project",
            responses: {
              "200": jsonResponse({
                type: "object",
                required: ["id", "name"],
                properties: { id: { type: "string" }, name: { type: "integer" } },
              }),
            },
          },
        },
        "/v1/projects/{projectId}/ping": {
          parameters: [pathParam("projectId")],
          post: {
            operationId: "pingProjectReceipt",
            summary: "Receipt-only action",
            responses: {
              "200": jsonResponse({
                type: "object",
                required: ["ok"],
                properties: { ok: { type: "boolean" } },
              }),
            },
          },
        },
        // 5. Ordinary 5-field resource (no 202, no completedAt/response/error) must NOT be exempted as Operation
        "/v1/devices/{deviceId}": {
          parameters: [pathParam("deviceId")],
          get: {
            operationId: "getDevice",
            summary: "Device GET without updatedAt",
            responses: {
              "200": jsonResponse({
                type: "object",
                required: ["id", "type", "status", "createdAt"],
                properties: {
                  id: { type: "string" },
                  type: { type: "string" },
                  status: { type: "string" },
                  createdAt: { type: "string" },
                },
              }),
            },
          },
          patch: {
            operationId: "patchDeviceAddsUpdatedAt",
            summary:
              "PATCH adding undeclared updatedAt on response and reserved updatedAt on request",
            requestBody: jsonRequestBody({
              type: "object",
              additionalProperties: false,
              properties: { status: { type: "string" }, updatedAt: { type: "string" } },
            }),
            responses: {
              "200": jsonResponse({
                type: "object",
                required: ["id", "type", "status", "createdAt", "updatedAt"],
                properties: {
                  id: { type: "string" },
                  type: { type: "string" },
                  status: { type: "string" },
                  createdAt: { type: "string" },
                  updatedAt: { type: "string" },
                },
              }),
            },
          },
        },
        // 6. Hoisted PATCH returning only 202 must still check mutation input symmetry
        "/v1/organizations/{organizationId}/projects/{projectId}": {
          parameters: [pathParam("organizationId"), pathParam("projectId")],
          patch: {
            operationId: "patchHoistedProjectAsync",
            summary: "Hoisted async PATCH returning 202 only",
            requestBody: jsonRequestBody({
              type: "object",
              additionalProperties: false,
              properties: { name: { type: "integer" } },
            }),
            responses: {
              "202": jsonResponse({
                type: "object",
                required: ["id"],
                properties: { id: { type: "string" } },
              }),
            },
          },
        },
        // 7. Explicit x-photon-resource.canonical selects between two hoisted GETs (no direct child GET)
        "/v1/organizations/{organizationId}/teams/{teamId}/items": {
          parameters: [pathParam("organizationId"), pathParam("teamId")],
          get: {
            operationId: "listTeamItems",
            summary: "List team items pointing explicitly to TeamItem",
            responses: {
              "200": jsonResponse({
                type: "object",
                required: ["items"],
                properties: {
                  items: { type: "array", items: { $ref: "#/components/schemas/TeamItemSlice" } },
                },
              }),
            },
          },
          post: {
            operationId: "createTeamItemWithGlobalOnlyField",
            summary: "POST returning globalOnly field not on TeamItem",
            requestBody: jsonRequestBody({
              type: "object",
              properties: { name: { type: "string" } },
            }),
            responses: {
              "201": jsonResponse({
                type: "object",
                required: ["id", "name", "globalOnly"],
                properties: {
                  id: { type: "string" },
                  name: { type: "string" },
                  globalOnly: { type: "string" },
                },
              }),
            },
          },
        },
        // 7b. Positive control: the same POST response passes when the pointer targets GlobalItem
        "/v1/regions/{regionId}/teams/{teamId}/items": {
          parameters: [pathParam("regionId"), pathParam("teamId")],
          get: {
            operationId: "listRegionTeamItems",
            summary: "List region team items pointing explicitly to GlobalItem",
            responses: {
              "200": jsonResponse({
                type: "object",
                required: ["items"],
                properties: {
                  items: { type: "array", items: { $ref: "#/components/schemas/GlobalItemSlice" } },
                },
              }),
            },
          },
          post: {
            operationId: "createRegionTeamItemWithGlobalOnlyField",
            summary: "POST returning globalOnly field present on GlobalItem",
            requestBody: jsonRequestBody({
              type: "object",
              properties: { name: { type: "string" } },
            }),
            responses: {
              "201": jsonResponse({
                type: "object",
                required: ["id", "name", "globalOnly"],
                properties: {
                  id: { type: "string" },
                  name: { type: "string" },
                  globalOnly: { type: "string" },
                },
              }),
            },
          },
        },
        "/v1/teams/{teamId}/items/{itemId}": {
          parameters: [pathParam("teamId"), pathParam("itemId")],
          get: {
            operationId: "getTeamItem",
            summary: "TeamItem canonical GET",
            responses: { "200": jsonResponse({ $ref: "#/components/schemas/TeamItem" }) },
          },
        },
        "/v1/items/{itemId}": {
          parameters: [pathParam("itemId")],
          get: {
            operationId: "getGlobalItem",
            summary: "GlobalItem canonical GET",
            responses: { "200": jsonResponse({ $ref: "#/components/schemas/GlobalItem" }) },
          },
        },
      },
      components: {
        schemas: {
          Project: {
            "x-photon-resource": { type: "projects.project" },
            type: "object",
            required: ["id", "name"],
            properties: {
              id: { type: "string", readOnly: true },
              name: { type: "string" },
              // default payload containing x-photon-resource must NOT be treated as a schema annotation
              metadata: {
                type: "object",
                default: { "x-photon-resource": "just-example-data" },
              },
              // property literally named "example" carrying an invalid annotation MUST be validated
              example: {
                type: "object",
                "x-photon-resource": { type: "BAD_EXAMPLE_PROP" },
              },
            },
          },
          LegacyProject: {
            type: "object",
            required: ["legacyOnly"],
            properties: { legacyOnly: { type: "string" } },
          },
          TeamItem: {
            "x-photon-resource": { type: "teams.item" },
            type: "object",
            required: ["id", "name"],
            properties: { id: { type: "string" }, name: { type: "string" } },
          },
          GlobalItem: {
            "x-photon-resource": { type: "global.item" },
            type: "object",
            required: ["id", "name", "globalOnly"],
            properties: {
              id: { type: "string" },
              name: { type: "string" },
              globalOnly: { type: "string" },
            },
          },
          TeamItemSlice: {
            "x-photon-resource": { role: "slice", canonical: "#/components/schemas/TeamItem" },
            type: "object",
            required: ["id", "name"],
            properties: { id: { type: "string" }, name: { type: "string" } },
          },
          GlobalItemSlice: {
            "x-photon-resource": { role: "slice", canonical: "#/components/schemas/GlobalItem" },
            type: "object",
            required: ["id", "name"],
            properties: { id: { type: "string" }, name: { type: "string" } },
          },
          // 8. nonResourceInputs must NOT exempt server-managed createdAt
          CreateTeamItemBadNri: {
            "x-photon-resource": {
              role: "create",
              canonical: "#/components/schemas/TeamItem",
              nonResourceInputs: ["createdAt"],
            },
            type: "object",
            properties: {
              name: { type: "string" },
              createdAt: { type: "string" },
            },
          },
        },
      },
    });

    const { report } = await lintOpenApi(doc, configPath);
    const respMsgs = ads0007ProblemsFor(report, "ads-0007-response-representation-consistency").map(
      (e) => e.message,
    );
    const mutMsgs = ads0007ProblemsFor(report, "ads-0007-mutation-input-symmetry").map(
      (e) => e.message,
    );
    const annotMsgs = ads0007ProblemsFor(report, "ads-0007-resource-annotation-valid").map(
      (e) => e.message,
    );
    const derivMsgs = ads0007ProblemsFor(report, "ads-0007-derived-schema-compatibility").map(
      (e) => e.message,
    );

    expect(respMsgs.some((m) => m.includes("/widgets") && m.includes('property "bogus"'))).toBe(
      true,
    );
    expect(respMsgs.some((m) => m.includes("PUT") && m.includes("(2XX"))).toBe(true);
    expect(respMsgs.some((m) => m.includes("legacyOnly"))).toBe(false);
    expect(respMsgs.some((m) => m.includes("/archive") && m.includes('property "name"'))).toBe(
      true,
    );
    expect(respMsgs.some((m) => m.includes("/ping"))).toBe(false);
    expect(respMsgs.some((m) => m.includes("/devices") && m.includes('property "updatedAt"'))).toBe(
      true,
    );
    expect(
      respMsgs.some(
        (m) =>
          m.includes('POST "/v1/organizations/{organizationId}/teams/{teamId}/items"') &&
          m.includes('property "globalOnly"'),
      ),
    ).toBe(true);
    expect(respMsgs.some((m) => m.includes('"/v1/regions/{regionId}/teams/{teamId}/items"'))).toBe(
      false,
    );

    expect(mutMsgs.some((m) => m.includes("/devices") && m.includes('property "updatedAt"'))).toBe(
      true,
    );
    expect(
      mutMsgs.some((m) => m.includes("/organizations/{organizationId}/projects/{projectId}")),
    ).toBe(true);

    expect(annotMsgs.some((m) => m.includes("default"))).toBe(false);
    expect(annotMsgs.some((m) => m.includes("/properties/example"))).toBe(true);
    expect(
      annotMsgs.some((m) => m.includes("CreateTeamItemBadNri") && m.includes("createdAt")),
    ).toBe(true);
    expect(
      derivMsgs.some(
        (m) => m.includes("CreateTeamItemBadNri") && m.includes('property "createdAt"'),
      ),
    ).toBe(true);
  });
  it("checks 2XX custom actions, Operation replay exemptions, root-null patch roles, and skips path extension keys", async () => {
    const configPath = await writeRedoclyConfig({
      "photon-ads/ads-0007-response-representation-consistency": "error",
      "photon-ads/ads-0007-collection-slice-subset": "error",
      "photon-ads/ads-0007-mutation-input-symmetry": "error",
      "photon-ads/ads-0007-resource-annotation-valid": "error",
      "photon-ads/ads-0007-derived-schema-compatibility": "error",
    });
    const operationSchema = {
      type: "object",
      required: ["id", "type", "status", "createdAt", "updatedAt", "completedAt"],
      properties: {
        id: { type: "string" },
        type: { type: "string" },
        status: { type: "string", enum: ["queued", "running", "succeeded", "failed"] },
        createdAt: { type: "string", format: "date-time" },
        updatedAt: { type: "string", format: "date-time" },
        completedAt: { type: ["string", "null"], format: "date-time" },
        response: { type: ["object", "null"] },
        error: { type: ["object", "null"] },
      },
    };
    const gadgetProperties = {
      id: { type: "string" },
      type: { type: "string" },
      status: { type: "string" },
      createdAt: { type: "string" },
      updatedAt: { type: "string" },
      response: { type: ["object", "null"] },
      error: { type: ["object", "null"] },
      name: { type: "string" },
    };
    const doc = baseOpenApi({
      paths: {
        "/v1/gadgets/{gadgetId}": {
          parameters: [pathParam("gadgetId")],
          get: {
            operationId: "getGadget",
            summary: "Gadget canonical GET",
            responses: { "200": jsonResponse({ $ref: "#/components/schemas/Gadget" }) },
          },
          patch: {
            operationId: "patchGadget",
            summary: "PATCH returning a drifted Gadget under 200 and an Operation under 202",
            requestBody: jsonRequestBody({
              type: "object",
              additionalProperties: false,
              properties: { name: { type: "string" } },
            }),
            responses: {
              "200": jsonResponse({
                type: "object",
                required: ["id", "name"],
                properties: {
                  ...gadgetProperties,
                  completedAt: { type: ["string", "null"] },
                  debug: { type: "string" },
                },
              }),
              "202": jsonResponse(operationSchema),
            },
          },
        },
        "/v1/gadgets/{gadgetId}/rename": {
          parameters: [pathParam("gadgetId")],
          post: {
            operationId: "renameGadget",
            summary: "Action returning a drifted Gadget under 2XX",
            responses: {
              "2XX": jsonResponse({
                type: "object",
                required: ["id", "name"],
                properties: { id: { type: "string" }, name: { type: "integer" } },
              }),
            },
          },
        },
        "x-internal-notes": {
          get: {
            responses: {
              "200": jsonResponse({
                type: "object",
                "x-photon-resource": { type: "BAD_EXTENSION_PATH" },
              }),
            },
          },
        },
      },
      components: {
        schemas: {
          Gadget: {
            "x-photon-resource": { type: "devices.gadget" },
            type: "object",
            required: ["id", "name"],
            properties: gadgetProperties,
          },
          NullablePatchGadget: {
            "x-photon-resource": { role: "patch", canonical: "#/components/schemas/Gadget" },
            type: ["object", "null"],
            additionalProperties: false,
            properties: { name: { type: "string" } },
          },
        },
      },
    });

    const { report } = await lintOpenApi(doc, configPath);
    const respMsgs = ads0007ProblemsFor(report, "ads-0007-response-representation-consistency").map(
      (e) => e.message,
    );
    const annotMsgs = ads0007ProblemsFor(report, "ads-0007-resource-annotation-valid").map(
      (e) => e.message,
    );
    const derivMsgs = ads0007ProblemsFor(report, "ads-0007-derived-schema-compatibility").map(
      (e) => e.message,
    );

    expect(
      respMsgs.some(
        (m) => m.startsWith('PATCH "/v1/gadgets/{gadgetId}" (200') && m.includes("does not exist"),
      ),
    ).toBe(true);
    expect(
      respMsgs.some(
        (m) => m.includes('"/v1/gadgets/{gadgetId}/rename" (2XX') && m.includes('property "name"'),
      ),
    ).toBe(true);
    expect(annotMsgs.some((m) => m.includes("BAD_EXTENSION_PATH"))).toBe(false);
    expect(
      derivMsgs.some((m) => m.includes("NullablePatchGadget") && m.includes("non-object type")),
    ).toBe(true);
  });
});
