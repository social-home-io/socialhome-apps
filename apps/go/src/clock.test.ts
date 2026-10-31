import { describe, expect, it } from "vitest";
import { SKEW_MS, decideClaim, markFor, splitLeft, turnClock } from "./clock.js";
import type { ClockInput } from "./clock.js";
import { replay } from "./game.js";
import type { Entry } from "./game.js";
import { DAY_MS } from "./inbound.js";
import type { Color } from "./rules.js";

const at = (r: number, c: number): number => r * 9 + c;
const HOUR = 60 * 60 * 1000;
const T0 = Date.UTC(2026, 9, 31, 12, 0, 0);

function input(log: Entry[], myColor: Color, clockFrom: { n: number; at: number } | null, days = 2, over: Partial<ClockInput> = {}): ClockInput {
  return { state: replay(9, log, { handicap: 0, days })!.state, myColor, logLength: log.length, clockFrom, awaiting: false, ...over };
}

// Black moved, White moved: Black (us) to move.
const ours: Entry[] = [at(4, 4), at(2, 2)];

describe("the turn's clock", () => {
  it("counts our turn from when this side first had their move", () => {
    const c = turnClock(input(ours, "b", { n: 2, at: T0 }), T0 + 5 * HOUR)!;
    expect(c).toMatchObject({ who: "b", mine: true, deadline: T0 + 2 * DAY_MS, expired: false });
    expect(c.leftMs).toBe(2 * DAY_MS - 5 * HOUR);
  });

  it("counts their turn from our step, with a grace for delivery before we may claim", () => {
    const c = turnClock(input(ours, "w", { n: 2, at: T0 }), T0 + 2 * DAY_MS)!;
    expect(c.mine).toBe(false);
    expect(c.expired).toBe(false);
    expect(turnClock(input(ours, "w", { n: 2, at: T0 }), T0 + 2 * DAY_MS + SKEW_MS)!.expired).toBe(true);
  });

  it("no clock: no game clock, after the end, or while the invite is unanswered", () => {
    expect(turnClock(input(ours, "b", { n: 2, at: T0 }, 0), T0 + 100 * DAY_MS)).toBeNull();
    expect(turnClock(input([...ours, "resign-b"], "b", { n: 3, at: T0 }), T0 + 100 * DAY_MS)).toBeNull();
    expect(turnClock(input([], "w", { n: 0, at: T0 }, 2, { awaiting: true }), T0 + 100 * DAY_MS)).toBeNull();
  });

  it("a mark for another position starts the turn now (never earlier)", () => {
    const c = turnClock(input(ours, "b", { n: 1, at: T0 - 30 * DAY_MS }), T0)!;
    expect(c.leftMs).toBe(2 * DAY_MS);
    expect(turnClock(input(ours, "b", null), T0)!.leftMs).toBe(2 * DAY_MS);
  });

  it("a mark in this device's future (its clock went back) counts from now", () => {
    expect(turnClock(input(ours, "b", { n: 2, at: T0 + 10 * DAY_MS }), T0)!.deadline).toBe(T0 + 2 * DAY_MS);
  });

  it("waits at least as long as their Go said it still counts", () => {
    const hint = { n: 2, at: T0 + 3 * DAY_MS };
    const c = turnClock(input(ours, "w", { n: 2, at: T0 }, 2, { theirHint: hint }), T0 + 2 * DAY_MS + SKEW_MS)!;
    expect(c.expired).toBe(false);
    expect(c.deadline).toBe(T0 + 3 * DAY_MS);
    // A hint for an older position doesn't count.
    const old = turnClock(input(ours, "w", { n: 2, at: T0 }, 2, { theirHint: { n: 1, at: T0 + 9 * DAY_MS } }), T0 + 2 * DAY_MS + SKEW_MS)!;
    expect(old.expired).toBe(true);
  });
});

describe("deciding a claim on our time", () => {
  it("accepts when our own deadline has passed", () => {
    expect(decideClaim(input(ours, "b", { n: 2, at: T0 }), T0 + 2 * DAY_MS)).toEqual({ accept: true });
    expect(decideClaim(input(ours, "b", { n: 2, at: T0 }), T0 + 9 * DAY_MS)).toEqual({ accept: true });
  });

  it("refuses an early claim and says how long we still have", () => {
    expect(decideClaim(input(ours, "b", { n: 2, at: T0 }), T0 + 2 * DAY_MS - 1)).toEqual({ accept: false, leftMs: 1 });
    expect(decideClaim(input(ours, "b", { n: 2, at: T0 }), T0 + HOUR)).toEqual({ accept: false, leftMs: 2 * DAY_MS - HOUR });
  });

  it("refuses when the claimer's clock runs ahead of ours: only our clock counts", () => {
    // Their step reached us at T0. Their clock is 10 minutes ahead, so they claim
    // at what is T0 + 2 days - 10 min for us: refused, the game goes on.
    expect(decideClaim(input(ours, "b", { n: 2, at: T0 }), T0 + 2 * DAY_MS - 10 * 60 * 1000).accept).toBe(false);
  });

  it("counts from when OUR side saw their move, however long it waited in the mailbox", () => {
    // They moved days ago (maybe), we opened Go at T0: a claim right after is refused.
    expect(decideClaim(input(ours, "b", { n: 2, at: T0 }), T0 + 1000)).toEqual({ accept: false, leftMs: 2 * DAY_MS - 1000 });
  });

  it("a move after our time ran out but before any claim counts: the claim then meets their turn", () => {
    // We ran out, then moved anyway (log length 3, their turn now).
    const moved: Entry[] = [...ours, at(6, 6)];
    expect(decideClaim(input(moved, "b", { n: 3, at: T0 + 5 * DAY_MS }), T0 + 5 * DAY_MS + 1).accept).toBe(false);
  });

  it("refuses a claim when it is not our turn, without a clock, or with no record for this position", () => {
    expect(decideClaim(input(ours, "w", { n: 2, at: T0 }), T0 + 30 * DAY_MS)).toEqual({ accept: false, leftMs: 2 * DAY_MS });
    expect(decideClaim(input(ours, "b", { n: 2, at: T0 }, 0), T0 + 30 * DAY_MS).accept).toBe(false);
    expect(decideClaim(input(ours, "b", { n: 1, at: T0 - 30 * DAY_MS }), T0).accept).toBe(false);
  });
});

describe("helpers", () => {
  it("keeps the first mark for a position, starts a new one for the next", () => {
    expect(markFor({ n: 2, at: 5 }, 2, 99)).toEqual({ n: 2, at: 5 });
    expect(markFor({ n: 2, at: 5 }, 3, 99)).toEqual({ n: 3, at: 99 });
    expect(markFor(undefined, 0, 7)).toEqual({ n: 0, at: 7 });
  });

  it("splits time left into days, hours and minutes", () => {
    expect(splitLeft(2 * DAY_MS + 5 * HOUR + 59_999)).toEqual({ d: 2, h: 5, m: 0 });
    expect(splitLeft(3 * HOUR + 20 * 60_000)).toEqual({ d: 0, h: 3, m: 20 });
    expect(splitLeft(-5)).toEqual({ d: 0, h: 0, m: 0 });
  });
});
