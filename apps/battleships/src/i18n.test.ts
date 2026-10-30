import { afterEach, describe, expect, it } from "vitest";
import { CATALOGS, LOCALES, ago, pickLocale, setLocale, t } from "./i18n.js";
import type { MessageKey } from "./i18n.js";

const placeholders = (s: string): string[] => [...new Set([...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]))].sort();
const EN_KEYS = Object.keys(CATALOGS.en).sort() as MessageKey[];

afterEach(() => setLocale("en"));

describe("string catalogs", () => {
  it("ships the five Social Home languages", () => {
    expect([...LOCALES]).toEqual(["en", "de", "nl", "fr", "es"]);
  });

  it.each(LOCALES.filter((l) => l !== "en"))("%s has every key English has, and no others", (locale) => {
    expect(Object.keys(CATALOGS[locale]).sort()).toEqual(EN_KEYS);
  });

  it.each(LOCALES)("%s: no empty string, same placeholders as English", (locale) => {
    for (const key of EN_KEYS) {
      const text = CATALOGS[locale][key];
      expect(text.trim(), `${locale} ${key}`).not.toBe("");
      expect(placeholders(text), `${locale} ${key}`).toEqual(placeholders(CATALOGS.en[key]));
    }
  });

  it.each(LOCALES)("%s keeps the names Social Home and Apps", (locale) => {
    for (const key of EN_KEYS) {
      for (const name of ["Social Home", "Apps"]) {
        if (CATALOGS.en[key].includes(name)) expect(CATALOGS[locale][key], `${locale} ${key}`).toContain(name);
      }
    }
  });

  it("uses the glossary's game names", () => {
    expect(LOCALES.map((l) => CATALOGS[l]["app.title"])).toEqual([
      "Battleships",
      "Schiffe versenken",
      "Zeeslag",
      "Bataille navale",
      "Hundir la flota",
    ]);
  });

  it("uses the glossary's hit / miss / sunk", () => {
    expect(CATALOGS.de["cell.miss"]).toContain("Wasser");
    expect(CATALOGS.de["cell.hit"]).toContain("Treffer");
    expect(CATALOGS.de["battle.shipSunk"]).toContain("versenkt");
    expect(CATALOGS.nl["cell.hit"]).toContain("raak");
    expect(CATALOGS.nl["cell.miss"]).toContain("mis");
    expect(CATALOGS.nl["battle.shipSunk"]).toContain("gezonken");
    expect(CATALOGS.fr["cell.hit"]).toContain("touché");
    expect(CATALOGS.fr["cell.miss"]).toContain("à l’eau");
    expect(CATALOGS.fr["battle.shipSunk"]).toContain("coulé");
    expect(CATALOGS.es["cell.hit"]).toContain("tocado");
    expect(CATALOGS.es["cell.miss"]).toContain("agua");
    expect(CATALOGS.es["battle.shipSunk"]).toContain("hundido");
  });

  it("never accuses: no cheat words in any language", () => {
    for (const l of LOCALES) {
      for (const [key, text] of Object.entries(CATALOGS[l])) {
        expect(text, `${l} ${key}`).not.toMatch(/cheat|betrug|schummel|vals spel|trich|tramp/i);
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
    for (const [key, text] of Object.entries(CATALOGS.de)) expect(text, key).not.toMatch(/\b(Sie|Ihre?n?|Ihnen)\b/);
  });

  it("Spanish says tú, never usted", () => {
    for (const [key, text] of Object.entries(CATALOGS.es)) expect(text, key).not.toMatch(/\busted(es)?\b/i);
  });

  it("French says vous, never tu", () => {
    for (const [key, text] of Object.entries(CATALOGS.fr)) expect(text, key).not.toMatch(/\b(tu|ton|ta|tes)\b/i);
  });
});

describe("pickLocale and t", () => {
  it.each([
    ["de", "de"], ["de-CH", "de"], ["nl-BE", "nl"], ["FR", "fr"], ["es_419", "es"],
    ["en-GB", "en"], ["pt-BR", "en"], ["ar", "en"], ["", "en"], [undefined, "en"], [null, "en"],
  ])("%s → %s", (tag, want) => {
    expect(pickLocale(tag as string | undefined)).toBe(want);
  });

  it("fills placeholders with literal text", () => {
    expect(t("invite.declined", { name: "Ben $& <b>" })).toBe("Ben $& <b> declined the game.");
    expect(t("battle.fireAt", { cell: "C9" })).toBe("Fire at C9");
  });

  it("follows the language set", () => {
    setLocale("de");
    expect(t("battle.fireAt", { cell: "C9" })).toBe("Feuer auf C9");
    setLocale("es");
    expect(t("chip.yourTurn")).toBe("Te toca");
  });

  it("says how long ago, in the language set", () => {
    const now = Date.UTC(2026, 9, 30, 12);
    expect(ago(now - 2 * 86400_000, now)).toBe("2 days ago");
    expect(ago(now - 3 * 3600_000, now)).toBe("3 hours ago");
    expect(ago(now - 5 * 60_000, now)).toBe("5 minutes ago");
    expect(ago(now, now)).toBe("now");
    setLocale("de");
    expect(ago(now - 2 * 86400_000, now)).toBe("vorgestern");
  });
});
