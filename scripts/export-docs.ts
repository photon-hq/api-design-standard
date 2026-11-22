import { execFileSync } from "node:child_process";
import { access, mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Lexer, type Token, type Tokens } from "marked";
import { parse as parseYaml } from "yaml";
import { ADS_STANDARDS, PLUGIN_ID } from "../src/catalog.js";
import { createPhotonAdsPlugin } from "../src/plugin.js";
import type {
  AdsRuleSeverity,
  AdsStandardMetadata,
  AdsStatus,
  RedoclyPlugin,
} from "../src/types.js";

export interface DocsReferenceRule {
  id: string;
  severity: AdsRuleSeverity;
  summary: string;
}

export interface DocsReferenceStandard {
  ads: string;
  slug: string;
  folder: string;
  title: string;
  sidebarTitle: string;
  description: string;
  status: AdsStatus;
  updated: string;
  rules: DocsReferenceRule[];
  body: string;
}

export interface DocsReferenceDocument {
  schemaVersion: 1;
  family: "ads";
  source: {
    package: string;
    repository: string;
    revision: string;
    version: string;
  };
  overview: {
    title: string;
    sidebarTitle: string;
    description: string;
    body: string;
  };
  standards: DocsReferenceStandard[];
}

export interface BuildDocsReferenceOptions {
  standardsCatalog?: readonly AdsStandardMetadata[];
  plugin?: RedoclyPlugin;
}

