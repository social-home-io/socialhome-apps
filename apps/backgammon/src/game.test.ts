import { describe, expect, it } from "vitest";
import { buildChain } from "./dice.js";
import {
  IllegalMove,
  MAX_TURN,
  NO_DICE,
  applyEntry,
  canDouble,
  initialState,
  mustPass,
  passReason,
  replay,
  resignBy,
  timeoutOf,
  turnsPlayed,
} from "./game.js";
import type { DiceSource, Entry, GameState, Setup } from "./game.js";
import { diceSource } from "./inbound.js";
import { CHECKERS, OFF, BAR, other, startBoard } from "./rules.js";
import type { Board, Color } from "./rules.js";
import { autoTurn, seedOf } from "./testkit.js";

const W = buildChain(seedOf(1));
const B = buildChain(seedOf(2));

/** A source that knows both chains whole (a referee's view). */
function allDice(sid = "g-1"): DiceSource {
  return diceSource(sid, "w", W, { n: B.length - 1, link: B[B.length - 1] });
}

/** A source with fixed rolls: the opening and then turn by turn. */
function fixed(opening: { w: number; b: number }, rolls: Record<number, [number, number]> = {}): DiceSource {
  return {
    opening: () => ({ ...opening, ties: [], starter: opening.w > opening.b ? "w" : "b" }),
    roll: (t) => rolls[t] ?? [1, 2],
  };
}

const SETUP: Setup = { inviter: "w", cube: true, days: 0 };

function play(setup: Setup, log: Entry[], dice: DiceSource): GameState {
  const r = replay(setup, log, dice);
  if (!r) throw new Error("log doesn't replay");
  return r.state;
}

function reason(fn: () => unknown): string | null {
  try {
    fn();
    return null;
  } catch (err) {
    return err instanceof IllegalMove ? err.reason : "other";
  }
}

describe("the start", () => {
  it("waits for the inviter: it plays the opening roll or shows its link for it", () => {
    const st = initialState(SETUP, fixed({ w: 5, b: 3 }));
    expect(st.phase).toBe("start");
    expect(st.toMove).toBe("w");
    expect(st.mover).toBe("w");
    expect(st.roll).toEqual([5, 3]);
    expect(st.reveals).toEqual({ w: 0, b: 1 });
    // The inviter won: it plays; "open" is not for it.
    expect(reason(() => applyEntry(st, "open", fixed({ w: 5, b: 3 })))).toBe("phase");
    const after = applyEntry(st, [8, 3, 6, 3], fixed({ w: 5, b: 3 }));
    expect(after.turn).toBe(2);
    expect(after.mover).toBe("b");
    expect(after.reveals).toEqual({ w: 2, b: 1 });
  });

  it("lets the invitee play the opening when it won, after the inviter's link", () => {
    const dice = fixed({ w: 2, b: 6 });
    const st = initialState(SETUP, dice);
    expect(st.mover).toBeNull();
    expect(reason(() => applyEntry(st, [13, 11, 24, 18], dice))).toBe("phase");
    const opened = applyEntry(st, "open", dice);
    expect(opened.phase).toBe("play");
    expect(opened.mover).toBe("b");
    expect(opened.toMove).toBe("b");
    expect(opened.roll).toEqual([2, 6]);
    expect(opened.reveals).toEqual({ w: 1, b: 1 });
    const moved = applyEntry(opened, [13, 7, 13, 11], dice);
    expect(moved.reveals).toEqual({ w: 1, b: 2 });
    expect(moved.mover).toBe("w");
  });

  it("knows nothing about the opening without both links", () => {
    const st = initialState(SETUP, NO_DICE);
    expect(st.opening).toBeNull();
    expect(reason(() => applyEntry(st, "open", NO_DICE))).toBe("dice");
    expect(reason(() => applyEntry(st, [8, 3, 6, 3], NO_DICE))).toBe("dice");
  });
});

