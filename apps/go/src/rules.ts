/**
 * The Go board — pure, no DOM, no SDK.
 *
 * A board is a flat array of `size × size` points, row 0 at the top, `0`
 * empty, `1` black, `2` white. `place` puts a stone, takes the opponent's
 * chains left without liberties and refuses suicide; `scoreArea` counts the
 * Chinese way (stones on the board + empty points surrounded by one colour,
 * komi for White). Repetition (positional superko) is the game's job
 * (game.ts), since it needs every earlier position.
 */

export type Color = "b" | "w";
export type Size = 9 | 13 | 19;

export const SIZES: readonly Size[] = [9, 13, 19];
export const EMPTY = 0;
export const BLACK = 1;
export const WHITE = 2;
/** Points for White under area scoring (no ties). */
export const KOMI = 7.5;
/** Komi in a handicap game: half a point, so there is still no tie. */
export const HANDICAP_KOMI = 0.5;

export type Board = number[];

export function isSize(v: unknown): v is Size {
  return v === 9 || v === 13 || v === 19;
}

export function stoneOf(c: Color): number {
  return c === "b" ? BLACK : WHITE;
}

export function other(c: Color): Color {
  return c === "b" ? "w" : "b";
}

export function emptyBoard(size: Size): Board {
  return new Array<number>(size * size).fill(EMPTY);
}

export function isPoint(size: number, p: unknown): p is number {
  return typeof p === "number" && Number.isInteger(p) && p >= 0 && p < size * size;
}

export function neighbours(size: number, p: number): number[] {
  const r = Math.floor(p / size);
  const c = p % size;
  const out: number[] = [];
  if (r > 0) out.push(p - size);
  if (r < size - 1) out.push(p + size);
  if (c > 0) out.push(p - 1);
  if (c < size - 1) out.push(p + 1);
  return out;
}

/** The chain of stones through *p* and its liberties (empty for an empty point). */
export function chainAt(board: Board, size: number, p: number): { stones: number[]; liberties: number } {
  const colour = board[p];
  if (colour === EMPTY) return { stones: [], liberties: 0 };
  const seen = new Set<number>([p]);
  const libs = new Set<number>();
  const stack = [p];
  while (stack.length) {
    const q = stack.pop()!;
    for (const n of neighbours(size, q)) {
      const v = board[n];
      if (v === EMPTY) libs.add(n);
      else if (v === colour && !seen.has(n)) {
        seen.add(n);
        stack.push(n);
      }
    }
  }
  return { stones: [...seen].sort((a, b) => a - b), liberties: libs.size };
}

export type PlaceError = "occupied" | "suicide";

export type PlaceResult = { ok: true; board: Board; captured: number[] } | { ok: false; error: PlaceError };

/** Put a *color* stone on *p*: captures first, then the suicide check. */
export function place(board: Board, size: number, p: number, color: Color): PlaceResult {
  if (board[p] !== EMPTY) return { ok: false, error: "occupied" };
  const next = board.slice();
  const mine = stoneOf(color);
  const theirs = stoneOf(other(color));
  next[p] = mine;
  const captured: number[] = [];
  for (const n of neighbours(size, p)) {
    if (next[n] !== theirs) continue;
    const chain = chainAt(next, size, n);
    if (chain.liberties === 0) {
      for (const s of chain.stones) {
        next[s] = EMPTY;
        captured.push(s);
      }
    }
  }
  if (chainAt(next, size, p).liberties === 0) return { ok: false, error: "suicide" };
  return { ok: true, board: next, captured: captured.sort((a, b) => a - b) };
}

/** A position as a short string (for superko). */
export function positionKey(board: Board): string {
  return board.join("");
}

export interface SideScore {
  stones: number;
  territory: number;
  komi: number;
  /** White's points for Black's handicap stones (one per stone after the first). */
  handicap: number;
  total: number;
}

export interface AreaScore {
  b: SideScore;
  w: SideScore;
  /** Per point: who it counts for (`BLACK`, `WHITE`) or `EMPTY` for nobody. */
  owner: number[];
  winner: Color;
  /** Always positive (komi has a half point). */
  margin: number;
}

/**
 * Area scoring with *dead* stones taken off first: each side counts its
 * stones left on the board plus the empty points only its stones surround;
 * White adds komi. In a handicap game (*handicap* ≥ 2 stones) komi is 0.5
 * and White also gets one point per handicap stone after the first.
 */
