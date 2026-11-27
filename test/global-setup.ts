import { execFileSync } from "node:child_process";
import { rmSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));

export default function globalSetup(): void {
  // Compile dist/ once before test workers spawn so parallel Redocly CLI tests
  // never observe a half-written dist/ file from another worker's tsc run.
  rmSync(resolve(REPO_ROOT, "dist"), { recursive: true, force: true });
  execFileSync(resolve(REPO_ROOT, "node_modules/.bin/tsc"), ["-p", "tsconfig.build.json"], {
    cwd: REPO_ROOT,
    stdio: "inherit",
  });
}
