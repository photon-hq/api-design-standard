import { execFileSync } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

interface PackageManifest {
  readonly version: string;
  readonly [key: string]: unknown;
}

const STABLE_VERSION_RE = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const STAGING_SUFFIX_RE = /^-staging\.\d+\.\d+$/;
const GIT_SHA_RE = /^[a-f0-9]{40}$/;

const destination = process.env.PACK_DESTINATION;
if (!destination) {
  throw new Error("PACK_DESTINATION is required");
}

const suffix = process.env.RELEASE_SUFFIX ?? "";
if (suffix !== "" && !STAGING_SUFFIX_RE.test(suffix)) {
  throw new Error("RELEASE_SUFFIX must be empty or -staging.<run id>.<attempt>");
}

const original = await readFile("package.json", "utf8");
const manifest = JSON.parse(original) as PackageManifest;
const releaseVersion = process.env.RELEASE_VERSION ?? manifest.version;
if (!STABLE_VERSION_RE.test(releaseVersion)) {
  throw new Error("The release version must be a stable X.Y.Z version");
}

const photonSourceSha = execFileSync("git", ["rev-parse", "HEAD"], {
  encoding: "utf8",
}).trim();
if (!GIT_SHA_RE.test(photonSourceSha)) {
  throw new Error(`Expected 40-char git revision SHA, got "${photonSourceSha}"`);
}

await mkdir(destination, { recursive: true });
execFileSync("pnpm", ["build"], { stdio: "inherit" });

try {
  await writeFile(
    "package.json",
    `${JSON.stringify({ ...manifest, version: releaseVersion + suffix, photonSourceSha }, null, 2)}\n`,
  );
  execFileSync("npm", ["pack", "--ignore-scripts", "--pack-destination", resolve(destination)], {
    stdio: "inherit",
  });
} finally {
  await writeFile("package.json", original);
}
