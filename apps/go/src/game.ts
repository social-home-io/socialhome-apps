/**
 * One game of Go as a log of entries, replayed through the rules — pure.
 *
 * An entry is one step by one player:
 *   - a point index (`number`): a stone on that point, by the player to move
 *   - `"pass"`: the player to move passes; two in a row end play
 *   - a sorted list of points (`number[]`): while counting, the player to
 *     move marks those stones dead. The same list straight back from the
 *     other player is the agreement, and the game ends with the score
 *   - `"resume"`: while counting, the player to move goes back to play; the
 *     other player moves next
 *   - `"resign-b"` / `"resign-w"`: that player resigns (on either turn)
 *   - `"timeout-b"` / `"timeout-w"`: in a game with a clock, the player to
 *     move confirms their own time ran out (their Go adds it when the other
 *     player claims the win and its own records agree) — they lose on time
 *
 * Black moves first; with a handicap Black's stones start on the board
 * (rules.ts `handicapPoints`) and White moves first. After two passes the player to move (the first to
 * pass) marks first; marks then alternate until one side sends back exactly
 * the other's marking. Captures, ko, positional superko (no stone may
 * recreate any earlier whole-board position), suicide and the score are all
 * worked out here from the log — nothing else.
 */

import { BLACK, EMPTY, chainAt, emptyBoard, handicapPoints, isPoint, other, place, positionKey, scoreArea, stoneOf } from "./rules.js";
import type { AreaScore, Board, Color, PlaceError, Size } from "./rules.js";

export type Entry = number | "pass" | "resume" | "resign-b" | "resign-w" | "timeout-b" | "timeout-w" | number[];

/**
 * The fixed setup beyond the board size, chosen by the inviter: handicap
 * stones for Black (0 = none, else 2 … 9) and the clock in days per move
 * (0 = no clock).
 */
export interface Rules {
  handicap: number;
  days: number;
}

export const NO_RULES: Rules = { handicap: 0, days: 0 };

/** The longest log a game may have (moves, passes, marks, resumes). */
export const MAX_LOG = 1000;
/** Counting rounds (mark entries) a game may have; after that: agree, resume or resign. */
export const MAX_MARKS = 20;

export type Phase = "play" | "counting" | "over";

export type Result =
  | { winner: Color; by: "resign" }
  | { winner: Color; by: "time" }
  | { winner: Color; by: "score"; margin: number; score: AreaScore; dead: number[] };

export interface GameState {
  size: Size;
  handicap: number;
  /** Days per move; 0 = no clock. */
  days: number;
  board: Board;
  toMove: Color;
  phase: Phase;
  /** Passes in a row (play phase). */
  passes: number;
  /** Stones captured BY each colour. */
  captures: { b: number; w: number };
  /** Every position the board has been in (superko). */
  seen: ReadonlySet<string>;
  /** The latest stone played and the stones it took. */
  lastMove: number | null;
  lastCaptured: number[];
  /** While counting: the latest marking and who made it. */
  proposal: { by: Color; dead: number[] } | null;
  marks: number;
  /** Entries so far. */
  n: number;
  result: Result | null;
}

export type IllegalReason = PlaceError | "ko" | "turn" | "over" | "phase" | "mark" | "too-long" | "bad-entry";

export class IllegalMove extends Error {
  constructor(public reason: IllegalReason) {
    super(`illegal: ${reason}`);
  }
}

export function initialState(size: Size, rules: Rules = NO_RULES): GameState {
  const board = emptyBoard(size);
  const stones = handicapPoints(size, rules.handicap);
  for (const p of stones) board[p] = BLACK;
  return {
    size,
    handicap: stones.length,
    days: rules.days,
    board,
    toMove: stones.length > 0 ? "w" : "b",
    phase: "play",
    passes: 0,
    captures: { b: 0, w: 0 },
    seen: new Set([positionKey(board)]),
    lastMove: null,
    lastCaptured: [],
    proposal: null,
    marks: 0,
    n: 0,
    result: null,
  };
}

export const isResign = (e: Entry): e is "resign-b" | "resign-w" => e === "resign-b" || e === "resign-w";
export const isMark = (e: Entry): e is number[] => Array.isArray(e);
export const isTimeout = (e: Entry): e is "timeout-b" | "timeout-w" => e === "timeout-b" || e === "timeout-w";

export function timeoutOf(c: Color): Entry {
  return c === "b" ? "timeout-b" : "timeout-w";
}

export function resignBy(c: Color): Entry {
  return c === "b" ? "resign-b" : "resign-w";
}

/** Who made *entry* in *state*: the resigning (or timed-out) player, else the player to move. */
export function actorOf(state: GameState, entry: Entry): Color {
  if (entry === "resign-b" || entry === "timeout-b") return "b";
  if (entry === "resign-w" || entry === "timeout-w") return "w";
  return state.toMove;
}

export function sameEntry(a: Entry, b: Entry): boolean {
  if (Array.isArray(a) || Array.isArray(b)) {
    return Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((v, i) => v === b[i]);
  }
  return a === b;
}

