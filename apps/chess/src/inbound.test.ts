import { describe, expect, it } from "vitest";
import { applyMove, initialState, parseSquare } from "./chess.js";
import type { GameState, Move } from "./chess.js";
import { catchUpFromOwnCopy, judgeInbound, routeInbound } from "./inbound.js";
import type { GameEntry } from "./lifecycle.js";

function m(from: string, to: string): Move {
  return { from: parseSquare(from), to: parseSquare(to) };
}

function stateAfter(...moves: Move[]): GameState {
  let s = initialState();
  for (const mv of moves) s = applyMove(s, mv);
  return s;
}

/** What a chess of any version sends: the move plus its whole game. */
function payload(state: GameState, move: Move | undefined = state.history[state.history.length - 1]) {
  return { type: "move", sessionId: "s1", move, state };
}

const E4 = m("e2", "e4");
const E5 = m("e7", "e5");
const NF3 = m("g1", "f3");
const NC6 = m("b8", "c6");

describe("an honest move from the other player", () => {
  it("applies one opponent move on top of our own copy", () => {
    // We are Black; White (the opponent) played e4.
    const v = judgeInbound(initialState(), "b", payload(stateAfter(E4)));
    expect(v.kind).toBe("apply");
    if (v.kind !== "apply") return;
    expect(v.state.history).toEqual([E4]);
    expect(v.state.sideToMove).toBe("b");
    expect(v.move).toEqual(E4);
  });

  it("builds the board itself — never from the sender's board", () => {
    const sent = stateAfter(E4);
    const forgedBoard = { ...sent, board: new Array(64).fill(null) };
    const v = judgeInbound(initialState(), "b", payload(forgedBoard, E4));
    expect(v.kind).toBe("apply");
    if (v.kind !== "apply") return;
    expect(v.state.board).toEqual(stateAfter(E4).board);
  });

  it("a promotion carries its piece, as every chess version sends it", () => {
    // White pawn walks to a7 and takes on b8 (promotes to a queen).
    const line = [
      m("a2", "a4"), m("h7", "h6"), m("a4", "a5"), m("h6", "h5"),
      m("a5", "a6"), m("h5", "h4"), m("a6", "b7"), m("h4", "h3"),
    ];
    const local = stateAfter(...line);
    const promo: Move = { from: parseSquare("b7"), to: parseSquare("a8"), promotion: "Q" };
    const v = judgeInbound(local, "b", payload(applyMove(local, promo)));
    expect(v.kind).toBe("apply");
    if (v.kind !== "apply") return;
    expect(v.state.board[parseSquare("a8")]).toEqual({ type: "Q", color: "w" });
  });

  it("a message with only a move (no game) still works", () => {
    const v = judgeInbound(initialState(), "b", { type: "move", move: E4 });
    expect(v.kind).toBe("apply");
  });

  it("a held message after missed moves of the opponent catches up by one move", () => {
    // Invitee (Black) opens chess late; White moved before the invite was played.
    const v = judgeInbound(initialState(), "b", payload(stateAfter(E4)));
    expect(v.kind).toBe("apply");
  });
});

describe("a copy we already have changes nothing", () => {
  it("the same move again is stale", () => {
    expect(judgeInbound(stateAfter(E4), "b", payload(stateAfter(E4))).kind).toBe("stale");
  });

  it("an older copy of the same game is stale (never rolls back)", () => {
    expect(judgeInbound(stateAfter(E4, E5, NF3), "w", payload(stateAfter(E4))).kind).toBe("stale");
  });
});

