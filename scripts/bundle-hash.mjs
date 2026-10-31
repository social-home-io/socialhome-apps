// bundle-hash.mjs — what each app ships, as one hash per app, for the
// version guard (check-versions.mjs): it builds the PR's merge base in a
// throwaway git worktree, hashes both sides' apps/*/dist/, and every app whose
// bundle changed must bump its version — also when the change came from the
// SDK or a build tool rather than a file of the app itself.

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

/** Every file under `dir`, as sorted `/`-separated paths relative to it. */
function filesUnder(dir, prefix = "") {
  const out = [];
  for (const name of readdirSync(dir).sort()) {
    const full = path.join(dir, name);
    const rel = prefix ? `${prefix}/${name}` : name;
    if (statSync(full).isDirectory()) out.push(...filesUnder(full, rel));
    else out.push(rel);
  }
  return out;
}

/**
 * One SHA-256 per app over its whole `dist/` (each file's path and bytes, in
 * order), for every `apps/<id>/` that has a `manifest.json`.
 *
 * @param {string} root the repository root
 * @returns {{hashes: Record<string, string>, missing: string[]}} apps with a
 *   manifest but no built `dist/` are listed in `missing`
 */
export function hashBundles(root) {
  const appsDir = path.join(root, "apps");
  const hashes = {};
  const missing = [];
  if (!existsSync(appsDir)) return { hashes, missing };
  for (const id of readdirSync(appsDir).sort()) {
    if (!existsSync(path.join(appsDir, id, "manifest.json"))) continue;
    const dist = path.join(appsDir, id, "dist");
    if (!existsSync(dist)) {
      missing.push(id);
      continue;
    }
    const h = createHash("sha256");
    for (const rel of filesUnder(dist)) {
      const bytes = readFileSync(path.join(dist, rel));
      h.update(`${rel}\0${bytes.length}\0`);
      h.update(bytes);
    }
    hashes[id] = h.digest("hex");
  }
  return { hashes, missing };
}

/**
 * Build `ref` in a throwaway worktree (pnpm install from the store, then
 * `pnpm build`, the same as CI) and hash its bundles. The worktree is removed
 * afterwards, also on failure.
 *
 * @param {string} root the repository root (the worktree is added from here)
 * @param {string} ref a commit
 * @returns {Record<string, string>}
 */
export function hashBundlesAt(root, ref) {
  const parent = mkdtempSync(path.join(tmpdir(), "version-guard-"));
  const dir = path.join(parent, "base");
  const run = (cmd, args, cwd) => execFileSync(cmd, args, { cwd, stdio: ["ignore", "ignore", "inherit"] });
  try {
    run("git", ["worktree", "add", "--detach", dir, ref], root);
    run("pnpm", ["install", "--frozen-lockfile", "--prefer-offline"], dir);
    run("pnpm", ["build"], dir);
    return hashBundles(dir).hashes;
  } finally {
    try {
      run("git", ["worktree", "remove", "--force", dir], root);
    } catch {
      // Not registered (the add failed): the directory goes below.
    }
    rmSync(parent, { recursive: true, force: true });
  }
}
