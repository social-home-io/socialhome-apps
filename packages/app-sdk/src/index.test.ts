import { afterEach, describe, expect, it, vi } from "vitest";
import { createClient, parseHeldMessages, parseLaunchContext, parsePicked, parseSessionPayload, ShError, toShError, type SocialHomeClient, type Contact, type SessionTarget, type AppMessage } from "./index.js";

/**
 * A fake host frame: captures messages posted by the SDK and lets the test
 * drive replies/events back through the SDK's `message` listener.
 */
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
  const fromRogue = (data: unknown) =>
    handler?.({ source: {} as Window, data } as MessageEvent);

  return { posted, client, fromHost, fromRogue };
}

let active: SocialHomeClient | null = null;
afterEach(() => {
  active?.destroy();
  active = null;
});

describe("RPC calls", () => {
  it("store.set posts the right envelope and resolves on a matching ok reply", async () => {
    const h = makeHarness();
    active = h.client;
    const p = h.client.store.set("game:1", { turn: "w" });
    expect(h.posted).toHaveLength(1);
    expect(h.posted[0]).toMatchObject({
      method: "store.set",
      params: { key: "game:1", value: { turn: "w" } },
    });
    h.fromHost({ id: h.posted[0].id, ok: true, result: { ok: true } });
    await expect(p).resolves.toBeUndefined();
  });

  it("store.get resolves the result value", async () => {
    const h = makeHarness();
    active = h.client;
    const p = h.client.store.get("k");
    h.fromHost({ id: h.posted[0].id, ok: true, result: { v: 1 } });
    await expect(p).resolves.toEqual({ v: 1 });
  });

  it("a {ok:false,error} reply rejects with the error message", async () => {
    const h = makeHarness();
    active = h.client;
    const p = h.client.store.get("k");
    h.fromHost({ id: h.posted[0].id, ok: false, error: "boom" });
    await expect(p).rejects.toThrow("boom");
  });

  it("openSession resolves the session id string", async () => {
    const h = makeHarness();
    active = h.client;
    const target: SessionTarget = { instance_id: "peerB", user_ref: "alice", is_local: false };
    const p = h.client.federation.openSession(target);
    expect(h.posted[0]).toMatchObject({
      method: "app.openSession",
      params: { target: { instance_id: "peerB", user_ref: "alice", is_local: false } },
    });
    h.fromHost({ id: h.posted[0].id, ok: true, result: "sess-123" });
    await expect(p).resolves.toBe("sess-123");
  });

  it("federation.send posts session_id/target/payload", () => {
    const h = makeHarness();
    active = h.client;
    const target: SessionTarget = { instance_id: "peerB", user_ref: "alice", is_local: false };
    void h.client.federation.send("sess-1", target, { move: "e4" }).catch(() => {});
    expect(h.posted[0]).toMatchObject({
      method: "app.send",
      params: {
        session_id: "sess-1",
        target: { instance_id: "peerB", user_ref: "alice", is_local: false },
        payload: { move: "e4" },
      },
    });
  });

  it("context() returns identity without a token", async () => {
    const h = makeHarness();
    active = h.client;
    const p = h.client.context();
    h.fromHost({ id: h.posted[0].id, ok: true, result: { appId: "chess", selfUserId: "u1" } });
    const ctx = await p;
    expect(ctx).toEqual({ appId: "chess", selfUserId: "u1" });
    expect("token" in (ctx as object)).toBe(false);
  });

  it("context() from an older host has no launch (fall back to pendingSessions)", async () => {
    const h = makeHarness();
    active = h.client;
    const p = h.client.context();
    h.fromHost({ id: h.posted[0].id, ok: true, result: { appId: "chess", selfUserId: "u1" } });
    expect((await p).launch).toBeUndefined();
  });
  it("ignores replies from a rogue source", async () => {
    const h = makeHarness();
    active = h.client;
    const p = h.client.store.get("k");
    h.fromRogue({ id: h.posted[0].id, ok: true, result: "evil" });
    h.fromHost({ id: h.posted[0].id, ok: true, result: "ok" });
    await expect(p).resolves.toBe("ok");
  });
});

