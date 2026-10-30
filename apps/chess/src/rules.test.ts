/**
 * The full rules of chess: move-generator counts (perft) against the
 * published reference numbers, castling, en passant, promotion choice, every
 * way a game can be drawn, and the draw-offer / resign actions.
 */
import { describe, expect, it } from "vitest";
import {
  allLegalMoves,
  applyAction,
  applyMove,
  applyPly,
  canTakeAction,
  fromFen,
  initialState,
  isInsufficientMaterial,
  legalMoves,
  needsPromotion,
  parseSquare,
  perft,
  replayHistory,
  toFen,
} from "./chess.js";
import type { GameState, Move, Ply } from "./chess.js";

const s = parseSquare;
const mv = (from: string, to: string, promotion?: Move["promotion"]): Move =>
  promotion ? { from: s(from), to: s(to), promotion } : { from: s(from), to: s(to) };

/** Play UCI-ish moves ("e2e4", "e7e8q") from a state. */
function play(state: GameState, ...moves: string[]): GameState {
  for (const m of moves) {
    const promo = m[4]?.toUpperCase() as Move["promotion"] | undefined;
    state = applyMove(state, mv(m.slice(0, 2), m.slice(2, 4), promo));
  }
  return state;
}

const targets = (state: GameState, from: string): string[] =>
  [...new Set(legalMoves(state, s(from)).map((m) => m.to))].sort((a, b) => a - b).map((i) =>
    "abcdefgh"[i % 8] + String(8 - Math.floor(i / 8)),
  );

describe("perft — leaf counts match the published reference numbers", () => {
  it("start position, depth 1–3: 20 / 400 / 8902", () => {
    const start = initialState();
    expect(perft(start, 1)).toBe(20);
    expect(perft(start, 2)).toBe(400);
    expect(perft(start, 3)).toBe(8902);
  });

  it("Kiwipete (castling, en passant, promotions, pins), depth 1–2: 48 / 2039", () => {
    const kiwi = fromFen("r3k2r/p1ppqpb1/bn2pnp1/3PN3/1p2P3/2N2Q1p/PPPBBPPP/R3K2R w KQkq - 0 1");
    expect(perft(kiwi, 1)).toBe(48);
    expect(perft(kiwi, 2)).toBe(2039);
  });

  it("position 3 (en passant discovered checks), depth 1–3: 14 / 191 / 2812", () => {
    const p3 = fromFen("8/2p5/3p4/KP5r/1R3p1k/8/4P1P1/8 w - - 0 1");
    expect(perft(p3, 1)).toBe(14);
    expect(perft(p3, 2)).toBe(191);
    expect(perft(p3, 3)).toBe(2812);
  });

  it("position 4 (promotions, castling out of check), depth 1–2: 6 / 264", () => {
    const p4 = fromFen("r3k2r/Pppp1ppp/1b3nbN/nP6/BBP1P3/q4N2/Pp1P2PP/R2Q1RK1 w kq - 0 1");
    expect(perft(p4, 1)).toBe(6);
    expect(perft(p4, 2)).toBe(264);
  });

  it("position 5, depth 1–2: 44 / 1486", () => {
    const p5 = fromFen("rnbq1k1r/pp1Pbppp/2p5/8/2B5/8/PPP1NnPP/RNBQK2R w KQ - 1 8");
    expect(perft(p5, 1)).toBe(44);
    expect(perft(p5, 2)).toBe(1486);
  });
});

