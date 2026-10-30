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
 * same pattern as lifecycle.ts), in the person's language (i18n.ts). Square
 * names ("e4") stay as they are in every language.
 */

import {
  colOf,
  findKing,
  isBoardMove,
  isCastling,
  isEnPassant,
  isInCheck,
  lastMove,
  legalMoves,
  needsPromotion,
  squareName,
} from "./chess.js";
import type { Color, GameState, Move, PieceType, Ply } from "./chess.js";
import { t } from "./i18n.js";
import type { MessageKey } from "./i18n.js";

/** "knight" — a piece's name in the person's language, mid-sentence. */
export function pieceName(type: PieceType): string {
  return t(`piece.${type}` as MessageKey);
}

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
  const last = lastMove(state);
  if (last) return last.to;
  return myColor === "w" ? 52 /* e2 */ : 12 /* e7 */;
}

// ---------------------------------------------------------------------------
// Selection (shared by click and Enter/Space)
// ---------------------------------------------------------------------------

export type SelectionAction =
  | { kind: "select"; square: number; targets: number[] }
  | { kind: "move"; move: Move }
  /** A pawn reaches the last rank: ask which piece it becomes, then move. */
  | { kind: "promote"; from: number; to: number }
  | { kind: "clear" }
  | { kind: "none"; reason: "game-over" | "not-your-turn" | "not-your-piece" };

/**
 * What activating `square` does, given the current selection. Pure: the
 * caller applies the result (and the announcement) to its UI state.
 *  - nothing selected: your piece → select it (even with no legal moves, so
 *    the player hears why nothing lights up); anything else → none.
 *  - the selected square again → clear (toggle off).
 *  - a legal target → move (castling is the king's two-square move); a pawn
 *    reaching the last rank → promote (the caller asks for the piece).
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
    return { kind: "select", square, targets: targetsOf(state, square) };
  }
  if (square === selected) return { kind: "clear" };
  if (targets.includes(square)) {
    if (needsPromotion(state, selected, square)) return { kind: "promote", from: selected, to: square };
    return { kind: "move", move: { from: selected, to: square } };
  }
  if (mine) {
    return { kind: "select", square, targets: targetsOf(state, square) };
  }
  return { kind: "clear" };
}

/** The squares a piece can go to (a promotion square once, not per piece). */
export function targetsOf(state: GameState, square: number): number[] {
  return [...new Set(legalMoves(state, square).map((m) => m.to))];
}

// ---------------------------------------------------------------------------
// Copy: square names + announcements
// ---------------------------------------------------------------------------

/** "white knight" / "empty". */
export function pieceLabel(state: GameState, square: number): string {
  const piece = state.board[square];
  return piece ? t(`pc.${piece.color}${piece.type}` as MessageKey) : t("sq.empty");
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
  if (square === checkedKing(state)) parts.push(t("sq.check"));
  if (flags.selected) parts.push(t("sq.selected"));
  if (flags.legalTarget) parts.push(t("sq.legal"));
  if (flags.lastMove) parts.push(t("sq.last"));
  return parts.join(", ");
}

/** The square of a king in check (the side to move's), or -1. */
export function checkedKing(state: GameState): number {
  if (state.ending === "checkmate" || (state.result === null && isInCheck(state.board, state.sideToMove))) {
    return findKing(state.board, state.sideToMove);
  }
  return -1;
}

/** The board's accessible name: "Chess board, you play White". */
export function boardLabel(myColor: Color): string {
  return t(myColor === "w" ? "board.label.w" : "board.label.b");
}

/** How-to hint, linked from the board with aria-describedby. */
export function boardHint(): string {
  return t("board.hint");
}

/** Ordered square names, e.g. "f3 and h3" / "d3, e3 and f3". */
function listSquares(squares: readonly number[]): string {
  const names = squares.map(squareName).sort();
  if (names.length <= 1) return names.join("");
  return t("list.and", { first: names.slice(0, -1).join(", "), last: names[names.length - 1] });
}

/** Spoken when a piece is picked up: "Knight on g1. Moves to f3 and h3." */
export function selectionAnnouncement(
  state: GameState,
  square: number,
  targets: readonly number[],
): string {
  const piece = state.board[square];
  const name = piece ? pieceName(piece.type) : t("piece.any");
  const lead = t("sel.lead", { Piece: `${name[0].toUpperCase()}${name.slice(1)}`, square: squareName(square) });
  if (targets.length === 0) return `${lead} ${t("sel.noMoves")}`;
  return `${lead} ${t(targets.length === 1 ? "sel.oneMove" : "sel.moves", { squares: listSquares(targets) })}`;
}

