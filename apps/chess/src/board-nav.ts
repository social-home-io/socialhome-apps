/**
 * Keyboard + screen-reader logic for the chess board (pure, no DOM).
 *
 * The board is an ARIA grid with one tab stop (roving tabindex): the
 * "cursor" square carries tabindex=0, every other square -1. Arrow keys move
 * the cursor in *screen* space (Up is always toward the top of the board as
 * drawn, which is rank 1 when you play Black), Enter/Space activates the
 * cursor square — the same `activateSquare` decision a mouse click uses —
 * and Escape cancels a selection.
 *
 * All user-facing copy for the board lives here as small functions (the
 * same pattern as lifecycle.ts), English for now.
 */

import {
  isInCheck,
  legalMoves,
  rowOf,
  squareName,
} from "./chess.js";
import type { Color, GameState, Move, PieceType } from "./chess.js";

export const PIECE_NAMES: Record<PieceType, string> = {
  K: "king", Q: "queen", R: "rook", B: "bishop", N: "knight", P: "pawn",
};

const COLOR_NAMES: Record<Color, string> = { w: "white", b: "black" };

// ---------------------------------------------------------------------------
// Orientation + cursor movement
// ---------------------------------------------------------------------------

/**
 * Square indices in the order they are drawn (row-major, top-left first).
 * White: a8 … h1 (standard). Black: h1 … a8 (flipped, Black's pieces near
 * the player).
 */
export function buildSquareOrder(myColor: Color): number[] {
  const indices: number[] = [];
  if (myColor === "w") {
    for (let i = 0; i < 64; i++) indices.push(i);
  } else {
    for (let r = 7; r >= 0; r--) {
      for (let c = 7; c >= 0; c--) indices.push(r * 8 + c);
    }
  }
  return indices;
}

/** Keys the board handles for cursor movement. */
export type NavKey =
  | "ArrowUp" | "ArrowDown" | "ArrowLeft" | "ArrowRight"
  | "Home" | "End" | "PageUp" | "PageDown";

const NAV_KEYS: ReadonlySet<string> = new Set([
  "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight",
  "Home", "End", "PageUp", "PageDown",
]);

export function isNavKey(key: string): key is NavKey {
  return NAV_KEYS.has(key);
}

/**
 * Where the cursor goes from `square` on `key`, in screen space for the
 * player's orientation. Edges clamp (no wrap), like an ARIA data grid.
 * Home/End jump to the start/end of the drawn row; with `ctrl`, to the
 * first/last drawn square. PageUp/PageDown jump to the top/bottom row.
 */
export function moveCursor(
  square: number,
  key: NavKey,
  myColor: Color,
  ctrl = false,
): number {
  const order = buildSquareOrder(myColor);
  const pos = order.indexOf(square);
  let vr = Math.floor(pos / 8);
  let vc = pos % 8;
  switch (key) {
    case "ArrowUp": vr = Math.max(0, vr - 1); break;
    case "ArrowDown": vr = Math.min(7, vr + 1); break;
    case "ArrowLeft": vc = Math.max(0, vc - 1); break;
    case "ArrowRight": vc = Math.min(7, vc + 1); break;
    case "Home": vc = 0; if (ctrl) vr = 0; break;
    case "End": vc = 7; if (ctrl) vr = 7; break;
    case "PageUp": vr = 0; break;
    case "PageDown": vr = 7; break;
  }
  return order[vr * 8 + vc];
}

/**
 * The square the cursor starts on when a board opens: where the last move
 * landed (what changed), else the player's king-side centre pawn (e2 / e7).
 */
export function initialCursor(state: GameState, myColor: Color): number {
  const last = state.history.length ? state.history[state.history.length - 1] : null;
  if (last) return last.to;
  return myColor === "w" ? 52 /* e2 */ : 12 /* e7 */;
}

// ---------------------------------------------------------------------------
// Selection (shared by click and Enter/Space)
// ---------------------------------------------------------------------------

export type SelectionAction =
  | { kind: "select"; square: number; targets: number[] }
  | { kind: "move"; move: Move }
  | { kind: "clear" }
  | { kind: "none"; reason: "game-over" | "not-your-turn" | "not-your-piece" };

/**
 * What activating `square` does, given the current selection. Pure: the
 * caller applies the result (and the announcement) to its UI state.
 *  - nothing selected: your piece → select it (even with no legal moves, so
 *    the player hears why nothing lights up); anything else → none.
 *  - the selected square again → clear (toggle off).
 *  - a legal target → move (pawns reaching the last rank promote to a queen).
 *  - another of your pieces → select it instead.
 *  - anything else → clear.
 */
export function activateSquare(
  state: GameState,
  myColor: Color,
  selected: number | null,
  targets: readonly number[],
  square: number,
): SelectionAction {
  if (state.result !== null) return { kind: "none", reason: "game-over" };
  if (state.sideToMove !== myColor) return { kind: "none", reason: "not-your-turn" };

  const piece = state.board[square];
  const mine = piece !== null && piece.color === myColor;

  if (selected === null) {
    if (!mine) return { kind: "none", reason: "not-your-piece" };
    return { kind: "select", square, targets: legalMoves(state, square).map((m) => m.to) };
  }
  if (square === selected) return { kind: "clear" };
  if (targets.includes(square)) {
    const move: Move = { from: selected, to: square };
    const moving = state.board[selected];
    if (moving?.type === "P" && rowOf(square) === (moving.color === "w" ? 0 : 7)) {
      move.promotion = "Q";
    }
    return { kind: "move", move };
  }
  if (mine) {
    return { kind: "select", square, targets: legalMoves(state, square).map((m) => m.to) };
  }
  return { kind: "clear" };
}

