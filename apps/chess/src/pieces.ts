/**
 * Chess's own piece set: simple SVG figures drawn for this app (MPL-2.0, like
 * the rest of the repo), inlined in the single bundle — no font, no file.
 *
 * Each figure is a few closed shapes (`body`) plus thin inner lines
 * (`detail`) on a 45 × 45 grid. White figures are white with a dark outline;
 * black figures are near-black with a black outline and light inner lines,
 * so each side reads as itself on light and dark squares, in light and dark
 * themes, on every platform (Unicode glyphs depend on the font and may turn
 * into colour emoji).
 */
import type { Color, PieceType } from "./chess.js";

export interface PieceShape {
  /** "body" = filled with the piece colour; "detail" = an inner line only. */
  kind: "body" | "detail";
  d: string;
}

/** A circle as a path (keeps every shape one element type). */
const circle = (cx: number, cy: number, r: number): string =>
  `M ${cx - r} ${cy} a ${r} ${r} 0 1 0 ${2 * r} 0 a ${r} ${r} 0 1 0 ${-2 * r} 0 Z`;

/** A rounded rectangle as a path. */
const rect = (x: number, y: number, w: number, h: number, r: number): string =>
  `M ${x + r} ${y} h ${w - 2 * r} a ${r} ${r} 0 0 1 ${r} ${r} v ${h - 2 * r} a ${r} ${r} 0 0 1 ${-r} ${r} ` +
  `h ${-(w - 2 * r)} a ${r} ${r} 0 0 1 ${-r} ${-r} v ${-(h - 2 * r)} a ${r} ${r} 0 0 1 ${r} ${-r} Z`;

const BASE = rect(9.5, 35, 26, 4.5, 2);

export const PIECE_SHAPES: Record<PieceType, readonly PieceShape[]> = {
  P: [
    { kind: "body", d: "M 15.5 36 C 15.5 30 18 26 20 22.5 L 25 22.5 C 27 26 29.5 30 29.5 36 Z" },
    { kind: "body", d: rect(17, 19.5, 11, 3.5, 1.75) },
    { kind: "body", d: circle(22.5, 13, 5.5) },
    { kind: "body", d: rect(11.5, 35, 22, 4.5, 2) },
  ],
  R: [
    { kind: "body", d: "M 14 32 L 15 17 L 30 17 L 31 32 Z" },
    { kind: "body", d: rect(12, 30.5, 21, 4.5, 1) },
    {
      kind: "body",
      d: "M 12 17.5 L 12 9 L 16.5 9 L 16.5 12 L 20.5 12 L 20.5 9 L 24.5 9 L 24.5 12 L 28.5 12 L 28.5 9 L 33 9 L 33 17.5 Z",
    },
    { kind: "body", d: BASE },
    { kind: "detail", d: "M 15 20.5 L 30 20.5" },
  ],
  N: [
    {
      kind: "body",
      d:
        "M 13 37 C 13.5 31 17 28 20.5 23 C 18 24.8 15.5 25.8 13 26.5 C 11 28.5 8.5 28 8.2 25.6 " +
        "C 8 23 9.5 19.5 12 16.5 C 13 14.5 14 12.8 15.5 11.5 L 16.5 7.5 L 19.2 10.6 " +
        "C 24.5 10.5 30 13 33 18.5 C 36 24.5 35.8 31 35 37 Z",
    },
    { kind: "body", d: BASE },
    { kind: "detail", d: circle(15.3, 16, 1.2) },
    { kind: "detail", d: "M 29.5 15 C 32.5 20 33.5 27 32.8 34" },
    { kind: "detail", d: "M 9.8 24.6 L 11.6 24.2" },
  ],
  B: [
    { kind: "body", d: "M 15 36 C 16 32 18 29.5 19 27 L 26 27 C 27 29.5 29 32 30 36 Z" },
    { kind: "body", d: rect(16.5, 24.5, 12, 3.5, 1.75) },
    {
      kind: "body",
      d: "M 22.5 8.5 C 17.5 12.5 15 16.5 15.8 20.5 C 16.5 23.4 19 24.8 22.5 24.8 C 26 24.8 28.5 23.4 29.2 20.5 C 30 16.5 27.5 12.5 22.5 8.5 Z",
    },
    { kind: "body", d: circle(22.5, 6.3, 2.3) },
    { kind: "body", d: BASE },
    { kind: "detail", d: "M 25.6 13.2 L 21 19.6" },
  ],
  Q: [
    {
      kind: "body",
      d: "M 11.5 35 L 9 15 L 15.5 26 L 16.5 12 L 21 24.5 L 22.5 10 L 24 24.5 L 28.5 12 L 29.5 26 L 36 15 L 33.5 35 Z",
    },
    { kind: "body", d: circle(9, 13, 2.3) },
    { kind: "body", d: circle(16.5, 10, 2.3) },
    { kind: "body", d: circle(22.5, 8, 2.3) },
    { kind: "body", d: circle(28.5, 10, 2.3) },
    { kind: "body", d: circle(36, 13, 2.3) },
    { kind: "body", d: BASE },
    { kind: "detail", d: "M 12.3 30.5 L 32.7 30.5" },
  ],
  K: [
    {
      kind: "body",
      d: "M 11.5 35 C 9 29.5 9 24 12.8 21.2 C 16.3 18.8 20.3 20.2 22.5 23.5 C 24.7 20.2 28.7 18.8 32.2 21.2 C 36 24 36 29.5 33.5 35 Z",
    },
    { kind: "body", d: "M 21 5.5 L 24 5.5 L 24 8.5 L 27 8.5 L 27 11.5 L 24 11.5 L 24 19 L 21 19 L 21 11.5 L 18 11.5 L 18 8.5 L 21 8.5 Z" },
    { kind: "body", d: BASE },
    { kind: "detail", d: "M 12.3 30.5 L 32.7 30.5" },
    { kind: "detail", d: "M 22.5 23.5 L 22.5 30.5" },
  ],
};

/** The colours a side is drawn in. */
export const PIECE_COLORS: Record<Color, { fill: string; stroke: string; detail: string }> = {
  w: { fill: "#ffffff", stroke: "#1a1814", detail: "#1a1814" },
  b: { fill: "#262320", stroke: "#000000", detail: "#efe6d6" },
};

const SVG_NS = "http://www.w3.org/2000/svg";

/**
 * One piece as an `<svg>` element (decorative: `aria-hidden`; the square's
 * label names the piece). Built with DOM calls — no markup strings.
 */
export function pieceSvg(doc: Document, color: Color, type: PieceType, cls = "piece"): SVGSVGElement {
  const svg = doc.createElementNS(SVG_NS, "svg");
  svg.setAttribute("viewBox", "0 0 45 45");
  svg.setAttribute("class", `${cls} piece--${color}`);
  svg.setAttribute("aria-hidden", "true");
  svg.setAttribute("focusable", "false");
  svg.dataset["piece"] = color + type;
  const colors = PIECE_COLORS[color];
  for (const shape of PIECE_SHAPES[type]) {
    const path = doc.createElementNS(SVG_NS, "path");
    path.setAttribute("d", shape.d);
    path.setAttribute("stroke-linejoin", "round");
    path.setAttribute("stroke-linecap", "round");
    if (shape.kind === "body") {
      path.setAttribute("fill", colors.fill);
      path.setAttribute("stroke", colors.stroke);
      path.setAttribute("stroke-width", "1.5");
    } else {
      path.setAttribute("fill", "none");
      path.setAttribute("stroke", colors.detail);
      path.setAttribute("stroke-width", "1.3");
    }
    svg.appendChild(path);
  }
  return svg;
}
