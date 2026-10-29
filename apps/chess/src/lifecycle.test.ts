/**
 * Game-invite lifecycle: how chess reads `{verb: "close", reason}` session
 * events (declined / withdrawn) and when an invite counts as unanswered.
 */

import { describe, it, expect } from "vitest";
import { ShError } from "@socialhome/app-sdk";
import type { AppMessage, PickedPerson } from "@socialhome/app-sdk";
import { applyMove, initialState, parseSquare } from "./chess.js";
import type { GameState } from "./chess.js";
import {
  abandonButtonLabel,
  abandonConfirmCopy,
  classifySessionEvent,
  declinedMessage,
  continueCopy,
  entryForPicked,
  isUnknownGame,
  isLocalOpponent,
  pickFailure,
  INVITE_GONE,
  isOwnInvite,
  isStaleMove,
  launchAction,
  isAwaitingOpponent,
  senderOf,
  withdrawnMessage,
} from "./lifecycle.js";
import type { GameEntry } from "./lifecycle.js";

function stateAfter(...moves: [string, string][]): GameState {
  let s = initialState();
  for (const [from, to] of moves) s = applyMove(s, { from: parseSquare(from), to: parseSquare(to) });
  return s;
}

function entry(over: Partial<GameEntry> = {}): GameEntry {
  return {
    sessionId: "s1",
    opponentInstanceId: "inst-b",
    opponentRef: "bob",
    opponentIsLocal: false,
    opponentName: "Bob",
    myColor: "w",
    state: initialState(),
    ...over,
  };
}

function games(...entries: GameEntry[]): Map<string, GameEntry> {
  return new Map(entries.map((e) => [e.sessionId, e]));
}

function close(reason: unknown, over: Partial<AppMessage> = {}): AppMessage {
  return {
    sessionId: "s1",
    fromInstance: "inst-b",
    fromUser: "bob",
    payload: reason === undefined ? { verb: "close" } : { verb: "close", reason },
    ...over,
  };
}

describe("isAwaitingOpponent", () => {
  it("a fresh challenge is waiting for the opponent", () => {
    expect(isAwaitingOpponent(entry())).toBe(true);
  });

  it("still waiting after the challenger's own first move", () => {
    expect(isAwaitingOpponent(entry({ state: stateAfter(["e2", "e4"]) }))).toBe(true);
  });

  it("answered once the opponent has moved", () => {
    expect(
      isAwaitingOpponent(entry({ state: stateAfter(["e2", "e4"], ["e7", "e5"]) })),
    ).toBe(false);
  });

  it("an invite we received is never 'our invite'", () => {
    expect(isAwaitingOpponent(entry({ myColor: "b" }))).toBe(false);
  });

  it("a finished game is not waiting", () => {
    expect(isAwaitingOpponent(entry({ state: { ...initialState(), result: "draw" } }))).toBe(
      false,
    );
  });
});

describe("classifySessionEvent — declined (challenger side)", () => {
  it("our unanswered invite, declined by the invitee → declined", () => {
    const e = entry();
    expect(classifySessionEvent(close("declined"), games(e))).toEqual({
      kind: "declined",
      entry: e,
    });
  });

  it("also after our own first move", () => {
    const e = entry({ state: stateAfter(["d2", "d4"]) });
    expect(classifySessionEvent(close("declined"), games(e)).kind).toBe("declined");
  });

  it("a decline for a game already under way is ignored", () => {
    const e = entry({ state: stateAfter(["e2", "e4"], ["e7", "e5"]) });
    expect(classifySessionEvent(close("declined"), games(e)).kind).toBe("ignore");
  });

  it("a decline on a game where we are the invitee is ignored", () => {
    const e = entry({ myColor: "b" });
    expect(classifySessionEvent(close("declined"), games(e)).kind).toBe("ignore");
  });
});

describe("classifySessionEvent — withdrawn (invitee side)", () => {
  it("an invite we received, withdrawn by the challenger → withdrawn", () => {
    const e = entry({ myColor: "b" });
    expect(classifySessionEvent(close("withdrawn"), games(e))).toEqual({
      kind: "withdrawn",
      entry: e,
    });
  });

  it("also after the challenger's first move (we haven't answered)", () => {
    const e = entry({ myColor: "b", state: stateAfter(["e2", "e4"]) });
    expect(classifySessionEvent(close("withdrawn"), games(e)).kind).toBe("withdrawn");
  });

  it("ignored once we have answered with a move", () => {
    const e = entry({ myColor: "b", state: stateAfter(["e2", "e4"], ["e7", "e5"]) });
    expect(classifySessionEvent(close("withdrawn"), games(e)).kind).toBe("ignore");
  });

  it("a withdrawal on our own invite is ignored", () => {
    expect(classifySessionEvent(close("withdrawn"), games(entry())).kind).toBe("ignore");
  });
});

