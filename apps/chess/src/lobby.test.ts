import { describe, expect, it } from "vitest";
import { applyAction, applyMove, initialState, parseSquare } from "./chess.js";
import type { GameState } from "./chess.js";
import { gameMeta, groupGames } from "./lobby.js";
import type { GameEntry } from "./lifecycle.js";

const e4 = { from: parseSquare("e2"), to: parseSquare("e4") };
const nf6 = { from: parseSquare("g8"), to: parseSquare("f6") };
function game(id: string, myColor: "w" | "b", state: GameState, updatedAt: number): GameEntry {
  return {
    sessionId: id, opponentInstanceId: "i", opponentRef: "ben", opponentIsLocal: false,
    opponentName: "Ben", myColor, state, updatedAt,
  };
}

describe("groupGames", () => {
  it("your turn → waiting → finished, newest first in each", () => {
    const fresh = initialState();
    const afterE4 = applyMove(fresh, e4);
    const over = applyAction(fresh, { action: "resign", by: "b" });
    const g = groupGames([
      game("old-turn", "w", fresh, 1),
      game("waiting", "w", afterE4, 5),
      game("done", "w", over, 9),
      game("new-turn", "b", afterE4, 7),
      game("old-done", "b", over, 2),
    ]);
    expect(g.yourTurn.map((x) => x.sessionId)).toEqual(["new-turn", "old-turn"]);
    expect(g.waiting.map((x) => x.sessionId)).toEqual(["waiting"]);
    expect(g.finished.map((x) => x.sessionId)).toEqual(["done", "old-done"]);
  });
});

describe("gameMeta tells games with the same person apart", () => {
  it("not started / move number and last move", () => {
    expect(gameMeta(game("a", "w", initialState(), 0))).toBe("White · not started");
    const s = applyMove(applyMove(initialState(), e4), nf6);
    expect(gameMeta(game("b", "b", s, 0))).toBe("Black · move 1 · Nf6");
    expect(gameMeta(game("c", "w", applyMove(s, { from: parseSquare("d2"), to: parseSquare("d4") }), 0))).toBe(
      "White · move 2 · d4",
    );
  });
});
