/**
 * Social Home's look applied to Backgammon: the person's
 * language (closest catalog, English fallback), the text direction, light or
 * dark and the colour tokens.
 *
 * - Language: `<html lang>` names the catalog the app shows, not the tag
 *   Social Home asked for (an `ar` person sees English text, `lang="en"`).
 * - Direction: Social Home's `dir` when the app shows that language; English
 *   text shown in place of a right-to-left language stays left to right (a
 *   right-to-left page would scramble its word order). The board itself
 *   always stays left to right (main.ts), in a right-to-left language too.
 * - Theme: the SDK's `applyTheme` writes the eight `--sh-*` colours,
 *   `color-scheme` and `data-theme`; style.css uses the tokens in both
 *   themes (with Social Home's default light / dark palettes as fallbacks
 *   for an older Social Home that sends no tokens).
 * - Reduced motion: `data-reduced-motion="true"` turns animations off
 *   (style.css), on top of the system's own `prefers-reduced-motion`.
 */
import { applyTheme } from "@socialhome/app-sdk";
import type { AppLook } from "@socialhome/app-sdk";
import { pickLocale, setLocale } from "./i18n.js";
import type { Locale } from "./i18n.js";

/** Apply *look* to *root* (`document.documentElement`); returns the catalog chosen. */
export function applyLook(look: AppLook, root: HTMLElement): Locale {
  const locale = pickLocale(look.locale);
  setLocale(locale);
  root.lang = locale;
  const asked = (look.locale ?? "en").toLowerCase().split(/[-_]/)[0];
  root.dir = look.dir === "rtl" && asked === locale ? "rtl" : "ltr";
  applyTheme(look, root);
  return locale;
}