/** Whether *dead* is a valid marking: sorted, distinct stones, whole chains only. */
export function isValidMarking(state: GameState, dead: readonly number[]): boolean {
  const set = new Set<number>();
  for (let i = 0; i < dead.length; i++) {
    const p = dead[i];
    if (!isPoint(state.size, p) || state.board[p] === EMPTY) return false;
    if (i > 0 && p <= dead[i - 1]) return false;
    set.add(p);
  }
  for (const p of dead) {
    if (!chainAt(state.board, state.size, p).stones.every((s) => set.has(s))) return false;
  }
  return true;
}

/** The chain through *p* toggled in or out of *dead* (a sorted list back). */
export function toggleChain(state: GameState, dead: readonly number[], p: number): number[] {
  const chain = chainAt(state.board, state.size, p).stones;
  if (chain.length === 0) return [...dead];
  const set = new Set(dead);
  const on = !set.has(p);
  for (const s of chain) {
    if (on) set.add(s);
    else set.delete(s);
  }
  return [...set].sort((a, b) => a - b);
}

/** The state after *entry*; throws `IllegalMove` when it isn't allowed. */
export function applyEntry(state: GameState, entry: Entry): GameState {
  if (state.phase === "over") throw new IllegalMove("over");
  if (state.n >= MAX_LOG) throw new IllegalMove("too-long");
  const base = { ...state, n: state.n + 1 };

  if (isResign(entry)) {
    const by: Color = entry === "resign-b" ? "b" : "w";
    return { ...base, phase: "over", result: { winner: other(by), by: "resign" } };
  }
  if (isTimeout(entry)) {
    // Only in a game with a clock, and only on your own turn.
    if (state.days <= 0) throw new IllegalMove("bad-entry");
    const by: Color = entry === "timeout-b" ? "b" : "w";
    if (by !== state.toMove) throw new IllegalMove("turn");
    return { ...base, phase: "over", result: { winner: other(by), by: "time" } };
  }
  // The last log slot is kept for a resignation (or running out of time).
  if (state.n >= MAX_LOG - 1) throw new IllegalMove("too-long");

  if (typeof entry === "number") {
    if (state.phase !== "play") throw new IllegalMove("phase");
    if (!isPoint(state.size, entry)) throw new IllegalMove("bad-entry");
    const r = place(state.board, state.size, entry, state.toMove);
    if (!r.ok) throw new IllegalMove(r.error);
    const key = positionKey(r.board);
    if (state.seen.has(key)) throw new IllegalMove("ko");
    const seen = new Set(state.seen);
    seen.add(key);
    const captures = { ...state.captures };
    captures[state.toMove] += r.captured.length;
    return {
      ...base,
      board: r.board,
      toMove: other(state.toMove),
      passes: 0,
      captures,
      seen,
      lastMove: entry,
      lastCaptured: r.captured,
    };
  }

  if (entry === "pass") {
    if (state.phase !== "play") throw new IllegalMove("phase");
    const passes = state.passes + 1;
    return {
      ...base,
      toMove: other(state.toMove),
      passes,
      phase: passes >= 2 ? "counting" : "play",
      lastMove: null,
      lastCaptured: [],
      proposal: null,
    };
  }

  if (entry === "resume") {
    if (state.phase !== "counting") throw new IllegalMove("phase");
    return { ...base, phase: "play", toMove: other(state.toMove), passes: 0, proposal: null };
  }

  if (isMark(entry)) {
    if (state.phase !== "counting") throw new IllegalMove("phase");
    if (state.marks >= MAX_MARKS) throw new IllegalMove("too-long");
    if (!isValidMarking(state, entry)) throw new IllegalMove("mark");
    const by = state.toMove;
    const dead = [...entry];
    const marks = state.marks + 1;
    if (state.proposal && state.proposal.by !== by && sameEntry(state.proposal.dead, dead)) {
      const score = scoreArea(state.board, state.size, dead, state.handicap);
      return {
        ...base,
        marks,
        proposal: { by, dead },
        phase: "over",
        result: { winner: score.winner, by: "score", margin: score.margin, score, dead },
      };
    }
    return { ...base, marks, proposal: { by, dead }, toMove: other(by) };
  }

  throw new IllegalMove("bad-entry");
}

export interface Replay {
  state: GameState;
  actors: Color[];
}

/** Play *log* from the start (handicap stones placed); `null` if any entry isn't allowed. */
export function replay(size: Size, log: readonly Entry[], rules: Rules = NO_RULES): Replay | null {
  let state = initialState(size, rules);
  const actors: Color[] = [];
  for (const e of log) {
    try {
      actors.push(actorOf(state, e));
      state = applyEntry(state, e);
    } catch {
      return null;
    }
  }
  return { state, actors };
}

/** Why a stone can't go on *p* now, or `null` when it can. */
export function whyNot(state: GameState, p: number): IllegalReason | null {
  try {
    applyEntry(state, p);
    return null;
  } catch (err) {
    return err instanceof IllegalMove ? err.reason : "bad-entry";
  }
}

/** Whether our entry leaves the other player to act next in a running game. */
export function passesTurn(state: GameState, me: Color): boolean {
  return state.phase !== "over" && state.toMove !== me;
}

/** Stones played so far (for "move 23"). */
export function stonesPlayed(log: readonly Entry[]): number {
  return log.filter((e) => typeof e === "number").length;
}

export { stoneOf };