describe("real-time events", () => {
  it("onMessage receives {sessionId, fromInstance, payload} for kind=message", () => {
    const h = makeHarness();
    active = h.client;
    const cb = vi.fn();
    h.client.onMessage(cb);
    h.fromHost({
      type: "app:event",
      kind: "message",
      sessionId: "sess-1",
      fromInstance: "peerB",
      payload: { move: "e4" },
    });
    expect(cb).toHaveBeenCalledWith({
      sessionId: "sess-1",
      fromInstance: "peerB",
      payload: { move: "e4" },
    });
  });

  it("onSession receives session (invite) events, not onMessage", () => {
    const h = makeHarness();
    active = h.client;
    const onMsg = vi.fn();
    const onSess = vi.fn();
    h.client.onMessage(onMsg);
    h.client.onSession(onSess);
    h.fromHost({
      type: "app:event",
      kind: "session",
      sessionId: "sess-9",
      fromInstance: "peerC",
      payload: { verb: "open" },
    });
    expect(onSess).toHaveBeenCalledWith({
      sessionId: "sess-9",
      fromInstance: "peerC",
      payload: { verb: "open" },
    });
    expect(onMsg).not.toHaveBeenCalled();
  });

  it("unsubscribe stops delivery", () => {
    const h = makeHarness();
    active = h.client;
    const cb = vi.fn();
    const off = h.client.onMessage(cb);
    off();
    h.fromHost({ type: "app:event", kind: "message", sessionId: "s", fromInstance: "p", payload: 1 });
    expect(cb).not.toHaveBeenCalled();
  });

  it("ignores app:event from a rogue source", () => {
    const h = makeHarness();
    active = h.client;
    const cb = vi.fn();
    h.client.onMessage(cb);
    h.fromRogue({ type: "app:event", kind: "message", sessionId: "s", fromInstance: "p", payload: 1 });
    expect(cb).not.toHaveBeenCalled();
  });

  it("a throwing subscriber does not break the loop", () => {
    const h = makeHarness();
    active = h.client;
    const bad = vi.fn(() => {
      throw new Error("nope");
    });
    const good = vi.fn();
    h.client.onMessage(bad);
    h.client.onMessage(good);
    h.fromHost({ type: "app:event", kind: "message", sessionId: "s", fromInstance: "p", payload: 1 });
    expect(good).toHaveBeenCalled();
  });

  it("app:event surfaces fromUser when host includes it", () => {
    const h = makeHarness();
    active = h.client;
    const cb = vi.fn();
    h.client.onMessage(cb);
    h.fromHost({
      type: "app:event",
      kind: "message",
      sessionId: "sess-1",
      fromInstance: "peerB",
      fromUser: "alice",
      payload: { move: "e4" },
    });
    expect(cb).toHaveBeenCalledWith({
      sessionId: "sess-1",
      fromInstance: "peerB",
      fromUser: "alice",
      payload: { move: "e4" },
    });
  });

  it("app:event leaves fromUser undefined when host omits it", () => {
    const h = makeHarness();
    active = h.client;
    const cb = vi.fn();
    h.client.onMessage(cb);
    h.fromHost({
      type: "app:event",
      kind: "message",
      sessionId: "sess-2",
      fromInstance: "peerC",
      payload: { move: "d4" },
    });
    const received = cb.mock.calls[0][0];
    expect(received.fromUser).toBeUndefined();
  });
});

