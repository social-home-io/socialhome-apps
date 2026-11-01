// The app never stores or shows whom anybody gives to (decision D13): Social
// Home shows it in its own sheet. These checks read the source (plain JS:
// node:fs isn't in the app's browser-only tsconfig).
import { readFileSync, readdirSync } from "node:fs";
import { describe, expect, it } from "vitest";

const dir = new URL("./", import.meta.url);
const sources = readdirSync(dir)
  .filter((f) => f.endsWith(".ts") && !f.includes(".test.") && f !== "fixtures.ts")
  .map((f) => [f, readFileSync(new URL(f, dir), "utf8")]);
const main = readFileSync(new URL("main.ts", dir), "utf8");

describe("the app never stores or shows a result", () => {
  it("asks Social Home only for the draw's state; the name is shown by reveal, outside the app", () => {
    const calls = [...main.matchAll(/engines\.draw\.(\w+)/g)].map((m) => m[1]);
    expect(new Set(calls)).toEqual(new Set(["configure", "setWishes", "start", "status", "reveal", "onEvent"]));
    // reveal resolves with nothing, and nothing is done with it.
    expect(main).toMatch(/await client\.engines\.draw\.reveal\(id\);\n/);
  });

  it("writes to storage only through persist.ts (which keeps named fields only)", () => {
    for (const [file, src] of sources) {
      if (file === "persist.ts") continue;
      expect(src, file).not.toMatch(/store\.set\(/);
    }
    expect(main).not.toMatch(/localStorage|sessionStorage|indexedDB/);
  });

  it("sends to the table only the organiser's details", () => {
    const sends = [...main.matchAll(/group\.send\(([^)]*\))\)/g)].map((m) => m[1]);
    expect(sends).toEqual(["id, detailsMessage(st.settings)"]);
  });

  it("has no word for a result anywhere in its code", () => {
    for (const [file, src] of sources) {
      expect(src, file).not.toMatch(/\.result\b|recipient|getDrawResult|draw\/result|giver\b/);
    }
  });
});

describe("the sandbox", () => {
  it("uses no <form>: the frame has no allow-forms, so a submit never fires", () => {
    for (const [file, src] of sources) expect(src, file).not.toMatch(/el\("form"|type: "submit"|onsubmit/);
  });
});

describe("settings", () => {
  it("changes only the fields it means to: configure is a patch", () => {
    const calls = [...main.matchAll(/engines\.draw\.configure\(([^;]*?)\)\)?;/gs)].map((m) => m[1]);
    expect(calls.length).toBeGreaterThanOrEqual(4);
    expect(main).not.toMatch(/withSettings/);
    // Adding or removing a pair sends the pairs alone.
    expect(calls.filter((c) => /\{ pairs \}/.test(c)).length).toBe(2);
  });
});
