import { afterEach, describe, expect, it } from "vitest";
import { ShError } from "@socialhome/app-sdk";
import type { AppMessage, Contact, PickedPerson } from "@socialhome/app-sdk";
import {
  classifySessionEvent,
  continueCopy,
  entryForInvite,
  entryForPicked,
  fromOpponent,
  isAwaitingOpponent,
  isLocalOpponent,
  isUnansweredInvite,
  isUnknownGame,
  launchAction,
  pickFailure,
  removeCopy,
  resignCopy,
  routeInbound,
  senderOf,
  targetFor,
} from "./lifecycle.js";
import type { GameEntry } from "./lifecycle.js";
import { fire, lockIn, newGame, resign } from "./game.js";
import type { Game, Role } from "./game.js";
import type { Fleet } from "./rules.js";
import { setLocale } from "./i18n.js";

const FLEET: Fleet = [
  [0, 0, "h"],
  [1, 10, "h"],
  [2, 20, "h"],
  [3, 30, "h"],
  [4, 40, "h"],
];

function game(role: Role, over: Partial<Game> = {}): Game {
  return { ...lockIn(newGame("s1", role, FLEET), new Uint8Array(32)), ...over };
}

function entry(g: Game = game("challenger")): GameEntry {
  return { sessionId: "s1", opponentInstanceId: "inst-b", opponentRef: "bob", opponentIsLocal: false, opponentName: "Bob", game: g };
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

  it("routes a message to its game, from its opponent only", () => {
    const g = games(entry());
    expect(routeInbound({ sessionId: "s1", fromInstance: "inst-b", fromUser: "bob", payload: {} }, g).kind).toBe("game");
    expect(routeInbound({ sessionId: "s2", fromInstance: "inst-b", payload: {} }, g)).toEqual({ kind: "drop", reason: "unknown-game" });
    expect(routeInbound({ sessionId: "s1", fromInstance: "inst-x", payload: {} }, g)).toEqual({ kind: "drop", reason: "not-opponent" });
  });
});

describe("invite states", () => {
  it("our invite waits until their seal or a shot arrives", () => {
    expect(isAwaitingOpponent(entry())).toBe(true);
    expect(isAwaitingOpponent(entry(game("challenger", { theirLeaves: "x" })))).toBe(false);
    expect(isAwaitingOpponent(entry(game("invitee")))).toBe(false);
    expect(isAwaitingOpponent(entry(resign(game("challenger"))))).toBe(false);
  });

  it("a received invite is unanswered until we fire", () => {
    expect(isUnansweredInvite(entry(newGame("s1", "invitee", FLEET)))).toBe(true);
    expect(isUnansweredInvite(entry(game("invitee", { shots: [{ cell: 3 }] })))).toBe(false);
  });
});

describe("closes", () => {
  it("declined ends our unanswered invite only", () => {
    expect(classifySessionEvent(close("declined"), games(entry())).kind).toBe("declined");
    expect(classifySessionEvent(close("declined"), games(entry(game("challenger", { theirLeaves: "x" })))).kind).toBe("ignore");
  });

  it("withdrawn ends an invite we haven't fired in", () => {
    expect(classifySessionEvent(close("withdrawn"), games(entry(newGame("s1", "invitee", FLEET)))).kind).toBe("withdrawn");
    expect(classifySessionEvent(close("withdrawn"), games(entry(game("invitee", { shots: [{ cell: 1 }] })))).kind).toBe("ignore");
    expect(classifySessionEvent(close("withdrawn"), games(entry())).kind).toBe("ignore");
  });

  it("ended ends any game still going, never a finished one", () => {
    const g = game("invitee", { theirLeaves: "x", theirRoot: "r" });
    expect(classifySessionEvent(close("ended"), games(entry(g))).kind).toBe("ended");
    expect(classifySessionEvent(close("ended"), games(entry(resign(g)))).kind).toBe("ignore");
  });

  it("ignores closes from strangers, for unknown games, and without a known reason", () => {
    expect(classifySessionEvent(close("declined", { fromInstance: "x" }), games(entry())).kind).toBe("ignore");
    expect(classifySessionEvent(close("declined", { sessionId: "s9" }), games(entry())).kind).toBe("ignore");
    expect(classifySessionEvent(close(undefined), games(entry())).kind).toBe("ignore");
    expect(classifySessionEvent({ ...close(""), payload: { verb: "other" } }, games(entry())).kind).toBe("ignore");
  });

  it("a live open is news only, unless an older host seats it", () => {
    const open: AppMessage = { sessionId: "s7", fromInstance: "inst-b", fromUser: "bob", payload: { verb: "open" } };
    expect(classifySessionEvent(open, games()).kind).toBe("ignore");
    expect(classifySessionEvent(open, games(), { liveInvites: true }).kind).toBe("invite");
    expect(classifySessionEvent(open, games(), { liveInvites: true, selfUserId: "bob" }).kind).toBe("ignore");
    expect(classifySessionEvent({ ...open, sessionId: "s1" }, games(entry()), { liveInvites: true }).kind).toBe("ignore");
  });
});

