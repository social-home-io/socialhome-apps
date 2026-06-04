import { afterEach, describe, expect, it, vi } from "vitest";
import { createClient, type SocialHomeClient, type Contact, type SessionTarget, type AppMessage } from "./index.js";

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