describe("castling", () => {
  const open = (): GameState => fromFen("r3k2r/pppppppp/8/8/8/8/PPPPPPPP/R3K2R w KQkq - 0 1");

  it("the king may castle on both sides when the way is clear", () => {
    expect(targets(open(), "e1")).toEqual(["c1", "d1", "f1", "g1"]);
  });

  it("king-side castling moves the rook to f1", () => {
    const after = play(open(), "e1g1");
    expect(after.board[s("g1")]).toEqual({ type: "K", color: "w" });
    expect(after.board[s("f1")]).toEqual({ type: "R", color: "w" });
    expect(after.board[s("h1")]).toBeNull();
    expect(after.castling).toMatchObject({ K: false, Q: false, k: true, q: true });
  });

  it("queen-side castling moves the rook to d1 (Black too)", () => {
    const after = play(open(), "a2a3", "e8c8");
    expect(after.board[s("c8")]).toEqual({ type: "K", color: "b" });
    expect(after.board[s("d8")]).toEqual({ type: "R", color: "b" });
    expect(after.board[s("a8")]).toBeNull();
  });

  it("not out of check", () => {
    const st = fromFen("4k3/8/8/8/8/8/4r3/R3K2R w KQ - 0 1");
    expect(targets(st, "e1")).not.toContain("g1");
    expect(targets(st, "e1")).not.toContain("c1");
  });

  it("not through an attacked square (f1), not into one (g1)", () => {
    const through = fromFen("4k3/8/8/8/8/8/5r2/R3K2R w KQ - 0 1"); // f2 rook hits f1
    expect(targets(through, "e1")).not.toContain("g1");
    expect(targets(through, "e1")).toContain("c1");
    const into = fromFen("4k3/8/8/8/8/8/6r1/R3K2R w KQ - 0 1"); // g2 rook hits g1
    expect(targets(into, "e1")).not.toContain("g1");
  });

  it("queen side: b1 may be attacked but must be empty; d1 and c1 must be safe", () => {
    const b1Attacked = fromFen("4k3/8/8/8/8/8/1r6/R3K3 w Q - 0 1");
    expect(targets(b1Attacked, "e1")).toContain("c1");
    const b1Blocked = fromFen("4k3/8/8/8/8/8/8/RN2K3 w Q - 0 1");
    expect(targets(b1Blocked, "e1")).not.toContain("c1");
    const d1Attacked = fromFen("4k3/8/8/8/8/8/3r4/R3K3 w Q - 0 1");
    expect(targets(d1Attacked, "e1")).not.toContain("c1");
  });

  it("not after the king has moved, even when it came back", () => {
    const st = play(open(), "e1f1", "a7a6", "f1e1", "a6a5");
    expect(targets(st, "e1")).not.toContain("g1");
    expect(targets(st, "e1")).not.toContain("c1");
  });

  it("not on the side whose rook has moved (or was taken)", () => {
    const st = play(open(), "h1g1", "a7a6", "g1h1", "a6a5");
    expect(targets(st, "e1")).not.toContain("g1");
    expect(targets(st, "e1")).toContain("c1");
    // Black's rook on a8 taken: Black loses queen-side castling.
    const taken = play(fromFen("r3k2r/8/8/8/8/8/8/R3K2R w KQkq - 0 1"), "a1a8");
    expect(taken.castling.q).toBe(false);
    expect(taken.castling.k).toBe(true);
  });

  it("a normal game: castling after developing", () => {
    const st = play(initialState(), "e2e4", "e7e5", "g1f3", "b8c6", "f1c4", "g8f6");
    expect(targets(st, "e1")).toContain("g1");
    const castled = play(st, "e1g1");
    expect(castled.board[s("f1")]?.type).toBe("R");
  });
});

describe("en passant", () => {
  it("is offered right after the two-square push, and removes the passed pawn", () => {
    const st = play(initialState(), "e2e4", "a7a6", "e4e5", "d7d5");
    expect(targets(st, "e5")).toEqual(["d6", "e6"]);
    const after = play(st, "e5d6");
    expect(after.board[s("d5")]).toBeNull();
    expect(after.board[s("d6")]).toEqual({ type: "P", color: "w" });
  });

  it("is gone one move later", () => {
    const st = play(initialState(), "e2e4", "a7a6", "e4e5", "d7d5", "h2h3", "h7h6");
    expect(targets(st, "e5")).toEqual(["e6"]);
  });

  it("not after a one-square push", () => {
    const st = play(initialState(), "e2e4", "d7d6", "e4e5", "d6d5");
    expect(targets(st, "e5")).toEqual(["e6"]);
  });

  it("not when it would expose the king (a pin along the rank)", () => {
    const st = play(fromFen("8/8/8/8/k2p3R/8/4P3/4K3 w - - 0 1"), "e2e4");
    expect(legalMoves(st, s("d4")).map((m) => m.to)).not.toContain(s("e3"));
  });
});

