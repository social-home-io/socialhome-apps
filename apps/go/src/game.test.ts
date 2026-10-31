import { describe, expect, it } from "vitest";
import {
  IllegalMove,
  MAX_LOG,
  MAX_MARKS,
  actorOf,
  applyEntry,
  initialState,
  isValidMarking,
  passesTurn,
  replay,
  sameEntry,
  stonesPlayed,
  toggleChain,
  whyNot,
} from "./game.js";
import type { Entry, GameState } from "./game.js";
import { BLACK, EMPTY, WHITE, positionKey } from "./rules.js";

const at = (r: number, c: number): number => r * 9 + c;

function play(log: Entry[], size: 9 | 13 | 19 = 9): GameState {
  const r = replay(size, log);
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

/**
 * A ko on the top edge, Black to take:
 *   . B W .
 *   B W . W
 *   . B W .
 */
const KO_SETUP: Entry[] = [at(0, 1), at(0, 2), at(1, 0), at(1, 1), at(2, 1), at(1, 3), at(8, 8), at(2, 2)];

/** Walls on columns E (Black) and F (White), then White invades A9 and both pass. */
function wallsGame(): Entry[] {
  const log: Entry[] = [];
  for (let r = 0; r < 9; r++) log.push(at(r, 4), at(r, 5));
  log.push("pass", at(0, 0), "pass", "pass");
  return log;
}

describe("play", () => {
  it("starts empty with Black to move", () => {
    const s = initialState(9);
    expect(s.toMove).toBe("b");
    expect(s.board.every((v) => v === EMPTY)).toBe(true);
    expect(s.phase).toBe("play");
  });

  it("alternates and counts captures for the capturer", () => {
    const s = play([at(0, 1), at(0, 0), at(1, 0)]);
    expect(s.board[at(0, 0)]).toBe(EMPTY);
    expect(s.captures).toEqual({ b: 1, w: 0 });
    expect(s.lastMove).toBe(at(1, 0));
    expect(s.lastCaptured).toEqual([at(0, 0)]);
    expect(s.toMove).toBe("w");
  });

  it("captures a multi-stone chain", () => {
    // White A9 B9, Black A8 B8 then C9.
    const s = play([at(1, 0), at(0, 0), at(1, 1), at(0, 1), at(0, 2)]);
    expect(s.board[at(0, 0)]).toBe(EMPTY);
    expect(s.board[at(0, 1)]).toBe(EMPTY);
    expect(s.captures.b).toBe(2);
  });

  it("refuses an occupied point and suicide", () => {
    const s = play([at(0, 1), at(4, 4), at(1, 0)]);
    expect(reason(() => applyEntry(s, at(0, 1)))).toBe("occupied");
    expect(reason(() => applyEntry(s, at(0, 0)))).toBe("suicide");
    expect(whyNot(s, at(0, 0))).toBe("suicide");
    expect(whyNot(s, at(5, 5))).toBeNull();
  });

  it("refuses the immediate ko retake, allows it after a move elsewhere", () => {
    const take = play([...KO_SETUP, at(1, 2)]);
    expect(take.board[at(1, 1)]).toBe(EMPTY);
    expect(take.captures.b).toBe(1);
    expect(reason(() => applyEntry(take, at(1, 1)))).toBe("ko");
    // White plays elsewhere, Black answers, then White may take back.
    const later = play([...KO_SETUP, at(1, 2), at(8, 0), at(7, 8), at(1, 1)]);
    expect(later.board[at(1, 2)]).toBe(EMPTY);
    expect(later.board[at(1, 1)]).toBe(WHITE);
  });

  it("refuses any earlier whole-board position (positional superko), not just the last one", () => {
    const s = play([at(0, 1), at(4, 4), at(1, 0)]);
    // Pretend the position after a white stone on J1 happened long ago.
    const future = applyEntry(s, at(8, 8));
    const s2: GameState = { ...s, seen: new Set([...s.seen, positionKey(future.board)]) };
    expect(reason(() => applyEntry(s2, at(8, 8)))).toBe("ko");
    expect(reason(() => applyEntry(s, at(8, 8)))).toBeNull();
  });

  it("refuses a point off the board and moves in the wrong phase", () => {
    expect(reason(() => applyEntry(initialState(9), 81))).toBe("bad-entry");
    expect(reason(() => applyEntry(initialState(9), "resume"))).toBe("phase");
    expect(reason(() => applyEntry(initialState(9), [1]))).toBe("phase");
  });

  it("two passes in a row end play; a stone in between resets the count", () => {
    expect(play(["pass", at(4, 4), "pass"]).phase).toBe("play");
    const s = play([at(4, 4), "pass", "pass"]);
    expect(s.phase).toBe("counting");
    // White passed first: White marks first.
    expect(s.toMove).toBe("w");
    expect(reason(() => applyEntry(s, at(0, 0)))).toBe("phase");
    expect(reason(() => applyEntry(s, "pass"))).toBe("phase");
  });

  it("names who made an entry", () => {
    const s = initialState(9);
    expect(actorOf(s, at(1, 1))).toBe("b");
    expect(actorOf(s, "resign-w")).toBe("w");
    expect(actorOf(play([at(1, 1)]), "pass")).toBe("w");
  });
});

describe("counting", () => {
  it("the same marking straight back ends the game with the area score", () => {
    const counting = play(wallsGame());
    expect(counting.phase).toBe("counting");
    expect(counting.toMove).toBe("b"); // Black passed first
    const proposed = applyEntry(counting, [at(0, 0)]);
    expect(proposed.phase).toBe("counting");
    expect(proposed.toMove).toBe("w");
    expect(proposed.proposal).toEqual({ by: "b", dead: [at(0, 0)] });
    const done = applyEntry(proposed, [at(0, 0)]);
    expect(done.phase).toBe("over");
    expect(done.result).toMatchObject({ winner: "b", by: "score", margin: 1.5, dead: [at(0, 0)] });
    if (done.result?.by === "score") {
      expect(done.result.score.b).toEqual({ stones: 9, territory: 36, komi: 0, total: 45 });
      expect(done.result.score.w).toEqual({ stones: 10 - 1, territory: 27, komi: 7.5, total: 43.5 });
    }
    expect(reason(() => applyEntry(done, "pass"))).toBe("over");
  });

  it("a different marking goes back to the other player; resume returns to play", () => {
    const counting = play(wallsGame());
    const b = applyEntry(counting, [at(0, 0)]);
    const w = applyEntry(b, []); // White says the stone lives
    expect(w.phase).toBe("counting");
    expect(w.toMove).toBe("b");
    expect(w.proposal).toEqual({ by: "w", dead: [] });
    const resumed = applyEntry(w, "resume");
    expect(resumed.phase).toBe("play");
    expect(resumed.toMove).toBe("w"); // the other player moves next
    expect(resumed.passes).toBe(0);
    expect(resumed.proposal).toBeNull();
    // Black captures the invader after White's move: play really continues.
    const captured = applyEntry(applyEntry(applyEntry(resumed, at(8, 8)), at(0, 1)), at(7, 7));
    const afterCap = applyEntry(captured, at(1, 0));
    expect(afterCap.board[at(0, 0)]).toBe(EMPTY);
  });

  it("agreeing with your own marking isn't an agreement", () => {
    const counting = play(wallsGame());
    const b = applyEntry(counting, [at(0, 0)]);
    const w = applyEntry(b, [at(0, 0), at(0, 5), at(1, 5), at(2, 5), at(3, 5), at(4, 5), at(5, 5), at(6, 5), at(7, 5), at(8, 5)]);
    expect(w.phase).toBe("counting");
    const b2 = applyEntry(w, [at(0, 0)]);
    expect(b2.phase).toBe("counting");
    expect(applyEntry(b2, [at(0, 0)]).phase).toBe("over");
  });

  it("checks markings: stones only, sorted, whole chains", () => {
    const counting = play(wallsGame());
    expect(isValidMarking(counting, [at(0, 0)])).toBe(true);
    expect(isValidMarking(counting, [])).toBe(true);
    expect(isValidMarking(counting, [at(0, 1)])).toBe(false); // empty point
    expect(isValidMarking(counting, [at(0, 4)])).toBe(false); // part of the wall only
    expect(isValidMarking(counting, [at(8, 4), at(0, 4)])).toBe(false); // unsorted
    expect(reason(() => applyEntry(counting, [at(0, 1)]))).toBe("mark");
  });

  it("toggles whole chains in and out of a marking", () => {
    const counting = play(wallsGame());
    const wall = Array.from({ length: 9 }, (_, r) => at(r, 4));
    expect(toggleChain(counting, [], at(3, 4))).toEqual(wall);
    expect(toggleChain(counting, wall, at(5, 4))).toEqual([]);
    expect(toggleChain(counting, [at(0, 0)], at(4, 0))).toEqual([at(0, 0)]); // empty point: no change
  });

  it("bounds the counting rounds", () => {
    let s = play(wallsGame());
    for (let i = 0; i < MAX_MARKS; i++) s = applyEntry(s, i % 2 === 0 ? [at(0, 0)] : []);
    expect(reason(() => applyEntry(s, [at(0, 0)]))).toBe("too-long");
    expect(applyEntry(s, "resume").phase).toBe("play");
  });
});

describe("resign and bounds", () => {
  it("either player resigns at any time before the end", () => {
    const s = play([at(4, 4)]);
    expect(applyEntry(s, "resign-b").result).toEqual({ winner: "w", by: "resign" });
    expect(applyEntry(s, "resign-w").result).toEqual({ winner: "b", by: "resign" });
    const counting = play(wallsGame());
    expect(applyEntry(counting, "resign-w").phase).toBe("over");
    expect(reason(() => applyEntry(applyEntry(s, "resign-b"), "resign-w"))).toBe("over");
  });

  it("keeps the last log slot for a resignation", () => {
    const s: GameState = { ...initialState(9), n: MAX_LOG - 1 };
    expect(reason(() => applyEntry(s, at(4, 4)))).toBe("too-long");
    expect(reason(() => applyEntry(s, "pass"))).toBe("too-long");
    expect(applyEntry(s, "resign-b").phase).toBe("over");
    expect(reason(() => applyEntry({ ...s, n: MAX_LOG }, "resign-b"))).toBe("too-long");
  });

  it("a log that doesn't replay is null", () => {
    expect(replay(9, [at(0, 0), at(0, 0)])).toBeNull();
    expect(replay(9, [at(4, 4)])?.actors).toEqual(["b"]);
  });
});

describe("helpers", () => {
  it("compares entries, counts stones, says whose turn it passes", () => {
    expect(sameEntry([1, 2], [1, 2])).toBe(true);
    expect(sameEntry([1, 2], [1, 3])).toBe(false);
    expect(sameEntry(3, [3])).toBe(false);
    expect(sameEntry("pass", "pass")).toBe(true);
    expect(stonesPlayed([1, "pass", 2, [1]])).toBe(2);
    const s = play([at(4, 4)]);
    expect(passesTurn(s, "b")).toBe(true);
    expect(passesTurn(s, "w")).toBe(false);
    expect(passesTurn(applyEntry(s, "resign-w"), "w")).toBe(false);
    expect(s.board[at(4, 4)]).toBe(BLACK);
  });
});
