import { describe, expect, it } from "vitest";
import { PIECE_COLORS, PIECE_SHAPES } from "./pieces.js";

const TYPES = ["K", "Q", "R", "B", "N", "P"] as const;

describe("the SVG piece set", () => {
  it("has a figure with a filled body for every piece", () => {
    for (const type of TYPES) {
      const shapes = PIECE_SHAPES[type];
      expect(shapes.some((s) => s.kind === "body"), type).toBe(true);
      for (const s of shapes) expect(s.d, type).toMatch(/^M [\d.]+ [\d.]+/);
    }
  });

  it("stays on the 45 × 45 grid", () => {
    for (const type of TYPES) {
      for (const s of PIECE_SHAPES[type]) {
        // Absolute coordinates only after M / L (relative arcs are small).
        for (const [, x, y] of s.d.matchAll(/[ML] ([\d.]+) ([\d.]+)/g)) {
          expect(Number(x)).toBeLessThanOrEqual(45);
          expect(Number(y)).toBeLessThanOrEqual(45);
        }
      }
    }
  });

  it("white is white, black is dark with light inner lines (both sides readable)", () => {
    expect(PIECE_COLORS.w.fill).toBe("#ffffff");
    const lum = (hex: string): number => {
      const n = parseInt(hex.slice(1), 16);
      return (0.2126 * (n >> 16) + 0.7152 * ((n >> 8) & 255) + 0.0722 * (n & 255)) / 255;
    };
    expect(lum(PIECE_COLORS.b.fill)).toBeLessThan(0.2);
    expect(lum(PIECE_COLORS.b.detail)).toBeGreaterThan(0.8);
    expect(lum(PIECE_COLORS.w.stroke)).toBeLessThan(0.2);
  });
});