describe("contacts", () => {
  it("contacts() calls contacts.list and returns the Contact array", async () => {
    const h = makeHarness();
    active = h.client;
    const fakeContacts: Contact[] = [
      { instance_id: "home", user_ref: "alice", display_name: "Alice", is_local: true, online: true },
      { instance_id: "peerB", user_ref: "bob", display_name: "Bob", is_local: false, online: false },
    ];
    const p = h.client.contacts();
    expect(h.posted[0]).toMatchObject({ method: "contacts.list" });
    h.fromHost({ id: h.posted[0].id, ok: true, result: fakeContacts });
    const result = await p;
    expect(result).toEqual(fakeContacts);
    // Verify Contact shape
    expect(result[0]).toMatchObject<Contact>({
      instance_id: "home",
      user_ref: "alice",
      display_name: "Alice",
      is_local: true,
      online: true,
    });
  });

  it("contacts() returns empty array when host replies with non-array", async () => {
    const h = makeHarness();
    active = h.client;
    const p = h.client.contacts();
    h.fromHost({ id: h.posted[0].id, ok: true, result: null });
    await expect(p).resolves.toEqual([]);
  });
});

describe("pendingSessions", () => {
  it("posts app.pendingSessions (no params) and maps snake_case rows to AppMessage", async () => {
    const h = makeHarness();
    active = h.client;
    const p = h.client.federation.pendingSessions();
    expect(h.posted[0]).toMatchObject({ method: "app.pendingSessions" });
    expect("params" in h.posted[0]).toBe(false);
    h.fromHost({
      id: h.posted[0].id,
      ok: true,
      result: [
        { session_id: "s1", from_instance: "i1", from_user: "u1", payload: { verb: "open" } },
      ],
    });
    const result = await p;
    expect(result).toEqual<AppMessage[]>([
      { sessionId: "s1", fromInstance: "i1", fromUser: "u1", payload: { verb: "open" } },
    ]);
  });

  it("maps from_user: null to fromUser: undefined", async () => {
    const h = makeHarness();
    active = h.client;
    const p = h.client.federation.pendingSessions();
    h.fromHost({
      id: h.posted[0].id,
      ok: true,
      result: [{ session_id: "s2", from_instance: "i2", from_user: null, payload: { verb: "open" } }],
    });
    const result = await p;
    expect(result[0].fromUser).toBeUndefined();
    expect(result[0]).toEqual<AppMessage>({
      sessionId: "s2",
      fromInstance: "i2",
      payload: { verb: "open" },
    });
  });

  it("returns empty array when host replies with a non-array result", async () => {
    const h = makeHarness();
    active = h.client;
    const p = h.client.federation.pendingSessions();
    h.fromHost({ id: h.posted[0].id, ok: true, result: null });
    await expect(p).resolves.toEqual([]);
  });
});

describe("cancelSession", () => {
  const target: SessionTarget = { instance_id: "inst-b", user_ref: "bob", is_local: false };

  it("posts app.cancelSession with {sessionId, target} and resolves to undefined", async () => {
    const h = makeHarness();
    active = h.client;
    const p = h.client.federation.cancelSession("s1", target);
    expect(h.posted[0]).toMatchObject({
      method: "app.cancelSession",
      params: { sessionId: "s1", target },
    });
    h.fromHost({ id: h.posted[0].id, ok: true, result: { ok: true } });
    await expect(p).resolves.toBeUndefined();
  });

  it("rejects when the host refuses (e.g. an older host without the method)", async () => {
    const h = makeHarness();
    active = h.client;
    const p = h.client.federation.cancelSession("s1", target);
    h.fromHost({ id: h.posted[0].id, ok: false, error: "Unknown method: app.cancelSession" });
    await expect(p).rejects.toThrow("Unknown method");
  });
});

describe("session close events", () => {
  it("a {verb:'close', reason} session event reaches onSession subscribers", () => {
    const h = makeHarness();
    active = h.client;
    const seen: AppMessage[] = [];
    h.client.onSession((m) => seen.push(m));
    h.fromHost({
      type: "app:event",
      kind: "session",
      sessionId: "s1",
      fromInstance: "inst-a",
      fromUser: "alice",
      payload: { verb: "close", reason: "declined" },
    });
    expect(seen).toHaveLength(1);
    expect(parseSessionPayload(seen[0].payload)).toEqual({ verb: "close", reason: "declined" });
  });
});

