import { describe, expect, it } from "vitest";
import { BOTTOM, COLS, ROWS, THEIR_BAR, THEIR_OFF, TOP, isNavKey, isPointId, moveCursor, where } from "./board-nav.js";
import { BAR, OFF } from "./rules.js";

describe("the board's layout", () => {
  it("has every place once: 24 points, both bars, both trays", () => {
    const all = [...TOP, ...BOTTOM].sort((a, b) => a - b);
    expect(all).toEqual([OFF, ...Array.from({ length: 24 }, (_, i) => i + 1), BAR, THEIR_BAR, THEIR_OFF]);
    expect(TOP.length).toBe(COLS);
    expect(BOTTOM.length).toBe(COLS);
  });

  it("puts our home board bottom right and our 24-point top right, as seen from our seat", () => {
    expect(BOTTOM.slice(7, 13)).toEqual([6, 5, 4, 3, 2, 1]);
    expect(TOP[12]).toBe(24);
    expect(where(BAR)).toEqual({ row: 1, col: 6 });
    expect(where(OFF)).toEqual({ row: 1, col: 13 });
    expect(where(THEIR_BAR)).toEqual({ row: 0, col: 6 });
  });
});

describe("board keys", () => {
  it("moves along a row and between the rows, and stays put at an edge", () => {
    expect(moveCursor(8, "ArrowLeft")).toBe(9);
    expect(moveCursor(8, "ArrowRight")).toBe(7);
    expect(moveCursor(7, "ArrowRight")).toBe(BAR);
    expect(moveCursor(8, "ArrowUp")).toBe(17);
    expect(moveCursor(17, "ArrowDown")).toBe(8);
    expect(moveCursor(8, "ArrowDown")).toBe(8);
    expect(moveCursor(12, "ArrowLeft")).toBe(12);
    expect(moveCursor(OFF, "ArrowRight")).toBe(OFF);
  });

  it("jumps to the row's ends with Home and End", () => {
    expect(moveCursor(5, "Home")).toBe(12);
    expect(moveCursor(5, "End")).toBe(OFF);
    expect(moveCursor(20, "Home")).toBe(13);
    expect(moveCursor(20, "End")).toBe(THEIR_OFF);
  });

  it("knows its keys and its points", () => {
    for (const k of ["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "Home", "End"]) expect(isNavKey(k)).toBe(true);
    expect(isNavKey("Enter")).toBe(false);
    expect(isPointId(1)).toBe(true);
    expect(isPointId(24)).toBe(true);
    expect(isPointId(BAR)).toBe(false);
    expect(isPointId(OFF)).toBe(false);
    expect(ROWS).toEqual([TOP, BOTTOM]);
  });
});
