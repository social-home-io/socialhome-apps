import { afterEach, describe, expect, it } from "vitest";
import {
  announceInbound,
  announceStep,
  cellLabel,
  chipFor,
  clockName,
  metaFor,
  passText,
  pipsText,
  pointsBreakdown,
  resultLine,
  rollText,
  rulesLine,
  seen,
  statusFor,
  stepText,
  timeLeftText,
} from "./view.js";
import { applyEntry, initialState, resignBy } from "./game.js";
import type { DiceSource, GameState, Setup } from "./game.js";
import type { GameEntry } from "./lifecycle.js";
import { BAR, OFF, startBoard } from "./rules.js";
import type { Board } from "./rules.js";
import { toB64url } from "./dice.js";
import { setLocale } from "./i18n.js";
import { actorOf2, opponent, startGame } from "./testkit.js";
import type { Player } from "./testkit.js";

const SETUP: Setup = { inviter: "w", cube: true, days: 0 };
const fixed = (rolls: Record<number, [number, number]> = {}): DiceSource => ({
  opening: () => ({ w: 4, b: 1, ties: [], starter: "w" }),
  roll: (t) => rolls[t] ?? [6, 5],
});

/** We are Black; Ben (White) won the opening. */
function entry(over: Partial<GameEntry> = {}): GameEntry {
  return {
    sessionId: "s1", opponentInstanceId: "inst-b", opponentRef: "ben", opponentIsLocal: false,
    opponentName: "Ben · Lakeside", role: "invitee", setup: SETUP, myColor: "b", seed: null, theirTip: null,
    theirShown: null, log: [], heard: true, updatedAt: 1, ...over,
  };
}

function entryOf(p: Player): GameEntry {
  return entry({
    sessionId: p.sid, role: p.role, setup: p.setup, myColor: p.color, seed: toB64url(p.seed), theirTip: toB64url(p.theirTip!),
    theirShown: p.theirShown ? { n: p.theirShown.n, link: toB64url(p.theirShown.link) } : null, log: [...p.log],
  });
}

afterEach(() => setLocale("en"));

describe("words for the dice and the steps", () => {
  it("says rolls high first, doubles as doubles", () => {
    expect(rollText([2, 6])).toBe("6 and 2");
    expect(rollText([3, 3])).toBe("double 3");
    setLocale("de");
    expect(rollText([2, 6])).toBe("6 und 2");
  });

  it("names the other player's points in our numbering", () => {
    expect(seen(24, "w", "b")).toBe(1);
    expect(seen(BAR, "w", "b")).toBe(BAR);
    expect(stepText({ from: 24, to: 18 }, "w", "b")).toBe("1 to 7");
    expect(stepText({ from: BAR, to: 20 }, "b", "b")).toBe("bar to 20");
    expect(stepText({ from: 3, to: OFF }, "b", "b")).toBe("3 borne off");
  });

  it("explains a pass", () => {
    expect(passText("bar", [6, 6])).toContain("bar");
    expect(passText("blocked", [5, 4])).toContain("no checker can move");
  });

  it("announces our own steps: hits, bear-offs, dice left, done", () => {
    expect(announceStep({ from: 8, to: 5, die: 3, hit: true }, "b", [1], false)).toBe("8 to 5. Hit. Dice left: 1");
    expect(announceStep({ from: 2, to: OFF, die: 2, hit: false }, "b", [], true)).toBe("2 borne off. Borne off. Move complete: press Done to send it");
  });
});

describe("the status line", () => {
  it("before the roll: our turn to roll or double; nobody's roll shown", () => {
    const { a, b } = startGame({ seeds: [1, 2] });
    while (a.state()!.phase !== "ask") {
      const p = actorOf2(a, b);
      opponent(p, a, b).receive(p.play(p.autoStep()));
    }
    const p = actorOf2(a, b);
    const q = opponent(p, a, b);
    expect(statusFor(entryOf(p)).title).toBe("Your turn");
    expect(statusFor(entryOf(q)).title).toBe("Ben's turn");
    // p rolls: p waits for q's half, q's app adds it.
    q.receive(p.play("roll"));
    expect(statusFor(entryOf(p)).title).toBe("Rolling…");
    expect(statusFor(entryOf(p)).detail).toContain("Ben opens Backgammon");
    expect(statusFor(entryOf(q)).title).toContain("Adding your half");
    p.receive(q.play("show"));
    expect(statusFor(entryOf(p)).title).toMatch(/^Your turn: you rolled /);
  });

  it("a double tells the taker it comes before the roll", () => {
    const { a, b } = startGame({ seeds: [1, 2] });
    while (a.state()!.phase !== "ask") {
      const p = actorOf2(a, b);
      opponent(p, a, b).receive(p.play(p.autoStep()));
    }
    const p = actorOf2(a, b);
    const q = opponent(p, a, b);
    q.receive(p.play("double"));
    const s = statusFor(entryOf(q));
    expect(s.title).toBe("Ben doubles to 2");
    expect(s.detail).toContain("Before rolling");
    expect(statusFor(entryOf(p)).detail).toContain("Nobody knows your roll yet");
  });
});

