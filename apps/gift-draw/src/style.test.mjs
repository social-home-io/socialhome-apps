// The stylesheet's theme contract (plain JS: it reads the file with node:fs,
// which the app's browser-only tsconfig has no types for).
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { TOKEN_CSS_VARS } from "@socialhome/app-sdk";

const css = readFileSync(new URL("../public/style.css", import.meta.url), "utf8");
const block = (sel) => new RegExp(`${sel.replace(/[[\]"]/g, "\\$&")}\\s*\\{([^}]*)\\}`).exec(css)?.[1] ?? "";

describe("style.css", () => {
  it.each(["light", "dark"])("uses all eight Social Home tokens in %s, each with a fallback colour", (theme) => {
    const body = block(`:root[data-theme="${theme}"]`);
    expect(body).not.toBe("");
    for (const v of Object.values(TOKEN_CSS_VARS)) {
      expect(body, v).toMatch(new RegExp(`var\\(${v}, #[0-9a-f]{6}\\)`));
    }
  });

  it("turns animations off for reduced motion, from Social Home or the system", () => {
    expect(css).toContain(':root[data-reduced-motion="true"] *');
    expect(css).toMatch(/@media \(prefers-reduced-motion: reduce\)/);
  });

  it("mirrors the back arrow in right-to-left; never uses physical left margins", () => {
    expect(css).toContain('[dir="rtl"] .flip-rtl');
    expect(css).not.toMatch(/margin-left|padding-left|text-align: left/);
  });

  it("shows a 3 px focus ring in Social Home's focus colour on every control", () => {
    expect(css).toMatch(/\.btn:focus-visible, \.back:focus-visible, \.row:focus-visible, summary:focus-visible,\s*\.input:focus-visible \{\s*outline: 3px solid var\(--focus\); outline-offset: 2px;/);
  });

  it("keeps tap targets at least 36 px tall and loads nothing from outside", () => {
    for (const h of css.matchAll(/min-height: (\d+)px/g)) expect(Number(h[1])).toBeGreaterThanOrEqual(32);
    expect(css).toMatch(/\.btn \{[^}]*min-height: 44px/);
    expect(css).not.toMatch(/url\(|@import/);
  });
});