describe("forgeries are refused and our game is unchanged (#5 #6)", () => {
  it("an illegal move", () => {
    // Queen d1 → h5 through its own pawn.
    const local = initialState();
    const bad: GameState = { ...local, history: [m("d1", "h5")], sideToMove: "b" };
    const v = judgeInbound(local, "b", payload(bad));
    expect(v).toEqual({ kind: "refuse", reason: "illegal" });
  });

  it("r1's queen-and-rooks forgery: a0→h1 with a rewritten board and a claimed win", () => {
    const local = stateAfter(E4, E5);
    const board = local.board.slice();
    board[parseSquare("d1")] = null;
    board[parseSquare("a1")] = null;
    board[parseSquare("h1")] = null;
    const forged = {
      board,
      sideToMove: "w",
      history: [...local.history, { from: 0, to: 63 }],
      result: "black",
    };
    const v = judgeInbound(local, "w", { type: "move", sessionId: "s1", move: { from: 0, to: 63 }, state: forged });
    expect(v.kind).toBe("refuse");
  });

  it("a move of our own colour (the opponent moving our knight)", () => {
    // We are Black; after e4 e5 Nf3 it's... White just moved, so it's Black's
    // turn — ours. The opponent sends a Black move.
    const local = stateAfter(E4, E5, NF3);
    const v = judgeInbound(local, "b", payload(applyMove(local, NC6)));
    expect(v).toEqual({ kind: "refuse", reason: "wrong-colour" });
  });

  it("a rewritten history (one move longer, different past)", () => {
    const local = stateAfter(E4, E5);
    const other = stateAfter(m("d2", "d4"), E5, NF3);
    expect(judgeInbound(local, "w", payload(other))).toEqual({ kind: "refuse", reason: "rewrite" });
    expect(judgeInbound(stateAfter(E4, E5, NF3), "b", payload(other))).toEqual({ kind: "refuse", reason: "rewrite" });
  });

  it("a shorter copy with a different past is refused, not taken as stale", () => {
    const local = stateAfter(E4, E5, NF3);
    expect(judgeInbound(local, "b", payload(stateAfter(m("d2", "d4"))))).toEqual({ kind: "refuse", reason: "rewrite" });
  });

  it("a forged checkmate: the claimed result is ignored, the status is ours", () => {
    const local = stateAfter(E4);
    const sent = { ...stateAfter(E4, E5), result: "black" };
    const v = judgeInbound(local, "w", payload(sent as GameState));
    expect(v.kind).toBe("apply");
    if (v.kind !== "apply") return;
    expect(v.state.result).toBeNull();
  });

  it("a real checkmate is found locally (fool's mate)", () => {
    const local = stateAfter(m("f2", "f3"), E5, m("g2", "g4"));
    const mate = applyMove(local, m("d8", "h4"));
    const v = judgeInbound(local, "w", payload({ ...mate, result: null }));
    expect(v.kind).toBe("apply");
    if (v.kind !== "apply") return;
    expect(v.state.result).toBe("black");
  });

  it("no move after the game ended", () => {
    const local = applyMove(stateAfter(m("f2", "f3"), E5, m("g2", "g4")), m("d8", "h4"));
    const after = { ...local, history: [...local.history, m("a2", "a3")], result: null };
    const v = judgeInbound(local, "b", payload(after));
    expect(v.kind).toBe("refuse");
  });

  it("a resync that adds more than one move is refused (it would include ours)", () => {
    const v = judgeInbound(initialState(), "b", payload(stateAfter(E4, E5, NF3)));
    expect(v).toEqual({ kind: "refuse", reason: "too-many" });
  });

  it("a resync with an illegal step in its past is refused", () => {
    const local = stateAfter(E4);
    // Same first move, but a list that cannot have been played from the start.
    const forged = { ...stateAfter(E4), history: [E4, m("e7", "e4"), NF3] };
    expect(judgeInbound(local, "w", payload(forged as GameState, NF3)).kind).toBe("refuse");
    // One step ahead with an illegal step is refused as illegal.
    const oneIllegal = { ...stateAfter(E4), history: [E4, m("e7", "e4")] };
    expect(judgeInbound(local, "w", payload(oneIllegal as GameState))).toEqual({ kind: "refuse", reason: "illegal" });
    // A past that isn't legal even though it is our own (a copy broken by an
    // older chess) is never extended.
    const brokenLocal = { ...initialState(), history: [m("e2", "e5")] };
    const v = judgeInbound(brokenLocal, "w", payload({ ...initialState(), history: [m("e2", "e5"), E5] }, E5));
    expect(v).toEqual({ kind: "refuse", reason: "illegal" });
  });

  it("the move and its game must agree", () => {
    const v = judgeInbound(initialState(), "b", payload(stateAfter(E4), m("d2", "d4")));
    expect(v).toEqual({ kind: "refuse", reason: "inconsistent" });
  });

  it("garbage is refused, never thrown", () => {
    for (const p of [
      null,
      "move",
      { type: "move" },
      { type: "move", move: { from: -1, to: 70 } },
      { type: "move", move: { from: "a", to: 1 } },
      { type: "move", move: { from: 1.5, to: 2 } },
      { type: "move", move: E4, state: { history: "x" } },
      { type: "move", move: E4, state: { history: [{ from: 52, to: 36, promotion: "X" }] } },
    ]) {
      const v = judgeInbound(initialState(), "b", p);
      expect(v).toEqual({ kind: "refuse", reason: "malformed" });
    }
  });
});

