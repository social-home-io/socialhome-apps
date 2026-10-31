import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createClient,
  GROUP_BRIDGE,
  parseGroupEvent,
  parseGroupMessage,
  parseGroupSession,
  parseGroupSessions,
  parseLaunchContext,
  ShError,
  type GroupEvent,
  type SocialHomeClient,
} from "./index.js";

/** A fake host frame (as in index.test.ts). */
function makeHarness() {
  const posted: any[] = [];
  const parent = { postMessage: (m: unknown) => posted.push(m) } as unknown as Window;
  let handler: ((e: MessageEvent) => void) | null = null;
  const selfWin = {
    addEventListener: (_t: string, h: EventListenerOrEventListenerObject) => {
      handler = h as (e: MessageEvent) => void;
    },
    removeEventListener: () => {
      handler = null;
    },
  } as unknown as Window;
  const client = createClient(parent, selfWin);
  const fromHost = (data: unknown) => handler?.({ source: parent, data } as MessageEvent);
  const fromRogue = (data: unknown) => handler?.({ source: {} as Window, data } as MessageEvent);
  const reply = (result: unknown, i = posted.length - 1) => fromHost({ id: posted[i].id, ok: true, result });
  const refuse = (error: unknown, i = posted.length - 1) => fromHost({ id: posted[i].id, ok: false, error });
  return { posted, client, fromHost, fromRogue, reply, refuse };
}

let active: SocialHomeClient | null = null;
afterEach(() => {
  active?.destroy();
  active = null;
});

function harness() {
  const h = makeHarness();
  active = h.client;
  return h;
}

/** A table as the bridge hands it over (camelCase, app-groups.md). */
function table(over: Record<string, unknown> = {}) {
  return {
    id: "t1",
    appId: "quiz",
    state: "lobby",
    me: 1,
    myState: "seated",
    host: 1,
    isHost: true,
    min: 3,
    max: 8,
    lateJoin: false,
    seq: 0,
    note: "Bring snacks",
    players: [ANNA],
    ...over,
  };
}

const ANNA = { seat: 1, name: "Anna", household: null, isLocal: true, state: "seated" };
const BEN = { seat: 2, name: "Ben", household: "Okafor", isLocal: false, state: "seated" };
const CLEO = { seat: 3, name: "Cleo", household: "Lund", isLocal: false, state: "seated" };

function collect(client: SocialHomeClient): GroupEvent[] {
  const events: GroupEvent[] = [];
  client.group.onEvent((e) => events.push(e));
  return events;
}

const push = (h: ReturnType<typeof harness>, event: unknown) => h.fromHost({ type: "group:event", event });

describe("parseGroupSession (never trusts the shape)", () => {
  it("reads the bridge's table — seats, names, households, no usernames", () => {
    expect(parseGroupSession(table({ players: [BEN, ANNA] }))).toEqual({
      id: "t1",
      appId: "quiz",
      state: "lobby",
      me: 1,
      myState: "seated",
      host: 1,
      isHost: true,
      min: 3,
      max: 8,
      lateJoin: false,
      seq: 0,
      note: "Bring snacks",
      players: [
        { seat: 1, name: "Anna", household: null, isLocal: true, state: "seated" },
        { seat: 2, name: "Ben", household: "Okafor", isLocal: false, state: "seated" },
      ],
    });
  });

  it("reads core's snake_case view too", () => {
    const g = parseGroupSession({
      session_id: "t1", app_id: "quiz", state: "ended", end_reason: "expired", space_id: "sp1",
      me: 2, my_state: "seated", host: 1, is_host: false, min: 2, max: 4, late_join: true,
      players: [{ seat: 2, name: "Ben", household: null, is_local: true, state: "seated" }],
    });
    expect(g).toMatchObject({
      id: "t1", appId: "quiz", endReason: "expired", spaceId: "sp1", myState: "seated", lateJoin: true,
      players: [{ seat: 2, isLocal: true }],
    });
  });

  it("is undefined for anything that isn't a table", () => {
    expect(parseGroupSession(null)).toBeUndefined();
    expect(parseGroupSession("t1")).toBeUndefined();
    expect(parseGroupSession(table({ id: "a b" }))).toBeUndefined();
    expect(parseGroupSession(table({ id: "x".repeat(129) }))).toBeUndefined();
    expect(parseGroupSession(table({ state: "waiting" }))).toBeUndefined();
    expect(parseGroupSession(table({ min: 1 }))).toBeUndefined();
    expect(parseGroupSession(table({ min: 4, max: 3 }))).toBeUndefined();
    expect(parseGroupSession(table({ max: 31 }))).toBeUndefined();
    expect(parseGroupSession(table({ max: "8" }))).toBeUndefined();
  });

  it("leaves out bad players and repeated seats; reads bad optional fields as unknown", () => {
    const g = parseGroupSession(
      table({
        host: 0,
        me: "1",
        isHost: "yes",
        lateJoin: 1,
        seq: -1,
        note: "x".repeat(81),
        endReason: "finished",
        players: [
          CLEO,
          ANNA,
          { ...BEN, seat: 1 },
          { ...BEN, seat: 0 },
          { ...BEN, state: "invited" },
          { ...BEN, name: "" },
          { ...BEN, name: "x".repeat(81) },
          "Ben",
        ],
      }),
    );
    expect(g).toMatchObject({ host: null, me: null, isHost: false, lateJoin: false });
    expect(g?.seq).toBeUndefined();
    expect(g?.note).toBeUndefined();
    expect(g?.endReason).toBeUndefined(); // only for an ended table
    expect(g?.players.map((p) => p.seat)).toEqual([1, 3]);
  });

  it("parseGroupSessions drops bad rows", () => {
    expect(parseGroupSessions([table(), { id: 3 }, null])).toHaveLength(1);
    expect(parseGroupSessions({})).toEqual([]);
  });
});

