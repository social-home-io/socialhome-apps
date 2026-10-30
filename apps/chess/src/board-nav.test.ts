/**
 * Keyboard play: cursor movement in screen space, the shared click/Enter
 * selection decision, square names and the live-region sentences.
 */

import { afterEach, describe, it, expect } from "vitest";
import { setLocale } from "./i18n.js";
import { applyMove, applyPly, fromFen, initialState, parseSquare, positionOf } from "./chess.js";
import type { Board, GameState, Move, Ply } from "./chess.js";
import {
  activateSquare,
  checkedKing,
  endingText,
  targetsOf,
  boardHint,
  boardLabel,
  buildSquareOrder,
  initialCursor,
  isNavKey,
  moveAnnouncement,
  moveCursor,
  noneAnnouncement,
  selectionAnnouncement,
  selectionCleared,
  squareLabel,
} from "./board-nav.js";

const at = parseSquare;

function play(...moves: [string, string][]): GameState {
  let s = initialState();
  for (const [from, to] of moves) s = applyMove(s, { from: at(from), to: at(to) });
  return s;
}

function emptyBoard(): Board {
  return new Array(64).fill(null);
}

describe("buildSquareOrder", () => {
  it("draws a8 top-left for White and h1 top-left for Black", () => {
    expect(buildSquareOrder("w")[0]).toBe(at("a8"));
    expect(buildSquareOrder("w")[63]).toBe(at("h1"));
    expect(buildSquareOrder("b")[0]).toBe(at("h1"));
    expect(buildSquareOrder("b")[63]).toBe(at("a8"));
  });
});

describe("moveCursor (screen space)", () => {
  it("White: Up goes toward rank 8, Right toward the h-file", () => {
    expect(moveCursor(at("e2"), "ArrowUp", "w")).toBe(at("e3"));
    expect(moveCursor(at("e2"), "ArrowDown", "w")).toBe(at("e1"));
    expect(moveCursor(at("e2"), "ArrowRight", "w")).toBe(at("f2"));
    expect(moveCursor(at("e2"), "ArrowLeft", "w")).toBe(at("d2"));
  });

  it("Black (flipped board): Up goes toward rank 1, Right toward the a-file", () => {
    expect(moveCursor(at("e7"), "ArrowUp", "b")).toBe(at("e6"));
    expect(moveCursor(at("e7"), "ArrowDown", "b")).toBe(at("e8"));
    expect(moveCursor(at("e7"), "ArrowRight", "b")).toBe(at("d7"));
    expect(moveCursor(at("e7"), "ArrowLeft", "b")).toBe(at("f7"));
  });

  it("clamps at the edges instead of wrapping", () => {
    expect(moveCursor(at("a8"), "ArrowUp", "w")).toBe(at("a8"));
    expect(moveCursor(at("a8"), "ArrowLeft", "w")).toBe(at("a8"));
    expect(moveCursor(at("h1"), "ArrowDown", "w")).toBe(at("h1"));
    expect(moveCursor(at("h1"), "ArrowRight", "w")).toBe(at("h1"));
  });

  it("Home/End jump along the drawn row; Ctrl+Home/End to the corners", () => {
    expect(moveCursor(at("e4"), "Home", "w")).toBe(at("a4"));
    expect(moveCursor(at("e4"), "End", "w")).toBe(at("h4"));
    expect(moveCursor(at("e4"), "Home", "w", true)).toBe(at("a8"));
    expect(moveCursor(at("e4"), "End", "w", true)).toBe(at("h1"));
    expect(moveCursor(at("e4"), "Home", "b")).toBe(at("h4"));
  });

  it("PageUp/PageDown jump to the top/bottom row", () => {
    expect(moveCursor(at("c4"), "PageUp", "w")).toBe(at("c8"));
    expect(moveCursor(at("c4"), "PageDown", "w")).toBe(at("c1"));
    expect(moveCursor(at("c4"), "PageUp", "b")).toBe(at("c1"));
  });

  it("reaches every one of the 64 squares", () => {
    const seen = new Set<number>();
    let cur = at("a8");
    for (let r = 0; r < 8; r++) {
      let c = cur;
      for (let i = 0; i < 8; i++) {
        seen.add(c);
        c = moveCursor(c, "ArrowRight", "w");
      }
      cur = moveCursor(cur, "ArrowDown", "w");
    }
    expect(seen.size).toBe(64);
  });

  it("isNavKey knows the board keys and nothing else", () => {
    expect(isNavKey("ArrowUp")).toBe(true);
    expect(isNavKey("PageDown")).toBe(true);
    expect(isNavKey("Enter")).toBe(false);
    expect(isNavKey("Tab")).toBe(false);
  });
});

