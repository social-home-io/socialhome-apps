import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

import {
  CatalogError,
  MAX_CATALOG_BYTES,
  MAX_CHANGELOG_ENTRIES,
  MAX_CHANGELOG_NOTE_CHARS,
  MAX_DESCRIPTION_CHARS,
  MAX_I18N_LOCALES,
  MAX_ICON_DATA_URI_BYTES,
  MAX_NAME_CHARS,
  MAX_PLAYERS,
  MIN_PLAYERS,
  buildEntry,
  compareCalver,
  parseCalver,
  permissionsFor,
  serializeCatalog,
  validateChangelog,
  validateManifest,
} from "./catalog-lib.mjs";

const REPO_ROOT = resolve(import.meta.dirname, "..");

function manifest(over = {}) {
  return {
    app_id: "chess",
    name: "Chess",
    version: "2026.10.29",
    description: "Play chess.",
    entry: "index.html",
    icon: "data:image/svg+xml,%3Csvg%2F%3E",
    capabilities: ["storage", "federation"],
    ...over,
  };
}

function entry(over = {}) {
  return { version: "2026.10.29", date: "2026-10-29", notes: { en: "New." }, ...over };
}

const bad = (fn, re) => expect(fn).toThrowError(re instanceof RegExp ? re : new RegExp(re));

describe("parseCalver / compareCalver", () => {
  it("parses YYYY.M.D and YYYY.M.D.N", () => {
    expect(parseCalver("2026.10.29")).toEqual([2026, 10, 29, 0]);
    expect(parseCalver("2026.6.3.2")).toEqual([2026, 6, 3, 2]);
  });
  it("rejects semver-ish and out-of-range values", () => {
    for (const v of ["1.0.0", "2026.13.1", "2026.1.32", "2026.10", "v2026.10.29", 2026]) {
      expect(parseCalver(v)).toBeNull();
    }
  });
  it("compares numerically, not as strings", () => {
    expect(compareCalver("2026.10.2", "2026.9.30")).toBeGreaterThan(0);
    expect(compareCalver("2026.10.29.1", "2026.10.29")).toBeGreaterThan(0);
    expect(compareCalver("2026.10.29", "2026.10.29")).toBe(0);
  });
});

