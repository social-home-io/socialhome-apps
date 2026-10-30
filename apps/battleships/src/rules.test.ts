import { describe, expect, it } from "vitest";
import {
  CELLS,
  FLEET_SQUARES,
  SHIPS,
  canPlace,
  cellName,
  cryptoRng,
  fleetBits,
  isLegalFleet,
  parseFleet,
  parsePlacement,
  randomFleet,
  shipCells,
  shipMap,
  withShip,
} from "./rules.js";
import type { Fleet } from "./rules.js";

/** A small seeded PRNG (mulberry32) so random tests repeat. */
function seeded(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const CLASSIC: Fleet = [
  [0, 11, "h"], // B2–F2
  [1, 27, "v"], // H3–H6
  [2, 70, "h"], // A8–C8
  [3, 44, "v"], // E5–E7
  [4, 88, "h"], // I9–J9
];

describe("board", () => {
  it("names squares A1 … J10, A1 top-left", () => {
    expect(cellName(0)).toBe("A1");
    expect(cellName(9)).toBe("J1");
    expect(cellName(82)).toBe("C9");
    expect(cellName(99)).toBe("J10");
  });

  it("has the five classic ships, 17 squares", () => {
    expect(SHIPS.map((s) => s.len)).toEqual([5, 4, 3, 3, 2]);
    expect(FLEET_SQUARES).toBe(17);
  });

  it("lays ships in straight lines inside the board", () => {
    expect(shipCells(3, 7, "h")).toEqual([7, 8, 9]);
    expect(shipCells(3, 8, "h")).toBeNull();
    expect(shipCells(2, 80, "v")).toEqual([80, 90]);
    expect(shipCells(2, 90, "v")).toBeNull();
    expect(shipCells(2, -1, "h")).toBeNull();
  });
});

describe("fleet legality", () => {
  it("accepts the classic fleet; ships may touch", () => {
    expect(isLegalFleet(CLASSIC)).toBe(true);
    const touching: Fleet = [
      [0, 0, "h"],
      [1, 10, "h"],
      [2, 20, "h"],
      [3, 30, "h"],
      [4, 40, "h"],
    ];
    expect(isLegalFleet(touching)).toBe(true);
  });

  it("refuses overlap, a missing ship, wrong order and ships off the board", () => {
    expect(isLegalFleet(withShip(CLASSIC, 4, 11, "v"))).toBe(false); // over the carrier
    expect(isLegalFleet(CLASSIC.slice(0, 4))).toBe(false);
    expect(isLegalFleet([CLASSIC[1], CLASSIC[0], ...CLASSIC.slice(2)])).toBe(false);
    expect(isLegalFleet(withShip(CLASSIC, 0, 8, "h"))).toBe(false);
  });

  it("parses fleets and placements from untrusted input", () => {
    expect(parseFleet(JSON.parse(JSON.stringify(CLASSIC)))).toEqual(CLASSIC);
    expect(parseFleet("x")).toBeNull();
    expect(parseFleet([...CLASSIC, [4, 0, "h"]])).toBeNull();
    expect(parseFleet(withShip(CLASSIC, 4, 11, "v"))).toBeNull();
    expect(parsePlacement([2, 70, "h"])).toEqual([2, 70, "h"]);
    expect(parsePlacement([2, 70, "d"])).toBeNull();
    expect(parsePlacement([5, 70, "h"])).toBeNull();
    expect(parsePlacement([0, 8, "h"])).toBeNull();
    expect(parsePlacement([0, 1.5, "h"])).toBeNull();
    expect(parsePlacement([0, 1, "h", 1])).toBeNull();
  });

  it("maps ships to squares and bits", () => {
    const map = shipMap(CLASSIC);
    expect(map[11]).toBe(0);
    expect(map[57]).toBe(1);
    expect(map[0]).toBe(-1);
    const bits = fleetBits(CLASSIC);
    expect(bits.reduce((a, b) => a + b, 0)).toBe(17);
    expect(bits.length).toBe(CELLS);
  });

  it("moves a ship only where it fits (ignoring itself)", () => {
    expect(canPlace(CLASSIC, 0, 12, "h")).toBe(true); // one square right, overlaps only itself
    expect(canPlace(CLASSIC, 4, 11, "v")).toBe(false);
    expect(canPlace(CLASSIC, 4, 99, "h")).toBe(false);
    const moved = withShip(CLASSIC, 0, 12, "h");
    expect(moved[0]).toEqual([0, 12, "h"]);
    expect(CLASSIC[0]).toEqual([0, 11, "h"]); // the original is untouched
  });
});

describe("randomFleet", () => {
  it("always returns a legal fleet (1,000 seeds)", () => {
    for (let s = 0; s < 1000; s++) expect(isLegalFleet(randomFleet(seeded(s)))).toBe(true);
  });

  it("varies with the random source", () => {
    expect(randomFleet(seeded(1))).not.toEqual(randomFleet(seeded(2)));
  });

  it("works from crypto.getRandomValues", () => {
    expect(isLegalFleet(randomFleet(cryptoRng()))).toBe(true);
  });
});
