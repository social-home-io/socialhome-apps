/**
 * Social Home's look applied to Coin toss: the person's language (closest
 * catalog, English fallback), the text direction, light or dark, the colour
 * tokens and reduced motion.
 *
 * - Language: `<html lang>` names the catalog the app shows, not the tag
 *   Social Home asked for (an `ar` person sees English text, `lang="en"`).
 * - Direction: Social Home's `dir` when the app shows that language; English
 *   text shown in place of a right-to-left language stays left to right.
 * - Theme: the SDK's `applyTheme` writes the eight `--sh-*` colours,
 *   `color-scheme` and `data-theme`; style.css uses the tokens in both
 *   themes (with Social Home's default palettes as fallbacks).
 * - Reduced motion: `data-reduced-motion="true"` (from Social Home) or the
 *   system's `prefers-reduced-motion` swaps the spin for a short fade
 *   (`wantsReducedMotion`, used by main.ts to pick the animation).
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

/** Whether to fade instead of spin: Social Home's flag wins when it sent
 *  one; otherwise the system setting decides. */
export function wantsReducedMotion(flag: string | undefined, systemReduce: boolean): boolean {
  if (flag === "true") return true;
  if (flag === "false") return false;
  return systemReduce;
}
