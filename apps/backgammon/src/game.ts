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
 *   - `"roll"`: the player to move, who could double, rolls instead;
 *     `"show"`: the other player's app answers with its link for that roll.
 *   - `"double"`: the player to move offers the doubling cube before rolling;
 *     `"take"` (which also shows the taker's link for the roll) / `"drop"`
 *     the answer.
 *   - `"resign-w"` / `"resign-b"`: that player gives up (on either turn).
 *   - `"timeout-w"` / `"timeout-b"`: with a clock, the player who has to act
 *     confirms their own time ran out (their app adds it when the other
 *     claims the win and its own records agree).
 *   - `"auto-w"` / `"auto-b"`: that player rolls without being asked from
 *     now on — it gives up offering the cube on its own turns;
 *     `"manual-w"` / `"manual-b"` takes that back. Only the player about to
 *     act on its own turn can say so, as the first entry of that turn, and
 *     always together with the step that follows it (inbound.ts).
 *
 * Every roll comes from the two players' dice chains (dice.ts) through a
 * `DiceSource`; this file decides which link each player must have shown
 * after each entry (`reveals`). Turn t's roll needs link t of both chains;
 * a roll is known to a player only when both links are. The roller always
 * has its own link, so the roll stays hidden from it until the OTHER player
 * shows link t, and from the other player until the roller shows its own
 * link t with the finished turn:
 *
 *   - with your finished turn t you show link t (the other side checks your
 *     roll) and, when the other player can't double at turn t + 1, also
 *     link t + 1: their roll is then known to them at once, no extra
 *     message;
 *   - when the other player CAN double at turn t + 1 you hold link t + 1
 *     back, so they decide on the cube without knowing their roll: they
 *     send "roll" (your app answers "show" with link t + 1) or "double"
 *     (your "take" shows it; "drop" ends the game);
 *   - "open" shows link 1.
 *
 * Rolling without being asked ("auto-*") is fair for the same reason: the
 * roller says it before the other player's turn that comes ahead of its
 * own, as an entry in the log. When the other player finishes that turn
 * it knows the roller has given up the cube for its next turn, so it may
 * show link t + 1 with the turn — exactly as when the cube isn't
 * available. The roller can't take it back once it knows the roll: the
 * next chance to say "manual-*" is the first entry of its next turn, after
 * the other player's turn was sent, and it applies only from the turn
 * after.
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
  | "roll"
  | "show"
  | "double"
  | "take"
  | "drop"
  | "resign-w"
  | "resign-b"
  | "timeout-w"
  | "timeout-b"
  | "auto-w"
  | "auto-b"
  | "manual-w"
  | "manual-b";

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
/** How often each player may switch rolling without being asked on or off in one game. */
export const MAX_AUTO_CHANGES = 20;
/** Entries a log may have: per turn at most a roll (or a double) and its answer, then the turn; plus "open", the end and the auto-roll switches. */
export const MAX_LOG = 3 * MAX_TURN + 4 + 2 * MAX_AUTO_CHANGES;
/** Most numbers in one turn entry: four steps. */
export const MAX_TURN_NUMBERS = 8;

/** The rolls a player can know: `null` until both links of that turn are shown. */
export interface DiceSource {
  opening(): Opening | null;
  /** Turn *t*'s roll (t ≥ 2). */
  roll(t: number): [number, number] | null;
}

/**
 * - "start": before the opening roll is played;
 * - "ask": the mover may double, before its roll is known: "roll" or "double";
 * - "dice": the mover rolled; the other app shows its link ("show");
 * - "play": the mover plays its roll;
 * - "cube": the other player answers a double;
 * - "over".
 */
export type Phase = "start" | "ask" | "dice" | "play" | "cube" | "over";

/**
 * How a game ended. `kind` is what the position was worth: the win itself,
 * or for a resignation or running out of time what the board shows at that
 * moment (no checker borne off is a gammon, one still in the winner's home
 * board or on the bar a backgammon), so giving up never saves a gammon.
 * A declined double is always a single game at the cube's old value.
 */
export type Result =
  | { winner: Color; by: WinKind | "drop" | "resign" | "time"; kind: WinKind; cube: number; points: number }
  | { winner: null; by: "limit"; kind: null; cube: number; points: 0 };

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
  /** Who has to act now: the mover, the player answering a double or showing its link, or (start) the inviter. */
  toMove: Color;
  /** The mover's roll for this turn when this side knows it (never in "ask"). */
  roll: [number, number] | null;
  opening: Opening | null;
  cube: { value: number; owner: Color | null };
  /** The newest link each colour must have shown. */
  reveals: Record<Color, number>;
  /** Each colour rolls without being asked (gave up offering the cube on its turns). */
  autoRoll: Record<Color, boolean>;
  /** How often each colour switched `autoRoll`. */
  autoChanges: Record<Color, number>;
  /** Nothing has happened yet in this turn (or before the opening): the player about to act may switch `autoRoll`. */
  fresh: boolean;
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
    autoRoll: { w: false, b: false },
    autoChanges: { w: 0, b: 0 },
    fresh: true,
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

/** Whether *mover* may offer the cube at the start of turn *t* (never while it rolls without being asked). */
export function mayDouble(setup: Setup, cube: { value: number; owner: Color | null }, t: number, mover: Color, autoRoll = false): boolean {
  return setup.cube && !autoRoll && t >= 2 && cube.value < MAX_CUBE && (cube.owner === null || cube.owner === mover);
}

export const isAuto = (e: Entry): e is "auto-w" | "auto-b" | "manual-w" | "manual-b" =>
  e === "auto-w" || e === "auto-b" || e === "manual-w" || e === "manual-b";

/** The entry that switches *c*'s rolling without being asked to *on*. */
export function autoEntry(c: Color, on: boolean): Entry {
  return `${on ? "auto" : "manual"}-${c}` as Entry;
}

/** Whether *c* may switch rolling without being asked now: on its own turn, before anything else in it. */
export function canSwitchAuto(state: GameState, c: Color): boolean {
  if (!state.setup.cube || !state.fresh || state.toMove !== c || state.autoChanges[c] >= MAX_AUTO_CHANGES) return false;
  return state.phase === "start" || ((state.phase === "ask" || state.phase === "play") && state.mover === c);
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
  if (entry === "resign-w" || entry === "timeout-w" || entry === "auto-w" || entry === "manual-w") return "w";
  if (entry === "resign-b" || entry === "timeout-b" || entry === "auto-b" || entry === "manual-b") return "b";
  return state.toMove;
}

export function sameEntry(a: Entry, b: Entry): boolean {
  if (Array.isArray(a) || Array.isArray(b)) {
    return Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((v, i) => v === b[i]);
  }
  return a === b;
}

/** Whether the player to move may offer the cube now (before rolling). */
export function canDouble(state: GameState): boolean {
  return state.phase === "ask" && state.mover !== null && mayDouble(state.setup, state.cube, state.turn, state.mover, state.autoRoll[state.mover]);
}

/** Start turn *t* for *mover*: "ask" when it may double, else "play" with its roll when known. */
function beginTurn(state: GameState, t: number, mover: Color, dice: DiceSource): GameState {
  if (mayDouble(state.setup, state.cube, t, mover, state.autoRoll[mover])) {
    return { ...state, phase: "ask", turn: t, mover, toMove: mover, roll: null, fresh: true };
  }
  const roll = t === 1 ? (state.opening ? [state.opening.w, state.opening.b] as [number, number] : null) : dice.roll(t);
  return { ...state, phase: "play", turn: t, mover, toMove: mover, roll, fresh: true };
}

/** The game won by *winner* now: what the board is worth times the cube. */
function wonNow(state: GameState, winner: Color, by: "resign" | "time"): Result & { winner: Color } {
  const kind = winKind(state.board, winner);
  const value = state.cube.value;
  return { winner, by, kind, cube: value, points: value * WIN_MULTIPLIER[kind] };
}

/** What resigning now would cost *loser* (for the confirm). */
export function resignResult(state: GameState, loser: Color): { kind: WinKind; points: number } {
  const r = wonNow(state, other(loser), "resign");
  return { kind: r.kind, points: r.points };
}

function finish(state: GameState, result: Result): GameState {
  return { ...state, phase: "over", result, toMove: state.toMove };
}

/** The state after *entry*; throws `IllegalMove` when it isn't allowed. */
export function applyEntry(state: GameState, entry: Entry, dice: DiceSource): GameState {
  if (state.phase === "over") throw new IllegalMove("over");
  if (state.n >= MAX_LOG) throw new IllegalMove("too-long");
  const base: GameState = { ...state, n: state.n + 1, fresh: false };
  const value = state.cube.value;

  if (isResign(entry)) {
    const by: Color = entry === "resign-w" ? "w" : "b";
    return finish(base, wonNow(state, other(by), "resign"));
  }
  if (isTimeout(entry)) {
    if (state.setup.days <= 0) throw new IllegalMove("bad-entry");
    const by: Color = entry === "timeout-w" ? "w" : "b";
    if (by !== state.toMove) throw new IllegalMove("turn");
    return finish(base, wonNow(state, other(by), "time"));
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

  if (isAuto(entry)) {
    const by: Color = entry.endsWith("-w") ? "w" : "b";
    const on = entry.startsWith("auto");
    if (!canSwitchAuto(state, by)) throw new IllegalMove(state.toMove === by ? "phase" : "turn");
    if (state.autoRoll[by] === on) throw new IllegalMove("bad-entry");
    return {
      ...base,
      autoRoll: { ...state.autoRoll, [by]: on },
      autoChanges: { ...state.autoChanges, [by]: state.autoChanges[by] + 1 },
    };
  }

  if (entry === "roll") {
    // "ask" comes only when the mover could double; it may have given that up just now ("auto-*").
    if (state.phase !== "ask") throw new IllegalMove("phase");
    return { ...base, phase: "dice", toMove: other(state.mover!) };
  }

  if (entry === "show") {
    if (state.phase !== "dice") throw new IllegalMove("phase");
    const mover = state.mover!;
    const reveals = { ...state.reveals, [other(mover)]: state.turn };
    return { ...base, phase: "play", toMove: mover, reveals, roll: dice.roll(state.turn) };
  }

  if (entry === "double") {
    if (!canDouble(state)) throw new IllegalMove("cube");
    return { ...base, phase: "cube", toMove: other(state.mover!) };
  }

  if (entry === "take" || entry === "drop") {
    if (state.phase !== "cube") throw new IllegalMove("phase");
    const mover = state.mover!;
    if (entry === "drop") return finish(base, { winner: mover, by: "drop", kind: "single", cube: value, points: value });
    // The taker owns the cube and shows its link: the roll is known to the mover now.
    const taker = other(mover);
    const reveals = { ...state.reveals, [taker]: state.turn };
    return { ...base, phase: "play", toMove: mover, reveals, cube: { value: value * 2, owner: taker }, roll: dice.roll(state.turn) };
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
    const t = st.turn;
    const end = r.board[mover][OFF] === CHECKERS || t >= MAX_TURN;
    // Link t proves our roll; link t + 1 gives them theirs, unless they may double first.
    const them = other(mover);
    const ahead = !end && !mayDouble(st.setup, st.cube, t + 1, them, st.autoRoll[them]);
    const reveals = { ...st.reveals, [mover]: Math.max(st.reveals[mover], ahead ? t + 1 : t) };
    const after: GameState = { ...st, board: r.board, roll, last, reveals };
    if (r.board[mover][OFF] === CHECKERS) {
      const kind = winKind(r.board, mover);
      return finish(after, { winner: mover, by: kind, kind, cube: value, points: value * WIN_MULTIPLIER[kind] });
    }
    if (t >= MAX_TURN) return finish(after, { winner: null, by: "limit", kind: null, cube: value, points: 0 });
    return beginTurn(after, t + 1, other(mover), dice);
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
