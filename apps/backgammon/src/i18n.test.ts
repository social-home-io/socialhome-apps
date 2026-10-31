import { afterEach, describe, expect, it } from "vitest";
import { CATALOGS, LOCALES, pickLocale, setLocale, t } from "./i18n.js";
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

  it("calls the game Backgammon in every language", () => {
    expect(LOCALES.map((l) => CATALOGS[l]["app.title"])).toEqual(["Backgammon", "Backgammon", "Backgammon", "Backgammon", "Backgammon"]);
  });

  it("uses the glossary's backgammon words", () => {
    expect([CATALOGS.de["newGame.cube"], CATALOGS.nl["newGame.cube"], CATALOGS.fr["newGame.cube"], CATALOGS.es["newGame.cube"]]).toEqual([
      "Dopplerwürfel",
      "Verdubbelingskubus",
      "Videau",
      "Cubo de doblaje",
    ]);
    expect([CATALOGS.de["pt.bar"], CATALOGS.nl["pt.bar"], CATALOGS.fr["pt.bar"], CATALOGS.es["pt.bar"]]).toEqual(["Bar", "bar", "barre", "barra"]);
    expect([CATALOGS.de["cell.point"], CATALOGS.nl["cell.point"], CATALOGS.fr["cell.point"], CATALOGS.es["cell.point"]]).toEqual([
      "Punkt {n}",
      "Punt {n}",
      "Flèche {n}",
      "Punto {n}",
    ]);
    expect(CATALOGS.de["players.off"]).toContain("abgetragen");
    expect(CATALOGS.nl["players.off"]).toContain("uitgespeeld");
    expect(CATALOGS.fr["players.off"]).toContain("sorties");
    expect(CATALOGS.es["players.off"]).toContain("sacadas");
    expect([CATALOGS.de["fair.title"], CATALOGS.nl["fair.title"], CATALOGS.fr["fair.title"], CATALOGS.es["fair.title"]]).toEqual([
      "Faire Würfel",
      "Eerlijke dobbelstenen",
      "Dés équitables",
      "Dados justos",
    ]);
    for (const l of LOCALES) {
      expect(CATALOGS[l]["end.youGammon"]).toMatch(/gammon/i);
      expect(CATALOGS[l]["end.youBackgammon"]).toMatch(/backgammon/i);
    }
    // Clock and claim words as in Go (glossary: translations#16).
    expect([CATALOGS.de["btn.claim"], CATALOGS.nl["btn.claim"], CATALOGS.fr["btn.claim"], CATALOGS.es["btn.claim"]]).toEqual([
      "Sieg einfordern",
      "Winst opeisen",
      "Réclamer la victoire",
      "Reclamar la victoria",
    ]);
    expect(CATALOGS.de["clock.days"]).toBe("{n} Tage pro Zug");
    // Decline is never the Resign dialog's "keep playing".
    for (const l of LOCALES) expect(CATALOGS[l]["decline.cancel"]).not.toBe(CATALOGS[l]["decline.confirm"]);
  });

  it("never accuses: no cheat words in any language", () => {
    for (const l of LOCALES) {
      for (const [key, text] of Object.entries(CATALOGS[l])) {
        expect(text, `${l} ${key}`).not.toMatch(/cheat|betrug|schummel|vals spel|\btrich|tramp|forged|gefälscht/i);
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
    expect(t("btn.double", { n: 2 })).toBe("Double to 2");
    setLocale("de");
    expect(t("btn.double", { n: 4 })).toBe("Auf 4 verdoppeln");
  });
});
