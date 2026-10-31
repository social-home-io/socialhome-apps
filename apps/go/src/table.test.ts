import { afterEach, describe, expect, it } from "vitest";
import type { AppMessage, GroupEvent, GroupMessage, GroupSession } from "@socialhome/app-sdk";
import { buildMessage, judgeInbound } from "./inbound.js";
import type { LocalGame } from "./inbound.js";
import { classifySessionEvent, isAwaitingOpponent, isMyTurn, launchAction, rulesOf, routeInbound, toStored } from "./lifecycle.js";
import type { GameEntry } from "./lifecycle.js";
import { chipFor, opponentLabel, statusFor } from "./view.js";
import { setLocale } from "./i18n.js";
import {
  OPENER_SEAT,
  TABLE_RULES,
  TABLE_SIZE,
  canCloseTable,
  classifyTableEvent,
  entryForTable,
  hasTableSetup,
  isWaitingForPlayer,
  parseSavedGame,
  parseTableInfo,
  routeTableMessage,
  tableColor,
  tableRole,
  updateFromTable,
} from "./table.js";

afterEach(() => setLocale("en"));

function session(over: Partial<GroupSession> = {}): GroupSession {
  return {
    id: "t1",
    appId: "go",
    state: "playing",
    spaceId: "sp1",
    me: 2,
    myState: "seated",
    host: 1,
    isHost: false,
    min: 2,
    max: 2,
    lateJoin: false,
    players: [
      { seat: 1, name: "Anna", household: "Lakeside", isLocal: false, state: "seated" },
      { seat: 2, name: "Ben", household: null, isLocal: true, state: "seated" },
    ],
    ...over,
  };
}

const opener = (over: Partial<GroupSession> = {}): GroupSession => session({ me: 1, isHost: true, ...over });

const waiting = (): GroupSession =>
  opener({ state: "lobby", players: [{ seat: 1, name: "Anna", household: null, isLocal: true, state: "seated" }] });

function msg(over: Partial<GroupMessage> = {}): GroupMessage {
  return { id: "t1", seq: 1, from: 1, data: {}, direct: false, ...over };
}

const games = (...entries: GameEntry[]): Map<string, GameEntry> => new Map(entries.map((e) => [e.sessionId, e]));

const local = (e: GameEntry): LocalGame => ({ size: e.size, myColor: e.myColor, rules: rulesOf(e), role: e.role, log: e.log });

describe("who plays which colour at a table", () => {
  it("the opener plays White, whoever takes the seat plays Black and moves first", () => {
    expect(OPENER_SEAT).toBe(1);
    expect(tableColor(1)).toBe("w");
    expect(tableColor(2)).toBe("b");
    expect(tableColor(7)).toBe("b");
    expect(tableRole(1)).toBe("inviter");
    expect(tableRole(2)).toBe("invitee");
  });

  it("both sides agree without telling each other", () => {
    const a = entryForTable(opener())!;
    const b = entryForTable(session())!;
    expect([a.myColor, a.role]).toEqual(["w", "inviter"]);
    expect([b.myColor, b.role]).toEqual(["b", "invitee"]);
    expect(a.table).toEqual({ me: 1, them: 2, spaceId: "sp1" });
    expect(b.table).toEqual({ me: 2, them: 1, spaceId: "sp1" });
  });

  it("the person who just joined can play at once; the opener waits", () => {
    expect(isMyTurn(entryForTable(session())!)).toBe(true);
    expect(isMyTurn(entryForTable(opener())!)).toBe(false);
  });
});

