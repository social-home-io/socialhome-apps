import { describe, expect, it } from "vitest";
import {
  BAR,
  OFF,
  allHome,
  checkTurn,
  checkerTotal,
  diceToPlay,
  maxPlayable,
  nextSteps,
  pipCount,
  startBoard,
  stepsFor,
  targetsFrom,
  turnNeed,
  winKind,
  flatten,
  pairsOf,
} from "./rules.js";
import type { Board, Side } from "./rules.js";

/** A side from {point: count} in its own numbering; the rest (to 15) borne off unless `fill` is false. */
function side(spec: Record<number, number>, fill = true): Side {
  const s = new Array<number>(26).fill(0);
  let n = 0;
  for (const [p, c] of Object.entries(spec)) {
    s[Number(p)] = c;
    n += c;
  }
  if (fill) s[OFF] += 15 - n;
  return s;
}

function board(w: Record<number, number>, b: Record<number, number>): Board {
  return { w: side(w), b: side(b) };
}

const pairs = (...flat: number[]) => pairsOf(flat);

describe("the start", () => {
  it("has 15 checkers each, 167 pips each", () => {
    const b = startBoard();
    expect(checkerTotal(b.w)).toBe(15);
    expect(checkerTotal(b.b)).toBe(15);
    expect(pipCount(b.w)).toBe(167);
    expect(pipCount(b.b)).toBe(167);
  });

  it("plays the classic 3-1 opening (8/5 6/5) and refuses a step onto a blocked point", () => {
    const b = startBoard();
    const r = checkTurn(b, "w", [3, 1], pairs(8, 5, 6, 5));
    expect(r.ok).toBe(true);
    // White 6 → 1 with a 5? Black's 24 is White's 1: two black checkers sit there.
    expect(stepsFor(b, "w", 5).some((s) => s.from === 6)).toBe(false);
    // 13 → 8 with a 5 is fine (own point).
    expect(stepsFor(b, "w", 5).some((s) => s.from === 13 && s.to === 8)).toBe(true);
  });

  it("plays doubles four times", () => {
    expect(diceToPlay([4, 4])).toEqual([4, 4, 4, 4]);
    const r = checkTurn(startBoard(), "w", [4, 4], pairs(24, 20, 24, 20, 13, 9, 13, 9));
    expect(r.ok).toBe(true);
    // Three steps of a double that can play four are too few.
    expect(checkTurn(startBoard(), "w", [4, 4], pairs(24, 20, 24, 20, 13, 9))).toEqual({ ok: false, error: "too-few" });
  });

  it("refuses a step with a number that wasn't rolled", () => {
    expect(checkTurn(startBoard(), "w", [3, 1], pairs(13, 9, 6, 5)).ok).toBe(false);
  });

  it("takes the dice in either order", () => {
    expect(checkTurn(startBoard(), "w", [6, 1], pairs(8, 7, 13, 7)).ok).toBe(true);
    expect(checkTurn(startBoard(), "w", [6, 1], pairs(13, 7, 8, 7)).ok).toBe(true);
  });
});

describe("hitting and the bar", () => {
  it("hits a single checker: it goes to the bar", () => {
    // Black has one checker on its 20 = White's 5.
    const b = board({ 8: 2, 6: 13 }, { 20: 1, 1: 14 });
    const s = stepsFor(b, "w", 3).find((x) => x.from === 8 && x.to === 5)!;
    expect(s.hit).toBe(true);
    const r = checkTurn(b, "w", [3, 2], pairs(8, 5, 8, 6));
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.board.b[BAR]).toBe(1);
      expect(r.board.b[20]).toBe(0);
      expect(r.board.w[5]).toBe(1);
    }
  });

  it("must enter from the bar first, into the other side's home board", () => {
    const b = board({ [BAR]: 1, 13: 14 }, { 1: 15 });
    // Only bar steps are offered while a checker is on the bar.
    for (const d of [1, 2, 3, 4, 5, 6]) {
      for (const s of stepsFor(b, "w", d)) expect(s.from).toBe(BAR);
    }
    expect(stepsFor(b, "w", 3)[0]).toMatchObject({ from: BAR, to: 22 });
    expect(checkTurn(b, "w", [3, 5], pairs(13, 8, BAR, 22)).ok).toBe(false);
    expect(checkTurn(b, "w", [3, 5], pairs(BAR, 22, 13, 8)).ok).toBe(true);
  });

  it("can't enter onto a point the other side holds; fully blocked means no move at all", () => {
    // Black holds its 1 … 6 = White's 19 … 24 (two each, the rest home and borne off).
    const shut = board({ [BAR]: 1, 13: 14 }, { 1: 2, 2: 2, 3: 2, 4: 2, 5: 2, 6: 2 });
    expect(turnNeed(shut, "w", [6, 5]).count).toBe(0);
    expect(checkTurn(shut, "w", [6, 5], [])).toMatchObject({ ok: true });
    // One point open (White's 22 = Black's 3): enter with the 3, then the 6 may move on.
    const open = board({ [BAR]: 1, 13: 14 }, { 1: 2, 2: 2, 4: 2, 5: 2, 6: 2 });
    expect(stepsFor(open, "w", 3)).toEqual([{ from: BAR, to: 22, die: 3, hit: false }]);
    expect(stepsFor(open, "w", 6)).toEqual([]);
  });

  it("with two on the bar and one entry point, enters one and stops", () => {
    const b = board({ [BAR]: 2, 13: 13 }, { 1: 2, 2: 2, 4: 2, 5: 2, 6: 2 });
    expect(turnNeed(b, "w", [3, 6]).count).toBe(1);
    expect(checkTurn(b, "w", [3, 6], pairs(BAR, 22)).ok).toBe(true);
    expect(checkTurn(b, "w", [3, 6], pairs(BAR, 22, 13, 7)).ok).toBe(false);
  });
});

