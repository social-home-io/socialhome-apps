import { describe, expect, it } from "vitest";
import { isNavKey, moveCursor, needsConfirm, startCursor } from "./board-nav.js";

describe("board keys", () => {
  it("moves one point with the arrows and stays put at the edge", () => {
    expect(moveCursor(9, 40, "ArrowUp")).toBe(31);
    expect(moveCursor(9, 40, "ArrowDown")).toBe(49);
    expect(moveCursor(9, 40, "ArrowLeft")).toBe(39);
    expect(moveCursor(9, 40, "ArrowRight")).toBe(41);
    expect(moveCursor(9, 0, "ArrowUp")).toBe(0);
    expect(moveCursor(9, 0, "ArrowLeft")).toBe(0);
    expect(moveCursor(9, 80, "ArrowDown")).toBe(80);
    expect(moveCursor(19, 18, "ArrowRight")).toBe(18);
  });

  it("jumps to row and column ends, and to the corners with Ctrl", () => {
    expect(moveCursor(13, 13 * 5 + 6, "Home")).toBe(13 * 5);
    expect(moveCursor(13, 13 * 5 + 6, "End")).toBe(13 * 5 + 12);
    expect(moveCursor(13, 13 * 5 + 6, "PageUp")).toBe(6);
    expect(moveCursor(13, 13 * 5 + 6, "PageDown")).toBe(13 * 12 + 6);
    expect(moveCursor(13, 50, "Home", true)).toBe(0);
    expect(moveCursor(13, 50, "End", true)).toBe(168);
    expect(moveCursor(13, 50, "x")).toBe(50);
  });

  it("knows which keys move", () => {
    expect(isNavKey("ArrowUp")).toBe(true);
    expect(isNavKey("Enter")).toBe(false);
  });

  it("starts at the last move, else the centre", () => {
    expect(startCursor(9, null)).toBe(40);
    expect(startCursor(19, null)).toBe(180);
    expect(startCursor(9, 12)).toBe(12);
  });

  it("asks for a second tap on 19 × 19 only", () => {
    expect(needsConfirm(9)).toBe(false);
    expect(needsConfirm(13)).toBe(false);
    expect(needsConfirm(19)).toBe(true);
  });
});
