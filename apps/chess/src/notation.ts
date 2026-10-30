/**
 * Standard algebraic notation (SAN) and PGN for a game's history — the move
 * list, step-through replay and "Copy PGN" (pure, no DOM).
 *
 * SAN uses the English piece letters (K Q R B N) as PGN requires, in every
 * language: "e4", "Nf3", "exd6", "O-O", "e8=N+", "Qh4#".
 */
import {
  allLegalMoves,
  applyPly,
  colOf,
  initialState,
  isBoardMove,
  isCastling,
  isEnPassant,
  isInCheck,
  rowOf,
  squareName,
} from "./chess.js";
import type { Color, GameState, Move, Ply } from "./chess.js";

/** SAN of `move`, played on `state` (which must allow it). */
export function toSan(state: GameState, move: Move): string {
  const piece = state.board[move.from];
  if (!piece) return `${squareName(move.from)}-${squareName(move.to)}`;
  let san: string;
  if (isCastling(state.board, move)) {
    san = colOf(move.to) > colOf(move.from) ? "O-O" : "O-O-O";
  } else {
    const capture = state.board[move.to] !== null || isEnPassant(state, move);
    const to = squareName(move.to);
    if (piece.type === "P") {
      san = capture ? `${"abcdefgh"[colOf(move.from)]}x${to}` : to;
      if (move.promotion) san += `=${move.promotion}`;
    } else {
      // Tell apart two pieces of the same kind that can reach the square.
      const rivals = allLegalMoves(state).filter(
        (m) => m.to === move.to && m.from !== move.from && state.board[m.from]?.type === piece.type,
      );
      let which = "";
      if (rivals.length) {
        const sameFile = rivals.some((m) => colOf(m.from) === colOf(move.from));
        const sameRank = rivals.some((m) => rowOf(m.from) === rowOf(move.from));
        if (!sameFile) which = "abcdefgh"[colOf(move.from)];
        else if (!sameRank) which = String(8 - rowOf(move.from));
        else which = squareName(move.from);
      }
      san = `${piece.type}${which}${capture ? "x" : ""}${to}`;
    }
  }
  const after = applyPly(state, move);
  if (after.ending === "checkmate") san += "#";
  else if (isInCheck(after.board, after.sideToMove)) san += "+";
  return san;
}

/** One board move of a game, ready to show and to step to. */
export interface MoveRow {
  /** 1-based move number ("1." for White's and Black's first move). */
  number: number;
  color: Color;
  san: string;
  /** Index of this move in `history` (actions included). */
  historyIndex: number;
  /** The position after this move. */
  after: GameState;
}

/**
 * Every board move of a history with its SAN and the position after it
 * (actions such as a draw offer are skipped: they don't change the board).
 * Stops at the first entry the engine doesn't allow.
 */
export function moveRows(history: readonly Ply[]): MoveRow[] {
  const rows: MoveRow[] = [];
  let state = initialState();
  let count = 0;
  for (const [i, ply] of history.entries()) {
    try {
      if (isBoardMove(ply)) {
        const san = toSan(state, ply);
        const color = state.sideToMove;
        state = applyPly(state, ply);
        rows.push({ number: Math.floor(count / 2) + 1, color, san, historyIndex: i, after: state });
        count++;
      } else {
        state = applyPly(state, ply);
      }
    } catch {
      break;
    }
  }
  return rows;
}

/** The PGN result token of a game. */
export function pgnResult(state: GameState): string {
  switch (state.result) {
    case "white": return "1-0";
    case "black": return "0-1";
    case "draw": return "1/2-1/2";
    default: return "*";
  }
}

/** Escape a PGN tag value. */
const tag = (name: string, value: string): string => `[${name} "${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"]`;

/** The whole game as PGN, with the players' names. */
export function toPgn(state: GameState, white: string, black: string): string {
  const result = pgnResult(state);
  const headers = [
    tag("Event", "Social Home chess"),
    tag("Site", "Social Home"),
    tag("Date", "????.??.??"),
    tag("Round", "-"),
    tag("White", white),
    tag("Black", black),
    tag("Result", result),
  ];
  if (state.ending === "resign") headers.push(tag("Termination", "resignation"));
  const parts: string[] = [];
  for (const row of moveRows(state.history)) {
    if (row.color === "w") parts.push(`${row.number}.`);
    else if (parts.length === 0) parts.push(`${row.number}...`);
    parts.push(row.san);
  }
  parts.push(result);
  // Wrap the movetext at 80 characters, as PGN export format asks.
  const lines: string[] = [];
  let line = "";
  for (const p of parts) {
    if (line && line.length + 1 + p.length > 80) {
      lines.push(line);
      line = p;
    } else {
      line = line ? `${line} ${p}` : p;
    }
  }
  if (line) lines.push(line);
  return `${headers.join("\n")}\n\n${lines.join("\n")}\n`;
}
