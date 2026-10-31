import { describe, expect, it } from "vitest";
import { CHAIN_LENGTH, buildChain } from "./dice.js";
import {
  IllegalMove,
  MAX_AUTO_CHANGES,
  MAX_LOG,
  MAX_TURN,
  NO_DICE,
  actorOf,
  applyEntry,
  autoEntry,
  canDouble,
  canSwitchAuto,
  initialState,
  isAuto,
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
const NO_CUBE: Setup = { ...SETUP, cube: false };


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
    // Black may double before its first roll: White holds link 2 back.
    expect(after.phase).toBe("ask");
    expect(after.roll).toBeNull();
    expect(after.reveals).toEqual({ w: 1, b: 1 });
  });

  it("without the cube, the opening turn shows the next roller's link at once", () => {
    const dice = fixed({ w: 5, b: 3 }, { 2: [4, 2] });
    const after = applyEntry(initialState(NO_CUBE, dice), [8, 3, 6, 3], dice);
    expect(after.phase).toBe("play");
    expect(after.roll).toEqual([4, 2]);
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
    expect(moved.reveals).toEqual({ w: 1, b: 1 });
    expect(moved.mover).toBe("w");
    expect(moved.phase).toBe("ask");
  });

  it("knows nothing about the opening without both links", () => {
    const st = initialState(SETUP, NO_DICE);
    expect(st.opening).toBeNull();
    expect(reason(() => applyEntry(st, "open", NO_DICE))).toBe("dice");
    expect(reason(() => applyEntry(st, [8, 3, 6, 3], NO_DICE))).toBe("dice");
  });
});

describe("turns and links", () => {
  it("roll: the mover decides before its roll is known, the other app shows its link", () => {
    const dice = fixed({ w: 4, b: 1 }, { 2: [3, 1], 3: [6, 5] });
    let st = applyEntry(initialState(SETUP, dice), [24, 23, 13, 9], dice); // White, turn 1
    expect(st.phase).toBe("ask");
    expect(st.roll).toBeNull();
    expect(reason(() => applyEntry(st, [8, 5, 6, 5], dice))).toBe("phase");
    expect(reason(() => applyEntry(st, "show", dice))).toBe("phase");
    st = applyEntry(st, "roll", dice);
    expect(st.phase).toBe("dice");
    expect(st.toMove).toBe("w");
    expect(st.roll).toBeNull();
    expect(st.reveals).toEqual({ w: 1, b: 1 });
    expect(reason(() => applyEntry(st, "roll", dice))).toBe("phase");
    st = applyEntry(st, "show", dice);
    expect(st.phase).toBe("play");
    expect(st.toMove).toBe("b");
    expect(st.reveals).toEqual({ w: 2, b: 1 });
    expect(st.roll).toEqual([3, 1]);
    st = applyEntry(st, [8, 5, 6, 5], dice); // Black, turn 2
    expect(st.reveals).toEqual({ w: 2, b: 2 });
    expect(st.phase).toBe("ask");
  });

  it("double: nobody knows the roll until the taker shows its link", () => {
    const dice = fixed({ w: 4, b: 1 }, { 2: [3, 1], 3: [6, 5] });
    let st = applyEntry(initialState(SETUP, dice), [24, 23, 13, 9], dice);
    st = applyEntry(st, "double", dice); // Black doubles on turn 2
    expect(st.phase).toBe("cube");
    expect(st.toMove).toBe("w");
    expect(st.roll).toBeNull();
    expect(st.reveals).toEqual({ w: 1, b: 1 });
    st = applyEntry(st, "take", dice);
    expect(st.cube).toEqual({ value: 2, owner: "w" });
    expect(st.toMove).toBe("b");
    expect(st.reveals).toEqual({ w: 2, b: 1 });
    expect(st.roll).toEqual([3, 1]);
    // White owns the cube and may double on turn 3: Black holds link 3 back.
    st = applyEntry(st, [8, 5, 6, 5], dice);
    expect(st.reveals.b).toBe(2);
    expect(st.phase).toBe("ask");
    st = applyEntry(applyEntry(st, "roll", dice), "show", dice);
    expect(st.roll).toEqual([6, 5]);
    // Black can't double on turn 4 (White owns the cube): White shows link 4 with its turn.
    st = applyEntry(st, [24, 18, 18, 13], dice);
    expect(st.reveals.w).toBe(4);
    expect(st.phase).toBe("play");
    expect(st.roll).toEqual([1, 2]);
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
    let st = initialState(NO_CUBE, dice);
    st = { ...applyEntry(st, [24, 23, 13, 9], dice), board: shut };
    expect(mustPass(st)).toBe(true);
    expect(passReason(st)).toBe("bar");
    const passed = applyEntry(st, [], dice);
    expect(passed.mover).toBe("w");
    expect(passed.last?.steps).toEqual([]);
    // A pass when a move exists is refused.
    const open = applyEntry(initialState(NO_CUBE, dice), [24, 23, 13, 9], dice);
    expect(mustPass(open)).toBe(false);
    expect(reason(() => applyEntry(open, [], dice))).toBe("move");
    // Nothing to pass before the roll is known.
    const asked = applyEntry(initialState(SETUP, dice), [24, 23, 13, 9], dice);
    expect(mustPass({ ...asked, board: shut })).toBe(false);
  });

  it("counts turns played", () => {
    expect(turnsPlayed(["open", [1, 0], "double", "take", [], "roll", "show", [2, 1]])).toBe(3);
  });
});

