/**
 * Judging a message that another household's chess sent us.
 *
 * Our copy of a game is ours. A message can only add entries to the history
 * we already have, and every new entry must be the opponent's (never ours):
 * their move, their draw offer or its answer, or their resignation — at
 * most `MAX_NEW` of them, since the latest message of a game is all Social
 * Home keeps while chess is closed (a move and then a draw offer arrive as
 * one). The board, the side to move and the result are always rebuilt here
 * by replaying the whole history through our own engine (chess.ts) — the
 * same rules on both sides; nothing the sender says about the board or the
 * outcome is taken.
 *
 * One race is resolved rather than refused: resigning is allowed on either
 * turn, so a resignation can cross a move in flight. When the only
 * difference is the other player's resignation against our own new entries
 * (or ours against theirs), both sides end with the moves first and the
 * resignation last, as long as the game was still running.
 *
 * Every chess version sends the same shape, `{type: "move", sessionId, move,
 * state}` with the whole game in `state`. Only `state.history` and `move` (the
 * latest entry) are read; a message with just a `move` is taken as our list
 * plus that entry.
 */

import { GAME_ACTIONS, actorOf, applyPly, initialState, isBoardMove, opponent } from "./chess.js";
import type { AppMessage } from "@socialhome/app-sdk";
import type { ActionPly, Color, GameAction, GameState, Move, PieceType, Ply } from "./chess.js";
import { fromOpponent } from "./lifecycle.js";
import type { GameEntry } from "./lifecycle.js";

/** Why a message was refused (for the log; the notice is the same for all). */
export type RefuseReason =
  /** Not a move message chess can read. */
  | "malformed"
  /** Its history differs from the one we already have. */
  | "rewrite"
  /** An entry in it is not allowed from its position (or after the game ended). */
  | "illegal"
  /** A new entry is ours: the opponent can't move our pieces or speak for us. */
  | "wrong-colour"
  /** It adds more entries than one turn of the opponent can. */
  | "too-many"
  /** Its `move` is not the last entry of its own history. */
  | "inconsistent";

export type InboundVerdict =
  /** Take this state (built here). `added` are the opponent's new entries, `move` the last. */
  | { kind: "apply"; state: GameState; move: Ply; added: Ply[] }
  /** A copy of entries we already have: nothing to do, nothing to say. */
  | { kind: "stale" }
  /** Keep our game as it is. */
  | { kind: "refuse"; reason: RefuseReason };

/**
 * The most entries one message may add: the opponent's answer to our draw
 * offer, their move, their own offer and their resignation.
 */
export const MAX_NEW = 4;

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

/** A clean history entry (a move or an action) from untrusted input, or `null`. */
export function parsePly(v: unknown): Ply | null {
  if (typeof v !== "object" || v === null) return null;
  const r = v as Record<string, unknown>;
  if (r["action"] === undefined) return parseMove(v);
  if (!GAME_ACTIONS.includes(r["action"] as GameAction)) return null;
  if (r["by"] !== "w" && r["by"] !== "b") return null;
  return { action: r["action"] as GameAction, by: r["by"] };
}

/** A clean history from untrusted input, or `null` if any entry is bad. */
function parseHistory(v: unknown): Ply[] | null {
  if (!Array.isArray(v)) return null;
  const out: Ply[] = [];
  for (const item of v) {
    const ply = parsePly(item);
    if (!ply) return null;
    out.push(ply);
  }
  return out;
}

export function samePly(a: Ply, b: Ply): boolean {
  if (isBoardMove(a) && isBoardMove(b)) {
    return a.from === b.from && a.to === b.to && (a.promotion ?? null) === (b.promotion ?? null);
  }
  if (!isBoardMove(a) && !isBoardMove(b)) return a.action === b.action && a.by === b.by;
  return false;
}

/** @deprecated name kept for older callers: same as `samePly`. */
export const sameMove = samePly;

/** A replay of a history, with who made each entry; `null` if one isn't allowed. */
interface Replay {
  state: GameState;
  actors: Color[];
}

function replay(history: readonly Ply[]): Replay | null {
  let state = initialState();
  const actors: Color[] = [];
  for (const ply of history) {
    try {
      actors.push(actorOf(state, ply));
      state = applyPly(state, ply);
    } catch {
      return null;
    }
  }
  return { state, actors };
}

const isResignBy = (ply: Ply | undefined, by: Color): boolean =>
  ply !== undefined && !isBoardMove(ply) && ply.action === "resign" && ply.by === by;

/**
 * Decide what an inbound message does to our copy of the game.
 * Pure and total: never throws, whatever the payload holds.
 */