describe("classifySessionEvent — who may close", () => {
  it("a close from another household is ignored", () => {
    const msg = close("declined", { fromInstance: "inst-x" });
    expect(classifySessionEvent(msg, games(entry())).kind).toBe("ignore");
  });

  it("a close from another person of the opponent's household is ignored", () => {
    const msg = close("declined", { fromUser: "mallory" });
    expect(classifySessionEvent(msg, games(entry())).kind).toBe("ignore");
  });

  it("a close without a named person is accepted from the opponent's household", () => {
    const msg = close("declined", { fromUser: undefined });
    expect(classifySessionEvent(msg, games(entry())).kind).toBe("declined");
  });

  it("a game saved before person-addressing (no opponentRef) still matches", () => {
    const e = entry({ opponentRef: "" });
    expect(classifySessionEvent(close("declined"), games(e)).kind).toBe("declined");
  });
});

describe("classifySessionEvent — plain / unknown close keeps today's behaviour", () => {
  it("a close with no reason changes nothing", () => {
    expect(classifySessionEvent(close(undefined), games(entry())).kind).toBe("ignore");
  });

  it("a close with an unknown reason changes nothing", () => {
    expect(classifySessionEvent(close("expired"), games(entry())).kind).toBe("ignore");
    expect(classifySessionEvent(close(42), games(entry())).kind).toBe("ignore");
  });

  it("a close for a game we don't know never creates one", () => {
    expect(classifySessionEvent(close("declined"), games()).kind).toBe("ignore");
    expect(classifySessionEvent(close(undefined), games()).kind).toBe("ignore");
  });
});

describe("classifySessionEvent — invites", () => {
  const base = { sessionId: "s9", fromInstance: "inst-b", fromUser: "bob" };

  it("an open is an invite", () => {
    expect(classifySessionEvent({ ...base, payload: { verb: "open" } }, games()).kind).toBe(
      "invite",
    );
  });

  it("a payload without a verb (older host / replay) is an invite", () => {
    expect(classifySessionEvent({ ...base, payload: {} }, games()).kind).toBe("invite");
    expect(classifySessionEvent({ ...base, payload: undefined }, games()).kind).toBe("invite");
  });

  it("other verbs are ignored", () => {
    expect(classifySessionEvent({ ...base, payload: { verb: "accept" } }, games()).kind).toBe(
      "ignore",
    );
  });
});

describe("senderOf", () => {
  it("prefers the host's fromUser", () => {
    expect(
      senderOf({ sessionId: "s", fromInstance: "i", fromUser: "bob", payload: { from_user: "x" } }),
    ).toBe("bob");
  });

  it("falls back to the payload's from_user (remote session events)", () => {
    expect(
      senderOf({ sessionId: "s", fromInstance: "i", payload: { verb: "open", from_user: "alice" } }),
    ).toBe("alice");
  });

  it("is undefined when nobody is named", () => {
    expect(senderOf({ sessionId: "s", fromInstance: "i", payload: { verb: "open" } })).toBeUndefined();
    expect(senderOf({ sessionId: "s", fromInstance: "i", payload: { from_user: "" } })).toBeUndefined();
    expect(senderOf({ sessionId: "s", fromInstance: "i", payload: null })).toBeUndefined();
  });

  it("a remote close naming another person via the payload is ignored", () => {
    const msg = close("declined", { fromUser: undefined });
    msg.payload = { verb: "close", reason: "declined", from_user: "mallory" };
    expect(classifySessionEvent(msg, games(entry())).kind).toBe("ignore");
  });

  it("a remote close naming the opponent via the payload is accepted", () => {
    const msg = close("declined", { fromUser: undefined });
    msg.payload = { verb: "close", reason: "declined", from_user: "bob" };
    expect(classifySessionEvent(msg, games(entry())).kind).toBe("declined");
  });
});