describe("parseSessionPayload", () => {
  it("reads verb and reason", () => {
    expect(parseSessionPayload({ verb: "close", reason: "withdrawn", app_id: "chess" })).toEqual({
      verb: "close",
      reason: "withdrawn",
    });
  });

  it("an open has no reason", () => {
    expect(parseSessionPayload({ verb: "open" })).toEqual({ verb: "open", reason: undefined });
  });

  it("tolerates non-objects and non-string fields", () => {
    expect(parseSessionPayload(null)).toEqual({});
    expect(parseSessionPayload("close")).toEqual({});
    expect(parseSessionPayload({ verb: 1, reason: { x: 1 } })).toEqual({
      verb: undefined,
      reason: undefined,
    });
  });
});

describe("launch context (Play opens the game you were invited to)", () => {
  async function contextWith(launch: unknown) {
    const h = makeHarness();
    active = h.client;
    const p = h.client.context();
    h.fromHost({ id: h.posted[0].id, ok: true, result: { appId: "chess", selfUserId: "u1", launch } });
    return p;
  }

  it("opened normally: an empty launch — a host that plays invites from Needs you", async () => {
    expect(await contextWith({})).toEqual({ appId: "chess", selfUserId: "u1", launch: {} });
  });

  it("opened by Play: the session and the invite it accepted, typed", async () => {
    const ctx = await contextWith({
      sessionId: "s1",
      invite: { sessionId: "s1", fromInstance: "peer", fromUser: "alice", payload: { verb: "open" } },
    });
    expect(ctx.launch).toEqual({
      sessionId: "s1",
      invite: { sessionId: "s1", fromInstance: "peer", fromUser: "alice", payload: { verb: "open" } },
    });
  });

  it("opened by Play for an invite that no longer waits: the session only", async () => {
    expect((await contextWith({ sessionId: "s1" })).launch).toEqual({ sessionId: "s1" });
  });

  it("never trusts the shape", () => {
    expect(parseLaunchContext(undefined)).toBeUndefined();
    expect(parseLaunchContext("x")).toBeUndefined();
    expect(parseLaunchContext({ sessionId: 7 })).toEqual({});
    // An invite for another session than the launch's is dropped.
    expect(parseLaunchContext({ sessionId: "s1", invite: { sessionId: "s2" } })).toEqual({ sessionId: "s1" });
    // An invite without a session is dropped.
    expect(parseLaunchContext({ invite: { sessionId: "s1" } })).toEqual({});
    const l = parseLaunchContext({ sessionId: "s1", invite: { sessionId: "s1", fromInstance: 3, fromUser: 4 } });
    expect(l?.invite).toEqual({ sessionId: "s1", fromInstance: "3", fromUser: undefined, payload: undefined });
  });
});

describe("held messages (moves and declines wait while the app is closed)", () => {
  it("context() asks to pull held messages only when told to", () => {
    const h = makeHarness();
    active = h.client;
    h.client.context().catch(() => {});
    h.client.context({ pullHeld: true }).catch(() => {});
    expect(h.posted[0]).toEqual({ id: h.posted[0].id, method: "app.context" });
    expect(h.posted[1]).toMatchObject({ method: "app.context", params: { held: "pull" } });
  });

  it("federation.held() posts app.held and types each row, latest per session", async () => {
    const h = makeHarness();
    active = h.client;
    const p = h.client.federation.held();
    expect(h.posted[0]).toMatchObject({ method: "app.held" });
    h.fromHost({
      id: h.posted[0].id,
      ok: true,
      result: [
        { kind: "message", sessionId: "g1", fromInstance: "peer", fromUser: "alice", payload: { n: 2 } },
        { kind: "session", sessionId: "g2", fromInstance: "peer", payload: { verb: "close", reason: "declined" } },
      ],
    });
    expect(await p).toEqual([
      { kind: "message", sessionId: "g1", fromInstance: "peer", fromUser: "alice", payload: { n: 2 } },
      { kind: "session", sessionId: "g2", fromInstance: "peer", fromUser: undefined, payload: { verb: "close", reason: "declined" } },
    ]);
  });

  it("an older host rejects app.held", async () => {
    const h = makeHarness();
    active = h.client;
    const p = h.client.federation.held();
    h.fromHost({ id: h.posted[0].id, ok: false, error: "Unknown method: app.held" });
    await expect(p).rejects.toThrow();
  });

  it("never trusts the shape", () => {
    expect(parseHeldMessages(undefined)).toEqual([]);
    expect(parseHeldMessages([null, 3, { kind: "message" }, { sessionId: "" }])).toEqual([]);
    expect(parseHeldMessages([{ sessionId: "s", kind: "weird" }])).toEqual([
      { sessionId: "s", fromInstance: "", fromUser: undefined, payload: undefined, kind: "message" },
    ]);
  });
});