describe("a message lands in the game Social Home delivered it in (#7)", () => {
  function game(sessionId: string, over: Partial<GameEntry> = {}): GameEntry {
    return {
      sessionId,
      opponentInstanceId: "house-b",
      opponentRef: "ben",
      opponentIsLocal: false,
      opponentName: "Ben",
      myColor: "w",
      state: initialState(),
      ...over,
    };
  }
  const games = new Map([
    ["g2", game("g2", { opponentInstanceId: "house-c", opponentRef: "cleo", opponentName: "Cleo" })],
    ["g3", game("g3")],
  ]);

  it("routes on the delivered session, not the payload's", () => {
    const r = routeInbound(
      { sessionId: "g3", fromInstance: "house-b", fromUser: "ben", payload: { type: "move", sessionId: "g2" } },
      games,
    );
    expect(r.kind).toBe("game");
    if (r.kind === "game") expect(r.entry.sessionId).toBe("g3");
  });

  it("drops a message for a game we don't have", () => {
    expect(
      routeInbound({ sessionId: "nope", fromInstance: "house-b", payload: { type: "move", sessionId: "g3" } }, games),
    ).toEqual({ kind: "drop", reason: "unknown-game" });
  });

  it("drops a message from someone this game is not with", () => {
    expect(
      routeInbound({ sessionId: "g2", fromInstance: "house-b", fromUser: "ben", payload: { type: "move" } }, games),
    ).toEqual({ kind: "drop", reason: "not-opponent" });
    expect(
      routeInbound({ sessionId: "g2", fromInstance: "house-c", fromUser: "mallory", payload: { type: "move" } }, games),
    ).toEqual({ kind: "drop", reason: "not-opponent" });
  });
});

describe("our own saved copy can catch this screen up (same person, another screen)", () => {
  it("takes our store's copy when it legally extends this screen's moves", () => {
    const fresh = catchUpFromOwnCopy(stateAfter(E4), stateAfter(E4, E5));
    expect(fresh?.history).toEqual([E4, E5]);
    // ...after which the opponent's next move fits.
    expect(judgeInbound(fresh!, "b", payload(stateAfter(E4, E5, NF3))).kind).toBe("apply");
  });

  it("never takes a copy that differs, is illegal, or isn't ahead", () => {
    expect(catchUpFromOwnCopy(stateAfter(E4), stateAfter(m("d2", "d4"), E5))).toBeNull();
    expect(catchUpFromOwnCopy(stateAfter(E4), { history: [E4, m("e7", "e4")] })).toBeNull();
    expect(catchUpFromOwnCopy(stateAfter(E4, E5), stateAfter(E4))).toBeNull();
    expect(catchUpFromOwnCopy(stateAfter(E4), null)).toBeNull();
  });
});