describe("validateManifest", () => {
  it("accepts a v1 manifest (no v2 fields)", () => {
    expect(() => validateManifest(manifest())).not.toThrow();
  });

  it("accepts every v2 field", () => {
    expect(() =>
      validateManifest(
        manifest({
          min_age: 13,
          languages: ["en", "de", "pt-BR"],
          homepage: "https://example.org/chess",
          min_core_version: "2026.10.29",
          i18n: { de: { name: "Schach", description: "Spiel Schach." } },
        })
      )
    ).not.toThrow();
  });

  it("throws CatalogError, not a generic error", () => {
    expect(() => validateManifest(manifest({ name: "" }))).toThrow(CatalogError);
  });

  it.each(["app_id", "name", "version", "description", "entry", "icon", "capabilities"])(
    "requires %s",
    (field) => {
      const m = manifest();
      delete m[field];
      bad(() => validateManifest(m), `missing required field "${field}"`);
    }
  );

  it("bounds name and description (in characters, not bytes)", () => {
    expect(() => validateManifest(manifest({ name: "é".repeat(MAX_NAME_CHARS) }))).not.toThrow();
    bad(() => validateManifest(manifest({ name: "x".repeat(MAX_NAME_CHARS + 1) })), "name is 41 characters");
    bad(
      () => validateManifest(manifest({ description: "x".repeat(MAX_DESCRIPTION_CHARS + 1) })),
      "description is 301 characters"
    );
  });

  it("requires CalVer versions", () => {
    bad(() => validateManifest(manifest({ version: "1.0.0" })), "not CalVer");
    bad(() => validateManifest(manifest({ min_core_version: "latest" })), "min_core_version");
  });

  it("rejects bad app ids", () => {
    bad(() => validateManifest(manifest({ app_id: "Chess App" })), "app_id");
  });

  it("rejects unknown capabilities", () => {
    bad(() => validateManifest(manifest({ capabilities: ["storage", "camera"] })), "unknown capabilities: camera");
  });

  it("bounds the icon data URI", () => {
    const big = "data:image/svg+xml," + "a".repeat(MAX_ICON_DATA_URI_BYTES);
    bad(() => validateManifest(manifest({ icon: big })), "icon data URI");
  });

  it("only allows Social Home's age ratings", () => {
    bad(() => validateManifest(manifest({ min_age: 12 })), "min_age must be one of 0, 13, 16, 18");
    bad(() => validateManifest(manifest({ min_age: "13" })), "min_age");
  });

  it("checks languages", () => {
    bad(() => validateManifest(manifest({ languages: [] })), "non-empty");
    bad(() => validateManifest(manifest({ languages: ["English"] })), "not a locale code");
    bad(() => validateManifest(manifest({ languages: ["en", "en"] })), "duplicates");
  });

  it("requires an https homepage", () => {
    bad(() => validateManifest(manifest({ homepage: "http://example.org" })), "https://");
    bad(() => validateManifest(manifest({ homepage: "not a url" })), "not a valid URL");
  });

  it("does not let an app set its own publisher", () => {
    bad(() => validateManifest(manifest({ publisher: "Totally Social Home" })), "publisher is set by the catalog");
  });

  describe("i18n", () => {
    it("bounds the locale count", () => {
      const i18n = {};
      for (let i = 0; i <= MAX_I18N_LOCALES; i++) {
        i18n[`a${String.fromCharCode(97 + i)}`] = { name: "n", description: "d" };
      }
      bad(() => validateManifest(manifest({ i18n })), "at most 12");
    });
    it("rejects the base locale, unknown fields and bad codes", () => {
      bad(() => validateManifest(manifest({ i18n: { en: { name: "n", description: "d" } } })), "base locale");
      bad(() => validateManifest(manifest({ i18n: { de: { name: "n", description: "d", x: 1 } } })), "unknown field");
      bad(() => validateManifest(manifest({ i18n: { German: { name: "n", description: "d" } } })), "locale code");
    });
    it("bounds translated name and description", () => {
      bad(
        () => validateManifest(manifest({ i18n: { de: { name: "x".repeat(41), description: "d" } } })),
        "i18n.de.name"
      );
      bad(() => validateManifest(manifest({ i18n: { de: { name: "Schach" } } })), "i18n.de.description");
    });
  });
});

describe("validateManifest: group games (players / tables / late_join)", () => {
  const group = (over = {}) => manifest({ players: { min: 3, max: 8 }, tables: true, ...over });

  it("accepts a group game, a two-player game open as a table, and the bounds", () => {
    expect(() => validateManifest(group())).not.toThrow();
    expect(() => validateManifest(group({ late_join: true }))).not.toThrow();
    expect(() => validateManifest(manifest({ players: { min: 2, max: 2 }, tables: true }))).not.toThrow();
    expect(() => validateManifest(manifest({ tables: true }))).not.toThrow();
    expect(() => validateManifest(manifest({ players: { min: 2, max: 2 } }))).not.toThrow();
    expect(() => validateManifest(group({ players: { min: MIN_PLAYERS, max: MAX_PLAYERS } }))).not.toThrow();
    expect(() => validateManifest(manifest({ tables: false, late_join: false }))).not.toThrow();
  });

  it("bounds players: 2 ≤ min ≤ max ≤ 30, whole numbers, nothing else", () => {
    bad(() => validateManifest(group({ players: { min: 1, max: 8 } })), "players.min is 1, at least 2");
    bad(() => validateManifest(group({ players: { min: 3, max: 31 } })), "players.max is 31, at most 30");
    bad(() => validateManifest(group({ players: { min: 5, max: 4 } })), /players.min \(5\) is more than players.max \(4\)/);
    bad(() => validateManifest(group({ players: { min: 2.5, max: 4 } })), "whole numbers");
    bad(() => validateManifest(group({ players: { min: "2", max: 4 } })), "whole numbers");
    bad(() => validateManifest(group({ players: { min: 2 } })), "whole numbers");
    bad(() => validateManifest(group({ players: [2, 4] })), "players must be an object");
    bad(() => validateManifest(group({ players: { min: 2, max: 4, ideal: 3 } })), "unknown field\\(s\\): ideal");
  });

  it("tables and late_join are booleans; more than two players and late_join need tables", () => {
    bad(() => validateManifest(group({ tables: "yes" })), "tables must be true or false");
    bad(() => validateManifest(group({ late_join: 1 })), "late_join must be true or false");
    bad(() => validateManifest(manifest({ players: { min: 3, max: 8 } })), "needs tables: true");
    bad(() => validateManifest(manifest({ late_join: true })), "late_join needs tables: true");
  });
});