describe("bearing off", () => {
  it("only with every checker home", () => {
    expect(allHome(side({ 6: 5, 1: 2 }))).toBe(true);
    expect(allHome(side({ 7: 1, 1: 2 }))).toBe(false);
    const notHome = board({ 7: 1, 3: 2 }, { 24: 2 });
    expect(stepsFor(notHome, "w", 3).some((s) => s.to === OFF)).toBe(false);
  });

  it("with the exact number, or a higher one from the highest point only", () => {
    const b = board({ 5: 1, 3: 2 }, { 13: 2 });
    expect(stepsFor(b, "w", 5).filter((s) => s.to === OFF).map((s) => s.from)).toEqual([5]);
    // 6 is higher than every point: only the checker on 5 (the highest) may go off.
    expect(stepsFor(b, "w", 6).filter((s) => s.to === OFF).map((s) => s.from)).toEqual([5]);
    // 4: no checker on 4, a higher one (5) exists, so the 4 must move 5 → 1, not bear off from 3.
    expect(stepsFor(b, "w", 4)).toEqual([{ from: 5, to: 1, die: 4, hit: false }]);
  });

  it("bears off a whole double", () => {
    const b = board({ 2: 4 }, { 24: 2 });
    const r = checkTurn(b, "w", [5, 5], pairs(2, 0, 2, 0, 2, 0, 2, 0));
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.board.w[OFF]).toBe(15);
  });

  it("a checker that is hit on the way stops bearing off until it is home again", () => {
    const b = board({ [BAR]: 1, 2: 2 }, { 24: 2 });
    expect(stepsFor(b, "w", 2).every((s) => s.from === BAR)).toBe(true);
  });
});