describe("announcements for the other player's steps", () => {
  it("says their move in our numbers, a hit on us, and what we do next", () => {
    const dice = fixed({ 2: [6, 5] });
    let st = initialState({ ...SETUP, cube: false }, dice);
    // White hits our blot: we have a single checker on our 21 (White's 4).
    const board: Board = startBoard();
    board.b[24] = 1;
    board.b[21] = 1;
    st = { ...st, board };
    const after = applyEntry(st, [8, 4, 6, 5], dice);
    const lines = announceInbound(entry(), [[8, 4, 6, 5]], after);
    // Black learns the opening roll only with White's first turn: both are said.
    expect(lines[0]).toBe("Opening roll: you 1, Ben 4. Ben starts.");
    expect(lines[1]).toBe("Ben rolled 4 and 1: 17 to 21, 19 to 20.");
    expect(lines).toContain("Your checker was hit and is on the bar.");
    expect(lines[lines.length - 1]).toBe("Your turn: you rolled 6 and 5.");
  });

  it("with the cube, asks us to roll or double; a double never says a roll", () => {
    const dice = fixed();
    const after = applyEntry(initialState(SETUP, dice), [24, 23, 13, 9], dice);
    expect(announceInbound(entry(), [[24, 23, 13, 9]], after).at(-1)).toBe("Your turn: roll, or double first.");
    const asked = applyEntry(applyEntry(after, "double", dice), "take", dice);
    const ours = applyEntry(asked, [24, 18, 18, 13], dice);
    const doubled = applyEntry(ours, "double", dice);
    const said = announceInbound(entry({ myColor: "b" }), ["double"], doubled).join(" ");
    expect(said).toContain("doubles to 4");
    expect(said).not.toMatch(/rolled/);
  });
});

describe("the end", () => {
  const over = (st: GameState) => st;
  it("says who won what, and how the points add up", () => {
    const dice = fixed();
    const st = over(applyEntry(applyEntry(initialState(SETUP, dice), [24, 23, 13, 9], dice), resignBy("b"), dice));
    expect(resultLine(st, "b", "Ben")).toBe("You resigned: Ben wins 3 points.");
    expect(resultLine(st, "w", "Bob")).toBe("Bob resigned: you win 3 points.");
    expect(pointsBreakdown(st)).toBe("");
    const doubled = applyEntry({ ...st, phase: "play", result: null, cube: { value: 2, owner: "w" } }, resignBy("b"), dice);
    expect(resultLine(doubled, "w", "Bob")).toBe("Bob resigned: you win 6 points.");
    expect(pointsBreakdown(doubled)).toBe("Cube 2 × 3");
  });
});

describe("labels", () => {
  it("names a place and what is on it, for a screen reader", () => {
    const c = { id: 6, mine: 5, theirs: 0, selected: false, target: false, source: true, lastFrom: false, lastTo: true };
    expect(cellLabel(c, "b", "Ben")).toBe("Point 6, 5 of yours (Black), can move, Ben moved here");
    expect(cellLabel({ ...c, id: BAR, mine: 0, source: false, lastTo: false }, "b", "Ben")).toBe("Your bar, empty");
    expect(pipsText(startBoard(), "w", "Ben")).toBe("Pips: you 167, Ben 167");
  });

  it("says the setup and the time left", () => {
    expect(rulesLine({ inviter: "w", cube: true, days: 2 })).toBe("Doubling cube · 2 days per move");
    expect(rulesLine({ inviter: "w", cube: false, days: 0 })).toBe("No doubling cube");
    expect(clockName(1)).toBe("1 day per move");
    expect(timeLeftText(0)).toBe("Time ran out");
    expect(timeLeftText(90 * 60 * 1000)).toBe("1 h 30 min left");
  });

  it("chips and meta for the lobby", () => {
    const { a, b } = startGame({ seeds: [1, 2] });
    const first = actorOf2(a, b);
    expect(chipFor(entryOf(first)).tone).toBe("turn");
    expect(chipFor(entryOf(opponent(first, a, b))).text).toBe("Ben's turn");
    expect(metaFor(entryOf(a))).toMatch(/^White · not started/);
  });
});