describe("validateChangelog", () => {
  it("accepts newest-first entries up to the manifest version", () => {
    const cl = [entry(), entry({ version: "2026.10.28", date: "2026-10-28", notes: { en: "a", de: "b" } })];
    expect(() => validateChangelog(cl, "2026.10.29")).not.toThrow();
  });

  it("must be a list", () => {
    bad(() => validateChangelog({ "2026.10.29": "x" }, "2026.10.29"), "JSON list");
  });

  it("rejects entries newer than the manifest", () => {
    bad(() => validateChangelog([entry({ version: "2026.10.30" })], "2026.10.29"), "newer than the manifest");
  });

  it("rejects wrong order and duplicates", () => {
    bad(
      () => validateChangelog([entry({ version: "2026.10.28" }), entry({ version: "2026.10.29" })], "2026.10.29"),
      "newest first"
    );
    bad(() => validateChangelog([entry(), entry()], "2026.10.29"), "newest first");
  });

  it("checks date, notes and unknown fields", () => {
    bad(() => validateChangelog([entry({ date: "29.10.2026" })], "2026.10.29"), "not YYYY-MM-DD");
    bad(() => validateChangelog([entry({ notes: { de: "Neu." } })], "2026.10.29"), "notes.en is required");
    bad(() => validateChangelog([entry({ notes: "New." })], "2026.10.29"), "notes must be an object");
    bad(() => validateChangelog([entry({ title: "x" })], "2026.10.29"), "unknown field");
    bad(
      () => validateChangelog([entry({ notes: { en: "x".repeat(MAX_CHANGELOG_NOTE_CHARS + 1) } })], "2026.10.29"),
      "notes.en is 501 characters"
    );
  });
});

describe("permissionsFor", () => {
  it("maps capabilities to the three plain-word permissions, federation implying people", () => {
    expect(permissionsFor(["storage", "federation"])).toEqual(["storage", "people", "federation"]);
    expect(permissionsFor(["federation", "storage"])).toEqual(["storage", "people", "federation"]);
    expect(permissionsFor(["storage"])).toEqual(["storage"]);
    expect(permissionsFor(["people"])).toEqual(["people"]);
    expect(permissionsFor([])).toEqual([]);
  });
});