describe("entryForTable", () => {
  it("builds the fixed setup: 9 × 9, no handicap, no clock — never the lobby's choices", () => {
    expect(TABLE_SIZE).toBe(9);
    expect(TABLE_RULES).toEqual({ handicap: 0, days: 0 });
    for (const s of [opener(), session()]) {
      const e = entryForTable(s, 42)!;
      expect([e.size, e.handicap, e.days]).toEqual([9, 0, 0]);
      expect(e.log).toEqual([]);
      expect(e.updatedAt).toBe(42);
      expect(hasTableSetup(e)).toBe(true);
    }
  });

  it("is named after the other player", () => {
    const e = entryForTable(session())!;
    expect(e.opponentName).toBe("Anna");
    expect(e.opponentIsLocal).toBe(false);
    expect(e.sessionId).toBe("t1");
  });

  it("an open game waits with nobody in the other seat, and never shows as an invite", () => {
    const e = entryForTable(waiting())!;
    expect(e.table!.them).toBeNull();
    expect(e.opponentName).toBe("");
    expect(isWaitingForPlayer(e)).toBe(true);
    expect(canCloseTable(e)).toBe(true);
    expect(isAwaitingOpponent(e)).toBe(false);
    expect(opponentLabel(e)).toBe("Open game");
    expect(chipFor(e).text).toBe("Waiting for a player");
    expect(statusFor(e).title).toBe("Waiting for someone to take the seat");
  });

  it("none for a table we don't sit at, one that ended, or one for more than two", () => {
    expect(entryForTable(session({ me: null, myState: "joining" }))).toBeNull();
    expect(entryForTable(session({ myState: "left" }))).toBeNull();
    expect(entryForTable(session({ state: "ended", endReason: "cancelled" }))).toBeNull();
    expect(entryForTable(session({ max: 4 }))).toBeNull();
  });
});

describe("the judge at a table", () => {
  it("the opener takes Black's first move from the player who took the seat", () => {
    const a = entryForTable(opener())!;
    const v = judgeInbound(local(a), buildMessage(9, "b", [40]));
    expect(v.kind).toBe("apply");
  });

  it("refuses a tampered setup: a handicap, a clock, another board or other colours", () => {
    const a = entryForTable(opener())!; // we play White
    // Black gives itself four handicap stones.
    expect(judgeInbound(local(a), buildMessage(9, "b", [], { handicap: 4, days: 0 }))).toEqual({ kind: "refuse", reason: "setup" });
    expect(judgeInbound(local(a), buildMessage(9, "b", [40], { handicap: 2, days: 0 }))).toEqual({ kind: "refuse", reason: "setup" });
    // A clock nobody chose.
    expect(judgeInbound(local(a), buildMessage(9, "b", [40], { handicap: 0, days: 1 }))).toEqual({ kind: "refuse", reason: "setup" });
    // Another board.
    expect(judgeInbound(local(a), buildMessage(13, "b", [40]))).toEqual({ kind: "refuse", reason: "setup" });
    // Swapped colours ("you play Black").
    expect(judgeInbound(local(a), buildMessage(9, "w", [40]))).toEqual({ kind: "refuse", reason: "setup" });
    // The joiner refuses the same from the opener.
    const b = entryForTable(session())!;
    const after = [40];
    expect(judgeInbound({ ...local(b), log: after }, buildMessage(9, "w", [40, 41], { handicap: 3, days: 0 }))).toEqual({
      kind: "refuse",
      reason: "setup",
    });
  });

  it("refuses a first message that plays for us", () => {
    const b = entryForTable(session())!; // we play Black and move first
    expect(judgeInbound(local(b), buildMessage(9, "w", [40]))).toEqual({ kind: "refuse", reason: "wrong-player" });
  });

  it("both resigning at once: the opener's resignation counts on both sides", () => {
    const a = entryForTable(opener())!;
    const b = entryForTable(session())!;
    const shared = [40];
    const fromA = judgeInbound({ ...local(a), log: [...shared, "resign-w"] }, buildMessage(9, "b", [...shared, "resign-b"]));
    const fromB = judgeInbound({ ...local(b), log: [...shared, "resign-b"] }, buildMessage(9, "w", [...shared, "resign-w"]));
    expect(fromA.kind).toBe("stale"); // the opener keeps its own resignation
    expect(fromB).toMatchObject({ kind: "apply", log: [...shared, "resign-w"] });
  });
});

