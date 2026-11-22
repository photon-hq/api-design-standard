import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  buildDocsReference,
  exportDocsReference,
  resolveExportVersion,
  rewriteOverviewLinksForDocs,
  stripFrontmatterAndH1,
  stripLintRulesSection,
  validateMintlifyMdxSafety,
} from "../scripts/export-docs.js";
import { ADS_STANDARDS } from "../src/catalog.js";
import { createPhotonAdsPlugin } from "../src/plugin.js";
import type { AdsStandardMetadata, AdsStatus } from "../src/types.js";

const REPO_ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));
const FORBIDDEN_DOCS_PATTERNS = [
  /redocly/i,
  /photon-ads\//i,
  /\.npmrc/i,
  /pnpm\s+check/i,
  /@photon-hq\//i,
];

async function createTempRepoFixture(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "photon-ads-export-test-"));
  await cp(resolve(REPO_ROOT, "package.json"), resolve(dir, "package.json"));
  await cp(resolve(REPO_ROOT, "ads"), resolve(dir, "ads"), { recursive: true });
  return dir;
}

async function addFixtureStandard(
  rootDir: string,
  folder: string,
  ads: string,
  status: AdsStatus,
): Promise<AdsStandardMetadata> {
  const dir = resolve(rootDir, "ads", folder);
  await mkdir(dir, { recursive: true });
  await writeFile(
    resolve(dir, "index.md"),
    [
      "---",
      `title: "ADS-${ads}: Example ${status} Standard"`,
      `sidebarTitle: "ADS-${ads} · Example"`,
      `description: "Example ${status.toLowerCase()} standard for export filtering tests."`,
      `ads: "${ads}"`,
      `status: "${status}"`,
      'updated: "2026-11-21"',
      "---",
      "",
      `# ADS-${ads}: Example ${status} Standard`,
      "",
      `- **Status**: ${status}`,
      "- **Updated**: 2026-11-21",
      "",
      "## Normative Rules",
      "",
      "Resources **MUST** follow the example convention.",
      "",
    ].join("\n"),
    "utf8",
  );
  await writeFile(resolve(dir, "rules.ts"), "export {};\n", "utf8");
  await writeFile(resolve(dir, "rules.test.ts"), "export {};\n", "utf8");
  return {
    ads,
    slug: `ads-${ads}`,
    folder,
    rules: [],
  };
}