export function judgeInbound(local: GameState, myColor: Color, payload: unknown): InboundVerdict {
  if (typeof payload !== "object" || payload === null) return { kind: "refuse", reason: "malformed" };
  const p = payload as Record<string, unknown>;
  if (p["type"] !== "move") return { kind: "refuse", reason: "malformed" };

  const rawMove = p["move"];
  const move = rawMove === undefined ? null : parsePly(rawMove);
  if (rawMove !== undefined && !move) return { kind: "refuse", reason: "malformed" };

  const state = p["state"];
  let history: Ply[] | null;
  if (typeof state === "object" && state !== null) {
    history = parseHistory((state as Record<string, unknown>)["history"]);
    if (!history) return { kind: "refuse", reason: "malformed" };
  } else if (state === undefined && move) {
    history = [...local.history, move];
  } else {
    return { kind: "refuse", reason: "malformed" };
  }

  if (move && (history.length === 0 || !samePly(move, history[history.length - 1]))) {
    return { kind: "refuse", reason: "inconsistent" };
  }

  const them = opponent(myColor);
  const ours = local.history;
  let shared = 0;
  while (shared < ours.length && shared < history.length && samePly(ours[shared], history[shared])) shared++;

  if (shared === history.length) return { kind: "stale" };
  if (shared < ours.length) return judgeResignRace(ours, history, shared, myColor);

  // Our past is its past: it adds entries, each of them the opponent's.
  const added = history.slice(ours.length);
  // Checked first, so a huge forged list costs nothing.
  if (added.length > MAX_NEW) return { kind: "refuse", reason: "too-many" };
  const r = replay(history);
  if (!r) return { kind: "refuse", reason: "illegal" };
  if (r.actors.slice(ours.length).some((c) => c !== them)) return { kind: "refuse", reason: "wrong-colour" };
  return { kind: "apply", state: r.state, move: added[added.length - 1], added };
}

/**
 * The two histories part after `shared` entries. Fine only when one side's
 * tail is just a resignation and the other's is the other player's own
 * entries made meanwhile: the result is those entries, then the resignation
 * (if the game was still running after them).
 */
function judgeResignRace(ours: readonly Ply[], theirs: readonly Ply[], shared: number, myColor: Color): InboundVerdict {
  const them = opponent(myColor);
  const ourTail = ours.slice(shared);
  const theirTail = theirs.slice(shared);
  if (theirTail.length > MAX_NEW || ourTail.length > MAX_NEW) return { kind: "refuse", reason: "rewrite" };
  const base = replay(ours.slice(0, shared));
  if (!base) return { kind: "refuse", reason: "rewrite" };

  const byOnly = (tail: readonly Ply[], who: Color): boolean => {
    let st = base.state;
    for (const ply of tail) {
      if (actorOf(st, ply) !== who) return false;
      try {
        st = applyPly(st, ply);
      } catch {
        return false;
      }
    }
    return true;
  };

  // They resigned while we added our own entries: ours first, then theirs.
  if (theirTail.length === 1 && isResignBy(theirTail[0], them) && byOnly(ourTail, myColor)) {
    const r = replay([...ours, theirTail[0]]);
    // Our own entries ended the game already (mate, an accepted draw): keep it.
    if (!r) return { kind: "stale" };
    return { kind: "apply", state: r.state, move: theirTail[0], added: [theirTail[0]] };
  }

  // We resigned while they added their entries: theirs first, then our resignation.
  if (ourTail.length === 1 && isResignBy(ourTail[0], myColor) && byOnly(theirTail, them)) {
    const moved = replay(theirs);
    if (!moved) return { kind: "refuse", reason: "illegal" };
    const resignation = ourTail[0] as ActionPly;
    const withResign = moved.state.result === null ? replay([...theirs, resignation]) : null;
    return {
      kind: "apply",
      state: (withResign ?? moved).state,
      move: theirTail[theirTail.length - 1],
      added: theirTail,
    };
  }
  return { kind: "refuse", reason: "rewrite" };
}

/** Play `history` from the start through our engine; `null` if an entry isn't allowed. */
function replayMoves(history: readonly Ply[]): GameState | null {
  return replay(history)?.state ?? null;
}

/**
 * Our saved copy of a game rebuilt from its history through today's engine
 * (castling rights, the draw offer and the rest follow from the moves), so
 * games saved by an older chess carry on. `null` when it can't be rebuilt.
 */
export function restoreState(stored: unknown): GameState | null {
  if (typeof stored !== "object" || stored === null) return null;
  const history = parseHistory((stored as Record<string, unknown>)["history"]);
  return history ? replayMoves(history) : null;
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
  if (!local.history.every((ply, i) => samePly(ply, history[i]))) return null;
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
