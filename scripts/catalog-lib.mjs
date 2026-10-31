// catalog-lib.mjs — pure helpers behind build-catalog.mjs: validate an app's
// manifest.json + CHANGELOG.json, and shape its catalog v2 entry.
//
// Catalog v2 is additive over v1: every v1 field stays with the same meaning,
// so a Social Home that only knows v1 keeps installing from it (it reads
// app_id, name, latest_version, description, icon_url, capabilities,
// bundle_url, bundle_sha256 and ignores the rest).
//
// The bounds below match what the receiver (Social Home core) enforces on a
// v2 catalog, so a bad value fails this repo's CI instead of being dropped
// by every household.

/** Catalog schema version this script emits. */
export const CATALOG_SCHEMA = 2;

/** Who publishes this catalog. Shown as "From Social Home" (owner decision D6:
 * an honest label, no signature yet; the bundle sha256 stays the pin). */
export const PUBLISHER = "Social Home";

// --- Receiver bounds -------------------------------------------------------
export const MAX_NAME_CHARS = 40;
export const MAX_DESCRIPTION_CHARS = 300;
export const MAX_I18N_LOCALES = 12;
export const MAX_LANGUAGES = 12;
export const MAX_CHANGELOG_ENTRIES = 5;
export const MAX_CHANGELOG_NOTE_CHARS = 500;
export const MAX_ICON_DATA_URI_BYTES = 16 * 1024;
export const MAX_CATALOG_BYTES = 256 * 1024;
export const MAX_URL_CHARS = 500;

/** Group games (Social Home v_76, SDK 1.9): a table seats 2–30 players
 * (Social Home cuts a larger `max` to 30; this repo refuses it instead). A
 * table opened by picking people seats at most 10 — Social Home enforces that
 * when the table is opened, not in the manifest. */
export const MIN_PLAYERS = 2;
export const MAX_PLAYERS = 30;

/** Age ratings Social Home accepts (`installed_apps.min_age`). */
export const VALID_MIN_AGES = Object.freeze([0, 13, 16, 18]);

/** Capability ids a manifest may declare (what the bridge grants). */
export const KNOWN_CAPABILITIES = Object.freeze(["storage", "people", "federation"]);

/** The plain-word permissions, in display order. `federation` implies
 * `people`: sending invites is useless without picking who to send them to. */
const PERMISSION_ORDER = ["storage", "people", "federation"];
const IMPLIED_PERMISSIONS = { storage: ["storage"], people: ["people"], federation: ["people", "federation"] };

const CALVER_RE = /^(\d{4})\.(\d{1,2})\.(\d{1,2})(?:\.(\d+))?$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const LOCALE_RE = /^[a-z]{2,3}(?:-[A-Z]{2})?$/;
const APP_ID_RE = /^[a-z][a-z0-9_-]{0,39}$/;

/** Base language of `name`, `description` and the first changelog note. */
export const BASE_LOCALE = "en";

/** Raised for any manifest / changelog / catalog that breaks the schema. */
export class CatalogError extends Error {}

function fail(where, msg) {
  throw new CatalogError(`${where}: ${msg}`);
}

