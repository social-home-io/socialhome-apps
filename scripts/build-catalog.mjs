#!/usr/bin/env node
// build-catalog.mjs — builds dist-tars/<app_id>-<version>.tgz for every app
// under apps/<app>/dist and emits catalog.json at the repo root.
//
// Environment:
//   RELEASE_TAG   (required) — the GitHub release tag, e.g. "1.0.0"
//   REPO_BASE     (optional) — base URL for download links
//                              default: https://github.com/social-home-io/socialhome-apps
//
// Usage (after pnpm build):
//   RELEASE_TAG=1.0.0 node scripts/build-catalog.mjs

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const RELEASE_TAG = process.env.RELEASE_TAG;
if (!RELEASE_TAG) {
  console.error(
    "ERROR: RELEASE_TAG environment variable is required.\n" +
      "  Example: RELEASE_TAG=1.0.0 node scripts/build-catalog.mjs"
  );
  process.exit(1);
}

const REPO_BASE =
  (process.env.REPO_BASE ?? "").replace(/\/+$/, "") ||
  "https://github.com/social-home-io/socialhome-apps";

// Paths relative to the repo root (this script lives in scripts/).
const REPO_ROOT = resolve(import.meta.dirname, "..");
const APPS_DIR = join(REPO_ROOT, "apps");
const DIST_TARS_DIR = join(REPO_ROOT, "dist-tars");
const CATALOG_PATH = join(REPO_ROOT, "catalog.json");

// Required fields in every app's manifest.json.
const REQUIRED_MANIFEST_FIELDS = [
  "app_id",
  "name",
  "version",
  "description",
  "entry",
  "icon",
  "capabilities",
];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Read and parse a JSON file; return the parsed object.
 * @param {string} filePath
 * @returns {Record<string, unknown>}
 */
function readJson(filePath) {
  try {
    return JSON.parse(readFileSync(filePath, "utf8"));
  } catch (err) {
    console.error(`ERROR: Cannot read/parse ${filePath}: ${err.message}`);
    process.exit(1);
  }
}

/**
 * Validate that a manifest has all required fields.
 * Exits with an error message on failure.
 * @param {Record<string, unknown>} manifest
 * @param {string} manifestPath
 */
function validateManifest(manifest, manifestPath) {
  const missing = REQUIRED_MANIFEST_FIELDS.filter((f) => !(f in manifest));
  if (missing.length > 0) {
    console.error(
      `ERROR: ${manifestPath} is missing required field(s): ${missing.join(", ")}`
    );
    process.exit(1);
  }
}

/**
 * Compute the SHA-256 hex digest of a file on disk.
 * @param {string} filePath
 * @returns {string} lowercase hex
 */
function sha256File(filePath) {
  const bytes = readFileSync(filePath);
  return createHash("sha256").update(bytes).digest("hex");
}

/**
 * Discover immediate subdirectories of `appsDir` that contain a manifest.json.
 * @param {string} appsDir
 * @returns {string[]} absolute paths to app dirs
 */
function discoverAppDirs(appsDir) {
  let entries;
  try {
    entries = readdirSync(appsDir);
  } catch {
    console.error(`ERROR: Cannot read apps directory: ${appsDir}`);
    process.exit(1);
  }

  return entries
    .map((name) => join(appsDir, name))
    .filter((p) => {
      try {
        return (
          statSync(p).isDirectory() &&
          statSync(join(p, "manifest.json")).isFile()
        );
      } catch {
        return false;
      }
    });
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

console.log(`Building catalog for release tag: ${RELEASE_TAG}`);
console.log(`Repo base URL: ${REPO_BASE}`);
console.log();

// Ensure the output directory exists.
mkdirSync(DIST_TARS_DIR, { recursive: true });

const appDirs = discoverAppDirs(APPS_DIR);
if (appDirs.length === 0) {
  console.error(`ERROR: No app directories found under ${APPS_DIR}`);
  process.exit(1);
}

/** @type {Array<Record<string, unknown>>} */
const catalogEntries = [];

for (const appDir of appDirs) {
  const manifestPath = join(appDir, "manifest.json");
  const manifest = readJson(manifestPath);
  validateManifest(manifest, manifestPath);

  const { app_id, name, version, description, capabilities } = manifest;
  const distDir = join(appDir, "dist");

  // Verify the dist directory exists (i.e. the app was built).
  try {
    statSync(distDir);
  } catch {
    console.error(
      `ERROR: dist/ directory not found for app "${app_id}" at ${distDir}\n` +
        `  Run "pnpm build" before building the catalog.`
    );
    process.exit(1);
  }

  const tarName = `${app_id}-${version}.tgz`;
  const tarPath = join(DIST_TARS_DIR, tarName);

  // Build the tarball: contents of dist/ at the archive root (no "dist/" prefix).
  console.log(`  [${app_id}] Creating ${tarName}...`);
  execFileSync("tar", ["-czf", tarPath, "-C", distDir, "."], {
    stdio: ["ignore", "inherit", "inherit"],
  });

  // SHA-256 of the tarball bytes.
  const bundle_sha256 = sha256File(tarPath);

  // Construct the download URL.
  const bundle_url = `${REPO_BASE}/releases/download/${RELEASE_TAG}/${tarName}`;

  // Determine icon_url: if there's a packaged icon in dist, point at it via
  // the release asset bundle_url fragment; otherwise null.
  // (The catalog consumer uses bundle_url to download and unpack the bundle;
  //  a separate icon CDN link is optional.)
  const icon_url = null;

  catalogEntries.push({
    app_id,
    name,
    latest_version: version,
    description,
    icon_url,
    capabilities: capabilities ?? [],
    bundle_url,
    bundle_sha256,
  });

  console.log(`  [${app_id}] sha256: ${bundle_sha256}`);
  console.log(`  [${app_id}] url:    ${bundle_url}`);
  console.log();
}

// Write catalog.json.
const catalog = { apps: catalogEntries };
writeFileSync(CATALOG_PATH, JSON.stringify(catalog, null, 2) + "\n", "utf8");

console.log(`catalog.json written to: ${CATALOG_PATH}`);
console.log(`Tarballs written to:     ${DIST_TARS_DIR}/`);
console.log();
console.log("Done.");
