/**
 * The board's layout and keyboard moves — pure, tested.
 *
 * The board is one `role="grid"` of two rows with a roving tabindex (one
 * Tab stop), in the viewer's numbering, laid out as on a real board seen
 * from your seat:
 *
 *   13 14 15 16 17 18 | their bar | 19 20 21 22 23 24 | their tray
 *   12 11 10  9  8  7 | your bar  |  6  5  4  3  2  1 | your tray
 *
 * Your checkers travel 24 → 1 (along the top to the left, then along the
 * bottom to the right) and off into your tray. That direction is the
 * game's, not the reading direction's: the board never mirrors, in a
 * right-to-left language too, so ArrowLeft always means "towards 13 / 12".
 */

import { BAR, OFF } from "./rules.js";

/** Their bar and their borne-off tray, as places on our board. */
export const THEIR_BAR = 26;
export const THEIR_OFF = 27;

export const COLS = 14;

export const TOP: readonly number[] = [13, 14, 15, 16, 17, 18, THEIR_BAR, 19, 20, 21, 22, 23, 24, THEIR_OFF];
export const BOTTOM: readonly number[] = [12, 11, 10, 9, 8, 7, BAR, 6, 5, 4, 3, 2, 1, OFF];
export const ROWS: readonly (readonly number[])[] = [TOP, BOTTOM];

/** Row and column of a place. */
export function where(id: number): { row: number; col: number } {
  const top = TOP.indexOf(id);
  if (top >= 0) return { row: 0, col: top };
  return { row: 1, col: BOTTOM.indexOf(id) };
}

const NAV_KEYS = new Set(["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "Home", "End"]);

export function isNavKey(key: string): boolean {
  return NAV_KEYS.has(key);
}

/** The place the cursor moves to; the same place at an edge. */
export function moveCursor(id: number, key: string): number {
  const { row, col } = where(id);
  if (col < 0) return id;
  switch (key) {
    case "ArrowUp":
      return ROWS[0][col];
    case "ArrowDown":
      return ROWS[1][col];
    case "ArrowLeft":
      return col > 0 ? ROWS[row][col - 1] : id;
    case "ArrowRight":
      return col < COLS - 1 ? ROWS[row][col + 1] : id;
    case "Home":
      return ROWS[row][0];
    case "End":
      return ROWS[row][COLS - 1];
    default:
      return id;
  }
}

/** Whether *id* is a point (1 … 24) rather than a bar or tray. */
export function isPointId(id: number): boolean {
  return id >= 1 && id <= 24;
}
