import { afterEach, describe, expect, it } from "vitest";
import { applyLook, wantsReducedMotion } from "./look.js";
import { getLocale, setLocale, t } from "./i18n.js";

/** A stand-in for `document.documentElement` (the tests run without a DOM). */
function fakeRoot() {
  const props: Record<string, string> = {};
  const root = {
    lang: "",
    dir: "",
    style: { setProperty: (k: string, v: string) => { props[k] = v; }, colorScheme: "" },
    dataset: {} as Record<string, string>,
  };
  return { props, root, el: root as unknown as HTMLElement };
}

afterEach(() => setLocale("en"));

describe("applyLook", () => {
  it("picks the catalog, sets lang/dir, the theme tokens and reduced motion", () => {
    const { props, root, el } = fakeRoot();
    const look = {
      locale: "de-AT", dir: "ltr" as const, theme: "dark" as const, reducedMotion: true,
      tokens: {
        bg: "#14161c", surface: "#1e2129", text: "#e9e6df", muted: "#a8a294",
        accent: "#e07a52", onAccent: "#14161c", border: "#343846", focus: "#f0a07e",
      },
    };
    expect(applyLook(look, el)).toBe("de");
    expect(getLocale()).toBe("de");
    expect(t("btn.toss")).toBe("Münze werfen");
    expect(root.lang).toBe("de");
    expect(root.dataset["theme"]).toBe("dark");
    expect(root.dataset["reducedMotion"]).toBe("true");
    expect(Object.keys(props)).toHaveLength(8);
  });

  it("an unknown right-to-left language falls back to English, left to right", () => {
    const { root, el } = fakeRoot();
    expect(applyLook({ locale: "ar", dir: "rtl", theme: "light" }, el)).toBe("en");
    expect(root.dir).toBe("ltr");
  });
});

describe("wantsReducedMotion", () => {
  it("follows Social Home's flag when it sent one, else the system", () => {
    expect(wantsReducedMotion("true", false)).toBe(true);
    expect(wantsReducedMotion("false", true)).toBe(false);
    expect(wantsReducedMotion(undefined, true)).toBe(true);
    expect(wantsReducedMotion(undefined, false)).toBe(false);
  });
});
