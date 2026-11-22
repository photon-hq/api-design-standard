import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  buildDocsReference,
  exportDocsReference,
  resolveExportVersion,
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
    expect(first.source.package).toBe("@photon-hq/api-design-standards");
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
          "",
          "> Lazy blockquote continuation `/v1/projects/{",
          "projectId}` is valid CommonMark.",
          "",
          "| `one | two |",
          "| {projectId}` | four |",
          "",
          "Escaped comparisons like values \\< 10 are also safe.",
          "Explicit links like [Example](https://example.com) and bare URLs like https://example.com are safe.",
          "",
          "```json",
          '{ "id": "prj_123" }',
          "```",
        ].join("\n"),
      ),
    ).not.toThrow();

    expect(() =>
      validateMintlifyMdxSafety("bad-autolink.md", "See <https://example.com>."),
    ).toThrow(/unescaped "<"/);

    expect(() =>
      validateMintlifyMdxSafety("bad-indented-code.md", "Example:\n\n    {projectId"),
    ).toThrow(/indented code blocks are not supported in MDX/);

    expect(() => validateMintlifyMdxSafety("bad-list-blocks.md", "- `one\n- {projectId}`")).toThrow(
      /unescaped curly brace/,
    );

    expect(() =>
      validateMintlifyMdxSafety(
        "bad-piped-table-blocks.md",
        "| Col A | Col B |\n| --- | --- |\n| `one | two |\n| {projectId}` | four |",
      ),
    ).toThrow(/unescaped curly brace/);

    expect(() =>
      validateMintlifyMdxSafety(
        "bad-pipeless-table-blocks.md",
        "Field | Note\n--- | ---\n`a | b\n{projectId}` | c",
      ),
    ).toThrow(/unescaped curly brace/);

    expect(() =>
      validateMintlifyMdxSafety("bad-unclosed-fence.md", '```json\n{ "id": "prj_123" }'),
    ).toThrow(/Unclosed fenced code block/);

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

  it("supports RELEASE_VERSION override and rejects invalid versions", async () => {
    expect(resolveExportVersion("0.1.0", undefined)).toBe("0.1.0");
    expect(resolveExportVersion("0.1.0", "0.2.0")).toBe("0.2.0");
    expect(resolveExportVersion("0.1.0", "0.2.0-staging.123.1")).toBe("0.2.0-staging.123.1");
    expect(resolveExportVersion("0.1.0", "1.2.3-rc.1+build.7")).toBe("1.2.3-rc.1+build.7");
    expect(() => resolveExportVersion("0.1.0", "")).toThrow(/Invalid RELEASE_VERSION/);
    expect(() => resolveExportVersion("0.1.0", "v0.2.0")).toThrow(/Invalid RELEASE_VERSION/);
    expect(() => resolveExportVersion("0.1.0", "not-a-version")).toThrow(/Invalid RELEASE_VERSION/);

    const previous = process.env.RELEASE_VERSION;
    const previousSha = process.env.GITHUB_SHA;
    try {
      const baseline = await buildDocsReference(REPO_ROOT);
      process.env.RELEASE_VERSION = "0.2.0";
      process.env.GITHUB_SHA = "0".repeat(40);
      const overridden = await buildDocsReference(REPO_ROOT);
      expect(overridden.source.version).toBe("0.2.0");
      expect(overridden.source.revision).toBe(baseline.source.revision);

      process.env.RELEASE_VERSION = "invalid";
      await expect(buildDocsReference(REPO_ROOT)).rejects.toThrow(/Invalid RELEASE_VERSION/);
    } finally {
      if (previous === undefined) {
        delete process.env.RELEASE_VERSION;
      } else {
        process.env.RELEASE_VERSION = previous;
      }
      if (previousSha === undefined) {
        delete process.env.GITHUB_SHA;
      } else {
        process.env.GITHUB_SHA = previousSha;
      }
    }
  });
});
