/**
 * Game-invite lifecycle: how chess reads `{verb: "close", reason}` session
 * events (declined / withdrawn) and when an invite counts as unanswered.
 */

import { describe, it, expect } from "vitest";
import type { AppMessage } from "@socialhome/app-sdk";
import { applyMove, initialState, parseSquare } from "./chess.js";
import type { GameState } from "./chess.js";
import {
  classifySessionEvent,
  declinedMessage,
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