describe("the doubling cube", () => {
  const dice = fixed({ w: 4, b: 1 });
  const afterOpening = () => applyEntry(initialState(SETUP, dice), [24, 23, 13, 9], dice);

  it("can't be offered on the opening turn, without the cube, or by the player who doesn't own it", () => {
    expect(canDouble(initialState(SETUP, dice))).toBe(false);
    expect(canDouble(afterOpening())).toBe(true);
    const noCube = applyEntry(initialState(NO_CUBE, dice), [24, 23, 13, 9], dice);
    expect(canDouble(noCube)).toBe(false);
    expect(reason(() => applyEntry(noCube, "double", dice))).toBe("cube");
    expect(reason(() => applyEntry(noCube, "roll", dice))).toBe("phase");
    // Black doubles, White takes and owns it: Black can't double again; White can on its turn.
    let st = applyEntry(applyEntry(afterOpening(), "double", dice), "take", dice);
    expect(canDouble(st)).toBe(false);
    st = applyEntry(st, [24, 23, 24, 22], dice);
    expect(st.mover).toBe("w");
    expect(canDouble(st)).toBe(true);
    st = applyEntry(applyEntry(st, "double", dice), "take", dice);
    expect(st.cube).toEqual({ value: 4, owner: "b" });
  });

  it("a drop loses the cube's value before the double, as a single game", () => {
    let st = applyEntry(applyEntry(afterOpening(), "double", dice), "take", dice); // 2, White owns
    st = applyEntry(st, [24, 23, 24, 22], dice);
    st = applyEntry(applyEntry(st, "double", dice), "drop", dice); // White redoubles to 4, Black drops
    expect(st.phase).toBe("over");
    expect(st.result).toEqual({ winner: "w", by: "drop", kind: "single", cube: 2, points: 2 });
  });

  it("take and drop only answer a double; only the other player answers", () => {
    const st = afterOpening();
    expect(reason(() => applyEntry(st, "take", dice))).toBe("phase");
    const offered = applyEntry(st, "double", dice);
    expect(offered.toMove).toBe("w");
    expect(reason(() => applyEntry(offered, "double", dice))).toBe("cube");
    expect(reason(() => applyEntry(offered, "show", dice))).toBe("phase");
    expect(reason(() => applyEntry(offered, [24, 23, 24, 22], dice))).toBe("phase");
  });

  it("stops at 64", () => {
    let st = afterOpening();
    for (let i = 0; i < 6; i++) {
      st = applyEntry(applyEntry(st, "double", dice), "take", dice);
      // The doubler plays its roll; then the new owner is to move.
      st = applyEntry(st, autoTurn(st), dice);
    }
    expect(st.cube.value).toBe(64);
    expect(canDouble(st)).toBe(false);
    // Nobody can double: every roll is shown with the turn before.
    expect(st.phase).toBe("play");
  });
});

