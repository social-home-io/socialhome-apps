/**
 * Backgammon rules — pure, no DOM, tested.
 *
 * Each colour keeps its checkers in its OWN numbering (the way players
 * count): points 1 … 24, where it moves from 24 towards 1, its home board is
 * 1 … 6, index 25 is its bar and index 0 holds its borne-off checkers. A
 * checker of the other colour on my point p sits on its point 25 − p.
 *
 * A turn is a list of single steps, one die each (four with a double).
 * The standard rules decide which lists are allowed:
 *   - a checker on the bar must enter first (into the other side's home);
 *   - a step may land on an empty point, a point of your own, or a point with
 *     one checker of the other side (a hit: it goes to the bar); never on two
 *     or more;
 *   - bearing off only with all 15 checkers home; a higher die than needed
 *     may bear off the checker on the highest point;
 *   - you must use as many dice as can be used, and if only one of two
 *     different dice can be used, the larger one when it can be.
 */

export type Color = "w" | "b";
export const COLORS: readonly Color[] = ["w", "b"];
export const other = (c: Color): Color => (c === "w" ? "b" : "w");

export const BAR = 25;
export const OFF = 0;
export const CHECKERS = 15;
/** The highest a doubling cube goes. */
export const MAX_CUBE = 64;

/** One colour's checkers: index 0 borne off, 1 … 24 points, 25 the bar. */
export type Side = number[];
export type Board = Record<Color, Side>;

/** A step of one checker by one die: `to` 0 means borne off. */
export interface Step {
  from: number;
  to: number;
  die: number;
  hit: boolean;
}

/** The starting position, the same for both colours in their own numbering. */
export function startSide(): Side {
  const s = new Array<number>(26).fill(0);
  s[24] = 2;
  s[13] = 5;
  s[8] = 3;
  s[6] = 5;
  return s;
}

export function startBoard(): Board {
  return { w: startSide(), b: startSide() };
}

export function copyBoard(b: Board): Board {
  return { w: [...b.w], b: [...b.b] };
}

/** The four (double) or two dice to play for a roll. */
export function diceToPlay(roll: readonly number[]): number[] {
  return roll[0] === roll[1] ? [roll[0], roll[0], roll[0], roll[0]] : [roll[0], roll[1]];
}

export function isDie(v: unknown): v is number {
  return typeof v === "number" && Number.isInteger(v) && v >= 1 && v <= 6;
}

/** Every checker of *side* is in its home board (or off): bearing off is allowed. */
export function allHome(side: Side): boolean {
  for (let p = 7; p <= BAR; p++) if (side[p] > 0) return false;
  return true;
}

/** The legal single steps for *me* with one *die*. */
export function stepsFor(board: Board, me: Color, die: number): Step[] {
  const mine = board[me];
  const theirs = board[other(me)];
  const out: Step[] = [];
  const land = (from: number, to: number) => {
    const opp = theirs[25 - to];
    if (opp >= 2) return;
    out.push({ from, to, die, hit: opp === 1 });
  };
  if (mine[BAR] > 0) {
    land(BAR, BAR - die);
    return out;
  }
  const home = allHome(mine);
  for (let from = 24; from >= 1; from--) {
    if (mine[from] === 0) continue;
    const to = from - die;
    if (to >= 1) {
      land(from, to);
    } else if (home) {
      if (to === 0) out.push({ from, to: OFF, die, hit: false });
      else {
        // A higher die bears off only the checker on the highest point.
        let higher = false;
        for (let p = from + 1; p <= 6; p++) if (mine[p] > 0) higher = true;
        if (!higher) out.push({ from, to: OFF, die, hit: false });
      }
    }
  }
  return out;
}

/** The board after one step (a new board). */
export function applyStep(board: Board, me: Color, s: Step): Board {
  const next = copyBoard(board);
  const mine = next[me];
  const theirs = next[other(me)];
  mine[s.from]--;
  mine[s.to]++;
  if (s.hit) {
    theirs[25 - s.to]--;
    theirs[BAR]++;
  }
  return next;
}

/** *dice* without one *die* (the first one equal to it). */
export function without(dice: readonly number[], die: number): number[] {
  const i = dice.indexOf(die);
  if (i < 0) return [...dice];
  return [...dice.slice(0, i), ...dice.slice(i + 1)];
}

const distinct = (dice: readonly number[]): number[] => [...new Set(dice)];

/** The most of *dice* that can be used from *board* (0 … dice.length). */
export function maxPlayable(board: Board, me: Color, dice: readonly number[]): number {
  if (dice.length === 0) return 0;
  let best = 0;
  for (const d of distinct(dice)) {
    const rest = without(dice, d);
    for (const s of stepsFor(board, me, d)) {
      const n = 1 + maxPlayable(applyStep(board, me, s), me, rest);
      if (n > best) best = n;
      if (best === dice.length) return best;
    }
  }
  return best;
}

/** What a turn must use: how many dice, and the one die when only one can be used. */
export interface TurnNeed {
  count: number;
  /** Two different dice, only one usable, and the larger can be used: it must be. */
  mustDie: number | null;
}

export function turnNeed(board: Board, me: Color, roll: readonly number[]): TurnNeed {
  const dice = diceToPlay(roll);
  const count = maxPlayable(board, me, dice);
  let mustDie: number | null = null;
  if (count === 1 && dice.length === 2) {
    const larger = Math.max(dice[0], dice[1]);
    if (stepsFor(board, me, larger).length > 0) mustDie = larger;
  }
  return { count, mustDie };
}