describe("turns and links", () => {
  it("each finished turn t shows link t + 1; a double on turn t shows link t", () => {
    const dice = fixed({ w: 4, b: 1 }, { 2: [3, 1], 3: [6, 5] });
    let st = initialState(SETUP, dice);
    st = applyEntry(st, [24, 23, 13, 9], dice); // White, turn 1
    expect(st.reveals.w).toBe(2);
    st = applyEntry(st, "double", dice); // Black doubles on turn 2
    expect(st.phase).toBe("cube");
    expect(st.toMove).toBe("w");
    expect(st.reveals.b).toBe(2);
    expect(st.roll).toEqual([3, 1]);
    st = applyEntry(st, "take", dice);
    expect(st.cube).toEqual({ value: 2, owner: "w" });
    expect(st.toMove).toBe("b");
    st = applyEntry(st, [8, 5, 6, 5], dice); // Black plays the 3-1
    expect(st.reveals.b).toBe(3);
    expect(st.turn).toBe(3);
    expect(st.mover).toBe("w");
  });

  it("refuses a turn that doesn't fit the roll", () => {
    const dice = fixed({ w: 4, b: 1 });
    const st = initialState(SETUP, dice);
    expect(reason(() => applyEntry(st, [24, 18, 13, 12], dice))).toBe("move");
    expect(reason(() => applyEntry(st, [24, 20], dice))).toBe("move");
    expect(reason(() => applyEntry(st, [24, 20, 13], dice))).toBe("bad-entry");
  });

  it("passes with [] only when nothing can be played, and says why", () => {
    // Black on the bar, White holds Black's whole entry (White's 1 … 6 = Black's 19 … 24).
    const shut: Board = { w: [3, 2, 2, 2, 2, 2, 2, ...new Array(19).fill(0)], b: startBoard().b };
    shut.b[24] = 1;
    shut.b[BAR] = 1;
    const dice = fixed({ w: 4, b: 1 }, { 2: [6, 6] });
    let st = initialState(SETUP, dice);
    st = { ...applyEntry(st, [24, 23, 13, 9], dice), board: shut };
    expect(mustPass(st)).toBe(true);
    expect(passReason(st)).toBe("bar");
    const passed = applyEntry(st, [], dice);
    expect(passed.mover).toBe("w");
    expect(passed.last?.steps).toEqual([]);
    // A pass when a move exists is refused.
    const open = applyEntry(initialState(SETUP, dice), [24, 23, 13, 9], dice);
    expect(mustPass(open)).toBe(false);
    expect(reason(() => applyEntry(open, [], dice))).toBe("move");
  });

  it("counts turns played", () => {
    expect(turnsPlayed(["open", [1, 0], "double", "take", []])).toBe(2);
  });
});

describe("the doubling cube", () => {
  const dice = fixed({ w: 4, b: 1 });
  const afterOpening = () => applyEntry(initialState(SETUP, dice), [24, 23, 13, 9], dice);

  it("can't be offered on the opening turn, without the cube, or by the player who doesn't own it", () => {
    expect(canDouble(initialState(SETUP, dice))).toBe(false);
    expect(canDouble(afterOpening())).toBe(true);
    const noCube = applyEntry(initialState({ ...SETUP, cube: false }, dice), [24, 23, 13, 9], dice);
    expect(canDouble(noCube)).toBe(false);
    expect(reason(() => applyEntry(noCube, "double", dice))).toBe("cube");
    // Black doubles, White takes and owns it: Black can't double again; White can on its turn.
    let st = applyEntry(applyEntry(afterOpening(), "double", dice), "take", dice);
    expect(canDouble(st)).toBe(false);
    st = applyEntry(st, [24, 23, 24, 22], dice);
    expect(st.mover).toBe("w");
    expect(canDouble(st)).toBe(true);
    st = applyEntry(applyEntry(st, "double", dice), "take", dice);
    expect(st.cube).toEqual({ value: 4, owner: "b" });
  });

  it("a drop loses the cube's value before the double", () => {
    let st = applyEntry(applyEntry(afterOpening(), "double", dice), "take", dice); // 2, White owns
    st = applyEntry(st, [24, 23, 24, 22], dice);
    st = applyEntry(applyEntry(st, "double", dice), "drop", dice); // White redoubles to 4, Black drops
    expect(st.phase).toBe("over");
    expect(st.result).toEqual({ winner: "w", by: "drop", cube: 2, points: 2 });
  });

  it("take and drop only answer a double; only the other player answers", () => {
    const st = afterOpening();
    expect(reason(() => applyEntry(st, "take", dice))).toBe("phase");
    const offered = applyEntry(st, "double", dice);
    expect(offered.toMove).toBe("w");
    expect(reason(() => applyEntry(offered, "double", dice))).toBe("cube");
    expect(reason(() => applyEntry(offered, [24, 23, 24, 22], dice))).toBe("phase");
  });

  it("stops at 64", () => {
    let st = afterOpening();
    for (let i = 0; i < 6; i++) {
      st = applyEntry(applyEntry(st, "double", dice), "take", dice);
      // The other player plays the roll they were offered with, then the owner is to move.
      st = applyEntry(st, autoTurn(st), dice);
    }
    expect(st.cube.value).toBe(64);
    expect(canDouble(st)).toBe(false);
  });
});

