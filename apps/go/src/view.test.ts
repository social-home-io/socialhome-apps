import { afterEach, describe, expect, it } from "vitest";
import { announceInbound, announceOwn, cellLabel, chipFor, metaFor, resultLine, statusFor } from "./view.js";
import { groupGames } from "./lobby.js";
import { replay } from "./game.js";
import type { Entry } from "./game.js";
import type { GameEntry } from "./lifecycle.js";
import { setLocale } from "./i18n.js";

const at = (r: number, c: number): number => r * 9 + c;

function entry(over: Partial<GameEntry> = {}): GameEntry {
  return {
    sessionId: "s1", opponentInstanceId: "inst-b", opponentRef: "ben", opponentIsLocal: false,
    opponentName: "Ben · Lakeside", role: "inviter", size: 9, myColor: "b", log: [], heard: true, updatedAt: 1, ...over,
  };
}

function wallsGame(): Entry[] {
  const log: Entry[] = [];
  for (let r = 0; r < 9; r++) log.push(at(r, 4), at(r, 5));
  log.push("pass", at(0, 0), "pass", "pass");
  return log;
}

const state = (log: Entry[]) => replay(9, log)!.state;

afterEach(() => setLocale("en"));

describe("lobby", () => {
  it("groups your turn → waiting → finished, newest first", () => {
    const g = groupGames([
      entry({ sessionId: "old-turn", updatedAt: 1 }),
      entry({ sessionId: "waiting", log: [40], updatedAt: 5 }),
      entry({ sessionId: "done", log: ["resign-w"], updatedAt: 9 }),
      entry({ sessionId: "new-turn", myColor: "w", log: [40], updatedAt: 7 }),
      entry({ sessionId: "setup", role: "invitee", size: null, myColor: null, updatedAt: 3 }),
    ]);
    expect(g.yourTurn.map((x) => x.sessionId)).toEqual(["new-turn", "old-turn"]);
    expect(g.waiting.map((x) => x.sessionId)).toEqual(["waiting", "setup"]);
    expect(g.finished.map((x) => x.sessionId)).toEqual(["done"]);
  });

  it("chips and meta lines", () => {
    expect(chipFor(entry())).toEqual({ text: "Your turn", tone: "turn" });
    expect(chipFor(entry({ heard: false, log: [40] }))).toEqual({ text: "Invite sent", tone: "wait" });
    expect(chipFor(entry({ log: [40] }))).toEqual({ text: "Ben's turn", tone: "wait" });
    expect(chipFor(entry({ log: ["resign-w"] }))).toEqual({ text: "You won", tone: "good" });
    expect(chipFor(entry({ log: ["resign-b"] }))).toEqual({ text: "You lost", tone: "bad" });
    expect(chipFor(entry({ log: wallsGame() }))).toEqual({ text: "Counting", tone: "turn" });
    expect(chipFor(entry({ size: null, myColor: null, role: "invitee" })).text).toBe("Waiting for Ben");
    expect(metaFor(entry())).toBe("Black · 9 × 9 · no stones yet");
    expect(metaFor(entry({ myColor: "w", size: 19, log: [40, 41, "pass"] }))).toBe("White · 19 × 19 · move 2");
    setLocale("de");
    expect(metaFor(entry({ log: [40] }))).toBe("Schwarz · 9 × 9 · Zug 1");
  });
});

describe("status", () => {
  it("says whose turn, a pass, counting and the wait for the board", () => {
    expect(statusFor(entry()).title).toBe("Your turn");
    expect(statusFor(entry({ log: [40, "pass"] })).detail).toBe("Ben passed. If you pass too, play ends and you count.");
    expect(statusFor(entry({ log: wallsGame() })).detail).toContain("Both passed");
    expect(statusFor(entry({ log: [...wallsGame(), [at(0, 0)]] })).detail).toBe("Ben is checking your marking.");
    expect(statusFor(entry({ myColor: "w", log: [...wallsGame(), [at(0, 0)]] })).detail).toBe(
      "Ben marked 1 dead stones. Agree, or change the marking and send yours.",
    );
    expect(statusFor(entry({ size: null, myColor: null, role: "invitee" })).title).toBe("Waiting for Ben");
  });
});

