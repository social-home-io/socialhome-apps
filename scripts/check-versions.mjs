// check-versions.mjs — CI guard: a PR that changes what an app (or the SDK)
// ships must bump its version and add a CHANGELOG entry. See RELEASING.md and
// scripts/version-guard-lib.mjs for the rule.
//
// "What an app ships" is checked twice: the files under apps/<id>/ the PR
// changes, and the built bundle itself — the merge base is built in a
// throwaway worktree (scripts/bundle-hash.mjs) and compared with this
// checkout's apps/*/dist/, so an SDK or build-tool change that alters an
// app's bundle needs that app's version bump too.
//
// Usage:  pnpm build && node scripts/check-versions.mjs <base-ref>
//         (CI passes origin/<base branch>; locally: origin/main)

import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

import { hashBundles, hashBundlesAt } from "./bundle-hash.mjs";
import { appIdOf, bundlesChanged, checkVersions } from "./version-guard-lib.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const baseRef = process.argv[2] ?? "origin/main";

function git(...args) {
  // stderr is ignored: `git show` of a file that doesn't exist yet (a new
  // app) is an expected miss, handled by jsonAt, not an error to print.
  return execFileSync("git", args, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
}

/** JSON of `file` at `ref`, or null when the file doesn't exist there. */
function jsonAt(ref, file) {
  try {
    return JSON.parse(git("show", `${ref}:${file}`));
  } catch {
    return null;
  }
}

const mergeBase = git("merge-base", baseRef, "HEAD").trim();
const changedFiles = git("diff", "--name-only", `${mergeBase}...HEAD`)
  .split("\n")
  .filter(Boolean);

// The bundles: this checkout's (built by `pnpm build` before this runs) and
// the merge base's, built the same way.
const head = hashBundles(root);
if (head.missing.length > 0) {
  console.error(`Version check: no built bundle for ${head.missing.join(", ")} — run \`pnpm build\` first.`);
  process.exit(1);
}
console.log(`Building ${baseRef} (merge base ${mergeBase.slice(0, 7)}) to compare the bundles…`);
const changedBundles = bundlesChanged(hashBundlesAt(root, mergeBase), head.hashes);

const ids = [
  ...new Set([...changedFiles.map(appIdOf).filter((id) => id !== null), ...changedBundles]),
];
const baseManifests = {};
const headManifests = {};
const headChangelogs = {};
for (const id of ids) {
  baseManifests[id] = jsonAt(mergeBase, `apps/${id}/manifest.json`);
  headManifests[id] = jsonAt("HEAD", `apps/${id}/manifest.json`);
  headChangelogs[id] = jsonAt("HEAD", `apps/${id}/CHANGELOG.json`);
}

const problems = checkVersions({
  changedFiles,
  baseManifests,
  headManifests,
  headChangelogs,
  baseSdkVersion: jsonAt(mergeBase, "packages/app-sdk/package.json")?.version ?? null,
  headSdkVersion: jsonAt("HEAD", "packages/app-sdk/package.json")?.version ?? null,
  changedBundles,
});

if (problems.length > 0) {
  console.error("Version check failed:\n");
  for (const p of problems) console.error(`  - ${p}`);
  console.error("\nSee RELEASING.md → \"Versions\".");
  process.exit(1);
}
console.log(
  ids.length > 0
    ? `Version check passed for: ${ids.join(", ")}`
    : "Version check passed (no app changes).",
);
console.log(
  changedBundles.length > 0
    ? `Bundles changed against ${baseRef}: ${changedBundles.join(", ")}`
    : `No bundle changed against ${baseRef}.`,
);
