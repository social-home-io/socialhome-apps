/**
 * The optional clock: days per move, correspondence style — pure, tested.
 *
 * Each move gives the other player the full allowance again. Nobody loses
 * automatically: when the other player's time has run out you may claim the
 * win, and THEIR app decides, from its own records only:
 *
 *   - Every side keeps one time of its own (`GameEntry.clockFrom`): the
 *     moment, on this device's clock, that it first had the game as it now
 *     stands (its own step, or the other player's step arriving). No time
 *     ever comes from the other side.
 *   - On my turn that moment is when my app first showed me their step, so
 *     my deadline is `clockFrom + days`. A claim is accepted only if that
 *     deadline has passed by my own clock; otherwise it is refused and play
 *     goes on. The worst a dispute can do is "the game continues".
 *   - On their turn it is when I made my step: their deadline as I see it
 *     is never earlier than their own (they can only have seen my step
 *     later). I offer "Claim the win" only `SKEW_MS` after it, so a claim is
 *     almost never refused for delivery delay.
 *
 * Both sides compare times from their own clock only, so the two devices'
 * clocks may disagree by any amount; only a clock that is changed while a
 * turn runs moves that side's view (and only for its own deadline).
 */

import type { Color } from "./rules.js";
import { DAY_MS } from "./inbound.js";
import type { GameState } from "./game.js";

/** Grace before "time ran out" shows for the other player (delivery, clock steps). */
export const SKEW_MS = 10 * 60 * 1000;

/** When this side started counting the current turn (log length *n*). */
export interface ClockMark {
  n: number;
  at: number;
}

export interface ClockInput {
  state: GameState;
  myColor: Color;
  logLength: number;
  clockFrom: ClockMark | null | undefined;
  /** We are still waiting for the invitee to answer (no clock runs yet). */
  awaiting: boolean;
  /** Their app said they still had this long (our clock), for this log length. */
  theirHint?: ClockMark | null;
}

export interface TurnClock {
  /** Whose turn the clock runs for. */
  who: Color;
  mine: boolean;
  /** Deadline on this device's clock. */
  deadline: number;
  /** Time left (≥ 0). */
  leftMs: number;
  /** My turn: my time is up by my own records. Their turn: I may claim. */
  expired: boolean;
}

/** The clock of the turn now running, or `null` (no clock, game over, waiting for the invite). */
export function turnClock(c: ClockInput, now: number): TurnClock | null {
  const st = c.state;
  if (st.setup.days <= 0 || st.phase === "over" || c.awaiting) return null;
  // A mark for another position: the turn started when we first saw this one (now).
  const since = c.clockFrom && c.clockFrom.n === c.logLength ? c.clockFrom.at : now;
  const mine = st.toMove === c.myColor;
  let deadline = Math.min(since, now) + st.setup.days * DAY_MS;
  if (!mine) {
    deadline += SKEW_MS;
    // Their app told us how long it still counts: wait at least that long.
    if (c.theirHint && c.theirHint.n === c.logLength) deadline = Math.max(deadline, c.theirHint.at);
  }
  return { who: st.toMove, mine, deadline, leftMs: Math.max(0, deadline - now), expired: now >= deadline };
}

export type ClaimDecision = { accept: true } | { accept: false; leftMs: number };

/**
 * A claim that our time ran out: accepted only if, by our own records, our
 * deadline has passed (our turn began when we first saw their step). Not our
 * turn, no clock or the game is over → refused with the whole allowance.
 */
export function decideClaim(c: ClockInput, now: number): ClaimDecision {
  const clock = turnClock({ ...c, awaiting: false }, now);
  if (!clock || !clock.mine) return { accept: false, leftMs: c.state.setup.days * DAY_MS };
  return clock.expired ? { accept: true } : { accept: false, leftMs: clock.leftMs };
}

/** The mark to keep after the game moved to *n* entries at *now*: an existing one for the same position stays. */
export function markFor(prev: ClockMark | null | undefined, n: number, now: number): ClockMark {
  return prev && prev.n === n ? prev : { n, at: now };
}

/** The pieces of a time-left text: whole days and hours, or hours and minutes under a day. */
export function splitLeft(ms: number): { d: number; h: number; m: number } {
  const totalMin = Math.max(0, Math.floor(ms / 60_000));
  const d = Math.floor(totalMin / (24 * 60));
  const h = Math.floor((totalMin % (24 * 60)) / 60);
  const m = totalMin % 60;
  return { d, h, m };
}
