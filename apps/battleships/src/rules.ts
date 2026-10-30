/**
 * Battleships rules v1 ("classic"): a 10 × 10 board, columns A–J, rows 1–10,
 * A1 top-left; square index `i = row * 10 + col`. Five ships, 17 squares:
 * carrier 5, battleship 4, cruiser 3, submarine 3, destroyer 2. Ships lie in
 * straight lines inside the board, never overlap, and may touch.
 *
 * Pure: no DOM, no SDK, no randomness of its own (a random source is passed in).
 */

export const RULES = "classic";
export const SIZE = 10;
export const CELLS = SIZE * SIZE;

export type ShipId = "carrier" | "battleship" | "cruiser" | "submarine" | "destroyer";

/** The fleet, in the order every message uses (a ship is named by its index). */
export const SHIPS: readonly { id: ShipId; len: number }[] = [
  { id: "carrier", len: 5 },
  { id: "battleship", len: 4 },
  { id: "cruiser", len: 3 },
  { id: "submarine", len: 3 },
  { id: "destroyer", len: 2 },
];

/** Squares a complete fleet covers. */
export const FLEET_SQUARES = SHIPS.reduce((n, s) => n + s.len, 0);

export type Dir = "h" | "v";

/** One ship on the board: `[shipIndex, startSquare, direction]` (also the wire shape). */
export type Placement = [number, number, Dir];

/** A full fleet: `fleet[i]` is ship `i`. */
export type Fleet = Placement[];

const COLS = "ABCDEFGHIJ";

export function rowOf(i: number): number {
  return Math.floor(i / SIZE);
}

export function colOf(i: number): number {
  return i % SIZE;
}

/** "C9" for square 82. Letters and digits read the same in all five languages. */
export function cellName(i: number): string {
  return `${COLS[colOf(i)]}${rowOf(i) + 1}`;
}

export function isCell(v: unknown): v is number {
  return typeof v === "number" && Number.isInteger(v) && v >= 0 && v < CELLS;
}

export function isShipIndex(v: unknown): v is number {
  return typeof v === "number" && Number.isInteger(v) && v >= 0 && v < SHIPS.length;
}

/** The squares of a ship of *len* from *start* in *dir*, or `null` if it leaves the board. */
export function shipCells(len: number, start: number, dir: Dir): number[] | null {
  if (!isCell(start)) return null;
  const r = rowOf(start);
  const c = colOf(start);
  if (dir === "h" ? c + len > SIZE : r + len > SIZE) return null;
  const out: number[] = [];
  for (let k = 0; k < len; k++) out.push(dir === "h" ? start + k : start + k * SIZE);
  return out;
}

/** The squares of placement *p*, or `null` if it is not a ship on the board. */
export function placementCells(p: Placement): number[] | null {
  if (!isShipIndex(p[0])) return null;
  return shipCells(SHIPS[p[0]].len, p[1], p[2]);
}

/** A clean placement from untrusted input, or `null`. */
export function parsePlacement(v: unknown): Placement | null {
  if (!Array.isArray(v) || v.length !== 3) return null;
  const [idx, start, dir] = v;
  if (!isShipIndex(idx) || !isCell(start) || (dir !== "h" && dir !== "v")) return null;
  if (!shipCells(SHIPS[idx].len, start, dir)) return null;
  return [idx, start, dir];
}

/** A clean, legal fleet from untrusted input, or `null`. */
export function parseFleet(v: unknown): Fleet | null {
  if (!Array.isArray(v) || v.length !== SHIPS.length) return null;
  const fleet: Fleet = [];
  for (let i = 0; i < v.length; i++) {
    const p = parsePlacement(v[i]);
    if (!p || p[0] !== i) return null;
    fleet.push(p);
  }
  return isLegalFleet(fleet) ? fleet : null;
}

/** Five ships, each once and in order, on the board, no overlap. */
export function isLegalFleet(fleet: Fleet): boolean {
  if (fleet.length !== SHIPS.length) return false;
  const used = new Set<number>();
  for (let i = 0; i < fleet.length; i++) {
    if (fleet[i][0] !== i) return false;
    const cells = placementCells(fleet[i]);
    if (!cells) return false;
    for (const c of cells) {
      if (used.has(c)) return false;
      used.add(c);
    }
  }
  return used.size === FLEET_SQUARES;
}

/** For every square, the index of the ship on it, or -1 for water. */
export function shipMap(fleet: Fleet): Int8Array {
  const map = new Int8Array(CELLS).fill(-1);
  for (const p of fleet) {
    for (const c of placementCells(p) ?? []) map[c] = p[0];
  }
  return map;
}

/** One bit per square: 1 where a ship lies. */
export function fleetBits(fleet: Fleet): Uint8Array {
  const map = shipMap(fleet);
  const bits = new Uint8Array(CELLS);
  for (let i = 0; i < CELLS; i++) bits[i] = map[i] >= 0 ? 1 : 0;
  return bits;
}

/**
 * Whether ship *idx* fits at *start* / *dir* in *fleet* — inside the board and
 * not over another ship (the ship itself is ignored, so it can move a square).
 */
export function canPlace(fleet: Fleet, idx: number, start: number, dir: Dir): boolean {
  const cells = shipCells(SHIPS[idx].len, start, dir);
  if (!cells) return false;
  const map = shipMap(fleet.filter((p) => p[0] !== idx));
  return cells.every((c) => map[c] < 0);
}

/** *fleet* with ship *idx* moved (the caller checks `canPlace` first). */
export function withShip(fleet: Fleet, idx: number, start: number, dir: Dir): Fleet {
  return fleet.map((p) => (p[0] === idx ? [idx, start, dir] : [...p]) as Placement);
}

/**
 * A random legal fleet. *rng* returns a number in [0, 1); a placement that
 * doesn't fit is retried (a free spot always exists on an empty-enough board).
 */
export function randomFleet(rng: () => number): Fleet {
  for (;;) {
    const fleet: Fleet = [];
    const used = new Set<number>();
    let ok = true;
    for (let i = 0; i < SHIPS.length && ok; i++) {
      ok = false;
      for (let tries = 0; tries < 200; tries++) {
        const dir: Dir = rng() < 0.5 ? "h" : "v";
        const start = Math.floor(rng() * CELLS);
        const cells = shipCells(SHIPS[i].len, start, dir);
        if (!cells || cells.some((c) => used.has(c))) continue;
        for (const c of cells) used.add(c);
        fleet.push([i, start, dir]);
        ok = true;
        break;
      }
    }
    if (ok) return fleet;
  }
}

/** A random source from `crypto.getRandomValues` (works in every context). */
export function cryptoRng(): () => number {
  const buf = new Uint32Array(1);
  return () => {
    globalThis.crypto.getRandomValues(buf);
    return buf[0] / 0x100000000;
  };
}