const VALID_STATUSES = new Set<AdsStatus>(["Draft", "Reviewing", "Approved", "Deprecated"]);
const ADS_FOLDER_RE = /^(\d{4})-([a-z0-9]+(?:-[a-z0-9]+)*)$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const SEMVER_RE =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*)(?:\.(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*))*)?(?:\+[0-9a-zA-Z-]+(?:\.[0-9a-zA-Z-]+)*)?$/;
const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/;
const LEADING_H1_RE = /^\s*#\s+[^\r\n]+\r?\n?/;
const EXTERNAL_OR_ANCHOR_HREF_RE = /^(?:https?:|mailto:|#)/i;
const MARKDOWN_HREF_RE = /\.md(?:#.*)?$/i;
const FENCE_OPEN_RE = /^\s{0,3}(`{3,}|~{3,})/;
const LINT_RULES_TITLE_RE = /^(?:Deterministic\s+)?Lint\s+Rules$/i;
const CANONICAL_REPOSITORY = "photon-hq/api-design-standards";

function assertCondition(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new Error(message);
  }
}

export function stripFrontmatterAndH1(markdown: string): {
  frontmatter: Record<string, unknown> | null;
  body: string;
} {
  const match = FRONTMATTER_RE.exec(markdown);
  let frontmatter: Record<string, unknown> | null = null;
  let content = markdown;

  if (match) {
    const parsed: unknown = parseYaml(match[1] ?? "");
    assertCondition(
      typeof parsed === "object" && parsed !== null && !Array.isArray(parsed),
      "YAML frontmatter must parse to a mapping object.",
    );
    frontmatter = parsed as Record<string, unknown>;
    content = match[2] ?? "";
  }

  const withoutH1 = content.replace(LEADING_H1_RE, "").replaceAll("\r\n", "\n").trim();
  return { frontmatter, body: withoutH1 };
}

function assertSafeLinkHref(label: string, href: string | null | undefined, context: string): void {
  if (!href) {
    return;
  }
  const trimmed = href.trim();
  if (!EXTERNAL_OR_ANCHOR_HREF_RE.test(trimmed) && MARKDOWN_HREF_RE.test(trimmed)) {
    throw new Error(`Invalid relative .md link in ${label}: ${context.trim()}`);
  }
}

function assertClosedFencedCodeBlock(label: string, token: Tokens.Code): void {
  if (token.codeBlockStyle === "indented") {
    throw new Error(
      `Mintlify MDX safety violation in ${label}: indented code blocks are not supported in MDX; use fenced code blocks instead.`,
    );
  }
  const rawLines = token.raw.replace(/\r?\n$/, "").split(/\r?\n/);
  const openMatch = FENCE_OPEN_RE.exec(rawLines[0] ?? "");
  if (!openMatch?.[1]) {
    return;
  }
  const fenceChar = openMatch[1][0] ?? "`";
  const fenceLen = openMatch[1].length;
  const closeRe = new RegExp(`^\\s{0,3}${fenceChar}{${fenceLen},}\\s*$`);
  const lastLine = rawLines[rawLines.length - 1] ?? "";
  assertCondition(
    rawLines.length >= 2 && closeRe.test(lastLine),
    `Unclosed fenced code block in ${label}.`,
  );
}

function inspectMarkdownTokens(label: string, tokens: Token[]): void {
  for (const token of tokens) {
    switch (token.type) {
      case "code": {
        assertClosedFencedCodeBlock(label, token as Tokens.Code);
        break;
      }
      case "codespan":
      case "escape":
      case "space":
      case "hr":
      case "br": {
        break;
      }
      case "html": {
        throw new Error(
          `Mintlify MDX safety violation in ${label}: unescaped "<" outside code span: ${token.raw.trim()}`,
        );
      }
      case "def": {
        const defToken = token as Tokens.Def;
        assertSafeLinkHref(label, defToken.href, defToken.raw);
        break;
      }
      case "link":
      case "image": {
        const linkToken = token as Tokens.Link | Tokens.Image;
        if (linkToken.type === "link" && linkToken.raw.startsWith("<")) {
          throw new Error(
            `Mintlify MDX safety violation in ${label}: unescaped "<" outside code span: ${linkToken.raw.trim()}`,
          );
        }
        assertSafeLinkHref(label, linkToken.href, linkToken.raw);
        if (Array.isArray(linkToken.tokens)) {
          inspectMarkdownTokens(label, linkToken.tokens);
        }
        break;
      }
      case "table": {
        const tableToken = token as Tokens.Table;
        for (const headerCell of tableToken.header) {
          inspectMarkdownTokens(label, headerCell.tokens);
        }
        for (const row of tableToken.rows) {
          for (const cell of row) {
            inspectMarkdownTokens(label, cell.tokens);
          }
        }
        break;
      }
      case "list": {
        const listToken = token as Tokens.List;
        for (const item of listToken.items) {
          inspectMarkdownTokens(label, item.tokens);
        }
        break;
      }
      case "text": {
        const textToken = token as Tokens.Text;
        if (Array.isArray(textToken.tokens)) {
          inspectMarkdownTokens(label, textToken.tokens);
          break;
        }
        if (/[{}]/.test(textToken.raw)) {
          throw new Error(
            `Mintlify MDX safety violation in ${label}: unescaped curly brace outside code span: ${textToken.raw.trim()}`,
          );
        }
        if (textToken.raw.includes("<")) {
          throw new Error(
            `Mintlify MDX safety violation in ${label}: unescaped "<" outside code span: ${textToken.raw.trim()}`,
          );
        }
        break;
      }
      default: {
        if ("tokens" in token && Array.isArray(token.tokens)) {
          inspectMarkdownTokens(label, token.tokens);
        }
        break;
      }
    }
  }
}

export function validateMintlifyMdxSafety(label: string, markdown: string): void {
  const tokenList = Lexer.lex(markdown, { gfm: true });
  inspectMarkdownTokens(label, tokenList);
  for (const [tag, link] of Object.entries(tokenList.links)) {
    assertSafeLinkHref(label, link.href, `[${tag}]: ${link.href}`);
  }
}

export function stripLintRulesSection(markdown: string): string {
  const normalized = markdown.replaceAll("\r\n", "\n");
  const tokens = Lexer.lex(normalized, { gfm: true });
  const kept: string[] = [];
  let skipping = false;

  for (const token of tokens) {
    if (token.type === "heading") {
      const heading = token as Tokens.Heading;
      if (heading.depth === 2 && LINT_RULES_TITLE_RE.test(heading.text.trim())) {
        skipping = true;
        continue;
      }
      if (skipping && heading.depth <= 2) {
        skipping = false;
        while (kept.length > 0 && kept[kept.length - 1]?.trim() === "") {
          kept.pop();
        }
        const previous = kept.pop();
        if (previous !== undefined) {
          kept.push(previous.replace(/\n+$/, ""), "\n\n");
        }
        kept.push(token.raw);
        continue;
      }
    }

    if (!skipping) {
      kept.push(token.raw);
    }
  }

  return kept.join("").trim();
}

export function rewriteOverviewLinksForDocs(markdown: string): string {
  return markdown
    .replace(
      /\]\(\.(?:\/ads)?\/(\d{4})-[a-z0-9-]+\/index\.md(#[^)]*)?\)/g,
      (_match, num: string, hash: string | undefined) => `](./ads-${num}${hash ?? ""})`,
    )
    .replace(
      /\]\((?:\.|\.\.)\/LICENSE\)/g,
      `](https://github.com/${CANONICAL_REPOSITORY}/blob/main/LICENSE)`,
    );
}

export function resolveExportVersion(packageVersion: string, releaseVersion?: string): string {
  if (releaseVersion === undefined) {
    assertCondition(
      SEMVER_RE.test(packageVersion),
      `package.json version "${packageVersion}" must be a valid semver string.`,
    );
    return packageVersion;
  }
  const trimmed = releaseVersion.trim();
  assertCondition(
    SEMVER_RE.test(trimmed),
    `Invalid RELEASE_VERSION "${releaseVersion}". Expected semver matching X.Y.Z (with optional prerelease/build suffix).`,
  );
  return trimmed;
}

function readGitRevision(rootDir: string): string {
  let insideWorkTree = false;
  try {
    insideWorkTree =
      execFileSync("git", ["rev-parse", "--is-inside-work-tree"], {
        cwd: rootDir,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      }).trim() === "true";
  } catch {
    insideWorkTree = false;
  }

  if (insideWorkTree) {
    const sha = execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: rootDir,
      encoding: "utf8",
    }).trim();
    assertCondition(/^[a-f0-9]{40}$/.test(sha), `Expected 40-char git revision SHA, got "${sha}".`);
    return sha;
  }

  const envSha = process.env.GITHUB_SHA?.trim();
  assertCondition(
    envSha && /^[a-f0-9]{40}$/.test(envSha),
    "Expected 40-char git revision SHA from git rev-parse HEAD or GITHUB_SHA.",
  );
  return envSha;
}

