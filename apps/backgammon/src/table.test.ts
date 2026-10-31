import { afterEach, describe, expect, it } from "vitest";
import { ShError } from "@socialhome/app-sdk";
import type { AppMessage, GroupEvent, GroupMessage, GroupSession } from "@socialhome/app-sdk";
import { toB64url } from "./dice.js";
import type { Entry, Setup } from "./game.js";
import { buildMessage } from "./inbound.js";
import type { InboundVerdict, WireMessage } from "./inbound.js";
import {
  classifySessionEvent,
  isAwaitingOpponent,
  isMyTurn,
  launchAction,
  ownSideOf,
  routeInbound,
  stateOf,
  toStored,
} from "./lifecycle.js";
import type { GameEntry } from "./lifecycle.js";
import { autoTurn, seedOf } from "./testkit.js";
import { chipFor, metaFor, opponentLabel, statusFor } from "./view.js";
import { setLocale } from "./i18n.js";
import {
  OPENER_SEAT,
  TABLE_SETUP,
  canCloseTable,
  classifyTableEvent,
  isSentAfterFinish,
  tableSendOptions,
  entryForTable,
  handsTurn,
  hasTableSetup,
  isWaitingForPlayer,
  judgeGame,
  opensTable,
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
    appId: "backgammon",
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

/** The joiner (seat 2) and the opener (seat 1) at the same table. */
function pair(joinerSeed = 1, openerSeed = 2): { a: GameEntry; b: GameEntry; openerSeed: Uint8Array } {
  return { a: entryForTable(opener(), seedOf(99))!, b: entryForTable(session(), seedOf(joinerSeed))!, openerSeed: seedOf(openerSeed) };
}

/** What the app sends: the whole game, and the seat it hands the turn (main.ts `sendState`). */
function send(entry: GameEntry): { data: WireMessage; turn: number | undefined } {
  return { data: buildMessage(ownSideOf(entry)!), turn: handsTurn(entry) ? (entry.table!.them ?? undefined) : undefined };
}

/**
 * Deliver *data* from *from* to *to* the way main.ts does: routed by table and
 * seat only, judged by the same judge, the verdict taken into the game.
 */
function deliver(from: GameEntry, to: GameEntry, data: unknown, newSeed: Uint8Array = seedOf(7)): InboundVerdict {
  const route = routeTableMessage(msg({ id: from.sessionId, from: from.table!.me, data }), games(to));
  if (route.kind !== "game") throw new Error(`dropped: ${route.reason}`);
  const v = judgeGame(route.entry, JSON.parse(JSON.stringify(data)));
  if (v.kind === "invite") {
    to.setup = v.setup;
    to.myColor = v.myColor;
    to.theirTip = toB64url(v.theirTip);
    to.seed = toB64url(newSeed);
    to.heard = true;
  } else if (v.kind === "apply") {
    to.setup = v.setup;
    to.myColor = v.myColor;
    to.theirTip = toB64url(v.theirTip);
    to.theirShown = v.theirShown ? { n: v.theirShown.n, link: toB64url(v.theirShown.link) } : null;
    to.log = v.log;
    to.heard = true;
  }
  return v;
}

const play = (entry: GameEntry, e: Entry): void => {
  entry.log = [...entry.log, e];
};

/** A message with our own side changed (a tampered app). */
const tampered = (entry: GameEntry, over: { setup?: Setup; myColor?: "w" | "b" }): WireMessage =>
  buildMessage({ ...ownSideOf(entry)!, ...over });

describe("seats → roles and colours", () => {
  it("the opener is the invitee and plays White; whoever takes the seat invites and plays Black", () => {
    expect(OPENER_SEAT).toBe(1);
    expect(tableColor(1)).toBe("w");
    expect(tableColor(2)).toBe("b");
    expect(tableColor(5)).toBe("b");
    expect(tableRole(1)).toBe("invitee");
    expect(tableRole(2)).toBe("inviter");
    expect(TABLE_SETUP.inviter).toBe(tableColor(2));
  });

  it("both sides agree without telling each other", () => {
    const { a, b } = pair();
    expect([a.role, a.myColor, a.setup, a.seed]).toEqual(["invitee", null, null, null]);
    expect([b.role, b.myColor, b.setup]).toEqual(["inviter", "b", TABLE_SETUP]);
    expect(b.seed).toBe(toB64url(seedOf(1)));
    expect(a.table).toEqual({ me: 1, them: 2, spaceId: "sp1" });
    expect(b.table).toEqual({ me: 2, them: 1, spaceId: "sp1" });
  });

  it("the player who sat down commits at once and hands the opener the turn", () => {
    const { a, b } = pair();
    expect(opensTable(b)).toBe(true);
    expect(opensTable(a)).toBe(false);
    const first = send(b);
    expect(first.turn).toBe(1);
    expect(Object.keys(first.data.tips)).toEqual(["b"]);
    expect(first.data.shown).toBeUndefined();
    // Never an "invite sent" with Cancel: there is no invite at a table.
    expect(isAwaitingOpponent(b)).toBe(false);
    // A 1:1 inviter's first message hands nobody the turn (the invite sits in Needs you).
    expect(opensTable({ ...b, table: undefined })).toBe(false);
    expect(handsTurn({ ...b, table: undefined })).toBe(false);
  });
});

describe("entryForTable", () => {
  it("the fixed setup: the New-game defaults (doubling cube, no clock), never the lobby's choices", () => {
    expect(TABLE_SETUP).toEqual({ inviter: "b", cube: true, days: 0 });
    const { a, b } = pair();
    for (const e of [a, b]) {
      expect(e.log).toEqual([]);
      expect(hasTableSetup(e)).toBe(true);
    }
    expect(entryForTable(session(), seedOf(1), 42)!.updatedAt).toBe(42);
    expect(metaFor(a)).toBe("White · Doubling cube");
  });

  it("is named after the other player", () => {
    const b = entryForTable(session(), seedOf(1))!;
    expect(b.opponentName).toBe("Anna");
    expect(b.opponentIsLocal).toBe(false);
    expect(b.sessionId).toBe("t1");
  });

  it("an open game waits with nobody in the other seat, and never shows as an invite", () => {
    const e = entryForTable(waiting(), seedOf(1))!;
    expect(e.table!.them).toBeNull();
    expect(e.opponentName).toBe("");
    expect(isWaitingForPlayer(e)).toBe(true);
    expect(canCloseTable(e)).toBe(true);
    expect(isAwaitingOpponent(e)).toBe(false);
    expect(isMyTurn(e)).toBe(false);
    expect(opponentLabel(e)).toBe("Open game");
    expect(chipFor(e).text).toBe("Waiting for a player");
    expect(statusFor(e).title).toBe("Waiting for someone to take the seat");
    // Only the opener closes it; nobody can while someone sits there.
    const { a, b } = pair();
    expect(canCloseTable(a)).toBe(false);
    expect(canCloseTable(b)).toBe(false);
  });

  it("says what the player who sat down waits for", () => {
    const b = entryForTable(session(), seedOf(1))!;
    expect(statusFor(b).detail).toContain("Anna's Backgammon answers");
  });

  it("none for a table we don't sit at, one that ended, or one for more than two", () => {
    expect(entryForTable(session({ me: null, myState: "joining" }), seedOf(1))).toBeNull();
    expect(entryForTable(session({ myState: "left" }), seedOf(1))).toBeNull();
    expect(entryForTable(session({ state: "ended", endReason: "cancelled" }), seedOf(1))).toBeNull();
    expect(entryForTable(session({ max: 4 }), seedOf(1))).toBeNull();
  });
});

describe("the opening over the table: dice commit/reveal through the first move", () => {
  for (let i = 1; i <= 8; i++) {
    it(`seeds ${i}/${i + 20}: both sides reach the same game, and the turn goes where the next step is owed`, () => {
      const { a, b } = pair(i, i + 20);
      // 1. The player who sat down commits (tip only) and hands the opener the turn.
      const m1 = send(b);
      expect(m1.turn).toBe(1);
      const v1 = deliver(b, a, m1.data, seedOf(i + 20));
      expect(v1.kind).toBe("invite");
      expect([a.myColor, a.setup]).toEqual(["w", TABLE_SETUP]);
      expect(hasTableSetup(a)).toBe(true);
      // 2. The opener's app answers by itself: its tip and link 1, handing the turn back.
      const m2 = send(a);
      expect(m2.data.shown?.n).toBe(1);
      expect(m2.turn).toBe(2);
      const v2 = deliver(a, b, m2.data);
      expect(v2).toMatchObject({ kind: "apply", accepted: true });
      expect(opensTable(b)).toBe(false);
      // 3. Only the player who sat down knows the opening roll yet.
      const sb = stateOf(b)!;
      expect(sb.opening).not.toBeNull();
      expect(stateOf(a)!.opening).toBeNull();
      if (sb.opening!.starter === "b") {
        // They won it and play it at once; the opener gets the turn.
        expect(isMyTurn(b)).toBe(true);
        play(b, autoTurn(sb));
        const m3 = send(b);
        expect(m3.turn).toBe(1);
        expect(deliver(b, a, m3.data)).toMatchObject({ kind: "apply" });
      } else {
        // The opener won: the joiner's app shows link 1 ("open") and the opener plays it.
        play(b, "open");
        const m3 = send(b);
        expect(m3.turn).toBe(1);
        expect(deliver(b, a, m3.data)).toMatchObject({ kind: "apply" });
        const sa = stateOf(a)!;
        expect(isMyTurn(a)).toBe(true);
        expect(sa.roll).toEqual([sa.opening!.w, sa.opening!.b]);
        play(a, autoTurn(sa));
        const m4 = send(a);
        expect(m4.turn).toBe(2);
        expect(deliver(a, b, m4.data)).toMatchObject({ kind: "apply" });
      }
      // Both copies replay to the same board, opening and next step.
      const fa = stateOf(a)!;
      const fb = stateOf(b)!;
      expect(fa.board).toEqual(fb.board);
      expect(fa.opening).toEqual(fb.opening);
      expect([fa.turn, fa.toMove, fa.phase]).toEqual([fb.turn, fb.toMove, fb.phase]);
      expect(a.log).toEqual(b.log);
    });
  }

  it("covers both opening winners across the seeds above", () => {
    const starters = new Set<string>();
    for (let i = 1; i <= 8; i++) {
      const { a, b } = pair(i, i + 20);
      deliver(b, a, send(b).data, seedOf(i + 20));
      deliver(a, b, send(a).data);
      starters.add(stateOf(b)!.opening!.starter);
    }
    expect([...starters].sort()).toEqual(["b", "w"]);
  });
});

describe("the judge at a table refuses a tampered setup", () => {
  it("the opener refuses a first message with another cube, a clock or swapped colours", () => {
    const { a, b } = pair();
    expect(judgeGame(a, tampered(b, { setup: { ...TABLE_SETUP, cube: false } }))).toEqual({ kind: "refuse", reason: "setup" });
    expect(judgeGame(a, tampered(b, { setup: { ...TABLE_SETUP, days: 1 } }))).toEqual({ kind: "refuse", reason: "setup" });
    // "You play Black": the joiner claims White (the opener's colour).
    expect(judgeGame(a, tampered(b, { myColor: "w", setup: { ...TABLE_SETUP, inviter: "w" } }))).toEqual({ kind: "refuse", reason: "setup" });
    // The honest message passes the same judge.
    expect(judgeGame(a, send(b).data).kind).toBe("invite");
  });

  it("a 1:1 invitee takes any setup the inviter chose (unchanged)", () => {
    const { a, b } = pair();
    const oneToOne: GameEntry = { ...a, table: undefined };
    expect(judgeGame(oneToOne, tampered(b, { setup: { ...TABLE_SETUP, cube: false } })).kind).toBe("invite");
  });

  it("after the handshake either side refuses a message whose setup differs", () => {
    const { a, b } = pair();
    deliver(b, a, send(b).data);
    deliver(a, b, send(a).data);
    expect(judgeGame(a, tampered(b, { setup: { ...TABLE_SETUP, cube: false } }))).toEqual({ kind: "refuse", reason: "setup" });
    expect(judgeGame(b, tampered(a, { setup: { ...TABLE_SETUP, days: 2 } }))).toEqual({ kind: "refuse", reason: "setup" });
  });

  it("a message acting as the other role is refused", () => {
    const { a, b } = pair();
    // The opener's app can't commit first: the player who sat down never takes a tip-only "invite".
    const fakeInvite = buildMessage({ setup: TABLE_SETUP, myColor: "w", myTip: seedOf(5), theirTip: null, shown: null, log: [] });
    expect(judgeGame(b, fakeInvite).kind).toBe("refuse");
    // After the handshake, a step played for us (the player who sat down) is refused.
    deliver(b, a, send(b).data);
    deliver(a, b, send(a).data);
    const st = stateOf(b)!;
    const ours: Entry = st.opening!.starter === "b" ? autoTurn(st) : "open";
    const forged = buildMessage({ ...ownSideOf(a)!, log: [ours] });
    expect(judgeGame(b, forged)).toMatchObject({ kind: "refuse" });
  });
});

describe("routeTableMessage", () => {
  const b = entryForTable(session(), seedOf(1))!;

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

  it("waits for the roster before taking a message at an open game", () => {
    const a = entryForTable(waiting(), seedOf(1))!;
    expect(routeTableMessage(msg({ from: 2 }), games(a))).toEqual({ kind: "drop", reason: "no-opponent-yet" });
  });

  it("a 1:1 message or session event never reaches a table game", () => {
    const m: AppMessage = { sessionId: "t1", fromInstance: "", fromUser: "", payload: send(b).data };
    expect(routeInbound(m, games(b))).toEqual({ kind: "drop", reason: "unknown-game" });
    const close: AppMessage = { sessionId: "t1", fromInstance: "", payload: { verb: "close", reason: "ended" } };
    expect(classifySessionEvent(close, games(b))).toEqual({ kind: "ignore" });
  });
});

describe("updateFromTable", () => {
  it("fills the seat once and keeps it", () => {
    const a = entryForTable(waiting(), seedOf(1))!;
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
    const a = entryForTable(waiting(), seedOf(1))!;
    expect(updateFromTable(a, opener({ id: "t9" })).changed).toBe(false);
  });
});

describe("classifyTableEvent", () => {
  const ev = (e: Partial<GroupEvent> & { type: GroupEvent["type"] }): GroupEvent =>
    ({ id: "t1", session: session(), ...e }) as GroupEvent;

  it("someone taking the seat at our open game", () => {
    const a = entryForTable(waiting(), seedOf(1))!;
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
    const b = entryForTable(session(), seedOf(1))!;
    expect(classifyTableEvent(ev({ type: "left", seat: 1 }), games(b))).toEqual({ kind: "gone", entry: b, reason: "left" });
    expect(classifyTableEvent(ev({ type: "removed", seat: 1 }), games(b))).toEqual({ kind: "gone", entry: b, reason: "left" });
    expect(classifyTableEvent(ev({ type: "ended" }), games(b))).toEqual({ kind: "gone", entry: b, reason: "ended" });
    // Ended by the game's last message: that message is on its way (or held).
    const finished = session({ state: "ended", endReason: "finished" });
    expect(classifyTableEvent(ev({ type: "ended", session: finished }), games(b))).toEqual({ kind: "ignore" });
    expect(classifyTableEvent(ev({ type: "left", seat: 2 }), games(b))).toEqual({ kind: "mine-over", entry: b });
    expect(classifyTableEvent(ev({ type: "left", seat: 5 }), games(b))).toEqual({ kind: "ignore" });
  });

  it("a finished game stays when the table ends or the other player leaves", () => {
    const { a, b } = pair();
    deliver(b, a, send(b).data);
    deliver(a, b, send(a).data);
    b.log = ["resign-b"];
    expect(stateOf(b)!.phase).toBe("over");
    expect(classifyTableEvent(ev({ type: "ended" }), games(b))).toEqual({ kind: "ignore" });
    expect(classifyTableEvent(ev({ type: "left", seat: 1 }), games(b))).toEqual({ kind: "ignore" });
  });

  it("never touches a 1:1 game, and ignores messages", () => {
    const b: GameEntry = { ...entryForTable(session(), seedOf(1))!, table: undefined };
    expect(classifyTableEvent(ev({ type: "ended" }), games(b))).toEqual({ kind: "ignore" });
    expect(classifyTableEvent({ type: "message", ...msg() }, games(b))).toEqual({ kind: "ignore" });
  });
});

describe("launchAction for a table", () => {
  it("Join / Play opens the table", () => {
    const s = session();
    expect(launchAction({ sessionId: "t1", group: s }, games())).toEqual({ kind: "table", session: s });
    expect(launchAction({ sessionId: "t1", group: s }, games(entryForTable(s, seedOf(1))!))).toEqual({ kind: "table", session: s });
  });

  it("a table id naming a 1:1 game we have is refused, and an invite never names a table game", () => {
    const b: GameEntry = { ...entryForTable(session(), seedOf(1))!, table: undefined };
    expect(launchAction({ sessionId: "t1", group: session() }, games(b))).toEqual({ kind: "mismatch" });
    const invite: AppMessage = { sessionId: "t1", fromInstance: "", payload: {} };
    expect(launchAction({ sessionId: "t1", invite }, games(entryForTable(session(), seedOf(1))!))).toEqual({ kind: "mismatch" });
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
  const roundTrip = (e: GameEntry): Record<string, unknown> => JSON.parse(JSON.stringify(toStored(e)));

  it("reads table games back with their seat (waiting, mid-handshake, played), and a 1:1 game as before", () => {
    const { a, b } = pair();
    expect(parseSavedGame(roundTrip(entryForTable(waiting(), seedOf(1))!))).toMatchObject({ table: { me: 1, them: null } });
    expect(parseSavedGame(roundTrip(b))).toMatchObject({ table: { me: 2, them: 1, spaceId: "sp1" }, myColor: "b", setup: TABLE_SETUP });
    deliver(b, a, send(b).data);
    deliver(a, b, send(a).data);
    expect(parseSavedGame(roundTrip(a))).toMatchObject({ table: { me: 1, them: 2 }, myColor: "w", role: "invitee" });
    const oneToOne = roundTrip(b);
    delete oneToOne["table"];
    expect(parseSavedGame(oneToOne)?.table).toBeUndefined();
  });

  it("drops a table game whose setup doesn't follow from its seat", () => {
    const { a, b } = pair();
    const bad = (e: GameEntry, over: Record<string, unknown>) => parseSavedGame({ ...roundTrip(e), ...over });
    expect(bad(b, { setup: { ...TABLE_SETUP, cube: false } })).toBeNull();
    expect(bad(b, { setup: { ...TABLE_SETUP, days: 1 } })).toBeNull();
    expect(bad(b, { setup: { ...TABLE_SETUP, inviter: "w" }, myColor: "w" })).toBeNull();
    expect(bad(b, { role: "invitee" })).toBeNull();
    expect(bad(b, { table: { me: 2, them: 2 } })).toBeNull();
    expect(bad(b, { table: "t1" })).toBeNull();
    // The opener before the first message: nothing of its own yet.
    expect(bad(a, { role: "inviter" })).toBeNull();
    expect(bad(a, { seed: toB64url(seedOf(3)) })).toBeNull();
    expect(bad(a, { setup: TABLE_SETUP, myColor: "b", seed: toB64url(seedOf(3)) })).toBeNull();
    expect(bad(a, { setup: TABLE_SETUP, myColor: "w", seed: toB64url(seedOf(3)) })).not.toBeNull();
  });
});

describe("the game's last message ends the table", () => {
  it("final on the message that ends the game, the turn when it passes", () => {
    expect(tableSendOptions(2, true, false)).toEqual({ turn: 2 });
    expect(tableSendOptions(2, false, false)).toEqual({});
    expect(tableSendOptions(1, false, true)).toEqual({ final: true });
  });

  it("a finished game's send refused because the table ended needs no retry", () => {
    expect(isSentAfterFinish(new ShError("group_closed", "x"), true)).toBe(true);
    expect(isSentAfterFinish(new ShError("group_closed", "x"), false)).toBe(false);
    expect(isSentAfterFinish(new ShError("group_busy", "x"), true)).toBe(false);
  });
});
