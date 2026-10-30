/**
 * Judging a move that another household's chess sent us.
 *
 * Our copy of a game is ours: a message can only ever add ONE move to the
 * history we already have. That move must be the opponent's (never ours),
 * legal from the current position, and the message's move list must be our
 * list plus that move. The board, the side to move and the result are always
 * rebuilt here by replaying the moves through our own engine — nothing the
 * sender says about the board or the outcome is taken.
 *
 * Every chess version sends the same shape, `{type: "move", sessionId, move,
 * state}` with the whole game in `state`. Only `state.history` and `move` are
 * read; a message with just a `move` is taken as our list plus that move.
 */

import { applyMove, initialState } from "./chess.js";
import type { AppMessage } from "@socialhome/app-sdk";
import type { Color, GameState, Move, PieceType } from "./chess.js";
import { fromOpponent } from "./lifecycle.js";
import type { GameEntry } from "./lifecycle.js";

/** Why a message was refused (for the log; the notice is the same for all). */
export type RefuseReason =
  /** Not a move message chess can read. */
  | "malformed"
  /** Its moves differ from the ones we already have. */
  | "rewrite"
  /** A move in it is not allowed from its position (or after the game ended). */
  | "illegal"
  /** The new move is for our colour: the opponent can't move our pieces. */
  | "wrong-colour"
  /** It adds more than one move (one of them would be ours). */
  | "too-many"
  /** Its `move` is not the last move of its own list. */
  | "inconsistent";

export type InboundVerdict =
  /** Take this state (built here) — it adds `move`, the opponent's. */
  | { kind: "apply"; state: GameState; move: Move }
  /** A copy of moves we already have: nothing to do, nothing to say. */
  | { kind: "stale" }
  /** Keep our game as it is. */
  | { kind: "refuse"; reason: RefuseReason };

const PROMOTIONS: readonly PieceType[] = ["Q", "R", "B", "N"];

function isSquare(v: unknown): v is number {
  return typeof v === "number" && Number.isInteger(v) && v >= 0 && v < 64;
}

/** A clean `Move` from untrusted input, or `null`. */
export function parseMove(v: unknown): Move | null {
  if (typeof v !== "object" || v === null) return null;
  const r = v as Record<string, unknown>;
  if (!isSquare(r["from"]) || !isSquare(r["to"])) return null;
  const promotion = r["promotion"];
  if (promotion === undefined || promotion === null) return { from: r["from"], to: r["to"] };
  if (!PROMOTIONS.includes(promotion as PieceType)) return null;
  return { from: r["from"], to: r["to"], promotion: promotion as PieceType };
}

/** A clean move list from untrusted input, or `null` if any entry is bad. */
function parseHistory(v: unknown): Move[] | null {
  if (!Array.isArray(v)) return null;
  const out: Move[] = [];
  for (const item of v) {
    const mv = parseMove(item);
    if (!mv) return null;
    out.push(mv);
  }
  return out;
}

export function sameMove(a: Move, b: Move): boolean {
  return a.from === b.from && a.to === b.to && (a.promotion ?? null) === (b.promotion ?? null);
}

/**
 * Decide what an inbound move message does to our copy of the game.
 * Pure and total: never throws, whatever the payload holds.
 */
export function judgeInbound(local: GameState, myColor: Color, payload: unknown): InboundVerdict {
  if (typeof payload !== "object" || payload === null) return { kind: "refuse", reason: "malformed" };
  const p = payload as Record<string, unknown>;
  if (p["type"] !== "move") return { kind: "refuse", reason: "malformed" };

  const rawMove = p["move"];
  const move = rawMove === undefined ? null : parseMove(rawMove);
  if (rawMove !== undefined && !move) return { kind: "refuse", reason: "malformed" };

  const state = p["state"];
  let history: Move[] | null;
  if (typeof state === "object" && state !== null) {
    history = parseHistory((state as Record<string, unknown>)["history"]);
    if (!history) return { kind: "refuse", reason: "malformed" };
  } else if (state === undefined && move) {
    history = [...local.history, move];
  } else {
    return { kind: "refuse", reason: "malformed" };
  }

  if (move && (history.length === 0 || !sameMove(move, history[history.length - 1]))) {
    return { kind: "refuse", reason: "inconsistent" };
  }

  // Our past must be its past.
  const ours = local.history;
  const shared = Math.min(ours.length, history.length);
  for (let i = 0; i < shared; i++) {
    if (!sameMove(ours[i], history[i])) return { kind: "refuse", reason: "rewrite" };
  }
  if (history.length <= ours.length) return { kind: "stale" };

  // One new move at most (checked first, so a huge forged list costs nothing).
  if (history.length - ours.length > 1) return { kind: "refuse", reason: "too-many" };

  // Replay every move from the start through our own engine.
  const replay = replayMoves(history);
  if (!replay) return { kind: "refuse", reason: "illegal" };

  // After the opponent's move it is our turn; otherwise the move was ours.
  if (replay.sideToMove !== myColor) return { kind: "refuse", reason: "wrong-colour" };

  return { kind: "apply", state: replay, move: history[history.length - 1] };
}

/** Play `history` from the start through our engine; `null` if a move isn't allowed. */
function replayMoves(history: readonly Move[]): GameState | null {
  let state = initialState();
  for (const mv of history) {
    try {
      state = applyMove(state, mv);
    } catch {
      return null;
    }
  }
  return state;
}

/**
 * Our own saved copy of a game (this person's store) when it is ahead of the
 * copy on this screen — the same person moved on another screen. Rebuilt by
 * replay; `null` unless it is legal and extends this screen's moves.
 */
export function catchUpFromOwnCopy(local: GameState, stored: unknown): GameState | null {
  if (typeof stored !== "object" || stored === null) return null;
  const history = parseHistory((stored as Record<string, unknown>)["history"]);
  if (!history || history.length <= local.history.length) return null;
  if (!local.history.every((mv, i) => sameMove(mv, history[i]))) return null;
  return replayMoves(history);
}

/** Where an inbound message goes: the game Social Home delivered it in. */
export type InboundRoute =
  | { kind: "game"; entry: GameEntry }
  | { kind: "drop"; reason: "unknown-game" | "not-opponent" };

/**
 * Social Home has checked that `msg.sessionId` is a game the sender plays
 * with this person; the `sessionId` inside the payload is the sender's word
 * only and is ignored. The message must also come from that game's opponent.
 */
export function routeInbound(msg: AppMessage, games: ReadonlyMap<string, GameEntry>): InboundRoute {
  const entry = games.get(msg.sessionId);
  if (!entry) return { kind: "drop", reason: "unknown-game" };
  if (!fromOpponent(entry, msg)) return { kind: "drop", reason: "not-opponent" };
  return { kind: "game", entry };
}
