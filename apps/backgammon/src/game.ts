/**
 * One game of backgammon as a log of entries, replayed through the rules —
 * pure, tested.
 *
 * Entries, each by one player:
 *   - `number[]`: a whole turn by the player to move, as [from, to] pairs in
 *     their own numbering (rules.ts), flattened: [13, 7, 8, 7]. `[]` when the
 *     roll can't be played at all (the turn passes).
 *   - `"open"`: the inviter shows its link for the opening roll when the
 *     invitee won it (the invitee then plays it). When the inviter won it,
 *     its first turn shows that link instead.
 *   - `"double"`: the player to move offers the doubling cube (turn 2 on,
 *     their roll is shown with it); `"take"` / `"drop"` the answer.
 *   - `"resign-w"` / `"resign-b"`: that player gives up (on either turn).
 *   - `"timeout-w"` / `"timeout-b"`: with a clock, the player who has to act
 *     confirms their own time ran out (their app adds it when the other
 *     claims the win and its own records agree).
 *
 * Every roll comes from the two players' dice chains (dice.ts) through a
 * `DiceSource`; this file decides which link each player must have shown
 * after each entry (`reveals`): link t + 1 with your finished turn t, link t
 * with a double on turn t, link 1 with "open". A roll is known to a player
 * only when both links are.
 */

import {
  BAR,
  CHECKERS,
  MAX_CUBE,
  OFF,
  WIN_MULTIPLIER,
  applyStep,
  checkTurn,
  other,
  pairsOf,
  startBoard,
  turnNeed,
  winKind,
} from "./rules.js";
import type { Board, Color, Step, WinKind } from "./rules.js";
import { CHAIN_LENGTH } from "./dice.js";
import type { Opening } from "./dice.js";

export type Entry =
  | number[]
  | "open"
  | "double"
  | "take"
  | "drop"
  | "resign-w"
  | "resign-b"
  | "timeout-w"
  | "timeout-b";

/** The fixed setup, chosen by the inviter. */
export interface Setup {
  /** The inviter's colour. */
  inviter: Color;
  /** Play with the doubling cube. */
  cube: boolean;
  /** Days per move; 0 = no clock. */
  days: number;
}

/** The longest a game can be: one link per turn, the last one shown with turn L − 1. */
export const MAX_TURN = CHAIN_LENGTH - 1;
/** Entries a log may have: every turn, plus room for cube steps and the end. */
export const MAX_LOG = MAX_TURN + 2 * 7 + 4;
/** Most numbers in one turn entry: four steps. */
export const MAX_TURN_NUMBERS = 8;

/** The rolls a player can know: `null` until both links of that turn are shown. */
export interface DiceSource {
  opening(): Opening | null;
  /** Turn *t*'s roll (t ≥ 2). */
  roll(t: number): [number, number] | null;
}

export type Phase = "start" | "play" | "cube" | "over";

export type Result =
  | { winner: Color; by: WinKind | "drop" | "resign" | "time"; cube: number; points: number }
  | { winner: null; by: "limit"; cube: number; points: 0 };

export interface LastTurn {
  by: Color;
  turn: number;
  roll: [number, number];
  steps: Step[];
}

export interface GameState {
  setup: Setup;
  board: Board;
  phase: Phase;
  /** The turn being played (1 = the opening roll's turn). */
  turn: number;
  /** Whose turn it is (`null` in "start" until the opening is known). */
  mover: Color | null;
  /** Who has to act now: the mover, the player answering a double, or (start) the inviter. */
  toMove: Color;
  /** The mover's roll for this turn when this side knows it. */
  roll: [number, number] | null;
  opening: Opening | null;
  cube: { value: number; owner: Color | null };
  /** The newest link each colour must have shown. */
  reveals: Record<Color, number>;
  last: LastTurn | null;
  result: Result | null;
  /** Entries so far. */
  n: number;
}

export type IllegalReason = "turn" | "over" | "phase" | "dice" | "move" | "cube" | "too-long" | "bad-entry";

export class IllegalMove extends Error {
  constructor(public reason: IllegalReason) {
    super(`illegal: ${reason}`);
  }
}

