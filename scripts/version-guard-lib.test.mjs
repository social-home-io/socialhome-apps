import { describe, expect, it } from "vitest";

import { appIdOf, bundlesChanged, checkVersions, compareSemver, shipsCode } from "./version-guard-lib.mjs";

const changelog = (version) => [{ version, date: "2026-10-30", notes: { en: "x" } }];

function check(over = {}) {
  return checkVersions({
    changedFiles: ["apps/chess/src/main.ts"],
    baseManifests: { chess: { version: "2026.10.30" } },
    headManifests: { chess: { version: "2026.10.31" } },
    headChangelogs: { chess: changelog("2026.10.31") },
    baseSdkVersion: "1.7.0",
    headSdkVersion: "1.7.0",
    ...over,
  });
}

describe("shipsCode / appIdOf", () => {
  it("ignores tests and docs", () => {
    expect(shipsCode("apps/chess/src/chess.test.ts")).toBe(false);
    expect(shipsCode("apps/chess/README.md")).toBe(false);
    expect(shipsCode("scripts/catalog-lib.test.mjs")).toBe(false);
    expect(shipsCode("apps/chess/src/main.ts")).toBe(true);
    expect(shipsCode("apps/chess/public/style.css")).toBe(true);
  });
  it("reads the app id", () => {
    expect(appIdOf("apps/chess/src/main.ts")).toBe("chess");
    expect(appIdOf("packages/app-sdk/src/index.ts")).toBeNull();
  });
});

describe("checkVersions", () => {
  it("passes a bumped app with its CHANGELOG entry", () => {
    expect(check()).toEqual([]);
  });

  it("fails an app change without a version bump", () => {
    const problems = check({ headManifests: { chess: { version: "2026.10.30" } }, headChangelogs: { chess: changelog("2026.10.30") } });
    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatch(/bump "version" in apps\/chess\/manifest.json above 2026.10.30/);
  });

  it("fails a version that goes down", () => {
    const problems = check({ headManifests: { chess: { version: "2026.10.29" } }, headChangelogs: { chess: changelog("2026.10.29") } });
    expect(problems.join("\n")).toMatch(/above 2026.10.30/);
  });

  it("fails a bump without a CHANGELOG entry", () => {
    expect(check({ headChangelogs: { chess: changelog("2026.10.30") } }).join("\n")).toMatch(/CHANGELOG.json entry for 2026.10.31/);
    expect(check({ headChangelogs: { chess: null } }).join("\n")).toMatch(/CHANGELOG.json entry/);
  });

  it("needs nothing for test- or docs-only changes", () => {
    expect(
      check({
        changedFiles: ["apps/chess/src/chess.test.ts", "README.md"],
        headManifests: { chess: { version: "2026.10.30" } },
        headChangelogs: { chess: changelog("2026.10.30") },
      }),
    ).toEqual([]);
  });

  it("accepts a new app with a CHANGELOG entry for its first version", () => {
    expect(
      check({
        changedFiles: ["apps/battleships/manifest.json", "apps/battleships/src/main.ts"],
        baseManifests: { battleships: null },
        headManifests: { battleships: { version: "2026.10.30" } },
        headChangelogs: { battleships: changelog("2026.10.30") },
      }),
    ).toEqual([]);
  });

  it("ignores a removed app", () => {
    expect(check({ headManifests: { chess: null } })).toEqual([]);
  });

  it("fails a non-CalVer version", () => {
    expect(check({ headManifests: { chess: { version: "1.0.0" } } }).join("\n")).toMatch(/not CalVer/);
  });

  it("needs an SDK bump when the SDK changes", () => {
    const problems = check({ changedFiles: ["packages/app-sdk/src/index.ts"] });
    expect(problems.join("\n")).toMatch(/bump "version" in packages\/app-sdk\/package.json above 1.7.0/);
    expect(check({ changedFiles: ["packages/app-sdk/src/index.ts"], headSdkVersion: "1.8.0" })).toEqual([]);
    expect(check({ changedFiles: ["packages/app-sdk/src/index.test.ts"] })).toEqual([]);
  });

  it("compares semver numerically", () => {
    expect(compareSemver("1.10.0", "1.9.0")).toBeGreaterThan(0);
    expect(compareSemver("1.7.0", "1.7.0")).toBe(0);
  });
});

describe("bundles that changed without a file of the app (SDK, build tools)", () => {
  // The SDK grew by a minor version, and every app's bundle with it (PR #29).
  const sdkOnly = {
    changedFiles: ["packages/app-sdk/src/index.ts", "packages/app-sdk/package.json"],
    baseManifests: { chess: { version: "2026.10.30" }, go: { version: "2026.10.31" } },
    headManifests: { chess: { version: "2026.10.30" }, go: { version: "2026.10.31" } },
    headChangelogs: { chess: changelog("2026.10.30"), go: changelog("2026.10.31") },
    headSdkVersion: "1.8.0",
  };

  it("bundlesChanged lists apps built differently on both sides, sorted", () => {
    expect(bundlesChanged({ go: "a", chess: "b", quiz: "c" }, { go: "x", chess: "b", quiz: "y" })).toEqual(["go", "quiz"]);
    expect(bundlesChanged({ chess: "b" }, { chess: "b" })).toEqual([]);
  });

  it("bundlesChanged leaves new and removed apps to the file check", () => {
    expect(bundlesChanged({ old: "a" }, { fresh: "b" })).toEqual([]);
  });

  it("an SDK change that alters an app's bundle needs that app's version bump", () => {
    const problems = check({ ...sdkOnly, changedBundles: ["chess", "go"] });
    expect(problems).toHaveLength(2); // a version bump, for each app
    expect(problems.join("\n")).toMatch(/apps\/chess: this PR changes the app's built bundle .* bump "version" .* above 2026.10.30/);
    expect(problems.join("\n")).toMatch(/apps\/go: this PR changes the app's built bundle/);
  });

  it("passes once each changed bundle's app is bumped with a CHANGELOG entry", () => {
    expect(
      check({
        ...sdkOnly,
        changedBundles: ["chess"],
        headManifests: { ...sdkOnly.headManifests, chess: { version: "2026.10.31" } },
        headChangelogs: { ...sdkOnly.headChangelogs, chess: changelog("2026.10.31") },
      }),
    ).toEqual([]);
  });

  it("an SDK change that leaves every bundle as it was needs only the SDK bump", () => {
    expect(check({ ...sdkOnly, changedBundles: [] })).toEqual([]);
  });

  it("a tool bump (lockfile only) that changes a bundle is caught too", () => {
    const problems = check({
      ...sdkOnly,
      changedFiles: ["pnpm-lock.yaml", "package.json"],
      headSdkVersion: "1.7.0",
      changedBundles: ["go"],
    });
    expect(problems.join("\n")).toMatch(/apps\/go: this PR changes the app's built bundle/);
    expect(problems.join("\n")).not.toMatch(/apps\/chess/);
  });

  it("an app whose own files changed keeps the usual message", () => {
    const problems = check({
      changedFiles: ["apps/chess/src/main.ts"],
      headManifests: { chess: { version: "2026.10.30" } },
      changedBundles: ["chess"],
    });
    expect(problems.join("\n")).toMatch(/apps\/chess: this PR changes what the app ships/);
  });
});