describe("the end", () => {
  it("resigning loses what the board is worth now, times the cube: never saves a gammon", () => {
    const dice = fixed({ w: 4, b: 1 }, { 2: [6, 5] });
    const base = applyEntry(initialState(NO_CUBE, dice), [24, 23, 13, 9], dice);
    // At the start White's back checkers sit in Black's home board: a backgammon.
    const early = applyEntry(base, resignBy("w"), dice);
    expect(early.result).toEqual({ winner: "b", by: "resign", kind: "backgammon", cube: 1, points: 3 });
    expect(reason(() => applyEntry(early, [1, 0], dice))).toBe("over");
    // Nothing borne off, nothing back: a gammon.
    const home: Board = { w: new Array(26).fill(0), b: new Array(26).fill(0) };
    home.w[6] = 15;
    home.b[OFF] = 10;
    home.b[3] = 5;
    const g = applyEntry({ ...base, board: home, cube: { value: 2, owner: "w" } }, resignBy("w"), dice);
    expect(g.result).toEqual({ winner: "b", by: "resign", kind: "gammon", cube: 2, points: 4 });
    // One checker off: a single game.
    home.w[OFF] = 1;
    home.w[6] = 14;
    expect(applyEntry({ ...base, board: home }, resignBy("w"), dice).result).toMatchObject({ kind: "single", points: 1 });
  });

  it("time runs out only with a clock, and only for the player who has to act", () => {
    const dice = fixed({ w: 4, b: 1 });
    const st = initialState(SETUP, dice);
    expect(reason(() => applyEntry(st, timeoutOf("w"), dice))).toBe("bad-entry");
    const clocked = initialState({ ...SETUP, days: 2 }, dice);
    expect(reason(() => applyEntry(clocked, timeoutOf("b"), dice))).toBe("turn");
    expect(applyEntry(clocked, timeoutOf("w"), dice).result).toEqual({ winner: "b", by: "time", kind: "backgammon", cube: 1, points: 3 });
    // While the other app has to show its link, its time counts.
    const asked = applyEntry(applyEntry(applyEntry(clocked, [24, 23, 13, 9], dice), "roll", dice), timeoutOf("w"), dice);
    expect(asked.result?.winner).toBe("b");
  });

  it("bearing off the last checker wins: single, gammon or backgammon times the cube", () => {
    const dice = fixed({ w: 4, b: 1 }, { 2: [6, 5] });
    const base = applyEntry(initialState(NO_CUBE, dice), [24, 23, 13, 9], dice);
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
    expect(applyEntry(race(single), [2, 0, 1, 0], dice).result).toEqual({ winner: "b", by: "single", kind: "single", cube: 2, points: 2 });
    const gammon = new Array(26).fill(0);
    gammon[6] = 15;
    expect(applyEntry(race(gammon), [2, 0, 1, 0], dice).result).toMatchObject({ by: "gammon", points: 4 });
    const bg = new Array(26).fill(0);
    bg[6] = 14;
    bg[20] = 1; // White's 20 = Black's 5: in Black's home board
    expect(applyEntry(race(bg), [2, 0, 1, 0], dice).result).toMatchObject({ by: "backgammon", points: 6 });
    const barred = new Array(26).fill(0);
    barred[6] = 14;
    barred[BAR] = 1;
    const won = applyEntry(race(barred), [2, 0, 1, 0], dice);
    expect(won.result).toMatchObject({ by: "backgammon", points: 6 });
    // The winning turn shows only its own link: no roll comes after it.
    expect(won.reveals.b).toBe(2);
  });

  it("ends without a winner when the dice chains run out", () => {
    const dice = fixed({ w: 4, b: 1 });
    const st = { ...applyEntry(initialState(NO_CUBE, dice), [24, 23, 13, 9], dice), turn: MAX_TURN };
    const end = applyEntry(st, autoTurn(st), dice);
    expect(end.phase).toBe("over");
    expect(end.result).toEqual({ winner: null, by: "limit", kind: null, cube: 1, points: 0 });
    expect(end.reveals.b).toBe(MAX_TURN);
    expect(MAX_TURN + 1).toBeLessThanOrEqual(CHAIN_LENGTH);
  });

  it("refuses entries past the log limit (only resigning or the clock fit the last slot)", () => {
    const dice = fixed({ w: 4, b: 1 });
    const st = { ...initialState(SETUP, dice), n: MAX_LOG - 1 };
    expect(reason(() => applyEntry(st, [24, 23, 13, 9], dice))).toBe("too-long");
    expect(applyEntry(st, resignBy("w"), dice).phase).toBe("over");
    expect(reason(() => applyEntry({ ...st, n: MAX_LOG }, resignBy("w"), dice))).toBe("too-long");
  });
});

/** What one side can know: its whole chain, the other's links up to the newest it showed. */
function sideDice(sid: string, me: Color, st: GameState): DiceSource {
  const theirs = me === "w" ? B : W;
  const n = st.reveals[other(me)];
  return diceSource(sid, me, me === "w" ? W : B, n > 0 ? { n, link: theirs[n] } : null);
}

