// The stylesheet's theme contract (plain JS: it reads the file with node:fs,
// which the app's browser-only tsconfig has no types for).
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { TOKEN_CSS_VARS } from "@socialhome/app-sdk";

const css = readFileSync(new URL("../public/style.css", import.meta.url), "utf8");

describe("style.css", () => {
  it("uses all eight Social Home tokens in light, each with a fallback colour", () => {
    const light = /:root\[data-theme="light"\]\s*\{([^}]*)\}/.exec(css)?.[1] ?? "";
    expect(light).not.toBe("");
    for (const v of Object.values(TOKEN_CSS_VARS)) {
      expect(light, v).toMatch(new RegExp(`var\\(${v}, #[0-9a-f]{6}\\)`));
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
});
