import { afterEach, describe, expect, it } from "vitest";
import { ShError } from "@socialhome/app-sdk";
import type { AppMessage, Contact, PickedPerson } from "@socialhome/app-sdk";
import {
  canClaim,
  classifySessionEvent,
  clockOf,
  hasPendingClaim,
  showClaimOffer,
  continueCopy,
  entryForInvite,
  entryForPicked,
  fromOpponent,
  isAwaitingOpponent,
  isLocalOpponent,
  isMyTurn,
  isOver,
  isUnansweredInvite,
  isUnknownGame,
  launchAction,
  parseEntry,
  pickFailure,
  rematchOf,
  removeCopy,
  resignCopy,
  resolveColor,
  routeInbound,
  senderOf,
  stateOf,
  targetFor,
  toStored,
} from "./lifecycle.js";
import type { GameEntry } from "./lifecycle.js";
import type { Entry } from "./game.js";
import { setLocale } from "./i18n.js";

function entry(over: Partial<GameEntry> = {}): GameEntry {
  return {
    sessionId: "s1",
    opponentInstanceId: "inst-b",
    opponentRef: "bob",
    opponentIsLocal: false,
    opponentName: "Bob",
    role: "inviter",
    size: 9,
    myColor: "b",
    handicap: 0,
    days: 0,
    log: [],
    heard: false,
    updatedAt: 1,
    ...over,
  };
}

const games = (...e: GameEntry[]) => new Map(e.map((x) => [x.sessionId, x]));

function close(reason: unknown, over: Partial<AppMessage> = {}): AppMessage {
  return { sessionId: "s1", fromInstance: "inst-b", fromUser: "bob", payload: { verb: "close", reason }, ...over };
}

afterEach(() => setLocale("en"));

describe("who an event comes from", () => {
  it("reads the sender from fromUser, else the payload's from_user", () => {
    expect(senderOf({ sessionId: "s", fromInstance: "i", fromUser: "a", payload: {} })).toBe("a");
    expect(senderOf({ sessionId: "s", fromInstance: "i", payload: { from_user: "b" } })).toBe("b");
    expect(senderOf({ sessionId: "s", fromInstance: "i", payload: null })).toBeUndefined();
  });

  it("checks household and person", () => {
    const e = entry();
    expect(fromOpponent(e, close("x"))).toBe(true);
    expect(fromOpponent(e, close("x", { fromInstance: "inst-c" }))).toBe(false);
    expect(fromOpponent(e, close("x", { fromUser: "carol" }))).toBe(false);
    expect(fromOpponent({ ...e, opponentRef: "" }, close("x", { fromUser: "carol" }))).toBe(true);
  });

  it("routes a message by the session Social Home delivered, from its opponent only", () => {
    const g = games(entry());
    expect(routeInbound({ sessionId: "s1", fromInstance: "inst-b", fromUser: "bob", payload: { sid: "s9" } }, g).kind).toBe("game");
    expect(routeInbound({ sessionId: "s2", fromInstance: "inst-b", payload: { sid: "s1" } }, g)).toEqual({ kind: "drop", reason: "unknown-game" });
    expect(routeInbound({ sessionId: "s1", fromInstance: "inst-x", payload: {} }, g)).toEqual({ kind: "drop", reason: "not-opponent" });
  });
});

