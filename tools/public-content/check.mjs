#!/usr/bin/env node
// Public content check. Every tracked file in this repository and every commit
// message must be free of internal identifiers, local paths, credential-shaped
// values, and internal package dependencies. Tracked files must also be free of
// internal issue-tracker keys and URLs. Internal identifiers are listed only as
// SHA-256 hashes.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

export const internalTermHashes = new Set([
  "6dfcd9a8e3a02a70bac21971c0b69561884359f850d7151d3451ed755f3f8099",
  "b44c7eaf88e2843fa6821c682d49ff33a473b248ef52b86ce70163b9fd0c8718",
  "56d5d419fab9f9c394847225d03291358160bf14f4abc8ff4ac13aea26cd2223",
  "65b0e2cea7cd42eb7815cfaacf2bc035e090cd1fea93319ef26e8457a2783903",
  "7df2ef96bcfe02fc865847731c9031584ab582563a84f2d923069b85c5e60190",
  "11810ec2a8369536786230b73126e43c173ada26da4ae75c957764d149e13f8f",
  "17c96ba030dbc76afbfe3ae5e5dcd1642beda1268de7e0a02b0470671eb00dfc",
  "212776f49d894288d048e4bb68f80b3524aad80487e506af7239231ef5d72efd",
  "f0fcf169a84eb47b6b94abdd6311644f4f25ddcf4d4cf220c599723c30cff551",
  "236c06d735c2d978446c40aff313c9a0530a712efd4186fee52da138c7d8095d",
  "addc3bcdc97955777d35537fb66ee622dd02b72d3d14390596127d254eab56b2",
  "ee4290e15e9a2f894e730a406061e2ac1bb679e167c2c1712a834b90351b8ad8",
  "469e20d57eb53c4d2de1aa350c07bb9c82dc39d1c19ef2cc3f0d22b564de0b6d",
  "7e8a134f4188a9e8b8dc5888be72fb6fb52b6cd91bf619e3baa3dfa1c96d1e2e",
  "8fc74e386bb5f6a3c962c509b4f2d0f445df25a002d6f805b8620b510c7e9f87",
  "1aa14fcfb101ab0dc42f86de9bf242ea4898dd96f1d186ade5ca6e6918f052d4",
  "97135148b83513ab746db5f5158732622b6590e85c5995d774dde956d6ba0733",
  "1f575ee7dca1009d45cc1329824e52eff489e15ab3f95261e4620aa94791a1e9",
  "255efeffc0d091d02b71f1c43822689c069e09aedc776c954d443bd45ee0080a",
  "bae32160166a9dd0d5b0f6f47ec25ac92f964294259ed28e57e01c7936b146f5",
  "fff740d935ebad958ee8b578c42620bcc1201e1ead0399eda519195922d9dd90",
  "4b3a945ebf7300c565dcb33a17ae283e6cad7d05ac3e86bcd043b4e6bbf0e6b2",
  "c947ba79b98323b709aa371cf326f2d43ca1d18ac8085578678b50d5abd1d0cd",
  "72e230a57008249e528b92baf6cbef16e1ccb10ae8322929319cbed4f9f3024a",
  "27084dcd0c23dec1ea5805c32a27e2854a5bfcac20f2df2576fd1e438e2b1c27",
  "e578bff2e17aa0f51d092ab52f81ad3d1b78cb6ae0772dffb7728b698a135446",
]);

export const blockedIssuePrefixHashes = new Set([
  "82fe032bd9337b5dfb99b28717cf8651daac73f2d319e6d6213544660b961ee7",
  "ce69118d2572468ab7efc0bc1480279e7c62f594d89369988cef524a9fa40290",
  "bd1505eba5af8be0aed5523f432c8c011b38f6296d4063dc016ca973d62135a3",
  "a92c36e66a25ee99ff862faa8e87987be6c7cd13c3ee661c400a45b0f1e3b132",
  "add93534eeb463800fe0ed0946048d33636dd2a014fab92e8a37f77ce98c740b",
  "eb0de251ac21fb6753f04bc96527b0ff0686b585de75f924aedd7ba90502d6b4",
]);

