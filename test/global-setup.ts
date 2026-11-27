import { execFileSync } from "node:child_process";
import { rmSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { TestProject } from "vitest/node";

const REPO_ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));

function buildDist(): void {
  rmSync(resolve(REPO_ROOT, "dist"), { recursive: true, force: true });
  execFileSync(resolve(REPO_ROOT, "node_modules/.bin/tsc"), ["-p", "tsconfig.build.json"], {
    cwd: REPO_ROOT,
    stdio: "inherit",
  });
}

export default function globalSetup(project: TestProject): void {
  // Compile dist/ once before test workers spawn (and before watch-mode reruns)
  // so parallel Redocly CLI tests never observe a half-written dist/ file.
  buildDist();
  project.onTestsRerun(buildDist);
}