describe("game state", () => {
  it("rebuilds the board from the log; nothing for an invitee waiting for the board", () => {
    const e = entry({ log: [40] });
    expect(stateOf(e)?.board[40]).toBe(1);
    expect(isMyTurn(e)).toBe(false);
    expect(isMyTurn(entry())).toBe(true);
    expect(stateOf(entry({ size: null, myColor: null, role: "invitee" }))).toBeNull();
  });

  it("our invite waits until something comes back", () => {
    expect(isAwaitingOpponent(entry())).toBe(true);
    expect(isAwaitingOpponent(entry({ heard: true }))).toBe(false);
    expect(isAwaitingOpponent(entry({ role: "invitee" }))).toBe(false);
    expect(isAwaitingOpponent(entry({ log: ["resign-b"] }))).toBe(false);
  });

  it("a received invite is unanswered until we play", () => {
    expect(isUnansweredInvite(entry({ role: "invitee", size: null, myColor: null }))).toBe(true);
    expect(isUnansweredInvite(entry({ role: "invitee", myColor: "w", log: [40] }))).toBe(true);
    expect(isUnansweredInvite(entry({ role: "invitee", myColor: "w", log: [40, 41] }))).toBe(false);
    expect(isOver(entry({ log: ["resign-w"] }))).toBe(true);
  });

  it("reads saved entries strictly and replays their logs", () => {
    const e = entry({ log: [40, 41] });
    expect(parseEntry(toStored(e))).toMatchObject({ sessionId: "s1", log: [40, 41] });
    expect(parseEntry({ ...e, log: [40, 40] })).toBeNull(); // doesn't replay
    expect(parseEntry({ ...e, size: 10 })).toBeNull();
    expect(parseEntry({ ...e, myColor: null })).toBeNull();
    expect(parseEntry({ ...e, role: "x" })).toBeNull();
    expect(parseEntry({ ...e, size: null, myColor: null, log: [1] })).toBeNull();
    expect(parseEntry({ ...e, size: null, myColor: null, log: [] })).toMatchObject({ size: null });
    expect(parseEntry(null)).toBeNull();
  });
});

describe("closes", () => {
  it("declined ends our unanswered invite only", () => {
    expect(classifySessionEvent(close("declined"), games(entry())).kind).toBe("declined");
    expect(classifySessionEvent(close("declined"), games(entry({ heard: true }))).kind).toBe("ignore");
  });

  it("withdrawn ends an invite we haven't played in", () => {
    const fresh = entry({ role: "invitee", size: null, myColor: null });
    expect(classifySessionEvent(close("withdrawn"), games(fresh)).kind).toBe("withdrawn");
    const played: Entry[] = [40, 41];
    expect(classifySessionEvent(close("withdrawn"), games(entry({ role: "invitee", myColor: "w", log: played }))).kind).toBe("ignore");
  });

  it("ended ends any game still going, never a finished one", () => {
    expect(classifySessionEvent(close("ended"), games(entry({ heard: true, log: [40] }))).kind).toBe("ended");
    expect(classifySessionEvent(close("ended"), games(entry({ log: [40, "resign-w"] }))).kind).toBe("ignore");
  });

  it("ignores closes from strangers, for unknown games, and without a known reason", () => {
    expect(classifySessionEvent(close("declined", { fromInstance: "x" }), games(entry())).kind).toBe("ignore");
    expect(classifySessionEvent(close("declined", { sessionId: "s9" }), games(entry())).kind).toBe("ignore");
    expect(classifySessionEvent(close(undefined), games(entry())).kind).toBe("ignore");
  });

  it("a live open is news only, unless an older host seats it", () => {
    const open: AppMessage = { sessionId: "s7", fromInstance: "inst-b", fromUser: "bob", payload: { verb: "open" } };
    expect(classifySessionEvent(open, games()).kind).toBe("ignore");
    expect(classifySessionEvent(open, games(), { liveInvites: true }).kind).toBe("invite");
    expect(classifySessionEvent(open, games(), { liveInvites: true, selfUserId: "bob" }).kind).toBe("ignore");
  });
});

describe("launch", () => {
  const invite: AppMessage = { sessionId: "s1", fromInstance: "inst-b", fromUser: "bob", payload: { verb: "open" } };
  it("starts, opens, refuses or says gone", () => {
    expect(launchAction(undefined, games())).toEqual({ kind: "none" });
    expect(launchAction({ sessionId: "s1", invite }, games())).toEqual({ kind: "start", invite });
    expect(launchAction({ sessionId: "s1", invite }, games(entry()))).toEqual({ kind: "open", sessionId: "s1" });
    expect(launchAction({ sessionId: "s1", invite: { ...invite, fromUser: "eve" } }, games(entry()))).toEqual({ kind: "mismatch" });
    expect(launchAction({ sessionId: "s1" }, games())).toEqual({ kind: "gone" });
  });
});

