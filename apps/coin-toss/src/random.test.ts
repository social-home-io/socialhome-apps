import { describe, expect, it } from "vitest";
import { MAX_DURATION_MS, MIN_DURATION_MS, randomInt, toss, tossDuration, tossSide } from "./random.js";
import type { RandomSource } from "./random.js";

/** A source that hands out *values* in order (then repeats the last). */
function fixed(...values: number[]): RandomSource {
  let i = 0;
  return (array) => {
    for (let j = 0; j < array.length; j++) array[j] = values[Math.min(i++, values.length - 1)]! >>> 0;
    return array;
  };
}

describe("tossSide", () => {
  it("reaches both outcomes: an even value is heads, an odd one tails", () => {
    expect(tossSide(fixed(0))).toBe("heads");
    expect(tossSide(fixed(1))).toBe("tails");
    expect(tossSide(fixed(0xffff_fffe))).toBe("heads");
    expect(tossSide(fixed(0xffff_ffff))).toBe("tails");
  });

  it("uses the browser's crypto by default and lands on both sides", () => {
    const seen = new Set<string>();
    for (let i = 0; i < 200; i++) seen.add(tossSide());
    expect([...seen].sort()).toEqual(["heads", "tails"]);
  });
});

describe("tossDuration", () => {
  it("stays within [2000, 4000] ms at the edges of the source", () => {
    expect(MIN_DURATION_MS).toBe(2000);
    expect(MAX_DURATION_MS).toBe(4000);
    expect(tossDuration(fixed(0))).toBe(2000);
    expect(tossDuration(fixed(2000))).toBe(4000);
    expect(tossDuration(fixed(2001))).toBe(2000);
  });

  it("redraws a value from the biased tail instead of folding it in", () => {
    const range = 2001;
    const limit = Math.floor(2 ** 32 / range) * range;
    // limit itself is rejected; the next draw (5) is used.
    expect(tossDuration(fixed(limit, 5))).toBe(2005);
    expect(tossDuration(fixed(0xffff_ffff, 7))).toBe(2007);
  });

  it("is a whole number within range for many crypto draws", () => {
    for (let i = 0; i < 2000; i++) {
      const d = tossDuration();
      expect(Number.isInteger(d)).toBe(true);
      expect(d).toBeGreaterThanOrEqual(2000);
      expect(d).toBeLessThanOrEqual(4000);
    }
  });
});

describe("randomInt", () => {
  it("covers every value of a small range evenly", () => {
    const counts = [0, 0, 0];
    let n = 0;
    const counter: RandomSource = (a) => { a[0] = n++; return a; };
    for (let i = 0; i < 300; i++) counts[randomInt(0, 2, counter)]!++;
    expect(counts).toEqual([100, 100, 100]);
  });
});

describe("toss", () => {
  it("decides the side and the duration up front", () => {
    expect(toss(fixed(1, 0))).toEqual({ side: "tails", durationMs: 2000 });
    expect(toss(fixed(0, 2000))).toEqual({ side: "heads", durationMs: 4000 });
  });
});
