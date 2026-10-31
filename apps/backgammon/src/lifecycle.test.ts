import { afterEach, describe, expect, it } from "vitest";
import { ShError } from "@socialhome/app-sdk";
import type { AppMessage, PickedPerson } from "@socialhome/app-sdk";
import {
  adoptOwnCopy,
  classifySessionEvent,
  entryForInvite,
  entryForPicked,
  isAwaitingOpponent,
  isMyTurn,
  isUnknownGame,
  launchAction,
  ownSideOf,
  parseEntry,
  personName,
  pickFailure,
  rematchOf,
  resignCopy,
  resolveColor,
  routeInbound,
  stateOf,
  toStored,
} from "./lifecycle.js";
import type { GameEntry } from "./lifecycle.js";
import { toB64url } from "./dice.js";
import { setLocale } from "./i18n.js";
import { Player, actorOf2, opponent, startGame, seedOf } from "./testkit.js";

const picked: PickedPerson = { sessionId: "s-1", instance_id: "inst-b", user_ref: "bob", is_local: false, display_name: "Bob · Lakeside" };

/** The saved entry of *p* in a game the testkit plays. */
function entryOf(p: Player, over: Partial<GameEntry> = {}): GameEntry {
  return {
    sessionId: p.sid,
    opponentInstanceId: "inst-x",
    opponentRef: "x",
    opponentIsLocal: false,
    opponentName: "Bob",
    role: p.role,
    setup: p.setup,
    myColor: p.color,
    seed: toB64url(p.seed),
    theirTip: p.theirTip ? toB64url(p.theirTip) : null,
    theirShown: p.theirShown ? { n: p.theirShown.n, link: toB64url(p.theirShown.link) } : null,
    log: [...p.log],
    heard: true,
    updatedAt: 1,
    ...over,
  };
}

const games = (...e: GameEntry[]) => new Map(e.map((x) => [x.sessionId, x]));

afterEach(() => setLocale("en"));

describe("a saved game", () => {
  it("round-trips through the store and rebuilds the same state", () => {
    const { a, b } = startGame({ cube: false });
    b.receive(a.play(a.autoStep()));
    const e = entryOf(b);
    const back = parseEntry(JSON.parse(JSON.stringify(toStored(e))))!;
    expect(back).not.toBeNull();
    expect(stateOf(back)).toEqual(b.state());
  });

  it("refuses a log that doesn't replay, a broken seed or a bad shown link", () => {
    const { a, b } = startGame({ cube: false });
    b.receive(a.play(a.autoStep()));
    const e = toStored(entryOf(b));
    expect(parseEntry({ ...e, log: [[1, 0]] })).toBeNull();
    expect(parseEntry({ ...e, seed: "not-a-seed" })).toBeNull();
    expect(parseEntry({ ...e, theirShown: { n: 0, link: e.theirShown!.link } })).toBeNull();
    expect(parseEntry({ ...e, seed: null })).toBeNull();
    expect(parseEntry(null)).toBeNull();
  });

  it("our next message shows exactly the link the game says we must have shown", () => {
    const { a, b } = startGame();
    // The inviter has shown nothing yet; the invitee has shown link 1.
    expect(ownSideOf(entryOf(a))!.shown).toBeNull();
    expect(ownSideOf(entryOf(b))!.shown!.n).toBe(1);
    for (let i = 0; i < 12; i++) {
      const p = actorOf2(a, b);
      const q = opponent(p, a, b);
      expect(q.receive(p.play(p.autoStep()))).toMatchObject({ kind: "apply" });
      expect(ownSideOf(entryOf(p))!.shown?.n ?? 0).toBe(p.state()!.reveals[p.color!]);
      expect(ownSideOf(entryOf(p))!.shown?.n ?? 0).toBe(p.shown()?.n ?? 0);
    }
  });
});

describe("whose turn", () => {
  it("is ours when we have to act: rolling, playing, answering a double or showing our link", () => {
    const { a, b } = startGame();
    const first = a.state()!.toMove === a.color ? a : b;
    expect(isMyTurn(entryOf(first))).toBe(true);
    expect(isMyTurn(entryOf(first === a ? b : a))).toBe(false);
  });

  it("an unanswered invite waits for the opponent", () => {
    const e = entryForPicked(picked, { inviter: "w", cube: true, days: 0 }, seedOf(1), 5);
    expect(isAwaitingOpponent(e)).toBe(true);
    expect(stateOf(e)).toBeNull();
    expect(e.clockFrom).toEqual({ n: 0, at: 5 });
    expect(personName(e)).toBe("Bob");
  });
});

describe("resigning", () => {
  it("says what the board is worth: single, gammon or backgammon", () => {
    const e = entryForPicked(picked, { inviter: "w", cube: true, days: 0 }, seedOf(1));
    expect(resignCopy(e, { kind: "single", points: 1 }).body).toBe("Bob wins 1 point.");
    expect(resignCopy(e, { kind: "single", points: 4 }).body).toContain("4 points");
    expect(resignCopy(e, { kind: "gammon", points: 2 }).body).toContain("gammon");
    expect(resignCopy(e, { kind: "backgammon", points: 6 }).body).toMatch(/backgammon.*6 points/);
  });
});

