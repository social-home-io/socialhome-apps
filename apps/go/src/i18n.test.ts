import { afterEach, describe, expect, it } from "vitest";
import { CATALOGS, LOCALES, num, pickLocale, setLocale, t } from "./i18n.js";
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

  it("calls the game Go in every language", () => {
    expect(LOCALES.map((l) => CATALOGS[l]["app.title"])).toEqual(["Go", "Go", "Go", "Go", "Go"]);
  });

  it("uses the glossary's Go words", () => {
    expect(CATALOGS.de["btn.pass"]).toBe("Passen");
    expect(CATALOGS.de["cell.black"]).toBe("schwarzer Stein");
    expect(CATALOGS.de["captures.b"]).toContain("geschlagen");
    expect(CATALOGS.de["score.territory"]).toBe("Gebiet");
    expect(CATALOGS.de["btn.resume"]).toBe("Partie fortsetzen");
    expect(CATALOGS.nl["cell.white"]).toBe("witte steen");
    expect(CATALOGS.nl["captures.w"]).toContain("geslagen");
    expect(CATALOGS.nl["score.territory"]).toBe("Gebied");
    expect(CATALOGS.fr["cell.black"]).toBe("pierre noire");
    expect(CATALOGS.fr["btn.pass"]).toBe("Passer");
    expect(CATALOGS.fr["score.territory"]).toBe("Territoire");
    expect(CATALOGS.es["cell.white"]).toBe("piedra blanca");
    expect(CATALOGS.es["btn.pass"]).toBe("Pasar");
    expect(CATALOGS.es["score.territory"]).toBe("Territorio");
    for (const l of LOCALES) {
      expect(CATALOGS[l]["score.komi"]).toBe("Komi");
      expect(CATALOGS[l]["illegal.ko"]).toMatch(/\bko\b/i);
    }
    // Resume play is never the Resign dialog's "keep playing".
    for (const l of LOCALES) expect(CATALOGS[l]["btn.resume"]).not.toBe(CATALOGS[l]["resign.cancel"]);
  });

  it("never accuses: no cheat words in any language", () => {
    for (const l of LOCALES) {
      for (const [key, text] of Object.entries(CATALOGS[l])) {
        expect(text, `${l} ${key}`).not.toMatch(/cheat|betrug|schummel|vals spel|trich|tramp|forged|gefälscht/i);
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

describe("pickLocale, t and num", () => {
  it.each([
    ["de", "de"], ["de-CH", "de"], ["nl-BE", "nl"], ["FR", "fr"], ["es_419", "es"],
    ["en-GB", "en"], ["pt-BR", "en"], ["ar", "en"], ["", "en"], [undefined, "en"], [null, "en"],
  ])("%s → %s", (tag, want) => {
    expect(pickLocale(tag as string | undefined)).toBe(want);
  });

  it("fills placeholders with literal text", () => {
    expect(t("invite.declined", { name: "Ben $& <b>" })).toBe("Ben $& <b> declined the game.");
    expect(t("btn.place", { point: "D4" })).toBe("Place at D4");
  });

  it("writes scores with the language's decimal mark", () => {
    expect(num(3.5)).toBe("3.5");
    expect(num(45)).toBe("45");
    setLocale("de");
    expect(num(3.5)).toBe("3,5");
    expect(t("end.byScore", { winner: "Schwarz", margin: num(3.5) })).toBe("Schwarz gewinnt mit 3,5 Punkten");
  });
});
