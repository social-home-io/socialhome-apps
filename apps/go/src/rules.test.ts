import { describe, expect, it } from "vitest";
import {
  BLACK,
  EMPTY,
  KOMI,
  WHITE,
  chainAt,
  emptyBoard,
  isSize,
  neighbours,
  place,
  pointName,
  scoreArea,
  starPoints,
} from "./rules.js";
import type { Board } from "./rules.js";

/** A board from rows of `.`, `B`, `W` (row 0 at the top). */
function board(rows: string[]): Board {
  return rows.join("").split("").map((ch) => (ch === "B" ? BLACK : ch === "W" ? WHITE : EMPTY));
}

const E9 = ".........";

describe("points", () => {
  it("names points A–T without I, rows from the bottom", () => {
    expect(pointName(9, 0)).toBe("A9");
    expect(pointName(9, 80)).toBe("J1");
    expect(pointName(19, 3 * 19 + 3)).toBe("D16");
    expect(pointName(19, 18 * 19 + 18)).toBe("T1");
    expect(pointName(13, 8)).toBe("J13"); // the ninth column is J: no I
  });

  it("knows the board sizes", () => {
    expect([9, 13, 19].every(isSize)).toBe(true);
    expect([0, 8, 10, 21, "9", null].some(isSize)).toBe(false);
  });

  it("finds neighbours at edges and corners", () => {
    expect(neighbours(9, 0).sort((a, b) => a - b)).toEqual([1, 9]);
    expect(neighbours(9, 4).length).toBe(3);
    expect(neighbours(9, 40).length).toBe(4);
    expect(neighbours(9, 80).sort((a, b) => a - b)).toEqual([71, 79]);
  });

  it("puts star points where they belong", () => {
    expect(starPoints(9).map((p) => pointName(9, p))).toEqual(["C7", "G7", "E5", "C3", "G3"]);
    expect(starPoints(13)).toHaveLength(9);
    expect(starPoints(19).map((p) => pointName(19, p))).toContain("K10");
  });
});

describe("captures", () => {
  it("takes a single stone in the corner", () => {
    const b = board(["WB.......", E9, E9, E9, E9, E9, E9, E9, E9]);
    const r = place(b, 9, 9, "b");
    expect(r.ok && r.captured).toEqual([0]);
    expect(r.ok && r.board[0]).toBe(EMPTY);
  });

  it("takes a chain of several stones along the edge", () => {
    const open = board(["WWW......", "BBB......", E9, E9, E9, E9, E9, E9, E9]);
    const r = place(open, 9, 3, "b");
    expect(r.ok && r.captured).toEqual([0, 1, 2]);
  });

  it("takes two separate chains with one stone", () => {
    // White on B8 and B6 each have one liberty left: B7.
    const s = board([".B.......", "BWB......", E9, "BWB......", ".B.......", E9, E9, E9, E9]);
    const r = place(s, 9, 19, "b");
    expect(r.ok && r.captured).toEqual([10, 28]);
  });

  it("refuses suicide, allows a move that captures first", () => {
    const corner = board([".B.......", "B........", E9, E9, E9, E9, E9, E9, E9]);
    expect(place(corner, 9, 0, "w")).toEqual({ ok: false, error: "suicide" });
    // A white stone that fills its own last liberty but takes the black stone first:
    const snap = board([".BW......", "BW.......", E9, E9, E9, E9, E9, E9, E9]);
    const r = place(snap, 9, 0, "w");
    expect(r.ok && r.captured).toEqual([1]);
  });

  it("refuses multi-stone suicide", () => {
    const t = board(["W.WB.....", "WWWB.....", "BBB......", E9, E9, E9, E9, E9, E9]);
    expect(place(t, 9, 1, "w")).toEqual({ ok: false, error: "suicide" });
  });

  it("refuses an occupied point", () => {
    expect(place(board(["B........", E9, E9, E9, E9, E9, E9, E9, E9]), 9, 0, "w")).toEqual({ ok: false, error: "occupied" });
  });

  it("reports chains and liberties", () => {
    const b = board(["BB.......", "W........", E9, E9, E9, E9, E9, E9, E9]);
    expect(chainAt(b, 9, 0)).toEqual({ stones: [0, 1], liberties: 2 });
    expect(chainAt(b, 9, 40)).toEqual({ stones: [], liberties: 0 });
  });
});

describe("area scoring", () => {
  // Black wall on column E, white wall on column F.
  const walls = board(Array.from({ length: 9 }, () => "....BW..."));

  it("counts stones plus surrounded points, komi for White", () => {
    const s = scoreArea(walls, 9, []);
    expect(s.b).toEqual({ stones: 9, territory: 36, komi: 0, total: 45 });
    expect(s.w).toEqual({ stones: 9, territory: 27, komi: KOMI, total: 43.5 });
    expect(s.winner).toBe("b");
    expect(s.margin).toBe(1.5);
  });

  it("takes dead stones off first: their points count for the side around them", () => {
    const invaded = walls.slice();
    invaded[0] = WHITE;
    const unmarked = scoreArea(invaded, 9, []);
    expect(unmarked.b.territory).toBe(0); // the region touches a white stone: nobody's
    expect(unmarked.winner).toBe("w");
    const marked = scoreArea(invaded, 9, [0]);
    expect(marked.b.total).toBe(45);
    expect(marked.owner[0]).toBe(BLACK);
  });

  it("an empty board is nobody's: White wins by komi", () => {
    const s = scoreArea(emptyBoard(9), 9, []);
    expect(s.b.total).toBe(0);
    expect(s.w.total).toBe(KOMI);
    expect(s.winner).toBe("w");
  });

  it("seki points touching both colours count for nobody", () => {
    const b = board(["B.W......", "B.W......", "BBWWWWWWW", E9, E9, E9, E9, E9, E9]);
    const s = scoreArea(b, 9, []);
    expect(s.owner[1]).toBe(EMPTY);
    expect(s.owner[10]).toBe(EMPTY);
  });
});
