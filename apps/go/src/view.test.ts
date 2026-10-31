import { afterEach, describe, expect, it } from "vitest";
import {
  announceInbound,
  announceOwn,
  cellLabel,
  chipFor,
  clockName,
  handicapExplain,
  metaFor,
  resultLine,
  rulesLine,
  statusFor,
  timeLeftText,
} from "./view.js";
import { groupGames } from "./lobby.js";
import { replay } from "./game.js";
import type { Entry } from "./game.js";
import type { GameEntry } from "./lifecycle.js";
import { setLocale } from "./i18n.js";

const at = (r: number, c: number): number => r * 9 + c;

function entry(over: Partial<GameEntry> = {}): GameEntry {
  return {
    sessionId: "s1", opponentInstanceId: "inst-b", opponentRef: "ben", opponentIsLocal: false,
    opponentName: "Ben · Lakeside", role: "inviter", size: 9, myColor: "b", handicap: 0, days: 0, log: [], heard: true, updatedAt: 1, ...over,
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

describe("handicap and clock words", () => {
  const T0 = Date.UTC(2026, 9, 31, 12);
  const DAY = 24 * 60 * 60 * 1000;
  const HOUR = 60 * 60 * 1000;

  it("time left, plainly", () => {
    expect(timeLeftText(2 * DAY + 5 * HOUR)).toBe("2 days 5 h left");
    expect(timeLeftText(DAY + 3 * HOUR)).toBe("1 day 3 h left");
    expect(timeLeftText(3 * HOUR + 20 * 60_000)).toBe("3 h 20 min left");
    expect(timeLeftText(12 * 60_000)).toBe("12 min left");
    expect(timeLeftText(10_000)).toBe("1 min left");
    expect(timeLeftText(0)).toBe("Time ran out");
    setLocale("de");
    expect(timeLeftText(2 * DAY + 5 * HOUR)).toBe("noch 2 Tage 5 Std.");
  });

  it("the lobby row and the setup line mention handicap and clock when set", () => {
    expect(metaFor(entry({ size: 13, handicap: 3, days: 2, log: [] }))).toBe("Black · 13 × 13 · Handicap 3 · 2 days per move · no stones yet");
    expect(metaFor(entry({ days: 1, log: [40] }))).toBe("Black · 9 × 9 · 1 day per move · move 1");
    expect(metaFor(entry({ log: [40] }))).toBe("Black · 9 × 9 · move 1");
    expect(rulesLine({ handicap: 0, days: 0 })).toBe("");
    expect(clockName(7)).toBe("7 days per move");
  });

  it("says plainly what a handicap means", () => {
    expect(handicapExplain(4)).toBe("Black gets 4 stones, White moves first.");
    expect(handicapExplain(0)).toBe("Even game: Black moves first, White gets komi 7.5.");
    setLocale("de");
    expect(handicapExplain(0)).toBe("Ohne Vorgabe: Schwarz zieht zuerst, Weiß bekommt 7,5 Komi.");
  });

  it("the chip shows a claimable or claimed win", () => {
    const waiting = entry({ days: 1, log: [40], clockFrom: { n: 1, at: T0 } });
    expect(chipFor(waiting, T0 + HOUR)).toEqual({ text: "Ben's turn", tone: "wait" });
    expect(chipFor(waiting, T0 + 2 * DAY)).toEqual({ text: "Ben's time ran out", tone: "turn" });
    expect(chipFor({ ...waiting, claimedAt: 1 }, T0 + 2 * DAY)).toEqual({ text: "Win claimed", tone: "wait" });
  });

  it("a handicap game opens with White to move and says why", () => {
    const w = entry({ myColor: "w", handicap: 3, log: [] });
    expect(statusFor(w)).toEqual({ title: "Your turn", detail: "Black starts with 3 handicap stones, so White moves first." });
  });

  it("a win on time", () => {
    const st = replay(9, [40, "timeout-w"], { handicap: 0, days: 2 })!.state;
    expect(resultLine(st)).toBe("Black wins on time");
    const e = entry({ days: 2 });
    const before = replay(9, [40], { handicap: 0, days: 2 })!.state;
    expect(announceInbound(e, ["timeout-w"], before, st)).toEqual(["Ben's time ran out. You win."]);
  });
});