describe("docs-reference export", () => {
  let originalReleaseVersion: string | undefined;
  let originalGithubSha: string | undefined;

  beforeEach(() => {
    originalReleaseVersion = process.env.RELEASE_VERSION;
    originalGithubSha = process.env.GITHUB_SHA;
    delete process.env.RELEASE_VERSION;
  });

  afterEach(() => {
    if (originalReleaseVersion === undefined) {
      delete process.env.RELEASE_VERSION;
    } else {
      process.env.RELEASE_VERSION = originalReleaseVersion;
    }
    if (originalGithubSha === undefined) {
      delete process.env.GITHUB_SHA;
    } else {
      process.env.GITHUB_SHA = originalGithubSha;
    }
  });
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
      "Design conventions behind Photon's public HTTP APIs, why we publish them openly, and how to report inconsistencies.",
    );
    expect(first.overview.body).not.toMatch(/^#\s+/m);
    expect(first.overview.body).not.toContain("./ads/");
    expect(first.overview.body).toContain("## Why We Publish These Standards");
    expect(first.overview.body).toContain("## Feedback & Reporting Issues");
    expect(first.overview.body).toContain("do not accept external pull requests");
    expect(first.overview.body).toContain(
      "https://github.com/photon-hq/api-design-standards/issues/new",
    );
    expect(first.overview.body).not.toMatch(/^#{2,3}\s+Status\s+Lifecycle\b/im);
    expect(first.overview.body).not.toMatch(/^#{2,3}\s+Standards(?:\s+Index)?\b/im);
    for (const pattern of FORBIDDEN_DOCS_PATTERNS) {
      expect(first.overview.description).not.toMatch(pattern);
      expect(first.overview.body).not.toMatch(pattern);
    }

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
    expect(ads0001?.body).toContain("## Normative Rules");
    expect(ads0001?.body).toContain("## Examples");
    expect(ads0001?.body).toContain("## Changelog");
    expect(ads0001?.body).toContain("Approved and published as `ADS-0001`.");
    expect(ads0001?.body).not.toMatch(/^##\s+(?:Deterministic\s+)?Lint\s+Rules\b/im);
    for (const standard of first.standards) {
      expect(standard.status).toBe("Approved");
      for (const pattern of FORBIDDEN_DOCS_PATTERNS) {
        expect(standard.description).not.toMatch(pattern);
        expect(standard.body).not.toMatch(pattern);
      }
    }
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

  it("strips ## Lint Rules sections while preserving surrounding sections and code fences", () => {
    const withChangelog = [
      "## Normative Rules",
      "",
      "Use `id`.",
      "",
      "## Examples",
      "",
      "```markdown",
      "## Lint Rules",
      "Inside a fenced block, keep verbatim.",
      "```",
      "",
      "## Lint Rules",
      "",
      "Internal plugin details.",
      "",
      "### Nested subsection",
      "",
      "```markdown",
      "## Fake Heading Inside Fence",
      "```",
      "",
      "## Changelog",
      "",
      "- **2026-11-21**: Approved.",
    ].join("\n");

    expect(stripLintRulesSection(withChangelog)).toBe(
      [
        "## Normative Rules",
        "",
        "Use `id`.",
        "",
        "## Examples",
        "",
        "```markdown",
        "## Lint Rules",
        "Inside a fenced block, keep verbatim.",
        "```",
        "",
        "## Changelog",
        "",
        "- **2026-11-21**: Approved.",
      ].join("\n"),
    );

    const atEnd = [
      "## Normative Rules",
      "",
      "Use `id`.",
      "",
      "## Lint Rules",
      "",
      "Removed through EOF.",
    ].join("\n");
    expect(stripLintRulesSection(atEnd)).toBe("## Normative Rules\n\nUse `id`.");

    const withoutLintRules = "## Normative Rules\n\nUse `id`.";
    expect(stripLintRulesSection(withoutLintRules)).toBe(withoutLintRules);

    const withSetextNextSection = [
      "## Normative Rules",
      "",
      "Use `id`.",
      "",
      "## Lint Rules",
      "",
      "Internal plugin details.",
      "",
      "```markdown",
      "Examples",
      "--------",
      "```",
      "",
      "Examples",
      "--------",
      "",
      "Keep these examples.",
    ].join("\n");
    expect(stripLintRulesSection(withSetextNextSection)).toBe(
      [
        "## Normative Rules",
        "",
        "Use `id`.",
        "",
        "Examples",
        "--------",
        "",
        "Keep these examples.",
      ].join("\n"),
    );

    const withSetextLintRules = [
      "## Normative Rules",
      "",
      "Use `id`.",
      "",
      "Lint Rules",
      "----------",
      "",
      "Removed setext lint section.",
      "",
      "Changelog",
      "=========",
      "",
      "- **2026-11-21**: Approved.",
    ].join("\n");
    expect(stripLintRulesSection(withSetextLintRules)).toBe(
      [
        "## Normative Rules",
        "",
        "Use `id`.",
        "",
        "Changelog",
        "=========",
        "",
        "- **2026-11-21**: Approved.",
      ].join("\n"),
    );
  });

  it("exports only Approved standards and excludes Draft, Reviewing, and Deprecated standards", async () => {
    const fixtureRoot = await createTempRepoFixture();
    process.env.GITHUB_SHA = "a".repeat(40);
    try {
      const draftMeta = await addFixtureStandard(
        fixtureRoot,
        "0002-draft-example",
        "0002",
        "Draft",
      );
      const reviewingMeta = await addFixtureStandard(
        fixtureRoot,
        "0003-reviewing-example",
        "0003",
        "Reviewing",
      );
      const deprecatedMeta = await addFixtureStandard(
        fixtureRoot,
        "0004-deprecated-example",
        "0004",
        "Deprecated",
      );

      const exported = await buildDocsReference(fixtureRoot, {
        standardsCatalog: [...ADS_STANDARDS, draftMeta, reviewingMeta, deprecatedMeta],
        plugin: createPhotonAdsPlugin(),
      });

      expect(exported.standards.map((standard) => standard.slug)).toEqual(["ads-0001"]);
      expect(exported.standards.every((standard) => standard.status === "Approved")).toBe(true);
    } finally {
      await rm(fixtureRoot, { recursive: true, force: true });
    }
  });

  it("rejects export when no Approved standard exists", async () => {
    const fixtureRoot = await createTempRepoFixture();
    process.env.GITHUB_SHA = "b".repeat(40);
    try {
      const indexPath = resolve(fixtureRoot, "ads/0001-resource-identifiers/index.md");
      const original = await readFile(indexPath, "utf8");
      await writeFile(indexPath, original.replace('status: "Approved"', 'status: "Draft"'), "utf8");

      await expect(buildDocsReference(fixtureRoot)).rejects.toThrow(
        /At least one Approved ADS standard is required/,
      );
    } finally {
      await rm(fixtureRoot, { recursive: true, force: true });
    }
  });

  it("still enforces index.md rule parity before stripping ## Lint Rules", async () => {
    const fixtureRoot = await createTempRepoFixture();
    process.env.GITHUB_SHA = "c".repeat(40);
    try {
      const indexPath = resolve(fixtureRoot, "ads/0001-resource-identifiers/index.md");
      const original = await readFile(indexPath, "utf8");
      await writeFile(
        indexPath,
        original.replaceAll("photon-ads/ads-0001-path-param-consistency", "removed-rule"),
        "utf8",
      );

      await expect(buildDocsReference(fixtureRoot)).rejects.toThrow(
        /Rule "photon-ads\/ads-0001-path-param-consistency" exported by ads\/0001-resource-identifiers\/rules\.ts is not documented in ads\/0001-resource-identifiers\/index\.md/,
      );
    } finally {
      await rm(fixtureRoot, { recursive: true, force: true });
    }
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
        "See [ADS-0001](./ads/0001-resource-identifiers/index.md), [ADS-0001 relative](./0001-resource-identifiers/index.md#normative-rules), and [LICENSE](../LICENSE).",
      ),
    ).toBe(
      "See [ADS-0001](./ads-0001), [ADS-0001 relative](./ads-0001#normative-rules), and [LICENSE](https://github.com/photon-hq/api-design-standards/blob/main/LICENSE).",
    );
  });

  it("supports RELEASE_VERSION override and rejects invalid versions", async () => {
    expect(resolveExportVersion("0.1.0", undefined)).toBe("0.1.0");
    expect(resolveExportVersion("0.1.0", "0.2.0")).toBe("0.2.0");
    expect(resolveExportVersion("0.1.0", "0.2.0-staging.123.1")).toBe("0.2.0-staging.123.1");
    expect(resolveExportVersion("0.1.0", "1.2.3-rc.1+build.7")).toBe("1.2.3-rc.1+build.7");
    expect(() => resolveExportVersion("0.1.0", "")).toThrow(/Invalid RELEASE_VERSION/);
    expect(() => resolveExportVersion("0.1.0", "v0.2.0")).toThrow(/Invalid RELEASE_VERSION/);
    expect(() => resolveExportVersion("0.1.0", "01.2.3")).toThrow(/Invalid RELEASE_VERSION/);
    expect(() => resolveExportVersion("0.1.0", "1.2.3-rc..1")).toThrow(/Invalid RELEASE_VERSION/);
    expect(() => resolveExportVersion("0.1.0", "1.2.3-01")).toThrow(/Invalid RELEASE_VERSION/);
    expect(() => resolveExportVersion("0.1.0", "1.2.3+build..7")).toThrow(
      /Invalid RELEASE_VERSION/,
    );
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