describe("a whole game with real dice", () => {
  for (const cube of [false, true]) {
    it(`plays to the end${cube ? " with doubles taken" : ""}; nobody ever knows a roll early`, () => {
      const setup: Setup = { ...SETUP, cube };
      for (const sid of ["g-1", "g-2", "g-3", "g-4"]) {
        const dice = allDice(sid);
        let st = initialState(setup, dice);
        const log: Entry[] = [];
        let guard = 0;
        let doubled = 0;
        while (st.phase !== "over" && guard++ < 3000) {
          let e: Entry;
          if (st.phase === "start") e = st.mover === "w" ? autoTurn(st) : "open";
          else if (st.phase === "ask") e = st.turn % 7 === 0 && st.cube.value < 8 ? "double" : "roll";
          else if (st.phase === "dice") e = "show";
          else if (st.phase === "cube") e = "take";
          else e = autoTurn(st);
          if (st.phase !== "start" && st.mover) {
            const roller = st.mover;
            const known = (who: Color) => sideDice(sid, who, st).roll(st.turn) !== null;
            if (st.phase === "ask" || st.phase === "cube" || st.phase === "dice") {
              // Deciding on the cube, or waiting for it: the roller can't know its roll yet.
              expect(known(roller)).toBe(false);
            }
            // The other player never knows the roller's roll before the roller's turn shows it
            // (the opening roll is the exception: both see it before anyone moves).
            if (st.turn > 1) expect(known(other(roller))).toBe(false);
            if (st.phase === "play") expect(known(roller)).toBe(true);
          }
          const turn = st.turn;
          const mover = st.mover;
          const before = st.phase;
          st = applyEntry(st, e, dice);
          log.push(e);
          if (e === "double") doubled++;
          if (Array.isArray(e) && mover && st.phase !== "over") {
            expect(st.reveals[mover]).toBe(st.phase === "ask" ? turn : turn + 1);
          }
          if (before === "start" && e === "open") expect(st.reveals.w).toBe(1);
        }
        expect(st.phase).toBe("over");
        if (cube) expect(doubled).toBeGreaterThan(0);
        const r = st.result!;
        expect(r.winner).not.toBeNull();
        expect(st.board[r.winner as Color][OFF]).toBe(CHECKERS);
        expect(st.board[other(r.winner as Color)][OFF]).toBeLessThan(CHECKERS);
        expect(r.points).toBe(r.cube * { single: 1, gammon: 2, backgammon: 3 }[r.kind!]);
        // The same log replays to the same end.
        expect(replay(setup, log, dice)!.state.result).toEqual(r);
      }
    });
  }
});