describe("the end", () => {
  it("resigning loses the cube's value", () => {
    const dice = fixed({ w: 4, b: 1 });
    const st = applyEntry(applyEntry(initialState(SETUP, dice), [24, 23, 13, 9], dice), resignBy("w"), dice);
    expect(st.result).toEqual({ winner: "b", by: "resign", cube: 1, points: 1 });
    expect(reason(() => applyEntry(st, [1, 0], dice))).toBe("over");
  });

  it("time runs out only with a clock, and only for the player who has to act", () => {
    const dice = fixed({ w: 4, b: 1 });
    const st = initialState(SETUP, dice);
    expect(reason(() => applyEntry(st, timeoutOf("w"), dice))).toBe("bad-entry");
    const clocked = initialState({ ...SETUP, days: 2 }, dice);
    expect(reason(() => applyEntry(clocked, timeoutOf("b"), dice))).toBe("turn");
    expect(applyEntry(clocked, timeoutOf("w"), dice).result).toEqual({ winner: "b", by: "time", cube: 1, points: 1 });
  });

  it("bearing off the last checker wins: single, gammon or backgammon times the cube", () => {
    const dice = fixed({ w: 4, b: 1 }, { 2: [6, 5] });
    const base = applyEntry(initialState(SETUP, dice), [24, 23, 13, 9], dice);
    const race = (loser: number[]): GameState => {
      const board: Board = { w: [...loser], b: new Array(26).fill(0) };
      board.b[OFF] = 13;
      board.b[1] = 1;
      board.b[2] = 1;
      return { ...base, board, cube: { value: 2, owner: "w" } };
    };
    const single = new Array(26).fill(0);
    single[OFF] = 1;
    single[6] = 14;
    expect(applyEntry(race(single), [2, 0, 1, 0], dice).result).toEqual({ winner: "b", by: "single", cube: 2, points: 2 });
    const gammon = new Array(26).fill(0);
    gammon[6] = 15;
    expect(applyEntry(race(gammon), [2, 0, 1, 0], dice).result).toMatchObject({ by: "gammon", points: 4 });
    const bg = new Array(26).fill(0);
    bg[6] = 14;
    bg[20] = 1; // White's 20 = Black's 5: in Black's home board
    expect(applyEntry(race(bg), [2, 0, 1, 0], dice).result).toMatchObject({ by: "backgammon", points: 6 });
  });

  it("ends in a draw when the dice chains run out", () => {
    const dice = fixed({ w: 4, b: 1 });
    const st = { ...applyEntry(initialState(SETUP, dice), [24, 23, 13, 9], dice), turn: MAX_TURN };
    const end = applyEntry(st, autoTurn(st), dice);
    expect(end.phase).toBe("over");
    expect(end.result).toEqual({ winner: null, by: "limit", cube: 1, points: 0 });
    expect(end.reveals.b).toBe(MAX_TURN + 1);
  });
});

describe("a whole game with real dice", () => {
  it("plays to the end, 15 off for the winner, every turn showing the right link", () => {
    for (const sid of ["g-1", "g-2", "g-3"]) {
      const dice = allDice(sid);
      let st = initialState(SETUP, dice);
      const log: Entry[] = [];
      let guard = 0;
      while (st.phase !== "over" && guard++ < 2000) {
        const e: Entry = st.phase === "start" && st.mover !== "w" ? "open" : autoTurn(st);
        const turn = st.turn;
        const mover = st.mover;
        st = applyEntry(st, e, dice);
        log.push(e);
        if (Array.isArray(e) && mover) expect(st.reveals[mover]).toBe(turn + 1);
      }
      expect(st.phase).toBe("over");
      const r = st.result!;
      expect(r.winner).not.toBeNull();
      expect(st.board[r.winner as Color][OFF]).toBe(CHECKERS);
      expect(st.board[other(r.winner as Color)][OFF]).toBeLessThan(CHECKERS);
      // The same log replays to the same end.
      expect(replay(SETUP, log, dice)!.state.result).toEqual(r);
    }
  });
});