async function assertFileExists(path: string, message: string): Promise<void> {
  try {
    await access(path);
  } catch {
    throw new Error(message);
  }
}

function parseFrontmatterString(
  frontmatter: Record<string, unknown>,
  field: string,
  label: string,
): string {
  const value = frontmatter[field];
  assertCondition(
    typeof value === "string" && value.trim().length > 0,
    `${label}: missing or empty frontmatter field "${field}".`,
  );
  return value.trim();
}

export async function buildDocsReference(
  rootDir: string,
  options: BuildDocsReferenceOptions = {},
): Promise<DocsReferenceDocument> {
  const packageJsonPath = resolve(rootDir, "package.json");
  const pkg = JSON.parse(await readFile(packageJsonPath, "utf8")) as {
    name?: string;
    version?: string;
  };
  assertCondition(
    typeof pkg.name === "string" && pkg.name.length > 0,
    "package.json must define name.",
  );
  assertCondition(
    typeof pkg.version === "string" && pkg.version.length > 0,
    "package.json must define version.",
  );

  const version = resolveExportVersion(pkg.version, process.env.RELEASE_VERSION);
  const revision = readGitRevision(rootDir);

  const overviewLabel = "ads/overview.md";
  const overviewPath = resolve(rootDir, overviewLabel);
  const overviewRaw = await readFile(overviewPath, "utf8");
  const { frontmatter: overviewFrontmatter, body: rawOverviewBody } =
    stripFrontmatterAndH1(overviewRaw);
  assertCondition(overviewFrontmatter !== null, `${overviewLabel} is missing YAML frontmatter.`);
  const overviewTitle = parseFrontmatterString(overviewFrontmatter, "title", overviewLabel);
  const overviewSidebarTitle = parseFrontmatterString(
    overviewFrontmatter,
    "sidebarTitle",
    overviewLabel,
  );
  const overviewDescription = parseFrontmatterString(
    overviewFrontmatter,
    "description",
    overviewLabel,
  );
  const overviewBody = rewriteOverviewLinksForDocs(rawOverviewBody);
  assertCondition(overviewBody.length > 0, `${overviewLabel} body must not be empty.`);
  validateMintlifyMdxSafety(overviewLabel, overviewBody);

  const adsDir = resolve(rootDir, "ads");
  const entries = await readdir(adsDir, { withFileTypes: true });
  const folders = entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort((a, b) => a.localeCompare(b, "en"));

  assertCondition(folders.length > 0, "No ADS folders found under ads/.");

  const standardsCatalog = options.standardsCatalog ?? ADS_STANDARDS;
  const plugin = options.plugin ?? createPhotonAdsPlugin();
  const pluginRuleNames = new Set(Object.keys(plugin.rules.oas3));
  const pluginRecommendedRuleIds = new Set(Object.keys(plugin.configs?.recommended?.rules ?? {}));
  const seenRuleNames = new Set<string>();
  const standards: DocsReferenceStandard[] = [];

  for (const folder of folders) {
    const folderMatch = ADS_FOLDER_RE.exec(folder);
    assertCondition(
      folderMatch?.[1],
      `Invalid ADS folder name "${folder}". Expected "<4-digit-num>-<kebab-slug>".`,
    );
    const adsNumber = folderMatch[1];
    const folderDir = resolve(adsDir, folder);

    await assertFileExists(
      resolve(folderDir, "index.md"),
      `ADS folder "ads/${folder}" is missing required file "index.md".`,
    );
    await assertFileExists(
      resolve(folderDir, "rules.ts"),
      `ADS folder "ads/${folder}" is missing required file "rules.ts".`,
    );
    await assertFileExists(
      resolve(folderDir, "rules.test.ts"),
      `ADS folder "ads/${folder}" is missing required file "rules.test.ts".`,
    );

    const catalogEntry = standardsCatalog.find((item) => item.folder === folder);
    assertCondition(
      catalogEntry,
      `ADS folder "ads/${folder}" is not registered in src/catalog.ts (ADS_STANDARDS).`,
    );
    assertCondition(
      catalogEntry.ads === adsNumber,
      `Catalog entry for "ads/${folder}" has ads="${catalogEntry.ads}", expected "${adsNumber}".`,
    );
    assertCondition(
      catalogEntry.slug === `ads-${adsNumber}`,
      `Catalog entry for "ads/${folder}" has slug="${catalogEntry.slug}", expected "ads-${adsNumber}".`,
    );

    const indexPath = resolve(folderDir, "index.md");
    const indexRaw = await readFile(indexPath, "utf8");
    const { frontmatter, body } = stripFrontmatterAndH1(indexRaw);
    assertCondition(frontmatter !== null, `ads/${folder}/index.md is missing YAML frontmatter.`);
    assertCondition(body.length > 0, `ads/${folder}/index.md body must not be empty.`);

    const label = `ads/${folder}/index.md`;
    const title = parseFrontmatterString(frontmatter, "title", label);
    const sidebarTitle = parseFrontmatterString(frontmatter, "sidebarTitle", label);
    const description = parseFrontmatterString(frontmatter, "description", label);
    const frontmatterAds = parseFrontmatterString(frontmatter, "ads", label);
    const status = parseFrontmatterString(frontmatter, "status", label) as AdsStatus;
    const updated = parseFrontmatterString(frontmatter, "updated", label);

    assertCondition(
      frontmatterAds === adsNumber,
      `${label}: frontmatter ads="${frontmatterAds}" does not match folder number "${adsNumber}".`,
    );
    assertCondition(
      VALID_STATUSES.has(status),
      `${label}: invalid status "${status}". Expected one of ${[...VALID_STATUSES].join(", ")}.`,
    );
    assertCondition(
      DATE_RE.test(updated),
      `${label}: invalid updated date "${updated}". Expected YYYY-MM-DD.`,
    );

    validateMintlifyMdxSafety(label, body);

    const documentedRuleIds = new Set(
      [...body.matchAll(new RegExp(`\\b${PLUGIN_ID}/(ads-${adsNumber}-[a-z0-9-]+)\\b`, "g"))].map(
        (match) => `${PLUGIN_ID}/${match[1]}`,
      ),
    );

    const rules: DocsReferenceRule[] = [];
    for (const rule of catalogEntry.rules) {
      assertCondition(
        rule.id === `${PLUGIN_ID}/${rule.name}`,
        `Rule metadata mismatch for "${rule.name}": id must be "${PLUGIN_ID}/${rule.name}".`,
      );
      assertCondition(
        pluginRuleNames.has(rule.name),
        `Rule "${rule.name}" in catalog for ads/${folder} is not exported by the Redocly plugin.`,
      );
      assertCondition(
        pluginRecommendedRuleIds.has(rule.id),
        `Rule "${rule.id}" in catalog for ads/${folder} is missing from photon-ads/recommended.`,
      );
      assertCondition(
        documentedRuleIds.has(rule.id),
        `Rule "${rule.id}" exported by ads/${folder}/rules.ts is not documented in ${label}.`,
      );
      seenRuleNames.add(rule.name);
      rules.push({
        id: rule.id,
        severity: rule.severity,
        summary: rule.summary,
      });
    }

    for (const docRuleId of documentedRuleIds) {
      assertCondition(
        rules.some((rule) => rule.id === docRuleId),
        `${label} documents rule "${docRuleId}", which is not exported in ads/${folder}/rules.ts.`,
      );
    }

    if (status !== "Approved") {
      continue;
    }

    const exportedBody = stripLintRulesSection(body);
    assertCondition(
      exportedBody.length > 0,
      `${label}: body after removing Lint Rules section must not be empty.`,
    );
    validateMintlifyMdxSafety(label, exportedBody);

    standards.push({
      ads: adsNumber,
      slug: catalogEntry.slug,
      folder,
      title,
      sidebarTitle,
      description,
      status,
      updated,
      rules,
      body: exportedBody,
    });
  }

  for (const catalogEntry of standardsCatalog) {
    assertCondition(
      folders.includes(catalogEntry.folder),
      `Catalog entry "${catalogEntry.folder}" has no matching directory under ads/.`,
    );
  }

  for (const exportedRuleName of pluginRuleNames) {
    assertCondition(
      seenRuleNames.has(exportedRuleName),
      `Plugin rule "${exportedRuleName}" is not mapped to any ADS standard in src/catalog.ts.`,
    );
  }

  assertCondition(
    standards.length > 0,
    "At least one Approved ADS standard is required to export docs-reference.json.",
  );

  standards.sort((a, b) => a.ads.localeCompare(b.ads, "en"));

  return {
    schemaVersion: 1,
    family: "ads",
    source: {
      package: pkg.name,
      repository: CANONICAL_REPOSITORY,
      revision,
      version,
    },
    overview: {
      title: overviewTitle,
      sidebarTitle: overviewSidebarTitle,
      description: overviewDescription,
      body: overviewBody,
    },
    standards,
  };
}

export async function exportDocsReference(rootDir: string): Promise<string> {
  const reference = await buildDocsReference(rootDir);
  const outputDir = resolve(rootDir, "artifacts");
  const outputPath = resolve(outputDir, "docs-reference.json");
  await mkdir(outputDir, { recursive: true });
  await writeFile(outputPath, `${JSON.stringify(reference, null, 2)}\n`, "utf8");
  return outputPath;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const repoRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
  const outputPath = await exportDocsReference(repoRoot);
  console.log(`Exported deterministic docs reference to ${outputPath}`);
}
