import { execFileSync, spawnSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { stringify as stringifyYaml } from "yaml";
import {
  ADS_0004_METADATA,
  CANONICAL_OPERATION_STATUSES,
  extractOperationCancelParam,
  extractOperationItemParam,
  isCanonicalOperationStatus,
  isOperationDeletePath,
  isOperationSchemaName,
  isSensitiveCredentialKey,
  isSnakeCaseActionType,
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
      description: "Test specification for ADS-0004.",
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

function ads0004Problems(report: RedoclyJsonReport): RedoclyJsonProblem[] {
  return report.problems.filter((problem) => problem.ruleId.startsWith("photon-ads/ads-0004-"));
}

function problemDetailsSchema(): Record<string, unknown> {
  return {
    type: "object",
    required: ["type", "title", "status", "code"],
    properties: {
      type: { type: "string", format: "uri" },
      title: { type: "string" },
      status: { type: "integer" },
      code: { type: "string" },
      detail: { type: "string" },
      retryable: { type: "boolean" },
    },
  };
}

function canonicalOperationBranch(
  status: string | readonly string[],
  overrides: {
    completedAt: Record<string, unknown>;
    response: Record<string, unknown>;
    error: Record<string, unknown>;
    nextAction?: Record<string, unknown>;
    extraRequired?: readonly string[];
    extraProperties?: Record<string, unknown>;
  },
): Record<string, unknown> {
  return {
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
      ...(overrides.extraRequired ?? []),
    ],
    properties: {
      id: { type: "string" },
      type: { type: "string", enum: ["plan.change"] },
      status:
        typeof status === "string"
          ? { type: "string", const: status }
          : { type: "string", enum: [...status] },
      createdAt: { type: "string", format: "date-time" },
      updatedAt: { type: "string", format: "date-time" },
      completedAt: overrides.completedAt,
      response: overrides.response,
      error: overrides.error,
      ...(overrides.nextAction ? { nextAction: overrides.nextAction } : {}),
      ...(overrides.extraProperties ?? {}),
    },
  };
}

function canonicalValidOperationUnion(): Record<string, unknown> {
  return {
    oneOf: [
      { $ref: "#/components/schemas/PendingOperation" },
      { $ref: "#/components/schemas/RunningOperation" },
      { $ref: "#/components/schemas/RequiresActionOperation" },
      { $ref: "#/components/schemas/SucceededOperation" },
      { $ref: "#/components/schemas/FailedOperation" },
      { $ref: "#/components/schemas/CancelledOperation" },
    ],
  };
}

function canonicalValidOperationComponents(): Record<string, unknown> {
  return {
    ProblemDetails: problemDetailsSchema(),
    PlanOutcome: {
      type: "object",
      required: ["id", "projectId", "plan"],
      properties: {
        id: { type: "string" },
        projectId: { type: "string" },
        plan: { type: "string" },
      },
    },
    RedirectNextAction: {
      type: "object",
      required: ["type", "url"],
      properties: {
        type: { type: "string", const: "redirect" },
        url: { type: "string", format: "uri" },
        expiresAt: { type: ["string", "null"], format: "date-time" },
      },
    },
    ConfirmPaymentNextAction: {
      type: "object",
      required: ["type", "invoiceId"],
      properties: {
        type: { type: "string", const: "confirm_payment" },
        invoiceId: { type: "string" },
        expiresAt: { type: ["string", "null"], format: "date-time" },
      },
    },
    PendingOperation: canonicalOperationBranch("pending", {
      completedAt: { type: "null" },
      response: { type: "null" },
      error: { type: "null" },
      nextAction: { type: "null" },
      extraProperties: {
        startedAt: { type: "null" },
        cancellable: { type: "boolean" },
        metadata: { type: "object", properties: { projectId: { type: "string" } } },
      },
    }),
    RunningOperation: canonicalOperationBranch("running", {
      completedAt: { type: "null" },
      response: { type: "null" },
      error: { type: "null" },
      nextAction: { type: "null" },
      extraProperties: {
        startedAt: { type: "string", format: "date-time" },
        cancellable: { type: "boolean" },
      },
    }),
    RequiresActionOperation: canonicalOperationBranch("requires_action", {
      completedAt: { type: "null" },
      response: { type: "null" },
      error: { type: "null" },
      extraRequired: ["nextAction"],
      nextAction: {
        oneOf: [
          { $ref: "#/components/schemas/RedirectNextAction" },
          { $ref: "#/components/schemas/ConfirmPaymentNextAction" },
        ],
      },
      extraProperties: {
        cancellable: { type: "boolean" },
      },
    }),
    SucceededOperation: canonicalOperationBranch("succeeded", {
      completedAt: { type: "string", format: "date-time" },
      response: { $ref: "#/components/schemas/PlanOutcome" },
      error: { type: "null" },
      nextAction: { type: "null" },
      extraProperties: {
        cancellable: { type: "boolean" },
      },
    }),
    FailedOperation: canonicalOperationBranch("failed", {
      completedAt: { type: "string", format: "date-time" },
      response: { type: "null" },
      error: { $ref: "#/components/schemas/ProblemDetails" },
      nextAction: { type: "null" },
      extraProperties: {
        cancellable: { type: "boolean" },
      },
    }),
    CancelledOperation: canonicalOperationBranch("cancelled", {
      completedAt: { type: "string", format: "date-time" },
      response: { type: "null" },
      error: { type: "null" },
      nextAction: { type: "null" },
      extraProperties: {
        cancellable: { type: "boolean" },
      },
    }),
    PlanChangeOperation: canonicalValidOperationUnion(),
  };
}

beforeAll(async () => {
  tempDir = await mkdtemp(join(tmpdir(), "photon-ads-0004-"));
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

describe("ADS-0004 unit helpers", () => {
  it("exports metadata with four error-level rules", () => {
    expect(ADS_0004_METADATA.ads).toBe("0004");
    expect(ADS_0004_METADATA.slug).toBe("ads-0004");
    expect(ADS_0004_METADATA.folder).toBe("0004-long-running-operations");
    expect(ADS_0004_METADATA.rules.map((rule) => rule.id)).toEqual([
      "photon-ads/ads-0004-operation-resource-shape",
      "photon-ads/ads-0004-operation-status-invariants",
      "photon-ads/ads-0004-accepted-operation-headers",
      "photon-ads/ads-0004-operation-cancel-method",
    ]);
    expect(ADS_0004_METADATA.rules.every((rule) => rule.severity === "error")).toBe(true);
  });

  it("validates canonical operation statuses and snake_case nextAction types", () => {
    for (const status of CANONICAL_OPERATION_STATUSES) {
      expect(isCanonicalOperationStatus(status)).toBe(true);
    }
    for (const bad of [
      "queued",
      "in_progress",
      "processing",
      "done",
      "completed",
      "canceled",
      "PENDING",
    ]) {
      expect(isCanonicalOperationStatus(bad)).toBe(false);
    }

    expect(isSnakeCaseActionType("redirect")).toBe(true);
    expect(isSnakeCaseActionType("confirm_payment")).toBe(true);
    expect(isSnakeCaseActionType("verify_dns")).toBe(true);
    expect(isSnakeCaseActionType("verify_2fa_code")).toBe(true);
    expect(isSnakeCaseActionType("Redirect")).toBe(false);
    expect(isSnakeCaseActionType("confirmPayment")).toBe(false);
    expect(isSnakeCaseActionType("confirm-payment")).toBe(false);
    expect(isSnakeCaseActionType("CONFIRM_PAYMENT")).toBe(false);
    expect(isSnakeCaseActionType("_leading")).toBe(false);
    expect(isSnakeCaseActionType("trailing_")).toBe(false);
  });

  it("classifies sensitive credential keys tightly without false positives on safe identifiers", () => {
    for (const bad of [
      "clientSecret",
      "client_secret",
      "CLIENT_SECRET",
      "accessToken",
      "access_token",
      "refreshToken",
      "idToken",
      "sessionToken",
      "password",
      "userPassword",
      "apiKey",
      "api_key",
      "providerApiKey",
      "secret",
      "signingSecret",
      "privateKey",
      "private_key",
      "token",
    ]) {
      expect(isSensitiveCredentialKey(bad), `expected ${bad} to be flagged`).toBe(true);
    }

    for (const safe of [
      "type",
      "url",
      "expiresAt",
      "invoiceId",
      "apiKeyId",
      "tokenId",
      "secretId",
      "nextPageToken",
      "pageToken",
      "continuation_token",
      "publicKey",
      "records",
      "tokenType",
      "notatoken",
    ]) {
      expect(isSensitiveCredentialKey(safe), `expected ${safe} to be allowed`).toBe(false);
    }
  });

  it("recognizes operation paths and component schema names", () => {
    expect(extractOperationItemParam("/v1/projects/{projectId}/operations/{operationId}")).toBe(
      "operationId",
    );
    expect(extractOperationItemParam("/v1/operations/{opId}/")).toBe("opId");
    expect(extractOperationItemParam("/v1/projects/{projectId}/operations")).toBeNull();
    expect(
      extractOperationItemParam("/v1/projects/{projectId}/operations/{operationId}/cancel"),
    ).toBeNull();

    expect(
      extractOperationCancelParam("/v1/projects/{projectId}/operations/{operationId}/cancel"),
    ).toBe("operationId");
    expect(
      extractOperationCancelParam("/v1/projects/{projectId}/operations/{operationId}"),
    ).toBeNull();

    expect(isOperationDeletePath("/v1/projects/{projectId}/operations/{operationId}")).toBe(true);
    expect(isOperationDeletePath("/v1/projects/{projectId}/operations/{operationId}/cancel")).toBe(
      true,
    );
    expect(isOperationDeletePath("/v1/projects/{projectId}/operations")).toBe(false);

    expect(isOperationSchemaName("Operation")).toBe(true);
    expect(isOperationSchemaName("PlanChangeOperation")).toBe(true);
    expect(isOperationSchemaName("OperationResponse")).toBe(true);
    expect(isOperationSchemaName("OperationStatus")).toBe(true);
    expect(isOperationSchemaName("Legacy-Operation")).toBe(true);
    expect(isOperationSchemaName("v1.PlanChangeOperation")).toBe(true);
    expect(isOperationSchemaName("plan_change_operation")).toBe(true);
    expect(isOperationSchemaName("plan-change-operation")).toBe(true);
    expect(isOperationSchemaName("OperationListResponse")).toBe(false);
    expect(isOperationSchemaName("Cooperation")).toBe(false);
    expect(isOperationSchemaName("cooperation")).toBe(false);
    expect(isOperationSchemaName("Project")).toBe(false);
  });
});

describe("ADS-0004 Redocly end-to-end rules", () => {
  it("passes the repository valid OpenAPI fixture with zero errors", () => {
    const { exitCode, report } = runRedoclyLint(VALID_FIXTURE);
    expect(exitCode).toBe(0);
    expect(report.totals.errors).toBe(0);
    expect(ads0004Problems(report)).toEqual([]);
  });

  it("passes full 6-state unions, minimal subsets, allOf+oneOf narrowing, empty succeeded outcomes, and OAS 3.0 nullable idioms", async () => {
    const doc = baseOpenApi({
      paths: {
        "/v1/projects/{projectId}/plan-changes": {
          parameters: [
            { name: "projectId", in: "path", required: true, schema: { type: "string" } },
          ],
          post: {
            operationId: "startPlanChange",
            summary: "Start plan change",
            responses: {
              "202": {
                description: "Accepted",
                headers: {
                  location: {
                    description: "Case-insensitive Location header",
                    schema: { type: "string", format: "uri" },
                  },
                  "Retry-After": {
                    description: "Polling delay",
                    schema: { type: "integer" },
                  },
                },
                content: {
                  "application/json": {
                    schema: { $ref: "#/components/schemas/PlanChangeOperation" },
                  },
                },
              },
              "200": {
                description: "Idempotent terminal replay",
                content: {
                  "application/json": {
                    schema: { $ref: "#/components/schemas/SucceededOperation" },
                  },
                },
              },
              "400": {
                description: "Invalid request",
                content: {
                  "application/problem+json": {
                    schema: { $ref: "#/components/schemas/ProblemDetails" },
                  },
                },
              },
            },
          },
        },
        "/v1/projects/{projectId}/operations/{operationId}": {
          parameters: [
            { name: "projectId", in: "path", required: true, schema: { type: "string" } },
            { name: "operationId", in: "path", required: true, schema: { type: "string" } },
          ],
          get: {
            operationId: "getOperation",
            summary: "Get operation",
            responses: {
              "200": {
                description: "Operation status",
                content: {
                  "application/json": {
                    schema: { $ref: "#/components/schemas/PlanChangeOperation" },
                  },
                },
              },
              "404": { description: "Not found" },
            },
          },
        },
        "/v1/projects/{projectId}/operations/{operationId}/cancel": {
          parameters: [
            { name: "projectId", in: "path", required: true, schema: { type: "string" } },
            { name: "operationId", in: "path", required: true, schema: { type: "string" } },
          ],
          post: {
            operationId: "cancelOperation",
            summary: "Cancel operation",
            responses: {
              "200": {
                description: "Updated operation",
                content: {
                  "application/json": {
                    schema: { $ref: "#/components/schemas/PlanChangeOperation" },
                  },
                },
              },
              "409": { description: "Not cancellable" },
            },
          },
        },
        "/v1/organizations/{organizationId}/exports": {
          parameters: [
            { name: "organizationId", in: "path", required: true, schema: { type: "string" } },
          ],
          post: {
            operationId: "startMinimalSubsetOp",
            summary: "Start minimal 3-state operation omitting running/requires_action/cancelled",
            responses: {
              "202": {
                $ref: "#/components/responses/MinimalAcceptedOperation",
              },
              "400": { description: "Bad request" },
            },
          },
        },
        "/v1/organizations/{organizationId}/deletions/operations/{operationId}": {
          parameters: [
            { name: "organizationId", in: "path", required: true, schema: { type: "string" } },
            { name: "operationId", in: "path", required: true, schema: { type: "string" } },
          ],
          get: {
            operationId: "getDeletionOperation",
            summary:
              "Get deletion operation with allOf + oneOf base narrowing and empty succeeded outcome",
            responses: {
              "200": {
                description: "Deletion operation",
                content: {
                  "application/json": {
                    schema: { $ref: "#/components/schemas/DeletionOperation" },
                  },
                },
              },
              "404": { description: "Not found" },
            },
          },
        },
      },
      components: {
        headers: {
          OperationLocation: {
            description: "Poll URL",
            schema: { type: "string", format: "uri" },
          },
        },
        responses: {
          MinimalAcceptedOperation: {
            description: "Accepted minimal operation",
            headers: {
              Location: { $ref: "#/components/headers/OperationLocation" },
            },
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/MinimalOperation" },
              },
            },
          },
        },
        schemas: {
          ...canonicalValidOperationComponents(),
          MinimalOperation: {
            oneOf: [
              canonicalOperationBranch("pending", {
                completedAt: { type: "null" },
                response: { type: "null" },
                error: { type: "null" },
              }),
              canonicalOperationBranch("succeeded", {
                completedAt: { type: "string", format: "date-time" },
                response: { type: "null" },
                error: { type: "null" },
              }),
              canonicalOperationBranch("failed", {
                completedAt: { type: "string", format: "date-time" },
                response: { type: "null" },
                error: { $ref: "#/components/schemas/ProblemDetails" },
              }),
            ],
          },
          DeletionOperationBase: {
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
              id: { type: "string" },
              type: { type: "string", const: "organization.delete" },
              status: {
                type: "string",
                enum: ["pending", "running", "succeeded", "failed", "cancelled"],
              },
              createdAt: { type: "string", format: "date-time" },
              updatedAt: { type: "string", format: "date-time" },
              completedAt: { type: ["string", "null"], format: "date-time" },
              response: { type: "null" },
              error: {
                anyOf: [{ $ref: "#/components/schemas/ProblemDetails" }, { type: "null" }],
              },
            },
          },
          DeletionOperation: {
            allOf: [
              { $ref: "#/components/schemas/DeletionOperationBase" },
              {
                oneOf: [
                  {
                    type: "object",
                    properties: {
                      status: { type: "string", enum: ["pending", "running"] },
                      completedAt: { type: "null" },
                      error: { type: "null" },
                    },
                  },
                  {
                    type: "object",
                    properties: {
                      status: { type: "string", enum: ["succeeded", "cancelled"] },
                      completedAt: { type: "string" },
                      error: { type: "null" },
                    },
                  },
                  {
                    type: "object",
                    properties: {
                      status: { type: "string", const: "failed" },
                      completedAt: { type: "string" },
                      error: { $ref: "#/components/schemas/ProblemDetails" },
                    },
                  },
                ],
              },
            ],
          },
        },
      },
    });

    const { exitCode, report } = await lintOpenApi(doc);
    expect(ads0004Problems(report)).toEqual([]);
    expect(exitCode).toBe(0);
  });

  it("supports OpenAPI 3.0 nullable: true + enum: [null] operation schemas", async () => {
    const doc = baseOpenApi({
      openapi: "3.0.3",
      paths: {
        "/v1/projects/{projectId}/operations/{operationId}": {
          parameters: [
            { name: "projectId", in: "path", required: true, schema: { type: "string" } },
            { name: "operationId", in: "path", required: true, schema: { type: "string" } },
          ],
          get: {
            operationId: "getOas30Operation",
            summary: "Get OAS 3.0 operation",
            responses: {
              "200": {
                description: "Operation",
                content: {
                  "application/json": {
                    schema: {
                      oneOf: [
                        {
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
                            id: { type: "string" },
                            type: { type: "string", enum: ["domain.verify"] },
                            status: { type: "string", enum: ["pending"] },
                            createdAt: { type: "string", format: "date-time" },
                            updatedAt: { type: "string", format: "date-time" },
                            completedAt: {
                              type: "string",
                              format: "date-time",
                              nullable: true,
                              enum: [null],
                            },
                            response: { type: "object", nullable: true, enum: [null] },
                            error: { type: "object", nullable: true, enum: [null] },
                          },
                        },
                        {
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
                            id: { type: "string" },
                            type: { type: "string", enum: ["domain.verify"] },
                            status: { type: "string", enum: ["failed"] },
                            createdAt: { type: "string", format: "date-time" },
                            updatedAt: { type: "string", format: "date-time" },
                            completedAt: { type: "string", format: "date-time" },
                            response: { type: "object", nullable: true, enum: [null] },
                            error: { $ref: "#/components/schemas/ProblemDetails" },
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
      },
      components: {
        schemas: {
          ProblemDetails: problemDetailsSchema(),
        },
      },
    });

    const { exitCode, report } = await lintOpenApi(doc);
    expect(ads0004Problems(report)).toEqual([]);
    expect(exitCode).toBe(0);
  });

  it("does not false-positive on lifecycle-bearing resources, fire-and-forget 202 endpoints, or multi-entity composites", async () => {
    const doc = baseOpenApi({
      paths: {
        "/v1/organizations/{organizationId}/projects": {
          parameters: [
            { name: "organizationId", in: "path", required: true, schema: { type: "string" } },
          ],
          post: {
            operationId: "createProject",
            summary: "Create a lifecycle-bearing project resource",
            responses: {
              "202": {
                description: "Project provisioning",
                headers: {
                  Location: { schema: { type: "string", format: "uri" } },
                },
                content: {
                  "application/json": {
                    schema: { $ref: "#/components/schemas/Project" },
                  },
                },
              },
              "400": { description: "Bad request" },
            },
          },
        },
        "/v1/projects/{projectId}/domains": {
          parameters: [
            { name: "projectId", in: "path", required: true, schema: { type: "string" } },
          ],
          post: {
            operationId: "createDomain",
            summary: "Create a lifecycle-bearing domain referencing an operationId foreign key",
            responses: {
              "202": {
                description: "Domain awaiting verification",
                content: {
                  "application/json": {
                    schema: { $ref: "#/components/schemas/Domain" },
                  },
                },
              },
              "400": { description: "Bad request" },
            },
          },
        },
        "/v1/projects/{projectId}/messages": {
          parameters: [
            { name: "projectId", in: "path", required: true, schema: { type: "string" } },
          ],
          post: {
            operationId: "sendMessage",
            summary: "Fire-and-forget message send without Location",
            responses: {
              "202": {
                description: "Queued message",
                content: {
                  "application/json": {
                    schema: {
                      type: "object",
                      required: ["id", "projectId", "type", "status", "createdAt"],
                      properties: {
                        id: { type: "string" },
                        projectId: { type: "string" },
                        type: { type: "string", enum: ["text"] },
                        status: { type: "string", enum: ["queued"] },
                        createdAt: { type: "string", format: "date-time" },
                      },
                    },
                  },
                },
              },
              "400": { description: "Bad request" },
            },
          },
        },
        "/v1/projects/{projectId}/typing": {
          parameters: [
            { name: "projectId", in: "path", required: true, schema: { type: "string" } },
          ],
          post: {
            operationId: "sendTypingIndicator",
            summary: "Fire-and-forget ephemeral signal",
            responses: {
              "202": {
                description: "Accepted",
                content: {
                  "application/json": {
                    schema: {
                      type: "object",
                      required: ["accepted"],
                      properties: {
                        accepted: { type: "boolean" },
                      },
                    },
                  },
                },
              },
              "400": { description: "Bad request" },
            },
          },
        },
        "/v1/projects/{projectId}/exports": {
          parameters: [
            { name: "projectId", in: "path", required: true, schema: { type: "string" } },
          ],
          post: {
            operationId: "createCompositeExport",
            summary: "Multi-entity composite response allowed by ADS-0002",
            responses: {
              "202": {
                description: "Composite response",
                content: {
                  "application/json": {
                    schema: {
                      type: "object",
                      required: ["operation", "resource"],
                      properties: {
                        operation: {
                          type: "object",
                          required: ["id", "status"],
                          properties: {
                            id: { type: "string" },
                            status: { type: "string" },
                          },
                        },
                        resource: { $ref: "#/components/schemas/Project" },
                      },
                    },
                  },
                },
              },
              "400": { description: "Bad request" },
            },
          },
        },
      },
      components: {
        schemas: {
          Project: {
            type: "object",
            required: ["id", "organizationId", "name", "status", "createdAt", "updatedAt"],
            properties: {
              id: { type: "string" },
              organizationId: { type: "string" },
              name: { type: "string" },
              status: { type: "string", enum: ["provisioning", "active"] },
              createdAt: { type: "string", format: "date-time" },
              updatedAt: { type: "string", format: "date-time" },
            },
          },
          Domain: {
            type: "object",
            required: ["id", "projectId", "hostname", "status", "operationId", "createdAt"],
            properties: {
              id: { type: "string" },
              projectId: { type: "string" },
              hostname: { type: "string" },
              status: { type: "string", enum: ["pending_verification", "verified"] },
              operationId: { type: "string" },
              createdAt: { type: "string", format: "date-time" },
            },
          },
        },
      },
    });

    const { exitCode, report } = await lintOpenApi(doc);
    expect(ads0004Problems(report)).toEqual([]);
    expect(exitCode).toBe(0);
  });

  it("enforces ads-0004-operation-resource-shape for wrappers, synonyms, status vocabulary, required fields, timestamps, error shape, and path params", async () => {
    const doc = baseOpenApi({
      paths: {
        "/v1/projects/{projectId}/wrapped-op": {
          parameters: [
            { name: "projectId", in: "path", required: true, schema: { type: "string" } },
          ],
          post: {
            operationId: "startWrappedOperation",
            summary: "Returns wrapped operation",
            responses: {
              "202": {
                description: "Wrapped",
                headers: { Location: { schema: { type: "string", format: "uri" } } },
                content: {
                  "application/json": {
                    schema: {
                      type: "object",
                      required: ["operation"],
                      properties: {
                        operation: canonicalOperationBranch("pending", {
                          completedAt: { type: "null" },
                          response: { type: "null" },
                          error: { type: "null" },
                        }),
                      },
                    },
                  },
                },
              },
              "400": { description: "Bad request" },
            },
          },
        },
        "/v1/projects/{projectId}/operations/{opId}": {
          parameters: [
            { name: "projectId", in: "path", required: true, schema: { type: "string" } },
            { name: "opId", in: "path", required: true, schema: { type: "string" } },
          ],
          get: {
            operationId: "getSynonymOperation",
            summary: "Uses non-canonical path param and field synonyms",
            responses: {
              "200": {
                description: "Non-canonical operation",
                content: {
                  "application/json": {
                    schema: {
                      type: "object",
                      required: [
                        "operationId",
                        "kind",
                        "state",
                        "submittedAt",
                        "updatedAt",
                        "resolvedAt",
                        "result",
                        "failure",
                      ],
                      properties: {
                        operationId: { type: "string" },
                        kind: { type: "string", const: "plan.change" },
                        state: { type: "string", const: "in_progress" },
                        submittedAt: { type: "string", format: "date-time" },
                        updatedAt: { type: "string" },
                        resolvedAt: { type: "null" },
                        result: { type: "null" },
                        failure: { type: "null" },
                      },
                    },
                  },
                },
              },
              "404": { description: "Not found" },
            },
          },
        },
        "/v1/organizations/{organizationId}/operations/{operationId}": {
          parameters: [
            { name: "organizationId", in: "path", required: true, schema: { type: "string" } },
            { name: "operationId", in: "path", required: true, schema: { type: "string" } },
          ],
          get: {
            operationId: "getBadStatusAndErrorOperation",
            summary:
              "Has bad statuses, missing required fields, bad timestamps, bad cancellable, and bad error",
            responses: {
              "200": {
                description: "Bad operation",
                content: {
                  "application/json": {
                    schema: {
                      oneOf: [
                        {
                          type: "object",
                          required: ["id", "type", "status", "createdAt", "updatedAt"],
                          properties: {
                            id: { type: "string" },
                            type: { type: "string", const: "domain.verify" },
                            status: {
                              type: "string",
                              enum: [
                                "queued",
                                "in_progress",
                                "processing",
                                "done",
                                "completed",
                                "canceled",
                              ],
                            },
                            createdAt: { type: "string" },
                            updatedAt: { type: "string", format: "date-time" },
                            completedAt: { type: "string" },
                            startedAt: { type: "string" },
                            cancellable: { type: "string" },
                            endedAt: { type: "null" },
                            response: { type: "null" },
                            error: {
                              type: "object",
                              required: ["type", "title"],
                              properties: {
                                type: { type: "string" },
                                title: { type: "string" },
                                status: { type: "string" },
                              },
                            },
                          },
                        },
                        {
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
                            id: { type: "string" },
                            type: { type: "string", const: "domain.verify" },
                            status: { type: "string" },
                            createdAt: { type: "string", format: "date-time" },
                            updatedAt: { type: "string", format: "date-time" },
                            completedAt: { type: "string", format: "date-time" },
                            response: { type: "null" },
                            error: { type: "string" },
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
      },
    });

    const { exitCode, report } = await lintOpenApi(doc);
    expect(exitCode).toBe(1);
    const shapeErrors = ads0004Problems(report).filter(
      (problem) => problem.ruleId === "photon-ads/ads-0004-operation-resource-shape",
    );
    const messages = shapeErrors.map((problem) => problem.message);

    expect(messages.some((m) => m.includes('top-level key "operation"'))).toBe(true);
    expect(messages.some((m) => m.includes('path parameter "{opId}"'))).toBe(true);
    expect(messages.some((m) => m.includes('uses "operationId" as its primary identifier'))).toBe(
      true,
    );
    expect(messages.some((m) => m.includes('non-canonical field "kind"'))).toBe(true);
    expect(messages.some((m) => m.includes('non-canonical field "state"'))).toBe(true);
    expect(messages.some((m) => m.includes('non-canonical timestamp field "submittedAt"'))).toBe(
      true,
    );
    expect(messages.some((m) => m.includes('non-canonical timestamp field "resolvedAt"'))).toBe(
      true,
    );
    expect(messages.some((m) => m.includes('non-canonical timestamp field "endedAt"'))).toBe(true);
    expect(messages.some((m) => m.includes('non-canonical field "result"'))).toBe(true);
    expect(messages.some((m) => m.includes('non-canonical field "failure"'))).toBe(true);
    expect(
      messages.some(
        (m) =>
          m.includes('"queued"') &&
          m.includes('"in_progress"') &&
          m.includes('"processing"') &&
          m.includes('"done"') &&
          m.includes('"completed"') &&
          m.includes('"canceled"'),
      ),
    ).toBe(true);
    expect(messages.some((m) => m.includes("must declare explicit enum or const"))).toBe(true);
    expect(
      messages.some((m) => m.includes('must mark canonical field "completedAt" as required')),
    ).toBe(true);
    expect(
      messages.some((m) => m.includes('Operation "createdAt" must be a non-null RFC 3339')),
    ).toBe(true);
    expect(
      messages.some((m) => m.includes('Operation "updatedAt" must be a non-null RFC 3339')),
    ).toBe(true);
    expect(messages.some((m) => m.includes('Operation "completedAt" must be an RFC 3339'))).toBe(
      true,
    );
    expect(messages.some((m) => m.includes('Operation "startedAt" must be an RFC 3339'))).toBe(
      true,
    );
    expect(
      messages.some((m) => m.includes('Operation "cancellable" must be a non-null boolean')),
    ).toBe(true);
    expect(messages.some((m) => m.includes('missing: "code"'))).toBe(true);
    expect(
      messages.some((m) => m.includes('Operation "error.status" must be a non-null integer')),
    ).toBe(true);
    expect(
      messages.some((m) =>
        m.includes(
          'Operation "error" must be an RFC 9457 Problem Details object or null, not "string"',
        ),
      ),
    ).toBe(true);
  });

  it("enforces ads-0004-operation-status-invariants on requires_action nextAction contract and credential safety", async () => {
    const doc = baseOpenApi({
      paths: {
        "/v1/projects/{projectId}/operations/{operationId}": {
          parameters: [
            { name: "projectId", in: "path", required: true, schema: { type: "string" } },
            { name: "operationId", in: "path", required: true, schema: { type: "string" } },
          ],
          get: {
            operationId: "getBrokenRequiresActionOps",
            summary: "Tests all requires_action nextAction violations",
            responses: {
              "200": {
                description: "Broken requires_action variants",
                content: {
                  "application/json": {
                    schema: {
                      oneOf: [
                        canonicalOperationBranch("requires_action", {
                          completedAt: { type: "null" },
                          response: { type: "null" },
                          error: { type: "null" },
                        }),
                        canonicalOperationBranch("requires_action", {
                          completedAt: { type: "null" },
                          response: { type: "null" },
                          error: { type: "null" },
                          nextAction: {
                            anyOf: [
                              {
                                type: "object",
                                required: ["type", "url"],
                                properties: {
                                  type: { type: "string", const: "redirect" },
                                  url: { type: "string", format: "uri" },
                                },
                              },
                              { type: "null" },
                            ],
                          },
                        }),
                        canonicalOperationBranch("requires_action", {
                          completedAt: { type: "null" },
                          response: { type: "null" },
                          error: { type: "null" },
                          extraRequired: ["nextAction"],
                          nextAction: {
                            oneOf: [
                              {
                                type: "object",
                                required: ["type"],
                                properties: {
                                  type: { type: "string", const: "confirmPayment" },
                                  deadline: { type: "string", format: "date-time" },
                                  validUntil: { type: "string", format: "date-time" },
                                  expiresAt: { type: "string" },
                                  message: { type: "string" },
                                  clientSecret: { type: "string" },
                                  credentials: {
                                    type: "object",
                                    properties: {
                                      accessToken: { type: "string" },
                                    },
                                  },
                                },
                              },
                              {
                                type: "object",
                                required: ["type", "url"],
                                properties: {
                                  type: { type: "string", const: "redirect" },
                                  url: { type: "string" },
                                },
                              },
                              {
                                type: "object",
                                required: ["kind"],
                                properties: {
                                  kind: { type: "string", const: "verify_dns" },
                                },
                              },
                            ],
                          },
                        }),
                        canonicalOperationBranch("requires_action", {
                          completedAt: { type: "null" },
                          response: { type: "null" },
                          error: { type: "null" },
                          extraRequired: ["nextAction"],
                          nextAction: {
                            type: "object",
                            required: ["type", "invoiceId", "apiKeyId"],
                            properties: {
                              type: { type: "string", const: "confirm_payment" },
                              invoiceId: { type: "string" },
                              apiKeyId: { type: "string" },
                              refreshToken: { type: "string" },
                            },
                          },
                        }),
                      ],
                    },
                  },
                },
              },
              "404": { description: "Not found" },
            },
          },
        },
      },
    });

    const { exitCode, report } = await lintOpenApi(doc);
    expect(exitCode).toBe(1);
    const invErrors = ads0004Problems(report).filter(
      (problem) => problem.ruleId === "photon-ads/ads-0004-operation-status-invariants",
    );
    const messages = invErrors.map((problem) => problem.message);

    expect(
      messages.some((m) => m.includes('must declare a required non-null "nextAction" object')),
    ).toBe(true);
    expect(messages.some((m) => m.includes('must mark "nextAction" as required'))).toBe(true);
    expect(
      messages.some((m) => m.includes('must declare "nextAction" as a non-null structured object')),
    ).toBe(true);
    expect(messages.some((m) => m.includes('"confirmPayment"') && m.includes("snake_case"))).toBe(
      true,
    );
    expect(messages.some((m) => m.includes('non-canonical discriminator "kind"'))).toBe(true);
    expect(messages.some((m) => m.includes('non-canonical expiration field "deadline"'))).toBe(
      true,
    );
    expect(messages.some((m) => m.includes('non-canonical expiration field "validUntil"'))).toBe(
      true,
    );
    expect(messages.some((m) => m.includes('"nextAction.expiresAt"'))).toBe(true);
    expect(messages.some((m) => m.includes('free-text field "message"'))).toBe(true);
    expect(
      messages.some((m) => m.includes('variant "redirect"') && m.includes("format: uri")),
    ).toBe(true);
    expect(messages.some((m) => m.includes('sensitive credential key "clientSecret"'))).toBe(true);
    expect(messages.some((m) => m.includes('sensitive credential key "accessToken"'))).toBe(true);
    expect(messages.some((m) => m.includes('sensitive credential key "refreshToken"'))).toBe(true);
    expect(messages.some((m) => m.includes('"apiKeyId"'))).toBe(false);
    expect(messages.some((m) => m.includes('"invoiceId"'))).toBe(false);
  });

  it("enforces ads-0004-operation-status-invariants across non-terminal, failed, succeeded, cancelled, and mixed un-discriminated branches", async () => {
    const doc = baseOpenApi({
      paths: {
        "/v1/projects/{projectId}/operations/{operationId}": {
          parameters: [
            { name: "projectId", in: "path", required: true, schema: { type: "string" } },
            { name: "operationId", in: "path", required: true, schema: { type: "string" } },
          ],
          get: {
            operationId: "getBrokenStatusInvariants",
            summary: "Tests per-status invariant failures",
            responses: {
              "200": {
                description: "Broken branches",
                content: {
                  "application/json": {
                    schema: {
                      oneOf: [
                        canonicalOperationBranch("pending", {
                          completedAt: { type: ["string", "null"], format: "date-time" },
                          response: { anyOf: [{ type: "object" }, { type: "null" }] },
                          error: {
                            anyOf: [
                              { $ref: "#/components/schemas/ProblemDetails" },
                              { type: "null" },
                            ],
                          },
                          nextAction: {
                            anyOf: [
                              {
                                type: "object",
                                required: ["type", "url"],
                                properties: {
                                  type: { type: "string", const: "redirect" },
                                  url: { type: "string", format: "uri" },
                                },
                              },
                              { type: "null" },
                            ],
                          },
                        }),
                        canonicalOperationBranch("failed", {
                          completedAt: { type: ["string", "null"], format: "date-time" },
                          response: { type: "object", properties: { ok: { type: "boolean" } } },
                          error: {
                            anyOf: [
                              { $ref: "#/components/schemas/ProblemDetails" },
                              { type: "null" },
                            ],
                          },
                        }),
                        canonicalOperationBranch("succeeded", {
                          completedAt: { type: ["string", "null"], format: "date-time" },
                          response: { type: "object", properties: { ok: { type: "boolean" } } },
                          error: { $ref: "#/components/schemas/ProblemDetails" },
                        }),
                        canonicalOperationBranch("cancelled", {
                          completedAt: { type: "string", format: "date-time" },
                          response: { type: "object", properties: { ok: { type: "boolean" } } },
                          error: { $ref: "#/components/schemas/ProblemDetails" },
                        }),
                        canonicalOperationBranch(["pending", "succeeded", "failed"], {
                          completedAt: { type: ["string", "null"], format: "date-time" },
                          response: { type: "null" },
                          error: {
                            anyOf: [
                              { $ref: "#/components/schemas/ProblemDetails" },
                              { type: "null" },
                            ],
                          },
                        }),
                        canonicalOperationBranch(["pending", "requires_action"], {
                          completedAt: { type: "null" },
                          response: { type: "null" },
                          error: { type: "null" },
                        }),
                      ],
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
          ProblemDetails: problemDetailsSchema(),
        },
      },
    });

    const { exitCode, report } = await lintOpenApi(doc);
    expect(exitCode).toBe(1);
    const invErrors = ads0004Problems(report).filter(
      (problem) => problem.ruleId === "photon-ads/ads-0004-operation-status-invariants",
    );
    const messages = invErrors.map((problem) => problem.message);

    expect(
      messages.some((m) => m.includes("(pending)") && m.includes('allows non-null "nextAction"')),
    ).toBe(true);
    expect(
      messages.some(
        (m) => m.includes("(pending)") && m.includes('constrain "completedAt" to null'),
      ),
    ).toBe(true);
    expect(
      messages.some((m) => m.includes("(pending)") && m.includes('constrain "response" to null')),
    ).toBe(true);
    expect(
      messages.some((m) => m.includes("(pending)") && m.includes('constrain "error" to null')),
    ).toBe(true);
    expect(
      messages.some(
        (m) => m.includes("(failed)") && m.includes('constrain "completedAt" to a non-null'),
      ),
    ).toBe(true);
    expect(
      messages.some((m) =>
        m.includes('"failed" branch must require a non-null RFC 9457 Problem Details'),
      ),
    ).toBe(true);
    expect(
      messages.some((m) => m.includes('"failed" branch must constrain "response" to null')),
    ).toBe(true);
    expect(
      messages.some(
        (m) => m.includes("(succeeded)") && m.includes('constrain "completedAt" to a non-null'),
      ),
    ).toBe(true);
    expect(
      messages.some((m) => m.includes("(succeeded)") && m.includes('constrain "error" to null')),
    ).toBe(true);
    expect(
      messages.some((m) => m.includes('"cancelled" branch must constrain "response" to null')),
    ).toBe(true);
    expect(
      messages.some((m) => m.includes("(cancelled)") && m.includes('constrain "error" to null')),
    ).toBe(true);
    expect(messages.some((m) => m.includes("mixes non-terminal and terminal statuses"))).toBe(true);
    expect(
      messages.some((m) => m.includes('combines "requires_action" with other status value(s)')),
    ).toBe(true);
  });

  it("enforces ads-0004-accepted-operation-headers on 202 Operation responses", async () => {
    const doc = baseOpenApi({
      paths: {
        "/v1/projects/{projectId}/plan-changes": {
          parameters: [
            { name: "projectId", in: "path", required: true, schema: { type: "string" } },
          ],
          post: {
            operationId: "startPlanChangeNoLocation",
            summary: "Missing Location header via shared Operation schema",
            responses: {
              "202": {
                description: "Accepted without Location",
                headers: {
                  "Retry-After": { schema: { type: "integer" } },
                },
                content: {
                  "application/json": {
                    schema: { $ref: "#/components/schemas/PlanChangeOperation" },
                  },
                },
              },
              "400": { description: "Bad request" },
            },
          },
        },
        "/v1/projects/{projectId}/inline-ops": {
          parameters: [
            { name: "projectId", in: "path", required: true, schema: { type: "string" } },
          ],
          post: {
            operationId: "startInlineOpNoLocation",
            summary: "Missing Location header on inline Operation schema",
            responses: {
              "202": {
                description: "Accepted inline without Location",
                content: {
                  "application/json": {
                    schema: canonicalOperationBranch("pending", {
                      completedAt: { type: "null" },
                      response: { type: "null" },
                      error: { type: "null" },
                    }),
                  },
                },
              },
              "400": { description: "Bad request" },
            },
          },
        },
        "/v1/projects/{projectId}/ref-response-ops": {
          parameters: [
            { name: "projectId", in: "path", required: true, schema: { type: "string" } },
          ],
          post: {
            operationId: "startRefRespNoLocation",
            summary: "Missing Location header in $ref response",
            responses: {
              "202": {
                $ref: "#/components/responses/AcceptedNoLocation",
              },
              "400": { description: "Bad request" },
            },
          },
        },
        "/v1/projects/{projectId}/operations/{operationId}": {
          parameters: [
            { name: "projectId", in: "path", required: true, schema: { type: "string" } },
            { name: "operationId", in: "path", required: true, schema: { type: "string" } },
          ],
          get: {
            operationId: "getOperation",
            summary: "Poll operation",
            responses: {
              "200": {
                description: "Operation",
                content: {
                  "application/json": {
                    schema: { $ref: "#/components/schemas/PlanChangeOperation" },
                  },
                },
              },
              "404": { description: "Not found" },
            },
          },
        },
      },
      components: {
        responses: {
          AcceptedNoLocation: {
            description: "Accepted without Location header",
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/PendingOperation" },
              },
            },
          },
        },
        schemas: canonicalValidOperationComponents(),
      },
    });

    const { exitCode, report } = await lintOpenApi(doc);
    expect(exitCode).toBe(1);
    const headerErrors = ads0004Problems(report).filter(
      (problem) => problem.ruleId === "photon-ads/ads-0004-accepted-operation-headers",
    );
    expect(headerErrors).toHaveLength(3);
    const messages = headerErrors.map((problem) => problem.message);
    expect(messages.some((m) => m.includes("/v1/projects/{projectId}/plan-changes"))).toBe(true);
    expect(messages.some((m) => m.includes("/v1/projects/{projectId}/inline-ops"))).toBe(true);
    expect(messages.some((m) => m.includes("/v1/projects/{projectId}/ref-response-ops"))).toBe(
      true,
    );
  });

  it("enforces ads-0004-operation-cancel-method against DELETE and non-200 POST cancel responses", async () => {
    const doc = baseOpenApi({
      paths: {
        "/v1/projects/{projectId}/operations/{operationId}": {
          parameters: [
            { name: "projectId", in: "path", required: true, schema: { type: "string" } },
            { name: "operationId", in: "path", required: true, schema: { type: "string" } },
          ],
          get: {
            operationId: "getOperation",
            summary: "Get operation",
            responses: {
              "200": {
                description: "Operation",
                content: {
                  "application/json": {
                    schema: { $ref: "#/components/schemas/PlanChangeOperation" },
                  },
                },
              },
              "404": { description: "Not found" },
            },
          },
          delete: {
            operationId: "deleteOperation",
            summary: "Forbidden DELETE on operation",
            responses: {
              "204": { description: "Deleted" },
              "404": { description: "Not found" },
            },
          },
        },
        "/v1/projects/{projectId}/operations/{operationId}/cancel": {
          parameters: [
            { name: "projectId", in: "path", required: true, schema: { type: "string" } },
            { name: "operationId", in: "path", required: true, schema: { type: "string" } },
          ],
          delete: {
            operationId: "deleteCancelOperation",
            summary: "Forbidden DELETE on cancel route",
            responses: {
              "204": { description: "Cancelled" },
              "404": { description: "Not found" },
            },
          },
          post: {
            operationId: "postCancelReturning204",
            summary: "Cancel returning 204 instead of 200 JSON",
            responses: {
              "204": { description: "No content" },
              "409": { description: "Conflict" },
            },
          },
        },
        "/v1/organizations/{organizationId}/operations/{operationId}/cancel": {
          parameters: [
            { name: "organizationId", in: "path", required: true, schema: { type: "string" } },
            { name: "operationId", in: "path", required: true, schema: { type: "string" } },
          ],
          post: {
            operationId: "postCancelReturning202Only",
            summary: "Cancel returning 202 without 200 JSON",
            responses: {
              "202": {
                description: "Accepted",
                headers: { Location: { schema: { type: "string", format: "uri" } } },
                content: {
                  "application/json": {
                    schema: { $ref: "#/components/schemas/PlanChangeOperation" },
                  },
                },
              },
              "409": { description: "Conflict" },
            },
          },
        },
      },
      components: {
        schemas: canonicalValidOperationComponents(),
      },
    });

    const { exitCode, report } = await lintOpenApi(doc);
    expect(exitCode).toBe(1);
    const cancelErrors = ads0004Problems(report).filter(
      (problem) => problem.ruleId === "photon-ads/ads-0004-operation-cancel-method",
    );
    expect(cancelErrors).toHaveLength(4);
    const messages = cancelErrors.map((problem) => problem.message);
    expect(
      messages.some((m) =>
        m.includes('DELETE "/v1/projects/{projectId}/operations/{operationId}"'),
      ),
    ).toBe(true);
    expect(
      messages.some((m) =>
        m.includes('DELETE "/v1/projects/{projectId}/operations/{operationId}/cancel"'),
      ),
    ).toBe(true);
    expect(
      messages.some(
        (m) =>
          m.includes('POST "/v1/projects/{projectId}/operations/{operationId}/cancel"') &&
          m.includes("must declare a 200 JSON response"),
      ),
    ).toBe(true);
    expect(
      messages.some(
        (m) =>
          m.includes('POST "/v1/organizations/{organizationId}/operations/{operationId}/cancel"') &&
          m.includes("must declare a 200 JSON response"),
      ),
    ).toBe(true);
  });

  it("supports declarative path, method, and schema ignore options across all four ADS-0004 rules", async () => {
    const doc = baseOpenApi({
      paths: {
        "/v1/projects/{projectId}/legacy-ops": {
          parameters: [
            { name: "projectId", in: "path", required: true, schema: { type: "string" } },
          ],
          post: {
            operationId: "startLegacyOp",
            summary: "Ignored by schema and path",
            responses: {
              "202": {
                description: "Accepted without Location",
                content: {
                  "application/json": {
                    schema: { $ref: "#/components/schemas/LegacyOperation" },
                  },
                },
              },
              "400": { description: "Bad request" },
            },
          },
        },
        "/v1/projects/{projectId}/active-ops": {
          parameters: [
            { name: "projectId", in: "path", required: true, schema: { type: "string" } },
          ],
          post: {
            operationId: "startActiveOp",
            summary: "Not ignored — should still report",
            responses: {
              "202": {
                description: "Accepted without Location",
                content: {
                  "application/json": {
                    schema: { $ref: "#/components/schemas/ActiveBadOperation" },
                  },
                },
              },
              "400": { description: "Bad request" },
            },
          },
        },
        "/v1/projects/{projectId}/operations/{operationId}": {
          parameters: [
            { name: "projectId", in: "path", required: true, schema: { type: "string" } },
            { name: "operationId", in: "path", required: true, schema: { type: "string" } },
          ],
          delete: {
            operationId: "legacyDeleteOp",
            summary: "Ignored DELETE",
            responses: {
              "204": { description: "Deleted" },
              "404": { description: "Not found" },
            },
          },
        },
      },
      components: {
        schemas: {
          LegacyOperation: {
            type: "object",
            required: ["id", "kind", "state"],
            properties: {
              id: { type: "string" },
              kind: { type: "string", const: "legacy.run" },
              state: { type: "string", const: "queued" },
            },
          },
          ActiveBadOperation: {
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
              id: { type: "string" },
              type: { type: "string", const: "plan.change" },
              status: { type: "string", const: "pending" },
              createdAt: { type: "string", format: "date-time" },
              updatedAt: { type: "string", format: "date-time" },
              completedAt: { type: "string", format: "date-time" },
              response: { type: "null" },
              error: { type: "null" },
            },
          },
        },
      },
    });

    const configPath = await writeRedoclyConfig({
      "photon-ads/ads-0004-operation-resource-shape": {
        severity: "error",
        ignore: [{ schema: "LegacyOperation", reason: "Legacy v1 schema" }],
      },
      "photon-ads/ads-0004-operation-status-invariants": {
        severity: "error",
        ignore: [{ schema: "LegacyOperation", reason: "Legacy v1 schema" }],
      },
      "photon-ads/ads-0004-accepted-operation-headers": {
        severity: "error",
        ignore: [
          {
            path: "/v1/projects/{projectId}/legacy-ops",
            method: "post",
            reason: "Legacy accepted response",
          },
        ],
      },
      "photon-ads/ads-0004-operation-cancel-method": {
        severity: "error",
        ignore: [
          {
            path: "/v1/projects/{projectId}/operations/{operationId}",
            method: "delete",
            reason: "Legacy delete endpoint",
          },
        ],
      },
    });

    const { exitCode, report } = await lintOpenApi(doc, configPath);
    expect(exitCode).toBe(1);
    const errors = ads0004Problems(report);
    expect(errors.some((e) => e.message.includes("legacy-ops"))).toBe(false);
    expect(errors.some((e) => e.message.includes("DELETE"))).toBe(false);
    expect(
      errors.some(
        (e) =>
          e.ruleId === "photon-ads/ads-0004-operation-status-invariants" &&
          e.message.includes("active-ops"),
      ),
    ).toBe(true);
    expect(
      errors.some(
        (e) =>
          e.ruleId === "photon-ads/ads-0004-accepted-operation-headers" &&
          e.message.includes("active-ops"),
      ),
    ).toBe(true);
  });

  it("handles cyclic nested schemas inside response, metadata, and nextAction safely", async () => {
    const doc = baseOpenApi({
      paths: {
        "/v1/projects/{projectId}/operations/{operationId}": {
          parameters: [
            { name: "projectId", in: "path", required: true, schema: { type: "string" } },
            { name: "operationId", in: "path", required: true, schema: { type: "string" } },
          ],
          get: {
            operationId: "getCyclicOperation",
            summary: "Operation with cyclic nested metadata and nextAction nodes",
            responses: {
              "200": {
                description: "Operation",
                content: {
                  "application/json": {
                    schema: {
                      oneOf: [
                        canonicalOperationBranch("requires_action", {
                          completedAt: { type: "null" },
                          response: { type: "null" },
                          error: { type: "null" },
                          extraRequired: ["nextAction"],
                          nextAction: {
                            type: "object",
                            required: ["type", "tree"],
                            properties: {
                              type: { type: "string", const: "verify_tree" },
                              tree: { $ref: "#/components/schemas/RecursiveNode" },
                            },
                          },
                          extraProperties: {
                            metadata: { $ref: "#/components/schemas/RecursiveNode" },
                          },
                        }),
                        canonicalOperationBranch("succeeded", {
                          completedAt: { type: "string", format: "date-time" },
                          response: { $ref: "#/components/schemas/RecursiveNode" },
                          error: { type: "null" },
                          nextAction: { type: "null" },
                        }),
                      ],
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
          RecursiveNode: {
            type: "object",
            required: ["label"],
            properties: {
              label: { type: "string" },
              child: { $ref: "#/components/schemas/RecursiveNode" },
            },
          },
        },
      },
    });

    const { exitCode, report } = await lintOpenApi(doc);
    expect(ads0004Problems(report)).toEqual([]);
    expect(exitCode).toBe(0);
  });

  it("prunes unsatisfiable branches when allOf narrows an existing Operation union on status", async () => {
    const pathParam = (name: string) => ({
      name,
      in: "path",
      required: true,
      schema: { type: "string" },
    });
    const doc = baseOpenApi({
      paths: {
        "/v1/projects/{projectId}/plan-changes": {
          parameters: [pathParam("projectId")],
          post: {
            operationId: "startPlanChange",
            summary: "Start plan change",
            responses: {
              "202": {
                description: "Accepted with pending-only narrowed union",
                headers: {
                  Location: {
                    required: true,
                    schema: { type: "string", format: "uri" },
                  },
                },
                content: {
                  "application/json": {
                    schema: {
                      allOf: [
                        { $ref: "#/components/schemas/PlanChangeOperation" },
                        {
                          type: "object",
                          properties: {
                            status: { type: "string", const: "pending" },
                          },
                        },
                      ],
                    },
                  },
                },
              },
              "400": { description: "Bad request" },
            },
          },
        },
        "/v1/projects/{projectId}/operations/{operationId}": {
          parameters: [pathParam("projectId"), pathParam("operationId")],
          get: {
            operationId: "getProjectOperation",
            summary: "Get project operation",
            responses: {
              "200": {
                description: "Operation status",
                content: {
                  "application/json": {
                    schema: { $ref: "#/components/schemas/PlanChangeOperation" },
                  },
                },
              },
              "404": { description: "Not found" },
            },
          },
        },
      },
      components: {
        schemas: canonicalValidOperationComponents(),
      },
    });

    const { exitCode, report } = await lintOpenApi(doc);
    expect(ads0004Problems(report)).toEqual([]);
    expect(exitCode).toBe(0);
  });

  it("preserves nested nextAction variants during deduplication and inspects patternProperties for credentials", async () => {
    const pathParam = (name: string) => ({
      name,
      in: "path",
      required: true,
      schema: { type: "string" },
    });
    const doc = baseOpenApi({
      paths: {
        "/v1/projects/{projectId}/operations/{operationId}": {
          parameters: [pathParam("projectId"), pathParam("operationId")],
          get: {
            operationId: "getDuplicateShapeActionOp",
            responses: {
              "200": {
                description: "Two inline verify_dns variants sharing details:object shape",
                content: {
                  "application/json": {
                    schema: canonicalOperationBranch("requires_action", {
                      completedAt: { type: "null" },
                      response: { type: "null" },
                      error: { type: "null" },
                      extraRequired: ["nextAction"],
                      nextAction: {
                        oneOf: [
                          {
                            type: "object",
                            required: ["type", "details"],
                            properties: {
                              type: { type: "string", const: "verify_dns" },
                              details: {
                                type: "object",
                                required: ["record"],
                                properties: {
                                  record: { type: "string" },
                                },
                              },
                            },
                          },
                          {
                            type: "object",
                            required: ["type", "details"],
                            properties: {
                              type: { type: "string", const: "verify_dns" },
                              details: {
                                type: "object",
                                required: ["clientSecret"],
                                properties: {
                                  clientSecret: { type: "string" },
                                },
                              },
                            },
                          },
                        ],
                      },
                    }),
                  },
                },
              },
            },
          },
        },
        "/v1/projects/{projectId}/pattern-ops/operations/{operationId}": {
          parameters: [pathParam("projectId"), pathParam("operationId")],
          get: {
            operationId: "getPatternPropertiesActionOp",
            responses: {
              "200": {
                description:
                  "Credential exposed via patternProperties and safe generic map pattern",
                content: {
                  "application/json": {
                    schema: canonicalOperationBranch("requires_action", {
                      completedAt: { type: "null" },
                      response: { type: "null" },
                      error: { type: "null" },
                      extraRequired: ["nextAction"],
                      nextAction: {
                        type: "object",
                        required: ["type"],
                        properties: {
                          type: { type: "string", const: "verify_records" },
                          items: {
                            type: "array",
                            items: {
                              type: "object",
                              patternProperties: {
                                "^clientSecret$": { type: "string" },
                                "^[a-zA-Z0-9_]+$": { type: "string" },
                              },
                            },
                          },
                          nestedEntries: {
                            type: "object",
                            patternProperties: {
                              "^entry_": {
                                type: "object",
                                properties: {
                                  apiKey: { type: "string" },
                                },
                              },
                            },
                          },
                        },
                      },
                    }),
                  },
                },
              },
            },
          },
        },
      },
    });

    const { report } = await lintOpenApi(doc);
    const invErrors = ads0004Problems(report).filter(
      (problem) => problem.ruleId === "photon-ads/ads-0004-operation-status-invariants",
    );
    const messages = invErrors.map((e) => e.message);

    expect(
      messages.some((m) => m.includes('key "clientSecret"') && m.includes("details.clientSecret")),
    ).toBe(true);
    expect(
      messages.some((m) => m.includes('key "clientSecret"') && m.includes("[/^clientSecret$/]")),
    ).toBe(true);
    expect(
      messages.some(
        (m) => m.includes('key "apiKey"') && m.includes("nestedEntries[/^entry_/].apiKey"),
      ),
    ).toBe(true);
    expect(messages.some((m) => m.includes("^[a-zA-Z0-9_]+$"))).toBe(false);
  });

  it("handles OAS 3.0 nullable:true with non-null enum, enforces object-only responses, integer error.status, hyphenated *Operation names, and explicit 200 cancel precedence", async () => {
    const pathParam = (name: string) => ({
      name,
      in: "path",
      required: true,
      schema: { type: "string" },
    });
    const oas30Doc = baseOpenApi({
      openapi: "3.0.3",
      paths: {
        "/v1/projects/{projectId}/operations/{operationId}": {
          parameters: [pathParam("projectId"), pathParam("operationId")],
          get: {
            operationId: "getOas30NullableNonNullEnumOp",
            responses: {
              "200": {
                description: "Valid OAS 3.0 nullable:true with non-null enum",
                content: {
                  "application/json": {
                    schema: {
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
                        id: { type: "string" },
                        type: { type: "string", enum: ["plan.change"] },
                        status: { type: "string", nullable: true, enum: ["pending"] },
                        createdAt: { type: "string", format: "date-time" },
                        updatedAt: { type: "string", format: "date-time" },
                        completedAt: { type: "string", nullable: true, enum: [null] },
                        response: { type: "object", nullable: true, enum: [null] },
                        error: { type: "object", nullable: true, enum: [null] },
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
    const oas30Result = await lintOpenApi(oas30Doc);
    expect(ads0004Problems(oas30Result.report)).toEqual([]);

    const badDoc = baseOpenApi({
      paths: {
        "/v1/projects/{projectId}/nullable-ops/operations/{operationId}": {
          parameters: [pathParam("projectId"), pathParam("operationId")],
          get: {
            operationId: "getNullableOperation",
            responses: {
              "200": {
                description: "Operation response allowing null",
                content: {
                  "application/json": {
                    schema: {
                      ...canonicalOperationBranch("pending", {
                        completedAt: { type: "null" },
                        response: { type: "null" },
                        error: { type: "null" },
                      }),
                      type: ["object", "null"],
                    },
                  },
                },
              },
            },
          },
        },
        "/v1/projects/{projectId}/untyped-ops/operations/{operationId}": {
          parameters: [pathParam("projectId"), pathParam("operationId")],
          get: {
            operationId: "getUntypedOperation",
            responses: {
              "200": {
                description: "Operation response omitting type: object",
                content: {
                  "application/json": {
                    schema: {
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
                        id: { type: "string" },
                        type: { type: "string", const: "plan.change" },
                        status: { type: "string", const: "pending" },
                        createdAt: { type: "string", format: "date-time" },
                        updatedAt: { type: "string", format: "date-time" },
                        completedAt: { type: "null" },
                        response: { type: "null" },
                        error: { type: "null" },
                      },
                    },
                  },
                },
              },
            },
          },
        },
        "/v1/projects/{projectId}/float-error-ops/operations/{operationId}": {
          parameters: [pathParam("projectId"), pathParam("operationId")],
          get: {
            operationId: "getFloatErrorStatusOp",
            responses: {
              "200": {
                description: "Failed op with non-integer error.status",
                content: {
                  "application/json": {
                    schema: canonicalOperationBranch("failed", {
                      completedAt: { type: "string", format: "date-time" },
                      response: { type: "null" },
                      error: {
                        type: "object",
                        required: ["type", "title", "status", "code"],
                        properties: {
                          type: { type: "string", format: "uri" },
                          title: { type: "string" },
                          status: { type: "number" },
                          code: { type: "string" },
                        },
                      },
                    }),
                  },
                },
              },
            },
          },
        },
        "/v1/projects/{projectId}/legacy-trigger": {
          parameters: [pathParam("projectId")],
          post: {
            operationId: "triggerLegacyHyphenOp",
            responses: {
              "202": {
                description: "Missing Location header with hyphenated *Operation component name",
                content: {
                  "application/json": {
                    schema: { $ref: "#/components/schemas/Legacy-Operation" },
                  },
                },
              },
            },
          },
        },
        "/v1/projects/{projectId}/operations/{operationId}/cancel": {
          parameters: [pathParam("projectId"), pathParam("operationId")],
          post: {
            operationId: "cancelWithBodyless200AndJson2XX",
            responses: {
              "200": {
                description: "Bodyless 200 takes precedence over 2XX",
              },
              "2XX": {
                description: "Wildcard 2XX with JSON body must not mask bodyless 200",
                content: {
                  "application/json": {
                    schema: canonicalOperationBranch("cancelled", {
                      completedAt: { type: "string", format: "date-time" },
                      response: { type: "null" },
                      error: { type: "null" },
                    }),
                  },
                },
              },
            },
          },
        },
      },
      components: {
        schemas: {
          "Legacy-Operation": {
            type: "object",
            required: ["id", "status"],
            properties: {
              id: { type: "string" },
              status: { type: "string", const: "pending" },
            },
          },
        },
      },
    });

    const badResult = await lintOpenApi(badDoc);
    const problems = ads0004Problems(badResult.report);
    const byRule = (ruleId: string) =>
      problems.filter((p) => p.ruleId === ruleId).map((p) => p.message);

    expect(
      byRule("photon-ads/ads-0004-operation-resource-shape").some(
        (m) => m.includes("nullable-ops") && m.includes("non-null flat top-level JSON object"),
      ),
    ).toBe(true);
    expect(
      byRule("photon-ads/ads-0004-operation-resource-shape").some(
        (m) => m.includes("untyped-ops") && m.includes("non-null flat top-level JSON object"),
      ),
    ).toBe(true);
    expect(
      byRule("photon-ads/ads-0004-operation-resource-shape").some(
        (m) => m.includes("float-error-ops") && m.includes('Operation "error.status"'),
      ),
    ).toBe(true);
    expect(
      byRule("photon-ads/ads-0004-accepted-operation-headers").some(
        (m) => m.includes("legacy-trigger") && m.includes('declare a "Location" header'),
      ),
    ).toBe(true);
    expect(
      byRule("photon-ads/ads-0004-operation-cancel-method").some((m) =>
        m.includes("must declare a 200 JSON response"),
      ),
    ).toBe(true);
  });

  it("reports overlapping status branches in oneOf unions while allowing anyOf and disjoint multi-type or multi-action oneOf unions", async () => {
    const pathParam = (name: string) => ({
      name,
      in: "path",
      required: true,
      schema: { type: "string" },
    });
    const validMultiDoc = baseOpenApi({
      paths: {
        "/v1/projects/{projectId}/multi-type/operations/{operationId}": {
          parameters: [pathParam("projectId"), pathParam("operationId")],
          get: {
            operationId: "getMultiTypeOperation",
            responses: {
              "200": {
                description: "Disjoint operation types sharing status values in oneOf",
                content: {
                  "application/json": {
                    schema: {
                      oneOf: [
                        canonicalOperationBranch("pending", {
                          completedAt: { type: "null" },
                          response: { type: "null" },
                          error: { type: "null" },
                          extraProperties: {
                            type: { type: "string", const: "plan.change" },
                          },
                        }),
                        canonicalOperationBranch("pending", {
                          completedAt: { type: "null" },
                          response: { type: "null" },
                          error: { type: "null" },
                          extraProperties: {
                            type: { type: "string", const: "domain.verify" },
                          },
                        }),
                      ],
                    },
                  },
                },
              },
            },
          },
        },
        "/v1/projects/{projectId}/anyof-overlap/operations/{operationId}": {
          parameters: [pathParam("projectId"), pathParam("operationId")],
          get: {
            operationId: "getAnyOfOverlapOperation",
            responses: {
              "200": {
                description: "anyOf permits overlapping branches",
                content: {
                  "application/json": {
                    schema: {
                      anyOf: [
                        canonicalOperationBranch("pending", {
                          completedAt: { type: "null" },
                          response: { type: "null" },
                          error: { type: "null" },
                        }),
                        canonicalOperationBranch(["pending", "running"], {
                          completedAt: { type: "null" },
                          response: { type: "null" },
                          error: { type: "null" },
                        }),
                      ],
                    },
                  },
                },
              },
            },
          },
        },
        "/v1/projects/{projectId}/multi-action/operations/{operationId}": {
          parameters: [pathParam("projectId"), pathParam("operationId")],
          get: {
            operationId: "getMultiActionOneOfOperation",
            responses: {
              "200": {
                description: "Disjoint nextAction.type variants under requires_action",
                content: {
                  "application/json": {
                    schema: {
                      oneOf: [
                        canonicalOperationBranch("requires_action", {
                          completedAt: { type: "null" },
                          response: { type: "null" },
                          error: { type: "null" },
                          extraRequired: ["nextAction"],
                          nextAction: {
                            type: "object",
                            required: ["type", "url"],
                            properties: {
                              type: { type: "string", const: "redirect" },
                              url: { type: "string", format: "uri" },
                            },
                          },
                        }),
                        canonicalOperationBranch("requires_action", {
                          completedAt: { type: "null" },
                          response: { type: "null" },
                          error: { type: "null" },
                          extraRequired: ["nextAction"],
                          nextAction: {
                            type: "object",
                            required: ["type", "invoiceId"],
                            properties: {
                              type: { type: "string", const: "confirm_payment" },
                              invoiceId: { type: "string" },
                            },
                          },
                        }),
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
    const validRes = await lintOpenApi(validMultiDoc);
    expect(ads0004Problems(validRes.report)).toEqual([]);

    const overlapDoc = baseOpenApi({
      paths: {
        "/v1/projects/{projectId}/overlap/operations/{operationId}": {
          parameters: [pathParam("projectId"), pathParam("operationId")],
          get: {
            operationId: "getOverlappingOneOfOperation",
            responses: {
              "200": {
                description: "oneOf branches overlapping on status pending",
                content: {
                  "application/json": {
                    schema: {
                      oneOf: [
                        canonicalOperationBranch("pending", {
                          completedAt: { type: "null" },
                          response: { type: "null" },
                          error: { type: "null" },
                        }),
                        canonicalOperationBranch(["pending", "running"], {
                          completedAt: { type: "null" },
                          response: { type: "null" },
                          error: { type: "null" },
                        }),
                      ],
                    },
                  },
                },
              },
            },
          },
        },
        "/v1/projects/{projectId}/duplicate-branch/operations/{operationId}": {
          parameters: [pathParam("projectId"), pathParam("operationId")],
          get: {
            operationId: "getDuplicateOneOfOperation",
            responses: {
              "200": {
                description: "Identical oneOf branches overlapping on status running",
                content: {
                  "application/json": {
                    schema: {
                      oneOf: [
                        canonicalOperationBranch("running", {
                          completedAt: { type: "null" },
                          response: { type: "null" },
                          error: { type: "null" },
                        }),
                        canonicalOperationBranch("running", {
                          completedAt: { type: "null" },
                          response: { type: "null" },
                          error: { type: "null" },
                        }),
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
    const overlapRes = await lintOpenApi(overlapDoc);
    const invMessages = ads0004Problems(overlapRes.report)
      .filter((p) => p.ruleId === "photon-ads/ads-0004-operation-status-invariants")
      .map((p) => p.message);

    expect(
      invMessages.some(
        (m) => m.includes("overlap") && m.includes('matches status "pending" in multiple branches'),
      ),
    ).toBe(true);
    expect(
      invMessages.some(
        (m) =>
          m.includes("duplicate-branch") &&
          m.includes('matches status "running" in multiple branches'),
      ),
    ).toBe(true);
  });

  it("reports incomplete analysis instead of silently truncating when an Operation union exceeds the variant cap", async () => {
    const pathParam = (name: string) => ({
      name,
      in: "path",
      required: true,
      schema: { type: "string" },
    });
    const manyBranches = Array.from({ length: 260 }, (_, index) =>
      canonicalOperationBranch("pending", {
        completedAt: { type: "null" },
        response: { type: "null" },
        error: { type: "null" },
        extraProperties: {
          type: { type: "string", const: `resource_${index}.action` },
        },
      }),
    );
    const doc = baseOpenApi({
      paths: {
        "/v1/projects/{projectId}/huge/operations/{operationId}": {
          parameters: [pathParam("projectId"), pathParam("operationId")],
          get: {
            operationId: "getHugeUnionOperation",
            responses: {
              "200": {
                description: "Union exceeding 256-variant cap",
                content: {
                  "application/json": {
                    schema: { oneOf: manyBranches },
                  },
                },
              },
            },
          },
        },
      },
    });

    const { report } = await lintOpenApi(doc);
    const messages = ads0004Problems(report).map((p) => p.message);
    expect(messages.some((m) => m.includes("256-variant union analysis cap"))).toBe(true);
  });
});