describe("typed errors (ShError)", () => {
  it("an object error reply rejects as ShError with code, permission and retryAfterMs", async () => {
    const h = makeHarness();
    active = h.client;
    const p = h.client.store.get("k");
    h.fromHost({
      id: h.posted[0].id,
      ok: false,
      error: { code: "permission_denied", message: "no storage", permission: "storage" },
    });
    const err = await p.catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ShError);
    expect(err).toBeInstanceOf(Error);
    expect(err).toMatchObject({ code: "permission_denied", message: "no storage", permission: "storage" });
  });

  it("an older host's string error is code 'error' with that message", async () => {
    const h = makeHarness();
    active = h.client;
    const p = h.client.store.get("k");
    h.fromHost({ id: h.posted[0].id, ok: false, error: "boom" });
    await expect(p).rejects.toMatchObject({ code: "error", message: "boom" });
  });

  it("toShError never trusts the shape", () => {
    expect(toShError(null)).toMatchObject({ code: "error", message: "Unknown error from host" });
    expect(toShError({ code: 7, permission: "camera", retryAfterMs: -1 })).toMatchObject({
      code: "error",
      permission: undefined,
      retryAfterMs: undefined,
    });
    expect(toShError({ code: "too_soon", message: "wait", retryAfterMs: 4200 })).toMatchObject({
      code: "too_soon",
      retryAfterMs: 4200,
    });
  });

  it("openSession on a host with the invite sheet is refused as use_people_pick", async () => {
    const h = makeHarness();
    active = h.client;
    const target: SessionTarget = { instance_id: "peerB", user_ref: "alice", is_local: false };
    const p = h.client.federation.openSession(target);
    h.fromHost({ id: h.posted[0].id, ok: false, error: { code: "use_people_pick", message: "use people.pick" } });
    await expect(p).rejects.toMatchObject({ code: "use_people_pick" });
  });

  it("send to a game the host doesn't know is unknown_session", async () => {
    const h = makeHarness();
    active = h.client;
    const target: SessionTarget = { instance_id: "peerB", user_ref: "alice", is_local: false };
    const p = h.client.federation.send("new-id", target, {});
    h.fromHost({ id: h.posted[0].id, ok: false, error: { code: "unknown_session", message: "x" } });
    await expect(p).rejects.toMatchObject({ code: "unknown_session" });
  });
});

describe("context permissions", () => {
  it("lists the known permissions; unknown names are dropped", async () => {
    const h = makeHarness();
    active = h.client;
    const p = h.client.context();
    h.fromHost({
      id: h.posted[0].id,
      ok: true,
      result: { appId: "chess", selfUserId: "u1", permissions: ["storage", "people", "camera", 3] },
    });
    expect((await p).permissions).toEqual(["storage", "people"]);
  });

  it("an older host without permissions leaves them undefined", async () => {
    const h = makeHarness();
    active = h.client;
    const p = h.client.context();
    h.fromHost({ id: h.posted[0].id, ok: true, result: { appId: "chess", selfUserId: "u1" } });
    expect((await p).permissions).toBeUndefined();
  });
});