describe("buildEntry", () => {
  const base = { bundleUrl: "https://x/chess.tgz", bundleSha256: "ab".repeat(32), bundleSize: 4321 };

  it("keeps every v1 field core reads today, unchanged", () => {
    const e = buildEntry({ manifest: manifest(), changelog: null, ...base });
    expect(e).toMatchObject({
      app_id: "chess",
      name: "Chess",
      latest_version: "2026.10.29",
      description: "Play chess.",
      icon_url: "data:image/svg+xml,%3Csvg%2F%3E",
      capabilities: ["storage", "federation"],
      bundle_url: "https://x/chess.tgz",
      bundle_sha256: "ab".repeat(32),
    });
  });

  it("fills v2 defaults for a v1 manifest", () => {
    const e = buildEntry({ manifest: manifest({ icon: "icon.svg" }), changelog: null, ...base });
    expect(e.icon_url).toBeNull();
    expect(e.bundle_size).toBe(4321);
    expect(e.permissions).toEqual(["storage", "people", "federation"]);
    expect(e.min_age).toBe(0);
    expect(e.languages).toEqual(["en"]);
    expect(e.publisher).toBe("Social Home");
    expect(e.changelog).toEqual([]);
    expect(e).not.toHaveProperty("i18n");
    expect(e).not.toHaveProperty("homepage");
    expect(e).not.toHaveProperty("min_core_version");
    expect(e).not.toHaveProperty("players");
  });

  it("carries players for the Apps page (schema stays 2), not tables / late_join", () => {
    const m = manifest({ players: { min: 3, max: 8 }, tables: true, late_join: true });
    const e = buildEntry({ manifest: m, changelog: null, ...base });
    expect(e.players).toEqual({ min: 3, max: 8 });
    expect(e).not.toHaveProperty("tables");
    expect(e).not.toHaveProperty("late_join");
  });

  it("copies v2 manifest fields and keeps only the newest changelog entries", () => {
    const changelog = Array.from({ length: MAX_CHANGELOG_ENTRIES + 2 }, (_, i) =>
      entry({ version: `2026.10.${29 - i}` })
    );
    const m = manifest({
      min_age: 13,
      languages: ["en", "de"],
      homepage: "https://example.org",
      min_core_version: "2026.10.29",
      i18n: { de: { name: "Schach", description: "Spiel Schach." } },
    });
    const e = buildEntry({ manifest: m, changelog, ...base });
    expect(e.min_age).toBe(13);
    expect(e.languages).toEqual(["en", "de"]);
    expect(e.homepage).toBe("https://example.org");
    expect(e.min_core_version).toBe("2026.10.29");
    expect(e.i18n.de.name).toBe("Schach");
    expect(e.changelog.map((c) => c.version)).toEqual([
      "2026.10.29",
      "2026.10.28",
      "2026.10.27",
      "2026.10.26",
      "2026.10.25",
    ]);
  });
});

describe("serializeCatalog", () => {
  it("emits schema 2 with a UTC generated_at", () => {
    const doc = JSON.parse(serializeCatalog([{ app_id: "chess" }], new Date("2026-10-29T09:00:00.123Z")));
    expect(doc.schema).toBe(2);
    expect(doc.generated_at).toBe("2026-10-29T09:00:00+00:00");
    expect(doc.apps).toEqual([{ app_id: "chess" }]);
  });
  it("rejects duplicate app ids", () => {
    bad(() => serializeCatalog([{ app_id: "a" }, { app_id: "a" }]), 'app_id "a" appears twice');
  });
  it("bounds the whole catalog size", () => {
    bad(() => serializeCatalog([{ app_id: "a", pad: "x".repeat(MAX_CATALOG_BYTES) }]), "at most 262144");
  });
});

describe("apps in this repo", () => {
  const appsDir = join(REPO_ROOT, "apps");
  const apps = readdirSync(appsDir).filter((d) => existsSync(join(appsDir, d, "manifest.json")));

  it.each(apps)("%s has a valid manifest and changelog", (app) => {
    const m = JSON.parse(readFileSync(join(appsDir, app, "manifest.json"), "utf8"));
    validateManifest(m, `${app}/manifest.json`);
    const clPath = join(appsDir, app, "CHANGELOG.json");
    if (existsSync(clPath)) {
      validateChangelog(JSON.parse(readFileSync(clPath, "utf8")), m.version, `${app}/CHANGELOG.json`);
    }
  });

  it("chess translates its name and description into de, nl, fr and es", () => {
    const m = JSON.parse(readFileSync(join(appsDir, "chess", "manifest.json"), "utf8"));
    expect(Object.keys(m.i18n).sort()).toEqual(["de", "es", "fr", "nl"]);
    const cl = JSON.parse(readFileSync(join(appsDir, "chess", "CHANGELOG.json"), "utf8"));
    for (const e of cl) expect(Object.keys(e.notes).sort()).toEqual(["de", "en", "es", "fr", "nl"]);
  });
});