describe("entries", () => {
  const contacts: Contact[] = [
    { instance_id: "inst-a", user_ref: "me", is_local: true, display_name: "Me", online: true },
    { instance_id: "inst-b", user_ref: "bob", is_local: false, display_name: "Bob · Lakeside", online: false },
  ];

  it("the inviter fixes size and colour; the invitee learns them later", () => {
    const p: PickedPerson = { instance_id: "inst-b", user_ref: "bob", is_local: false, display_name: "Bob", sessionId: "s5" };
    expect(entryForPicked(p, 13, "w", undefined, 7)).toMatchObject({ sessionId: "s5", role: "inviter", size: 13, myColor: "w", log: [], updatedAt: 7 });
    const e = entryForInvite({ sessionId: "s6", fromInstance: "inst-b", fromUser: "bob", payload: {} }, contacts, 8);
    expect(e).toMatchObject({ role: "invitee", size: null, myColor: null, opponentName: "Bob · Lakeside", opponentIsLocal: false });
    expect(targetFor(e)).toEqual({ instance_id: "inst-b", user_ref: "bob", is_local: false });
    expect(isLocalOpponent("inst-a", "kim", contacts)).toBe(true);
  });

  it("resolves a random colour and swaps colours for a rematch", () => {
    expect(resolveColor("b")).toBe("b");
    expect(resolveColor("random", 0.2)).toBe("b");
    expect(resolveColor("random", 0.7)).toBe("w");
    expect(rematchOf(entry({ size: 19, myColor: "b" }))).toEqual({ size: 19, color: "w", rules: { handicap: 0, days: 0 } });
    expect(rematchOf(entry({ size: null, myColor: null }))).toBeNull();
  });
});

describe("failures and confirms", () => {
  it("reads pick failures", () => {
    expect(pickFailure(new ShError("busy", "x"))).toEqual({ kind: "quiet" });
    expect(pickFailure(new ShError("permission_denied", "x"))).toEqual({ kind: "toast", message: "Go can't invite people in this household." });
    expect(pickFailure(new Error("x"))).toMatchObject({ kind: "toast" });
    expect(isUnknownGame(new ShError("unknown_session", "x"))).toBe(true);
    expect(isUnknownGame(new Error("unknown_session"))).toBe(false);
  });

  it("says what resign, remove and continue do", () => {
    const e = entry({ opponentName: "Bob · Lakeside" });
    expect(resignCopy(e).body).toBe("Bob wins.");
    expect(removeCopy(e).title).toBe("Remove your game with Bob · Lakeside?");
    expect(continueCopy(e)).toMatchObject({ confirm: "Continue game with Bob", primary: true });
    setLocale("de");
    expect(resignCopy(e).confirm).toBe("Aufgeben");
  });
});

