import { describe, expect, it } from "vitest";
import {
  BLACK,
  EMPTY,
  HANDICAP_KOMI,
  KOMI,
  SIZES,
  handicapPoints,
  handicapsFor,
  isHandicap,
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
import type { Board, Size } from "./rules.js";

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
    expect(s.b).toEqual({ stones: 9, territory: 36, komi: 0, handicap: 0, total: 45 });
    expect(s.w).toEqual({ stones: 9, territory: 27, komi: KOMI, handicap: 0, total: 43.5 });
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

describe("handicap", () => {
  const names = (size: Size, n: number) => handicapPoints(size, n).map((p) => pointName(size, p)).sort();
  const sorted = (a: string[]) => [...a].sort();

  it("allows none or 2 … 9 stones on 13 × 13 and 19 × 19, 2 … 5 on 9 × 9", () => {
    expect(handicapsFor(19)).toEqual([0, 2, 3, 4, 5, 6, 7, 8, 9]);
    expect(handicapsFor(13)).toEqual([0, 2, 3, 4, 5, 6, 7, 8, 9]);
    expect(handicapsFor(9)).toEqual([0, 2, 3, 4, 5]);
    for (const bad of [1, 6, 10, -1, 2.5, "2", null]) expect(isHandicap(9, bad), String(bad)).toBe(false);
    for (const bad of [1, 10, 19]) expect(isHandicap(19, bad)).toBe(false);
    expect(handicapPoints(9, 6)).toEqual([]);
    expect(handicapPoints(19, 1)).toEqual([]);
  });

  it("puts 19 × 19 stones on the usual star points, tengen for 5, 7 and 9", () => {
    expect(names(19, 2)).toEqual(sorted(["D4", "Q16"]));
    expect(names(19, 3)).toEqual(sorted(["D4", "Q16", "Q4"]));
    expect(names(19, 4)).toEqual(sorted(["D4", "Q16", "Q4", "D16"]));
    expect(names(19, 5)).toEqual(sorted(["D4", "Q16", "Q4", "D16", "K10"]));
    expect(names(19, 6)).toEqual(sorted(["D4", "Q16", "Q4", "D16", "D10", "Q10"]));
    expect(names(19, 7)).toEqual(sorted(["D4", "Q16", "Q4", "D16", "D10", "Q10", "K10"]));
    expect(names(19, 8)).toEqual(sorted(["D4", "Q16", "Q4", "D16", "D10", "Q10", "K4", "K16"]));
    expect(names(19, 9)).toEqual(sorted(["D4", "Q16", "Q4", "D16", "D10", "Q10", "K4", "K16", "K10"]));
  });

  it("uses 13 × 13's star points the same way", () => {
    expect(names(13, 2)).toEqual(sorted(["D4", "K10"]));
    expect(names(13, 4)).toEqual(sorted(["D4", "K10", "K4", "D10"]));
    expect(names(13, 5)).toEqual(sorted(["D4", "K10", "K4", "D10", "G7"]));
    expect(names(13, 9)).toEqual(sorted(["D4", "K10", "K4", "D10", "D7", "K7", "G4", "G10", "G7"]));
  });

  it("uses 9 × 9's 3-3 points, tengen for 5", () => {
    expect(names(9, 2)).toEqual(sorted(["C3", "G7"]));
    expect(names(9, 3)).toEqual(sorted(["C3", "G7", "G3"]));
    expect(names(9, 4)).toEqual(sorted(["C3", "G7", "G3", "C7"]));
    expect(names(9, 5)).toEqual(sorted(["C3", "G7", "G3", "C7", "E5"]));
  });

  it("places exactly n distinct stones, all on star points", () => {
    for (const size of SIZES) {
      for (const n of handicapsFor(size)) {
        const pts = handicapPoints(size, n);
        expect(pts.length).toBe(n);
        expect(new Set(pts).size).toBe(n);
        for (const p of pts) expect(starPoints(size)).toContain(p);
      }
    }
  });

  it("scores a handicap game with komi 0.5 and one point per stone after the first for White", () => {
    const walls = emptyBoard(9);
    for (let r = 0; r < 9; r++) {
      walls[r * 9 + 4] = BLACK;
      walls[r * 9 + 5] = WHITE;
    }
    // Black: 9 stones + 36; White: 9 stones + 27 + 0.5 komi + 3 for a 4-stone handicap.
    const s = scoreArea(walls, 9, [], 4);
    expect(s.b).toEqual({ stones: 9, territory: 36, komi: 0, handicap: 0, total: 45 });
    expect(s.w).toEqual({ stones: 9, territory: 27, komi: HANDICAP_KOMI, handicap: 3, total: 39.5 });
    expect(s.winner).toBe("b");
    expect(s.margin).toBe(5.5);
    // 2 stones: White gets 1 point for the handicap.
    expect(scoreArea(walls, 9, [], 2).w.total).toBe(9 + 27 + 0.5 + 1);
    // No handicap: the usual komi.
    expect(scoreArea(walls, 9, [], 0).w).toMatchObject({ komi: KOMI, handicap: 0 });
  });
});