describe("promotion", () => {
  const ready = (): GameState => fromFen("7k/P7/8/8/8/8/8/K7 w - - 0 1");

  it("offers all four pieces for one target square", () => {
    const promos = legalMoves(ready(), s("a7")).map((m) => m.promotion).sort();
    expect(promos).toEqual(["B", "N", "Q", "R"]);
    expect(needsPromotion(ready(), s("a7"), s("a8"))).toBe(true);
    expect(needsPromotion(ready(), s("a1"), s("a2"))).toBe(false);
  });

  it("becomes the chosen piece (a knight)", () => {
    const after = play(ready(), "a7a8n");
    expect(after.board[s("a8")]).toEqual({ type: "N", color: "w" });
  });

  it("a promotion must name its piece", () => {
    expect(() => applyMove(ready(), mv("a7", "a8"))).toThrow();
    expect(() => applyMove(ready(), mv("a7", "a8", "K"))).toThrow();
  });

  it("a promotion with a capture", () => {
    const st = fromFen("1r5k/P7/8/8/8/8/8/K7 w - - 0 1");
    const after = play(st, "a7b8r");
    expect(after.board[s("b8")]).toEqual({ type: "R", color: "w" });
  });
});

describe("endings", () => {
  it("checkmate", () => {
    const st = play(initialState(), "f2f3", "e7e5", "g2g4", "d8h4");
    expect(st.result).toBe("black");
    expect(st.ending).toBe("checkmate");
  });

  it("stalemate", () => {
    const st = play(fromFen("k7/8/1Q6/8/8/8/8/K7 w - - 0 1"), "b6c7");
    expect(st.ending).toBe("stalemate");
    expect(st.result).toBe("draw");
  });

  it("threefold repetition (the knights dance)", () => {
    let st = initialState();
    st = play(st, "g1f3", "g8f6", "f3g1", "f6g8", "g1f3", "g8f6", "f3g1");
    expect(st.result).toBeNull();
    st = play(st, "f6g8");
    expect(st.ending).toBe("repetition");
    expect(st.result).toBe("draw");
  });

  it("repetition counts only the same side to move and the same castling rights", () => {
    // Kings step away and back: castling rights are lost on the first step,
    // so the start position never comes back.
    let st = fromFen("r3k2r/8/8/8/8/8/8/R3K2R w KQkq - 0 1");
    st = play(st, "e1f1", "e8f8", "f1e1", "f8e8", "e1f1", "e8f8", "f1e1", "f8e8");
    expect(st.result).toBeNull();
    st = play(st, "e1f1", "e8f8");
    expect(st.ending).toBe("repetition");
  });

  it("the 50-move rule: 100 half-moves without a capture or pawn move", () => {
    const st = fromFen("4k3/8/8/8/8/8/R7/4K3 w - - 98 80");
    const near = play(st, "a2b2");
    expect(near.result).toBeNull();
    expect(near.halfmoveClock).toBe(99);
    const after = play(near, "e8d8");
    expect(after.ending).toBe("fifty-moves");
  });

  it("a pawn move resets the 50-move count", () => {
    const st = play(fromFen("4k3/8/8/8/8/8/P7/R3K3 w - - 97 80"), "a2a3");
    expect(st.halfmoveClock).toBe(0);
  });

  it("checkmate on the 100th half-move is still checkmate", () => {
    const st = play(fromFen("k7/8/1K6/8/8/8/8/7R w - - 99 80"), "h1h8");
    expect(st.ending).toBe("checkmate");
  });

  it("insufficient material", () => {
    expect(isInsufficientMaterial(fromFen("4k3/8/8/8/8/8/8/4K3 w - - 0 1").board)).toBe(true);
    expect(isInsufficientMaterial(fromFen("4k3/8/8/8/8/8/8/2B1K3 w - - 0 1").board)).toBe(true);
    expect(isInsufficientMaterial(fromFen("4k3/8/8/8/8/8/8/1N2K3 w - - 0 1").board)).toBe(true);
    // Bishops on the same square colour (c1 and f8 are both dark).
    expect(isInsufficientMaterial(fromFen("4kb2/8/8/8/8/8/8/2B1K3 w - - 0 1").board)).toBe(true);
    // Opposite colours, two knights, a pawn or a rook: play on.
    expect(isInsufficientMaterial(fromFen("4k1b1/8/8/8/8/8/8/2B1K3 w - - 0 1").board)).toBe(false);
    expect(isInsufficientMaterial(fromFen("4k3/8/8/8/8/8/8/1NN1K3 w - - 0 1").board)).toBe(false);
    expect(isInsufficientMaterial(fromFen("4k3/8/8/8/8/8/P7/4K3 w - - 0 1").board)).toBe(false);
    expect(isInsufficientMaterial(fromFen("4k3/8/8/8/8/8/8/R3K3 w - - 0 1").board)).toBe(false);
  });

  it("taking the last piece ends the game as insufficient material", () => {
    const st = play(fromFen("4k3/8/8/8/8/8/3r4/4K3 w - - 0 1"), "e1d2");
    expect(st.ending).toBe("insufficient");
    expect(st.result).toBe("draw");
  });
});