/** Spoken when a picked-up piece is put back. */
export function selectionCleared(): string {
  return t("sel.cleared");
}

/** Spoken when Enter/Space does nothing, so the key press isn't silent. */
export function noneAnnouncement(
  reason: "game-over" | "not-your-turn" | "not-your-piece",
  opponentName: string,
): string {
  switch (reason) {
    case "game-over": return t("none.over");
    case "not-your-turn": return t("none.notYourTurn", { name: opponentName });
    case "not-your-piece": return t("none.notYourPiece");
  }
}

/**
 * How the game ended, as one sentence for the status line and the live
 * region: "Checkmate — you win!", "Draw by repetition: …", "Ben resigned —
 * you win!". Empty while the game goes on.
 */
export function endingText(state: GameState, myColor: Color, opponentName: string): string {
  if (state.result === null) return "";
  const name = opponentName;
  const iWon = state.result !== "draw" && (state.result === "white") === (myColor === "w");
  switch (state.ending) {
    case "resign":
      return iWon ? t("end.resignWon", { name }) : t("end.resignLost", { name });
    case "stalemate":
      return t("end.stalemate");
    case "repetition":
      return t("end.repetition");
    case "fifty-moves":
      return t("end.fiftyMoves");
    case "insufficient":
      return t("end.insufficient");
    case "agreement":
      return t("end.agreement");
    default:
      // Checkmate — and games saved before endings had names.
      if (state.result === "draw") return t("end.stalemate");
      return iWon ? t("end.checkmateWon") : t("end.checkmateLost", { name });
  }
}

/**
 * What happened on one history entry, for the live region:
 *   "Ben moved knight to f3."           (opponent)
 *   "You moved pawn to e4."             (you)
 *   "… and took the bishop." / "… and promoted to a knight." /
 *   "… and took the pawn en passant." / "Ben castled kingside."
 *   "Ben offers a draw." / "Ben declined your draw offer."
 *   then the ending ("Checkmate — Ben wins.", "Draw by repetition: …"),
 *   or "Check." and "Your turn." when they apply.
 *
 * `before` is the position the entry was played from; `after` the result. If
 * `before` doesn't hold the moving piece (a resync that skipped moves) the
 * sentence falls back to "Ben made a move."
 */
export function moveAnnouncement(args: {
  before: GameState;
  after: GameState;
  move: Ply;
  myColor: Color;
  opponentName: string;
}): string {
  const { before, after, move, myColor, opponentName } = args;
  const name = opponentName;
  const parts: string[] = [];

  if (!isBoardMove(move)) {
    const mine = move.by === myColor;
    switch (move.action) {
      case "offer-draw": parts.push(mine ? t("act.offerMe") : t("act.offerThem", { name })); break;
      case "decline-draw": parts.push(mine ? t("act.declineMe") : t("act.declineThem", { name })); break;
      case "accept-draw": parts.push(mine ? t("act.acceptMe") : t("act.acceptThem", { name })); break;
      case "resign": break; // the ending says it
    }
  } else {
    const moving = before.board[move.from];
    const byMe = moving ? moving.color === myColor : after.sideToMove !== myColor;
    if (moving && isCastling(before.board, move)) {
      const kingSide = colOf(move.to) > colOf(move.from);
      const key = kingSide ? (byMe ? "move.castleKMe" : "move.castleKThem") : (byMe ? "move.castleQMe" : "move.castleQThem");
      parts.push(`${t(key, { name })}${t("move.end")}`);
    } else if (moving) {
      const where = { name, piece: pieceName(moving.type), square: squareName(move.to) };
      let s = t(byMe ? "move.byMe" : "move.byThem", where);
      const taken = before.board[move.to];
      if (isEnPassant(before, move)) s += t("move.enPassant");
      else if (taken && taken.color !== moving.color) s += t("move.took", { piece: pieceName(taken.type) });
      if (move.promotion) {
        s += t(taken ? "move.promotedAfterTake" : "move.promoted", { piece: pieceName(move.promotion) });
      }
      parts.push(`${s}${t("move.end")}`);
    } else {
      parts.push(byMe ? t("move.madeByMe") : t("move.madeByThem", { name }));
    }
  }

  if (after.result !== null) {
    if (before.result === null) parts.push(endingText(after, myColor, name));
  } else if (isBoardMove(move)) {
    if (isInCheck(after.board, after.sideToMove)) parts.push(t("ann.check"));
    if (after.sideToMove === myColor) parts.push(t("ann.yourTurn"));
  }
  return parts.join(" ");
}