describe("rolling without being asked", () => {
  it("the roller says it on its own turn; from its next turn its roll comes with the other player's move", () => {
    const dice = fixed({ w: 4, b: 1 }, { 2: [3, 1], 3: [6, 5], 4: [2, 1] });
    // White (inviter) won the opening: Black's turn 2 asks first, as usual.
    let st = applyEntry(initialState(SETUP, dice), [24, 23, 13, 9], dice);
    expect(st.phase).toBe("ask");
    expect(canSwitchAuto(st, "b")).toBe(true);
    expect(canSwitchAuto(st, "w")).toBe(false);
    // Black gives up the cube now and rolls: the switch alone doesn't roll.
    st = applyEntry(st, autoEntry("b", true), dice);
    expect(st.autoRoll).toEqual({ w: false, b: true });
    expect(st.phase).toBe("ask");
    expect(canDouble(st)).toBe(false);
    expect(reason(() => applyEntry(st, "double", dice))).toBe("cube");
    // Once per turn, before anything else.
    expect(canSwitchAuto(st, "b")).toBe(false);
    expect(reason(() => applyEntry(st, autoEntry("b", false), dice))).toBe("phase");
    st = applyEntry(applyEntry(st, "roll", dice), "show", dice);
    st = applyEntry(st, [8, 5, 6, 5], dice); // Black, turn 2
    expect(st.phase).toBe("ask"); // White still decides on the cube blind
    st = applyEntry(applyEntry(st, "roll", dice), "show", dice);
    expect(st.reveals.b).toBe(3); // Black's "show" for White's roll
    st = applyEntry(st, autoTurn(st), dice); // White, turn 3
    // Black rolls without being asked: White showed link 4 with its turn.
    expect(st.reveals.w).toBe(4);
    expect(st.phase).toBe("play");
    expect(st.mover).toBe("b");
    expect(st.roll).toEqual([2, 1]);
  });

  it("taking it back applies from the turn after (never to a roll already known)", () => {
    const dice = fixed({ w: 4, b: 1 });
    let st = applyEntry(initialState(SETUP, dice), [24, 23, 13, 9], dice);
    st = applyEntry(applyEntry(applyEntry(st, autoEntry("b", true), dice), "roll", dice), "show", dice);
    st = applyEntry(st, autoTurn(st), dice); // Black 2
    st = applyEntry(applyEntry(st, "roll", dice), "show", dice);
    st = applyEntry(st, autoTurn(st), dice); // White 3: shows link 4 at once
    expect(st.phase).toBe("play");
    // Black knows its roll and switches back: it still can't double this turn.
    st = applyEntry(st, autoEntry("b", false), dice);
    expect(st.phase).toBe("play");
    expect(canDouble(st)).toBe(false);
    st = applyEntry(st, autoTurn(st), dice); // Black 4
    st = applyEntry(applyEntry(st, "roll", dice), "show", dice);
    st = applyEntry(st, autoTurn(st), dice); // White 5: holds link 6 back again
    expect(st.reveals.w).toBe(5);
    expect(st.phase).toBe("ask");
    expect(canDouble(st)).toBe(true);
  });

  it("only the player about to act, on its own turn, with the cube on, and only as a change", () => {
    const dice = fixed({ w: 4, b: 1 });
    const start = initialState(SETUP, dice);
    // Before the opening the inviter may say it.
    expect(canSwitchAuto(start, "w")).toBe(true);
    expect(applyEntry(start, autoEntry("w", true), dice).autoRoll.w).toBe(true);
    expect(reason(() => applyEntry(start, autoEntry("b", true), dice))).toBe("turn");
    expect(reason(() => applyEntry(start, autoEntry("w", false), dice))).toBe("bad-entry");
    expect(reason(() => applyEntry(initialState(NO_CUBE, dice), autoEntry("w", true), dice))).toBe("phase");
    // Not while showing a link or answering a double.
    let st = applyEntry(start, [24, 23, 13, 9], dice);
    st = applyEntry(st, "roll", dice);
    expect(st.phase).toBe("dice");
    expect(reason(() => applyEntry(st, autoEntry("w", true), dice))).toBe("phase");
    // At most MAX_AUTO_CHANGES switches each.
    const worn = { ...start, autoChanges: { w: MAX_AUTO_CHANGES, b: 0 } };
    expect(canSwitchAuto(worn, "w")).toBe(false);
    expect(isAuto(autoEntry("b", false))).toBe(true);
    expect(actorOf(start, "manual-b")).toBe("b");
  });

  for (const who of ["w", "b", "both"] as const) {
    it(`a whole game with ${who} rolling without being asked: nobody ever knows a roll early`, () => {
      for (const sid of ["a-1", "a-2", "a-3"]) {
        const dice = allDice(sid);
        let st = initialState(SETUP, dice);
        const auto = (c: Color) => who === "both" || who === c;
        let guard = 0;
        let asked = 0;
        let doubled = 0;
        while (st.phase !== "over" && guard++ < 4000) {
          const actor = st.toMove;
          if (auto(actor) && !st.autoRoll[actor] && canSwitchAuto(st, actor)) st = applyEntry(st, autoEntry(actor, true), dice);
          let e: Entry;
          if (st.phase === "start") e = st.mover === "w" ? autoTurn(st) : "open";
          else if (st.phase === "ask") e = st.turn % 5 === 0 && canDouble(st) && st.cube.value < 8 ? "double" : "roll";
          else if (st.phase === "dice") e = "show";
          else if (st.phase === "cube") e = "take";
          else e = autoTurn(st);
          if (st.phase === "ask" && st.mover && auto(st.mover)) asked++;
          if (st.phase !== "start" && st.mover && st.turn > 1) {
            const roller = st.mover;
            const known = (c: Color) => sideDice(sid, c, st).roll(st.turn) !== null;
            if (st.phase === "ask" || st.phase === "cube" || st.phase === "dice") expect(known(roller)).toBe(false);
            expect(known(other(roller))).toBe(false);
            if (st.phase === "play") expect(known(roller)).toBe(true);
          }
          if (e === "double") {
            doubled++;
            expect(auto(st.mover!)).toBe(false);
          }
          st = applyEntry(st, e, dice);
        }
        expect(st.phase).toBe("over");
        // An auto roller is asked at most once: the turn before its switch was in the log.
        expect(asked).toBeLessThanOrEqual(who === "both" ? 2 : 1);
        if (who !== "both") expect(doubled).toBeGreaterThan(0);
      }
    });
  }
});