/** The partial turn so far: the board now and the dice still to play. */
export interface TurnProgress {
  board: Board;
  left: number[];
  steps: Step[];
}

export function progressOf(board: Board, me: Color, roll: readonly number[], steps: readonly Step[]): TurnProgress {
  let b = board;
  let left = diceToPlay(roll);
  for (const s of steps) {
    b = applyStep(b, me, s);
    left = without(left, s.die);
  }
  return { board: b, left, steps: [...steps] };
}

/**
 * The steps that may come next after *steps* (from the turn's start *board*):
 * each one still lets the whole turn use as many dice as the rules demand.
 */
export function nextSteps(board: Board, me: Color, roll: readonly number[], steps: readonly Step[]): Step[] {
  const need = turnNeed(board, me, roll);
  const cur = progressOf(board, me, roll, steps);
  if (steps.length >= need.count) return [];
  const out: Step[] = [];
  for (const d of distinct(cur.left)) {
    if (need.mustDie !== null && d !== need.mustDie) continue;
    const rest = without(cur.left, d);
    for (const s of stepsFor(cur.board, me, d)) {
      if (steps.length + 1 + maxPlayable(applyStep(cur.board, me, s), me, rest) === need.count) out.push(s);
    }
  }
  return out;
}

/**
 * Where the checker on *from* may go now, with the steps to get there: one
 * die, or several dice in a row for the same checker (each stop legal).
 * One die is preferred; for a bear-off reachable with two dice, the smaller.
 */
export function targetsFrom(
  board: Board,
  me: Color,
  roll: readonly number[],
  steps: readonly Step[],
  from: number,
): Map<number, Step[]> {
  const out = new Map<number, Step[]>();
  let frontier: { at: number; path: Step[] }[] = [{ at: from, path: [] }];
  while (frontier.length > 0) {
    const next: { at: number; path: Step[] }[] = [];
    for (const f of frontier) {
      const opts = nextSteps(board, me, roll, [...steps, ...f.path])
        .filter((s) => s.from === f.at)
        .sort((a, b) => a.die - b.die);
      for (const s of opts) {
        const path = [...f.path, s];
        if (!out.has(s.to)) out.set(s.to, path);
        // A checker that is off (or just hit on the way: it may go on) keeps moving only from a point.
        if (s.to !== OFF) next.push({ at: s.to, path });
      }
    }
    frontier = next;
  }
  return out;
}

export type TurnError = "bad-step" | "too-few" | "wrong-die";

export type TurnCheck = { ok: true; board: Board; steps: Step[] } | { ok: false; error: TurnError };

/**
 * Check a whole turn sent as [from, to] pairs (to 0 = off), in the order
 * played. The dice are a set: any order of them may be used, but every stop
 * must be legal and the turn must use as many dice as the rules demand.
 */
export function checkTurn(board: Board, me: Color, roll: readonly number[], pairs: readonly (readonly [number, number])[]): TurnCheck {
  const need = turnNeed(board, me, roll);
  if (pairs.length !== need.count) return { ok: false, error: pairs.length < need.count ? "too-few" : "bad-step" };
  let wrongDie = false;
  const search = (b: Board, left: number[], i: number, done: Step[]): TurnCheck | null => {
    if (i === pairs.length) return { ok: true, board: b, steps: done };
    const [from, to] = pairs[i];
    for (const d of distinct(left)) {
      if (need.mustDie !== null && d !== need.mustDie) {
        if (stepsFor(b, me, d).some((s) => s.from === from && s.to === to)) wrongDie = true;
        continue;
      }
      const s = stepsFor(b, me, d).find((x) => x.from === from && x.to === to);
      if (!s) continue;
      const r = search(applyStep(b, me, s), without(left, d), i + 1, [...done, s]);
      if (r) return r;
    }
    return null;
  };
  const r = search(board, diceToPlay(roll), 0, []);
  if (r) return r;
  return { ok: false, error: wrongDie ? "wrong-die" : "bad-step" };
}

/** Pips still to travel: the race count. */
export function pipCount(side: Side): number {
  let n = 0;
  for (let p = 1; p <= BAR; p++) n += side[p] * p;
  return n;
}

/** How big a win is when *winner* has borne off all 15. */
export type WinKind = "single" | "gammon" | "backgammon";

export function winKind(board: Board, winner: Color): WinKind {
  const loser = board[other(winner)];
  if (loser[OFF] > 0) return "single";
  // A checker on the bar or in the winner's home board (the loser's 19 … 24).
  if (loser[BAR] > 0) return "backgammon";
  for (let p = 19; p <= 24; p++) if (loser[p] > 0) return "backgammon";
  return "gammon";
}

export const WIN_MULTIPLIER: Record<WinKind, number> = { single: 1, gammon: 2, backgammon: 3 };

/** Checkers of *side* on the board, bar and off: always 15 in a real game. */
export function checkerTotal(side: Side): number {
  return side.reduce((a, b) => a + b, 0);
}

/** "13/7" style pairs flattened for the wire: [13, 7, 8, 7]. */
export function flatten(steps: readonly Step[]): number[] {
  const out: number[] = [];
  for (const s of steps) out.push(s.from, s.to);
  return out;
}

export function pairsOf(flat: readonly number[]): [number, number][] {
  const out: [number, number][] = [];
  for (let i = 0; i + 1 < flat.length; i += 2) out.push([flat[i], flat[i + 1]]);
  return out;
}
