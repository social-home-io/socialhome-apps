import { afterEach, describe, expect, it } from "vitest";
import { applyLook } from "./look.js";
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

const LIGHT = {
  locale: "de-AT",
  dir: "ltr" as const,
  theme: "light" as const,
  reducedMotion: true,
  tokens: {
    bg: "#f4ece0", surface: "#efe3d2", text: "#1a1814", muted: "#685f4f",
    accent: "#b54824", onAccent: "#f4ece0", border: "#d8cfc0", focus: "#a44221",
  },
};

afterEach(() => setLocale("en"));

describe("applyLook", () => {
  it("picks the catalog, sets lang/dir and the theme tokens", () => {
    const { props, root, el } = fakeRoot();
    expect(applyLook(LIGHT, el)).toBe("de");
    expect(getLocale()).toBe("de");
    expect(t("btn.newGame")).toBe("Neue Partie");
    expect(t("app.title")).toBe("Schiffe versenken");
    expect(root.lang).toBe("de");
    expect(root.dir).toBe("ltr");
    expect(root.style.colorScheme).toBe("light");
    expect(root.dataset["theme"]).toBe("light");
    expect(root.dataset["reducedMotion"]).toBe("true");
    expect(props["--sh-bg"]).toBe("#f4ece0");
    expect(props["--sh-accent"]).toBe("#b54824");
    expect(Object.keys(props)).toHaveLength(8);
  });

  it("an unknown language falls back to English — left to right, since the text is English", () => {
    const { root, el } = fakeRoot();
    expect(applyLook({ locale: "ar", dir: "rtl", theme: "dark" }, el)).toBe("en");
    expect(root.lang).toBe("en");
    expect(root.dir).toBe("ltr");
    expect(root.dataset["theme"]).toBe("dark");
  });

  it("the direction follows Social Home when Battleships shows that language", () => {
    const { root, el } = fakeRoot();
    applyLook({ locale: "de", dir: "rtl" }, el);
    expect(root.dir).toBe("rtl");
    applyLook({ locale: "de", dir: "ltr" }, el);
    expect(root.dir).toBe("ltr");
  });

  it("an older Social Home sends nothing: English, left to right, default colours", () => {
    const { props, root, el } = fakeRoot();
    expect(applyLook({}, el)).toBe("en");
    expect(root.dir).toBe("ltr");
    expect(root.dataset["theme"]).toBeUndefined();
    expect(props).toEqual({});
  });
});