function isPlainObject(v) {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

function chars(s) {
  return [...s].length;
}

function requireText(where, field, value, max) {
  if (typeof value !== "string" || value.trim() === "") {
    fail(where, `${field} must be a non-empty string`);
  }
  if (chars(value) > max) {
    fail(where, `${field} is ${chars(value)} characters, at most ${max}`);
  }
}

/** Parse a CalVer string into a comparable tuple, or null. */
export function parseCalver(v) {
  if (typeof v !== "string") return null;
  const m = CALVER_RE.exec(v);
  if (!m) return null;
  const [, y, mo, d, n] = m;
  const month = Number(mo);
  const day = Number(d);
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  return [Number(y), month, day, n === undefined ? 0 : Number(n)];
}

/** Negative, zero or positive, like a sort comparator. */
export function compareCalver(a, b) {
  const ta = parseCalver(a);
  const tb = parseCalver(b);
  for (let i = 0; i < 4; i++) {
    if (ta[i] !== tb[i]) return ta[i] - tb[i];
  }
  return 0;
}

function validateHttpsUrl(where, field, value) {
  if (typeof value !== "string" || chars(value) > MAX_URL_CHARS) {
    fail(where, `${field} must be a URL of at most ${MAX_URL_CHARS} characters`);
  }
  let url;
  try {
    url = new URL(value);
  } catch {
    fail(where, `${field} is not a valid URL`);
  }
  if (url.protocol !== "https:") fail(where, `${field} must be an https:// URL`);
}

function validateI18n(where, i18n) {
  if (!isPlainObject(i18n)) fail(where, "i18n must be an object of locale → {name, description}");
  const locales = Object.keys(i18n);
  if (locales.length > MAX_I18N_LOCALES) {
    fail(where, `i18n has ${locales.length} locales, at most ${MAX_I18N_LOCALES}`);
  }
  for (const loc of locales) {
    if (!LOCALE_RE.test(loc)) fail(where, `i18n locale "${loc}" is not a locale code like "de" or "pt-BR"`);
    if (loc === BASE_LOCALE) fail(where, `i18n must not repeat the base locale "${BASE_LOCALE}" (use name/description)`);
    const t = i18n[loc];
    if (!isPlainObject(t)) fail(where, `i18n.${loc} must be an object`);
    const extra = Object.keys(t).filter((k) => k !== "name" && k !== "description");
    if (extra.length) fail(where, `i18n.${loc} has unknown field(s): ${extra.join(", ")}`);
    requireText(where, `i18n.${loc}.name`, t.name, MAX_NAME_CHARS);
    requireText(where, `i18n.${loc}.description`, t.description, MAX_DESCRIPTION_CHARS);
  }
}

/**
 * Validate a parsed manifest.json. Throws CatalogError on the first problem.
 * @param {unknown} manifest
 * @param {string} where  label for messages (e.g. the file path)
 */
export function validateManifest(manifest, where = "manifest.json") {
  if (!isPlainObject(manifest)) fail(where, "must be a JSON object");
  for (const f of ["app_id", "name", "version", "description", "entry", "icon", "capabilities"]) {
    if (!(f in manifest)) fail(where, `missing required field "${f}"`);
  }
  const m = manifest;
  if (typeof m.app_id !== "string" || !APP_ID_RE.test(m.app_id)) {
    fail(where, "app_id must be lower-case letters, digits, '-' or '_' (≤ 40)");
  }
  requireText(where, "name", m.name, MAX_NAME_CHARS);
  requireText(where, "description", m.description, MAX_DESCRIPTION_CHARS);
  if (!parseCalver(m.version)) fail(where, `version "${m.version}" is not CalVer YYYY.M.D[.N]`);
  if (typeof m.entry !== "string" || m.entry === "") fail(where, "entry must be a non-empty string");
  if (typeof m.icon !== "string" || m.icon === "") fail(where, "icon must be a non-empty string");
  if (m.icon.startsWith("data:") && Buffer.byteLength(m.icon, "utf8") > MAX_ICON_DATA_URI_BYTES) {
    fail(where, `icon data URI is ${Buffer.byteLength(m.icon, "utf8")} bytes, at most ${MAX_ICON_DATA_URI_BYTES}`);
  }
  if (!Array.isArray(m.capabilities) || !m.capabilities.every((c) => typeof c === "string")) {
    fail(where, "capabilities must be a list of strings");
  }
  const unknown = m.capabilities.filter((c) => !KNOWN_CAPABILITIES.includes(c));
  if (unknown.length) {
    fail(where, `unknown capabilities: ${unknown.join(", ")} (known: ${KNOWN_CAPABILITIES.join(", ")})`);
  }

  // --- v2 fields (all optional) ---
  if ("min_age" in m && !VALID_MIN_AGES.includes(m.min_age)) {
    fail(where, `min_age must be one of ${VALID_MIN_AGES.join(", ")}`);
  }
  if ("languages" in m) {
    const langs = m.languages;
    if (!Array.isArray(langs) || langs.length === 0) fail(where, "languages must be a non-empty list");
    if (langs.length > MAX_LANGUAGES) fail(where, `languages has ${langs.length} entries, at most ${MAX_LANGUAGES}`);
    for (const l of langs) {
      if (typeof l !== "string" || !LOCALE_RE.test(l)) fail(where, `language "${l}" is not a locale code`);
    }
    if (new Set(langs).size !== langs.length) fail(where, "languages has duplicates");
  }
  if ("i18n" in m) validateI18n(where, m.i18n);
  if ("homepage" in m) validateHttpsUrl(where, "homepage", m.homepage);
  if ("min_core_version" in m && !parseCalver(m.min_core_version)) {
    fail(where, `min_core_version "${m.min_core_version}" is not CalVer YYYY.M.D[.N]`);
  }
  if ("publisher" in m) {
    fail(where, `publisher is set by the catalog ("${PUBLISHER}"), not by the app`);
  }
  validateGroupFields(where, m);
}

/** `players {min, max}`, `tables` and `late_join` (group games, SDK 1.9). */
function validateGroupFields(where, m) {
  for (const f of ["tables", "late_join"]) {
    if (f in m && typeof m[f] !== "boolean") fail(where, `${f} must be true or false`);
  }
  if ("players" in m) {
    const p = m.players;
    if (!isPlainObject(p)) fail(where, "players must be an object {min, max}");
    const extra = Object.keys(p).filter((k) => k !== "min" && k !== "max");
    if (extra.length) fail(where, `players has unknown field(s): ${extra.join(", ")}`);
    if (!Number.isInteger(p.min) || !Number.isInteger(p.max)) {
      fail(where, "players.min and players.max must be whole numbers");
    }
    if (p.min < MIN_PLAYERS) fail(where, `players.min is ${p.min}, at least ${MIN_PLAYERS}`);
    if (p.max > MAX_PLAYERS) fail(where, `players.max is ${p.max}, at most ${MAX_PLAYERS}`);
    if (p.min > p.max) fail(where, `players.min (${p.min}) is more than players.max (${p.max})`);
    if ((p.min !== 2 || p.max !== 2) && m.tables !== true) {
      fail(where, "players other than {min: 2, max: 2} needs tables: true (without it an app plays 1:1 only)");
    }
  }
  if (m.late_join === true && m.tables !== true) {
    fail(where, "late_join needs tables: true");
  }
}

/**
 * Validate a parsed CHANGELOG.json: a list, newest first, of
 * `{version, date, notes: {en, de?, …}}`. Every entry must be ≤ the
 * manifest version. Throws CatalogError.
 * @param {unknown} changelog
 * @param {string} manifestVersion
 * @param {string} where
 */
export function validateChangelog(changelog, manifestVersion, where = "CHANGELOG.json") {
  if (!Array.isArray(changelog)) fail(where, "must be a JSON list of entries, newest first");
  let prev = null;
  changelog.forEach((e, i) => {
    const at = `${where}[${i}]`;
    if (!isPlainObject(e)) fail(at, "must be an object");
    const extra = Object.keys(e).filter((k) => !["version", "date", "notes"].includes(k));
    if (extra.length) fail(at, `unknown field(s): ${extra.join(", ")}`);
    if (!parseCalver(e.version)) fail(at, `version "${e.version}" is not CalVer YYYY.M.D[.N]`);
    if (typeof e.date !== "string" || !DATE_RE.test(e.date) || Number.isNaN(Date.parse(`${e.date}T00:00:00Z`))) {
      fail(at, `date "${e.date}" is not YYYY-MM-DD`);
    }
    if (compareCalver(e.version, manifestVersion) > 0) {
      fail(at, `version ${e.version} is newer than the manifest version ${manifestVersion}`);
    }
    if (prev !== null && compareCalver(e.version, prev) >= 0) {
      fail(at, `version ${e.version} must be older than the entry before it (${prev}); newest first, no duplicates`);
    }
    prev = e.version;
    if (!isPlainObject(e.notes)) fail(at, "notes must be an object of locale → text");
    if (!(BASE_LOCALE in e.notes)) fail(at, `notes.${BASE_LOCALE} is required`);
    const locales = Object.keys(e.notes);
    if (locales.length > MAX_I18N_LOCALES + 1) fail(at, `notes has ${locales.length} locales, at most ${MAX_I18N_LOCALES + 1}`);
    for (const loc of locales) {
      if (!LOCALE_RE.test(loc)) fail(at, `notes locale "${loc}" is not a locale code`);
      requireText(at, `notes.${loc}`, e.notes[loc], MAX_CHANGELOG_NOTE_CHARS);
    }
  });
}

/** The plain-word permissions (storage / people / federation) a list of
 * manifest capabilities amounts to, in display order. */
export function permissionsFor(capabilities) {
  const set = new Set(capabilities.flatMap((c) => IMPLIED_PERMISSIONS[c] ?? []));
  return PERMISSION_ORDER.filter((p) => set.has(p));
}

/**
 * Build one catalog v2 entry. Inputs must already be validated.
 * @param {object} args
 * @param {Record<string, any>} args.manifest
 * @param {Array<Record<string, any>> | null} args.changelog  full CHANGELOG.json, or null
 * @param {string} args.bundleUrl
 * @param {string} args.bundleSha256
 * @param {number} args.bundleSize  tarball bytes
 */
export function buildEntry({ manifest, changelog, bundleUrl, bundleSha256, bundleSize }) {
  const m = manifest;
  // The manifest icon is a self-contained data: URI, so it doubles as the
  // catalog icon_url the Apps cards render directly (no external fetch).
  const icon_url = typeof m.icon === "string" && m.icon.startsWith("data:") ? m.icon : null;

  const entry = {
    // --- v1 (read by every Social Home) ---
    app_id: m.app_id,
    name: m.name,
    latest_version: m.version,
    description: m.description,
    icon_url,
    capabilities: [...m.capabilities],
    bundle_url: bundleUrl,
    bundle_sha256: bundleSha256,
    // --- v2 (optional; an older Social Home ignores them) ---
    bundle_size: bundleSize,
    permissions: permissionsFor(m.capabilities),
    min_age: m.min_age ?? 0,
    languages: m.languages ? [...m.languages] : [BASE_LOCALE],
    publisher: PUBLISHER,
  };
  if (m.i18n) entry.i18n = m.i18n;
  if (m.homepage) entry.homepage = m.homepage;
  if (m.min_core_version) entry.min_core_version = m.min_core_version;
  // Group games: "2–8 players" on the Apps page. Additive (schema stays 2).
  if (m.players) entry.players = { min: m.players.min, max: m.players.max };
  // The app can be played at a table — e.g. an open game in a space. Social
  // Home reads it from the catalog for an app a household hasn't installed
  // yet ("Games allowed here" lists only such apps); `late_join` only matters
  // once installed, so it stays in the manifest.
  if (m.tables === true) entry.tables = true;
  entry.changelog = (changelog ?? []).slice(0, MAX_CHANGELOG_ENTRIES);
  return entry;
}

/**
 * Wrap entries in the catalog document and check its total size.
 * @param {Array<Record<string, unknown>>} entries
 * @param {Date} now
 * @returns {string} the serialized catalog (with trailing newline)
 */
export function serializeCatalog(entries, now = new Date()) {
  const ids = entries.map((e) => e.app_id);
  const dup = ids.find((id, i) => ids.indexOf(id) !== i);
  if (dup) throw new CatalogError(`catalog: app_id "${dup}" appears twice`);
  const catalog = {
    schema: CATALOG_SCHEMA,
    generated_at: now.toISOString().replace(/\.\d{3}Z$/, "+00:00"),
    apps: entries,
  };
  const text = JSON.stringify(catalog, null, 2) + "\n";
  const bytes = Buffer.byteLength(text, "utf8");
  if (bytes > MAX_CATALOG_BYTES) {
    throw new CatalogError(`catalog: ${bytes} bytes, at most ${MAX_CATALOG_BYTES}`);
  }
  return text;
}
