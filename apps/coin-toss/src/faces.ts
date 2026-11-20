/**
 * The two faces of the coin, as inline SVG (no image files, no fonts): a
 * smiling head for heads, a star for tails. No words on the coin, so it
 * reads the same in every language; the result line names the side.
 * Gold in both themes; the faces differ by shape, never by colour alone.
 */
import type { Side } from "./random.js";

const RIM = `<circle cx="50" cy="50" r="46" fill="none" stroke="#a8790f" stroke-width="2.5"/>
<circle cx="50" cy="50" r="40" fill="none" stroke="#a8790f" stroke-width="1.2" stroke-dasharray="2 3"/>`;

const HEADS = `<svg viewBox="0 0 100 100" aria-hidden="true" focusable="false">${RIM}
<circle cx="50" cy="48" r="23" fill="#e0a81c" stroke="#8a6209" stroke-width="2.5"/>
<circle cx="42" cy="44" r="3.2" fill="#6b4b05"/>
<circle cx="58" cy="44" r="3.2" fill="#6b4b05"/>
<path d="M39 54 Q50 64 61 54" fill="none" stroke="#6b4b05" stroke-width="3.2" stroke-linecap="round"/>
<path d="M33 37 Q36 22 50 22 Q64 22 67 37 Q60 29 50 30 Q40 29 33 37 Z" fill="#8a6209"/>
<path d="M38 74 Q50 70 62 74 L66 82 Q50 77 34 82 Z" fill="#8a6209"/>
</svg>`;

const TAILS = `<svg viewBox="0 0 100 100" aria-hidden="true" focusable="false">${RIM}
<path d="M50 20 L58.8 38.6 L79 41 L64 55 L68 75 L50 65 L32 75 L36 55 L21 41 L41.2 38.6 Z"
  fill="#e0a81c" stroke="#8a6209" stroke-width="2.5" stroke-linejoin="round"/>
<circle cx="50" cy="49" r="5" fill="#8a6209"/>
</svg>`;

/** Static markup for *side*'s face (a constant: safe for innerHTML). */
export function faceSvg(side: Side): string {
  return side === "heads" ? HEADS : TAILS;
}
