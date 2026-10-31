/**
 * Keyboard moves on the board — pure, tested.
 *
 * The board is one `role="grid"` with a roving tabindex (one Tab stop).
 * Arrows move one point, Home / End go to the row's ends (with Ctrl: the
 * board's corners), PageUp / PageDown to the column's ends. The board always
 * runs A → T left to right, in a right-to-left language too, so ArrowLeft
 * always means "towards A".
 */

const NAV_KEYS = new Set(["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "Home", "End", "PageUp", "PageDown"]);

export function isNavKey(key: string): boolean {
  return NAV_KEYS.has(key);
}

/** The point the cursor moves to on a *size* board; the same point at an edge. */
export function moveCursor(size: number, p: number, key: string, ctrl = false): number {
  const r = Math.floor(p / size);
  const c = p % size;
  const at = (row: number, col: number) => row * size + col;
  switch (key) {
    case "ArrowUp":
      return r > 0 ? at(r - 1, c) : p;
    case "ArrowDown":
      return r < size - 1 ? at(r + 1, c) : p;
    case "ArrowLeft":
      return c > 0 ? at(r, c - 1) : p;
    case "ArrowRight":
      return c < size - 1 ? at(r, c + 1) : p;
    case "Home":
      return ctrl ? 0 : at(r, 0);
    case "End":
      return ctrl ? size * size - 1 : at(r, size - 1);
    case "PageUp":
      return at(0, c);
    case "PageDown":
      return at(size - 1, c);
    default:
      return p;
  }
}

/** Where the cursor starts: the last move, else the centre. */
export function startCursor(size: number, last: number | null): number {
  if (last !== null && last >= 0 && last < size * size) return last;
  const mid = Math.floor(size / 2);
  return mid * size + mid;
}

/**
 * Whether a tap only previews the stone (a second tap or "Place" plays it):
 * on 19 × 19, where a point is small enough on a phone to miss.
 */
export function needsConfirm(size: number): boolean {
  return size >= 19;
}
