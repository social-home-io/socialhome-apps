import { afterEach, describe, expect, it } from "vitest";
import { CATALOGS, LOCALES, list, pickLocale, setLocale, t } from "./i18n.js";
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

  it("names the app as the glossary does (translations#18)", () => {
    expect(LOCALES.map((l) => CATALOGS[l]["app.title"])).toEqual([
      "Gift draw", "Wichteln", "Lootjes trekken", "Père Noël secret", "Amigo invisible",
    ]);
    expect(LOCALES.map((l) => CATALOGS[l]["home.new"])).toEqual([
      "New gift draw", "Neues Wichteln", "Nieuwe trekking", "Nouveau Père Noël secret", "Nuevo amigo invisible",
    ]);
  });

  it("uses the glossary's gift-draw words", () => {
    const row = (key: MessageKey) => LOCALES.map((l) => CATALOGS[l][key]);
    expect(row("draw.btn")).toEqual(["Draw names", "Namen ziehen", "Lootjes trekken", "Tirer au sort", "Sortear"]);
    expect(row("again.btn")).toEqual(["Draw again", "Neu auslosen", "Opnieuw trekken", "Refaire le tirage", "Repetir el sorteo"]);
    expect(row("waiting.keep")).toEqual(["Keep waiting", "Weiter warten", "Blijven wachten", "Continuer d’attendre", "Seguir esperando"]);
    expect(row("waiting.without")).toEqual(["Draw without them", "Ohne sie auslosen", "Zonder hen trekken", "Tirer au sort sans eux", "Sortear sin ellos"]);
    expect(row("ready.title")).toEqual(["Your name is ready", "Dein Los ist da", "Je lootje is er", "Votre tirage est prêt", "Ya tienes tu amigo invisible"]);
    expect(row("ready.see")).toEqual(["See who you're giving to", "Sieh nach, wen du beschenkst", "Bekijk wie je hebt getrokken", "Voir à qui vous offrez un cadeau", "Mira a quién le regalas"]);
    expect(row("pairs.add")).toEqual(["Add a pair", "Paar hinzufügen", "Paar toevoegen", "Ajouter une paire", "Añadir una pareja"]);
    expect(row("field.day")).toEqual(["Exchange day", "Bescherung", "Cadeaudag", "Jour de l’échange", "Día del intercambio"]);
    expect(row("wish.update")).toEqual(["Update my wish list", "Wunschliste ändern", "Verlanglijstje aanpassen", "Modifier ma liste de souhaits", "Cambiar mi lista de deseos"]);
  });

  it("never uses a game result, the household pairing words, Secret Santa, host or organiser", () => {
    const banned = [/\bRemis\b/, /Unentschieden/, /\bremise\b/, /\bnulle\b/, /\btablas\b/, /\bempate\b/, /koppel/i, /Kopplung/, /jumel/i, /vincul/i,
      /Secret Santa/, /\bhost\b/i, /Gastgeber/, /Organisator/, /organisator/, /organisateur/, /organizador/, /anfitri/, /\bhôte\b/, /Beitreten/, /Rejoindre/, /Unirse/];
    for (const l of LOCALES) {
      for (const key of EN_KEYS) {
        if (key === "about.how" || key.startsWith("field.")) continue;
        for (const b of banned) expect(CATALOGS[l][key], `${l} ${key}`).not.toMatch(b);
      }
    }
  });

  it("French puts a no-break space before : ; ! ?", () => {
    for (const key of EN_KEYS) expect(CATALOGS.fr[key], key).not.toMatch(/ [:;!?]/);
  });
});

describe("pickLocale / t / list", () => {
  it("picks the closest catalog", () => {
    expect(pickLocale("de-CH")).toBe("de");
    expect(pickLocale("pt-BR")).toBe("en");
    expect(pickLocale(undefined)).toBe("en");
  });

  it("fills placeholders with literal text", () => {
    expect(t("table.started", { name: "$& <b>" })).toBe("$& <b> started this gift draw.");
  });

  it("joins names in the person's language", () => {
    expect(list(["Ben", "Lena"])).toBe("Ben and Lena");
    setLocale("de");
    expect(list(["Ben", "Lena", "Cleo"])).toBe("Ben, Lena und Cleo");
  });
});