describe("invites and sessions", () => {
  it("a picked person gets a fresh entry with our colour and seed; an invite waits for the setup", () => {
    const e = entryForPicked(picked, { inviter: "b", cube: false, days: 2 }, seedOf(3));
    expect(e.myColor).toBe("b");
    expect(e.seed).toBe(toB64url(seedOf(3)));
    const msg: AppMessage = { sessionId: "s-9", fromInstance: "inst-c", fromUser: "carol", payload: {} };
    const inv = entryForInvite(msg, [{ instance_id: "inst-c", user_ref: "carol", is_local: true, display_name: "Carol", online: true }]);
    expect(inv).toMatchObject({ role: "invitee", setup: null, seed: null, opponentName: "Carol", opponentIsLocal: true });
  });

  it("routes by the session Social Home delivered, from its opponent only", () => {
    const e = entryForPicked(picked, { inviter: "w", cube: true, days: 0 }, seedOf(1));
    const g = games(e);
    expect(routeInbound({ sessionId: "s-1", fromInstance: "inst-b", fromUser: "bob", payload: {} }, g).kind).toBe("game");
    expect(routeInbound({ sessionId: "s-1", fromInstance: "inst-c", fromUser: "bob", payload: {} }, g)).toEqual({ kind: "drop", reason: "not-opponent" });
    expect(routeInbound({ sessionId: "s-2", fromInstance: "inst-b", payload: {} }, g)).toEqual({ kind: "drop", reason: "unknown-game" });
  });

  it("a decline closes only our unanswered invite; a launch opens or starts a game", () => {
    const e = entryForPicked(picked, { inviter: "w", cube: true, days: 0 }, seedOf(1));
    const close = (reason: string): AppMessage => ({ sessionId: "s-1", fromInstance: "inst-b", fromUser: "bob", payload: { verb: "close", reason } });
    expect(classifySessionEvent(close("declined"), games(e)).kind).toBe("declined");
    expect(classifySessionEvent(close("withdrawn"), games(e)).kind).toBe("ignore");
    expect(launchAction({ sessionId: "s-1" }, games(e))).toEqual({ kind: "open", sessionId: "s-1" });
    expect(launchAction({ sessionId: "s-7" }, games(e))).toEqual({ kind: "gone" });
    expect(launchAction(undefined, games(e))).toEqual({ kind: "none" });
  });

  it("a rematch swaps colours and keeps the cube and clock", () => {
    const e = entryForPicked(picked, { inviter: "w", cube: false, days: 3 }, seedOf(1));
    expect(rematchOf(e)).toEqual({ color: "b", cube: false, days: 3 });
    expect(resolveColor("random", 0.2)).toBe("w");
    expect(resolveColor("random", 0.7)).toBe("b");
    expect(resolveColor("b", 0.2)).toBe("b");
  });

  it("explains a failed invite sheet calmly", () => {
    expect(pickFailure(new ShError("busy", "x"))).toEqual({ kind: "quiet" });
    expect(pickFailure(new ShError("permission_denied", "x"))).toMatchObject({ kind: "toast" });
    expect(isUnknownGame(new ShError("unknown_session", "x"))).toBe(true);
    expect(isUnknownGame(new Error("x"))).toBe(false);
  });
});

describe("two screens of one person answering the same invite", () => {
  it("the inviter keeps the first answer; the other screen takes the saved copy and plays on", () => {
    const a = new Player("s-2", "inviter", seedOf(61));
    const screen1 = new Player("s-2", "invitee", seedOf(62));
    const screen2 = new Player("s-2", "invitee", seedOf(63));
    const invite = a.invite("w");
    expect(screen1.receive(invite).kind).toBe("invite");
    expect(screen2.receive(invite).kind).toBe("invite");
    const answer1 = screen1.message();
    const answer2 = screen2.message();
    expect(a.receive(answer1)).toMatchObject({ kind: "apply", accepted: true });
    // The second answer is old news to the inviter, not a refused message.
    expect(a.receive(answer2)).toEqual({ kind: "stale" });
    const next = a.play(a.autoStep());
    expect(screen1.receive(next).kind).toBe("apply");
    // The losing screen learns that the inviter holds another tip for it.
    const v = screen2.receive(next);
    expect(v).toEqual({ kind: "other-screen", myTip: screen1.chain![0] });
    if (v.kind !== "other-screen") return;

    const mine = entryOf(screen2, { log: [] });
    // The store still has this screen's own copy (or nothing): nothing to adopt yet.
    expect(adoptOwnCopy(mine, entryOf(screen2), v.myTip)).toBeNull();
    expect(adoptOwnCopy(mine, null, v.myTip)).toBeNull();
    // Another game's or another setup's copy is never taken.
    expect(adoptOwnCopy(mine, entryOf(screen1, { sessionId: "s-9" }), v.myTip)).toBeNull();
    expect(adoptOwnCopy(mine, entryOf(screen1, { setup: { ...screen1.setup!, cube: false } }), v.myTip)).toBeNull();
    // The winning screen's saved copy: same seed as the inviter holds.
    const adopted = adoptOwnCopy(mine, entryOf(screen1), v.myTip);
    expect(adopted).not.toBeNull();
    expect(adopted!.seed).toBe(toB64url(screen1.seed));
    expect(adopted!.log).toEqual(screen1.log);
    expect(stateOf(adopted!)?.n).toBe(screen1.log.length);
    // Played on from the adopted copy, the next message is the inviter's to take.
    expect(ownSideOf(adopted!)!.myTip).toEqual(screen1.chain![0]);
  });

  it("the inviter's own tip mismatch is still refused (no second screen there)", () => {
    const { a, b } = startGame({ seeds: [64, 65] });
    const forged = { ...JSON.parse(JSON.stringify(b.message())), tips: { ...b.message().tips, [a.color!]: toB64url(seedOf(66)) } };
    expect(a.receive(forged)).toEqual({ kind: "refuse", reason: "setup" });
  });
});