describe("people.pick (Social Home's invite sheet)", () => {
  const BEN: SessionTarget = { instance_id: "brookside", user_ref: "ben", is_local: false };

  it("asks the host for the sheet and maps who was picked, with their session ids", async () => {
    const h = makeHarness();
    active = h.client;
    const p = h.client.people.pick({ max: 1, suggest: { ...BEN, extra: "x" } as SessionTarget });
    expect(h.posted[0]).toMatchObject({
      method: "people.pick",
      params: { purpose: "play", max: 1, suggest: BEN },
    });
    // Only the three target fields of a suggestion go to the host.
    expect(Object.keys(h.posted[0].params.suggest).sort()).toEqual(["instance_id", "is_local", "user_ref"]);
    h.fromHost({
      id: h.posted[0].id,
      ok: true,
      result: [{ ...BEN, display_name: "Ben · Brookside", session_id: "s1" }],
    });
    await expect(p).resolves.toEqual([
      { ...BEN, display_name: "Ben · Brookside", sessionId: "s1" },
    ]);
  });

  it("defaults to one person to play with; cancel is []", async () => {
    const h = makeHarness();
    active = h.client;
    const p = h.client.people.pick();
    expect(h.posted[0].params).toEqual({ purpose: "play", max: 1 });
    h.fromHost({ id: h.posted[0].id, ok: true, result: [] });
    await expect(p).resolves.toEqual([]);
  });

  it("waits for the person — no 15 s RPC timeout", async () => {
    vi.useFakeTimers();
    try {
      const h = makeHarness();
      active = h.client;
      const p = h.client.people.pick();
      let settled = false;
      p.then(() => { settled = true; }, () => { settled = true; });
      await vi.advanceTimersByTimeAsync(60_000);
      expect(settled).toBe(false);
      h.fromHost({ id: h.posted[0].id, ok: true, result: [] });
      await expect(p).resolves.toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("busy / too_soon come back typed", async () => {
    const h = makeHarness();
    active = h.client;
    const p = h.client.people.pick();
    h.fromHost({ id: h.posted[0].id, ok: false, error: { code: "too_soon", message: "wait", retryAfterMs: 3000 } });
    await expect(p).rejects.toMatchObject({ code: "too_soon", retryAfterMs: 3000 });
  });

  it("parsePicked never trusts the shape", () => {
    expect(parsePicked(null)).toEqual([]);
    expect(
      parsePicked([
        { instance_id: "a", user_ref: "b", is_local: true, session_id: "s" },
        { instance_id: "a", user_ref: "b", is_local: "yes", session_id: "s" },
        { instance_id: "a", user_ref: "", is_local: true, session_id: "s" },
        { instance_id: "a", user_ref: "b", is_local: true },
        "junk",
      ]),
    ).toEqual([{ instance_id: "a", user_ref: "b", is_local: true, display_name: "b", sessionId: "s" }]);
  });
});

describe("people.pick continue (an old game picked up again)", () => {
  it("asks for the continue sheet with the session id and the opponent", async () => {
    const h = makeHarness();
    active = h.client;
    const ben: SessionTarget = { instance_id: "brookside", user_ref: "ben", is_local: false };
    const p = h.client.people.pick({ purpose: "continue", sessionId: "old-game", suggest: ben });
    expect(h.posted[0]).toMatchObject({
      method: "people.pick",
      params: { purpose: "continue", max: 1, sessionId: "old-game", suggest: ben },
    });
    h.fromHost({
      id: h.posted[0].id,
      ok: true,
      result: [{ ...ben, display_name: "Ben", session_id: "old-game" }],
    });
    await expect(p).resolves.toEqual([{ ...ben, display_name: "Ben", sessionId: "old-game" }]);
  });

  it("a play pick sends no sessionId", () => {
    const h = makeHarness();
    active = h.client;
    void h.client.people.pick().catch(() => {});
    expect("sessionId" in h.posted[0].params).toBe(false);
  });
});
