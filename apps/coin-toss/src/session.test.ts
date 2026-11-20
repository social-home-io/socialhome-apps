import { describe, expect, it } from "vitest";
import { HISTORY_SIZE, emptyTally, record, restAngle, spinEndAngle } from "./session.js";

describe("spinEndAngle", () => {
  it("lands showing the decided side, from either side", () => {
    for (const from of ["heads", "tails"] as const) {
      for (const target of ["heads", "tails"] as const) {
        for (const ms of [2000, 2777, 3333, 4000]) {
          const end = spinEndAngle(from, target, ms);
          expect(((end % 360) + 360) % 360, `${from}→${target} ${ms}`).toBe(restAngle(target));
        }
      }
    }
  });

  it("spins at least two full turns, and more the longer it flies", () => {
    expect(spinEndAngle("heads", "heads", 2000) - restAngle("heads")).toBeGreaterThanOrEqual(720);
    expect(spinEndAngle("heads", "heads", 4000)).toBeGreaterThan(spinEndAngle("heads", "heads", 2000));
  });
});

describe("record", () => {
  it("counts each side and keeps the newest results first", () => {
    let t = emptyTally();
    t = record(t, "heads");
    t = record(t, "tails");
    t = record(t, "tails");
    expect(t).toEqual({ heads: 1, tails: 2, recent: ["tails", "tails", "heads"] });
  });

  it("keeps only the last few results but counts them all", () => {
    let t = emptyTally();
    for (let i = 0; i < HISTORY_SIZE + 5; i++) t = record(t, "heads");
    expect(t.recent).toHaveLength(HISTORY_SIZE);
    expect(t.heads).toBe(HISTORY_SIZE + 5);
  });
});
