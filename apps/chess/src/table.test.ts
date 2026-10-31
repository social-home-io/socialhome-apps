import { describe, expect, it } from "vitest";
import type { GroupEvent, GroupMessage, GroupSession } from "@socialhome/app-sdk";
import { applyMove, initialState } from "./chess.js";
import { judgeInbound } from "./inbound.js";
import { colorFromInviter, launchAction } from "./lifecycle.js";
import type { GameEntry } from "./lifecycle.js";
import {
  OPENER_SEAT,
  classifyTableEvent,
  entryForTable,
  isWaitingForPlayer,
  parseTableInfo,
  routeTableMessage,
  tableColor,
  updateFromTable,
} from "./table.js";

function session(over: Partial<GroupSession> = {}): GroupSession {
  return {
    id: "t1",
    appId: "chess",
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

const opener = (over: Partial<GroupSession> = {}): GroupSession =>
  session({ me: 1, isHost: true, ...over });

const waiting = (): GroupSession =>
  opener({ state: "lobby", players: [{ seat: 1, name: "Anna", household: null, isLocal: true, state: "seated" }] });

function msg(over: Partial<GroupMessage> = {}): GroupMessage {
  return { id: "t1", seq: 1, from: 1, data: {}, direct: false, ...over };
}

const games = (...entries: GameEntry[]): Map<string, GameEntry> => new Map(entries.map((e) => [e.sessionId, e]));

describe("who plays which colour at a table", () => {
  it("the opener plays Black, whoever takes the seat plays White and moves first", () => {
    expect(OPENER_SEAT).toBe(1);
    expect(tableColor(1)).toBe("b");
    expect(tableColor(2)).toBe("w");
    expect(tableColor(7)).toBe("w");
  });

  it("both sides agree without telling each other", () => {
    const a = entryForTable(opener())!;
    const b = entryForTable(session())!;
    expect(a.myColor).toBe("b");
    expect(b.myColor).toBe("w");
    expect(a.table).toEqual({ me: 1, them: 2, spaceId: "sp1" });
    expect(b.table).toEqual({ me: 2, them: 1, spaceId: "sp1" });
  });

  it("an inviter's colour message never changes a table game", () => {
    const b = entryForTable(session())!;
    expect(colorFromInviter(b, { type: "open", youPlay: "b" })).toBeUndefined();
  });
});

describe("entryForTable", () => {
  it("starts a fresh board named after the other player", () => {
    const e = entryForTable(session(), 42)!;
    expect(e.sessionId).toBe("t1");
    expect(e.opponentName).toBe("Anna");
    expect(e.opponentIsLocal).toBe(false);
    expect(e.state.history).toEqual([]);
    expect(e.inviter).toBe(false);
    expect(e.accepted).toBe(true);
    expect(e.updatedAt).toBe(42);
  });

  it("an open game waits with nobody in the other seat", () => {
    const e = entryForTable(waiting())!;
    expect(e.table!.them).toBeNull();
    expect(e.opponentName).toBe("");
    expect(isWaitingForPlayer(e)).toBe(true);
  });

  it("none for a table we don't sit at, one that ended, or one for more than two", () => {
    expect(entryForTable(session({ me: null, myState: "joining" }))).toBeNull();
    expect(entryForTable(session({ myState: "left" }))).toBeNull();
    expect(entryForTable(session({ state: "ended", endReason: "cancelled" }))).toBeNull();
    expect(entryForTable(session({ max: 4 }))).toBeNull();
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

  it("the judge refuses Black's move from the player who took the seat", () => {
    const a = entryForTable(opener())!; // we play Black, they play White
    const white = applyMove(initialState(), { from: 52, to: 36 });
    const ok = judgeInbound(a.state, a.myColor, { type: "move", state: { history: white.history } });
    expect(ok.kind).toBe("apply");
    const b2 = entryForTable(session())!; // we play White: a first move from them is ours
    const forged = judgeInbound(b2.state, b2.myColor, { type: "move", state: { history: white.history } });
    expect(forged).toEqual({ kind: "refuse", reason: "wrong-colour" });
  });
});

describe("updateFromTable", () => {
  it("fills the seat once and keeps it", () => {
    const a = entryForTable(waiting())!;
    expect(updateFromTable(a, opener())).toEqual({ changed: true, joined: true });
    expect(a.table!.them).toBe(2);
    expect(a.opponentName).toBe("Ben");
    // A roster that later shows someone else in another seat doesn't move it.
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
    const action = classifyTableEvent(ev({ type: "joined", seat: 2, session: opener() }), games(a));
    expect(action).toEqual({ kind: "joined", entry: a });
    expect(a.table!.them).toBe(2);
    // The start that follows is just an update.
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
    b.state = { ...b.state, result: "white" };
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
  });

  it("a table id naming a 1:1 game we have is refused", () => {
    const b: GameEntry = { ...entryForTable(session())!, table: undefined };
    expect(launchAction({ sessionId: "t1", group: session() }, games(b))).toEqual({ kind: "mismatch" });
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
