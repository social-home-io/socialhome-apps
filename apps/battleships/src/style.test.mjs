// The stylesheet's theme contract (plain JS: it reads the file with node:fs,
// which the app's browser-only tsconfig has no types for).
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { TOKEN_CSS_VARS } from "@socialhome/app-sdk";

const css = readFileSync(new URL("../public/style.css", import.meta.url), "utf8");
const block = (sel) => new RegExp(`${sel.replace(/[[\]"]/g, "\\$&")}\\s*\\{([^}]*)\\}`).exec(css)?.[1] ?? "";

describe("style.css", () => {
  it.each(['light', 'dark'])("uses all eight Social Home tokens in %s, each with a fallback colour", (theme) => {
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

  it("shows the focus ring in Social Home's focus colour, 3 px with an offset", () => {
    expect(css).toMatch(/\.cell:focus-visible[^{]*\{\s*outline: 3px solid var\(--focus\); outline-offset: 2px;/);
  });

  it("on a phone shows one board at a time behind tabs", () => {
    expect(css).toContain('.boards[data-tab="target"] [data-pane="own"]');
    expect(css).toMatch(/@media \(max-width: 600px\)[\s\S]*\.tabs \{\s*display: flex/);
  });
});
