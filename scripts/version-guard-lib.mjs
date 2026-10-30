// version-guard-lib.mjs — the rule behind scripts/check-versions.mjs.
//
// Social Home only offers an update when an app's manifest `version` goes UP,
// and its "What's new" comes from CHANGELOG.json. So a pull request that
// changes what an app ships must bump that app's version and add the
// CHANGELOG entry for it — otherwise the change sits in every release
// unseen. The same holds for the SDK's package.json version.
//
// Pure functions only (no git, no fs), so they are unit-tested directly.

import { compareCalver, parseCalver } from "./catalog-lib.mjs";

/**
 * Files that don't change what an app ships: tests and docs. A PR that only
 * touches these needs no version bump.
 */
export function shipsCode(path) {
  const name = path.split("/").pop() ?? "";
  if (/\.test\.[cm]?[jt]sx?$/.test(name)) return false;
  if (/\.md$/i.test(name)) return false;
  return true;
}

/** `apps/<id>/…` → `<id>`, else null. */
export function appIdOf(path) {
  const m = /^apps\/([^/]+)\//.exec(path);
  return m ? m[1] : null;
}

/** Plain semver compare for the SDK (`1.7.0`); NaN-safe. */
export function compareSemver(a, b) {
  const pa = String(a).split(".").map((x) => Number.parseInt(x, 10) || 0);
  const pb = String(b).split(".").map((x) => Number.parseInt(x, 10) || 0);
  for (let i = 0; i < 3; i++) {
    if ((pa[i] ?? 0) !== (pb[i] ?? 0)) return (pa[i] ?? 0) - (pb[i] ?? 0);
  }
  return 0;
}

/**
 * Check a pull request.
 *
 * @param {object} input
 * @param {string[]} input.changedFiles   paths changed between base and head
 * @param {Record<string, {version?: string} | null>} input.baseManifests  app_id → base manifest (null = new app)
 * @param {Record<string, {version?: string} | null>} input.headManifests  app_id → head manifest (null = removed app)
 * @param {Record<string, Array<{version?: string}> | null>} input.headChangelogs app_id → head CHANGELOG.json
 * @param {string|null} input.baseSdkVersion
 * @param {string|null} input.headSdkVersion
 * @returns {string[]} problems, empty when the PR is fine
 */
export function checkVersions({
  changedFiles,
  baseManifests,
  headManifests,
  headChangelogs,
  baseSdkVersion,
  headSdkVersion,
}) {
  const problems = [];
  const shipping = changedFiles.filter(shipsCode);

  const apps = new Set(shipping.map(appIdOf).filter((id) => id !== null));
  for (const id of [...apps].sort()) {
    const head = headManifests[id];
    if (head === null || head === undefined) continue; // app removed
    const base = baseManifests[id] ?? null;
    const version = head.version;
    if (!parseCalver(version)) {
      problems.push(`apps/${id}: manifest version "${version}" is not CalVer YYYY.M.D[.N]`);
      continue;
    }
    if (base && parseCalver(base.version) && compareCalver(version, base.version) <= 0) {
      problems.push(
        `apps/${id}: this PR changes what the app ships, so bump "version" in ` +
          `apps/${id}/manifest.json above ${base.version} (CalVer, e.g. today's date)`,
      );
    }
    const top = headChangelogs[id]?.[0];
    if (!top || top.version !== version) {
      problems.push(
        `apps/${id}: add a CHANGELOG.json entry for ${version} at the top ` +
          `(notes in every language the app ships; ≤ 500 characters each)`,
      );
    }
  }

  const sdkChanged = shipping.some((p) => p.startsWith("packages/app-sdk/") && p !== "packages/app-sdk/package.json");
  if (sdkChanged && baseSdkVersion && headSdkVersion && compareSemver(headSdkVersion, baseSdkVersion) <= 0) {
    problems.push(
      `packages/app-sdk: this PR changes the SDK, so bump "version" in ` +
        `packages/app-sdk/package.json above ${baseSdkVersion} (minor for additions, major for breaking)`,
    );
  }
  return problems;
}
