import { execFileSync } from "node:child_process";
import { access, mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parse as parseYaml } from "yaml";
import { ADS_STANDARDS, PLUGIN_ID } from "../src/catalog.js";
import { createPhotonAdsPlugin } from "../src/plugin.js";
import type { AdsRuleSeverity, AdsStatus } from "../src/types.js";

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

const VALID_STATUSES = new Set<AdsStatus>(["Draft", "Reviewing", "Approved", "Deprecated"]);
const ADS_FOLDER_RE = /^(\d{4})-([a-z0-9]+(?:-[a-z0-9]+)*)$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/;
const LEADING_H1_RE = /^\s*#\s+[^\r\n]+\r?\n?/;
const INLINE_RELATIVE_MD_LINK_RE = /\]\(\.\.?\/[^)]+\.md(?:#[^)]*)?\)/;
const REF_RELATIVE_MD_LINK_RE = /^\s*\[[^\]]+\]:\s*<?\.\.?\/[^\s>]+\.md(?:#[^\s>]*)?>?(?:\s|$)/;
const CANONICAL_REPOSITORY = "photon-hq/api-design-standards";
const OVERVIEW_TITLE = "API Design Standards";
const OVERVIEW_SIDEBAR_TITLE = "Overview";
const OVERVIEW_DESCRIPTION =
  "Public HTTP API design standards and deterministic OpenAPI lint rules for Photon APIs.";

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

  const withoutH1 = content.replace(LEADING_H1_RE, "").trim();
  return { frontmatter, body: withoutH1 };
}

/**
 * Strips fenced code blocks and inline code spans (including spans wrapped
 * across line breaks within a paragraph) while preserving line numbers so MDX
 * syntax validation inspects only prose and Markdown table text.
 */
function stripCodeFromMarkdown(markdown: string): string {
  const lines = markdown.split(/\r?\n/);
  const withoutFences: string[] = [];
  let activeFence: { char: string; length: number } | null = null;

  for (const line of lines) {
    const trimmed = line.trimStart();
    if (activeFence) {
      const closeRe = new RegExp(`^${activeFence.char}{${activeFence.length},}\\s*$`);
      if (closeRe.test(trimmed)) {
        activeFence = null;
      }
      withoutFences.push("");
      continue;
    }

    const openMatch = /^(`{3,}|~{3,})/.exec(trimmed);
    if (openMatch?.[1]) {
      activeFence = { char: openMatch[1][0] ?? "`", length: openMatch[1].length };
      withoutFences.push("");
      continue;
    }

    withoutFences.push(line);
  }

  assertCondition(activeFence === null, "Unclosed fenced code block in Markdown document.");

  // Strip inline code spans paragraph by paragraph (CommonMark code spans can
  // cross single line breaks, but never blank lines).
  const resultLines: string[] = [];
  let paragraph: string[] = [];

  const flushParagraph = (): void => {
    if (paragraph.length === 0) {
      return;
    }
    const stripped = stripInlineCodeSpans(paragraph.join("\n"));
    resultLines.push(...stripped.split("\n"));
    paragraph = [];
  };

  for (const line of withoutFences) {
    if (line.trim().length === 0) {
      flushParagraph();
      resultLines.push("");
    } else {
      paragraph.push(line);
    }
  }
  flushParagraph();

  return resultLines.join("\n");
}

function stripInlineCodeSpans(text: string): string {
  let result = "";
  let index = 0;

  while (index < text.length) {
    if (text[index] === "`") {
      let tickEnd = index;
      while (tickEnd < text.length && text[tickEnd] === "`") {
        tickEnd += 1;
      }
      const tickCount = tickEnd - index;
      let searchFrom = tickEnd;
      let closingStart = -1;

      while (searchFrom < text.length) {
        const nextTick = text.indexOf("`", searchFrom);
        if (nextTick === -1) {
          break;
        }
        let closeEnd = nextTick;
        while (closeEnd < text.length && text[closeEnd] === "`") {
          closeEnd += 1;
        }
        if (closeEnd - nextTick === tickCount) {
          closingStart = nextTick;
          break;
        }
        searchFrom = closeEnd;
      }

      if (closingStart !== -1) {
        // Preserve newlines inside multi-line code spans so line numbers stay exact.
        const span = text.slice(index, closingStart + tickCount);
        result += span.replace(/[^\n]/g, "");
        index = closingStart + tickCount;
        continue;
      }

      result += text.slice(index, tickEnd);
      index = tickEnd;
      continue;
    }
    result += text[index];
    index += 1;
  }

  return result;
}