describe("initialCursor", () => {
  it("starts on e2 / e7 in a fresh game", () => {
    expect(initialCursor(initialState(), "w")).toBe(at("e2"));
    expect(initialCursor(initialState(), "b")).toBe(at("e7"));
  });

  it("starts where the last move landed", () => {
    expect(initialCursor(play(["g1", "f3"]), "b")).toBe(at("f3"));
  });
});

describe("activateSquare", () => {
  it("picks up your piece with its legal targets", () => {
    const a = activateSquare(initialState(), "w", null, [], at("g1"));
    expect(a).toEqual({ kind: "select", square: at("g1"), targets: expect.any(Array) });
    if (a.kind === "select") expect([...a.targets].sort()).toEqual([at("f3"), at("h3")].sort());
  });

  it("picks up a blocked piece too (zero targets) so the player hears why", () => {
    expect(activateSquare(initialState(), "w", null, [], at("a1"))).toEqual({
      kind: "select", square: at("a1"), targets: [],
    });
  });

  it("then moves to a legal target", () => {
    expect(activateSquare(initialState(), "w", at("g1"), [at("f3"), at("h3")], at("f3"))).toEqual({
      kind: "move", move: { from: at("g1"), to: at("f3") },
    });
  });

  it("the selected square again clears; an empty non-target clears", () => {
    const s = initialState();
    expect(activateSquare(s, "w", at("g1"), [at("f3")], at("g1"))).toEqual({ kind: "clear" });
    expect(activateSquare(s, "w", at("g1"), [at("f3")], at("e4"))).toEqual({ kind: "clear" });
  });

  it("another own piece switches the selection", () => {
    const a = activateSquare(initialState(), "w", at("g1"), [at("f3")], at("e2"));
    expect(a.kind).toBe("select");
    if (a.kind === "select") expect(a.square).toBe(at("e2"));
  });

  it("says why nothing happens: not your turn, not your piece, game over", () => {
    expect(activateSquare(initialState(), "b", null, [], at("e7"))).toEqual({ kind: "none", reason: "not-your-turn" });
    expect(activateSquare(initialState(), "w", null, [], at("e7"))).toEqual({ kind: "none", reason: "not-your-piece" });
    expect(activateSquare(initialState(), "w", null, [], at("e4"))).toEqual({ kind: "none", reason: "not-your-piece" });
    const over: GameState = { ...initialState(), result: "white" };
    expect(activateSquare(over, "w", null, [], at("e2"))).toEqual({ kind: "none", reason: "game-over" });
  });

  it("a pawn reaching the last rank asks which piece it becomes", () => {
    const board = emptyBoard();
    board[at("a7")] = { type: "P", color: "w" };
    board[at("e1")] = { type: "K", color: "w" };
    board[at("h8")] = { type: "K", color: "b" };
    const s: GameState = positionOf(board, "w");
    // One target square for the four promotion pieces.
    expect(targetsOf(s, at("a7"))).toEqual([at("a8")]);
    expect(activateSquare(s, "w", at("a7"), [at("a8")], at("a8"))).toEqual({
      kind: "promote", from: at("a7"), to: at("a8"),
    });
  });

  it("the king's castling square is a target, and moving there castles", () => {
    const s = fromFen("r3k2r/8/8/8/8/8/8/R3K2R w KQkq - 0 1");
    const targets = targetsOf(s, at("e1"));
    expect(targets).toContain(at("g1"));
    expect(targets).toContain(at("c1"));
    expect(activateSquare(s, "w", at("e1"), targets, at("g1"))).toEqual({
      kind: "move", move: { from: at("e1"), to: at("g1") },
    });
  });
});

describe("squareLabel / boardLabel", () => {
  it("names the square and what is on it", () => {
    const s = initialState();
    expect(squareLabel(s, at("g1"))).toBe("g1, white knight");
    expect(squareLabel(s, at("e4"))).toBe("e4, empty");
    expect(squareLabel(s, at("d8"))).toBe("d8, black queen");
  });

  it("adds selected / legal move / last move", () => {
    const s = initialState();
    expect(squareLabel(s, at("g1"), { selected: true })).toBe("g1, white knight, selected");
    expect(squareLabel(s, at("f3"), { legalTarget: true })).toBe("f3, empty, legal move");
    expect(squareLabel(s, at("f3"), { lastMove: true })).toBe("f3, empty, last move");
  });

  it("says which side you play", () => {
    expect(boardLabel("w")).toBe("Chess board, you play White");
    expect(boardLabel("b")).toBe("Chess board, you play Black");
  });
});

