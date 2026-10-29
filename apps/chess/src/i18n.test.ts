import { afterEach, describe, expect, it } from "vitest";
import { CATALOGS, LOCALES, pickLocale, setLocale, t, tAround } from "./i18n.js";
import type { MessageKey } from "./i18n.js";

const placeholders = (s: string): string[] => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();
const EN_KEYS = Object.keys(CATALOGS.en).sort();

afterEach(() => setLocale("en"));

describe("string catalogs", () => {
  it("ships the five Social Home languages", () => {
    expect([...LOCALES]).toEqual(["en", "de", "nl", "fr", "es"]);
  });

  it.each(LOCALES.filter((l) => l !== "en"))("%s has every key English has, and no others", (locale) => {
    expect(Object.keys(CATALOGS[locale]).sort()).toEqual(EN_KEYS);
  });

  it.each(LOCALES)("%s: no empty string, same placeholders as English", (locale) => {
    for (const key of EN_KEYS as MessageKey[]) {
      const text = CATALOGS[locale][key];
      if (key !== "move.end") expect(text.trim(), `${locale} ${key}`).not.toBe("");
      expect(placeholders(text), `${locale} ${key}`).toEqual(placeholders(CATALOGS.en[key]));
    }
  });

  it.each(LOCALES)("%s keeps the name Social Home", (locale) => {
    for (const key of EN_KEYS as MessageKey[]) {
      if (CATALOGS.en[key].includes("Social Home")) {
        expect(CATALOGS[locale][key], `${locale} ${key}`).toContain("Social Home");
      }
    }
  });

  it("French puts a no-break space before : ; ! ?", () => {
    for (const [key, text] of Object.entries(CATALOGS.fr)) {
      expect(text, key).not.toMatch(/ [:;!?]/);
      expect(text, key).not.toMatch(/[^\s\u00a0][:;!?](\s|$)/);
    }
  });

  it("German says du, never Sie", () => {
    for (const [key, text] of Object.entries(CATALOGS.de)) {
      expect(text, key).not.toMatch(/\b(Sie|Ihre?n?|Ihnen)\b/);
    }
  });

  it("Spanish says tú, never usted or vosotros", () => {
    for (const [key, text] of Object.entries(CATALOGS.es)) {
      expect(text, key).not.toMatch(/\b(usted|vosotros|vuestr[ao]s?)\b/i);
    }
  });
});

describe("pickLocale", () => {
  it.each([
    ["de", "de"], ["de-CH", "de"], ["nl-BE", "nl"], ["FR", "fr"], ["es_419", "es"],
    ["en-GB", "en"], ["pt-BR", "en"], ["ar", "en"], ["", "en"], [undefined, "en"], [null, "en"],
  ])("%s → %s", (tag, want) => {
    expect(pickLocale(tag as string | undefined)).toBe(want);
  });
});

describe("t", () => {
  it("fills placeholders with literal text", () => {
    expect(t("invite.declined", { name: "Ben $& <b>" })).toBe("Ben $& <b> declined the game.");
  });

  it("follows the language set", () => {
    setLocale("de");
    expect(t("btn.newGame")).toBe("Neue Partie");
    setLocale("fr");
    expect(t("status.check")).toBe("Échec !");
  });

  it("tAround splits around the name, so it can go in its own element", () => {
    expect(tAround("board.waitingAccept")).toEqual(["Waiting for ", " to accept."]);
    setLocale("de");
    expect(tAround("board.waitingAccept")).toEqual(["Warte, bis ", " annimmt."]);
    expect(tAround("btn.newGame")).toEqual(["Neue Partie", ""]);
  });
});
