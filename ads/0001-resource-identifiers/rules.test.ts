import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { stringify as stringifyYaml } from "yaml";
import {
  ADS_0001_METADATA,
  deriveResourceStem,
  extractPathParamSlots,
  isNonResourceSchemaName,
  validateIdPropertyCasing,
  validatePathParamName,
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

function runRedoclyLint(
  specPath: string,
  configPath: string = REDOCLY_CONFIG,
  cwd: string = REPO_ROOT,
): {
  exitCode: number;
  stderr: string;
  report: RedoclyJsonReport;
} {
  try {
    const stdout = execFileSync(
      REDOCLY_BIN,
      ["lint", specPath, "--config", configPath, "--format=json"],
      {
        cwd,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    return {
      exitCode: 0,
      stderr: "",
      report: JSON.parse(stdout) as RedoclyJsonReport,
    };
  } catch (error) {
    const execError = error as { status?: number; stdout?: string; stderr?: string };
    const stdout = execError.stdout ?? "";
    const stderr = execError.stderr ?? "";
    if (!stdout.trim()) {
      throw new Error(`Redocly failed without JSON output (exit ${execError.status}): ${stderr}`);
    }
    return {
      exitCode: execError.status ?? 1,
      stderr,
      report: JSON.parse(stdout) as RedoclyJsonReport,
    };
  }
}

async function lintOpenApi(doc: Record<string, unknown>, configPath?: string, cwd?: string) {
  specCounter += 1;
  const specPath = join(tempDir, `spec-${specCounter}.yaml`);
  await writeFile(specPath, stringifyYaml(doc), "utf8");
  return runRedoclyLint(specPath, configPath, cwd);
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
      description: "Test specification for ADS-0001.",
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

beforeAll(async () => {
  tempDir = await mkdtemp(join(tmpdir(), "photon-ads-0001-"));
  // Always compile from current source so standalone `pnpm test` never exercises stale dist/.
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

describe("ADS-0001 unit helpers", () => {
  it("validates path parameter names accurately", () => {
    expect(validatePathParamName("projectId")).toBeNull();
    expect(validatePathParamName("apiKeyId")).toBeNull();
    expect(validatePathParamName("organizationId")).toBeNull();
    expect(validatePathParamName("slug")).toBeNull();
    expect(validatePathParamName("eventType")).toBeNull();
    expect(validatePathParamName("valid")).toBeNull();

    for (const generic of ["id", "ID", "Id", "uuid", "UUID", "uid", "guid", "pk", "PK"]) {
      expect(validatePathParamName(generic), `expected ${generic} to fail`).toContain(
        "generic name",
      );
    }

    for (const badCase of ["project_id", "project-id", "ProjectId", "api_key_id"]) {
      expect(validatePathParamName(badCase), `expected ${badCase} to fail`).toContain(
        "lowerCamelCase",
      );
    }

    for (const upperId of ["projectID", "apiKeyID", "projectIDType"]) {
      expect(validatePathParamName(upperId), `expected ${upperId} to fail`).toContain(
        'uppercase "ID"',
      );
    }
  });

  it("extracts normalized path parameter prefix slots while preserving interior empty segments", () => {
    expect(extractPathParamSlots("/v1/projects/{projectId}/api-keys/{apiKeyId}")).toEqual([
      { prefixKey: "/v1/projects/{*}", paramName: "projectId" },
      { prefixKey: "/v1/projects/{*}/api-keys/{*}", paramName: "apiKeyId" },
    ]);

    expect(extractPathParamSlots("/v1/projects/{projectId}:archive")).toEqual([
      { prefixKey: "/v1/projects/{*}", paramName: "projectId" },
    ]);

    expect(extractPathParamSlots("/v1/projects//{archiveId}/history")).toEqual([
      { prefixKey: "/v1/projects//{*}", paramName: "archiveId" },
    ]);
  });

  it("validates ID property casing accurately", () => {
    expect(validateIdPropertyCasing("id")).toBeNull();
    expect(validateIdPropertyCasing("projectId")).toBeNull();
    expect(validateIdPropertyCasing("apiKeyId")).toBeNull();
    expect(validateIdPropertyCasing("valid")).toBeNull();
    expect(validateIdPropertyCasing("paid")).toBeNull();
    expect(validateIdPropertyCasing("createdAt")).toBeNull();

    expect(validateIdPropertyCasing("ID")).toContain('lowercase "id"');
    expect(validateIdPropertyCasing("Id")).toContain('lowercase "id"');
    expect(validateIdPropertyCasing("project_id")).toContain('"projectId"');
    expect(validateIdPropertyCasing("api_key_id")).toContain('"apiKeyId"');
    expect(validateIdPropertyCasing("_id")).toContain('"id"');
    expect(validateIdPropertyCasing("projectID")).toContain('"projectId"');
    expect(validateIdPropertyCasing("organizationID")).toContain('"organizationId"');
  });

  it("classifies non-resource schemas and derives singular resource stems", () => {
    expect(isNonResourceSchemaName("CreateProjectRequest")).toBe(true);
    expect(isNonResourceSchemaName("ProblemDetails")).toBe(true);
    expect(isNonResourceSchemaName("ProjectUsage")).toBe(true);
    expect(isNonResourceSchemaName("ProjectListResponse")).toBe(true);
    expect(isNonResourceSchemaName("ProjectDeleteResponse")).toBe(true);
    expect(isNonResourceSchemaName("Project")).toBe(false);
    expect(isNonResourceSchemaName("ApiKeyResponse")).toBe(false);

    expect(deriveResourceStem("Project")).toBe("Project");
    expect(deriveResourceStem("ProjectResource")).toBe("Project");
    expect(deriveResourceStem("ApiKeyResponse")).toBe("ApiKey");
    expect(deriveResourceStem("InvoiceDetails")).toBe("Invoice");
    expect(deriveResourceStem("InvoiceDetail")).toBe("Invoice");
    expect(deriveResourceStem("OrganizationRecord")).toBe("Organization");
  });

  it("exposes metadata for all 3 ADS-0001 rules", () => {
    expect(ADS_0001_METADATA.ads).toBe("0001");
    expect(ADS_0001_METADATA.rules.map((rule) => rule.id)).toEqual([
      "photon-ads/ads-0001-resource-primary-id",
      "photon-ads/ads-0001-path-param-naming",
      "photon-ads/ads-0001-path-param-consistency",
    ]);
  });
});

describe("ADS-0001 end-to-end Redocly CLI enforcement", () => {
  it("loads the plugin via local config and consumer package specifier without deprecation warnings", async () => {
    const require = createRequire(import.meta.url);
    expect(require.resolve("@photon-ai/api-design-standards/redocly")).toBe(PLUGIN_DIST);

    const { exitCode, stderr, report } = runRedoclyLint(VALID_FIXTURE);
    expect(exitCode).toBe(0);
    expect(stderr).not.toContain("Deprecated plugin format");
    expect(report.totals.errors).toBe(0);
    expect(report.totals.warnings).toBe(0);
    expect(adsProblems(report)).toEqual([]);

    // Exercise the documented consumer setup using `@photon-ai/api-design-standards/redocly`.
    const consumerDir = join(tempDir, "consumer");
    const scopeDir = join(consumerDir, "node_modules", "@photon-ai");
    await mkdir(scopeDir, { recursive: true });
    await symlink(REPO_ROOT, join(scopeDir, "api-design-standards"), "dir");
    const consumerConfig = join(consumerDir, "redocly.yaml");
    await writeFile(
      consumerConfig,
      'plugins:\n  - "@photon-ai/api-design-standards/redocly"\nextends:\n  - photon-ads/recommended\n',
      "utf8",
    );

    const consumerResult = await lintOpenApi(
      baseOpenApi({
        paths: {
          "/v1/projects/{id}": {
            parameters: [
              {
                name: "id",
                in: "path",
                required: true,
                description: "Generic id",
                schema: { type: "string" },
              },
            ],
            get: {
              operationId: "getProject",
              summary: "Get project",
              responses: { "200": { description: "OK" } },
            },
          },
        },
      }),
      consumerConfig,
      consumerDir,
    );
    expect(consumerResult.exitCode).toBe(1);
    expect(consumerResult.stderr).not.toContain("Deprecated plugin format");
    expect(
      adsProblems(consumerResult.report).some(
        (problem) => problem.ruleId === "photon-ads/ads-0001-path-param-naming",
      ),
    ).toBe(true);
  });

  it("passes valid patterns without false positives", async () => {
    const { exitCode, report } = await lintOpenApi(
      baseOpenApi({
        paths: {
          "/v1/projects": {
            post: {
              operationId: "createProject",
              summary: "Create project",
              requestBody: {
                required: true,
                content: {
                  "application/json": {
                    schema: {
                      type: "object",
                      properties: {
                        organizationId: { type: "string" },
                        name: { type: "string" },
                      },
                    },
                  },
                },
              },
              responses: {
                "201": {
                  description: "Created",
                  content: {
                    "application/json": {
                      schema: { $ref: "#/components/schemas/Project" },
                    },
                  },
                },
                "400": {
                  description: "Bad request",
                  content: {
                    "application/problem+json": {
                      schema: { $ref: "#/components/schemas/ProblemDetails" },
                    },
                  },
                },
              },
            },
          },
          "/v1/projects/{projectId}": {
            parameters: [
              {
                name: "projectId",
                in: "path",
                required: true,
                description: "Project ID",
                schema: { type: "string" },
              },
            ],
            get: {
              operationId: "getProject",
              summary: "Get project",
              responses: {
                "200": {
                  description: "OK",
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
                "404": { description: "Not found" },
              },
            },
            delete: {
              operationId: "deleteProject",
              summary: "Delete project",
              responses: {
                "200": {
                  description: "Deleted",
                  content: {
                    "application/json": {
                      schema: {
                        type: "object",
                        properties: {
                          id: { type: "string" },
                          deleted: { type: "boolean" },
                        },
                      },
                    },
                  },
                },
                "404": { description: "Not found" },
              },
            },
          },
          "/v1/projects/{projectId}/usage": {
            parameters: [
              {
                name: "projectId",
                in: "path",
                required: true,
                description: "Project ID",
                schema: { type: "string" },
              },
            ],
            get: {
              operationId: "getProjectUsage",
              summary: "Get project usage",
              responses: {
                "200": {
                  description: "Usage",
                  content: {
                    "application/json": {
                      schema: {
                        type: "object",
                        properties: {
                          projectId: { type: "string" },
                          totalCents: { type: "integer" },
                        },
                      },
                    },
                  },
                },
                "404": { description: "Not found" },
              },
            },
          },
          "/v1/project-usage/{projectId}": {
            parameters: [
              {
                name: "projectId",
                in: "path",
                required: true,
                description: "Project ID",
                schema: { type: "string" },
              },
            ],
            get: {
              operationId: "getUsageSummaryByProject",
              summary: "Get usage summary by project",
              responses: {
                "200": {
                  description: "Usage summary",
                  content: {
                    "application/json": {
                      schema: { $ref: "#/components/schemas/ProjectUsage" },
                    },
                  },
                },
                "404": { description: "Not found" },
              },
            },
          },
          "/v1/projects//{archiveId}/history": {
            parameters: [
              {
                name: "archiveId",
                in: "path",
                required: true,
                description: "Archive ID",
                schema: { type: "string" },
              },
            ],
            get: {
              operationId: "getArchiveHistory",
              summary: "Get archive history with preserved interior empty segment",
              responses: {
                "200": { description: "OK" },
                "404": { description: "Not found" },
              },
            },
          },
          "/v1/themes/{slug}": {
            parameters: [
              {
                name: "slug",
                in: "path",
                required: true,
                description: "Theme slug",
                schema: { type: "string" },
              },
            ],
            get: {
              operationId: "getThemeBySlug",
              summary: "Get theme by slug",
              responses: {
                "200": {
                  description: "OK",
                  content: {
                    "application/json": {
                      schema: {
                        type: "object",
                        properties: {
                          id: { type: "string" },
                          slug: { type: "string" },
                        },
                      },
                    },
                  },
                },
                "404": { description: "Not found" },
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
                organizationId: { type: "string" },
                name: { type: "string" },
              },
            },
            ProjectUsage: {
              type: "object",
              properties: {
                projectId: { type: "string" },
                totalCents: { type: "integer" },
              },
            },
            ProblemDetails: {
              type: "object",
              properties: {
                type: { type: "string" },
                title: { type: "string" },
                status: { type: "integer" },
              },
            },
          },
        },
      }),
    );

    expect(exitCode).toBe(0);
    expect(adsProblems(report)).toEqual([]);
  });

  it("rejects generic, snake_case, kebab-case, PascalCase, and uppercase ID path parameters including $ref PathItems", async () => {
    const { exitCode, report } = await lintOpenApi(
      baseOpenApi({
        paths: {
          "/v1/projects/{id}": {
            $ref: "#/components/pathItems/SharedProjectPath",
          },
          "/v1/organizations/{uuid}": {
            parameters: [
              {
                name: "uuid",
                in: "path",
                required: true,
                description: "Generic uuid",
                schema: { type: "string" },
              },
            ],
            get: {
              operationId: "getOrg",
              summary: "Get organization",
              responses: { "200": { description: "OK" }, "404": { description: "Not found" } },
            },
          },
          "/v1/invoices/{invoice_id}": {
            parameters: [
              {
                name: "invoice_id",
                in: "path",
                required: true,
                description: "Snake case",
                schema: { type: "string" },
              },
            ],
            get: {
              operationId: "getInvoice",
              summary: "Get invoice",
              responses: { "200": { description: "OK" }, "404": { description: "Not found" } },
            },
          },
          "/v1/customers/{customer-id}": {
            parameters: [
              {
                name: "customer-id",
                in: "path",
                required: true,
                description: "Kebab case",
                schema: { type: "string" },
              },
            ],
            get: {
              operationId: "getCustomer",
              summary: "Get customer",
              responses: { "200": { description: "OK" }, "404": { description: "Not found" } },
            },
          },
          "/v1/keys/{ApiKeyId}": {
            parameters: [
              {
                name: "ApiKeyId",
                in: "path",
                required: true,
                description: "PascalCase",
                schema: { type: "string" },
              },
            ],
            get: {
              operationId: "getKey",
              summary: "Get key",
              responses: { "200": { description: "OK" }, "404": { description: "Not found" } },
            },
          },
          "/v1/tokens/{tokenID}": {
            parameters: [
              {
                name: "tokenID",
                in: "path",
                required: true,
                description: "Uppercase ID",
                schema: { type: "string" },
              },
            ],
            get: {
              operationId: "getToken",
              summary: "Get token",
              responses: { "200": { description: "OK" }, "404": { description: "Not found" } },
            },
          },
        },
        components: {
          pathItems: {
            SharedProjectPath: {
              parameters: [
                {
                  name: "id",
                  in: "path",
                  required: true,
                  description: "Generic id",
                  schema: { type: "string" },
                },
              ],
              get: {
                operationId: "getProject",
                summary: "Get project",
                responses: { "200": { description: "OK" }, "404": { description: "Not found" } },
              },
            },
          },
          parameters: {
            BadReusablePathParam: {
              name: "guid",
              in: "path",
              required: true,
              description: "Reusable bad path param",
              schema: { type: "string" },
            },
            AllowedQueryIdParam: {
              name: "id",
              in: "query",
              description: "Query params are not path params",
              schema: { type: "string" },
            },
          },
        },
      }),
    );

    expect(exitCode).toBe(1);
    const namingErrors = adsProblems(report).filter(
      (problem) => problem.ruleId === "photon-ads/ads-0001-path-param-naming",
    );
    const messages = namingErrors.map((problem) => problem.message);
    expect(messages.some((msg) => msg.includes("{id}"))).toBe(true);
    expect(messages.some((msg) => msg.includes("{uuid}"))).toBe(true);
    expect(messages.some((msg) => msg.includes("{invoice_id}"))).toBe(true);
    expect(messages.some((msg) => msg.includes("{customer-id}"))).toBe(true);
    expect(messages.some((msg) => msg.includes("{ApiKeyId}"))).toBe(true);
    expect(messages.some((msg) => msg.includes("{tokenID}"))).toBe(true);
    expect(messages.some((msg) => msg.includes("{guid}"))).toBe(true);

    // Confirm $ref PathItem reports the template violation at the route declaration key.
    expect(
      namingErrors.some((problem) =>
        problem.location?.some((loc) => loc.pointer === "#/paths/~1v1~1projects~1{id}"),
      ),
    ).toBe(true);

    expect(
      namingErrors.some((problem) =>
        problem.location?.some((loc) => loc.pointer?.includes("AllowedQueryIdParam")),
      ),
    ).toBe(false);
  });

  it("rejects inconsistent path parameter names across routes sharing a parent prefix", async () => {
    const { exitCode, report } = await lintOpenApi(
      baseOpenApi({
        paths: {
          "/v1/projects/{projectId}": {
            parameters: [
              {
                name: "projectId",
                in: "path",
                required: true,
                description: "Project ID",
                schema: { type: "string" },
              },
            ],
            get: {
              operationId: "getProject",
              summary: "Get project",
              responses: { "200": { description: "OK" }, "404": { description: "Not found" } },
            },
          },
          "/v1/projects/{id}/messages": {
            parameters: [
              {
                name: "id",
                in: "path",
                required: true,
                description: "Project ID",
                schema: { type: "string" },
              },
            ],
            get: {
              operationId: "listProjectMessages",
              summary: "List project messages",
              responses: { "200": { description: "OK" }, "404": { description: "Not found" } },
            },
          },
          "/v1/organizations/{orgId}": {
            parameters: [
              {
                name: "orgId",
                in: "path",
                required: true,
                description: "Org ID",
                schema: { type: "string" },
              },
            ],
            get: {
              operationId: "getOrg",
              summary: "Get org",
              responses: { "200": { description: "OK" }, "404": { description: "Not found" } },
            },
          },
          "/v1/organizations/{organizationId}/members": {
            parameters: [
              {
                name: "organizationId",
                in: "path",
                required: true,
                description: "Organization ID",
                schema: { type: "string" },
              },
            ],
            get: {
              operationId: "listOrgMembers",
              summary: "List org members",
              responses: { "200": { description: "OK" }, "404": { description: "Not found" } },
            },
          },
          "/v1/projects/{projectId}/api-keys/{apiKeyId}": {
            parameters: [
              {
                name: "projectId",
                in: "path",
                required: true,
                description: "Project ID",
                schema: { type: "string" },
              },
              {
                name: "apiKeyId",
                in: "path",
                required: true,
                description: "API Key ID",
                schema: { type: "string" },
              },
            ],
            get: {
              operationId: "getApiKey",
              summary: "Get API key",
              responses: { "200": { description: "OK" }, "404": { description: "Not found" } },
            },
          },
          "/v1/projects/{projectId}/api-keys/{keyId}/rotate": {
            parameters: [
              {
                name: "projectId",
                in: "path",
                required: true,
                description: "Project ID",
                schema: { type: "string" },
              },
              {
                name: "keyId",
                in: "path",
                required: true,
                description: "Key ID",
                schema: { type: "string" },
              },
            ],
            post: {
              operationId: "rotateApiKey",
              summary: "Rotate API key",
              responses: { "200": { description: "OK" }, "404": { description: "Not found" } },
            },
          },
        },
      }),
    );

    expect(exitCode).toBe(1);
    const consistencyErrors = adsProblems(report).filter(
      (problem) => problem.ruleId === "photon-ads/ads-0001-path-param-consistency",
    );
    expect(consistencyErrors).toHaveLength(3);
    expect(
      consistencyErrors.some(
        (problem) =>
          problem.message.includes("/v1/projects/{*}") &&
          problem.message.includes("{projectId}") &&
          problem.message.includes("{id}"),
      ),
    ).toBe(true);
    expect(
      consistencyErrors.some(
        (problem) =>
          problem.message.includes("/v1/organizations/{*}") &&
          problem.message.includes("{orgId}") &&
          problem.message.includes("{organizationId}"),
      ),
    ).toBe(true);
    expect(
      consistencyErrors.some(
        (problem) =>
          problem.message.includes("/v1/projects/{*}/api-keys/{*}") &&
          problem.message.includes("{apiKeyId}") &&
          problem.message.includes("{keyId}"),
      ),
    ).toBe(true);
  });

  it("rejects resource-prefixed primary IDs across named schemas, allOf, $ref chains, oneOf/anyOf variants, 2XX responses, envelopes, and bad ID casing", async () => {
    const { exitCode, report } = await lintOpenApi(
      baseOpenApi({
        paths: {
          "/v1/projects/{projectId}": {
            parameters: [
              {
                name: "projectId",
                in: "path",
                required: true,
                description: "Project ID",
                schema: { type: "string" },
              },
            ],
            get: {
              operationId: "getProject",
              summary: "Get project",
              responses: {
                "200": {
                  description: "OK",
                  content: {
                    "application/json": {
                      schema: { $ref: "#/components/schemas/Project" },
                    },
                  },
                },
                "404": { description: "Not found" },
              },
            },
          },
          "/v1/projects/{projectId}/api-keys/{apiKeyId}": {
            parameters: [
              {
                name: "projectId",
                in: "path",
                required: true,
                description: "Project ID",
                schema: { type: "string" },
              },
              {
                name: "apiKeyId",
                in: "path",
                required: true,
                description: "API Key ID",
                schema: { type: "string" },
              },
            ],
            get: {
              operationId: "getApiKey",
              summary: "Get API key via 2XX fallback",
              responses: {
                "2XX": {
                  description: "OK",
                  content: {
                    "application/json": {
                      schema: {
                        type: "object",
                        properties: {
                          apiKeyId: { type: "string" },
                          projectId: { type: "string" },
                        },
                      },
                    },
                  },
                },
                "404": { description: "Not found" },
              },
            },
          },
          "/v1/invoices/{invoiceId}": {
            parameters: [
              {
                name: "invoiceId",
                in: "path",
                required: true,
                description: "Invoice ID",
                schema: { type: "string" },
              },
            ],
            get: {
              operationId: "getInvoice",
              summary: "Get invoice wrapped in envelope",
              responses: {
                "200": {
                  description: "OK",
                  content: {
                    "application/json": {
                      schema: {
                        type: "object",
                        properties: {
                          invoice: {
                            type: "object",
                            properties: {
                              invoiceId: { type: "string" },
                              amountCents: { type: "integer" },
                            },
                          },
                        },
                      },
                    },
                  },
                },
                "404": { description: "Not found" },
              },
            },
          },
          "/v1/organizations/{organizationId}": {
            parameters: [
              {
                name: "organizationId",
                in: "path",
                required: true,
                description: "Organization ID",
                schema: { type: "string" },
              },
            ],
            get: {
              operationId: "getOrganization",
              summary: "Get organization with multi-variant oneOf",
              responses: {
                "200": {
                  description: "OK",
                  content: {
                    "application/json": {
                      schema: {
                        oneOf: [
                          {
                            type: "object",
                            properties: {
                              id: { type: "string" },
                              kind: { type: "string" },
                            },
                          },
                          {
                            type: "object",
                            properties: {
                              organizationId: { type: "string" },
                              name: { type: "string" },
                            },
                          },
                        ],
                      },
                    },
                  },
                },
                "404": { description: "Not found" },
              },
            },
          },
          "/v1/workspaces/{workspaceId}": {
            parameters: [
              {
                name: "workspaceId",
                in: "path",
                required: true,
                description: "Workspace ID",
                schema: { type: "string" },
              },
            ],
            get: {
              operationId: "getWorkspace",
              summary: "Get workspace through chained $ref with sibling properties",
              responses: {
                "200": {
                  description: "OK",
                  content: {
                    "application/json": {
                      schema: { $ref: "#/components/schemas/WorkspaceShape" },
                    },
                  },
                },
                "404": { description: "Not found" },
              },
            },
          },
        },
        components: {
          schemas: {
            Timestamped: {
              type: "object",
              properties: {
                createdAt: { type: "string" },
              },
            },
            WorkspaceShape: {
              $ref: "#/components/schemas/Timestamped",
              properties: {
                workspaceId: { type: "string" },
              },
            },
            Project: {
              allOf: [
                { $ref: "#/components/schemas/Timestamped" },
                {
                  type: "object",
                  properties: {
                    projectId: { type: "string" },
                    name: { type: "string" },
                  },
                },
              ],
            },
            WebhookSubscriptionResource: {
              type: "object",
              properties: {
                webhookSubscriptionId: { type: "string" },
                url: { type: "string" },
              },
            },
            BadCasingPayload: {
              type: "object",
              properties: {
                ID: { type: "string" },
                Id: { type: "string" },
                project_id: { type: "string" },
                organizationID: { type: "string" },
              },
            },
          },
        },
      }),
    );

    expect(exitCode).toBe(1);
    const primaryIdErrors = adsProblems(report).filter(
      (problem) => problem.ruleId === "photon-ads/ads-0001-resource-primary-id",
    );
    const messages = primaryIdErrors.map((problem) => problem.message);

    // Named schemas (including allOf and Resource suffix)
    expect(messages.some((msg) => msg.includes('"Project"') && msg.includes('"projectId"'))).toBe(
      true,
    );
    expect(
      messages.some(
        (msg) =>
          msg.includes('"WebhookSubscriptionResource"') && msg.includes('"webhookSubscriptionId"'),
      ),
    ).toBe(true);

    // 2XX fallback GET item response, envelope-wrapped GET item response, multi-variant oneOf, intermediate $ref chain
    expect(
      messages.some(
        (msg) =>
          msg.includes("/v1/projects/{projectId}/api-keys/{apiKeyId}") &&
          msg.includes('"apiKeyId"'),
      ),
    ).toBe(true);
    expect(
      messages.some(
        (msg) =>
          msg.includes("/v1/invoices/{invoiceId}") &&
          msg.includes('wrapped resource "invoice"') &&
          msg.includes('"invoiceId"'),
      ),
    ).toBe(true);
    expect(
      messages.some(
        (msg) =>
          msg.includes("/v1/organizations/{organizationId}") && msg.includes('"organizationId"'),
      ),
    ).toBe(true);
    expect(
      messages.some(
        (msg) => msg.includes("/v1/workspaces/{workspaceId}") && msg.includes('"workspaceId"'),
      ),
    ).toBe(true);

    // Malformed ID property casing
    expect(messages.some((msg) => msg.includes('Property "ID"'))).toBe(true);
    expect(messages.some((msg) => msg.includes('Property "Id"'))).toBe(true);
    expect(messages.some((msg) => msg.includes('Property "project_id"'))).toBe(true);
    expect(messages.some((msg) => msg.includes('Property "organizationID"'))).toBe(true);

    // Project was reported once at components.schemas.Project, not duplicated by GET /v1/projects/{projectId}
    const projectReports = primaryIdErrors.filter((problem) =>
      problem.location?.some(
        (loc) => loc.pointer === "#/components/schemas/Project/allOf/1/properties/projectId",
      ),
    );
    expect(projectReports).toHaveLength(1);
  });
});