describe("parseGroupMessage / parseGroupEvent", () => {
  it("reads a message (and core's session_id / from_seat spelling)", () => {
    expect(parseGroupMessage({ id: "t1", seq: 4, from: 2, data: { a: 1 }, direct: true, held: true })).toEqual({
      id: "t1", seq: 4, from: 2, data: { a: 1 }, direct: true, held: true,
    });
    expect(parseGroupMessage({ session_id: "t1", seq: 4, from_seat: 2, data: "x" })).toEqual({
      id: "t1", seq: 4, from: 2, data: "x", direct: false,
    });
  });

  it("a message without a table id, a seq or a sender seat is undefined", () => {
    expect(parseGroupMessage({ id: "t1", from: 2 })).toBeUndefined();
    expect(parseGroupMessage({ id: "t1", seq: 0, from: 2 })).toBeUndefined();
    expect(parseGroupMessage({ id: "t1", seq: 1 })).toBeUndefined();
    expect(parseGroupMessage({ seq: 1, from: 2 })).toBeUndefined();
  });

  it("reads every event type; drops unknown types and events without their table", () => {
    const session = table({ players: [ANNA, BEN] });
    expect(parseGroupEvent({ type: "message", id: "t1", seq: 1, from: 2, data: 0 })).toMatchObject({ type: "message", seq: 1 });
    for (const type of ["joined", "left", "removed"]) {
      expect(parseGroupEvent({ type, id: "t1", seat: 2, session })).toMatchObject({ type, seat: 2, session: { id: "t1" } });
    }
    for (const type of ["started", "host-changed", "ended"]) {
      expect(parseGroupEvent({ type, id: "t1", session })).toMatchObject({ type, session: { id: "t1" } });
    }
    expect(parseGroupEvent({ type: "updated", id: "t1", session })).toBeUndefined();
    expect(parseGroupEvent({ type: "joined", id: "t1", session })).toBeUndefined(); // no seat
    expect(parseGroupEvent({ type: "started", id: "t1" })).toBeUndefined(); // no table
    expect(parseGroupEvent({ type: "started", id: "t2", session })).toBeUndefined(); // another table
    expect(parseGroupEvent("started")).toBeUndefined();
  });
});