export function validateMintlifyMdxSafety(label: string, markdown: string): void {
  const prose = stripCodeFromMarkdown(markdown);
  const lines = prose.split("\n");

  for (const [index, line] of lines.entries()) {
    const lineNum = index + 1;
    // Allow escaped braces (\{ or \}) but reject any raw { or } outside code.
    const unescapedBraces = line.replace(/\\[{}]/g, "");
    if (/[{}]/.test(unescapedBraces)) {
      throw new Error(
        `Mintlify MDX safety violation in ${label} (line ${lineNum}): unescaped curly brace outside code span: ${line.trim()}`,
      );
    }

    // Reject any unescaped "<" outside code spans (preserving "\<" escapes),
    // preventing broken JSX tags or literal angle brackets in Mintlify MDX.
    const unescapedAngles = line.replace(/\\</g, "");
    if (unescapedAngles.includes("<")) {
      throw new Error(
        `Mintlify MDX safety violation in ${label} (line ${lineNum}): unescaped "<" outside code span: ${line.trim()}`,
      );
    }

    // Reject repo-relative .md links (both inline and reference-style definitions)
    // that would break once rendered in Mintlify.
    if (INLINE_RELATIVE_MD_LINK_RE.test(line) || REF_RELATIVE_MD_LINK_RE.test(line)) {
      throw new Error(`Invalid relative .md link in ${label} (line ${lineNum}): ${line.trim()}`);
    }
  }
}

export function rewriteOverviewLinksForDocs(markdown: string): string {
  return markdown
    .replace(
      /\]\(\.\/ads\/(\d{4})-[a-z0-9-]+\/index\.md(#[^)]*)?\)/g,
      (_match, num: string, hash: string | undefined) => `](./ads-${num}${hash ?? ""})`,
    )
    .replace(
      /\]\(\.\/LICENSE\)/g,
      `](https://github.com/${CANONICAL_REPOSITORY}/blob/main/LICENSE)`,
    );
}

function readGitRevision(rootDir: string): string {
  const envSha = process.env.GITHUB_SHA?.trim();
  if (envSha && /^[a-f0-9]{40}$/.test(envSha)) {
    return envSha;
  }
  const sha = execFileSync("git", ["rev-parse", "HEAD"], {
    cwd: rootDir,
    encoding: "utf8",
  }).trim();
  assertCondition(/^[a-f0-9]{40}$/.test(sha), `Expected 40-char git revision SHA, got "${sha}".`);
  return sha;
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

export async function buildDocsReference(rootDir: string): Promise<DocsReferenceDocument> {
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

  const revision = readGitRevision(rootDir);

  const readmePath = resolve(rootDir, "README.md");
  const readmeRaw = await readFile(readmePath, "utf8");
  const { body: rawOverviewBody } = stripFrontmatterAndH1(readmeRaw);
  const overviewBody = rewriteOverviewLinksForDocs(rawOverviewBody);
  assertCondition(overviewBody.length > 0, "README.md overview body must not be empty.");
  validateMintlifyMdxSafety("README.md (overview)", overviewBody);

  const adsDir = resolve(rootDir, "ads");
  const entries = await readdir(adsDir, { withFileTypes: true });
  const folders = entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort((a, b) => a.localeCompare(b, "en"));

  assertCondition(folders.length > 0, "No ADS folders found under ads/.");

  const plugin = createPhotonAdsPlugin();
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

    const catalogEntry = ADS_STANDARDS.find((item) => item.folder === folder);
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
      body,
    });
  }

  for (const catalogEntry of ADS_STANDARDS) {
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

  standards.sort((a, b) => a.ads.localeCompare(b.ads, "en"));

  return {
    schemaVersion: 1,
    family: "ads",
    source: {
      package: pkg.name,
      repository: CANONICAL_REPOSITORY,
      revision,
      version: pkg.version,
    },
    overview: {
      title: OVERVIEW_TITLE,
      sidebarTitle: OVERVIEW_SIDEBAR_TITLE,
      description: OVERVIEW_DESCRIPTION,
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