describe("launch", () => {
  const invite: AppMessage = { sessionId: "s1", fromInstance: "inst-b", fromUser: "bob", payload: { verb: "open" } };
  it("starts, opens, refuses or says gone", () => {
    expect(launchAction(undefined, games())).toEqual({ kind: "none" });
    expect(launchAction({}, games())).toEqual({ kind: "none" });
    expect(launchAction({ sessionId: "s1", invite }, games())).toEqual({ kind: "start", invite });
    expect(launchAction({ sessionId: "s1", invite }, games(entry()))).toEqual({ kind: "open", sessionId: "s1" });
    expect(launchAction({ sessionId: "s1" }, games(entry()))).toEqual({ kind: "open", sessionId: "s1" });
    expect(launchAction({ sessionId: "s1", invite: { ...invite, fromUser: "eve" } }, games(entry()))).toEqual({ kind: "mismatch" });
    expect(launchAction({ sessionId: "s1" }, games())).toEqual({ kind: "gone" });
  });
});

describe("entries", () => {
  const contacts: Contact[] = [
    { instance_id: "inst-a", user_ref: "me", is_local: true, display_name: "Me", online: true },
    { instance_id: "inst-b", user_ref: "bob", is_local: false, display_name: "Bob · Lakeside", online: false },
  ];

  it("for the person picked, and for an invite", () => {
    const p: PickedPerson = { instance_id: "inst-b", user_ref: "bob", is_local: false, display_name: "Bob", sessionId: "s5" };
    const g = game("challenger");
    expect(entryForPicked(p, g)).toMatchObject({ sessionId: "s5", opponentName: "Bob", opponentRef: "bob", game: g });
    const e = entryForInvite({ sessionId: "s6", fromInstance: "inst-b", fromUser: "bob", payload: {} }, contacts, g);
    expect(e).toMatchObject({ opponentName: "Bob · Lakeside", opponentIsLocal: false });
    const anon = entryForInvite({ sessionId: "s6", fromInstance: "inst-z", payload: {} }, contacts, g);
    expect(anon.opponentName).toBe("inst-z");
    expect(targetFor(e)).toEqual({ instance_id: "inst-b", user_ref: "bob", is_local: false });
  });

  it("knows a local inviter by our household's id", () => {
    expect(isLocalOpponent("inst-a", "kim", contacts)).toBe(true);
    expect(isLocalOpponent("inst-b", "bob", contacts)).toBe(false);
    expect(isLocalOpponent("inst-a", "kim", [])).toBe(false);
  });
});

describe("failures and confirms", () => {
  it("reads pick failures", () => {
    expect(pickFailure(new ShError("busy", "x"))).toEqual({ kind: "quiet" });
    expect(pickFailure(new ShError("too_soon", "x"))).toMatchObject({ kind: "toast" });
    expect(pickFailure(new ShError("permission_denied", "x"))).toEqual({ kind: "toast", message: "Battleships can't invite people in this household." });
    expect(pickFailure(new ShError("unknown_method", "x"))).toMatchObject({ kind: "toast" });
    expect(pickFailure(new Error("x"))).toMatchObject({ kind: "toast" });
  });

  it("knows a game Social Home forgot", () => {
    expect(isUnknownGame(new ShError("unknown_session", "x"))).toBe(true);
    expect(isUnknownGame(new Error("unknown_session"))).toBe(false);
  });

  it("says what resign, remove and continue do", () => {
    const e = entry();
    expect(resignCopy(e).body).toBe("Bob wins, and both fleets are shown.");
    expect(removeCopy(e).title).toBe("Remove your game with Bob?");
    expect(continueCopy(e)).toMatchObject({ confirm: "Continue game with Bob", primary: true });
    setLocale("de");
    expect(resignCopy(e).confirm).toBe("Aufgeben");
  });

  it("a fired game is no longer an unanswered invite", () => {
    const g = game("invitee", { theirLeaves: "x", theirRoot: "r" });
    expect(isUnansweredInvite(entry(fire(g, 5)))).toBe(false);
  });
});
