/**
 * Chess app build script.
 *
 * Produces a SINGLE self-contained, fully-inlined entry:
 *   dist/index.html    — HTML with the JS bundle, CSS, and icon all inlined
 *   dist/manifest.json — app metadata (the backend reads this)
 *
 * Why everything is inlined: a Social Home App runs in a sandboxed iframe with
 * an OPAQUE origin ("null"). Any external sub-resource (`<script src>`,
 * `<link href>`, `<img src>`) is fetched cross-origin from the real Social Home
 * origin, which (a) fails CSP `'self'` (the document's origin is "null", not the
 * serving origin) and (b) for module scripts is CORS-blocked and uncredentialed.
 * Inlining sidesteps all of it: no sub-resource fetch, only inline JS/CSS
 * (allowed by `script-src/style-src 'unsafe-inline'`) and a data-URI/inline icon.
 * => Social Home apps should ship a single inlined entry document.
 *
 * Usage: node build.mjs
 */

import esbuild from "esbuild";
import { mkdir, readFile, writeFile, cp, rm } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = __dirname;
const SRC = path.join(ROOT, "src");
const PUBLIC = path.join(ROOT, "public");
const DIST = path.join(ROOT, "dist");

async function main() {
  // Start clean so the tarball is exactly the inlined entry + manifest
  // (no stale app.js/style.css/icon.svg from an earlier build shape).
  await rm(DIST, { recursive: true, force: true });
  await mkdir(DIST, { recursive: true });

  // 1. Bundle TS + SDK to an in-memory IIFE string (no separate app.js).
  const result = await esbuild.build({
    entryPoints: [path.join(SRC, "main.ts")],
    bundle: true,
    format: "iife",
    target: "es2022",
    minify: true,
    sourcemap: false,
    write: false,
    resolveExtensions: [".ts", ".js"],
    logLevel: "info",
  });
  const js = result.outputFiles[0].text;

  // 2. Read CSS + icon to inline.
  const css = await readFile(path.join(PUBLIC, "style.css"), "utf8");
  const iconSvg = (await readFile(path.join(PUBLIC, "icon.svg"), "utf8")).trim();

  // 3. Compose a single self-contained document.
  const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <meta http-equiv="Content-Security-Policy"
        content="default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:; font-src data:; connect-src 'none'; base-uri 'none'; form-action 'none'" />
  <title>Chess — Social Home</title>
  <style>${css}</style>
</head>
<body>
  <header class="app-header">
    <span class="app-icon" aria-hidden="true">${iconSvg}</span>
    <h1>Chess</h1>
  </header>
  <main id="app-root" aria-label="Chess app"></main>
  <script>${js}</script>
</body>
</html>
`;

  await writeFile(path.join(DIST, "index.html"), html, "utf8");
  console.log("Wrote inlined dist/index.html");

  // 4. The backend reads manifest.json from the bundle root.
  await cp(path.join(ROOT, "manifest.json"), path.join(DIST, "manifest.json"));
  console.log("Copied manifest.json → dist/");

  console.log("\nBuild complete → dist/ (single inlined entry)");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