describe("selectionAnnouncement", () => {
  it("lists the legal targets in order", () => {
    expect(selectionAnnouncement(initialState(), at("g1"), [at("h3"), at("f3")]))
      .toBe("Knight on g1. Moves to f3 and h3.");
    expect(selectionAnnouncement(initialState(), at("e2"), [at("e3")]))
      .toBe("Pawn on e2. Move to e3.");
    expect(selectionAnnouncement(initialState(), at("e2"), [at("e3"), at("e4"), at("d3")]))
      .toBe("Pawn on e2. Moves to d3, e3 and e4.");
  });

  it("says when a piece can't move", () => {
    expect(selectionAnnouncement(initialState(), at("a1"), [])).toBe("Rook on a1. It has no legal moves.");
  });
});

describe("noneAnnouncement", () => {
  it("names the opponent whose turn it is", () => {
    expect(noneAnnouncement("not-your-turn", "Ben")).toBe("It's Ben's turn.");
    expect(noneAnnouncement("not-your-piece", "Ben")).toBe("Pick one of your own pieces first.");
    expect(noneAnnouncement("game-over", "Ben")).toBe("The game is over.");
  });
});

describe("moveAnnouncement", () => {
  function announce(before: GameState, move: Move, myColor: "w" | "b"): string {
    return moveAnnouncement({ before, after: applyMove(before, move), move, myColor, opponentName: "Ben" });
  }

  it("the opponent's move hands you the turn", () => {
    expect(announce(initialState(), { from: at("g1"), to: at("f3") }, "b"))
      .toBe("Ben moved knight to f3. Your turn.");
  });

  it("your own move is confirmed without 'Your turn'", () => {
    expect(announce(initialState(), { from: at("e2"), to: at("e4") }, "w"))
      .toBe("You moved pawn to e4.");
  });

  it("captures name the taken piece", () => {
    const before = play(["e2", "e4"], ["d7", "d5"]);
    expect(announce(before, { from: at("e4"), to: at("d5") }, "b"))
      .toBe("Ben moved pawn to d5 and took the pawn. Your turn.");
  });

  it("announces check", () => {
    // 1. e4 f5 2. Qh5+ — check, not mate (g6 blocks).
    const before = play(["e2", "e4"], ["f7", "f5"]);
    expect(announce(before, { from: at("d1"), to: at("h5") }, "b"))
      .toBe("Ben moved queen to h5. Check. Your turn.");
  });

  it("announces checkmate and who won", () => {
    const before = play(["f2", "f3"], ["e7", "e5"], ["g2", "g4"]);
    expect(announce(before, { from: at("d8"), to: at("h4") }, "w"))
      .toBe("Ben moved queen to h4. Checkmate — Ben wins.");
    expect(announce(before, { from: at("d8"), to: at("h4") }, "b"))
      .toBe("You moved queen to h4. Checkmate — you win!");
  });

  it("announces castling and en passant", () => {
    const castle = fromFen("r3k2r/8/8/8/8/8/8/R3K2R w KQkq - 0 1");
    expect(announce(castle, { from: at("e1"), to: at("g1") }, "b")).toBe("Ben castled kingside. Your turn.");
    expect(announce(castle, { from: at("e1"), to: at("c1") }, "w")).toBe("You castled queenside.");
    const ep = play(["e2", "e4"], ["a7", "a6"], ["e4", "e5"], ["d7", "d5"]);
    expect(announce(ep, { from: at("e5"), to: at("d6") }, "w")).toBe("You moved pawn to d6 and took the pawn en passant.");
  });

  it("announces a promotion to a knight", () => {
    const s = fromFen("7k/P6p/8/8/8/8/8/K7 w - - 0 1");
    expect(announce(s, { from: at("a7"), to: at("a8"), promotion: "N" }, "b"))
      .toBe("Ben moved pawn to a8 and promoted to a knight. Your turn.");
  });

  it("announces draw offers, answers and resignations", () => {
    const s = initialState();
    const say = (before: GameState, ply: Ply, me: "w" | "b"): string =>
      moveAnnouncement({ before, after: applyPly(before, ply), move: ply, myColor: me, opponentName: "Ben" });
    expect(say(s, { action: "offer-draw", by: "w" }, "b")).toBe("Ben offers a draw.");
    expect(say(s, { action: "offer-draw", by: "w" }, "w")).toBe("You offered a draw.");
    const offered = applyMove(applyPly(s, { action: "offer-draw", by: "w" }), { from: at("e2"), to: at("e4") });
    expect(say(offered, { action: "decline-draw", by: "b" }, "w")).toBe("Ben declined your draw offer.");
    expect(say(offered, { action: "accept-draw", by: "b" }, "w")).toBe("Ben accepted your draw offer. Draw agreed.");
    expect(say(offered, { action: "resign", by: "b" }, "w")).toBe("Ben resigned — you win!");
    expect(say(offered, { action: "resign", by: "w" }, "w")).toBe("You resigned — Ben wins.");
  });

  // endingText names every way a game ends.
  const end = (fen: string, ...moves: [string, string, Move["promotion"]?][]): GameState => {
    let s = fromFen(fen);
    for (const [f, to, p] of moves) s = applyMove(s, p ? { from: at(f), to: at(to), promotion: p } : { from: at(f), to: at(to) });
    return s;
  };

  it("endingText: checkmate, stalemate, insufficient material, the 50-move rule", () => {
    const mate = play(["f2", "f3"], ["e7", "e5"], ["g2", "g4"], ["d8", "h4"]);
    expect(endingText(mate, "w", "Ben")).toBe("Checkmate — Ben wins.");
    expect(endingText(end("k7/8/1Q6/8/8/8/8/K7 w - - 0 1", ["b6", "c7"]), "w", "Ben")).toBe("Stalemate — it's a draw.");
    expect(endingText(end("4k3/8/8/8/8/8/3r4/4K3 w - - 0 1", ["e1", "d2"]), "w", "Ben")).toMatch(/^Draw: neither side/);
    expect(endingText(end("4k3/8/8/8/8/8/R7/4K3 w - - 99 80", ["a2", "b2"]), "w", "Ben")).toMatch(/^Draw by the 50-move rule/);
  });

  it("endingText: repetition and an ongoing game", () => {
    const rep = play(["g1", "f3"], ["g8", "f6"], ["f3", "g1"], ["f6", "g8"], ["g1", "f3"], ["g8", "f6"], ["f3", "g1"], ["f6", "g8"]);
    expect(endingText(rep, "b", "Ben")).toBe("Draw by repetition: the same position came up three times.");
    expect(endingText(initialState(), "w", "Ben")).toBe("");
  });

  it("a king in check is marked on its square", () => {
    const check = play(["e2", "e4"], ["f7", "f6"], ["d1", "h5"]);
    expect(checkedKing(check)).toBe(at("e8"));
    expect(squareLabel(check, at("e8"))).toBe("e8, black king, in check");
    expect(checkedKing(initialState())).toBe(-1);
  });

  it("announces promotion", () => {
    const board = emptyBoard();
    board[at("a7")] = { type: "P", color: "w" };
    board[at("e1")] = { type: "K", color: "w" };
    board[at("h6")] = { type: "K", color: "b" };
    const before: GameState = positionOf(board, "w");
    expect(announce(before, { from: at("a7"), to: at("a8"), promotion: "Q" }, "b"))
      .toBe("Ben moved pawn to a8 and promoted to a queen. Your turn.");
  });

  it("falls back when the earlier position doesn't hold the piece (resync)", () => {
    const after = play(["g1", "f3"]);
    const text = moveAnnouncement({
      before: { ...initialState(), board: emptyBoard() },
      after,
      move: { from: at("g1"), to: at("f3") },
      myColor: "b",
      opponentName: "Ben",
    });
    expect(text).toBe("Ben made a move. Your turn.");
  });
});