const rules = [
  [
    "local-filesystem-path",
    /\/Users\/[A-Za-z0-9_.-]+\/|\/home\/(?:runner|[a-z][a-z0-9_-]*)\/|\/private\/tmp\/|\/workspace\/|[A-Z]:\\Users\\/,
  ],
  [
    "credential-shaped-value",
    /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----|\bgh[pousr]_[A-Za-z0-9]{30,}\b|\bgithub_pat_[A-Za-z0-9_]{30,}\b|\bxox[baprs]-[A-Za-z0-9-]{20,}\b|\bAKIA[0-9A-Z]{16}\b|\bpho_(?:ask|sk)_[A-Za-z0-9_-]{20,}\b|\bnpm_[A-Za-z0-9]{36}\b|\bpypi-[A-Za-z0-9_-]{50,}\b/,
  ],
  [
    "internal-package-dependency",
    /(?:\b(?:from|import)\s*|\b(?:require(?:\.resolve)?|import)\s*\(\s*)(["'])@photon-hq\/(?!api-design-standards(?:\/[^"']*)?\1)[^"']+\1|(["'])@photon-hq\/(?!api-design-standards(?:\/[^"']*)?\2)[^"']+\2\s*:|(?:node_modules\/|registry\.npmjs\.org\/|npm\.pkg\.github\.com\/)@photon-hq(?:\/|%2f)(?!api-design-standards(?![a-z0-9_.-]))[a-z0-9_.-]+/i,
  ],
];

const LINEAR_URL_RE = /https?:\/\/linear\.app\//i;
const ISSUE_KEY_RE = /\b([A-Z]{2,6})-(\d{1,6})\b/g;

const sha256 = (text) => createHash("sha256").update(text).digest("hex");

/** Lowercase tokens, their path segments and pairs, words and host suffixes. */
export function candidates(text) {
  const result = new Set();
  for (const [token] of text.matchAll(/[A-Za-z0-9@][A-Za-z0-9@._/-]*/g)) {
    const lower = token.toLowerCase().replace(/[._/-]+$/, "");
    result.add(lower);
    const segments = lower.split("/").filter(Boolean);
    segments.forEach((segment, index) => {
      result.add(segment);
      if (index + 1 < segments.length) {
        result.add(`${segment}/${segments[index + 1]}`);
        result.add(`${segment}/${segments[index + 1].split(".")[0]}`);
      }
      const labels = segment.split(".");
      for (let start = 1; start < labels.length - 1; start += 1) {
        result.add(labels.slice(start).join("."));
      }
    });
    for (const word of lower.split(/[^a-z0-9]+/)) {
      if (word) {
        result.add(word);
      }
    }
  }
  return result;
}

export function contentFindings(text, { checkIssueKeys = true, depth = 0 } = {}) {
  assert.ok(depth < 100, "Content nesting exceeds inspection limit");
  const findings = new Set();

  const inspect = (value, level) => {
    assert.ok(level < 100, "Content nesting exceeds inspection limit");
    if (typeof value === "string") {
      for (const [name, rule] of rules) {
        if (rule.test(value)) {
          findings.add(name);
        }
      }
      if (checkIssueKeys) {
        if (LINEAR_URL_RE.test(value)) {
          findings.add("internal-issue-reference");
        } else {
          for (const match of value.matchAll(ISSUE_KEY_RE)) {
            const prefix = match[1]?.toLowerCase();
            if (prefix && blockedIssuePrefixHashes.has(sha256(prefix))) {
              findings.add("internal-issue-reference");
              break;
            }
          }
        }
      }
      for (const candidate of candidates(value)) {
        if (internalTermHashes.has(sha256(candidate))) {
          findings.add("internal-identifier");
          break;
        }
      }
      for (const match of value.matchAll(
        /data:application\/json(?:;charset=[\w-]+)?;base64,([A-Za-z0-9+/=]+)/g,
      )) {
        inspect(Buffer.from(match[1], "base64").toString("utf8"), level + 1);
      }
      const trimmed = value.trimStart();
      if (
        trimmed.startsWith("{") ||
        trimmed.startsWith("[") ||
        trimmed.startsWith('"') ||
        value.includes("\\u")
      ) {
        try {
          const decoded = JSON.parse(value);
          if (decoded !== value && (typeof decoded === "string" || typeof decoded === "object")) {
            inspect(decoded, level + 1);
          }
        } catch (error) {
          if (!(error instanceof SyntaxError)) {
            throw error;
          }
        }
      }
    } else if (Array.isArray(value)) {
      for (const item of value) {
        inspect(item, level + 1);
      }
    } else if (value !== null && typeof value === "object") {
      for (const [key, item] of Object.entries(value)) {
        inspect(key, level + 1);
        inspect(item, level + 1);
      }
    }
  };

  inspect(text, depth);
  return [...findings].sort();
}

export function checkText(label, text, options = {}) {
  const findings = contentFindings(text, options);
  assert.deepEqual(findings, [], `Blocked content in ${label}: ${findings.join(", ")}`);
}

const defaultGitRunner = (root, args) =>
  execFileSync("git", args, {
    cwd: root,
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
  });

export function checkCommitRange(root, revRange, gitRunner = defaultGitRunner) {
  const output = gitRunner(root, ["rev-list", revRange]);
  const commits = output.split(/\r?\n/).filter(Boolean);
  assert.ok(commits.length > 0, `No commits found in range ${revRange}`);
  for (const sha of commits) {
    const message = gitRunner(root, ["log", "-1", "--format=%B", sha]);
    checkText(`commit ${sha.slice(0, 12)} message`, message, { checkIssueKeys: false });
  }
  return commits.length;
}

async function walk(root, prefix = "") {
  const result = [];
  for (const entry of await readdir(resolve(root, prefix), { withFileTypes: true })) {
    const path = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      result.push(...(await walk(root, path)));
    } else if (entry.isFile()) {
      result.push(path);
    } else {
      throw new Error(`Not a regular file: ${path}`);
    }
  }
  return result;
}

function trackedFiles(root) {
  const output = execFileSync("git", ["ls-files", "-z"], {
    cwd: root,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  return output.split("\0").filter(Boolean);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const tree = process.argv.indexOf("--tree");
  const root = tree === -1 ? process.cwd() : resolve(process.argv[tree + 1]);
  const paths = tree === -1 ? trackedFiles(root) : await walk(root);
  assert.ok(paths.length > 0, "No tracked files to check");
  for (const path of paths) {
    const bytes = await readFile(resolve(root, path));
    assert.ok(!bytes.includes(0), `Binary content is not public source: ${path}`);
    checkText(path, new TextDecoder("utf-8", { fatal: true }).decode(bytes), {
      checkIssueKeys: true,
    });
  }
  const commitRangeIndex = process.argv.indexOf("--commit-range");
  let checkedCommits = 0;
  if (commitRangeIndex !== -1) {
    const revRange = process.argv[commitRangeIndex + 1];
    assert.ok(revRange, "--commit-range requires a git revision range");
    checkedCommits = checkCommitRange(root, revRange);
  } else if (process.argv.includes("--commit-message")) {
    checkText(
      "the HEAD commit message",
      execFileSync("git", ["log", "-1", "--format=%B"], { cwd: root, encoding: "utf8" }),
      { checkIssueKeys: false },
    );
    checkedCommits = 1;
  }
  const commitNote = checkedCommits > 0 ? `, ${checkedCommits} commit message(s)` : "";
  console.log(`Public content check passed (${paths.length} files${commitNote}).`);
}
