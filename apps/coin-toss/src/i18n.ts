/**
 * Coin toss's words in Social Home's five languages.
 *
 * Social Home tells the app the person's language (`context().locale`); the
 * app picks the closest catalog (`de-CH` → `de`) and falls back to English.
 * Words follow Social Home's shared glossary (social-home-io/translations):
 * du / je / vous / tú; the app's name is an ordinary word, so each language
 * uses its own (Münzwurf · Kop of munt · Pile ou face · Cara o cruz), like
 * the other games. Heads / Tails = Kopf / Zahl · Kop / Munt · Pile / Face ·
 * Cara / Cruz. French puts a no-break space before : ; ! ?.
 *
 * Every catalog has every key (tested); `{name}`-style placeholders are
 * filled with literal text (never markup — callers build the DOM).
 */

export const LOCALES = ["en", "de", "nl", "fr", "es"] as const;
export type Locale = (typeof LOCALES)[number];

/** French typography: a no-break space before : ; ! ? */
const NB = " ";

const en = {
  "app.title": "Coin toss",
  "app.docTitle": "Coin toss — Social Home",
  "app.mainLabel": "Coin toss app",
  "hint": "Tap the coin or the button. The coin lands on heads or tails by pure chance.",
  "btn.toss": "Toss the coin",
  "btn.again": "Toss again",
  "btn.inAir": "In the air…",
  "coin.label": "Coin, showing {side}",
  "side.heads": "Heads",
  "side.tails": "Tails",
  "result.heads": "Heads!",
  "result.tails": "Tails!",
  "status.ready": "Ready to toss",
  "status.inAir": "The coin is in the air…",
  "tally.label": "So far",
  "tally.line": "Heads {heads} · Tails {tails}",
  "history.label": "Last tosses",
  "btn.reset": "Start over",
  "announce.reset": "Count started over",
};

export type MessageKey = keyof typeof en;
type Catalog = Record<MessageKey, string>;

const de: Catalog = {
  "app.title": "Münzwurf",
  "app.docTitle": "Münzwurf — Social Home",
  "app.mainLabel": "App Münzwurf",
  "hint": "Tipp auf die Münze oder den Knopf. Ob Kopf oder Zahl, entscheidet allein der Zufall.",
  "btn.toss": "Münze werfen",
  "btn.again": "Noch mal werfen",
  "btn.inAir": "In der Luft …",
  "coin.label": "Münze, zeigt {side}",
  "side.heads": "Kopf",
  "side.tails": "Zahl",
  "result.heads": "Kopf!",
  "result.tails": "Zahl!",
  "status.ready": "Bereit zum Werfen",
  "status.inAir": "Die Münze ist in der Luft …",
  "tally.label": "Bisher",
  "tally.line": "Kopf {heads} · Zahl {tails}",
  "history.label": "Letzte Würfe",
  "btn.reset": "Neu anfangen",
  "announce.reset": "Zählung neu gestartet",
};

const nl: Catalog = {
  "app.title": "Kop of munt",
  "app.docTitle": "Kop of munt — Social Home",
  "app.mainLabel": "App Kop of munt",
  "hint": "Tik op de munt of op de knop. Of het kop of munt wordt, is puur toeval.",
  "btn.toss": "Gooi de munt",
  "btn.again": "Nog een keer",
  "btn.inAir": "In de lucht…",
  "coin.label": "Munt, toont {side}",
  "side.heads": "Kop",
  "side.tails": "Munt",
  "result.heads": "Kop!",
  "result.tails": "Munt!",
  "status.ready": "Klaar om te gooien",
  "status.inAir": "De munt is in de lucht…",
  "tally.label": "Tot nu toe",
  "tally.line": "Kop {heads} · Munt {tails}",
  "history.label": "Laatste worpen",
  "btn.reset": "Opnieuw beginnen",
  "announce.reset": "Telling opnieuw begonnen",
};

const fr: Catalog = {
  "app.title": "Pile ou face",
  "app.docTitle": "Pile ou face — Social Home",
  "app.mainLabel": "App Pile ou face",
  "hint": "Touchez la pièce ou le bouton. Pile ou face, c’est le hasard qui décide.",
  "btn.toss": "Lancer la pièce",
  "btn.again": "Relancer",
  "btn.inAir": "En l’air…",
  "coin.label": "Pièce, côté {side}",
  "side.heads": "Face",
  "side.tails": "Pile",
  "result.heads": `Face${NB}!`,
  "result.tails": `Pile${NB}!`,
  "status.ready": "Prêt à lancer",
  "status.inAir": "La pièce est en l’air…",
  "tally.label": "Jusqu’ici",
  "tally.line": "Face {heads} · Pile {tails}",
  "history.label": "Derniers lancers",
  "btn.reset": "Recommencer",
  "announce.reset": "Le compte repart de zéro",
};

const es: Catalog = {
  "app.title": "Cara o cruz",
  "app.docTitle": "Cara o cruz — Social Home",
  "app.mainLabel": "App Cara o cruz",
  "hint": "Toca la moneda o el botón. Que salga cara o cruz es puro azar.",
  "btn.toss": "Lanzar la moneda",
  "btn.again": "Lanzar otra vez",
  "btn.inAir": "En el aire…",
  "coin.label": "Moneda, muestra {side}",
  "side.heads": "Cara",
  "side.tails": "Cruz",
  "result.heads": "¡Cara!",
  "result.tails": "¡Cruz!",
  "status.ready": "Lista para lanzar",
  "status.inAir": "La moneda está en el aire…",
  "tally.label": "Hasta ahora",
  "tally.line": "Cara {heads} · Cruz {tails}",
  "history.label": "Últimos lanzamientos",
  "btn.reset": "Empezar de nuevo",
  "announce.reset": "La cuenta vuelve a cero",
};

export const CATALOGS: Record<Locale, Catalog> = { en, de, nl, fr, es };

let current: Locale = "en";

export function pickLocale(tag: string | undefined | null): Locale {
  if (typeof tag !== "string") return "en";
  const base = tag.trim().toLowerCase().split(/[-_]/)[0];
  return (LOCALES as readonly string[]).includes(base) ? (base as Locale) : "en";
}

export function setLocale(locale: Locale): void {
  current = locale;
}

export function getLocale(): Locale {
  return current;
}

/** The text for *key* in the current language, `{placeholders}` filled with
 *  literal text. A missing key falls back to English. */
export function t(key: MessageKey, params: Record<string, string | number> = {}): string {
  let text = CATALOGS[current][key] ?? en[key];
  for (const [k, v] of Object.entries(params)) {
    text = text.split(`{${k}}`).join(String(v));
  }
  return text;
}

/** A count in the current language's digits. */
export function num(n: number): string {
  return new Intl.NumberFormat(current).format(n);
}