describe("routeTableMessage", () => {
  const b = entryForTable(session())!;

  it("takes a message from the other player's seat at our table", () => {
    expect(routeTableMessage(msg(), games(b))).toEqual({ kind: "game", entry: b });
  });

  it("drops our own seat, a third seat, and an unknown table", () => {
    expect(routeTableMessage(msg({ from: 2 }), games(b))).toEqual({ kind: "drop", reason: "not-opponent" });
    expect(routeTableMessage(msg({ from: 3 }), games(b))).toEqual({ kind: "drop", reason: "not-opponent" });
    expect(routeTableMessage(msg({ id: "t2" }), games(b))).toEqual({ kind: "drop", reason: "unknown-game" });
  });

  it("never routes to a 1:1 game with the same id", () => {
    const oneToOne: GameEntry = { ...b, table: undefined };
    expect(routeTableMessage(msg(), games(oneToOne))).toEqual({ kind: "drop", reason: "unknown-game" });
  });

  it("waits for the roster before taking a move at an open game", () => {
    const a = entryForTable(waiting())!;
    expect(routeTableMessage(msg({ from: 2 }), games(a))).toEqual({ kind: "drop", reason: "no-opponent-yet" });
  });

  it("a 1:1 message or session event never reaches a table game", () => {
    const m: AppMessage = { sessionId: "t1", fromInstance: "", fromUser: "", payload: buildMessage(9, "w", [40]) };
    expect(routeInbound(m, games(b))).toEqual({ kind: "drop", reason: "unknown-game" });
    const close: AppMessage = { sessionId: "t1", fromInstance: "", payload: { verb: "close", reason: "ended" } };
    expect(classifySessionEvent(close, games(b))).toEqual({ kind: "ignore" });
  });
});

describe("updateFromTable", () => {
  it("fills the seat once and keeps it", () => {
    const a = entryForTable(waiting())!;
    expect(updateFromTable(a, opener())).toEqual({ changed: true, joined: true });
    expect(a.table!.them).toBe(2);
    expect(a.opponentName).toBe("Ben");
    expect(isWaitingForPlayer(a)).toBe(false);
    const swapped = opener({
      players: [
        { seat: 1, name: "Anna", household: null, isLocal: true, state: "seated" },
        { seat: 3, name: "Mallory", household: "X", isLocal: false, state: "seated" },
      ],
    });
    expect(updateFromTable(a, swapped)).toEqual({ changed: false, joined: false });
    expect(a.table!.them).toBe(2);
    expect(a.opponentName).toBe("Ben");
  });

  it("ignores another table", () => {
    const a = entryForTable(waiting())!;
    expect(updateFromTable(a, opener({ id: "t9" })).changed).toBe(false);
  });
});

describe("classifyTableEvent", () => {
  const ev = (e: Partial<GroupEvent> & { type: GroupEvent["type"] }): GroupEvent =>
    ({ id: "t1", session: session(), ...e }) as GroupEvent;

  it("someone taking the seat at our open game", () => {
    const a = entryForTable(waiting())!;
    expect(classifyTableEvent(ev({ type: "joined", seat: 2, session: opener() }), games(a))).toEqual({ kind: "joined", entry: a });
    expect(a.table!.them).toBe(2);
    expect(classifyTableEvent(ev({ type: "started", session: opener() }), games(a)).kind).toBe("update");
  });

  it("seats a table we now sit at but have no game for", () => {
    const s = session();
    expect(classifyTableEvent(ev({ type: "joined", seat: 2, session: s }), games())).toEqual({ kind: "seat", session: s });
    expect(
      classifyTableEvent(ev({ type: "joined", seat: 2, session: session({ myState: "joining", me: null }) }), games()),
    ).toEqual({ kind: "ignore" });
  });

  it("the other player leaving or the table ending stops a game on the board", () => {
    const b = entryForTable(session())!;
    expect(classifyTableEvent(ev({ type: "left", seat: 1 }), games(b))).toEqual({ kind: "gone", entry: b, reason: "left" });
    expect(classifyTableEvent(ev({ type: "removed", seat: 1 }), games(b))).toEqual({ kind: "gone", entry: b, reason: "left" });
    expect(classifyTableEvent(ev({ type: "ended" }), games(b))).toEqual({ kind: "gone", entry: b, reason: "ended" });
    expect(classifyTableEvent(ev({ type: "left", seat: 2 }), games(b))).toEqual({ kind: "mine-over", entry: b });
    expect(classifyTableEvent(ev({ type: "left", seat: 5 }), games(b))).toEqual({ kind: "ignore" });
  });

  it("a finished game stays when the table ends or the other player leaves", () => {
    const b = entryForTable(session())!;
    b.log = ["resign-b"];
    expect(classifyTableEvent(ev({ type: "ended" }), games(b))).toEqual({ kind: "ignore" });
    expect(classifyTableEvent(ev({ type: "left", seat: 1 }), games(b))).toEqual({ kind: "ignore" });
  });

  it("never touches a 1:1 game, and ignores messages", () => {
    const b: GameEntry = { ...entryForTable(session())!, table: undefined };
    expect(classifyTableEvent(ev({ type: "ended" }), games(b))).toEqual({ kind: "ignore" });
    expect(classifyTableEvent({ type: "message", ...msg() }, games(b))).toEqual({ kind: "ignore" });
  });
});

