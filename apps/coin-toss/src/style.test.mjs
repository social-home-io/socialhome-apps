// The stylesheet's theme contract, and the no-Math.random rule (plain JS: it
// reads files with node:fs, which the app's browser-only tsconfig has no
// types for).
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { TOKEN_CSS_VARS } from "@socialhome/app-sdk";

const read = (p) => readFileSync(new URL(p, import.meta.url), "utf8");
const css = read("../public/style.css");
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

  it("loads nothing from outside: no url() and no @import", () => {
    expect(css).not.toMatch(/url\(|@import/);
  });

  it("shows a visible focus ring on buttons", () => {
    expect(css).toMatch(/\.btn:focus-visible \{ outline: 3px solid var\(--focus\)/);
  });
});

describe("randomness", () => {
  it("never uses Math.random anywhere in the app", () => {
    for (const f of ["main.ts", "random.ts", "session.ts", "faces.ts"]) {
      expect(read(`./${f}`), f).not.toMatch(/Math\.random/);
    }
    expect(read("./random.ts")).toMatch(/crypto\.getRandomValues/);
  });
});