export const NO_DICE: DiceSource = { opening: () => null, roll: () => null };

/** The state once both chains' tips are known (the invitee has answered). */
export function initialState(setup: Setup, dice: DiceSource): GameState {
  const invitee = other(setup.inviter);
  const opening = dice.opening();
  const st: GameState = {
    setup,
    board: startBoard(),
    phase: "start",
    turn: 1,
    mover: null,
    toMove: setup.inviter,
    roll: null,
    opening,
    cube: { value: 1, owner: null },
    reveals: { [setup.inviter]: 0, [invitee]: 1 } as Record<Color, number>,
    last: null,
    result: null,
    n: 0,
  };
  if (opening && opening.starter === setup.inviter) {
    st.mover = setup.inviter;
    st.roll = [opening.w, opening.b];
  }
  return st;
}

export const isResign = (e: Entry): e is "resign-w" | "resign-b" => e === "resign-w" || e === "resign-b";
export const isTimeout = (e: Entry): e is "timeout-w" | "timeout-b" => e === "timeout-w" || e === "timeout-b";
export const isTurn = (e: Entry): e is number[] => Array.isArray(e);

export function resignBy(c: Color): Entry {
  return c === "w" ? "resign-w" : "resign-b";
}

export function timeoutOf(c: Color): Entry {
  return c === "w" ? "timeout-w" : "timeout-b";
}

/** Who made *entry* in *state*: the resigning (or timed-out) player, else the player who has to act. */
export function actorOf(state: GameState, entry: Entry): Color {
  if (entry === "resign-w" || entry === "timeout-w") return "w";
  if (entry === "resign-b" || entry === "timeout-b") return "b";
  return state.toMove;
}

export function sameEntry(a: Entry, b: Entry): boolean {
  if (Array.isArray(a) || Array.isArray(b)) {
    return Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((v, i) => v === b[i]);
  }
  return a === b;
}

/** Whether the player to move may offer the cube now. */
export function canDouble(state: GameState): boolean {
  if (state.phase !== "play" || !state.setup.cube || state.turn < 2 || state.mover === null) return false;
  const { value, owner } = state.cube;
  return value < MAX_CUBE && (owner === null || owner === state.mover);
}

/** Start turn *t* for *mover*: its roll when known. */
function beginTurn(state: GameState, t: number, mover: Color, dice: DiceSource): GameState {
  const roll = t === 1 ? (state.opening ? [state.opening.w, state.opening.b] as [number, number] : null) : dice.roll(t);
  return { ...state, phase: "play", turn: t, mover, toMove: mover, roll };
}

function finish(state: GameState, result: Result): GameState {
  return { ...state, phase: "over", result, toMove: state.toMove };
}

