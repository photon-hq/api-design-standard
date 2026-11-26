import { execFileSync, spawnSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { stringify as stringifyYaml } from "yaml";
import {
  ADS_0005_METADATA,
  computeHoistedCollectionCandidates,
  endsWithPathParam,
  findCrudVerbInPathSegment,
  findMutatingTerminalActionSegment,
  isValidKebabCasePathSegment,
  looksLikePluralSubCollectionSegment,
  normalizePathTemplate,
  splitPathSegments,
  suggestResourceIdParam,
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
      description: "Test specification for ADS-0005.",
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

function ads0005Problems(report: RedoclyJsonReport): RedoclyJsonProblem[] {
  return report.problems.filter((problem) => problem.ruleId.startsWith("photon-ads/ads-0005-"));
}

function ads0005ProblemsFor(report: RedoclyJsonReport, ruleName: string): RedoclyJsonProblem[] {
  return report.problems.filter((problem) => problem.ruleId === `photon-ads/${ruleName}`);
}

beforeAll(async () => {
  tempDir = await mkdtemp(join(tmpdir(), "photon-ads-0005-"));
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

describe("ADS-0005 unit helpers", () => {
  it("exports metadata for all four error-level ADS-0005 rules", () => {
    expect(ADS_0005_METADATA.ads).toBe("0005");
    expect(ADS_0005_METADATA.slug).toBe("ads-0005");
    expect(ADS_0005_METADATA.folder).toBe("0005-standard-resource-methods");
    expect(ADS_0005_METADATA.rules.map((r) => r.id)).toEqual([
      "photon-ads/ads-0005-addressable-resource-read",
      "photon-ads/ads-0005-standard-http-methods",
      "photon-ads/ads-0005-standard-status-codes",
      "photon-ads/ads-0005-url-path-naming",
    ]);
    expect(ADS_0005_METADATA.rules.every((r) => r.severity === "error")).toBe(true);
  });

  it("normalizes path templates and computes hoisted canonical collection paths", () => {
    expect(normalizePathTemplate("/v1/projects/")).toBe("/v1/projects");
    expect(normalizePathTemplate("/")).toBe("/");
    expect(splitPathSegments("/v1/organizations/{organizationId}/projects/")).toEqual([
      "v1",
      "organizations",
      "{organizationId}",
      "projects",
    ]);
    expect(endsWithPathParam("/v1/projects/{projectId}")).toBe(true);
    expect(endsWithPathParam("/v1/projects/{projectId}/")).toBe(true);
    expect(endsWithPathParam("/v1/projects/{projectId}/revoke")).toBe(false);
    expect(endsWithPathParam("/v1/projects")).toBe(false);

    expect(
      computeHoistedCollectionCandidates(["v1", "organizations", "{organizationId}", "projects"]),
    ).toEqual([["v1", "projects"]]);
    expect(
      computeHoistedCollectionCandidates([
        "v1",
        "organizations",
        "{organizationId}",
        "billing",
        "invoices",
      ]),
    ).toEqual([["v1", "billing", "invoices"]]);
    expect(
      computeHoistedCollectionCandidates([
        "v1",
        "organizations",
        "{organizationId}",
        "projects",
        "{projectId}",
        "webhooks",
      ]),
    ).toEqual([
      ["v1", "projects", "{projectId}", "webhooks"],
      ["v1", "webhooks"],
    ]);
    expect(
      computeHoistedCollectionCandidates(["organizations", "{organizationId}", "members"]),
    ).toEqual([["members"]]);
    expect(computeHoistedCollectionCandidates(["v1", "projects"])).toEqual([]);
  });

  it("detects CRUD verb segments without false-positiving domain nouns or actions", () => {
    for (const [segment, expectedVerb] of [
      ["create", "create"],
      ["get", "get"],
      ["GET", "get"],
      ["list", "list"],
      ["update", "update"],
      ["delete", "delete"],
      ["remove", "remove"],
      ["fetch", "fetch"],
      ["edit", "edit"],
      ["add", "add"],
      ["getUser", "get"],
      ["GetUser", "get"],
      ["get-user", "get"],
      ["get_user", "get"],
      ["list-projects", "list"],
      ["create-project", "create"],
      ["delete-key", "delete"],
      ["deleteKey", "delete"],
      ["DELETE_KEY", "delete"],
      ["update-member", "update"],
      ["remove-item", "remove"],
      ["fetch-records", "fetch"],
      ["add-member", "add"],
      ["edit-profile", "edit"],
    ] as const) {
      expect(findCrudVerbInPathSegment(segment), segment).toBe(expectedVerb);
    }

    for (const safe of [
      "{deleteId}",
      ".well-known",
      "address",
      "addresses",
      "ADDRESS",
      "additional",
      "credit-cards",
      "deletion-check",
      "deletions",
      "delivery-attempts",
      "created",
      "deleted",
      "updates",
      "editor",
      "listing",
      "cancel",
      "revoke",
      "rotate",
      "resend",
      "retry",
      "verify",
      "enable",
      "disable",
      "archive",
      "restore",
      "read",
      "typing",
      "preview",
      "accept",
      "redeem",
      "checkout",
      "purchase",
      "commit",
      "uploads",
      "leave",
      "transfer-ownership",
      "count",
      "search",
      "query",
      "batch",
      "export",
      "import",
      "sync",
      "refresh",
      "pause",
      "resume",
    ]) {
      expect(findCrudVerbInPathSegment(safe), safe).toBeNull();
    }
  });

  it("validates kebab-case static segments, plural sub-collections, and suggested resource params", () => {
    expect(isValidKebabCasePathSegment("v1", 0)).toBe(true);
    expect(isValidKebabCasePathSegment("v2", 0)).toBe(true);
    expect(isValidKebabCasePathSegment(".well-known", 0)).toBe(true);
    expect(isValidKebabCasePathSegment("{projectId}", 2)).toBe(true);
    expect(isValidKebabCasePathSegment("api-keys", 3)).toBe(true);
    expect(isValidKebabCasePathSegment("oauth2", 1)).toBe(true);
    expect(isValidKebabCasePathSegment("{projectId}:archive", 2)).toBe(true);

    expect(isValidKebabCasePathSegment("V1", 0)).toBe(false);
    expect(isValidKebabCasePathSegment("apiKeys", 3)).toBe(false);
    expect(isValidKebabCasePathSegment("api_keys", 3)).toBe(false);
    expect(isValidKebabCasePathSegment("Projects", 1)).toBe(false);
    expect(isValidKebabCasePathSegment("webhooks.v1", 1)).toBe(false);
    expect(isValidKebabCasePathSegment("api--keys", 1)).toBe(false);
    expect(isValidKebabCasePathSegment("my projects", 1)).toBe(false);

    expect(looksLikePluralSubCollectionSegment("projects")).toBe(true);
    expect(looksLikePluralSubCollectionSegment("plan-changes")).toBe(true);
    expect(looksLikePluralSubCollectionSegment("api-keys")).toBe(true);
    expect(looksLikePluralSubCollectionSegment("exports")).toBe(true);
    expect(looksLikePluralSubCollectionSegment("revoke")).toBe(false);
    expect(looksLikePluralSubCollectionSegment("cancel")).toBe(false);
    expect(looksLikePluralSubCollectionSegment("dismiss")).toBe(false);
    expect(looksLikePluralSubCollectionSegment("reprocess")).toBe(false);
    expect(looksLikePluralSubCollectionSegment("revoke-sessions")).toBe(false);
    expect(looksLikePluralSubCollectionSegment("verify-dns")).toBe(false);
    expect(looksLikePluralSubCollectionSegment("status")).toBe(false);

    expect(suggestResourceIdParam("projects")).toBe("projectId");
    expect(suggestResourceIdParam("api-keys")).toBe("apiKeyId");
    expect(suggestResourceIdParam("entries")).toBe("entryId");
    expect(suggestResourceIdParam("addresses")).toBe("addressId");
    expect(suggestResourceIdParam("batches")).toBe("batchId");
  });

  it("identifies unmistakable state-mutating terminal action segments with zero CRUD-verb overlap", () => {
    const disallowedVerbs = [
      "revoke",
      "cancel",
      "rotate",
      "retry",
      "resend",
      "archive",
      "restore",
      "enable",
      "disable",
      "transfer-ownership",
      "pay",
      "purchase",
      "approve",
      "reject",
      "confirm",
      "submit",
      "trigger",
      "publish",
      "unpublish",
      "suspend",
      "unsuspend",
      "activate",
      "deactivate",
      "refund",
      "void",
      "reset",
      "purge",
      "invalidate",
      "disconnect",
      "unlink",
      "install",
      "uninstall",
      "deploy",
      "rollback",
      "pause",
      "resume",
      "verify",
    ];

    for (const verb of disallowedVerbs) {
      expect(findCrudVerbInPathSegment(verb), `no CRUD overlap for ${verb}`).toBeNull();
      expect(findMutatingTerminalActionSegment(`/v1/items/{itemId}/${verb}`), verb).toBe(verb);
      expect(
        findMutatingTerminalActionSegment(`/v1/items/{itemId}/${verb.toUpperCase()}/`),
        verb,
      ).toBe(verb);
      expect(findMutatingTerminalActionSegment(`/v1/items/{itemId}:${verb}`), verb).toBe(verb);
    }

    for (const allowedPath of [
      "/",
      "/v1/items/{itemId}",
      "/v1/items/{revoke}",
      "/v1/operations/{operationId}/redirect",
      "/v1/oauth/callback",
      "/v1/files/{fileId}/download",
      "/v1/reports/export",
      "/v1/templates/{templateId}/preview",
      "/v1/projects/search",
      "/v1/projects/query",
      "/v1/projects/count",
      "/v1/health/status",
      "/v1/invoices/{invoiceId}/pdf",
      "/v1/invoices/{invoiceId}/receipt",
      "/v1/projects/{projectId}/refunds",
      "/v1/projects/{projectId}/purchases",
      "/v1/projects/{projectId}/deploy/status",
      "/v1/projects/{projectId}/delete",
      "/.well-known",
    ]) {
      expect(findMutatingTerminalActionSegment(allowedPath), allowedPath).toBeNull();
    }
  });
});

describe("ADS-0005 Redocly CLI end-to-end linting", () => {
  it("passes the repository valid OpenAPI fixture with zero errors and zero warnings", () => {
    const { exitCode, report } = runRedoclyLint(VALID_FIXTURE);
    expect(exitCode).toBe(0);
    expect(report.totals.errors).toBe(0);
    expect(report.totals.warnings).toBe(0);
    expect(ads0005Problems(report)).toEqual([]);
  });

  it("allows valid CRUD resources, hoisted canonical reads, summary projections, lookup lists, composites, singletons, and custom actions", async () => {
    const doc = baseOpenApi({
      paths: {
        // Scoped list paired with hoisted canonical GET via identical $ref
        "/v1/organizations/{organizationId}/projects": {
          parameters: [pathParam("organizationId")],
          get: {
            operationId: "listOrgProjects",
            summary: "List organization projects",
            responses: {
              "200": jsonResponse({
                type: "object",
                required: ["items"],
                properties: {
                  items: { type: "array", items: { $ref: "#/components/schemas/Project" } },
                  nextPageToken: { type: ["string", "null"] },
                },
              }),
              "404": { description: "Not found" },
            },
          },
          post: {
            operationId: "createOrgProject",
            summary: "Create project",
            responses: {
              "201": jsonResponse({ $ref: "#/components/schemas/Project" }, "Created"),
              "200": jsonResponse({ $ref: "#/components/schemas/Project" }, "Idempotent replay"),
              "400": { description: "Bad request" },
            },
          },
        },
        "/v1/projects/{projectId}": {
          parameters: [pathParam("projectId")],
          get: {
            operationId: "getProject",
            summary: "Get project",
            responses: {
              "200": jsonResponse({ $ref: "#/components/schemas/Project" }),
              "304": { description: "Not modified" },
              "404": { description: "Not found" },
            },
          },
          patch: {
            operationId: "updateProject",
            summary: "Update project",
            responses: {
              "200": jsonResponse({ $ref: "#/components/schemas/Project" }),
              "404": { description: "Not found" },
            },
          },
          delete: {
            operationId: "deleteProject",
            summary: "Delete project",
            responses: {
              "204": { description: "Deleted" },
              "404": { description: "Not found" },
            },
          },
        },
        // Scoped list using summary projection matched by hoisted canonical GET with extra fields
        "/v1/organizations/{organizationId}/billing/invoices": {
          parameters: [pathParam("organizationId")],
          get: {
            operationId: "listOrgInvoices",
            summary: "List organization invoices",
            responses: {
              "200": jsonResponse({
                type: "object",
                required: ["items"],
                properties: {
                  items: { type: "array", items: { $ref: "#/components/schemas/InvoiceSummary" } },
                  hasMore: { type: "boolean" },
                  totalCount: { type: "integer" },
                },
              }),
              "404": { description: "Not found" },
            },
          },
        },
        "/v1/billing/invoices/{invoiceId}": {
          parameters: [pathParam("invoiceId")],
          get: {
            operationId: "getInvoice",
            summary: "Get invoice",
            responses: {
              "200": jsonResponse({ $ref: "#/components/schemas/Invoice" }),
              "404": { description: "Not found" },
            },
          },
        },
        // Scoped mutation + custom action paired with hoisted canonical GET
        "/v1/organizations/{organizationId}/members/{memberId}": {
          parameters: [pathParam("organizationId"), pathParam("memberId")],
          patch: {
            operationId: "updateOrgMember",
            summary: "Update org member",
            responses: {
              "200": jsonResponse({ $ref: "#/components/schemas/Member" }),
              "404": { description: "Not found" },
            },
          },
          delete: {
            operationId: "deleteOrgMember",
            summary: "Delete org member",
            responses: {
              "200": jsonResponse({
                type: "object",
                required: ["id", "deleted"],
                properties: { id: { type: "string" }, deleted: { type: "boolean" } },
              }),
              "404": { description: "Not found" },
            },
          },
        },
        "/v1/organizations/{organizationId}/members/{memberId}/suspend": {
          parameters: [pathParam("organizationId"), pathParam("memberId")],
          post: {
            operationId: "suspendOrgMember",
            summary: "Suspend org member",
            responses: {
              "200": jsonResponse({ $ref: "#/components/schemas/Member" }),
              "404": { description: "Not found" },
            },
          },
        },
        "/v1/members/{memberId}": {
          parameters: [pathParam("memberId")],
          get: {
            operationId: "getMember",
            summary: "Get member",
            responses: {
              "200": jsonResponse({ $ref: "#/components/schemas/Member" }),
              "404": { description: "Not found" },
            },
          },
        },
        // Non-id lookup lists (excluded without false positives)
        "/v1/scopes": {
          get: {
            operationId: "listScopes",
            summary: "List permission scopes",
            responses: {
              "200": jsonResponse({
                type: "object",
                required: ["items"],
                properties: {
                  items: {
                    type: "array",
                    items: {
                      type: "object",
                      required: ["name", "description"],
                      properties: {
                        name: { type: "string" },
                        description: { type: "string" },
                      },
                    },
                  },
                },
              }),
            },
          },
        },
        "/v1/countries": {
          get: {
            operationId: "listCountries",
            summary: "List supported countries",
            responses: {
              "200": jsonResponse({
                type: "object",
                required: ["items"],
                properties: {
                  items: {
                    type: "array",
                    items: {
                      type: "object",
                      required: ["code", "name"],
                      properties: {
                        code: { type: "string" },
                        name: { type: "string" },
                      },
                    },
                  },
                },
              }),
            },
          },
        },
        "/v1/recommendations": {
          get: {
            operationId: "listRecommendations",
            summary: "List recommendations",
            responses: {
              "200": jsonResponse({
                type: "object",
                required: ["items"],
                properties: {
                  items: {
                    type: "array",
                    items: {
                      type: "object",
                      required: ["title", "score"],
                      properties: {
                        title: { type: "string" },
                        score: { type: "number" },
                      },
                    },
                  },
                },
              }),
            },
          },
        },
        // Composite summary (extra non-metadata properties) & single resource with nested array
        "/v1/projects/{projectId}/dashboard-summary": {
          parameters: [pathParam("projectId")],
          get: {
            operationId: "getDashboardSummary",
            summary: "Composite summary with nested list and metrics",
            responses: {
              "200": jsonResponse({
                type: "object",
                required: ["projectId", "invoices", "totalCents"],
                properties: {
                  projectId: { type: "string" },
                  invoices: {
                    type: "array",
                    items: { $ref: "#/components/schemas/InvoiceSummary" },
                  },
                  totalCents: { type: "integer" },
                },
              }),
              "404": { description: "Not found" },
            },
          },
        },
        "/v1/projects/{projectId}/config": {
          parameters: [pathParam("projectId")],
          get: {
            operationId: "getProjectConfig",
            summary: "Single resource with its own id and nested array",
            responses: {
              "200": jsonResponse({
                type: "object",
                required: ["id", "rules"],
                properties: {
                  id: { type: "string" },
                  rules: {
                    type: "array",
                    items: {
                      type: "object",
                      required: ["id", "name"],
                      properties: { id: { type: "string" }, name: { type: "string" } },
                    },
                  },
                },
              }),
              "404": { description: "Not found" },
            },
          },
        },
        // Singleton with GET + PATCH and bodyless DELETE
        "/v1/projects/{projectId}/agent-profile": {
          parameters: [pathParam("projectId")],
          get: {
            operationId: "getAgentProfile",
            summary: "Get agent profile",
            responses: {
              "200": jsonResponse({ $ref: "#/components/schemas/AgentProfile" }),
              "404": { description: "Not found" },
            },
          },
          patch: {
            operationId: "updateAgentProfile",
            summary: "Update agent profile",
            responses: {
              "200": jsonResponse({ $ref: "#/components/schemas/AgentProfile" }),
              "404": { description: "Not found" },
            },
          },
          delete: {
            operationId: "resetAgentProfile",
            summary: "Delete singleton agent profile without body",
            responses: {
              "204": { description: "Deleted" },
              "404": { description: "Not found" },
            },
          },
        },
        // Safe non-CRUD domain paths and non-collection POST returning 200
        "/v1/addresses": {
          get: {
            operationId: "listAddresses",
            summary: "List addresses",
            responses: {
              "200": jsonResponse({
                type: "object",
                properties: {
                  items: {
                    type: "array",
                    items: {
                      type: "object",
                      properties: { line1: { type: "string" }, city: { type: "string" } },
                    },
                  },
                },
              }),
            },
          },
        },
        "/v1/projects/{projectId}/deletion-check": {
          parameters: [pathParam("projectId")],
          get: {
            operationId: "getDeletionCheck",
            summary: "Check deletion readiness",
            responses: {
              "200": jsonResponse({
                type: "object",
                properties: { canDelete: { type: "boolean" } },
              }),
              "404": { description: "Not found" },
            },
          },
        },
        "/v1/projects/{projectId}/webhooks/preview": {
          parameters: [pathParam("projectId")],
          post: {
            operationId: "previewWebhook",
            summary: "Preview webhook payload (custom action, 200 allowed)",
            responses: {
              "200": jsonResponse({
                type: "object",
                properties: { delivered: { type: "boolean" } },
              }),
              "400": { description: "Bad request" },
            },
          },
        },
        "/.well-known/openid-configuration": {
          get: {
            operationId: "getOidcConfig",
            summary: "OIDC discovery document",
            responses: {
              "200": jsonResponse({
                type: "object",
                properties: { issuer: { type: "string" } },
              }),
            },
          },
        },
      },
      components: {
        schemas: {
          Project: {
            type: "object",
            required: ["id", "organizationId", "name"],
            properties: {
              id: { type: "string" },
              organizationId: { type: "string" },
              name: { type: "string" },
            },
          },
          InvoiceSummary: {
            type: "object",
            required: ["id", "status", "totalCents"],
            properties: {
              id: { type: "string" },
              status: { type: "string" },
              totalCents: { type: "integer" },
            },
          },
          Invoice: {
            type: "object",
            required: ["id", "organizationId", "status", "totalCents", "currency"],
            properties: {
              id: { type: "string" },
              organizationId: { type: "string" },
              status: { type: "string" },
              totalCents: { type: "integer" },
              currency: { type: "string" },
              pdfUrl: { type: ["string", "null"] },
            },
          },
          Member: {
            type: "object",
            required: ["id", "organizationId", "role"],
            properties: {
              id: { type: "string" },
              organizationId: { type: "string" },
              role: { type: "string" },
            },
          },
          AgentProfile: {
            type: "object",
            required: ["projectId", "displayName"],
            properties: {
              projectId: { type: "string" },
              displayName: { type: "string" },
            },
          },
        },
      },
    });

    const { exitCode, report } = await lintOpenApi(doc);
    expect(ads0005Problems(report)).toEqual([]);
    expect(exitCode).toBe(0);
  });

  it("enforces ads-0005-addressable-resource-read for item mutations, singletons, custom actions, and addressable collections", async () => {
    const doc = baseOpenApi({
      paths: {
        // Item PATCH without GET
        "/v1/projects/{projectId}/members/{memberId}": {
          parameters: [pathParam("projectId"), pathParam("memberId")],
          patch: {
            operationId: "patchMemberNoGet",
            summary: "Patch member without GET",
            responses: {
              "200": jsonResponse({
                type: "object",
                required: ["id", "role"],
                properties: { id: { type: "string" }, role: { type: "string" } },
              }),
              "404": { description: "Not found" },
            },
          },
        },
        // Item DELETE without GET
        "/v1/projects/{projectId}/tokens/{tokenId}": {
          parameters: [pathParam("projectId"), pathParam("tokenId")],
          delete: {
            operationId: "deleteTokenNoGet",
            summary: "Delete token without GET",
            responses: {
              "204": { description: "Deleted" },
              "404": { description: "Not found" },
            },
          },
        },
        // Custom action sub-route without item GET
        "/v1/projects/{projectId}/invitations/{invitationId}/revoke": {
          parameters: [pathParam("projectId"), pathParam("invitationId")],
          post: {
            operationId: "revokeInvitationNoGet",
            summary: "Revoke invitation without GET",
            responses: {
              "200": jsonResponse({
                type: "object",
                properties: { revoked: { type: "boolean" } },
              }),
              "404": { description: "Not found" },
            },
          },
        },
        // Singleton PATCH without GET
        "/v1/projects/{projectId}/agent-profile": {
          parameters: [pathParam("projectId")],
          patch: {
            operationId: "patchSingletonNoGet",
            summary: "Patch singleton without GET",
            responses: {
              "200": jsonResponse({
                type: "object",
                properties: { displayName: { type: "string" } },
              }),
              "404": { description: "Not found" },
            },
          },
        },
        // Singleton bodyless DELETE without GET
        "/v1/projects/{projectId}/branding": {
          parameters: [pathParam("projectId")],
          delete: {
            operationId: "deleteSingletonNoGet",
            summary: "Delete singleton without GET",
            responses: {
              "204": { description: "Deleted" },
              "404": { description: "Not found" },
            },
          },
        },
        // Collection DELETE with requestBody should NOT double-report in Rule 1 (Rule 2 handles it)
        "/v1/projects/{projectId}/bulk-items": {
          parameters: [pathParam("projectId")],
          delete: {
            operationId: "bulkDeleteWithBody",
            summary: "Collection DELETE with body",
            requestBody: {
              required: true,
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    properties: { itemIds: { type: "array", items: { type: "string" } } },
                  },
                },
              },
            },
            responses: {
              "204": { description: "Deleted" },
              "400": { description: "Bad request" },
            },
          },
        },
        // Addressable collection GET with no direct or hoisted item GET
        "/v1/organizations/{organizationId}/api-keys": {
          parameters: [pathParam("organizationId")],
          get: {
            operationId: "listOrgApiKeys",
            summary: "List API keys without item GET",
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
                      properties: { id: { type: "string" }, name: { type: "string" } },
                    },
                  },
                  nextPageToken: { type: ["string", "null"] },
                },
              }),
              "404": { description: "Not found" },
            },
          },
        },
      },
    });

    const { exitCode, report } = await lintOpenApi(doc);
    expect(exitCode).toBe(1);
    const readErrors = ads0005ProblemsFor(report, "ads-0005-addressable-resource-read");
    const messages = readErrors.map((e) => e.message);

    expect(readErrors).toHaveLength(6);
    expect(
      messages.some(
        (m) =>
          m.includes('PATCH "/v1/projects/{projectId}/members/{memberId}"') &&
          m.includes("GET /v1/projects/{projectId}/members/{memberId}") &&
          m.includes("GET /v1/members/{memberId}"),
      ),
    ).toBe(true);
    expect(
      messages.some((m) => m.includes('DELETE "/v1/projects/{projectId}/tokens/{tokenId}"')),
    ).toBe(true);
    expect(
      messages.some(
        (m) =>
          m.includes('POST "/v1/projects/{projectId}/invitations/{invitationId}/revoke"') &&
          m.includes("GET /v1/projects/{projectId}/invitations/{invitationId}") &&
          m.includes("GET /v1/invitations/{invitationId}"),
      ),
    ).toBe(true);
    expect(
      messages.some(
        (m) =>
          m.includes('PATCH "/v1/projects/{projectId}/agent-profile"') &&
          m.includes("GET /v1/projects/{projectId}/agent-profile"),
      ),
    ).toBe(true);
    expect(messages.some((m) => m.includes('DELETE "/v1/projects/{projectId}/branding"'))).toBe(
      true,
    );
    expect(
      messages.some(
        (m) =>
          m.includes('GET "/v1/organizations/{organizationId}/api-keys"') &&
          m.includes("GET /v1/organizations/{organizationId}/api-keys/{apiKeyId}") &&
          m.includes("GET /v1/api-keys/{apiKeyId}"),
      ),
    ).toBe(true);
    // Bulk DELETE with requestBody is not double-reported by Rule 1
    expect(messages.some((m) => m.includes("/bulk-items"))).toBe(false);
  });

  it("rejects incompatible hoisted canonical GET schemas when matching scoped collections or mutations", async () => {
    const doc = baseOpenApi({
      paths: {
        // Case 1: Completely unrelated schemas sharing the path name "items"
        "/v1/organizations/{organizationId}/items": {
          parameters: [pathParam("organizationId")],
          get: {
            operationId: "listOrgItems",
            summary: "List org items",
            responses: {
              "200": jsonResponse({
                type: "object",
                properties: {
                  items: { type: "array", items: { $ref: "#/components/schemas/OrgAlertItem" } },
                },
              }),
            },
          },
        },
        "/v1/items/{itemId}": {
          parameters: [pathParam("itemId")],
          get: {
            operationId: "getCatalogItem",
            summary: "Get unrelated catalog item",
            responses: {
              "200": jsonResponse({ $ref: "#/components/schemas/CatalogItem" }),
            },
          },
        },
        // Case 2: Required property on list item has disjoint type on hoisted GET
        "/v1/organizations/{organizationId}/orders": {
          parameters: [pathParam("organizationId")],
          get: {
            operationId: "listOrgOrders",
            summary: "List org orders",
            responses: {
              "200": jsonResponse({
                type: "object",
                properties: {
                  items: {
                    type: "array",
                    items: {
                      type: "object",
                      required: ["id", "total"],
                      properties: { id: { type: "string" }, total: { type: "string" } },
                    },
                  },
                },
              }),
            },
          },
        },
        "/v1/orders/{orderId}": {
          parameters: [pathParam("orderId")],
          get: {
            operationId: "getOrder",
            summary: "Get order with incompatible total type",
            responses: {
              "200": jsonResponse({
                type: "object",
                required: ["id", "total"],
                properties: { id: { type: "string" }, total: { type: "integer" } },
              }),
            },
          },
        },
        // Case 3: Disjoint id types (string vs integer)
        "/v1/organizations/{organizationId}/widgets": {
          parameters: [pathParam("organizationId")],
          get: {
            operationId: "listOrgWidgets",
            summary: "List widgets",
            responses: {
              "200": jsonResponse({
                type: "object",
                properties: {
                  items: {
                    type: "array",
                    items: {
                      type: "object",
                      required: ["id", "name"],
                      properties: { id: { type: "string" }, name: { type: "string" } },
                    },
                  },
                },
              }),
            },
          },
        },
        "/v1/widgets/{widgetId}": {
          parameters: [pathParam("widgetId")],
          get: {
            operationId: "getWidget",
            summary: "Get widget with integer id",
            responses: {
              "200": jsonResponse({
                type: "object",
                required: ["id", "name"],
                properties: { id: { type: "integer" }, name: { type: "string" } },
              }),
            },
          },
        },
        // Case 4: Scoped PATCH returning unrelated schema from hoisted GET
        "/v1/organizations/{organizationId}/items/{itemId}": {
          parameters: [pathParam("organizationId"), pathParam("itemId")],
          patch: {
            operationId: "patchOrgAlertItem",
            summary: "Patch unrelated org alert item",
            responses: {
              "200": jsonResponse({ $ref: "#/components/schemas/OrgAlertItem" }),
            },
          },
        },
      },
      components: {
        schemas: {
          OrgAlertItem: {
            type: "object",
            properties: {
              id: { type: "string" },
              severity: { type: "string" },
            },
          },
          CatalogItem: {
            type: "object",
            properties: {
              id: { type: "string" },
              sku: { type: "string" },
              priceCents: { type: "integer" },
            },
          },
        },
      },
    });

    const { exitCode, report } = await lintOpenApi(doc);
    expect(exitCode).toBe(1);
    const readErrors = ads0005ProblemsFor(report, "ads-0005-addressable-resource-read");
    const messages = readErrors.map((e) => e.message);

    expect(readErrors).toHaveLength(4);
    expect(messages.some((m) => m.includes('GET "/v1/organizations/{organizationId}/items"'))).toBe(
      true,
    );
    expect(
      messages.some((m) => m.includes('GET "/v1/organizations/{organizationId}/orders"')),
    ).toBe(true);
    expect(
      messages.some((m) => m.includes('GET "/v1/organizations/{organizationId}/widgets"')),
    ).toBe(true);
    expect(
      messages.some((m) => m.includes('PATCH "/v1/organizations/{organizationId}/items/{itemId}"')),
    ).toBe(true);
  });

  it("enforces ads-0005-standard-http-methods for CRUD verbs, PUT+PATCH collisions, GET requestBody, and collection DELETE requestBody", async () => {
    const doc = baseOpenApi({
      paths: {
        "/v1/projects/create-project": {
          post: {
            operationId: "rpcCreateProject",
            summary: "RPC create path",
            responses: { "201": jsonResponse({ type: "object" }, "Created") },
          },
        },
        "/v1/getUser": {
          get: {
            operationId: "rpcGetUser",
            summary: "RPC get path",
            responses: { "200": jsonResponse({ type: "object" }) },
          },
        },
        "/v1/projects/{projectId}/list": {
          parameters: [pathParam("projectId")],
          get: {
            operationId: "rpcList",
            summary: "Bare CRUD verb segment",
            responses: { "200": jsonResponse({ type: "object" }) },
          },
        },
        "/v1/projects/{projectId}/webhooks/{webhookId}": {
          parameters: [pathParam("projectId"), pathParam("webhookId")],
          get: {
            operationId: "getWebhookWithBody",
            summary: "GET with requestBody",
            requestBody: {
              content: {
                "application/json": { schema: { type: "object" } },
              },
            },
            responses: { "200": jsonResponse({ type: "object" }) },
          },
          put: {
            operationId: "putWebhook",
            summary: "PUT colliding with PATCH",
            responses: { "200": jsonResponse({ type: "object" }) },
          },
          patch: {
            operationId: "patchWebhook",
            summary: "PATCH colliding with PUT",
            responses: { "200": jsonResponse({ type: "object" }) },
          },
        },
        "/v1/projects/{projectId}/webhooks": {
          parameters: [pathParam("projectId")],
          delete: {
            operationId: "deleteWebhooksWithBody",
            summary: "Collection DELETE with requestBody",
            requestBody: {
              $ref: "#/components/requestBodies/BulkDeleteBody",
            },
            responses: { "204": { description: "Deleted" } },
          },
        },
      },
      components: {
        requestBodies: {
          BulkDeleteBody: {
            required: true,
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: { webhookIds: { type: "array", items: { type: "string" } } },
                },
              },
            },
          },
        },
      },
    });

    const { exitCode, report } = await lintOpenApi(doc);
    expect(exitCode).toBe(1);
    const methodErrors = ads0005ProblemsFor(report, "ads-0005-standard-http-methods");
    const messages = methodErrors.map((e) => e.message);

    expect(methodErrors).toHaveLength(6);
    expect(messages.some((m) => m.includes('segment "create-project"'))).toBe(true);
    expect(messages.some((m) => m.includes('segment "getUser"'))).toBe(true);
    expect(messages.some((m) => m.includes('segment "list"'))).toBe(true);
    expect(messages.some((m) => m.includes("declares both PUT and PATCH"))).toBe(true);
    expect(
      messages.some(
        (m) =>
          m.includes('GET "/v1/projects/{projectId}/webhooks/{webhookId}"') &&
          m.includes("requestBody"),
      ),
    ).toBe(true);
    expect(
      messages.some(
        (m) =>
          m.includes('DELETE "/v1/projects/{projectId}/webhooks"') && m.includes("requestBody"),
      ),
    ).toBe(true);
  });

  it("enforces ads-0005-standard-status-codes across GET, collection POST, PATCH, and DELETE", async () => {
    const doc = baseOpenApi({
      paths: {
        // GET declaring 201 and 202
        "/v1/projects/{projectId}/status": {
          parameters: [pathParam("projectId")],
          get: {
            operationId: "getBadStatuses",
            summary: "GET with 201 and 202",
            responses: {
              "201": jsonResponse({ type: "object" }),
              "202": jsonResponse({ type: "object" }),
            },
          },
        },
        // Collection POST (paired with GET) returning only 200
        "/v1/projects/{projectId}/webhooks": {
          parameters: [pathParam("projectId")],
          get: {
            operationId: "listWebhooks",
            summary: "List webhooks",
            responses: {
              "200": jsonResponse({
                type: "object",
                properties: {
                  items: {
                    type: "array",
                    items: { type: "object", properties: { name: { type: "string" } } },
                  },
                },
              }),
            },
          },
          post: {
            operationId: "createWebhookOnly200",
            summary: "Collection creation returning only 200",
            responses: {
              "200": jsonResponse({ type: "object", properties: { id: { type: "string" } } }),
            },
          },
        },
        // Collection POST (paired with child {param}) returning only 204
        "/v1/projects/{projectId}/alerts": {
          parameters: [pathParam("projectId")],
          post: {
            operationId: "createAlertOnly204",
            summary: "Collection creation returning only 204",
            responses: {
              "204": { description: "No content" },
            },
          },
        },
        "/v1/projects/{projectId}/alerts/{alertId}": {
          parameters: [pathParam("projectId"), pathParam("alertId")],
          get: {
            operationId: "getAlert",
            summary: "Get alert",
            responses: {
              "200": jsonResponse({ type: "object", properties: { id: { type: "string" } } }),
            },
          },
          // PATCH returning 204
          patch: {
            operationId: "patchAlert204",
            summary: "PATCH with 204",
            responses: {
              "204": { description: "No content" },
            },
          },
          // DELETE returning 201 and 204 with content body (via $ref)
          delete: {
            operationId: "deleteAlertBad",
            summary: "DELETE with 201 and 204 body",
            responses: {
              "201": jsonResponse({ type: "object" }),
              "204": { $ref: "#/components/responses/NoContentWithBody" },
            },
          },
        },
        // PATCH 200 without response content body
        "/v1/projects/{projectId}/agent-profile": {
          parameters: [pathParam("projectId")],
          get: {
            operationId: "getProfile",
            summary: "Get profile",
            responses: { "200": jsonResponse({ type: "object" }) },
          },
          patch: {
            operationId: "patchProfileEmpty200",
            summary: "PATCH 200 missing content",
            responses: {
              "200": { description: "Updated without content" },
            },
          },
        },
      },
      components: {
        responses: {
          NoContentWithBody: {
            description: "Invalid 204 with body",
            content: {
              "application/json": {
                schema: { type: "object", properties: { deleted: { type: "boolean" } } },
              },
            },
          },
        },
      },
    });

    const { exitCode, report } = await lintOpenApi(doc);
    expect(exitCode).toBe(1);
    const statusErrors = ads0005ProblemsFor(report, "ads-0005-standard-status-codes");
    const messages = statusErrors.map((e) => e.message);

    expect(statusErrors).toHaveLength(8);
    expect(
      messages.some(
        (m) => m.includes('GET "/v1/projects/{projectId}/status"') && m.includes('"201"'),
      ),
    ).toBe(true);
    expect(
      messages.some(
        (m) => m.includes('GET "/v1/projects/{projectId}/status"') && m.includes('"202"'),
      ),
    ).toBe(true);
    expect(
      messages.some(
        (m) =>
          m.includes('POST "/v1/projects/{projectId}/webhooks"') &&
          m.includes('"201"') &&
          m.includes('"200"'),
      ),
    ).toBe(true);
    expect(
      messages.some(
        (m) =>
          m.includes('POST "/v1/projects/{projectId}/alerts"') &&
          m.includes('"201"') &&
          m.includes('"204"'),
      ),
    ).toBe(true);
    expect(
      messages.some(
        (m) =>
          m.includes('PATCH "/v1/projects/{projectId}/alerts/{alertId}"') &&
          m.includes('"204 No Content"'),
      ),
    ).toBe(true);
    expect(
      messages.some(
        (m) =>
          m.includes('PATCH "/v1/projects/{projectId}/agent-profile"') &&
          m.includes('without a response "content" body'),
      ),
    ).toBe(true);
    expect(
      messages.some(
        (m) =>
          m.includes('DELETE "/v1/projects/{projectId}/alerts/{alertId}"') &&
          m.includes('"201 Created"'),
      ),
    ).toBe(true);
    expect(
      messages.some(
        (m) =>
          m.includes('DELETE "/v1/projects/{projectId}/alerts/{alertId}"') &&
          m.includes('"204 No Content"'),
      ),
    ).toBe(true);
  });

  it("enforces ads-0005-url-path-naming for camelCase, snake_case, uppercase, dots, and spaces", async () => {
    const doc = baseOpenApi({
      paths: {
        "/v1/projects/{projectId}/apiKeys": {
          parameters: [pathParam("projectId")],
          get: {
            operationId: "getCamel",
            summary: "camelCase segment",
            responses: { "200": jsonResponse({ type: "object" }) },
          },
        },
        "/v1/projects/{projectId}/api_keys": {
          parameters: [pathParam("projectId")],
          get: {
            operationId: "getSnake",
            summary: "snake_case segment",
            responses: { "200": jsonResponse({ type: "object" }) },
          },
        },
        "/V1/Projects": {
          get: {
            operationId: "getUppercase",
            summary: "Uppercase version and resource segment",
            responses: { "200": jsonResponse({ type: "object" }) },
          },
        },
        "/v1/webhooks.v1": {
          get: {
            operationId: "getDot",
            summary: "Dotted segment",
            responses: { "200": jsonResponse({ type: "object" }) },
          },
        },
      },
    });

    const { exitCode, report } = await lintOpenApi(doc);
    expect(exitCode).toBe(1);
    const namingErrors = ads0005ProblemsFor(report, "ads-0005-url-path-naming");
    const messages = namingErrors.map((e) => e.message);

    expect(namingErrors).toHaveLength(5);
    expect(messages.some((m) => m.includes('segment "apiKeys"'))).toBe(true);
    expect(messages.some((m) => m.includes('segment "api_keys"'))).toBe(true);
    expect(messages.some((m) => m.includes('segment "V1"'))).toBe(true);
    expect(messages.some((m) => m.includes('segment "Projects"'))).toBe(true);
    expect(messages.some((m) => m.includes('segment "webhooks.v1"'))).toBe(true);
  });

  it("supports declarative path and optional method ignore options across all four ADS-0005 rules", async () => {
    const configPath = await writeRedoclyConfig({
      "photon-ads/ads-0005-addressable-resource-read": {
        severity: "error",
        ignore: [
          {
            path: "/v1/projects/{projectId}/audit-events",
            method: "get",
            reason: "Append-only audit stream without single-item GET",
          },
          {
            path: "/v1/projects/{projectId}/legacy-profile",
            method: "patch",
            reason: "Legacy write-only profile",
          },
        ],
      },
      "photon-ads/ads-0005-standard-http-methods": {
        severity: "error",
        ignore: [
          {
            path: "/v1/legacy/create-widget",
            method: "post",
            reason: "Legacy RPC path pending deprecation",
          },
          {
            path: "/v1/projects/{projectId}/legacy-dual",
            method: "put",
            reason: "Transitional PUT beside PATCH",
          },
        ],
      },
      "photon-ads/ads-0005-standard-status-codes": {
        severity: "error",
        ignore: [
          {
            path: "/v1/projects/{projectId}/legacy-profile",
            method: "patch",
            reason: "Legacy 204 patch response",
          },
        ],
      },
      "photon-ads/ads-0005-url-path-naming": {
        severity: "error",
        ignore: [
          {
            path: "/v1/projects/{projectId}/legacyKeys",
            reason: "Legacy camelCase path",
          },
        ],
      },
    });

    const doc = baseOpenApi({
      paths: {
        // Ignored append-only stream
        "/v1/projects/{projectId}/audit-events": {
          parameters: [pathParam("projectId")],
          get: {
            operationId: "listAuditEvents",
            summary: "Ignored audit stream",
            responses: {
              "200": jsonResponse({
                type: "object",
                properties: {
                  items: {
                    type: "array",
                    items: {
                      type: "object",
                      required: ["id", "action"],
                      properties: { id: { type: "string" }, action: { type: "string" } },
                    },
                  },
                },
              }),
            },
          },
        },
        // Non-ignored stream MUST still fail
        "/v1/projects/{projectId}/active-events": {
          parameters: [pathParam("projectId")],
          get: {
            operationId: "listActiveEvents",
            summary: "Non-ignored addressable collection",
            responses: {
              "200": jsonResponse({
                type: "object",
                properties: {
                  items: {
                    type: "array",
                    items: {
                      type: "object",
                      required: ["id", "action"],
                      properties: { id: { type: "string" }, action: { type: "string" } },
                    },
                  },
                },
              }),
            },
          },
        },
        // Ignored singleton PATCH + 204
        "/v1/projects/{projectId}/legacy-profile": {
          parameters: [pathParam("projectId")],
          patch: {
            operationId: "patchLegacyProfile",
            summary: "Ignored legacy patch",
            responses: { "204": { description: "No content" } },
          },
        },
        // Ignored RPC verb path
        "/v1/legacy/create-widget": {
          post: {
            operationId: "legacyCreateWidget",
            summary: "Ignored legacy create verb",
            responses: { "201": jsonResponse({ type: "object" }, "Created") },
          },
        },
        // Ignored PUT+PATCH dual method
        "/v1/projects/{projectId}/legacy-dual": {
          parameters: [pathParam("projectId")],
          get: {
            operationId: "getLegacyDual",
            summary: "Get legacy dual",
            responses: { "200": jsonResponse({ type: "object" }) },
          },
          put: {
            operationId: "putLegacyDual",
            summary: "Ignored PUT",
            responses: { "200": jsonResponse({ type: "object" }) },
          },
          patch: {
            operationId: "patchLegacyDual",
            summary: "PATCH beside ignored PUT",
            responses: { "200": jsonResponse({ type: "object" }) },
          },
        },
        // Ignored camelCase path
        "/v1/projects/{projectId}/legacyKeys": {
          parameters: [pathParam("projectId")],
          get: {
            operationId: "getLegacyKeys",
            summary: "Ignored camelCase path",
            responses: { "200": jsonResponse({ type: "object" }) },
          },
        },
        // Non-ignored camelCase path MUST still fail
        "/v1/projects/{projectId}/badKeys": {
          parameters: [pathParam("projectId")],
          get: {
            operationId: "getBadKeys",
            summary: "Non-ignored camelCase path",
            responses: { "200": jsonResponse({ type: "object" }) },
          },
        },
      },
    });

    const { exitCode, report } = await lintOpenApi(doc, configPath);
    expect(exitCode).toBe(1);
    const errors = ads0005Problems(report);
    const messages = errors.map((e) => e.message);

    expect(errors).toHaveLength(2);
    expect(messages.some((m) => m.includes("audit-events"))).toBe(false);
    expect(messages.some((m) => m.includes("legacy-profile"))).toBe(false);
    expect(messages.some((m) => m.includes("create-widget"))).toBe(false);
    expect(messages.some((m) => m.includes("legacy-dual"))).toBe(false);
    expect(messages.some((m) => m.includes("legacyKeys"))).toBe(false);

    expect(messages.some((m) => m.includes("active-events"))).toBe(true);
    expect(messages.some((m) => m.includes("badKeys"))).toBe(true);
  });

  it("handles OpenAPI 3.0 nullable schemas and external $ref PathItems with negative control", async () => {
    const externalPathItemPath = join(tempDir, "org-projects-path-item.yaml");
    await writeFile(
      externalPathItemPath,
      stringifyYaml({
        parameters: [pathParam("organizationId")],
        get: {
          operationId: "listOas30Projects",
          summary: "List OAS 3.0 projects",
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
                    },
                  },
                },
                nextPageToken: { type: "string", nullable: true },
              },
            }),
            "404": { description: "Not found" },
          },
        },
      }),
      "utf8",
    );

    const validDoc = baseOpenApi({
      openapi: "3.0.3",
      paths: {
        "/v1/organizations/{organizationId}/projects": {
          $ref: "./org-projects-path-item.yaml",
        },
        "/v1/projects/{projectId}": {
          parameters: [pathParam("projectId")],
          get: {
            operationId: "getOas30Project",
            summary: "Get OAS 3.0 project",
            responses: {
              "200": jsonResponse({
                type: "object",
                required: ["id", "name"],
                properties: {
                  id: { type: "string" },
                  name: { type: "string" },
                  description: { type: "string", nullable: true },
                },
              }),
              "404": { description: "Not found" },
            },
          },
        },
      },
    });

    const { exitCode, report } = await lintOpenApi(validDoc);
    expect(exitCode).toBe(0);
    expect(ads0005Problems(report)).toEqual([]);

    // Negative control: removing the hoisted GET must flag the referenced Path Item list.
    const missingGetDoc = baseOpenApi({
      openapi: "3.0.3",
      paths: {
        "/v1/organizations/{organizationId}/projects": {
          $ref: "./org-projects-path-item.yaml",
        },
      },
    });
    const missingRes = await lintOpenApi(missingGetDoc);
    expect(missingRes.exitCode).toBe(1);
    expect(
      ads0005ProblemsFor(missingRes.report, "ads-0005-addressable-resource-read").some((e) =>
        e.message.includes('GET "/v1/organizations/{organizationId}/projects"'),
      ),
    ).toBe(true);
  });

  it("preserves distinct array item variants in oneOf unions, ignores dictionary maps, checks custom-method suffixes, and handles cyclic item schemas safely", async () => {
    const doc = baseOpenApi({
      paths: {
        // oneOf with non-id array branch AND id-bearing array branch MUST NOT drop the second branch
        "/v1/projects/{projectId}/mixed-list": {
          parameters: [pathParam("projectId")],
          get: {
            operationId: "listMixed",
            summary: "Union of lookup list and addressable resource list",
            responses: {
              "200": jsonResponse({
                oneOf: [
                  {
                    type: "object",
                    properties: {
                      items: {
                        type: "array",
                        items: {
                          type: "object",
                          properties: { code: { type: "string" } },
                        },
                      },
                    },
                  },
                  {
                    type: "object",
                    properties: {
                      items: {
                        type: "array",
                        items: {
                          type: "object",
                          required: ["id", "name"],
                          properties: { id: { type: "string" }, name: { type: "string" } },
                        },
                      },
                    },
                  },
                ],
              }),
            },
          },
        },
        // Open dictionary of arrays should NOT be treated as a collection envelope
        "/v1/projects/{projectId}/grouped-tags": {
          parameters: [pathParam("projectId")],
          get: {
            operationId: "getGroupedTags",
            summary: "Dictionary map of arrays",
            responses: {
              "200": jsonResponse({
                type: "object",
                properties: {
                  default: {
                    type: "array",
                    items: {
                      type: "object",
                      properties: { id: { type: "string" }, label: { type: "string" } },
                    },
                  },
                },
                additionalProperties: {
                  type: "array",
                  items: {
                    type: "object",
                    properties: { id: { type: "string" }, label: { type: "string" } },
                  },
                },
              }),
            },
          },
        },
        // Cyclic nested item schema paired with hoisted GET via single-element allOf $ref
        "/v1/organizations/{organizationId}/nodes": {
          parameters: [pathParam("organizationId")],
          get: {
            operationId: "listNodes",
            summary: "List cyclic nodes",
            responses: {
              "200": jsonResponse({
                type: "object",
                properties: {
                  items: {
                    type: "array",
                    items: { allOf: [{ $ref: "#/components/schemas/TreeNode" }] },
                  },
                },
              }),
            },
          },
        },
        "/v1/nodes/{nodeId}": {
          parameters: [pathParam("nodeId")],
          get: {
            operationId: "getNode",
            summary: "Get cyclic node",
            responses: {
              "200": jsonResponse({ $ref: "#/components/schemas/TreeNode" }),
            },
          },
        },
        // Custom method suffix CRUD verb and non-kebab casing
        "/v1/nodes/{nodeId}:delete": {
          parameters: [pathParam("nodeId")],
          post: {
            operationId: "deleteNodeCustom",
            summary: "Disallowed CRUD verb in custom method suffix",
            responses: { "200": jsonResponse({ type: "object" }) },
          },
        },
        "/v1/nodes/{nodeId}:Archive": {
          parameters: [pathParam("nodeId")],
          post: {
            operationId: "archiveNodeUpper",
            summary: "Uppercase custom method suffix",
            responses: { "200": jsonResponse({ type: "object" }) },
          },
        },
      },
      components: {
        schemas: {
          TreeNode: {
            type: "object",
            required: ["id", "label"],
            properties: {
              id: { type: "string" },
              label: { type: "string" },
              parent: {
                anyOf: [{ $ref: "#/components/schemas/TreeNode" }, { type: "null" }],
              },
            },
          },
        },
      },
    });

    const { report } = await lintOpenApi(doc);
    const readErrors = ads0005ProblemsFor(report, "ads-0005-addressable-resource-read");
    const methodErrors = ads0005ProblemsFor(report, "ads-0005-standard-http-methods");
    const namingErrors = ads0005ProblemsFor(report, "ads-0005-url-path-naming");

    expect(readErrors.some((e) => e.message.includes("/mixed-list"))).toBe(true);
    expect(readErrors.some((e) => e.message.includes("/grouped-tags"))).toBe(false);
    expect(readErrors.some((e) => e.message.includes("/nodes"))).toBe(false);
    expect(methodErrors.some((e) => e.message.includes("{nodeId}:delete"))).toBe(true);
    expect(namingErrors.some((e) => e.message.includes("{nodeId}:Archive"))).toBe(true);
  });

  it("validates hoisted GET schema compatibility for custom actions, soft DELETE, OAS 3.1 $ref siblings, and optional fields", async () => {
    const doc = baseOpenApi({
      paths: {
        // 1. Custom action returning addressable resource with string id vs hoisted GET with integer id
        "/v1/organizations/{organizationId}/items/{itemId}/archive": {
          parameters: [pathParam("organizationId"), pathParam("itemId")],
          post: {
            operationId: "archiveOrgItem",
            summary: "Archive org item returning incompatible resource schema",
            responses: {
              "200": jsonResponse({
                type: "object",
                required: ["id", "title"],
                properties: {
                  id: { type: "string" },
                  title: { type: "string" },
                },
              }),
            },
          },
        },
        // Compatible receipt-only custom action (no id) still passes with hoisted GET
        "/v1/organizations/{organizationId}/items/{itemId}/touch": {
          parameters: [pathParam("organizationId"), pathParam("itemId")],
          post: {
            operationId: "touchOrgItem",
            summary: "Receipt-only custom action",
            responses: {
              "200": jsonResponse({
                type: "object",
                properties: { touched: { type: "boolean" } },
              }),
            },
          },
        },
        "/v1/items/{itemId}": {
          parameters: [pathParam("itemId")],
          get: {
            operationId: "getCatalogItem",
            summary: "Unrelated hoisted GET with integer id",
            responses: {
              "200": jsonResponse({
                type: "object",
                required: ["id", "sku"],
                properties: {
                  id: { type: "integer" },
                  sku: { type: "string" },
                },
              }),
            },
          },
        },
        // 2. Scoped soft DELETE returning incompatible resource schema vs hoisted GET
        "/v1/organizations/{organizationId}/members/{memberId}": {
          parameters: [pathParam("organizationId"), pathParam("memberId")],
          delete: {
            operationId: "softDeleteOrgMember",
            summary: "Soft delete returning incompatible Member representation",
            responses: {
              "200": jsonResponse({
                type: "object",
                required: ["id", "email"],
                properties: {
                  id: { type: "string" },
                  email: { type: "string" },
                },
              }),
            },
          },
        },
        "/v1/members/{memberId}": {
          parameters: [pathParam("memberId")],
          get: {
            operationId: "getUnrelatedMember",
            summary: "Hoisted GET with incompatible integer id",
            responses: {
              "200": jsonResponse({
                type: "object",
                required: ["id", "email"],
                properties: {
                  id: { type: "integer" },
                  email: { type: "string" },
                },
              }),
            },
          },
        },
        // Valid scoped DELETE returning deletion receipt with matching string id passes
        "/v1/organizations/{organizationId}/tokens/{tokenId}": {
          parameters: [pathParam("organizationId"), pathParam("tokenId")],
          delete: {
            operationId: "deleteOrgToken",
            summary: "Delete token returning deletion receipt",
            responses: {
              "200": jsonResponse({
                type: "object",
                required: ["id", "deleted"],
                properties: {
                  id: { type: "string" },
                  deleted: { type: "boolean" },
                },
              }),
            },
          },
        },
        "/v1/tokens/{tokenId}": {
          parameters: [pathParam("tokenId")],
          get: {
            operationId: "getToken",
            summary: "Get token",
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
        // 3. OAS 3.1 $ref with sibling properties constraint overriding id type
        "/v1/organizations/{organizationId}/contacts": {
          parameters: [pathParam("organizationId")],
          get: {
            operationId: "listOrgContacts",
            summary: "List contacts with sibling string id constraint",
            responses: {
              "200": jsonResponse({
                type: "object",
                properties: {
                  items: {
                    type: "array",
                    items: {
                      $ref: "#/components/schemas/SharedContact",
                      properties: { id: { type: "string" } },
                    },
                  },
                },
              }),
            },
          },
        },
        "/v1/contacts/{contactId}": {
          parameters: [pathParam("contactId")],
          get: {
            operationId: "getContact",
            summary: "Get contact with sibling integer id constraint",
            responses: {
              "200": jsonResponse({
                $ref: "#/components/schemas/SharedContact",
                properties: { id: { type: "integer" } },
              }),
            },
          },
        },
        // 4. Shared optional field with disjoint type (score: string vs score: integer)
        "/v1/organizations/{organizationId}/leads": {
          parameters: [pathParam("organizationId")],
          get: {
            operationId: "listOrgLeads",
            summary: "List leads with optional string score",
            responses: {
              "200": jsonResponse({
                type: "object",
                properties: {
                  items: {
                    type: "array",
                    items: {
                      type: "object",
                      required: ["id", "name"],
                      properties: {
                        id: { type: "string" },
                        name: { type: "string" },
                        score: { type: "string" },
                      },
                    },
                  },
                },
              }),
            },
          },
        },
        "/v1/leads/{leadId}": {
          parameters: [pathParam("leadId")],
          get: {
            operationId: "getLead",
            summary: "Get lead with optional integer score",
            responses: {
              "200": jsonResponse({
                type: "object",
                required: ["id", "name"],
                properties: {
                  id: { type: "string" },
                  name: { type: "string" },
                  score: { type: "integer" },
                },
              }),
            },
          },
        },
      },
      components: {
        schemas: {
          SharedContact: {
            type: "object",
            required: ["name"],
            properties: {
              name: { type: "string" },
            },
          },
        },
      },
    });

    const { report } = await lintOpenApi(doc);
    const readErrors = ads0005ProblemsFor(report, "ads-0005-addressable-resource-read");
    const messages = readErrors.map((e) => e.message);

    expect(
      messages.some((m) =>
        m.includes('POST "/v1/organizations/{organizationId}/items/{itemId}/archive"'),
      ),
    ).toBe(true);
    expect(
      messages.some((m) =>
        m.includes('POST "/v1/organizations/{organizationId}/items/{itemId}/touch"'),
      ),
    ).toBe(false);
    expect(
      messages.some((m) =>
        m.includes('DELETE "/v1/organizations/{organizationId}/members/{memberId}"'),
      ),
    ).toBe(true);
    expect(
      messages.some((m) =>
        m.includes('DELETE "/v1/organizations/{organizationId}/tokens/{tokenId}"'),
      ),
    ).toBe(false);
    expect(
      messages.some((m) => m.includes('GET "/v1/organizations/{organizationId}/contacts"')),
    ).toBe(true);
    expect(messages.some((m) => m.includes('GET "/v1/organizations/{organizationId}/leads"'))).toBe(
      true,
    );
  });

  it("handles trailing slashes, local $ref PathItem siblings, async actions, impossible array branches, search POST, missing 2xx creation POST, variant cap, and diamond allOf DAGs", async () => {
    const sharedPathItemFile = join(tempDir, "shared-profile-path-item.yaml");
    await writeFile(
      sharedPathItemFile,
      stringifyYaml({
        get: {
          operationId: "getSharedProfile",
          summary: "Get shared profile",
          responses: {
            "200": jsonResponse({
              type: "object",
              properties: { displayName: { type: "string" } },
            }),
          },
        },
      }),
      "utf8",
    );

    // 24-level diamond allOf DAG (2^24 naive paths; must complete linearly with memoization)
    const diamondSchemas: Record<string, unknown> = {
      Diamond0: {
        type: "object",
        required: ["id", "name"],
        properties: {
          id: { type: "string" },
          name: { type: "string" },
        },
      },
    };
    for (let i = 1; i <= 24; i += 1) {
      diamondSchemas[`Diamond${i}`] = {
        allOf: [
          { $ref: `#/components/schemas/Diamond${i - 1}` },
          { $ref: `#/components/schemas/Diamond${i - 1}` },
        ],
      };
    }

    // 260 distinct anyOf branches with an addressable collection at the tail (index 259)
    const overflowBranches: unknown[] = [];
    for (let i = 0; i < 259; i += 1) {
      overflowBranches.push({
        type: "object",
        properties: { [`flag${i}`]: { type: "string" } },
      });
    }
    overflowBranches.push({
      type: "object",
      properties: {
        items: {
          type: "array",
          items: {
            type: "object",
            properties: { id: { type: "string" }, label: { type: "string" } },
          },
        },
      },
    });

    const doc = baseOpenApi({
      paths: {
        // 1. Trailing-slash mismatch: PATCH /v1/profile must NOT be satisfied by GET /v1/profile/
        "/v1/profile": {
          patch: {
            operationId: "patchProfileNoSlash",
            summary: "Patch profile without trailing slash",
            responses: {
              "200": jsonResponse({
                type: "object",
                properties: { displayName: { type: "string" } },
              }),
            },
          },
        },
        "/v1/profile/": {
          get: {
            operationId: "getProfileWithSlash",
            summary: "Get profile with trailing slash",
            responses: {
              "200": jsonResponse({
                type: "object",
                properties: { displayName: { type: "string" } },
              }),
            },
          },
        },
        // 2. Local sibling PATCH on a referenced Path Item must be inspected
        "/v1/projects/{projectId}/shared-profile": {
          $ref: "./shared-profile-path-item.yaml",
          parameters: [pathParam("projectId")],
          patch: {
            operationId: "patchSharedProfile204",
            summary: "Local sibling PATCH returning disallowed 204",
            responses: {
              "204": { description: "No content" },
            },
          },
        },
        // 3. Recognized item action returning only 202 without Location still requires parent GET
        "/v1/api-keys/{apiKeyId}/revoke": {
          parameters: [pathParam("apiKeyId")],
          post: {
            operationId: "revokeApiKeyAsync",
            summary: "Async revoke without parent GET",
            responses: {
              "202": { description: "Accepted" },
            },
          },
        },
        // 4. Impossible string-only anyOf branch inside array property must not hide item id
        "/v1/projects/{projectId}/filtered-widgets": {
          parameters: [pathParam("projectId")],
          get: {
            operationId: "listFilteredWidgets",
            summary: "Array with impossible string-only anyOf alternative",
            responses: {
              "200": jsonResponse({
                type: "object",
                properties: {
                  items: {
                    type: "array",
                    anyOf: [
                      {
                        items: {
                          type: "object",
                          properties: { id: { type: "string" }, name: { type: "string" } },
                        },
                      },
                      {
                        type: "string",
                        items: {
                          type: "object",
                          properties: { label: { type: "string" } },
                        },
                      },
                    ],
                  },
                },
              }),
            },
          },
        },
        // 5. GET + POST on /search must NOT require 201/202 on POST
        "/v1/projects/{projectId}/search": {
          parameters: [pathParam("projectId")],
          get: {
            operationId: "simpleSearch",
            summary: "Simple query search",
            responses: {
              "200": jsonResponse({
                type: "object",
                properties: {
                  results: {
                    type: "array",
                    items: { type: "object", properties: { title: { type: "string" } } },
                  },
                },
              }),
            },
          },
          post: {
            operationId: "complexSearch",
            summary: "Complex query search",
            responses: {
              "200": jsonResponse({
                type: "object",
                properties: {
                  results: {
                    type: "array",
                    items: { type: "object", properties: { title: { type: "string" } } },
                  },
                },
              }),
            },
          },
        },
        // 6. Collection creation POST declaring only 400 and default must still require 201/202
        "/v1/projects/{projectId}/jobs": {
          parameters: [pathParam("projectId")],
          post: {
            operationId: "createJobNo2xx",
            summary: "Collection POST declaring only 400 and default",
            responses: {
              "400": { description: "Bad request" },
              default: { description: "Unexpected error" },
            },
          },
        },
        "/v1/projects/{projectId}/jobs/{jobId}": {
          parameters: [pathParam("projectId"), pathParam("jobId")],
          get: {
            operationId: "getJob",
            summary: "Get job",
            responses: {
              "200": jsonResponse({
                type: "object",
                properties: { id: { type: "string" }, name: { type: "string" } },
              }),
            },
          },
        },
        // 7. Truncated >256-variant union collection GET must report analysis cap
        "/v1/projects/{projectId}/huge-union": {
          parameters: [pathParam("projectId")],
          get: {
            operationId: "getHugeUnion",
            summary: "Collection hidden past variant cap",
            responses: {
              "200": jsonResponse({ anyOf: overflowBranches }),
            },
          },
        },
        // 8. 24-level diamond allOf DAG paired with hoisted GET
        "/v1/organizations/{organizationId}/diamonds": {
          parameters: [pathParam("organizationId")],
          get: {
            operationId: "listDiamonds",
            summary: "List diamond DAG items",
            responses: {
              "200": jsonResponse({
                type: "object",
                properties: {
                  items: {
                    type: "array",
                    items: { $ref: "#/components/schemas/Diamond24" },
                  },
                },
              }),
            },
          },
        },
        "/v1/diamonds/{diamondId}": {
          parameters: [pathParam("diamondId")],
          get: {
            operationId: "getDiamond",
            summary: "Get diamond",
            responses: {
              "200": jsonResponse({ $ref: "#/components/schemas/Diamond24" }),
            },
          },
        },
      },
      components: {
        schemas: diamondSchemas,
      },
    });

    const { report } = await lintOpenApi(doc);
    const readMessages = ads0005ProblemsFor(report, "ads-0005-addressable-resource-read").map(
      (e) => e.message,
    );
    const statusMessages = ads0005ProblemsFor(report, "ads-0005-standard-status-codes").map(
      (e) => e.message,
    );

    expect(readMessages.some((m) => m.includes('PATCH "/v1/profile"'))).toBe(true);
    expect(
      statusMessages.some(
        (m) =>
          m.includes('PATCH "/v1/projects/{projectId}/shared-profile"') &&
          m.includes('"204 No Content"'),
      ),
    ).toBe(true);
    expect(readMessages.some((m) => m.includes('POST "/v1/api-keys/{apiKeyId}/revoke"'))).toBe(
      true,
    );
    expect(
      readMessages.some((m) => m.includes('GET "/v1/projects/{projectId}/filtered-widgets"')),
    ).toBe(true);
    expect(statusMessages.some((m) => m.includes("/search"))).toBe(false);
    expect(
      statusMessages.some(
        (m) => m.includes('POST "/v1/projects/{projectId}/jobs"') && m.includes('"201"'),
      ),
    ).toBe(true);
    expect(
      readMessages.some(
        (m) =>
          m.includes('GET "/v1/projects/{projectId}/huge-union"') &&
          m.includes("256-variant union analysis cap"),
      ),
    ).toBe(true);
    expect(readMessages.some((m) => m.includes("/diamonds"))).toBe(false);
  });

  it("enforces read symmetry, compatibility, status codes, and chained Path Item refs for edge cases", async () => {
    const diamondSchemas: Record<string, unknown> = {
      Diamond0: {
        type: "object",
        required: ["id", "title"],
        properties: { id: { type: "string" }, title: { type: "string" } },
      },
    };
    for (let i = 1; i <= 24; i += 1) {
      diamondSchemas[`Diamond${i}`] = {
        allOf: [
          { $ref: `#/components/schemas/Diamond${i - 1}` },
          { $ref: `#/components/schemas/Diamond${i - 1}` },
        ],
      };
    }

    const doc = baseOpenApi({
      paths: {
        // 1. Negative control for diamond DAG without hoisted GET
        "/v1/organizations/{organizationId}/diamonds": {
          parameters: [pathParam("organizationId")],
          get: {
            operationId: "listDiamondsNoGet",
            summary: "List diamond items without item GET",
            responses: {
              "200": jsonResponse({
                type: "object",
                properties: {
                  items: { type: "array", items: { $ref: "#/components/schemas/Diamond24" } },
                },
              }),
            },
          },
        },
        // 2. Array items with anyOf alternative inheriting outer items via minItems
        "/v1/projects/{projectId}/inherited-items": {
          parameters: [pathParam("projectId")],
          get: {
            operationId: "listInheritedItems",
            summary: "List inherited array items",
            responses: {
              "200": jsonResponse({
                type: "object",
                properties: {
                  data: {
                    type: "array",
                    items: {
                      type: "object",
                      required: ["id"],
                      properties: { id: { type: "string" }, label: { type: "string" } },
                    },
                    anyOf: [{ minItems: 1 }, { items: { type: "string" } }],
                  },
                },
              }),
            },
          },
        },
        // 3. Nullable shared field type mismatch ([string, null] vs [integer, null])
        "/v1/organizations/{organizationId}/scores": {
          parameters: [pathParam("organizationId")],
          get: {
            operationId: "listScores",
            summary: "List scores",
            responses: {
              "200": jsonResponse({
                type: "object",
                properties: {
                  data: {
                    type: "array",
                    items: {
                      type: "object",
                      required: ["id"],
                      properties: {
                        id: { type: "string" },
                        score: { type: ["string", "null"] },
                      },
                    },
                  },
                },
              }),
            },
          },
        },
        "/v1/scores/{scoreId}": {
          parameters: [pathParam("scoreId")],
          get: {
            operationId: "getScore",
            summary: "Get score with incompatible nullable type",
            responses: {
              "200": jsonResponse({
                type: "object",
                required: ["id"],
                properties: {
                  id: { type: "string" },
                  score: { type: ["integer", "null"] },
                },
              }),
            },
          },
        },
        // 4. Scoped PATCH returning lifecycle-bearing resource in 202 vs incompatible hoisted GET
        "/v1/organizations/{organizationId}/jobs/{jobId}": {
          parameters: [pathParam("organizationId"), pathParam("jobId")],
          patch: {
            operationId: "patchJobAsyncResource",
            summary: "Patch job returning lifecycle-bearing resource in 202",
            responses: {
              "202": jsonResponse({
                type: "object",
                required: ["id", "status", "title"],
                properties: {
                  id: { type: "string" },
                  status: { type: "string" },
                  title: { type: "string" },
                },
              }),
            },
          },
        },
        "/v1/jobs/{jobId}": {
          parameters: [pathParam("jobId")],
          get: {
            operationId: "getJobIntId",
            summary: "Incompatible hoisted job GET",
            responses: {
              "200": jsonResponse({
                type: "object",
                required: ["id", "title"],
                properties: { id: { type: "integer" }, title: { type: "string" } },
              }),
            },
          },
        },
        // 5. Scoped PATCH returning separate ADS-0004 Operation in 202 stays accepted
        "/v1/organizations/{organizationId}/exports/{exportId}": {
          parameters: [pathParam("organizationId"), pathParam("exportId")],
          patch: {
            operationId: "patchExportAsyncOp",
            summary: "Patch export returning Operation in 202",
            responses: {
              "202": jsonResponse({
                type: "object",
                required: ["id", "status", "type", "createdAt", "updatedAt"],
                properties: {
                  id: { type: "string" },
                  status: { type: "string" },
                  type: { type: "string" },
                  createdAt: { type: "string" },
                  updatedAt: { type: "string" },
                },
              }),
            },
          },
        },
        "/v1/exports/{exportId}": {
          parameters: [pathParam("exportId")],
          get: {
            operationId: "getExport",
            summary: "Get export",
            responses: {
              "200": jsonResponse({
                type: "object",
                required: ["id", "format"],
                properties: { id: { type: "integer" }, format: { type: "string" } },
              }),
            },
          },
        },
        // 6. Attempt-history child route does not exempt parent custom action
        "/v1/api-keys/{apiKeyId}/revoke": {
          parameters: [pathParam("apiKeyId")],
          post: {
            operationId: "revokeWithAttemptChild",
            summary: "Revoke API key with attempt history child",
            responses: {
              "200": jsonResponse({
                type: "object",
                properties: { revoked: { type: "boolean" } },
              }),
            },
          },
        },
        "/v1/api-keys/{apiKeyId}/revoke/{attemptId}": {
          parameters: [pathParam("apiKeyId"), pathParam("attemptId")],
          get: {
            operationId: "getRevokeAttempt",
            summary: "Get revocation attempt",
            responses: {
              "200": jsonResponse({
                type: "object",
                properties: { id: { type: "string" }, ok: { type: "boolean" } },
              }),
            },
          },
        },
        // 7. Query-like addressable collection (/stats) requires 201/202 on creation POST
        "/v1/projects/{projectId}/stats": {
          parameters: [pathParam("projectId")],
          get: {
            operationId: "listStats",
            summary: "List addressable stat records",
            responses: {
              "200": jsonResponse({
                type: "object",
                properties: {
                  data: {
                    type: "array",
                    items: {
                      type: "object",
                      required: ["id", "metric"],
                      properties: { id: { type: "string" }, metric: { type: "string" } },
                    },
                  },
                },
              }),
            },
          },
          post: {
            operationId: "createStatWrongStatus",
            summary: "Create stat returning only 200",
            responses: {
              "200": jsonResponse({
                type: "object",
                required: ["id", "metric"],
                properties: { id: { type: "string" }, metric: { type: "string" } },
              }),
            },
          },
        },
        "/v1/stats/{statId}": {
          parameters: [pathParam("statId")],
          get: {
            operationId: "getStat",
            summary: "Get stat",
            responses: {
              "200": jsonResponse({
                type: "object",
                required: ["id", "metric"],
                properties: { id: { type: "string" }, metric: { type: "string" } },
              }),
            },
          },
        },
        // 8. Dual GET/POST /search returning collection stays exempt from 201/202
        "/v1/projects/{projectId}/search": {
          parameters: [pathParam("projectId")],
          get: {
            operationId: "getSearchHits",
            summary: "Search via GET",
            responses: {
              "200": jsonResponse({
                type: "object",
                properties: {
                  data: {
                    type: "array",
                    items: {
                      type: "object",
                      properties: { id: { type: "string" }, snippet: { type: "string" } },
                    },
                  },
                },
              }),
            },
          },
          post: {
            operationId: "postSearchHits",
            summary: "Search via POST",
            responses: {
              "200": jsonResponse({
                type: "object",
                properties: {
                  data: {
                    type: "array",
                    items: {
                      type: "object",
                      properties: { id: { type: "string" }, snippet: { type: "string" } },
                    },
                  },
                },
              }),
            },
          },
        },
        "/v1/search/{searchId}": {
          parameters: [pathParam("searchId")],
          get: {
            operationId: "getSearchItem",
            summary: "Get search item",
            responses: {
              "200": jsonResponse({
                type: "object",
                properties: { id: { type: "string" }, snippet: { type: "string" } },
              }),
            },
          },
        },
        // 9. Chained Path Item $ref (root -> HopA(patch) -> HopB(put)) caught for PUT+PATCH
        "/v1/chained-items/{itemId}": {
          $ref: "#/components/pathItems/ChainedHopA",
        },
      },
      components: {
        schemas: diamondSchemas,
        pathItems: {
          ChainedHopA: {
            $ref: "#/components/pathItems/ChainedHopB",
            patch: {
              operationId: "patchChained",
              summary: "Patch chained item",
              responses: {
                "200": jsonResponse({
                  type: "object",
                  properties: { id: { type: "string" } },
                }),
              },
            },
          },
          ChainedHopB: {
            parameters: [pathParam("itemId")],
            get: {
              operationId: "getChained",
              summary: "Get chained item",
              responses: {
                "200": jsonResponse({
                  type: "object",
                  properties: { id: { type: "string" } },
                }),
              },
            },
            put: {
              operationId: "putChained",
              summary: "Put chained item",
              responses: {
                "200": jsonResponse({
                  type: "object",
                  properties: { id: { type: "string" } },
                }),
              },
            },
          },
        },
      },
    });

    const { report } = await lintOpenApi(doc);
    const readMessages = ads0005ProblemsFor(report, "ads-0005-addressable-resource-read").map(
      (e) => e.message,
    );
    const methodMessages = ads0005ProblemsFor(report, "ads-0005-standard-http-methods").map(
      (e) => e.message,
    );
    const statusMessages = ads0005ProblemsFor(report, "ads-0005-standard-status-codes").map(
      (e) => e.message,
    );

    expect(
      readMessages.some((m) => m.includes('GET "/v1/organizations/{organizationId}/diamonds"')),
    ).toBe(true);
    expect(
      readMessages.some((m) => m.includes('GET "/v1/projects/{projectId}/inherited-items"')),
    ).toBe(true);
    expect(
      readMessages.some((m) => m.includes('GET "/v1/organizations/{organizationId}/scores"')),
    ).toBe(true);
    expect(
      readMessages.some((m) =>
        m.includes('PATCH "/v1/organizations/{organizationId}/jobs/{jobId}"'),
      ),
    ).toBe(true);
    expect(
      readMessages.some((m) =>
        m.includes('PATCH "/v1/organizations/{organizationId}/exports/{exportId}"'),
      ),
    ).toBe(false);
    expect(readMessages.some((m) => m.includes('POST "/v1/api-keys/{apiKeyId}/revoke"'))).toBe(
      true,
    );
    expect(
      statusMessages.some(
        (m) => m.includes('POST "/v1/projects/{projectId}/stats"') && m.includes('"201"'),
      ),
    ).toBe(true);
    expect(statusMessages.some((m) => m.includes("/search"))).toBe(false);
    expect(methodMessages.some((m) => m.includes('"/v1/chained-items/{itemId}"'))).toBe(true);
  });

  it("rejects non-deprecated Idempotency-Key headers on GET and HEAD across direct, path-level, and $ref declarations", async () => {
    const headerParam = (name: string, extra: Record<string, unknown> = {}) => ({
      name,
      in: "header",
      schema: { type: "string" },
      ...extra,
    });
    const ok200 = { "200": jsonResponse({ type: "object" }) };

    const doc = baseOpenApi({
      paths: {
        // Direct inline Idempotency-Key on GET and lowercase on HEAD -> both reported
        "/v1/projects/{projectId}/direct-idempotency": {
          parameters: [pathParam("projectId")],
          get: {
            operationId: "getDirectIdempotency",
            summary: "GET with inline Idempotency-Key",
            parameters: [headerParam("Idempotency-Key")],
            responses: ok200,
          },
          head: {
            operationId: "headDirectIdempotency",
            summary: "HEAD with lowercase idempotency-key",
            parameters: [headerParam("idempotency-key")],
            responses: { "200": { description: "OK" } },
          },
          post: {
            operationId: "postDirectIdempotency",
            summary: "POST with Idempotency-Key is allowed",
            parameters: [headerParam("Idempotency-Key")],
            responses: { "201": jsonResponse({ type: "object" }, "Created") },
          },
        },
        // Path-level Idempotency-Key inherited by GET and HEAD (POST allowed)
        "/v1/projects/{projectId}/path-level-idempotency": {
          parameters: [pathParam("projectId"), headerParam("IDEMPOTENCY-KEY")],
          get: {
            operationId: "getPathLevelIdempotency",
            summary: "GET inheriting path-level Idempotency-Key",
            responses: ok200,
          },
          head: {
            operationId: "headPathLevelIdempotency",
            summary: "HEAD inheriting path-level Idempotency-Key",
            responses: { "200": { description: "OK" } },
          },
          post: {
            operationId: "postPathLevelIdempotency",
            summary: "POST inheriting path-level Idempotency-Key",
            responses: { "201": jsonResponse({ type: "object" }, "Created") },
          },
        },
        // $ref Parameter on GET and POST -> GET reported at usage site, POST allowed
        "/v1/projects/{projectId}/ref-idempotency": {
          parameters: [pathParam("projectId")],
          get: {
            operationId: "getRefIdempotency",
            summary: "GET referencing component Idempotency-Key",
            parameters: [{ $ref: "#/components/parameters/SharedIdempotencyKey" }],
            responses: ok200,
          },
          post: {
            operationId: "postRefIdempotency",
            summary: "POST referencing same component Idempotency-Key",
            parameters: [{ $ref: "#/components/parameters/SharedIdempotencyKey" }],
            responses: { "201": jsonResponse({ type: "object" }, "Created") },
          },
        },
        // $ref Path Item with path-level $ref Idempotency-Key -> GET reported at path usage
        "/v1/projects/{projectId}/ref-path-item-idempotency": {
          $ref: "#/components/pathItems/SharedIdempotentPathItem",
        },
        // Path-level Idempotency-Key overridden to deprecated: true on GET (case-insensitive),
        // while HEAD still inherits the active path-level header -> only HEAD reported
        "/v1/projects/{projectId}/override-deprecated": {
          parameters: [pathParam("projectId"), headerParam("Idempotency-Key")],
          get: {
            operationId: "getOverrideDeprecated",
            summary: "GET deprecates inherited Idempotency-Key",
            parameters: [headerParam("idempotency-key", { deprecated: true })],
            responses: ok200,
          },
          head: {
            operationId: "headWithoutOverride",
            summary: "HEAD still inherits active Idempotency-Key",
            responses: { "200": { description: "OK" } },
          },
        },
        // Path-level deprecated Idempotency-Key overridden to non-deprecated on GET -> reported
        "/v1/projects/{projectId}/override-active": {
          parameters: [
            pathParam("projectId"),
            headerParam("Idempotency-Key", { deprecated: true }),
          ],
          get: {
            operationId: "getOverrideActive",
            summary: "GET re-enables Idempotency-Key",
            parameters: [headerParam("Idempotency-Key", { deprecated: false })],
            responses: ok200,
          },
        },
        // Allowed cases: inline deprecated, $ref deprecated, OAS 3.1 sibling deprecated, query param, other header
        "/v1/projects/{projectId}/safe-headers": {
          parameters: [pathParam("projectId")],
          get: {
            operationId: "getSafeHeaders",
            summary: "GET with deprecated Idempotency-Key and non-header params",
            parameters: [
              headerParam("Idempotency-Key", { deprecated: true }),
              headerParam("X-Request-Id"),
              { name: "Idempotency-Key", in: "query", schema: { type: "string" } },
            ],
            responses: ok200,
          },
        },
        // Allowed: $ref to deprecated component Parameter Object (even with unsupported
        // deprecated: false sibling on Reference Object).
        // Disallowed: $ref to active component Parameter Object with unsupported deprecated: true
        // sibling on Reference Object must still be reported per OpenAPI 3.1.
        "/v1/projects/{projectId}/ref-deprecated-idempotency": {
          parameters: [pathParam("projectId")],
          get: {
            operationId: "getRefDeprecatedIdempotency",
            summary: "GET with deprecated component parameter",
            parameters: [
              { $ref: "#/components/parameters/DeprecatedIdempotencyKey", deprecated: false },
            ],
            responses: ok200,
          },
          head: {
            operationId: "headUnsupportedRefSiblingDeprecated",
            summary: "HEAD with unsupported deprecated: true sibling on active $ref",
            parameters: [
              { $ref: "#/components/parameters/SharedIdempotencyKey", deprecated: true },
            ],
            responses: { "200": { description: "OK" } },
          },
        },
      },
      components: {
        parameters: {
          SharedIdempotencyKey: headerParam("Idempotency-Key"),
          DeprecatedIdempotencyKey: headerParam("Idempotency-Key", { deprecated: true }),
        },
        pathItems: {
          SharedIdempotentPathItem: {
            parameters: [
              pathParam("projectId"),
              { $ref: "#/components/parameters/SharedIdempotencyKey" },
            ],
            get: {
              operationId: "getFromRefPathItem",
              summary: "GET from $ref Path Item",
              responses: ok200,
            },
          },
        },
      },
    });

    const { exitCode, report } = await lintOpenApi(doc);
    expect(exitCode).toBe(1);
    const errors = ads0005ProblemsFor(report, "ads-0005-standard-http-methods");
    const messages = errors.map((e) => e.message);

    expect(errors).toHaveLength(9);
    expect(
      messages.some(
        (m) =>
          m.includes('GET "/v1/projects/{projectId}/direct-idempotency"') &&
          m.includes('"Idempotency-Key"'),
      ),
    ).toBe(true);
    expect(
      messages.some(
        (m) =>
          m.includes('HEAD "/v1/projects/{projectId}/direct-idempotency"') &&
          m.includes('"idempotency-key"'),
      ),
    ).toBe(true);
    expect(
      messages.some(
        (m) =>
          m.includes('GET "/v1/projects/{projectId}/path-level-idempotency"') &&
          m.includes('"IDEMPOTENCY-KEY"'),
      ),
    ).toBe(true);
    expect(
      messages.some(
        (m) =>
          m.includes('HEAD "/v1/projects/{projectId}/path-level-idempotency"') &&
          m.includes('"IDEMPOTENCY-KEY"'),
      ),
    ).toBe(true);
    const refError = errors.find((e) =>
      e.message.includes('GET "/v1/projects/{projectId}/ref-idempotency"'),
    );
    expect(refError).toBeDefined();
    expect(refError?.location?.[0]?.pointer).toContain("/get/parameters/0");
    expect(
      messages.some((m) => m.includes('GET "/v1/projects/{projectId}/ref-path-item-idempotency"')),
    ).toBe(true);
    expect(
      messages.some((m) => m.includes('HEAD "/v1/projects/{projectId}/override-deprecated"')),
    ).toBe(true);
    expect(
      messages.some((m) => m.includes('GET "/v1/projects/{projectId}/override-deprecated"')),
    ).toBe(false);
    expect(messages.some((m) => m.includes('GET "/v1/projects/{projectId}/override-active"'))).toBe(
      true,
    );
    expect(
      messages.some((m) =>
        m.includes('HEAD "/v1/projects/{projectId}/ref-deprecated-idempotency"'),
      ),
    ).toBe(true);
    expect(
      messages.some((m) => m.includes('GET "/v1/projects/{projectId}/ref-deprecated-idempotency"')),
    ).toBe(false);
    expect(messages.some((m) => m.startsWith("POST "))).toBe(false);
    expect(messages.some((m) => m.includes("safe-headers"))).toBe(false);
  });

  it("rejects state-mutating terminal action verbs on GET and HEAD while allowing POST, safe read paths, and ignore rules", async () => {
    const ok200 = { "200": jsonResponse({ type: "object" }) };
    const head200 = { "200": { description: "OK" } };
    const mutatingPaths: Record<string, unknown> = {};

    for (const verb of ["revoke", "cancel", "pay", "purchase", "rotate", "transfer-ownership"]) {
      mutatingPaths[`/v1/projects/{projectId}/resources/{resourceId}/${verb}`] = {
        parameters: [pathParam("projectId"), pathParam("resourceId")],
        get: { operationId: `get_${verb}`, summary: `Bad GET ${verb}`, responses: ok200 },
        head: { operationId: `head_${verb}`, summary: `Bad HEAD ${verb}`, responses: head200 },
        post: { operationId: `post_${verb}`, summary: `Good POST ${verb}`, responses: ok200 },
      };
    }

    const allowedGetPaths: Record<string, unknown> = {};
    for (const safeSeg of [
      "redirect",
      "callback",
      "download",
      "export",
      "preview",
      "search",
      "query",
      "count",
      "status",
      "pdf",
      "receipt",
      "refunds",
    ]) {
      allowedGetPaths[`/v1/projects/{projectId}/resources/{resourceId}/${safeSeg}`] = {
        parameters: [pathParam("projectId"), pathParam("resourceId")],
        get: { operationId: `get_${safeSeg}`, summary: `Allowed GET ${safeSeg}`, responses: ok200 },
        head: {
          operationId: `head_${safeSeg}`,
          summary: `Allowed HEAD ${safeSeg}`,
          responses: head200,
        },
      };
    }

    const doc = baseOpenApi({
      paths: {
        ...mutatingPaths,
        ...allowedGetPaths,
        "/v1/projects/{projectId}/resources/{resourceId}": {
          parameters: [pathParam("projectId"), pathParam("resourceId")],
          get: { operationId: "getResourceItem", summary: "Item GET", responses: ok200 },
          head: { operationId: "headResourceItem", summary: "Item HEAD", responses: head200 },
        },
        "/v1/projects/{projectId}/deploy/status": {
          parameters: [pathParam("projectId")],
          get: {
            operationId: "getDeployStatus",
            summary: "Non-terminal mutating segment is allowed",
            responses: ok200,
          },
        },
        // Mixed-case terminal mutating verb and custom method suffix on GET
        "/v1/projects/{projectId}/resources/{resourceId}/Verify": {
          parameters: [pathParam("projectId"), pathParam("resourceId")],
          get: { operationId: "getVerifyUpper", summary: "Uppercase Verify", responses: ok200 },
        },
        "/v1/projects/{projectId}/resources/{resourceId}:approve": {
          parameters: [pathParam("projectId"), pathParam("resourceId")],
          get: { operationId: "getCustomApprove", summary: "Custom :approve", responses: ok200 },
        },
        // CRUD verb /delete on GET must only be flagged once (by CRUD verb check, not double-reported)
        "/v1/projects/{projectId}/resources/{resourceId}/delete": {
          parameters: [pathParam("projectId"), pathParam("resourceId")],
          get: { operationId: "getDelete", summary: "CRUD verb delete", responses: ok200 },
        },
        // Path Item $ref on mutating terminal path
        "/v1/projects/{projectId}/resources/{resourceId}/refund": {
          $ref: "#/components/pathItems/SharedRefundPath",
        },
      },
      components: {
        pathItems: {
          SharedRefundPath: {
            parameters: [pathParam("projectId"), pathParam("resourceId")],
            get: { operationId: "getSharedRefund", summary: "Ref GET refund", responses: ok200 },
          },
        },
      },
    });

    const { exitCode, report } = await lintOpenApi(doc);
    expect(exitCode).toBe(1);
    const errors = ads0005ProblemsFor(report, "ads-0005-standard-http-methods");
    const messages = errors.map((e) => e.message);

    // 6 mutating verbs * 2 (GET+HEAD) + Verify + :approve + /delete (CRUD once) + $ref /refund = 16
    expect(errors).toHaveLength(16);
    for (const verb of ["revoke", "cancel", "pay", "purchase", "rotate", "transfer-ownership"]) {
      expect(
        messages.some((m) =>
          m.includes(`GET "/v1/projects/{projectId}/resources/{resourceId}/${verb}"`),
        ),
      ).toBe(true);
      expect(
        messages.some((m) =>
          m.includes(`HEAD "/v1/projects/{projectId}/resources/{resourceId}/${verb}"`),
        ),
      ).toBe(true);
      expect(messages.some((m) => m.startsWith("POST ") && m.includes(`/${verb}"`))).toBe(false);
    }
    expect(messages.some((m) => m.includes("/Verify") && m.includes('"verify"'))).toBe(true);
    expect(messages.some((m) => m.includes(":approve") && m.includes('"approve"'))).toBe(true);
    expect(messages.some((m) => m.includes("/refund") && m.includes('"refund"'))).toBe(true);
    expect(errors.filter((e) => e.message.includes("/delete"))).toHaveLength(1);
    for (const safeSeg of [
      "redirect",
      "callback",
      "download",
      "export",
      "preview",
      "search",
      "query",
      "count",
      "status",
      "pdf",
      "receipt",
      "refunds",
    ]) {
      expect(
        messages.some((m) => m.includes(`/${safeSeg}"`)),
        safeSeg,
      ).toBe(false);
    }

    // Verify declarative ignore config suppresses safe-method checks by path+method and path-only
    const ignoreConfigPath = await writeRedoclyConfig({
      "photon-ads/ads-0005-standard-http-methods": {
        severity: "error",
        ignore: [
          {
            path: "/v1/projects/{projectId}/legacy-revoke/revoke",
            method: "get",
            reason: "Legacy GET revoke pending migration to POST",
          },
          {
            path: "/v1/projects/{projectId}/legacy-idempotent",
            reason: "Legacy path with Idempotency-Key on GET and HEAD",
          },
        ],
      },
    });
    const ignoreDoc = baseOpenApi({
      paths: {
        "/v1/projects/{projectId}/legacy-revoke/revoke": {
          parameters: [pathParam("projectId")],
          get: { operationId: "getLegacyRevoke", summary: "Ignored GET revoke", responses: ok200 },
          head: {
            operationId: "headLegacyRevoke",
            summary: "Non-ignored HEAD revoke",
            responses: head200,
          },
        },
        "/v1/projects/{projectId}/legacy-idempotent": {
          parameters: [
            pathParam("projectId"),
            { name: "Idempotency-Key", in: "header", schema: { type: "string" } },
          ],
          get: { operationId: "getLegacyIdemp", summary: "Path-ignored GET", responses: ok200 },
          head: {
            operationId: "headLegacyIdemp",
            summary: "Path-ignored HEAD",
            responses: head200,
          },
        },
      },
    });
    const ignoreRes = await lintOpenApi(ignoreDoc, ignoreConfigPath);
    const ignoreErrors = ads0005ProblemsFor(ignoreRes.report, "ads-0005-standard-http-methods");
    expect(ignoreErrors).toHaveLength(1);
    expect(ignoreErrors[0]?.message).toContain(
      'HEAD "/v1/projects/{projectId}/legacy-revoke/revoke"',
    );
  });
});
