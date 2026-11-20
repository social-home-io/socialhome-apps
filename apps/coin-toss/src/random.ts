/**
 * The coin's randomness. Everything comes from `crypto.getRandomValues`
 * (never the predictable built-in PRNG), and both helpers take the source as an argument so
 * the tests can feed it fixed bytes.
 *
 * - `tossSide`: one random bit → heads or tails, exactly 50 / 50.
 * - `tossDuration`: a whole number of milliseconds in [2000, 4000], uniform:
 *   a 32-bit value is drawn and redrawn while it falls in the uneven tail
 *   above the largest multiple of the range (rejection sampling), so no
 *   duration is more likely than another.
 *
 * The result is decided before the coin leaves the hand; the animation only
 * lands on it.
 */

export type Side = "heads" | "tails";

/** Fills the array with random values, like `crypto.getRandomValues`. */
export type RandomSource = (array: Uint32Array<ArrayBuffer>) => unknown;

export const MIN_DURATION_MS = 2000;
export const MAX_DURATION_MS = 4000;

/** The browser's cryptographic random source. */
export const cryptoSource: RandomSource = (array) => crypto.getRandomValues(array);

function draw(source: RandomSource): number {
  const buf = new Uint32Array(1);
  source(buf);
  return buf[0]!;
}

/** A uniform whole number in [min, max] (inclusive). */
export function randomInt(min: number, max: number, source: RandomSource = cryptoSource): number {
  const range = max - min + 1;
  const limit = Math.floor(0x1_0000_0000 / range) * range; // values below this are unbiased
  for (;;) {
    const v = draw(source);
    if (v < limit) return min + (v % range);
  }
}

/** Heads or tails, 50 / 50. */
export function tossSide(source: RandomSource = cryptoSource): Side {
  return (draw(source) & 1) === 0 ? "heads" : "tails";
}

/** How long the coin is in the air, in [2000, 4000] ms. */
export function tossDuration(source: RandomSource = cryptoSource): number {
  return randomInt(MIN_DURATION_MS, MAX_DURATION_MS, source);
}

/** One toss: the side and the time in the air, both decided up front. */
export function toss(source: RandomSource = cryptoSource): { side: Side; durationMs: number } {
  return { side: tossSide(source), durationMs: tossDuration(source) };
}
