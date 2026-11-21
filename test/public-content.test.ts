import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { checkCommitRange, checkText, contentFindings } from "../tools/public-content/check.mjs";

const REPO_ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));

describe("public-content guard", () => {
  it("allows clean public ADS documentation and identifiers", () => {
    const sample = [
      "ADS-0001: Resource Identifiers and Path Parameter Naming",
      "RFC-2119, UTF-8, SHA-256, ISO-8601, Apache-2.0",
      "@photon-ai/api-design-standards",
      "https://github.com/photon-hq/api-design-standards",
      "https://api.example.com/v1/projects/{projectId}/api-keys/{apiKeyId}",
    ].join("\n");

    expect(contentFindings(sample)).toEqual([]);
    expect(() => checkText("sample", sample)).not.toThrow();
  });

  it("blocks local filesystem paths including JSON-serialized Windows paths", () => {
    const unixPath = ["/", "Users", "/developer/repo/file.ts"].join("");
    const linuxPath = ["/", "home", "/runner/work/repo"].join("");
    const wsPath = ["/", "workspace", "/repo/file.ts"].join("");
    const winJsonPath = JSON.stringify({
      path: ["C:", "\\", "Users", "\\", "alice", "\\", "repo"].join(""),
    });

    expect(contentFindings(unixPath)).toContain("local-filesystem-path");
    expect(contentFindings(linuxPath)).toContain("local-filesystem-path");
    expect(contentFindings(wsPath)).toContain("local-filesystem-path");
    expect(contentFindings(winJsonPath)).toContain("local-filesystem-path");
  });

  it("blocks credential-shaped values", () => {
    const fakeGhToken = ["ghp", "_", "A".repeat(36)].join("");
    const fakePem = ["-----BEGIN ", "PRIVATE KEY-----"].join("");
    const fakeAws = ["AKIA", "0123456789ABCDEF"].join("");

    expect(contentFindings(fakeGhToken)).toContain("credential-shaped-value");
    expect(contentFindings(fakePem)).toContain("credential-shaped-value");
    expect(contentFindings(fakeAws)).toContain("credential-shaped-value");
  });

  it("blocks internal package dependencies", () => {
    const dep = ['import x from "@photon-', 'hq/internal-pkg";'].join("");
    expect(contentFindings(dep)).toContain("internal-package-dependency");
  });

  it("blocks internal issue keys and tracker URLs in tracked files while allowing them in commit messages", () => {
    const issueKey = ["E", "N", "G", "-", "6335"].join("");
    const trackerUrl = ["https://", "linear", ".app/org/issue/123"].join("");

    expect(contentFindings(`Part of ${issueKey}`)).toContain("internal-issue-reference");
    expect(contentFindings(trackerUrl)).toContain("internal-issue-reference");

    // Commit messages allow the issue key trailer while still checking everything else.
    expect(
      contentFindings(`feat(ads): initialize (${issueKey})`, { checkIssueKeys: false }),
    ).toEqual([]);
  });

  it("inspects base64 inline JSON payloads and JSON unicode escapes", () => {
    const escaped = JSON.stringify({ path: ["/", "Users", "/alice/secret"].join("") }).replace(
      "Users",
      "\\u0055sers",
    );
    expect(contentFindings(escaped)).toContain("local-filesystem-path");

    const encoded = Buffer.from(
      JSON.stringify({ key: ["ghp", "_", "B".repeat(36)].join("") }),
      "utf8",
    ).toString("base64");
    expect(contentFindings(`data:application/json;base64,${encoded}`)).toContain(
      "credential-shaped-value",
    );
  });

  it("scans every commit message in a git revision range", () => {
    // Exercise the live git path against the current checkout history.
    expect(checkCommitRange(REPO_ROOT, "HEAD")).toBeGreaterThanOrEqual(1);

    // Verify an earlier commit carrying a blocked token is caught even when HEAD is clean.
    const leakedToken = ["ghp", "_", "Z".repeat(36)].join("");
    const messages: Record<string, string> = {
      "2222222222222222222222222222222222222222": "chore: clean head commit\n",
      "1111111111111111111111111111111111111111": `feat: leaked ${leakedToken}\n`,
    };
    const fakeGit = (_root: string, args: string[]): string => {
      if (args[0] === "rev-list") {
        return Object.keys(messages).join("\n");
      }
      if (args[0] === "log") {
        const sha = args[3] ?? "";
        return messages[sha] ?? "";
      }
      throw new Error(`Unexpected git args: ${args.join(" ")}`);
    };

    expect(() => checkCommitRange(REPO_ROOT, "base..head", fakeGit)).toThrow(
      /credential-shaped-value/,
    );
  });
});
