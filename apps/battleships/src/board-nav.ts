/**
 * Keyboard and placement helpers for the two 10 × 10 grids — pure, tested.
 *
 * Each board is one `role="grid"` with a roving tabindex (one Tab stop per
 * board, so Tab switches boards). Arrows move one square, Home / End go to
 * the row's ends (with Ctrl: the board's corners), PageUp / PageDown to the
 * column's ends. The board always runs A → J left to right, in a
 * right-to-left language too, so ArrowLeft always means "towards A".
 */

import { SHIPS, SIZE, canPlace, cellName, colOf, placementCells, rowOf } from "./rules.js";
import type { Dir, Fleet, Placement } from "./rules.js";
import { t } from "./i18n.js";
import { shipTitle } from "./view.js";

const NAV_KEYS = new Set(["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "Home", "End", "PageUp", "PageDown"]);

export function isNavKey(key: string): boolean {
  return NAV_KEYS.has(key);
}

/** The square the cursor moves to; the same square at an edge. */
export function moveCursor(cell: number, key: string, ctrl = false): number {
  const r = rowOf(cell);
  const c = colOf(cell);
  const at = (row: number, col: number) => row * SIZE + col;
  switch (key) {
    case "ArrowUp":
      return r > 0 ? at(r - 1, c) : cell;
    case "ArrowDown":
      return r < SIZE - 1 ? at(r + 1, c) : cell;
    case "ArrowLeft":
      return c > 0 ? at(r, c - 1) : cell;
    case "ArrowRight":
      return c < SIZE - 1 ? at(r, c + 1) : cell;
    case "Home":
      return ctrl ? 0 : at(r, 0);
    case "End":
      return ctrl ? SIZE * SIZE - 1 : at(r, SIZE - 1);
    case "PageUp":
      return at(0, c);
    case "PageDown":
      return at(SIZE - 1, c);
    default:
      return cell;
  }
}

/** Ship *idx* moved one square by an arrow key, or `null` if it can't go there. */
export function nudgeShip(fleet: Fleet, idx: number, key: string): Placement | null {
  const [, start, dir] = fleet[idx];
  const r = rowOf(start);
  const c = colOf(start);
  const delta: Record<string, [number, number]> = {
    ArrowUp: [-1, 0],
    ArrowDown: [1, 0],
    ArrowLeft: [0, -1],
    ArrowRight: [0, 1],
  };
  const d = delta[key];
  if (!d) return null;
  const nr = r + d[0];
  const nc = c + d[1];
  if (nr < 0 || nc < 0 || nr >= SIZE || nc >= SIZE) return null;
  const next = nr * SIZE + nc;
  return canPlace(fleet, idx, next, dir) ? [idx, next, dir] : null;
}

/**
 * Ship *idx* turned a quarter: from its first square if it fits, else slid
 * back along the new direction until it does; `null` when nothing fits.
 */
export function rotateShip(fleet: Fleet, idx: number): Placement | null {
  const [, start, dir] = fleet[idx];
  const nd: Dir = dir === "h" ? "v" : "h";
  const len = SHIPS[idx].len;
  for (let back = 0; back < len; back++) {
    const r = rowOf(start) - (nd === "v" ? back : 0);
    const c = colOf(start) - (nd === "h" ? back : 0);
    if (r < 0 || c < 0) break;
    const s = r * SIZE + c;
    if (canPlace(fleet, idx, s, nd)) return [idx, s, nd];
  }
  return null;
}

/** Where the ship would start when dragged by its *grip*-th square onto *cell*. */
export function dropStart(cell: number, grip: number, dir: Dir): number {
  return dir === "h" ? cell - grip : cell - grip * SIZE;
}

/** Whether *start* keeps the drag on the same row (h) / column (v) and on the board. */
export function dropFits(cell: number, grip: number, dir: Dir, len: number): boolean {
  if (dir === "h") return colOf(cell) - grip >= 0 && colOf(cell) - grip + len <= SIZE;
  return rowOf(cell) - grip >= 0 && rowOf(cell) - grip + len <= SIZE;
}

/** "Cruiser at A7 to A9, down." */
export function placementText(p: Placement): string {
  const cells = placementCells(p) ?? [p[1]];
  return t("place.at", {
    ship: shipTitle(p[0]),
    from: cellName(cells[0]),
    to: cellName(cells[cells.length - 1]),
    dir: t(p[2] === "h" ? "dir.h" : "dir.v"),
  });
}

export function droppedText(p: Placement): string {
  const cells = placementCells(p) ?? [p[1]];
  return t("place.dropped", { ship: shipTitle(p[0]), from: cellName(cells[0]), to: cellName(cells[cells.length - 1]) });
}
