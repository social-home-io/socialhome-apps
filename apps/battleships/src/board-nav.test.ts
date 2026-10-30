import { afterEach, describe, expect, it } from "vitest";
import { dropFits, dropStart, droppedText, isNavKey, moveCursor, nudgeShip, placementText, rotateShip } from "./board-nav.js";
import { setLocale } from "./i18n.js";
import type { Fleet } from "./rules.js";

afterEach(() => setLocale("en"));

const FLEET: Fleet = [[0, 11, "h"], [1, 27, "v"], [2, 70, "h"], [3, 44, "v"], [4, 88, "h"]];

describe("grid cursor", () => {
  it.each([
    [44, "ArrowUp", 34], [44, "ArrowDown", 54], [44, "ArrowLeft", 43], [44, "ArrowRight", 45],
    [0, "ArrowUp", 0], [0, "ArrowLeft", 0], [99, "ArrowDown", 99], [99, "ArrowRight", 99],
    [44, "Home", 40], [44, "End", 49], [44, "PageUp", 4], [44, "PageDown", 94], [44, "x", 44],
  ])("%i %s → %i", (from, key, want) => {
    expect(moveCursor(from, key)).toBe(want);
  });

  it("Ctrl+Home / Ctrl+End go to the corners", () => {
    expect(moveCursor(44, "Home", true)).toBe(0);
    expect(moveCursor(44, "End", true)).toBe(99);
  });

  it("knows its keys", () => {
    expect(isNavKey("ArrowUp")).toBe(true);
    expect(isNavKey("Enter")).toBe(false);
  });
});

describe("moving ships with the keyboard", () => {
  it("nudges a ship one square where it fits", () => {
    expect(nudgeShip(FLEET, 2, "ArrowDown")).toEqual([2, 80, "h"]);
    expect(nudgeShip(FLEET, 2, "ArrowLeft")).toBeNull(); // the board's edge
    expect(nudgeShip(FLEET, 4, "ArrowRight")).toBeNull(); // J9 is the edge
    expect(nudgeShip(FLEET, 0, "ArrowRight")).toEqual([0, 12, "h"]);
    expect(nudgeShip(FLEET, 3, "ArrowUp")).toEqual([3, 34, "v"]);
    expect(nudgeShip(FLEET, 3, "Home")).toBeNull();
    expect(nudgeShip(FLEET, 0, "ArrowUp")).toEqual([0, 1, "h"]);
    expect(nudgeShip([[0, 0, "h"], [1, 10, "h"], [2, 20, "h"], [3, 30, "h"], [4, 40, "h"]], 0, "ArrowDown")).toBeNull();
  });

  it("rotates in place, or slides back to fit", () => {
    expect(rotateShip(FLEET, 2)).toEqual([2, 70, "v"]); // A8 down to A10
    expect(rotateShip(FLEET, 4)).toEqual([4, 88, "v"]);
    expect(rotateShip([[0, 90, "h"], [1, 0, "h"], [2, 20, "h"], [3, 30, "h"], [4, 40, "h"]], 0)).toEqual([0, 50, "v"]);
    expect(rotateShip([[0, 0, "h"], [1, 10, "h"], [2, 20, "h"], [3, 30, "h"], [4, 40, "h"]], 0)).toBeNull();
  });

  it("drops a dragged ship by the square it was held at", () => {
    expect(dropStart(55, 2, "h")).toBe(53);
    expect(dropStart(55, 2, "v")).toBe(35);
    expect(dropFits(51, 2, "h", 3)).toBe(false);
    expect(dropFits(52, 2, "h", 3)).toBe(true);
    expect(dropFits(98, 0, "h", 3)).toBe(false);
    expect(dropFits(85, 0, "v", 3)).toBe(false);
    expect(dropFits(15, 2, "v", 3)).toBe(false);
  });

  it("says where a ship is", () => {
    expect(placementText([2, 60, "v"])).toBe("Cruiser at A7 to A9, down.");
    expect(droppedText([0, 11, "h"])).toBe("Carrier placed at B2 to F2.");
    setLocale("fr");
    expect(placementText([2, 60, "v"])).toBe("Croiseur de A7 à A9, vertical.");
  });
});