// ---------------------------------------------------------------------------
// Copy: square names + announcements
// ---------------------------------------------------------------------------

/** "white knight" / "empty". */
export function pieceLabel(state: GameState, square: number): string {
  const piece = state.board[square];
  return piece ? `${COLOR_NAMES[piece.color]} ${PIECE_NAMES[piece.type]}` : "empty";
}

/**
 * The accessible name of a square: "e4, white knight" / "e4, empty", plus
 * ", selected", ", legal move" and ", last move" when they apply — so a
 * screen reader hears the same state a sighted player sees as colour.
 */
export function squareLabel(
  state: GameState,
  square: number,
  flags: { selected?: boolean; legalTarget?: boolean; lastMove?: boolean } = {},
): string {
  const parts = [squareName(square), pieceLabel(state, square)];
  if (flags.selected) parts.push("selected");
  if (flags.legalTarget) parts.push("legal move");
  if (flags.lastMove) parts.push("last move");
  return parts.join(", ");
}

/** The board's accessible name: "Chess board, you play White". */
export function boardLabel(myColor: Color): string {
  return `Chess board, you play ${myColor === "w" ? "White" : "Black"}`;
}

/** How-to hint, linked from the board with aria-describedby. */
export const BOARD_HINT =
  "Use the arrow keys to move between squares. Press Enter or Space to pick up a piece, then again on the square to move it to. Press Escape to put it back.";

/** Ordered square names, e.g. "f3 and h3" / "d3, e3 and f3". */
function listSquares(squares: readonly number[]): string {
  const names = squares.map(squareName).sort();
  if (names.length <= 1) return names.join("");
  return `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}

/** Spoken when a piece is picked up: "Knight on g1. Moves to f3 and h3." */
export function selectionAnnouncement(
  state: GameState,
  square: number,
  targets: readonly number[],
): string {
  const piece = state.board[square];
  const name = piece ? PIECE_NAMES[piece.type] : "piece";
  const lead = `${name[0].toUpperCase()}${name.slice(1)} on ${squareName(square)}.`;
  if (targets.length === 0) return `${lead} It has no legal moves.`;
  return `${lead} ${targets.length === 1 ? "Move" : "Moves"} to ${listSquares(targets)}.`;
}

export const SELECTION_CLEARED = "Selection cleared.";

/** Spoken when Enter/Space does nothing, so the key press isn't silent. */
export function noneAnnouncement(
  reason: "game-over" | "not-your-turn" | "not-your-piece",
  opponentName: string,
): string {
  switch (reason) {
    case "game-over": return "The game is over.";
    case "not-your-turn": return `It's ${opponentName}'s turn.`;
    case "not-your-piece": return "Pick one of your own pieces first.";
  }
}

/**
 * What happened on a half-move, for the live region:
 *   "Ben moved knight to f3."           (opponent)
 *   "You moved pawn to e4."             (you)
 *   "… and took the bishop." / "… and promoted to a queen."
 *   then "Check.", "Checkmate. Ben wins." / "Stalemate, it's a draw.",
 *   or "Your turn." when the move hands you the turn.
 *
 * `before` is the position the move was played from; `after` the result. If
 * `before` doesn't hold the moving piece (a resync that skipped moves) the
 * sentence falls back to "Ben made a move."
 */
export function moveAnnouncement(args: {
  before: GameState;
  after: GameState;
  move: Move;
  myColor: Color;
  opponentName: string;
}): string {
  const { before, after, move, myColor, opponentName } = args;
  const moving = before.board[move.from];
  const byMe = moving ? moving.color === myColor : after.sideToMove !== myColor;
  const mover = byMe ? "You" : opponentName;

  const parts: string[] = [];
  if (moving) {
    let s = `${mover} moved ${PIECE_NAMES[moving.type]} to ${squareName(move.to)}`;
    const taken = before.board[move.to];
    if (taken && taken.color !== moving.color) s += ` and took the ${PIECE_NAMES[taken.type]}`;
    if (move.promotion) s += `${taken ? "," : ""} and promoted to a ${PIECE_NAMES[move.promotion]}`;
    parts.push(`${s}.`);
  } else {
    parts.push(`${mover} made a move.`);
  }

  if (after.result === "draw") {
    parts.push("Stalemate, it's a draw.");
  } else if (after.result !== null) {
    const iWon = (after.result === "white") === (myColor === "w");
    parts.push(iWon ? "Checkmate. You win." : `Checkmate. ${opponentName} wins.`);
  } else {
    if (isInCheck(after.board, after.sideToMove)) parts.push("Check.");
    if (after.sideToMove === myColor) parts.push("Your turn.");
  }
  return parts.join(" ");
}