describe("context: groups and launch.group", () => {
  it("groups is true only when the host says so; undefined on an older host", async () => {
    const h = harness();
    const p1 = h.client.context();
    h.reply({ appId: "quiz", selfUserId: "u1", groups: true });
    expect((await p1).groups).toBe(true);
    const p2 = h.client.context();
    h.reply({ appId: "quiz", selfUserId: "u1" });
    expect((await p2).groups).toBeUndefined();
    const p3 = h.client.context();
    h.reply({ appId: "quiz", selfUserId: "u1", groups: "yes" });
    expect((await p3).groups).toBeUndefined();
  });

  it("Join / Play for a table hands it over as launch.group", async () => {
    const h = harness();
    const p = h.client.context();
    h.reply({ appId: "quiz", selfUserId: "u1", groups: true, launch: { sessionId: "t1", group: table() } });
    const ctx = await p;
    expect(ctx.launch?.sessionId).toBe("t1");
    expect(ctx.launch?.group).toMatchObject({ id: "t1", state: "lobby", me: 1 });
    expect(ctx.launch?.invite).toBeUndefined();
  });

  it("parseLaunchContext: a table alone sets sessionId; a table for another session is dropped", () => {
    expect(parseLaunchContext({ group: table() })?.sessionId).toBe("t1");
    expect(parseLaunchContext({ sessionId: "other", group: table() })).toEqual({ sessionId: "other" });
    expect(parseLaunchContext({ group: { id: "t1" } })).toEqual({});
  });
});

