import { afterEach, describe, expect, it } from "vitest";
import type { AppMessage, GroupEvent, GroupMessage, GroupSession } from "@socialhome/app-sdk";
import { fire, hitsByMe, lockIn, phase, resign } from "./game.js";
import { buildMessage, markSent, passesTurn, receive } from "./protocol.js";
import type { Verdict } from "./protocol.js";
import type { Fleet } from "./rules.js";
import { isAwaitingOpponent, isUnansweredInvite, launchAction, opponentLabel, routeInbound } from "./lifecycle.js";
import type { GameEntry } from "./lifecycle.js";
import { chipFor, progressFor, statusFor } from "./view.js";
import { setLocale } from "./i18n.js";
import {
  OPENER_SEAT,
  classifyTableEvent,
  entryForTable,
  isWaitingForPlayer,
  parseTableInfo,
  roleFitsSeat,
  routeTableMessage,
  sealGoesOutOnLockIn,
  tablePassesTurn,
  tableRole,
  updateFromTable,
} from "./table.js";

afterEach(() => setLocale("en"));

const FLEET: Fleet = [
  [0, 0, "h"],
  [1, 10, "h"],
  [2, 20, "h"],
  [3, 30, "h"],
  [4, 40, "h"],
];
const FLEET2: Fleet = [
  [0, 90, "h"],
  [1, 80, "h"],
  [2, 70, "h"],
  [3, 60, "h"],
  [4, 50, "h"],
];
const seed = (n: number) => new Uint8Array(32).fill(n);