describe("messages", () => {
  it("name the other person", () => {
    expect(declinedMessage("Bob")).toBe("Bob declined the game.");
    expect(withdrawnMessage("Alice")).toBe("Alice took the invite back.");
  });
});

describe("abandon confirm", () => {
  it("a game in play: Abandon, and says the opponent isn't told", () => {
    const e = entry({ opponentName: "Ben", state: stateAfter(["e2", "e4"], ["e7", "e5"]) });
    expect(abandonButtonLabel(e)).toBe("Abandon");
    const copy = abandonConfirmCopy(e);
    expect(copy.title).toBe("Abandon your game with Ben?");
    expect(copy.body).toContain("can't be resumed");
    expect(copy.body).toContain("Ben isn't told");
    expect(copy.confirm).toBe("Abandon game");
    expect(copy.cancel).toBe("Keep playing");
  });

  it("a finished game: Remove", () => {
    const e = entry({ opponentName: "Ben", state: { ...initialState(), result: "black" } });
    expect(abandonButtonLabel(e)).toBe("Remove");
    expect(abandonConfirmCopy(e)).toMatchObject({
      title: "Remove your game with Ben?",
      confirm: "Remove game",
      cancel: "Keep it",
    });
  });
});

function open(over: Partial<AppMessage> = {}): AppMessage {
  return {
    sessionId: "s9",
    fromInstance: "inst-b",
    fromUser: "bob",
    payload: { verb: "open", session_id: "s9" },
    ...over,
  };
}

describe("classifySessionEvent — invites", () => {
  it("an older host: a live open is an invite (seated, as before)", () => {
    expect(classifySessionEvent(open(), games()).kind).toBe("invite");
    expect(classifySessionEvent(open(), games(), { liveInvites: true }).kind).toBe("invite");
  });

  it("a host with launch contexts: a live open is ignored — it waits in Needs you until Play", () => {
    expect(classifySessionEvent(open(), games(), { liveInvites: false }).kind).toBe("ignore");
  });

  it("our own invite echoed back is never an invite to us (the stray toast)", () => {
    const echo = open({ fromInstance: "inst-a", fromUser: "u-me" });
    expect(isOwnInvite(echo, "u-me")).toBe(true);
    expect(classifySessionEvent(echo, games(), { selfUserId: "u-me" }).kind).toBe("ignore");
    // Someone else's invite still is.
    expect(classifySessionEvent(open(), games(), { selfUserId: "u-me" }).kind).toBe("invite");
    // Before the context is known (no self id) nothing is mistaken for ours.
    expect(isOwnInvite(echo, "")).toBe(false);
  });

  it("closes are still handled on a host with launch contexts", () => {
    const e = entry();
    expect(classifySessionEvent(close("declined"), games(e), { liveInvites: false }).kind).toBe("declined");
  });
});

