import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { hashBundles } from "./bundle-hash.mjs";

let root;

function app(id, files, { manifest = true } = {}) {
  const dir = path.join(root, "apps", id);
  mkdirSync(dir, { recursive: true });
  if (manifest) writeFileSync(path.join(dir, "manifest.json"), "{}");
  for (const [rel, text] of Object.entries(files)) {
    const file = path.join(dir, "dist", rel);
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, text);
  }
}

beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), "bundle-hash-"));
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe("hashBundles", () => {
  it("hashes each app's dist, the same bytes the same hash", () => {
    app("chess", { "index.html": "<p>a</p>", "manifest.json": "{}" });
    app("go", { "index.html": "<p>a</p>", "manifest.json": "{}" });
    const { hashes, missing } = hashBundles(root);
    expect(Object.keys(hashes)).toEqual(["chess", "go"]);
    expect(hashes.chess).toMatch(/^[0-9a-f]{64}$/);
    expect(hashes.chess).toBe(hashes.go);
    expect(missing).toEqual([]);
  });

  it("a byte, a file name or a new file changes the hash", () => {
    app("a", { "index.html": "x" });
    app("b", { "index.html": "y" });
    app("c", { "other.html": "x" });
    app("d", { "index.html": "x", "icon.svg": "" });
    app("e", { "sub/index.html": "x" });
    const { hashes } = hashBundles(root);
    expect(new Set(Object.values(hashes)).size).toBe(5);
  });

  it("doesn't mix two files into one (path and length are part of it)", () => {
    app("a", { "x": "ab", "y": "" });
    app("b", { "x": "a", "y": "b" });
    const { hashes } = hashBundles(root);
    expect(hashes.a).not.toBe(hashes.b);
  });

  it("lists an app that isn't built, and skips folders without a manifest", () => {
    app("chess", {});
    app("notes", { "index.html": "x" }, { manifest: false });
    const { hashes, missing } = hashBundles(root);
    expect(hashes).toEqual({});
    expect(missing).toEqual(["chess"]);
  });

  it("no apps folder: nothing", () => {
    expect(hashBundles(path.join(root, "nowhere"))).toEqual({ hashes: {}, missing: [] });
  });
});
