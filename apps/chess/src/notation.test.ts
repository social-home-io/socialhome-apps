import { describe, expect, it } from "vitest";
import { applyAction, applyMove, fromFen, initialState, parseSquare } from "./chess.js";
import type { GameState, Move } from "./chess.js";
import { moveRows, pgnResult, toPgn, toSan } from "./notation.js";

const m = (from: string, to: string, promotion?: Move["promotion"]): Move =>
  promotion ? { from: parseSquare(from), to: parseSquare(to), promotion } : { from: parseSquare(from), to: parseSquare(to) };
function play(state: GameState, ...uci: string[]): GameState {
  for (const u of uci) state = applyMove(state, m(u.slice(0, 2), u.slice(2, 4), u[4]?.toUpperCase() as Move["promotion"]));
  return state;
}
const san = (fen: string, uci: string): string =>
  toSan(fromFen(fen), m(uci.slice(0, 2), uci.slice(2, 4), uci[4]?.toUpperCase() as Move["promotion"]));

describe("SAN", () => {
  it("pawn moves, piece moves and captures", () => {
    const s = initialState();
    expect(toSan(s, m("e2", "e4"))).toBe("e4");
    expect(toSan(s, m("g1", "f3"))).toBe("Nf3");
    const s2 = play(s, "e2e4", "d7d5");
    expect(toSan(s2, m("e4", "d5"))).toBe("exd5");
  });

  it("castling, en passant, promotion, check and mate", () => {
    expect(san("r3k2r/8/8/8/8/8/8/R3K2R w KQkq - 0 1", "e1g1")).toBe("O-O");
    expect(san("r3k2r/8/8/8/8/8/8/R3K2R w KQkq - 0 1", "e1c1")).toBe("O-O-O");
    expect(san("4k3/8/8/3pP3/8/8/8/4K3 w - d6 0 1", "e5d6")).toBe("exd6");
    expect(san("4k3/1P6/8/8/8/8/8/4K3 w - - 0 1", "b7b8n")).toBe("b8=N");
    expect(san("4k3/1P6/8/8/8/8/8/4K3 w - - 0 1", "b7b8q")).toBe("b8=Q+");
    const fool = play(initialState(), "f2f3", "e7e5", "g2g4");
    expect(toSan(fool, m("d8", "h4"))).toBe("Qh4#");
  });

  it("tells apart two pieces that can reach the same square", () => {
    // Knights on b1 and f1 can both reach d2: file letter.
    expect(san("4k3/8/8/8/8/8/8/1N2KN2 w - - 0 1", "b1d2")).toBe("Nbd2");
    // Rooks on a1 and a5 both reach a3: rank number.
    expect(san("4k3/8/8/R7/8/8/8/R3K3 w - - 0 1", "a1a3")).toBe("R1a3");
    // Three queens: file and rank.
    expect(san("4k3/8/8/8/Q2Q4/8/8/Q3K3 w - - 0 1", "a4d1")).toBe("Qa4d1");
  });
});

describe("move rows and PGN", () => {
  it("lists board moves with numbers, skipping actions", () => {
    let s = applyAction(initialState(), { action: "offer-draw", by: "w" });
    s = play(s, "e2e4", "e7e5", "g1f3");
    const rows = moveRows(s.history);
    expect(rows.map((r) => `${r.number}${r.color}:${r.san}`)).toEqual(["1w:e4", "1b:e5", "2w:Nf3"]);
    expect(rows[0].historyIndex).toBe(1);
    expect(rows[2].after.sideToMove).toBe("b");
  });

  it("writes PGN with names, result and resignation", () => {
    let s = play(initialState(), "e2e4", "e7e5");
    s = applyAction(s, { action: "resign", by: "w" });
    const pgn = toPgn(s, "Anna", 'Ben "B"');
    expect(pgn).toContain('[White "Anna"]');
    expect(pgn).toContain('[Black "Ben \\"B\\""]');
    expect(pgn).toContain('[Result "0-1"]');
    expect(pgn).toContain('[Termination "resignation"]');
    expect(pgn.trim().endsWith("1. e4 e5 0-1")).toBe(true);
  });

  it("result tokens and line wrapping", () => {
    expect(pgnResult(initialState())).toBe("*");
    const s = play(initialState(), "g1f3", "g8f6", "f3g1", "f6g8", "g1f3", "g8f6", "f3g1", "f6g8");
    const pgn = toPgn(s, "A", "B");
    expect(pgnResult(s)).toBe("1/2-1/2");
    for (const line of pgn.split("\n")) expect(line.length).toBeLessThanOrEqual(80);
  });
});