/** The state after *entry*; throws `IllegalMove` when it isn't allowed. */
export function applyEntry(state: GameState, entry: Entry, dice: DiceSource): GameState {
  if (state.phase === "over") throw new IllegalMove("over");
  if (state.n >= MAX_LOG) throw new IllegalMove("too-long");
  const base: GameState = { ...state, n: state.n + 1 };
  const value = state.cube.value;

  if (isResign(entry)) {
    const by: Color = entry === "resign-w" ? "w" : "b";
    return finish(base, { winner: other(by), by: "resign", cube: value, points: value });
  }
  if (isTimeout(entry)) {
    if (state.setup.days <= 0) throw new IllegalMove("bad-entry");
    const by: Color = entry === "timeout-w" ? "w" : "b";
    if (by !== state.toMove) throw new IllegalMove("turn");
    return finish(base, { winner: other(by), by: "time", cube: value, points: value });
  }
  // The last slot stays free for a resignation or running out of time.
  if (state.n >= MAX_LOG - 1) throw new IllegalMove("too-long");

  if (entry === "open") {
    if (state.phase !== "start") throw new IllegalMove("phase");
    const opening = dice.opening();
    if (!opening) throw new IllegalMove("dice");
    if (opening.starter === state.setup.inviter) throw new IllegalMove("phase");
    const reveals = { ...state.reveals, [state.setup.inviter]: 1 };
    return beginTurn({ ...base, opening, reveals }, 1, opening.starter, dice);
  }

  if (entry === "double") {
    if (!canDouble(state)) throw new IllegalMove("cube");
    const mover = state.mover!;
    const reveals = { ...state.reveals, [mover]: state.turn };
    // With the offer the mover shows link t: both now know the roll.
    const roll = state.roll ?? dice.roll(state.turn);
    if (!roll) throw new IllegalMove("dice");
    return { ...base, phase: "cube", toMove: other(mover), reveals, roll };
  }

  if (entry === "take" || entry === "drop") {
    if (state.phase !== "cube") throw new IllegalMove("phase");
    const mover = state.mover!;
    if (entry === "drop") return finish(base, { winner: mover, by: "drop", cube: value, points: value });
    return { ...base, phase: "play", toMove: mover, cube: { value: value * 2, owner: other(mover) } };
  }

  if (isTurn(entry)) {
    let st = base;
    if (state.phase === "start") {
      // The inviter won the opening roll and plays it.
      const opening = dice.opening();
      if (!opening) throw new IllegalMove("dice");
      if (opening.starter !== state.setup.inviter) throw new IllegalMove("phase");
      st = beginTurn({ ...base, opening }, 1, opening.starter, dice);
    } else if (state.phase !== "play") {
      throw new IllegalMove("phase");
    }
    const mover = st.mover!;
    const roll = st.roll ?? dice.roll(st.turn);
    if (!roll) throw new IllegalMove("dice");
    if (entry.length % 2 !== 0 || entry.length > 8) throw new IllegalMove("bad-entry");
    const r = checkTurn(st.board, mover, roll, pairsOf(entry));
    if (!r.ok) throw new IllegalMove("move");
    const last: LastTurn = { by: mover, turn: st.turn, roll, steps: r.steps };
    const reveals = { ...st.reveals, [mover]: st.turn + 1 };
    const after: GameState = { ...st, board: r.board, roll, last, reveals };
    if (r.board[mover][OFF] === CHECKERS) {
      const kind = winKind(r.board, mover);
      return finish(after, { winner: mover, by: kind, cube: value, points: value * WIN_MULTIPLIER[kind] });
    }
    if (st.turn >= MAX_TURN) return finish(after, { winner: null, by: "limit", cube: value, points: 0 });
    return beginTurn(after, st.turn + 1, other(mover), dice);
  }

  throw new IllegalMove("bad-entry");
}

export interface Replay {
  state: GameState;
  actors: Color[];
}

/** Play *log* from the start; `null` if any entry isn't allowed (or a roll it needs isn't known). */
export function replay(setup: Setup, log: readonly Entry[], dice: DiceSource): Replay | null {
  let state = initialState(setup, dice);
  const actors: Color[] = [];
  for (const e of log) {
    try {
      actors.push(actorOf(state, e));
      state = applyEntry(state, e, dice);
    } catch {
      return null;
    }
  }
  return { state, actors };
}

/** Whether our entry leaves the other player to act next in a running game. */
export function passesTurn(state: GameState, me: Color): boolean {
  return state.phase !== "over" && state.toMove !== me;
}

/** The roll can't be played at all: the turn passes with `[]`. */
export function mustPass(state: GameState): boolean {
  if (state.phase !== "play" || !state.roll || state.mover === null) return false;
  return turnNeed(state.board, state.mover, state.roll).count === 0;
}

/** Why a roll can't be played, for the person: on the bar and blocked, or no step anywhere. */
export function passReason(state: GameState): "bar" | "blocked" {
  return state.mover !== null && state.board[state.mover][BAR] > 0 ? "bar" : "blocked";
}

/** Turns played so far (for "turn 12"). */
export function turnsPlayed(log: readonly Entry[]): number {
  return log.filter(isTurn).length;
}

/** The board after part of a turn (the steps made so far, not sent yet). */
export function boardAfter(state: GameState, steps: readonly Step[]): Board {
  let b = state.board;
  for (const s of steps) b = applyStep(b, state.mover!, s);
  return b;
}
