/**
 * The pure parts of a toss: where the coin's spin ends, and this sitting's
 * tally and recent results. Nothing is saved: the count starts at zero each
 * time the app opens.
 */
import type { Side } from "./random.js";

/** How many recent results the strip shows. */
export const HISTORY_SIZE = 8;

/** Roughly how many half-turns a second the coin makes while spinning. */
export const HALF_TURNS_PER_SECOND = 5;

/** The resting angle (rotateX, degrees) that shows *side*: heads up at 0°,
 *  tails up at 180°. */
export function restAngle(side: Side): number {
  return side === "heads" ? 0 : 180;
}

/**
 * The angle the spin ends on, from the coin's current resting *side*: whole
 * turns for the time in the air plus the half turn that lands on *target*.
 * Always at least two full turns, so even a heads-after-heads toss visibly
 * spins.
 */
export function spinEndAngle(from: Side, target: Side, durationMs: number): number {
  const fullTurns = Math.max(2, Math.round((durationMs / 1000) * (HALF_TURNS_PER_SECOND / 2)));
  const half = from === target ? 0 : 180;
  return restAngle(from) + fullTurns * 360 + half;
}

export interface Tally {
  heads: number;
  tails: number;
  /** Newest first, at most HISTORY_SIZE. */
  recent: Side[];
}

export function emptyTally(): Tally {
  return { heads: 0, tails: 0, recent: [] };
}

/** The tally with one more *side* counted. */
export function record(tally: Tally, side: Side): Tally {
  return {
    heads: tally.heads + (side === "heads" ? 1 : 0),
    tails: tally.tails + (side === "tails" ? 1 : 0),
    recent: [side, ...tally.recent].slice(0, HISTORY_SIZE),
  };
}
