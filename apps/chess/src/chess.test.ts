/**
 * Unit tests for the chess engine.
 * Deterministic — no randomness, no I/O.
 */

import { describe, it, expect } from "vitest";
import {
  initialState,
  legalMoves,
  allLegalMoves,
  applyMove,
  isInCheck,
  detectResult,
  squareName,
  parseSquare,
  sq,
  rowOf,
  colOf,
  lastMove,
  isMyTurn,
} from "./chess.js";
import type { Board, GameState, Move, Piece } from "./chess.js";
import { groupContacts } from "./main.js";
import type { Contact } from "@socialhome/app-sdk";

// ---------------------------------------------------------------------------
// groupContacts (pure lobby helper)
// ---------------------------------------------------------------------------

function contact(over: Partial<Contact> & { user_ref: string }): Contact {
  return {
    instance_id: "inst-x",
    display_name: over.user_ref,
    is_local: false,
    online: false,
    ...over,
  };
}

describe("groupContacts", () => {
  it("splits local members into household and remote into friends", () => {
    const a = contact({ user_ref: "a", is_local: true });
    const b = contact({ user_ref: "b", is_local: false });
    const c = contact({ user_ref: "c", is_local: true });
    const { household, friends } = groupContacts([a, b, c]);
    expect(household).toEqual([a, c]);
    expect(friends).toEqual([b]);
  });

  it("handles an empty input", () => {
    const { household, friends } = groupContacts([]);
    expect(household).toEqual([]);
    expect(friends).toEqual([]);
  });

  it("returns all-household when every contact is local", () => {
    const a = contact({ user_ref: "a", is_local: true });
    const b = contact({ user_ref: "b", is_local: true });
    const { household, friends } = groupContacts([a, b]);
    expect(household).toEqual([a, b]);
    expect(friends).toEqual([]);
  });

  it("returns all-friends when no contact is local", () => {
    const a = contact({ user_ref: "a", is_local: false });
    const b = contact({ user_ref: "b", is_local: false });
    const { household, friends } = groupContacts([a, b]);
    expect(household).toEqual([]);
    expect(friends).toEqual([a, b]);
  });

  it("preserves input order within each group", () => {
    const local1 = contact({ user_ref: "l1", is_local: true });
    const remote1 = contact({ user_ref: "r1", is_local: false });
    const local2 = contact({ user_ref: "l2", is_local: true });
    const remote2 = contact({ user_ref: "r2", is_local: false });
    const { household, friends } = groupContacts([local1, remote1, local2, remote2]);
    expect(household).toEqual([local1, local2]);
    expect(friends).toEqual([remote1, remote2]);
  });
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build a minimal board from a sparse square map. Useful for scenario tests. */
function sparseBoard(pieces: Record<string, Piece>): Board {
  const board: Board = new Array(64).fill(null);
  for (const [name, piece] of Object.entries(pieces)) {
    const idx = parseSquare(name);
    if (idx === -1) throw new Error(`Bad square: ${name}`);
    board[idx] = piece;
  }
  return board;
}

function state(board: Board, sideToMove: "w" | "b" = "w"): GameState {
  return { board, sideToMove, history: [], result: null };
}

// ---------------------------------------------------------------------------
// lastMove / isMyTurn (pure UX helpers)
// ---------------------------------------------------------------------------

describe("lastMove", () => {
  it("is null on the initial state", () => {
    expect(lastMove(initialState())).toBeNull();
  });

  it("returns the most recent applied half-move", () => {
    let s = initialState();
    // 1. e2-e4
    const m1: Move = { from: parseSquare("e2"), to: parseSquare("e4") };
    s = applyMove(s, m1);
    expect(lastMove(s)).toEqual(m1);
    // 1... e7-e5
    const m2: Move = { from: parseSquare("e7"), to: parseSquare("e5") };
    s = applyMove(s, m2);
    const lm = lastMove(s);
    expect(lm).not.toBeNull();
    expect(lm!.from).toBe(parseSquare("e7"));
    expect(lm!.to).toBe(parseSquare("e5"));
  });
});

describe("isMyTurn", () => {
  it("is true when it is my color's turn and the game is ongoing", () => {
    const s = initialState(); // White to move, result null
    expect(isMyTurn(s, "w")).toBe(true);
  });

  it("is false when it is the opponent's turn", () => {
    const s = initialState(); // White to move
    expect(isMyTurn(s, "b")).toBe(false);
  });

  it("is false once the game is over, even on my color's turn", () => {
    const over: GameState = { ...initialState(), result: "draw" };
    expect(isMyTurn(over, "w")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Coordinate helpers
// ---------------------------------------------------------------------------

describe("coordinate helpers", () => {
  it("sq / rowOf / colOf round-trip", () => {
    expect(sq(0, 0)).toBe(0);
    expect(sq(7, 7)).toBe(63);
    expect(rowOf(0)).toBe(0);
    expect(colOf(0)).toBe(0);
    expect(rowOf(63)).toBe(7);
    expect(colOf(63)).toBe(7);
  });

  it("squareName maps correctly", () => {
    expect(squareName(0)).toBe("a8");   // top-left
    expect(squareName(7)).toBe("h8");   // top-right
    expect(squareName(56)).toBe("a1");  // bottom-left
    expect(squareName(63)).toBe("h1");  // bottom-right
    expect(squareName(sq(6, 4))).toBe("e2"); // e2
  });

  it("parseSquare inverts squareName", () => {
    for (let i = 0; i < 64; i++) {
      expect(parseSquare(squareName(i))).toBe(i);
    }
  });
});

// ---------------------------------------------------------------------------
// Initial position
// ---------------------------------------------------------------------------

describe("initialState", () => {
  it("has 32 pieces", () => {
    const s = initialState();
    const count = s.board.filter((p) => p !== null).length;
    expect(count).toBe(32);
  });

  it("White to move first", () => {
    expect(initialState().sideToMove).toBe("w");
  });

  it("correct pieces on e1 and e8", () => {
    const s = initialState();
    expect(s.board[parseSquare("e1")]).toEqual({ type: "K", color: "w" });
    expect(s.board[parseSquare("e8")]).toEqual({ type: "K", color: "b" });
  });

  it("pawns on ranks 2 and 7", () => {
    const s = initialState();
    for (let col = 0; col < 8; col++) {
      expect(s.board[sq(6, col)]).toEqual({ type: "P", color: "w" });
      expect(s.board[sq(1, col)]).toEqual({ type: "P", color: "b" });
    }
  });

  it("no result yet", () => {
    expect(initialState().result).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Pawn moves
// ---------------------------------------------------------------------------

describe("pawn moves", () => {
  it("white pawn on starting rank can move one or two squares forward", () => {
    const s = initialState();
    const from = parseSquare("e2");
    const moves = legalMoves(s, from).map((m) => squareName(m.to));
    expect(moves).toContain("e3");
    expect(moves).toContain("e4");
    expect(moves.length).toBe(2);
  });

  it("white pawn off starting rank can only move one square", () => {
    const board = sparseBoard({
      e1: { type: "K", color: "w" },
      e8: { type: "K", color: "b" },
      e3: { type: "P", color: "w" },
    });
    const s = state(board);
    const moves = legalMoves(s, parseSquare("e3")).map((m) => squareName(m.to));
    expect(moves).toEqual(["e4"]);
  });

  it("white pawn blocked cannot move", () => {
    const board = sparseBoard({
      e1: { type: "K", color: "w" },
      e8: { type: "K", color: "b" },
      e3: { type: "P", color: "w" },
      e4: { type: "P", color: "w" }, // blocked
    });
    const s = state(board);
    expect(legalMoves(s, parseSquare("e3"))).toHaveLength(0);
  });

  it("white pawn captures diagonally", () => {
    const board = sparseBoard({
      e1: { type: "K", color: "w" },
      e8: { type: "K", color: "b" },
      e4: { type: "P", color: "w" },
      d5: { type: "P", color: "b" },
      f5: { type: "P", color: "b" },
    });
    const s = state(board);
    const moves = legalMoves(s, parseSquare("e4")).map((m) => squareName(m.to));
    expect(moves).toContain("d5");
    expect(moves).toContain("f5");
    expect(moves).toContain("e5");
  });

  it("pawn cannot capture forward", () => {
    const board = sparseBoard({
      e1: { type: "K", color: "w" },
      e8: { type: "K", color: "b" },
      e4: { type: "P", color: "w" },
      e5: { type: "P", color: "b" }, // occupying square ahead
    });
    const s = state(board);
    const moves = legalMoves(s, parseSquare("e4")).map((m) => squareName(m.to));
    expect(moves).not.toContain("e5");
  });

  it("black pawn moves downward", () => {
    const s = initialState();
    // It's white's turn; manufacture a black-to-move state
    const board = s.board.slice();
    const bs = { board, sideToMove: "b" as const, history: [], result: null };
    const moves = legalMoves(bs, parseSquare("e7")).map((m) => squareName(m.to));
    expect(moves).toContain("e6");
    expect(moves).toContain("e5");
  });
});

// ---------------------------------------------------------------------------
// Knight moves
// ---------------------------------------------------------------------------

describe("knight moves", () => {
  it("knight on b1 has two moves in the opening", () => {
    const s = initialState();
    const moves = legalMoves(s, parseSquare("b1")).map((m) => squareName(m.to));
    expect(moves).toContain("a3");
    expect(moves).toContain("c3");
    expect(moves).toHaveLength(2);
  });

  it("knight in the centre has up to 8 targets", () => {
    const board = sparseBoard({
      e1: { type: "K", color: "w" },
      e8: { type: "K", color: "b" },
      d4: { type: "N", color: "w" },
    });
    const s = state(board);
    expect(legalMoves(s, parseSquare("d4")).length).toBe(8);
  });
});

// ---------------------------------------------------------------------------
// Bishop, rook, queen slides
// ---------------------------------------------------------------------------

describe("sliding pieces", () => {
  it("bishop slides diagonally and is blocked by own piece", () => {
    const board = sparseBoard({
      e1: { type: "K", color: "w" },
      e8: { type: "K", color: "b" },
      c1: { type: "B", color: "w" },
      d2: { type: "P", color: "w" }, // blocks one diagonal
    });
    const s = state(board);
    const targets = legalMoves(s, parseSquare("c1")).map((m) => squareName(m.to));
    expect(targets).not.toContain("d2"); // own pawn
    expect(targets).not.toContain("e3"); // blocked behind own pawn
    expect(targets).toContain("b2");     // other diagonal
    expect(targets).toContain("a3");
  });

  it("rook slides orthogonally and captures", () => {
    const board = sparseBoard({
      e1: { type: "K", color: "w" },
      e8: { type: "K", color: "b" },
      a1: { type: "R", color: "w" },
      a6: { type: "P", color: "b" }, // can capture
    });
    const s = state(board);
    const targets = legalMoves(s, parseSquare("a1")).map((m) => squareName(m.to));
    expect(targets).toContain("a6"); // capture
    expect(targets).not.toContain("a7"); // blocked behind capture
    expect(targets).toContain("b1");
  });

  it("queen combines rook+bishop moves", () => {
    const board = sparseBoard({
      e1: { type: "K", color: "w" },
      e8: { type: "K", color: "b" },
      d4: { type: "Q", color: "w" },
    });
    const s = state(board);
    // Open board — queen on d4 should have 27 moves (standard fact)
    expect(legalMoves(s, parseSquare("d4")).length).toBe(27);
  });
});

// ---------------------------------------------------------------------------
// King moves
// ---------------------------------------------------------------------------

describe("king moves", () => {
  it("king can move one square in any direction", () => {
    const board = sparseBoard({
      e4: { type: "K", color: "w" },
      e8: { type: "K", color: "b" },
    });
    const s = state(board);
    expect(legalMoves(s, parseSquare("e4")).length).toBe(8);
  });

  it("king cannot move into check", () => {
    // White king on e1, black rook on d8 — king cannot step to d1 or d2
    const board = sparseBoard({
      e1: { type: "K", color: "w" },
      e8: { type: "K", color: "b" },
      d8: { type: "R", color: "b" },
    });
    const s = state(board);
    const targets = legalMoves(s, parseSquare("e1")).map((m) => squareName(m.to));
    expect(targets).not.toContain("d1");
    expect(targets).not.toContain("d2");
  });
});

// ---------------------------------------------------------------------------
// applyMove
// ---------------------------------------------------------------------------

describe("applyMove", () => {
  it("moves the piece to the destination", () => {
    const s = initialState();
    const from = parseSquare("e2");
    const to = parseSquare("e4");
    const next = applyMove(s, { from, to });
    expect(next.board[to]).toEqual({ type: "P", color: "w" });
    expect(next.board[from]).toBeNull();
  });

  it("alternates side to move", () => {
    const s = initialState();
    const s2 = applyMove(s, { from: parseSquare("e2"), to: parseSquare("e4") });
    expect(s2.sideToMove).toBe("b");
    const s3 = applyMove(s2, { from: parseSquare("e7"), to: parseSquare("e5") });
    expect(s3.sideToMove).toBe("w");
  });

  it("records move in history", () => {
    const s = initialState();
    const move: Move = { from: parseSquare("e2"), to: parseSquare("e4") };
    const next = applyMove(s, move);
    expect(next.history).toHaveLength(1);
    expect(next.history[0]).toEqual(move);
  });

  it("throws on illegal move (own piece blocks)", () => {
    const s = initialState();
    // d1 queen blocked by pawns on starting position
    expect(() =>
      applyMove(s, { from: parseSquare("d1"), to: parseSquare("d3") })
    ).toThrow();
  });

  it("throws on wrong color piece", () => {
    const s = initialState(); // white to move
    expect(() =>
      applyMove(s, { from: parseSquare("e7"), to: parseSquare("e5") })
    ).toThrow();
  });

  it("throws when game is already over", () => {
    const s = initialState();
    const over = { ...s, result: "white" as const };
    expect(() =>
      applyMove(over, { from: parseSquare("e2"), to: parseSquare("e4") })
    ).toThrow();
  });
});

// ---------------------------------------------------------------------------
// Captures
// ---------------------------------------------------------------------------

describe("captures", () => {
  it("pawn captures opponent piece", () => {
    const board = sparseBoard({
      e1: { type: "K", color: "w" },
      e8: { type: "K", color: "b" },
      e4: { type: "P", color: "w" },
      d5: { type: "P", color: "b" },
    });
    const s = state(board);
    const next = applyMove(s, { from: parseSquare("e4"), to: parseSquare("d5") });
    expect(next.board[parseSquare("d5")]).toEqual({ type: "P", color: "w" });
    expect(next.board[parseSquare("e4")]).toBeNull();
  });

  it("rook captures opponent piece and stops", () => {
    const board = sparseBoard({
      e1: { type: "K", color: "w" },
      e8: { type: "K", color: "b" },
      a1: { type: "R", color: "w" },
      a5: { type: "P", color: "b" },
    });
    const s = state(board);
    const next = applyMove(s, { from: parseSquare("a1"), to: parseSquare("a5") });
    expect(next.board[parseSquare("a5")]).toEqual({ type: "R", color: "w" });
  });
});

// ---------------------------------------------------------------------------
// Check detection
// ---------------------------------------------------------------------------

describe("isInCheck", () => {
  it("not in check at start", () => {
    const s = initialState();
    expect(isInCheck(s.board, "w")).toBe(false);
    expect(isInCheck(s.board, "b")).toBe(false);
  });

  it("king is in check when attacked by a rook", () => {
    const board = sparseBoard({
      e1: { type: "K", color: "w" },
      e8: { type: "K", color: "b" },
      e4: { type: "R", color: "b" }, // attacks e1
    });
    expect(isInCheck(board, "w")).toBe(true);
    expect(isInCheck(board, "b")).toBe(false);
  });

  it("move that leaves own king in check is illegal", () => {
    // White king on e1, white rook on e3 (pinned), black rook on e8
    // Moving the rook off the e-file would expose the king to e8 rook
    const board = sparseBoard({
      e1: { type: "K", color: "w" },
      e8: { type: "R", color: "b" }, // attacks along e-file
      e3: { type: "R", color: "w" }, // shields the king
      a8: { type: "K", color: "b" }, // black king elsewhere
    });
    const s = state(board);
    // Moving the white rook to d3 would expose e1 king to e8 rook
    const moves = legalMoves(s, parseSquare("e3")).map((m) => squareName(m.to));
    expect(moves).not.toContain("d3"); // illegal — exposes king
    expect(moves).toContain("e8");     // capturing the attacker is legal
    // Moving along e-file is fine (doesn't expose king)
    expect(moves).toContain("e4");
    expect(moves).toContain("e5");
    expect(moves).toContain("e6");
    expect(moves).toContain("e7");
  });
});

// ---------------------------------------------------------------------------
// Pawn promotion
// ---------------------------------------------------------------------------

describe("pawn promotion", () => {
  it("white pawn promotes to queen on rank 8", () => {
    const board = sparseBoard({
      e1: { type: "K", color: "w" },
      e8: { type: "K", color: "b" },
      a7: { type: "P", color: "w" },
    });
    const s = state(board);
    const moves = legalMoves(s, parseSquare("a7"));
    // Should have a promotion move to a8
    const promo = moves.find((m) => squareName(m.to) === "a8");
    expect(promo).toBeDefined();
    expect(promo?.promotion).toBe("Q");

    const next = applyMove(s, promo!);
    expect(next.board[parseSquare("a8")]).toEqual({ type: "Q", color: "w" });
  });

  it("black pawn promotes on rank 1", () => {
    const board = sparseBoard({
      a1: { type: "K", color: "w" }, // put king out of the way
      e8: { type: "K", color: "b" },
      h2: { type: "P", color: "b" },
    });
    const s = state(board, "b");
    const moves = legalMoves(s, parseSquare("h2"));
    const promo = moves.find((m) => squareName(m.to) === "h1");
    expect(promo).toBeDefined();
    const next = applyMove(s, promo!);
    expect(next.board[parseSquare("h1")]).toEqual({ type: "Q", color: "b" });
  });
});

// ---------------------------------------------------------------------------
// Checkmate & stalemate
// ---------------------------------------------------------------------------

describe("game over detection", () => {
  it("fool's mate results in black winning", () => {
    // Shortest checkmate: 1.f3 e5 2.g4 Qh4#
    let s = initialState();
    s = applyMove(s, { from: parseSquare("f2"), to: parseSquare("f3") }); // 1.f3
    s = applyMove(s, { from: parseSquare("e7"), to: parseSquare("e5") }); // 1...e5
    s = applyMove(s, { from: parseSquare("g2"), to: parseSquare("g4") }); // 2.g4
    s = applyMove(s, { from: parseSquare("d8"), to: parseSquare("h4") }); // 2...Qh4#
    expect(s.result).toBe("black"); // black wins (white is in checkmate)
  });

  it("stalemate is a draw", () => {
    // Construct a stalemate position: black king on a8, white queen on b6,
    // white king on c6, black to move.
    const board = sparseBoard({
      a8: { type: "K", color: "b" },
      b6: { type: "Q", color: "w" },
      c6: { type: "K", color: "w" },
    });
    const s = state(board, "b");
    const result = detectResult(s);
    expect(result).toBe("draw");
  });

  it("no legal moves at start — ongoing", () => {
    const s = initialState();
    expect(allLegalMoves(s).length).toBeGreaterThan(0);
    expect(detectResult(s)).toBeNull();
  });

  it("cannot apply a move after checkmate", () => {
    let s = initialState();
    s = applyMove(s, { from: parseSquare("f2"), to: parseSquare("f3") });
    s = applyMove(s, { from: parseSquare("e7"), to: parseSquare("e5") });
    s = applyMove(s, { from: parseSquare("g2"), to: parseSquare("g4") });
    s = applyMove(s, { from: parseSquare("d8"), to: parseSquare("h4") });
    expect(() =>
      applyMove(s, { from: parseSquare("e2"), to: parseSquare("e4") })
    ).toThrow("Game is already over");
  });
});

// ---------------------------------------------------------------------------
// allLegalMoves count at opening
// ---------------------------------------------------------------------------

describe("allLegalMoves", () => {
  it("white has 20 legal moves at start", () => {
    // 16 pawn moves (8 pawns × 2) + 4 knight moves
    const s = initialState();
    expect(allLegalMoves(s).length).toBe(20);
  });

  it("returns empty when game is over", () => {
    const s = { ...initialState(), result: "white" as const };
    expect(allLegalMoves(s)).toHaveLength(0);
  });
});