describe("sh.group calls (the bridge contract)", () => {
  it("open asks Social Home's sheet and resolves with the new table", async () => {
    const h = harness();
    const p = h.client.group.open({
      suggest: [{ instance_id: "b", user_ref: "ben", is_local: false, extra: 1 } as never],
    });
    expect(h.posted[0]).toMatchObject({
      method: "group.open",
      params: { suggest: [{ instance_id: "b", user_ref: "ben", is_local: false }] },
    });
    expect(h.posted[0].params.suggest[0]).not.toHaveProperty("extra");
    h.reply(table());
    expect(await p).toMatchObject({ id: "t1", isHost: true, state: "lobby" });
  });

  it("open resolves null when the person cancels; posts no suggest by default", async () => {
    const h = harness();
    const p = h.client.group.open();
    expect(h.posted[0]).toEqual({ id: h.posted[0].id, method: "group.open", params: {} });
    h.reply(null);
    expect(await p).toBeNull();
  });

  it("open waits for the person — no 15 s RPC timeout", async () => {
    vi.useFakeTimers();
    try {
      const h = harness();
      const p = h.client.group.open();
      vi.advanceTimersByTime(60_000);
      h.reply(null);
      await expect(p).resolves.toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it("open refuses more than 9 suggested people without asking the host", async () => {
    const h = harness();
    const ten = Array.from({ length: 10 }, (_, i) => ({ instance_id: "b", user_ref: `u${i}`, is_local: false }));
    await expect(h.client.group.open({ suggest: ten })).rejects.toMatchObject({ code: "invalid" });
    expect(h.posted).toHaveLength(0);
  });

  it("open before Social Home's group sheet: unavailable, typed", async () => {
    const h = harness();
    const p = h.client.group.open();
    h.refuse({ code: "unavailable", message: "Not yet" });
    await expect(p).rejects.toMatchObject({ code: "unavailable" });
  });

  it("a reply that isn't a table is an error, not a crash", async () => {
    const h = harness();
    const p = h.client.group.get("t1");
    h.reply({ nope: true });
    await expect(p).rejects.toBeInstanceOf(ShError);
  });

  it("list and get read tables", async () => {
    const h = harness();
    const pl = h.client.group.list();
    expect(h.posted[0]).toEqual({ id: h.posted[0].id, method: "group.list" });
    h.reply([table(), table({ id: "t2" }), "junk"]);
    expect((await pl).map((g) => g.id)).toEqual(["t1", "t2"]);
    const pg = h.client.group.get("t2");
    expect(h.posted[1]).toMatchObject({ method: "group.get", params: { id: "t2" } });
    h.reply(table({ id: "t2" }));
    expect((await pg).id).toBe("t2");
  });

  it("start, remove and close are host commands with the table id", async () => {
    const h = harness();
    const ps = h.client.group.start("t1");
    expect(h.posted[0]).toMatchObject({ method: "group.start", params: { id: "t1" } });
    h.reply(table({ state: "playing" }));
    expect((await ps).state).toBe("playing");
    const pr = h.client.group.remove("t1", 3);
    expect(h.posted[1]).toMatchObject({ method: "group.remove", params: { id: "t1", seat: 3 } });
    h.reply(table({ state: "playing" }));
    expect((await pr).state).toBe("playing");
    const pc = h.client.group.close("t1");
    expect(h.posted[2]).toMatchObject({ method: "group.close", params: { id: "t1" } });
    h.reply({ ok: true });
    await expect(pc).resolves.toBeUndefined();
  });

  it("remove refuses a seat that isn't a seat number", async () => {
    const h = harness();
    await expect(h.client.group.remove("t1", 0)).rejects.toMatchObject({ code: "invalid" });
    await expect(h.client.group.remove("t1", 1.5)).rejects.toMatchObject({ code: "invalid" });
    expect(h.posted).toHaveLength(0);
  });

  it("leave posts group.leave", async () => {
    const h = harness();
    const p = h.client.group.leave("t1");
    expect(h.posted[0]).toMatchObject({ method: "group.leave", params: { id: "t1" } });
    h.reply({ ok: true });
    await expect(p).resolves.toBeUndefined();
  });

  it("the host's refusals come back typed", async () => {
    const h = harness();
    const p = h.client.group.start("t1");
    h.refuse({ code: "group_too_few", message: "Needs 3 players" });
    await expect(p).rejects.toMatchObject({ code: "group_too_few", message: "Needs 3 players" });
    const p2 = h.client.group.send("t1", {});
    h.refuse({ code: "group_busy", message: "Busy", retryAfterMs: 2000 });
    await expect(p2).rejects.toMatchObject({ code: "group_busy", retryAfterMs: 2000 });
    const p3 = h.client.group.list();
    h.refuse({ code: "permission_denied", message: "No", permission: "people" });
    await expect(p3).rejects.toMatchObject({ code: "permission_denied", permission: "people" });
  });
});

describe("feature detection: an older Social Home", () => {
  it("every sh.group call refused unknown_method reads groups_not_supported", async () => {
    const h = harness();
    const calls: Promise<unknown>[] = [
      h.client.group.open(),
      h.client.group.list(),
      h.client.group.get("t1"),
      h.client.group.start("t1"),
      h.client.group.send("t1", {}),
      h.client.group.leave("t1"),
      h.client.group.remove("t1", 2),
      h.client.group.close("t1"),
      h.client.group.held(),
    ];
    expect(h.posted.map((m) => m.method)).toEqual([
      GROUP_BRIDGE.open, GROUP_BRIDGE.list, GROUP_BRIDGE.get, GROUP_BRIDGE.start, GROUP_BRIDGE.send,
      GROUP_BRIDGE.leave, GROUP_BRIDGE.remove, GROUP_BRIDGE.close, GROUP_BRIDGE.held,
    ]);
    h.posted.forEach((_m, i) => h.refuse({ code: "unknown_method", message: "Unknown method" }, i));
    for (const c of calls) {
      await expect(c).rejects.toMatchObject({ name: "ShError", code: "groups_not_supported" });
    }
  });

  it("an older host's string error stays a plain error", async () => {
    const h = harness();
    const p = h.client.group.list();
    h.refuse("Unknown method: group.list");
    await expect(p).rejects.toMatchObject({ code: "error" });
  });
});

describe("group.send: to everyone, to chosen seats, the turn", () => {
  it("to everyone by default; resolves with the seq when this household numbered it", async () => {
    const h = harness();
    const p = h.client.group.send("t1", { round: 1 });
    expect(h.posted[0]).toEqual({ id: h.posted[0].id, method: "group.send", params: { id: "t1", data: { round: 1 } } });
    h.reply({ seq: 41 });
    expect(await p).toBe(41);
  });

  it("to chosen seats, with the turn; null seq when the host's household numbers it", async () => {
    const h = harness();
    const p = h.client.group.send("t1", { answer: "b" }, { to: [1], turn: 1 });
    expect(h.posted[0].params).toEqual({ id: "t1", data: { answer: "b" }, to: [1], turn: 1 });
    h.reply({ seq: null });
    expect(await p).toBeNull();
  });

  it("refuses bad seats and turns without asking the host", async () => {
    const h = harness();
    for (const to of [[], [0], [1, 1], [1.5], ["2"], Array.from({ length: 30 }, (_, i) => i + 1)]) {
      await expect(h.client.group.send("t1", {}, { to: to as number[] })).rejects.toMatchObject({ code: "invalid" });
    }
    await expect(h.client.group.send("t1", {}, { turn: 0 })).rejects.toMatchObject({ code: "invalid" });
    expect(h.posted).toHaveLength(0);
  });
});

describe("events: messages with sender seat and seq, roster changes", () => {
  it("a message reaches onEvent with its seat, seq and direct flag", () => {
    const h = harness();
    const events = collect(h.client);
    push(h, { type: "message", id: "t1", seq: 41, from: 2, data: { a: 1 }, direct: true });
    expect(events).toEqual([{ type: "message", id: "t1", seq: 41, from: 2, data: { a: 1 }, direct: true }]);
  });

  it("a seq already seen is dropped", () => {
    const h = harness();
    const events = collect(h.client);
    const m = { type: "message", id: "t1", seq: 5, from: 2, data: 1 };
    push(h, m);
    push(h, m);
    push(h, { ...m, id: "t2" });
    expect(events.map((e) => (e.type === "message" ? `${e.id}:${e.seq}` : e.type))).toEqual(["t1:5", "t2:5"]);
  });

  it("joined / left / removed / started / host-changed / ended pass through with the table", () => {
    const h = harness();
    const events = collect(h.client);
    const session = table({ state: "playing", players: [ANNA, BEN, CLEO] });
    push(h, { type: "joined", id: "t1", seat: 3, session });
    push(h, { type: "started", id: "t1", session });
    push(h, { type: "left", id: "t1", seat: 1, session: { ...session, host: 2 } });
    push(h, { type: "host-changed", id: "t1", session: { ...session, host: 2 } });
    push(h, { type: "removed", id: "t1", seat: 3, session });
    push(h, { type: "ended", id: "t1", session: { ...session, state: "ended", endReason: "finished" } });
    expect(events.map((e) => e.type)).toEqual(["joined", "started", "left", "host-changed", "removed", "ended"]);
    const ended = events.at(-1);
    expect(ended && "session" in ended ? ended.session.endReason : null).toBe("finished");
  });

  it("malformed, unknown or rogue pushes are ignored; onMessage / onSession don't hear them", () => {
    const h = harness();
    const events = collect(h.client);
    const other: unknown[] = [];
    h.client.onMessage((m) => other.push(m));
    h.client.onSession((m) => other.push(m));
    push(h, { type: "message", id: "t1", from: 2 });
    push(h, { type: "updated", id: "t1", session: table() });
    h.fromHost({ type: "group:event" });
    h.fromRogue({ type: "group:event", event: { type: "message", id: "t1", seq: 1, from: 2 } });
    push(h, { type: "message", id: "t1", seq: 1, from: 2 });
    expect(events).toHaveLength(1);
    expect(other).toEqual([]);
  });

  it("a throwing subscriber doesn't stop the others; unsubscribe stops delivery", () => {
    const h = harness();
    h.client.group.onEvent(() => {
      throw new Error("boom");
    });
    const events: GroupEvent[] = [];
    const off = h.client.group.onEvent((e) => events.push(e));
    push(h, { type: "message", id: "t1", seq: 1, from: 2 });
    off();
    push(h, { type: "message", id: "t1", seq: 2, from: 2 });
    expect(events).toHaveLength(1);
  });
});

describe("held messages at tables (each player's latest)", () => {
  it("group.held types the message events, oldest seq first per table", async () => {
    const h = harness();
    const p = h.client.group.held();
    expect(h.posted[0]).toEqual({ id: h.posted[0].id, method: "group.held" });
    h.reply([
      { type: "message", id: "t1", seq: 9, from: 3, data: "c", direct: false, held: true },
      { type: "message", id: "t2", seq: 2, from: 1, data: "x", direct: false, held: true },
      { type: "message", id: "t1", seq: 7, from: 2, data: "b", direct: true, held: true },
      { type: "joined", id: "t1", seq: 8, from: 2 },
      { type: "message", id: "t1", from: 2 },
    ]);
    const msgs = await p;
    expect(msgs.map((m) => `${m.id}:${m.seq}:${m.from}`)).toEqual(["t1:7:2", "t1:9:3", "t2:2:1"]);
    expect(msgs[0]).toMatchObject({ direct: true, held: true });
  });

  it("leaves out what already came live, and a later live repeat is dropped", async () => {
    const h = harness();
    const events = collect(h.client);
    push(h, { type: "message", id: "t1", seq: 7, from: 2, data: "b" });
    const p = h.client.group.held();
    h.reply([{ type: "message", id: "t1", seq: 7, from: 2 }, { type: "message", id: "t1", seq: 9, from: 3 }]);
    expect((await p).map((m) => m.seq)).toEqual([9]);
    push(h, { type: "message", id: "t1", seq: 9, from: 3 });
    expect(events.filter((e) => e.type === "message")).toHaveLength(1);
  });

  it("a non-list reply is no messages", async () => {
    const h = harness();
    const p = h.client.group.held();
    h.reply({});
    expect(await p).toEqual([]);
  });
});
