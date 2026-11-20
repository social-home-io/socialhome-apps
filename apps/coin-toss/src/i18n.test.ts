import { afterEach, describe, expect, it } from "vitest";
import { CATALOGS, LOCALES, pickLocale, setLocale, t } from "./i18n.js";

afterEach(() => setLocale("en"));

describe("i18n", () => {
  it("every language has every key, none empty", () => {
    const keys = Object.keys(CATALOGS.en).sort();
    for (const loc of LOCALES) {
      expect(Object.keys(CATALOGS[loc]).sort(), loc).toEqual(keys);
      for (const k of keys) expect(CATALOGS[loc][k as keyof typeof CATALOGS.en].trim(), `${loc} ${k}`).not.toBe("");
    }
  });

  it("keeps placeholders in every language", () => {
    for (const loc of LOCALES) {
      for (const [k, v] of Object.entries(CATALOGS.en)) {
        const want = (v.match(/\{\w+\}/g) ?? []).sort();
        const got = (CATALOGS[loc][k as keyof typeof CATALOGS.en].match(/\{\w+\}/g) ?? []).sort();
        expect(got, `${loc} ${k}`).toEqual(want);
      }
    }
  });

  it("uses the owner's words for heads and tails", () => {
    const sides = Object.fromEntries(LOCALES.map((l) => [l, [CATALOGS[l]["side.heads"], CATALOGS[l]["side.tails"]]]));
    expect(sides).toEqual({
      en: ["Heads", "Tails"],
      de: ["Kopf", "Zahl"],
      nl: ["Kop", "Munt"],
      fr: ["Face", "Pile"],
      es: ["Cara", "Cruz"],
    });
  });

  it("picks the closest language, English otherwise", () => {
    expect(pickLocale("de-CH")).toBe("de");
    expect(pickLocale("pt-BR")).toBe("en");
    expect(pickLocale(undefined)).toBe("en");
  });

  it("fills placeholders with literal text", () => {
    setLocale("de");
    expect(t("tally.line", { heads: 3, tails: 2 })).toBe("Kopf 3 · Zahl 2");
    expect(t("coin.label", { side: "$&" })).toBe("Münze, zeigt $&");
  });

  it("French puts a no-break space before the exclamation mark", () => {
    setLocale("fr");
    expect(t("result.heads")).toBe("Face !");
  });
});