describe("in the person's language", () => {
  afterEach(() => setLocale("en"));

  function announce(before: GameState, move: Move, myColor: "w" | "b"): string {
    return moveAnnouncement({ before, after: applyMove(before, move), move, myColor, opponentName: "Ben" });
  }

  it("German: squares, board, picking up and moves", () => {
    setLocale("de");
    const s = initialState();
    expect(squareLabel(s, at("d8"), { selected: true })).toBe("d8, schwarze Dame, ausgewählt");
    expect(boardLabel("b")).toBe("Schachbrett, du spielst Schwarz");
    expect(selectionAnnouncement(s, at("g1"), [at("h3"), at("f3")])).toBe("Springer auf g1. Züge nach f3 und h3.");
    expect(announce(s, { from: at("g1"), to: at("f3") }, "b")).toBe("Zug von Ben: Springer nach f3. Du bist dran.");
    const before = play(["e2", "e4"], ["d7", "d5"]);
    expect(announce(before, { from: at("e4"), to: at("d5") }, "w")).toBe("Dein Zug: Bauer nach d5, schlägt Bauer.");
    expect(noneAnnouncement("not-your-turn", "Ben")).toBe("Ben ist dran.");
    expect(boardHint()).toMatch(/Pfeiltasten/);
    expect(selectionCleared()).toBe("Auswahl aufgehoben.");
  });

  it("French and Spanish capitalise the piece that leads", () => {
    setLocale("fr");
    expect(selectionAnnouncement(initialState(), at("a1"), [])).toBe("Tour en a1. Aucun coup possible.");
    setLocale("es");
    expect(selectionAnnouncement(initialState(), at("e2"), [at("e3")])).toBe("Peón en e2. Puede ir a e3.");
  });
});