export function scoreArea(board: Board, size: number, dead: Iterable<number>, handicap = 0): AreaScore {
  const b = board.slice();
  for (const p of dead) b[p] = EMPTY;
  const owner = b.slice();
  const seen = new Uint8Array(b.length);
  for (let p = 0; p < b.length; p++) {
    if (b[p] !== EMPTY || seen[p]) continue;
    const region: number[] = [];
    let touchesB = false;
    let touchesW = false;
    const stack = [p];
    seen[p] = 1;
    while (stack.length) {
      const q = stack.pop()!;
      region.push(q);
      for (const n of neighbours(size, q)) {
        const v = b[n];
        if (v === BLACK) touchesB = true;
        else if (v === WHITE) touchesW = true;
        else if (!seen[n]) {
          seen[n] = 1;
          stack.push(n);
        }
      }
    }
    const who = touchesB && !touchesW ? BLACK : touchesW && !touchesB ? WHITE : EMPTY;
    for (const q of region) owner[q] = who;
  }
  const side = (stone: number, komi: number, extra: number): SideScore => {
    let stones = 0;
    let territory = 0;
    for (let p = 0; p < b.length; p++) {
      if (b[p] === stone) stones++;
      else if (owner[p] === stone) territory++;
    }
    return { stones, territory, komi, handicap: extra, total: stones + territory + komi + extra };
  };
  const hasHandicap = handicap >= 2;
  const sb = side(BLACK, 0, 0);
  const sw = side(WHITE, hasHandicap ? HANDICAP_KOMI : KOMI, hasHandicap ? handicap - 1 : 0);
  const winner: Color = sb.total > sw.total ? "b" : "w";
  return { b: sb, w: sw, owner, winner, margin: Math.abs(sb.total - sw.total) };
}

/** The star points (hoshi) of a board. */
export function starPoints(size: Size): number[] {
  const lines = size === 9 ? [2, 4, 6] : size === 13 ? [3, 6, 9] : [3, 9, 15];
  const out: number[] = [];
  for (const r of lines) {
    for (const c of lines) {
      // 9 × 9 shows the four 3-3 points and the centre only.
      if (size === 9 && (r === 4) !== (c === 4)) continue;
      out.push(r * size + c);
    }
  }
  return out;
}

/** The most handicap stones a board takes: 5 on 9 × 9, 9 on 13 × 13 and 19 × 19. */
export function maxHandicap(size: Size): number {
  return size === 9 ? 5 : 9;
}

/** The handicaps a board allows: 0 (none) or 2 … max. */
export function handicapsFor(size: Size): number[] {
  const out = [0];
  for (let n = 2; n <= maxHandicap(size); n++) out.push(n);
  return out;
}

export function isHandicap(size: Size, v: unknown): v is number {
  return typeof v === "number" && handicapsFor(size).includes(v);
}

/**
 * Where Black's *n* handicap stones go — the fixed star points, as in
 * Japanese and Chinese practice: 2 on the upper-right and lower-left
 * corners, 3 adds lower-right, 4 upper-left, 5 = 4 + centre, 6 = 4 + the
 * left and right sides, 7 = 6 + centre, 8 = 6 + top and bottom, 9 = 8 +
 * centre. On 9 × 9 the corners are the 3-3 points (2 … 5).
 */
export function handicapPoints(size: Size, n: number): number[] {
  if (!isHandicap(size, n) || n === 0) return [];
  const [lo, mid, hi] = size === 9 ? [2, 4, 6] : size === 13 ? [3, 6, 9] : [3, 9, 15];
  const at = (r: number, c: number) => r * size + c;
  const corners = [at(lo, hi), at(hi, lo), at(hi, hi), at(lo, lo)];
  const centre = at(mid, mid);
  const sides = [at(mid, lo), at(mid, hi)];
  const ends = [at(lo, mid), at(hi, mid)];
  let pts: number[];
  if (n <= 4) pts = corners.slice(0, n);
  else if (n === 5) pts = [...corners, centre];
  else if (n === 6) pts = [...corners, ...sides];
  else if (n === 7) pts = [...corners, ...sides, centre];
  else if (n === 8) pts = [...corners, ...sides, ...ends];
  else pts = [...corners, ...sides, ...ends, centre];
  return pts.sort((a, b) => a - b);
}

/** Column letters: A–T without I. */
export const COLUMNS = "ABCDEFGHJKLMNOPQRST";

/** "D4": the column letter (no I) and the row counted from the bottom. */
export function pointName(size: number, p: number): string {
  const r = Math.floor(p / size);
  const c = p % size;
  return `${COLUMNS[c]}${size - r}`;
}
