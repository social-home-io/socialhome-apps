/**
 * What each screen shows, worked out from the table and the draw's state
 * (pure, no DOM, unit-tested). main.ts only draws what this says.
 *
 * The draw's state comes from Social Home (`sh.engines.draw.status` and its
 * `engine:event` pushes); it never contains a result. The table (who's in,
 * who started it) comes from `sh.group`.
 */

import { DRAW_MIN_PEOPLE } from "@socialhome/app-sdk";
import type { DrawSettings, DrawStatus, GroupSession } from "@socialhome/app-sdk";
import { keepSeated, pairsFit } from "./rules.js";
import type { Pair } from "./rules.js";

/** Where the person is with one gift draw. */
export type Phase =
  | "invited" // invited, hasn't joined (Join is in Social Home's Needs you)
  | "joining" // Join sent, not seated yet
  | "gone" // left or removed
  | "ended" // the table is over: the draw is gone with it
  | "loading" // waiting for the draw's state
  | "error" // the draw's state didn't load
  | "gathering" // people join; the organiser sets it up
  | "drawing" // Social Home is drawing names
  | "ready" // the person has a name to see
  | "readyNoName" // names are drawn, but not for this person
  | "failedRules" // the pairs never fit
  | "failedTooFew" // fewer than three people left
  | "failedBroken" // someone's home kept breaking the draw
  | "failed"; // gave up for a reason this app doesn't know

export function phaseOf(table: GroupSession, status: DrawStatus | undefined, loadFailed = false): Phase {
  if (table.myState === "invited") return "invited";
  if (table.myState === "joining") return "joining";
  if (table.myState === "left" || table.myState === "removed") return "gone";
  if (table.state === "ended") return "ended";
  if (!status) return loadFailed ? "error" : "loading";
  switch (status.state) {
    case "gathering":
      return "gathering";
    case "drawing":
      return "drawing";
    case "ready":
      return status.hasResult ? "ready" : "readyNoName";
    case "failed":
      if (status.reason === "rules") return "failedRules";
      if (status.reason === "too_few") return "failedTooFew";
      if (status.reason === "broken") return "failedBroken";
      return "failed";
  }
}

/** One person in the draw. */
export interface Person {
  seat: number;
  name: string;
  /** Their household's name; `null` for the person's own. */
  household: string | null;
  isMe: boolean;
  isOrganiser: boolean;
}

/** Everyone seated, in seat order. */
export function seatedPeople(table: GroupSession): Person[] {
  return table.players
    .filter((p) => p.state === "seated")
    .map((p) => ({
      seat: p.seat,
      name: p.name,
      household: p.household,
      isMe: p.seat === table.me,
      isOrganiser: p.seat === table.host,
    }));
}

export function seatSet(table: GroupSession): Set<number> {
  return new Set(seatedPeople(table).map((p) => p.seat));
}

/** How many homes the seated people come from. */
export function homesCount(people: readonly Person[]): number {
  return new Set(people.map((p) => p.household ?? "\u0000own")).size;
}

/** The names at *seats* (anyone at the table, seated or not), in that order. */
export function namesOf(table: GroupSession, seats: readonly number[]): string[] {
  const bySeat = new Map(table.players.map((p) => [p.seat, p.name]));
  return seats.map((s) => bySeat.get(s)).filter((n): n is string => n !== undefined);
}

/** The person who started the draw, by name (`""` while unknown). */
export function organiserName(table: GroupSession): string {
  return table.host === null ? "" : namesOf(table, [table.host])[0] ?? "";
}

/**
 * The details to show: Social Home's own copy once it has one (always, once
 * the names are drawn, and for the organiser), else what the organiser
 * shared.
 */
export function shownDetails(status: DrawStatus | undefined, shared: DrawSettings | undefined): DrawSettings | null {
  return status?.settings ?? shared ?? null;
}

/** The pairs that still apply (both people seated). */
export function livePairs(table: GroupSession, details: DrawSettings | null): Pair[] {
  return keepSeated(details?.pairs ?? [], seatSet(table));
}

/** Whether the organiser may change the details and pairs now. */
export function canEditDetails(status: DrawStatus | undefined): boolean {
  return !!status && status.isHost && (status.state === "gathering" || status.state === "failed");
}

/** Why Draw names can't be pressed yet, or `null` when it can. */
export type DrawBlock = "few" | "pairs" | null;

export function drawBlock(table: GroupSession, pairs: readonly Pair[]): DrawBlock {
  const seats = seatSet(table);
  if (seats.size < DRAW_MIN_PEOPLE) return "few";
  if (!pairsFit(pairs, seats)) return "pairs";
  return null;
}

/** Organiser only: how far the current step is, in homes. */
export function progressOf(status: DrawStatus, homes: number): { done: number; of: number } | null {
  if (!status.isHost || status.state !== "drawing" || status.done === undefined || homes < 1) return null;
  return { done: Math.min(status.done, homes), of: homes };
}

/** Organiser only: each home the draw waits for, with its people's names. */
export function waitingHomes(table: GroupSession, status: DrawStatus): { seats: number[]; names: string[] }[] {
  if (!status.isHost || status.state !== "drawing") return [];
  return (status.waitingFor ?? [])
    .map((h) => ({ seats: h.seats, names: namesOf(table, h.seats) }))
    .filter((h) => h.names.length > 0);
}

/** Homes blamed for breaking a round (stopped it without proof, or sent a
 *  key nobody could seal to), by their people's names. Social Home shows
 *  them to everyone at the table; the app words it gently for all but the
 *  organiser. */
export function blamedHomes(table: GroupSession, status: DrawStatus): string[][] {
  return (status.blamed ?? []).map((h) => namesOf(table, h.seats)).filter((n) => n.length > 0);
}

/** The chip on a gift draw in the list. */
export type Chip = "ready" | "drawing" | "gathering" | "invited" | "over" | "failed" | "noName" | null;

export function chipOf(phase: Phase): Chip {
  switch (phase) {
    case "ready":
      return "ready";
    case "drawing":
      return "drawing";
    case "gathering":
      return "gathering";
    case "invited":
    case "joining":
      return "invited";
    case "ended":
    case "gone":
      return "over";
    case "failedRules":
    case "failedTooFew":
    case "failedBroken":
    case "failed":
      return "failed";
    case "readyNoName":
      return "noName";
    default:
      return null;
  }
}

const ORDER: Record<string, number> = { ready: 0, invited: 1, drawing: 2, gathering: 3, failed: 4, noName: 5, over: 6 };

/** The list order: names to see first, finished ones last. */
export function listOrder(a: Phase, b: Phase): number {
  return (ORDER[chipOf(a) ?? "gathering"] ?? 3) - (ORDER[chipOf(b) ?? "gathering"] ?? 3);
}

/** Whether a table belongs in this app's list. */
export function isOurTable(table: GroupSession, appId: string): boolean {
  return table.appId === undefined || table.appId === appId;
}