describe("launchAction for a table", () => {
  it("Join / Play opens the table", () => {
    const s = session();
    expect(launchAction({ sessionId: "t1", group: s }, games())).toEqual({ kind: "table", session: s });
    expect(launchAction({ sessionId: "t1", group: s }, games(entryForTable(s)!))).toEqual({ kind: "table", session: s });
  });

  it("a table id naming a 1:1 game we have is refused, and an invite never names a table game", () => {
    const b: GameEntry = { ...entryForTable(session())!, table: undefined };
    expect(launchAction({ sessionId: "t1", group: session() }, games(b))).toEqual({ kind: "mismatch" });
    const invite: AppMessage = { sessionId: "t1", fromInstance: "", payload: {} };
    expect(launchAction({ sessionId: "t1", invite }, games(entryForTable(session())!))).toEqual({ kind: "mismatch" });
  });
});

describe("parseTableInfo", () => {
  it("reads a saved table back", () => {
    expect(parseTableInfo({ me: 1, them: null, spaceId: "sp" })).toEqual({ me: 1, them: null, spaceId: "sp" });
    expect(parseTableInfo({ me: 2, them: 1 })).toEqual({ me: 2, them: 1 });
  });

  it("refuses anything else", () => {
    expect(parseTableInfo(null)).toBeUndefined();
    expect(parseTableInfo({ me: 0, them: 1 })).toBeUndefined();
    expect(parseTableInfo({ me: 1, them: 1 })).toBeUndefined();
    expect(parseTableInfo({ me: 1, them: "2" })).toBeUndefined();
    expect(parseTableInfo({ me: 1.5, them: null })).toBeUndefined();
  });
});

describe("parseSavedGame", () => {
  const roundTrip = (e: GameEntry): unknown => JSON.parse(JSON.stringify(toStored(e)));

  it("reads a table game back with its seat, and a 1:1 game as before", () => {
    const b = entryForTable(session())!;
    b.log = [40];
    expect(parseSavedGame(roundTrip(b))).toMatchObject({ table: { me: 2, them: 1, spaceId: "sp1" }, log: [40], myColor: "b" });
    const oneToOne = { ...roundTrip(b) as Record<string, unknown> };
    delete oneToOne["table"];
    expect(parseSavedGame(oneToOne)?.table).toBeUndefined();
  });

  it("drops a table game whose setup doesn't follow from its seat", () => {
    const b = entryForTable(session())!;
    const bad = (over: Record<string, unknown>) => parseSavedGame({ ...(roundTrip(b) as Record<string, unknown>), ...over });
    expect(bad({ handicap: 2 })).toBeNull();
    expect(bad({ days: 1 })).toBeNull();
    expect(bad({ size: 13 })).toBeNull();
    expect(bad({ myColor: "w" })).toBeNull();
    expect(bad({ role: "inviter" })).toBeNull();
    expect(bad({ table: { me: 2, them: 2 } })).toBeNull();
    expect(bad({ table: "t1" })).toBeNull();
  });
});
