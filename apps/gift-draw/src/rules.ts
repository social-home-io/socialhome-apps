/**
 * The gift draw's rules as the app checks them before asking Social Home
 * (pure, no DOM, unit-tested). Social Home checks all of it again — these
 * only keep the person from pressing a button that can't work.
 *
 * - Settings: a name (≤ 80 characters) and a budget (free text, ≤ 40), one
 *   line each; the exchange day `YYYY-MM-DD`, not in the past.
 * - Pairs ("Who shouldn't draw each other?", for couples): two different
 *   seated people, nobody in two pairs, at least four people when there is
 *   any pair and at most one pair for every three people (so the names can
 *   always be drawn).
 * - Wish list: ≤ 500 characters (Social Home also makes sure the whole card
 *   fits 1 KiB).
 */

import {
  DRAW_AGAIN_MAX,
  DRAW_BUDGET_MAX,
  DRAW_MIN_PEOPLE,
  DRAW_MIN_PEOPLE_WITH_PAIRS,
  DRAW_NAME_MAX,
  DRAW_WISH_MAX_CHARS,
} from "@socialhome/app-sdk";
import type { DrawStatus } from "@socialhome/app-sdk";

export type Pair = [number, number];

export { DRAW_BUDGET_MAX as BUDGET_MAX, DRAW_MIN_PEOPLE as MIN_PEOPLE, DRAW_NAME_MAX as NAME_MAX, DRAW_WISH_MAX_CHARS as WISH_MAX };

/** Characters as a person counts them (an emoji is one). */
export function chars(text: string): number {
  return [...text].length;
}

/** The wish list as Social Home keeps it: trimmed, Windows line ends made plain. */
export function cleanWish(text: string): string {
  return text.replace(/\r\n/g, "\n").trim();
}

/** How long a wish list is, as Social Home counts it. */
export function wishLength(text: string): number {
  return chars(cleanWish(text));
}

/** One line of at most *max* characters, trimmed. */
export function cleanLine(text: string, max: number): string {
  return [...text.replace(/[\r\n]+/g, " ").trim()].slice(0, max).join("");
}

/** The most pairs *n* people can have. */
export function maxPairs(n: number): number {
  return n < DRAW_MIN_PEOPLE_WITH_PAIRS ? 0 : Math.floor(n / 3);
}

/** Whether *pairs* work for the people in *seats* (Social Home's `pairs_fit`). */
export function pairsFit(pairs: readonly Pair[], seats: ReadonlySet<number>): boolean {
  if (pairs.length === 0) return true;
  if (pairs.length > maxPairs(seats.size)) return false;
  const seen = new Set<number>();
  for (const [a, b] of pairs) {
    if (a === b || !seats.has(a) || !seats.has(b) || seen.has(a) || seen.has(b)) return false;
    seen.add(a);
    seen.add(b);
  }
  return true;
}

/** The pairs whose two people are both still seated (someone of a pair left: the pair goes). */
export function keepSeated(pairs: readonly Pair[], seats: ReadonlySet<number>): Pair[] {
  return pairs.filter(([a, b]) => seats.has(a) && seats.has(b)).map(([a, b]) => [a, b] as Pair);
}

/** Seated people not in any pair yet, in seat order. */
export function unpaired(pairs: readonly Pair[], seats: ReadonlySet<number>): number[] {
  const taken = new Set(pairs.flat());
  return [...seats].filter((s) => !taken.has(s)).sort((x, y) => x - y);
}

/** Whether another pair may be added for these people. */
export function canAddPair(pairs: readonly Pair[], seats: ReadonlySet<number>): boolean {
  return pairs.length < maxPairs(seats.size) && unpaired(pairs, seats).length >= 2;
}

/** *pairs* with a new pair of *a* and *b* (low seat first), or `null` when it doesn't fit. */
export function addPair(pairs: readonly Pair[], a: number, b: number, seats: ReadonlySet<number>): Pair[] | null {
  const next: Pair[] = [...pairs, [Math.min(a, b), Math.max(a, b)]];
  return pairsFit(next, seats) ? next : null;
}

/** *pairs* without the one at *index*. */
export function removePair(pairs: readonly Pair[], index: number): Pair[] {
  return pairs.filter((_, i) => i !== index);
}

/** Today in the person's own time zone, `YYYY-MM-DD`. */
export function todayIso(now: Date = new Date()): string {
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, "0");
  const d = String(now.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

/** Whether *day* is a real `YYYY-MM-DD` date. */
export function isDay(day: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return false;
  const d = new Date(`${day}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === day;
}

/** Whether the exchange day *day* is over (`null`: no day, never over). */
export function isPastDay(day: string | null, today: string): boolean {
  return day !== null && day < today;
}

/** The organiser may draw again: everyone has their name, fewer than ten
 *  times so far, and the exchange day isn't over. */
export function canDrawAgain(status: DrawStatus, today: string): boolean {
  return (
    status.isHost &&
    status.state === "ready" &&
    status.again < DRAW_AGAIN_MAX &&
    !isPastDay(status.settings?.day ?? null, today)
  );
}

/** How often the organiser may still draw again. */
export function againLeft(status: DrawStatus): number {
  return Math.max(0, DRAW_AGAIN_MAX - status.again);
}

/** The exchange day for people: "24 Dec 2026" in their language. */
export function formatDay(day: string, locale: string): string {
  if (!isDay(day)) return day;
  const d = new Date(`${day}T12:00:00Z`);
  try {
    return new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeZone: "UTC" }).format(d);
  } catch {
    return day;
  }
}