describe("use as many dice as possible", () => {
  it("must play both when there is a way, even if one order blocks", () => {
    // White on 10 only (others off). Black holds White's 4 (its 21) and 8 (its 17).
    // 6-2: 10 → 4 is blocked, 10 → 8 is blocked → nothing can move. Check that it's 0.
    const blocked = board({ 10: 1 }, { 21: 2, 17: 2 });
    expect(turnNeed(blocked, "w", [6, 2]).count).toBe(0);
    // Black holds only White's 8: 10 → 4 (6) then 4 → 2 (2) uses both; 2 first is blocked.
    const b = board({ 10: 1, 20: 1 }, { 17: 2 });
    expect(maxPlayable(b, "w", [6, 2])).toBe(2);
    // Playing only the 6 with the 10 and stopping is too few.
    expect(checkTurn(b, "w", [6, 2], pairs(10, 4))).toEqual({ ok: false, error: "too-few" });
  });

  it("counts one die when every 2 is blocked before and after the 6", () => {
    // White: 13, 7, 3. Black holds White's 5, 1, 11 and 2 (its 20, 24, 14, 23).
    // 6: only 13 → 7. 2: 13 → 11, 7 → 5, 3 → 1 all blocked, before and after.
    const b = board({ 13: 1, 7: 1, 3: 1 }, { 20: 2, 24: 2, 14: 2, 23: 2 });
    const need = turnNeed(b, "w", [6, 2]);
    expect(need.count).toBe(1);
    expect(need.mustDie).toBe(6);
  });

  it("enforces the larger-die rule exactly", () => {
    // White: one checker on 7, everything else off; Black blocks White's 6 (its 19) and 1 (its 24).
    // 5-1: 7 → 2 (5) open, then 2 → 1 (1) blocked; 7 → 6 (1) blocked. Only one die: it must be the 5.
    const b = board({ 7: 1 }, { 19: 2, 24: 2 });
    const need = turnNeed(b, "w", [5, 1]);
    expect(need).toEqual({ count: 1, mustDie: 5 });
    expect(checkTurn(b, "w", [5, 1], pairs(7, 2)).ok).toBe(true);
    // 6-1: 7 → 1 (6) blocked, 7 → 6 (1) blocked → nothing.
    expect(turnNeed(b, "w", [6, 1]).count).toBe(0);
    // 4-3 with the checker on 8, Black on White's 1 and 5 (its 24 and 20) and 4 (its 21):
    // 8 → 4 (4) blocked; 8 → 5 (3) blocked → nothing.
    const c = board({ 8: 1 }, { 24: 2, 20: 2, 21: 2 });
    expect(turnNeed(c, "w", [4, 3]).count).toBe(0);
  });

  it("refuses the smaller die when only one die can be played and the larger can", () => {
    // White on 8 only; Black blocks White's 2 (its 23) and 4 (its 21) and 3 (its 22).
    // 6-1: 8 → 2 (6) blocked. 8 → 7 (1) open, then 7 → 1 (6) open → both. Not a one-die case.
    // 5-2: 8 → 3 (5) blocked; 8 → 6 (2) open, then 6 → 1 (5) open → both.
    // One-die case with both dice playable singly: White on 9; Black blocks 3 (22), 7 (18) … see below.
    // 6-2 from 9: 9 → 3 (6) open? make it open; then 3 → 1 (2) blocked. 9 → 7 (2) open, then 7 → 1 (6) blocked.
    const b = board({ 9: 1 }, { 24: 2 });
    // Black holds White's 1 (its 24): both orders end on 1 → each die alone only.
    const need = turnNeed(b, "w", [6, 2]);
    expect(need).toEqual({ count: 1, mustDie: 6 });
    expect(checkTurn(b, "w", [6, 2], pairs(9, 7))).toEqual({ ok: false, error: "wrong-die" });
    expect(checkTurn(b, "w", [6, 2], pairs(9, 3)).ok).toBe(true);
  });
});

describe("the turn in the UI", () => {
  it("offers only next steps that keep the turn whole", () => {
    const b = board({ 9: 1 }, { 24: 2 });
    const next = nextSteps(b, "w", [6, 2], []);
    expect(next.map((s) => [s.from, s.to, s.die])).toEqual([[9, 3, 6]]);
    expect(nextSteps(b, "w", [6, 2], next)).toEqual([]);
  });

  it("finds a target two dice away for one checker, with each stop legal", () => {
    const t = targetsFrom(startBoard(), "w", [6, 5], [], 24);
    // 24 → 18 (6) then → 13 (5), or 24 → 19 (5) then → 13 (6): 13 reachable.
    expect(t.has(13)).toBe(true);
    expect(t.get(13)!.length).toBe(2);
    expect(t.get(18)!.length).toBe(1);
    // A double can carry one checker four times.
    const d = targetsFrom(startBoard(), "w", [3, 3], [], 13);
    expect([...d.keys()].sort((a, b) => a - b)).toEqual([4, 7, 10]); // 13 → 1 lands on Black's two on its 24
  });

  it("flattens steps for the wire and back", () => {
    const steps = checkTurn(startBoard(), "w", [3, 1], pairs(8, 5, 6, 5));
    expect(steps.ok && flatten(steps.steps)).toEqual([8, 5, 6, 5]);
  });
});

describe("scoring", () => {
  it("is a single game when the loser has borne off one", () => {
    expect(winKind(board({}, { 6: 14 }), "w")).toBe("single");
  });

  it("is a gammon when the loser has borne off none", () => {
    expect(winKind({ w: side({}), b: side({ 6: 10, 12: 5 }, false) }, "w")).toBe("gammon");
  });

  it("is a backgammon with a loser's checker on the bar or in the winner's home board", () => {
    expect(winKind({ w: side({}), b: side({ 6: 14, 19: 1 }, false) }, "w")).toBe("backgammon");
    expect(winKind({ w: side({}), b: side({ 6: 14, [BAR]: 1 }, false) }, "w")).toBe("backgammon");
  });
});