describe("handicap and clock entries", () => {
  const T0 = Date.UTC(2026, 9, 31, 12);
  const DAY = 24 * 60 * 60 * 1000;
  const p: PickedPerson = { instance_id: "inst-b", user_ref: "bob", is_local: false, display_name: "Bob", sessionId: "s9" };

  it("the inviter's entry carries the setup and starts its clock mark", () => {
    expect(entryForPicked(p, 13, "b", { handicap: 3, days: 2 }, T0)).toMatchObject({
      size: 13,
      handicap: 3,
      days: 2,
      clockFrom: { n: 0, at: T0 },
    });
  });

  it("reads games saved before handicap and clock as neither", () => {
    const old = { ...toStored(entry({ log: [40] })) } as Record<string, unknown>;
    delete old["handicap"];
    delete old["days"];
    expect(parseEntry(old)).toMatchObject({ handicap: 0, days: 0, log: [40] });
  });

  it("refuses a saved game with a handicap or clock Go doesn't offer, and drops a broken clock mark", () => {
    expect(parseEntry({ ...entry(), handicap: 7 })).toBeNull(); // 9 × 9 takes at most 5
    expect(parseEntry({ ...entry(), days: 4 })).toBeNull();
    expect(parseEntry({ ...entry({ size: null, myColor: null }), handicap: 2 })).toBeNull();
    const e = parseEntry({ ...entry({ days: 2 }), clockFrom: { n: "x", at: 1 }, claimedAt: -1 })!;
    expect(e.clockFrom).toBeUndefined();
    expect(e.claimedAt).toBeUndefined();
    const ok = parseEntry({ ...entry({ days: 2 }), clockFrom: { n: 0, at: T0 }, claimedAt: 0, theirHint: { n: 0, at: T0 } })!;
    expect(ok).toMatchObject({ clockFrom: { n: 0, at: T0 }, claimedAt: 0, theirHint: { n: 0, at: T0 } });
  });

  it("replays a handicap game from its stones (White first)", () => {
    const e = entry({ handicap: 2, myColor: "w", heard: true, log: [40] });
    expect(stateOf(e)?.toMove).toBe("b");
    expect(parseEntry(toStored(e))).not.toBeNull();
    expect(parseEntry({ ...toStored(e), handicap: 0, log: [40, 41, 20] })).not.toBeNull();
  });

  it("a rematch keeps Black with the handicap; without one it swaps colours", () => {
    expect(rematchOf(entry({ handicap: 4, myColor: "b" }))).toEqual({ size: 9, color: "b", rules: { handicap: 4, days: 0 } });
    expect(rematchOf(entry({ days: 3, myColor: "b" }))).toEqual({ size: 9, color: "w", rules: { handicap: 0, days: 3 } });
  });

  describe("claiming the win", () => {
    // We (Black) moved at T0: White's turn, 1 day per move.
    const waiting = (over: Partial<GameEntry> = {}) =>
      entry({ days: 1, heard: true, log: [40], clockFrom: { n: 1, at: T0 }, ...over });

    it("is offered once their time (plus a grace) has run out", () => {
      expect(canClaim(waiting(), T0 + DAY)).toBe(false);
      expect(canClaim(waiting(), T0 + DAY + 11 * 60 * 1000)).toBe(true);
      expect(clockOf(waiting(), T0 + DAY / 2)).toMatchObject({ who: "w", mine: false, leftMs: DAY / 2 + 10 * 60 * 1000 });
    });

    it("not for an unanswered invite, an unsent move, our own turn or a game without a clock", () => {
      const late = T0 + 10 * DAY;
      expect(canClaim(waiting({ heard: false }), late)).toBe(false);
      expect(canClaim(waiting({ unsent: true }), late)).toBe(false);
      expect(canClaim(waiting({ log: [40, 41], clockFrom: { n: 2, at: T0 } }), late)).toBe(false);
      expect(canClaim(waiting({ days: 0 }), late)).toBe(false);
    });

    it("waits for their Go after a claim; Keep playing hides the offer for this position only", () => {
      const late = T0 + 10 * DAY;
      const claimed = waiting({ claimedAt: 1 });
      expect(hasPendingClaim(claimed)).toBe(true);
      expect(canClaim(claimed, late)).toBe(false);
      // A claim for an older position is no claim now.
      expect(hasPendingClaim(waiting({ claimedAt: 0 }))).toBe(false);
      const hidden = waiting({ claimHiddenAt: 1 });
      expect(canClaim(hidden, late)).toBe(true);
      expect(showClaimOffer(hidden, late)).toBe(false);
      expect(showClaimOffer(waiting({ claimHiddenAt: 0 }), late)).toBe(true);
    });
  });
});