describe("draw offers and resigning (actions in the history)", () => {
  it("an offer on your turn, then your move: the offer stands", () => {
    let st = applyAction(initialState(), { action: "offer-draw", by: "w" });
    expect(st.drawOffer).toBe("w");
    expect(st.sideToMove).toBe("w");
    st = play(st, "e2e4");
    expect(st.drawOffer).toBe("w");
    expect(canTakeAction(st, "accept-draw", "b")).toBe(true);
  });

  it("accepting ends the game as a draw by agreement", () => {
    let st = applyAction(initialState(), { action: "offer-draw", by: "w" });
    st = play(st, "e2e4");
    st = applyAction(st, { action: "accept-draw", by: "b" });
    expect(st.result).toBe("draw");
    expect(st.ending).toBe("agreement");
    expect(allLegalMoves(st)).toEqual([]);
  });

  it("declining clears the offer and the game goes on", () => {
    let st = play(applyAction(initialState(), { action: "offer-draw", by: "w" }), "e2e4");
    st = applyAction(st, { action: "decline-draw", by: "b" });
    expect(st.drawOffer).toBeNull();
    expect(st.result).toBeNull();
    expect(st.sideToMove).toBe("b");
  });

  it("a move by the other player declines the offer", () => {
    let st = play(applyAction(initialState(), { action: "offer-draw", by: "w" }), "e2e4");
    st = play(st, "e7e5");
    expect(st.drawOffer).toBeNull();
    expect(canTakeAction(st, "accept-draw", "b")).toBe(false);
  });

  it("offers and answers only on your own turn, one offer at a time", () => {
    const st = initialState();
    expect(canTakeAction(st, "offer-draw", "b")).toBe(false);
    expect(canTakeAction(st, "accept-draw", "w")).toBe(false);
    const offered = applyAction(st, { action: "offer-draw", by: "w" });
    expect(canTakeAction(offered, "offer-draw", "w")).toBe(false);
    expect(canTakeAction(offered, "accept-draw", "w")).toBe(false);
    expect(() => applyAction(st, { action: "offer-draw", by: "b" })).toThrow();
  });

  it("resigning at any time: the other side wins", () => {
    const st = play(initialState(), "e2e4");
    const resigned = applyAction(st, { action: "resign", by: "w" }); // on Black's turn
    expect(resigned.result).toBe("black");
    expect(resigned.ending).toBe("resign");
    expect(() => applyAction(resigned, { action: "resign", by: "b" })).toThrow();
  });

  it("replayHistory rebuilds moves and actions alike", () => {
    const history: Ply[] = [
      mv("e2", "e4"),
      { action: "offer-draw", by: "b" },
      mv("e7", "e5"),
      { action: "accept-draw", by: "w" },
    ];
    const st = replayHistory(history)!;
    expect(st.ending).toBe("agreement");
    expect(replayHistory([...history, mv("g1", "f3")])).toBeNull();
    expect(applyPly(initialState(), mv("e2", "e4")).sideToMove).toBe("b");
  });
});

describe("FEN", () => {
  it("round-trips the start position", () => {
    expect(toFen(initialState())).toBe("rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1");
  });

  it("names the en passant square and the clocks", () => {
    expect(toFen(play(initialState(), "e2e4"))).toBe(
      "rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq e3 0 1",
    );
  });

  it("rejects malformed input", () => {
    expect(() => fromFen("8/8/8 w - - 0 1")).toThrow();
    expect(() => fromFen("rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR x KQkq - 0 1")).toThrow();
  });
});
