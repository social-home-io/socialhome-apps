// check-versions.mjs — CI guard: a PR that changes what an app (or the SDK)
// ships must bump its version and add a CHANGELOG entry. See RELEASING.md and
// scripts/version-guard-lib.mjs for the rule.
//
// Usage:  node scripts/check-versions.mjs <base-ref>
//         (CI passes origin/<base branch>; locally: origin/main)

import { execFileSync } from "node:child_process";

import { appIdOf, checkVersions } from "./version-guard-lib.mjs";

const baseRef = process.argv[2] ?? "origin/main";

function git(...args) {
  // stderr is ignored: `git show` of a file that doesn't exist yet (a new
  // app) is an expected miss, handled by jsonAt, not an error to print.
  return execFileSync("git", args, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
}

/** JSON of `path` at `ref`, or null when the file doesn't exist there. */
function jsonAt(ref, path) {
  try {
    return JSON.parse(git("show", `${ref}:${path}`));
  } catch {
    return null;
  }
}

const mergeBase = git("merge-base", baseRef, "HEAD").trim();
const changedFiles = git("diff", "--name-only", `${mergeBase}...HEAD`)
  .split("\n")
  .filter(Boolean);

const ids = [...new Set(changedFiles.map(appIdOf).filter((id) => id !== null))];
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