describe("cell labels (never colour alone)", () => {
  it("names the point, the stone and what marks it", () => {
    expect(cellLabel(9, 0, { stone: 1, last: true, dead: false, area: 0, preview: false }, "b")).toBe("A9, black stone, last move");
    expect(cellLabel(9, 80, { stone: 2, last: false, dead: true, area: 1, preview: false }, "b")).toBe(
      "J1, white stone, marked dead, Black's area",
    );
    expect(cellLabel(9, 40, { stone: 0, last: false, dead: false, area: 2, preview: false }, "b")).toBe("E5, empty, White's area");
    expect(cellLabel(19, 0, { stone: 0, last: false, dead: false, area: 0, preview: true }, "w")).toBe("A19, your stone, not placed yet");
    setLocale("de");
    expect(cellLabel(9, 0, { stone: 1, last: false, dead: false, area: 0, preview: false }, "b")).toBe("A9, schwarzer Stein");
  });
});

describe("announcements", () => {
  const e = entry();
  it("the opponent's move and its captures", () => {
    // We play Black; Ben (White) plays B8, later takes our stone on B9.
    const log: Entry[] = [at(0, 1), at(0, 2), at(8, 8), at(1, 1)];
    const after = state(log);
    expect(announceInbound(e, [at(1, 1)], state(log.slice(0, 3)), after)).toEqual(["Ben played B8.", "Your turn."]);
    const cap: Entry[] = [at(0, 1), at(0, 2), at(8, 8), at(1, 1), at(8, 7), at(0, 0)];
    expect(announceInbound(e, [at(0, 0)], state(cap.slice(0, 5)), state(cap))).toEqual([
      "Ben played A9.",
      "Your stones captured: 1.",
      "Your turn.",
    ]);
  });

  it("passes, marks, agreement, resume and resign", () => {
    expect(announceInbound(e, ["pass"], state([40]), state([40, "pass"]))).toEqual(["Ben passed.", "Your turn."]);
    const two = state([40, 41, "pass"]);
    expect(announceInbound(entry({ myColor: "w" }), ["pass"], two, state([40, 41, "pass", "pass"]))[0]).toBe(
      "Ben passed too. Play ends: mark the dead stones.",
    );
    const walls = wallsGame();
    const w = entry({ myColor: "w" });
    expect(announceInbound(w, [[at(0, 0)]], state(walls), state([...walls, [at(0, 0)]]))).toEqual(["Ben sent a marking: 1 dead stones."]);
    const agreed = state([...walls, [at(0, 0)], [at(0, 0)]]);
    expect(announceInbound(e, [[at(0, 0)]], state([...walls, [at(0, 0)]]), agreed)).toEqual(["Black wins by 1.5"]);
    expect(announceInbound(e, ["resume"], state([...walls, [at(0, 0)]]), state([...walls, [at(0, 0)], "resume"]))).toEqual([
      "Ben resumed play.",
      "Your turn.",
    ]);
    expect(announceInbound(e, ["resign-w"], state([40]), state([40, "resign-w"]))).toEqual(["Ben resigned. You win."]);
  });

  it("our own step and the result line", () => {
    expect(announceOwn(at(4, 4), state([at(4, 4)]))).toEqual(["You played E5."]);
    expect(announceOwn("pass", state(["pass"]))).toEqual(["You passed."]);
    expect(resultLine(state([40, "resign-w"]))).toBe("Black wins by resignation");
    expect(resultLine(state([40]))).toBeNull();
    setLocale("de");
    expect(resultLine(state([...wallsGame(), [at(0, 0)], [at(0, 0)]]))).toBe("Schwarz gewinnt mit 1,5 Punkten");
  });
});
