import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  buildDocsReference,
  exportDocsReference,
  rewriteOverviewLinksForDocs,
  stripFrontmatterAndH1,
  validateMintlifyMdxSafety,
} from "../scripts/export-docs.js";

const REPO_ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));

describe("docs-reference export", () => {
  it("builds a deterministic schemaVersion 1 ads docs reference matching the contract", async () => {
    const first = await buildDocsReference(REPO_ROOT);
    const second = await buildDocsReference(REPO_ROOT);

    expect(first).toEqual(second);
    expect(first.schemaVersion).toBe(1);
    expect(first.family).toBe("ads");
    expect(first.source.package).toBe("@photon-ai/api-design-standards");
    expect(first.source.repository).toBe("photon-hq/api-design-standards");
    expect(first.source.revision).toMatch(/^[a-f0-9]{40}$/);
    expect(first.source.version).toMatch(/^\d+\.\d+\.\d+$/);

    expect(first.overview.title).toBe("API Design Standards");
    expect(first.overview.sidebarTitle).toBe("Overview");
    expect(first.overview.description).toBe(
      "Public HTTP API design standards and deterministic OpenAPI lint rules for Photon APIs.",
    );
    expect(first.overview.body).not.toMatch(/^#\s+/m);
    expect(first.overview.body).not.toContain("./ads/");
    expect(first.overview.body).toContain("./ads-0001");

    expect(first.standards).toHaveLength(1);
    const ads0001 = first.standards[0];
    expect(ads0001).toBeDefined();
    expect(ads0001?.ads).toBe("0001");
    expect(ads0001?.slug).toBe("ads-0001");
    expect(ads0001?.folder).toBe("0001-resource-identifiers");
    expect(ads0001?.title).toBe("ADS-0001: Resource Identifiers and Path Parameter Naming");
    expect(ads0001?.sidebarTitle).toBe("ADS-0001 · Resource Identifiers");
    expect(ads0001?.description).toBe(
      "Consistent primary identifier fields, qualified foreign keys, and URL path parameter naming across Photon public HTTP APIs.",
    );
    expect(ads0001?.status).toBe("Approved");
    expect(ads0001?.updated).toBe("2026-11-21");
    expect(ads0001?.rules).toEqual([
      {
        id: "photon-ads/ads-0001-resource-primary-id",
        severity: "error",
        summary:
          "Resource objects must use `id` as their primary identifier field rather than a resource-prefixed key.",
      },
      {
        id: "photon-ads/ads-0001-path-param-naming",
        severity: "error",
        summary:
          "URL path parameters must use lowerCamelCase, with resource-qualified names for resource identifiers (for example `{projectId}`), never generic `{id}`.",
      },
      {
        id: "photon-ads/ads-0001-path-param-consistency",
        severity: "error",
        summary:
          "Routes sharing the same parent resource path prefix must use the same path parameter name.",
      },
    ]);
    expect(ads0001?.body).not.toMatch(/^---/);
    expect(ads0001?.body).not.toMatch(/^#\s+/);
  });

  it("writes byte-identical artifacts/docs-reference.json across repeated runs", async () => {
    const out1 = await exportDocsReference(REPO_ROOT);
    const content1 = await readFile(out1, "utf8");
    const out2 = await exportDocsReference(REPO_ROOT);
    const content2 = await readFile(out2, "utf8");

    expect(out1).toBe(out2);
    expect(content1).toBe(content2);
    expect(content1.endsWith("\n")).toBe(true);
  });

  it("validates Mintlify MDX safety for braces, angle brackets, wrapped code spans, and links", () => {
    expect(() =>
      validateMintlifyMdxSafety(
        "safe.md",
        [
          "Use `{projectId}` and `<resource>Id` inside inline code.",
          "Wrapped spans like `/v1/projects/{",
          "projectId}` across a single line break are valid CommonMark.",
          "- Wrapped spans inside a single list item like `/v1/projects/{",
          "  projectId}` are also valid.",
          "Escaped comparisons like values \\< 10 are also safe.",
          "",
          "```json",
          '{ "id": "prj_123" }',
          "```",
        ].join("\n"),
      ),
    ).not.toThrow();

    expect(() => validateMintlifyMdxSafety("bad-list-blocks.md", "- `one\n- {projectId}`")).toThrow(
      /unescaped curly brace/,
    );

    expect(() =>
      validateMintlifyMdxSafety("bad-table-blocks.md", "| `one | two |\n| {projectId}` | four |"),
    ).toThrow(/unescaped curly brace/);

    expect(() =>
      validateMintlifyMdxSafety("bad-brace.md", "Never write raw {projectId} in prose."),
    ).toThrow(/unescaped curly brace/);

    expect(() =>
      validateMintlifyMdxSafety("bad-tag.md", "Never write raw <resource>Id in prose."),
    ).toThrow(/unescaped "<"/);

    expect(() =>
      validateMintlifyMdxSafety("bad-lt.md", "Values must be < 10 without escaping."),
    ).toThrow(/unescaped "<"/);

    expect(() =>
      validateMintlifyMdxSafety("bad-link.md", "See [ADS-0001](./ads/0001/index.md)."),
    ).toThrow(/Invalid relative \.md link/);

    expect(() =>
      validateMintlifyMdxSafety("bad-ref-link.md", "See [Guide][guide].\n\n[guide]: ./guide.md"),
    ).toThrow(/Invalid relative \.md link/);
  });

  it("strips frontmatter and leading H1 cleanly and rewrites overview links", () => {
    const parsed = stripFrontmatterAndH1("---\ntitle: Hello\n---\n\n# Heading\n\nBody text.\n");
    expect(parsed.frontmatter).toEqual({ title: "Hello" });
    expect(parsed.body).toBe("Body text.");

    expect(
      rewriteOverviewLinksForDocs(
        "See [ADS-0001](./ads/0001-resource-identifiers/index.md) and [LICENSE](./LICENSE).",
      ),
    ).toBe(
      "See [ADS-0001](./ads-0001) and [LICENSE](https://github.com/photon-hq/api-design-standards/blob/main/LICENSE).",
    );
  });
});
