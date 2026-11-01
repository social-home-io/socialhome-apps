import { describe, expect, it } from "vitest";
import {
  addPair,
  againLeft,
  canAddPair,
  canDrawAgain,
  chars,
  cleanLine,
  formatDay,
  isDay,
  isPastDay,
  keepSeated,
  maxPairs,
  pairsFit,
  removePair,
  todayIso,
  unpaired,
  wishLength,
} from "./rules.js";
import type { Pair } from "./rules.js";
import { status } from "./fixtures.js";

const seats = (n: number) => new Set(Array.from({ length: n }, (_, i) => i + 1));

describe("pairs", () => {
  it("allows none below 4 people, then one for every 3", () => {
    expect([3, 4, 5, 6, 9, 30].map(maxPairs)).toEqual([0, 1, 1, 2, 3, 10]);
  });

  it("fits only different seated people, nobody in two pairs, at most n/3", () => {
    expect(pairsFit([], seats(3))).toBe(true);
    expect(pairsFit([[1, 2]], seats(3))).toBe(false); // fewer than 4
    expect(pairsFit([[1, 2]], seats(4))).toBe(true);
    expect(pairsFit([[1, 2], [3, 4]], seats(5))).toBe(false); // > ⌊5/3⌋
    expect(pairsFit([[1, 2], [3, 4]], seats(6))).toBe(true);
    expect(pairsFit([[1, 2], [2, 3]], seats(9))).toBe(false); // overlap
    expect(pairsFit([[1, 1]], seats(9))).toBe(false);
    expect(pairsFit([[1, 12]], seats(9))).toBe(false); // not seated
  });

  it("adds a pair low seat first, refuses one that doesn't fit, removes by index", () => {
    expect(addPair([], 3, 1, seats(4))).toEqual([[1, 3]]);
    expect(addPair([[1, 3]], 2, 4, seats(4))).toBeNull();
    expect(addPair([[1, 3]], 3, 4, seats(9))).toBeNull();
    const two: Pair[] = [[1, 2], [3, 4]];
    expect(removePair(two, 0)).toEqual([[3, 4]]);
  });

  it("drops pairs of someone who left, lists who's free, says when another fits", () => {
    expect(keepSeated([[1, 2], [3, 4]], new Set([1, 2, 3]))).toEqual([[1, 2]]);
    expect(unpaired([[1, 3]], seats(5))).toEqual([2, 4, 5]);
    expect(canAddPair([], seats(4))).toBe(true);
    expect(canAddPair([[1, 2]], seats(5))).toBe(false);
    expect(canAddPair([], seats(3))).toBe(false);
  });
});

describe("text", () => {
  it("counts characters as people do", () => {
    expect(chars("🎁ab")).toBe(3);
    expect(wishLength("  socks\r\n  ")).toBe(5);
  });
  it("makes one trimmed line, cut to the limit", () => {
    expect(cleanLine("  a\nb  ", 80)).toBe("a b");
    expect(cleanLine("x".repeat(90), 80)).toHaveLength(80);
  });
});

describe("days", () => {
  it("knows real days", () => {
    expect(isDay("2026-12-24")).toBe(true);
    expect(isDay("2026-02-30")).toBe(false);
    expect(isDay("24.12.2026")).toBe(false);
  });
  it("today is the local date; a day before it is past, no day never is", () => {
    expect(todayIso(new Date(2026, 10, 1, 23, 30))).toBe("2026-11-01");
    expect(isPastDay("2026-10-31", "2026-11-01")).toBe(true);
    expect(isPastDay("2026-11-01", "2026-11-01")).toBe(false);
    expect(isPastDay(null, "2026-11-01")).toBe(false);
  });
  it("formats a day in the person's language", () => {
    expect(formatDay("2026-12-24", "en")).toMatch(/Dec/);
    expect(formatDay("2026-12-24", "de")).toBe("24.12.2026");
    expect(formatDay("nope", "en")).toBe("nope");
  });
});

describe("Draw again", () => {
  const ready = status({ state: "ready", hasResult: true });
  it("only the organiser, only when ready, before the day, fewer than 10 times", () => {
    expect(canDrawAgain(ready, "2026-11-01")).toBe(true);
    expect(canDrawAgain({ ...ready, isHost: false }, "2026-11-01")).toBe(false);
    expect(canDrawAgain({ ...ready, state: "drawing" }, "2026-11-01")).toBe(false);
    expect(canDrawAgain(ready, "2026-12-25")).toBe(false);
    expect(canDrawAgain({ ...ready, again: 10 }, "2026-11-01")).toBe(false);
    expect(canDrawAgain({ ...ready, settings: null }, "2027-01-01")).toBe(true);
  });
  it("counts what's left", () => {
    expect(againLeft({ ...ready, again: 3 })).toBe(7);
    expect(againLeft({ ...ready, again: 12 })).toBe(0);
  });
});