function session(over: Partial<GroupSession> = {}): GroupSession {
  return {
    id: "t1",
    appId: "battleships",
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

/** What leaves an app: the whole game, through JSON, and marked as sent when final. */
function out(e: GameEntry, from: number, seq: number): GroupMessage {
  const data = JSON.parse(JSON.stringify(buildMessage(e.game))) as unknown;
  e.game = markSent(e.game);
  return msg({ from, seq, data });
}

/** Deliver a table message the way main.ts does: route by table + seat, then the 1:1 judge. */
function deliver(m: GroupMessage, to: GameEntry): Verdict {
  const route = routeTableMessage(m, games(to));
  expect(route.kind).toBe("game");
  const v = receive(to.game, m.data, 1);
  if (v.kind === "update") to.game = v.game;
  return v;
}

describe("seats → roles", () => {
  it("the opener (seat 1) is the challenger; whoever takes a seat is the invitee and fires first", () => {
    expect(OPENER_SEAT).toBe(1);
    expect(tableRole(1)).toBe("challenger");
    expect(tableRole(2)).toBe("invitee");
    expect(tableRole(5)).toBe("invitee");
  });

  it("both sides agree without telling each other", () => {
    const a = entryForTable(opener(), FLEET)!;
    const b = entryForTable(session(), FLEET2)!;
    expect(a.game.role).toBe("challenger");
    expect(b.game.role).toBe("invitee");
    expect(a.table).toEqual({ me: 1, them: 2, spaceId: "sp1" });
    expect(b.table).toEqual({ me: 2, them: 1, spaceId: "sp1" });
    // The seals are bound to the table's id on both sides.
    expect(a.game.sid).toBe("t1");
    expect(b.game.sid).toBe("t1");
  });

  it("a saved game whose role doesn't fit its seat is not taken", () => {
    const b = entryForTable(session(), FLEET)!;
    expect(roleFitsSeat(b)).toBe(true);
    expect(roleFitsSeat({ ...b, game: { ...b.game, role: "challenger" } })).toBe(false);
    expect(roleFitsSeat({ ...b, game: { ...b.game, sid: "other" } })).toBe(false);
    expect(roleFitsSeat({ ...b, table: undefined })).toBe(true);
  });
});

describe("entryForTable", () => {
  it("starts a fresh game to place, named after the other player", () => {
    const e = entryForTable(session(), FLEET, 42)!;
    expect(e.sessionId).toBe("t1");
    expect(e.opponentName).toBe("Anna");
    expect(e.opponentIsLocal).toBe(false);
    expect(e.opponentInstanceId).toBe("");
    expect(e.game.fleet).toEqual(FLEET);
    expect(e.game.root).toBeNull();
    expect(e.game.updatedAt).toBe(42);
    expect(phase(e.game)).toBe("place");
  });

  it("an open game waits with nobody in the other seat", () => {
    const e = entryForTable(waiting(), FLEET)!;
    expect(e.table!.them).toBeNull();
    expect(e.opponentName).toBe("");
    expect(isWaitingForPlayer(e)).toBe(true);
    expect(opponentLabel(e)).toBe("Open game");
  });

  it("none for a table we don't sit at, one that ended, or one for more than two", () => {
    expect(entryForTable(session({ me: null, myState: "joining" }), FLEET)).toBeNull();
    expect(entryForTable(session({ myState: "left" }), FLEET)).toBeNull();
    expect(entryForTable(session({ state: "ended", endReason: "cancelled" }), FLEET)).toBeNull();
    expect(entryForTable(session({ max: 4 }), FLEET)).toBeNull();
  });
});

describe("routeTableMessage", () => {
  const b = entryForTable(session(), FLEET)!;

  it("takes a message from the other player's seat at our table", () => {
    expect(routeTableMessage(msg(), games(b))).toEqual({ kind: "game", entry: b });
  });

  it("drops our own seat, a third seat, and an unknown table", () => {
    expect(routeTableMessage(msg({ from: 2 }), games(b))).toEqual({ kind: "drop", reason: "not-opponent" });
    expect(routeTableMessage(msg({ from: 3 }), games(b))).toEqual({ kind: "drop", reason: "not-opponent" });
    expect(routeTableMessage(msg({ id: "t2" }), games(b))).toEqual({ kind: "drop", reason: "unknown-game" });
  });

  it("never routes to a 1:1 game with the same id, and 1:1 messages never reach a table game", () => {
    const oneToOne: GameEntry = { ...b, table: undefined };
    expect(routeTableMessage(msg(), games(oneToOne))).toEqual({ kind: "drop", reason: "unknown-game" });
    const m: AppMessage = { sessionId: "t1", fromInstance: "", fromUser: "", payload: {} };
    expect(routeInbound(m, games(b))).toEqual({ kind: "drop", reason: "not-opponent" });
  });

  it("waits for the roster before taking a message at an open game", () => {
    const a = entryForTable(waiting(), FLEET)!;
    expect(routeTableMessage(msg({ from: 2 }), games(a))).toEqual({ kind: "drop", reason: "no-opponent-yet" });
  });
});

describe("the seals over the table", () => {
  it("opener away when someone sits down: seal → seal → fire → answer, judged on both seats", () => {
    const anna = entryForTable(opener(), FLEET)!; // seat 1
    const ben = entryForTable(session(), FLEET2)!; // seat 2

    // Ben took the seat and locks in at once: his seal goes out, handing Anna the turn.
    ben.game = lockIn(ben.game, seed(2));
    expect(sealGoesOutOnLockIn(ben.game)).toBe(true);
    expect(phase(ben.game)).toBe("wait-seal");
    expect(passesTurn(ben.game)).toBe(false); // a 1:1 seal would not…
    expect(tablePassesTurn(ben.game)).toBe(true); // …at a table only "Your turn" tells Anna
    const v1 = deliver(out(ben, 2, 1), anna);
    expect(v1.kind).toBe("update");
    expect(v1.kind === "update" && v1.events.map((e) => e.type)).toEqual(["sealed"]);
    expect(v1.kind === "update" && v1.reply).toBe(false); // Anna hasn't placed her fleet yet

    // Anna places hers: her seal goes back and Ben fires first.
    anna.game = lockIn(anna.game, seed(1));
    expect(sealGoesOutOnLockIn(anna.game)).toBe(true);
    expect(phase(anna.game)).toBe("their-turn");
    expect(tablePassesTurn(anna.game)).toBe(true);
    expect(passesTurn(anna.game)).toBe(true);
    deliver(out(anna, 1, 2), ben);
    expect(phase(ben.game)).toBe("my-turn");

    // Ben fires at A1 (Anna's carrier): Anna answers "hit" with its opening.
    ben.game = fire(ben.game, 0);
    expect(tablePassesTurn(ben.game)).toBe(true);
    const v3 = deliver(out(ben, 2, 3), anna);
    expect(v3.kind === "update" && v3.events).toEqual([{ type: "fired", cell: 0, ans: "h" }]);
    expect(v3.kind === "update" && v3.reply).toBe(true);
    expect(phase(anna.game)).toBe("my-turn");

    // Anna's answer (+ her own shot) is checked against her sealed leaf on Ben's side.
    anna.game = fire(anna.game, 99);
    const v4 = deliver(out(anna, 1, 4), ben);
    expect(v4.kind === "update" && v4.events.map((e) => e.type)).toEqual(["answered", "fired"]);
    expect(hitsByMe(ben.game)).toBe(1);
  });

  it("opener locked in while waiting: their seal goes out on the seat, and the newcomer's first message fires", () => {
    const anna = entryForTable(waiting(), FLEET)!;
    anna.game = lockIn(anna.game, seed(1));
    expect(phase(anna.game)).toBe("wait-seal");
    // Someone sits down: Ben.
    expect(updateFromTable(anna, opener())).toEqual({ changed: true, joined: true });
    expect(tablePassesTurn(anna.game)).toBe(true);
    const ben = entryForTable(session(), FLEET2)!;
    const v1 = deliver(out(anna, 1, 1), ben);
    expect(v1.kind === "update" && v1.reply).toBe(false); // Ben still places his fleet
    ben.game = lockIn(ben.game, seed(2));
    expect(sealGoesOutOnLockIn(ben.game)).toBe(false); // it rides with his first shot
    expect(phase(ben.game)).toBe("my-turn");
    ben.game = fire(ben.game, 55);
    const v2 = deliver(out(ben, 2, 2), anna);
    expect(v2.kind === "update" && v2.events.map((e) => e.type)).toEqual(["sealed", "fired"]);
    expect(v2.kind === "update" && v2.events[1]).toEqual({ type: "fired", cell: 55, ans: "m" });
  });

  it("the opener can't fire first: a first shot from seat 1 is refused", () => {
    const anna = entryForTable(opener(), FLEET)!;
    const ben = entryForTable(session(), FLEET2)!;
    anna.game = lockIn(anna.game, seed(1));
    ben.game = lockIn(ben.game, seed(2));
    deliver(out(ben, 2, 1), anna);
    // A changed app on Anna's side claims the first shot.
    const forged = { ...anna.game, shots: [{ cell: 90 }], acked: true };
    const m = msg({ from: 1, data: JSON.parse(JSON.stringify(buildMessage(forged))) as unknown });
    expect(receive(ben.game, m.data, 1)).toEqual({ kind: "refuse", reason: "rewrite" });
  });

  it("a shot from a side that doesn't hold our seal voids the game (order)", () => {
    const anna = entryForTable(opener(), FLEET)!;
    const ben = entryForTable(session(), FLEET2)!;
    anna.game = lockIn(anna.game, seed(1));
    ben.game = lockIn(ben.game, seed(2));
    deliver(out(anna, 1, 1), ben); // Anna's seal reaches Ben
    // Ben's app fires with his seal but without acking Anna's: as a 1:1 game, void.
    const forged = { ...ben.game, theirRoot: null, shots: [{ cell: 0 }] };
    const v = receive(anna.game, JSON.parse(JSON.stringify(buildMessage(forged))) as unknown, 1);
    expect(v.kind === "update" && v.game.outcome).toEqual({ kind: "void", reason: "order", at: 0 });
  });

  it("a lie in an answer voids the game, as in a 1:1 game", () => {
    const anna = entryForTable(opener(), FLEET)!;
    const ben = entryForTable(session(), FLEET2)!;
    ben.game = lockIn(ben.game, seed(2));
    deliver(out(ben, 2, 1), anna);
    anna.game = lockIn(anna.game, seed(1));
    deliver(out(anna, 1, 2), ben);
    ben.game = fire(ben.game, 0);
    deliver(out(ben, 2, 3), anna);
    const m = out(anna, 1, 4);
    const data = m.data as { shots: unknown[][] };
    data.shots[0][1] = "m"; // A1 is a ship: "miss" doesn't open the sealed leaf
    const v = deliver(m, ben);
    expect(v.kind === "update" && v.game.outcome).toEqual({ kind: "void", reason: "answer", at: 0 });
  });

  it("another table's seal, other rules or another version are refused", () => {
    const anna = entryForTable(opener(), FLEET)!;
    const ben = entryForTable(session(), FLEET2)!;
    ben.game = lockIn(ben.game, seed(2));
    const good = JSON.parse(JSON.stringify(buildMessage(ben.game))) as Record<string, unknown>;
    expect(receive(anna.game, { ...good, sid: "t2" }, 1)).toEqual({ kind: "refuse", reason: "malformed" });
    expect(receive(anna.game, { ...good, rules: "salvo" }, 1)).toEqual({ kind: "unsupported" });
    expect(receive(anna.game, { ...good, v: 2 }, 1)).toEqual({ kind: "unsupported" });
  });

  it("the final message never passes the turn", () => {
    const ben = entryForTable(session(), FLEET2)!;
    ben.game = resign(lockIn(ben.game, seed(2)));
    expect(tablePassesTurn(ben.game)).toBe(false);
  });
});

describe("1:1 helpers leave table games alone", () => {
  it("an opener waiting for a seat is not an unanswered invite", () => {
    const a = entryForTable(waiting(), FLEET)!;
    a.game = lockIn(a.game, seed(1));
    expect(isAwaitingOpponent(a)).toBe(false);
    const b = entryForTable(session(), FLEET)!;
    expect(isUnansweredInvite(b)).toBe(false);
  });

  it("the lobby says the game waits for a player, then whom to play", () => {
    const a = entryForTable(waiting(), FLEET)!;
    expect(chipFor(a)).toEqual({ text: "Waiting for a player", tone: "plain" });
    expect(progressFor(a)).toContain("Open in the space");
    a.game = lockIn(a.game, seed(1));
    expect(statusFor(a).title).toBe("Waiting for someone to take the seat");
    updateFromTable(a, opener());
    expect(chipFor(a).text).toBe("Waiting for Ben");
    expect(statusFor(a).title).toBe("Waiting for Ben's fleet");
    const b = entryForTable(session(), FLEET)!;
    expect(progressFor(b)).toBe("Place your fleet to play Anna.");
  });
});

describe("updateFromTable", () => {
  it("fills the seat once and keeps it", () => {
    const a = entryForTable(waiting(), FLEET)!;
    expect(updateFromTable(a, opener())).toEqual({ changed: true, joined: true });
    expect(a.table!.them).toBe(2);
    expect(a.opponentName).toBe("Ben");
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
    const a = entryForTable(waiting(), FLEET)!;
    expect(updateFromTable(a, opener({ id: "t9" })).changed).toBe(false);
  });
});

describe("classifyTableEvent", () => {
  const ev = (e: Partial<GroupEvent> & { type: GroupEvent["type"] }): GroupEvent =>
    ({ id: "t1", session: session(), ...e }) as GroupEvent;

  it("someone taking the seat at our open game", () => {
    const a = entryForTable(waiting(), FLEET)!;
    const action = classifyTableEvent(ev({ type: "joined", seat: 2, session: opener() }), games(a));
    expect(action).toEqual({ kind: "joined", entry: a });
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

  it("the other player leaving or the table ending stops a game being played", () => {
    const b = entryForTable(session(), FLEET)!;
    expect(classifyTableEvent(ev({ type: "left", seat: 1 }), games(b))).toEqual({ kind: "gone", entry: b, reason: "left" });
    expect(classifyTableEvent(ev({ type: "removed", seat: 1 }), games(b))).toEqual({ kind: "gone", entry: b, reason: "left" });
    expect(classifyTableEvent(ev({ type: "ended" }), games(b))).toEqual({ kind: "gone", entry: b, reason: "ended" });
    expect(classifyTableEvent(ev({ type: "left", seat: 2 }), games(b))).toEqual({ kind: "mine-over", entry: b });
    expect(classifyTableEvent(ev({ type: "left", seat: 5 }), games(b))).toEqual({ kind: "ignore" });
  });

  it("a finished game stays (with its reveal) when the table ends or the other player leaves", () => {
    const b = entryForTable(session(), FLEET)!;
    b.game = resign(lockIn(b.game, seed(2)));
    expect(classifyTableEvent(ev({ type: "ended" }), games(b))).toEqual({ kind: "ignore" });
    expect(classifyTableEvent(ev({ type: "left", seat: 1 }), games(b))).toEqual({ kind: "ignore" });
  });

  it("never touches a 1:1 game, and ignores messages", () => {
    const b: GameEntry = { ...entryForTable(session(), FLEET)!, table: undefined };
    expect(classifyTableEvent(ev({ type: "ended" }), games(b))).toEqual({ kind: "ignore" });
    expect(classifyTableEvent({ type: "message", ...msg() }, games(b))).toEqual({ kind: "ignore" });
  });
});

describe("launchAction for a table", () => {
  it("Join / Play opens the table", () => {
    const s = session();
    expect(launchAction({ sessionId: "t1", group: s }, games())).toEqual({ kind: "table", session: s });
    const b = entryForTable(s, FLEET)!;
    expect(launchAction({ sessionId: "t1", group: s }, games(b))).toEqual({ kind: "table", session: s });
  });

  it("a table id naming a 1:1 game we have is refused", () => {
    const b: GameEntry = { ...entryForTable(session(), FLEET)!, table: undefined };
    expect(launchAction({ sessionId: "t1", group: session() }, games(b))).toEqual({ kind: "mismatch" });
  });

  it("an invite naming a table game is refused; Your turn without one opens it", () => {
    const b = entryForTable(session(), FLEET)!;
    const invite: AppMessage = { sessionId: "t1", fromInstance: "", fromUser: "", payload: {} };
    expect(launchAction({ sessionId: "t1", invite }, games(b))).toEqual({ kind: "mismatch" });
    expect(launchAction({ sessionId: "t1" }, games(b))).toEqual({ kind: "open", sessionId: "t1" });
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