describe("launchAction — Play opens the game you were invited to", () => {
  const invite = open({ sessionId: "s9" });

  it("opened normally or by an older host: nothing to start", () => {
    expect(launchAction(undefined, games())).toEqual({ kind: "none" });
    expect(launchAction({}, games())).toEqual({ kind: "none" });
  });

  it("an invite accepted for this launch: start that game", () => {
    expect(launchAction({ sessionId: "s9", invite }, games())).toEqual({ kind: "start", invite });
  });

  it("a game we already have: open it (no second seat)", () => {
    const e = entry({ sessionId: "s9", myColor: "b" });
    expect(launchAction({ sessionId: "s9", invite }, games(e))).toEqual({ kind: "open", sessionId: "s9" });
    expect(launchAction({ sessionId: "s9" }, games(e))).toEqual({ kind: "open", sessionId: "s9" });
  });

  it("an invite that no longer waits, for a game we don't have: say so", () => {
    expect(launchAction({ sessionId: "s9" }, games())).toEqual({ kind: "gone" });
    expect(INVITE_GONE).toMatch(/isn't open/);
  });
});

describe("held moves (Social Home keeps the latest move while chess is closed)", () => {
  const two = stateAfter(["e2", "e4"], ["e7", "e5"]);
  const three = stateAfter(["e2", "e4"], ["e7", "e5"], ["g1", "f3"]);

  it("a move ahead of ours is applied", () => {
    expect(isStaleMove(entry({ state: two }), three)).toBe(false);
  });

  it("a held copy of a move we already have changes nothing", () => {
    expect(isStaleMove(entry({ state: three }), three)).toBe(true);
  });

  it("an older held game never rolls the board back", () => {
    expect(isStaleMove(entry({ state: three }), two)).toBe(true);
  });

  it("several missed moves at once: the latest full state catches up", () => {
    expect(isStaleMove(entry({ state: initialState() }), three)).toBe(false);
  });
});

describe("new games through Social Home's invite sheet", () => {
  const BEN: PickedPerson = {
    instance_id: "brookside",
    user_ref: "ben",
    is_local: false,
    display_name: "Ben · Brookside",
    sessionId: "s1",
  };

  it("a picked person becomes a fresh game we play as White, with exactly them", () => {
    const entry = entryForPicked(BEN);
    expect(entry).toMatchObject({
      sessionId: "s1",
      opponentInstanceId: "brookside",
      opponentRef: "ben",
      opponentIsLocal: false,
      opponentName: "Ben · Brookside",
      myColor: "w",
    });
    expect(entry.state).toEqual(initialState());
    // Awaiting their answer: "Cancel invite" shows.
    expect(isAwaitingOpponent(entry)).toBe(true);
  });

  it("whether an invitee is local comes from the contact Social Home lists for them", () => {
    const milo = { instance_id: "home", user_ref: "u-milo", display_name: "Milo", is_local: true, online: false };
    const ben = { instance_id: "brookside", user_ref: "ben", display_name: "Ben", is_local: false, online: false };
    expect(isLocalOpponent("home", "u-milo", [milo])).toBe(true);
    expect(isLocalOpponent("brookside", "ben", [ben])).toBe(false);
    // Not a contact (yet): our household's id from any local contact.
    expect(isLocalOpponent("home", "u-anna", [milo])).toBe(true);
    expect(isLocalOpponent("home", "u-anna", [ben])).toBe(false);
    expect(isLocalOpponent("home", "u-anna", [])).toBe(false);
  });

  it("why the sheet didn't open, in what chess does about it", () => {
    expect(pickFailure(new ShError("unknown_method", "x"))).toEqual({ kind: "legacy" });
    expect(pickFailure(new ShError("busy", "x"))).toEqual({ kind: "quiet" });
    expect(pickFailure(new ShError("too_soon", "x", { retryAfterMs: 2000 }))).toEqual({
      kind: "toast",
      message: "Wait a moment, then try again.",
    });
    expect(pickFailure(new ShError("permission_denied", "x", { permission: "people" }))).toMatchObject({
      kind: "toast",
    });
    expect(pickFailure(new Error("RPC timeout"))).toEqual({
      kind: "toast",
      message: "Couldn't open the invite — please try again.",
    });
  });
});

describe("continue a game Social Home no longer knows", () => {
  const game: GameEntry = {
    sessionId: "old-game",
    opponentInstanceId: "brookside",
    opponentRef: "ben",
    opponentIsLocal: false,
    opponentName: "Ben",
    myColor: "w",
    state: initialState(),
  };

  it("a refused send for an unknown game offers to continue it", () => {
    expect(isUnknownGame(new ShError("unknown_session", "x"))).toBe(true);
    expect(isUnknownGame(new ShError("permission_denied", "x"))).toBe(false);
    expect(isUnknownGame(new Error("RPC timeout"))).toBe(false);
    const copy = continueCopy(game);
    expect(copy.confirm).toBe("Continue game with Ben");
    expect(copy.primary).toBe(true);
  });

  it("Play for our game from its opponent (a continue) opens it", () => {
    const invite = { sessionId: "old-game", fromInstance: "brookside", fromUser: "ben", payload: { verb: "continue" } };
    expect(launchAction({ sessionId: "old-game", invite }, new Map([["old-game", game]]))).toEqual({
      kind: "open",
      sessionId: "old-game",
    });
  });

  it("Play for our game from someone else is refused — a session id never moves", () => {
    for (const invite of [
      { sessionId: "old-game", fromInstance: "elsewhere", fromUser: "ben", payload: {} },
      { sessionId: "old-game", fromInstance: "brookside", fromUser: "mallory", payload: {} },
    ]) {
      expect(launchAction({ sessionId: "old-game", invite }, new Map([["old-game", game]]))).toEqual({
        kind: "mismatch",
      });
    }
  });
});
