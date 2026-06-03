/**
 * Chess app build script.
 *
 * Produces a self-contained dist/ bundle:
 *   dist/app.js       — esbuild bundle of src/main.ts (+ SDK)
 *   dist/index.html   — entry HTML
 *   dist/style.css    — board + UI styles
 *   dist/icon.svg     — app icon
 *   dist/manifest.json — app metadata
 *
 * Usage: node build.mjs
 * The root workspace exposes esbuild as a devDependency.
 */

import esbuild from "esbuild";
import { cp, mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const ROOT = __dirname;
const SRC = path.join(ROOT, "src");
const PUBLIC = path.join(ROOT, "public");
const DIST = path.join(ROOT, "dist");

async function main() {
  // Ensure dist/ exists
  await mkdir(DIST, { recursive: true });

  // 1. Bundle TypeScript entry + SDK into a single IIFE
  await esbuild.build({
    entryPoints: [path.join(SRC, "main.ts")],
    bundle: true,
    format: "iife",            // safe for the 'unsafe-inline' CSP (no dynamic import)
    target: "es2022",
    minify: true,
    sourcemap: false,
    outfile: path.join(DIST, "app.js"),
    // Resolve workspace package — the workspace root pnpm install wires this
    // via the node_modules symlink under the app package.
    // List .ts before .js so esbuild prefers TypeScript source over any .js
    // stub when both exist (e.g. "@socialhome/app-sdk" pre-built dist vs src).
    resolveExtensions: [".ts", ".js"],
    logLevel: "info",
  });

  // 2. Copy static assets
  const statics = [
    ["index.html",    path.join(PUBLIC, "index.html"),    path.join(DIST, "index.html")],
    ["style.css",     path.join(PUBLIC, "style.css"),     path.join(DIST, "style.css")],
    ["icon.svg",      path.join(PUBLIC, "icon.svg"),      path.join(DIST, "icon.svg")],
    ["manifest.json", path.join(ROOT, "manifest.json"),   path.join(DIST, "manifest.json")],
  ];

  for (const [name, src, dest] of statics) {
    await cp(src, dest);
    console.log(`Copied ${name} → dist/`);
  }

  console.log("\nBuild complete → dist/");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
