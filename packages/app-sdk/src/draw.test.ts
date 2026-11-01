import { afterEach, describe, expect, it } from "vitest";
import {
  createClient,
  ENGINE_BRIDGE,
  parseEngines,
  parseDrawEvent,
  parseDrawSettings,
  parseDrawStatus,
  ShError,
  type DrawEvent,
  type SocialHomeClient,
} from "./index.js";

/** A fake host frame (as in group.test.ts). */
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

/** A draw as the bridge hands it over (drawBridge.ts toDrawStatus). */
function status(over: Record<string, unknown> = {}) {
  return {
    id: "t1",
    state: "gathering",
    round: 0,
    again: 0,
    of: 4,
    settings: { name: "Wichteln 2026", budget: "about 20 €", day: "2026-12-24", pairs: [[1, 2]] },
    wish: "Tea",
    hasResult: false,
    isHost: true,
    ...over,
  };
}

const flush = () => new Promise((r) => setTimeout(r, 0));

describe("parseDrawStatus (never trusts the shape)", () => {
  it("reads the bridge's camelCase", () => {
    expect(parseDrawStatus(status({ done: 2, waitingFor: [{ seats: [3, 4] }] }))).toEqual({
      ...status(),
      settings: { name: "Wichteln 2026", budget: "about 20 €", day: "2026-12-24", pairs: [[1, 2]] },
      done: 2,
      waitingFor: [{ seats: [3, 4] }],
    });
  });

  it("reads core's snake_case too", () => {
    const { hasResult: _h, isHost: _i, ...rest } = status();
    const st = parseDrawStatus({
      ...rest,
      has_result: true,
      is_host: false,
      waiting_for: [{ seats: [2] }],
      false_complaints: [{ seats: [3] }],
    });
    expect(st?.hasResult).toBe(true);
    expect(st?.isHost).toBe(false);
    expect(st?.waitingFor).toEqual([{ seats: [2] }]);
    expect(st?.falseComplaints).toEqual([{ seats: [3] }]);
  });

  it.each([
    ["not an object", null],
    ["a bad id", status({ id: "../x" })],
    ["an unknown state", status({ state: "won" })],
    ["a round that isn't a number", status({ round: "1" })],
    ["a negative count", status({ of: -1 })],
    ["a wish over 500 characters", status({ wish: "x".repeat(501) })],
  ])("refuses %s", (_what, v) => {
    expect(parseDrawStatus(v)).toBeUndefined();
  });

  it("keeps a reason only for a failed draw", () => {
    expect(parseDrawStatus(status({ state: "failed", reason: "rules" }))?.reason).toBe("rules");
    expect(parseDrawStatus(status({ reason: "rules" }))?.reason).toBeUndefined();
  });

  it("never carries a result, even when a host sends one", () => {
    const st = parseDrawStatus(status({ result: { name: "Ben" }, giver: "Anna", hasResult: true }));
    expect(st).not.toHaveProperty("result");
    expect(st).not.toHaveProperty("giver");
    expect(JSON.stringify(st)).not.toContain("Ben");
  });

  it("drops bad settings and bad homes", () => {
    expect(parseDrawStatus(status({ settings: { name: 3 } }))?.settings).toBeNull();
    expect(parseDrawStatus(status({ settings: null }))?.settings).toBeNull();
    expect(parseDrawStatus(status({ waitingFor: [{ seats: ["x"] }, "y"] }))?.waitingFor).toBeUndefined();
  });
});

describe("parseDrawSettings", () => {
  it("fills missing fields", () => {
    expect(parseDrawSettings({})).toEqual({ name: "", budget: "", day: null, pairs: [] });
  });
  it.each([
    ["a two-line name", { name: "a\nb" }],
    ["a long budget", { budget: "x".repeat(41) }],
    ["a day that doesn't exist", { day: "2026-02-30" }],
    ["a day in another format", { day: "24.12.2026" }],
    ["overlapping pairs", { pairs: [[1, 2], [2, 3]] }],
    ["a pair of one seat", { pairs: [[1, 1]] }],
    ["more than ten pairs", { pairs: Array.from({ length: 11 }, (_, i) => [2 * i + 1, 2 * i + 2]) }],
  ])("refuses %s", (_what, v) => {
    expect(parseDrawSettings(v)).toBeNull();
  });
});

describe("parseDrawEvent", () => {
  it("reads a status push", () => {
    expect(parseDrawEvent({ type: "status", id: "t1", status: status() })?.status.of).toBe(4);
  });
  it("refuses one whose status is for another table, or an unknown type", () => {
    expect(parseDrawEvent({ type: "status", id: "t2", status: status() })).toBeUndefined();
    expect(parseDrawEvent({ type: "result", id: "t1", status: status() })).toBeUndefined();
  });
});

describe("sh.engines.draw", () => {
  it("names its bridge calls in one place", () => {
    expect(ENGINE_BRIDGE).toMatchObject({
      event: "engine:event",
      draw: {
        name: "draw",
        configure: "engine.draw.configure",
        setWishes: "engine.draw.setWishes",
        start: "engine.draw.start",
        status: "engine.draw.status",
        reveal: "engine.draw.reveal",
      },
    });
  });

  it("context() lists the engines the host runs for the app", async () => {
    const h = harness();
    const p = h.client.context();
    h.reply({ appId: "gift-draw", selfUserId: "u", groups: true, engines: ["draw"] });
    expect((await p).engines).toEqual(["draw"]);
    const q = h.client.context();
    h.reply({ appId: "gift-draw", selfUserId: "u", draw: true });
    expect((await q).engines).toBeUndefined();
  });

  it("parseEngines keeps only well-formed, distinct names", () => {
    expect(parseEngines(["draw", "draw", "Bad Name", 3, "x".repeat(40), "quiz"])).toEqual(["draw", "quiz"]);
    expect(parseEngines("draw")).toBeUndefined();
    expect(parseEngines(Array.from({ length: 40 }, (_, i) => `e${i}`))).toHaveLength(16);
  });

  it("configure sends only the fields given", async () => {
    const h = harness();
    const p = h.client.engines.draw.configure("t1", { name: "Wichteln", pairs: [[1, 3]] });
    expect(h.posted[0]).toMatchObject({
      method: "engine.draw.configure",
      params: { id: "t1", settings: { name: "Wichteln", pairs: [[1, 3]] } },
    });
    expect(h.posted[0].params.settings).not.toHaveProperty("budget");
    h.reply(status());
    expect((await p).settings?.name).toBe("Wichteln 2026");
  });

  it.each([
    ["a bad id", () => ["../t", {}]],
    ["a long name", () => ["t1", { name: "x".repeat(81) }]],
    ["a bad day", () => ["t1", { day: "tomorrow" }]],
    ["overlapping pairs", () => ["t1", { pairs: [[1, 2], [1, 3]] }]],
  ] as const)("configure refuses %s before sending anything", async (_w, args) => {
    const h = harness();
    const [id, s] = args();
    await expect(h.client.engines.draw.configure(id, s as never)).rejects.toMatchObject({ code: "invalid" });
    expect(h.posted).toHaveLength(0);
  });

  it("setWishes refuses a wish over 500 characters before sending", async () => {
    const h = harness();
    await expect(h.client.engines.draw.setWishes("t1", "é".repeat(501))).rejects.toMatchObject({ code: "wish_too_long" });
    expect(h.posted).toHaveLength(0);
    const p = h.client.engines.draw.setWishes("t1", "é".repeat(500));
    expect(h.posted[0]).toMatchObject({ method: "engine.draw.setWishes", params: { id: "t1", text: "é".repeat(500) } });
    h.reply(status());
    await p;
  });

  it("start sends again only when asked", async () => {
    const h = harness();
    const p = h.client.engines.draw.start("t1");
    expect(h.posted[0].params).toEqual({ id: "t1" });
    h.reply(status({ state: "drawing", round: 1 }));
    expect((await p).state).toBe("drawing");
    const q = h.client.engines.draw.start("t1", { again: true });
    expect(h.posted[1].params).toEqual({ id: "t1", again: true });
    h.reply(status({ state: "drawing", again: 1 }));
    await q;
  });

  it("refuses a reply for another table", async () => {
    const h = harness();
    const p = h.client.engines.draw.status("t1");
    h.reply(status({ id: "t2" }));
    await expect(p).rejects.toBeInstanceOf(ShError);
  });

  it("passes the host's refusal codes on", async () => {
    const h = harness();
    const p = h.client.engines.draw.start("t1");
    h.refuse({ code: "too_few", message: "Too few" });
    await expect(p).rejects.toMatchObject({ code: "too_few" });
  });

  it("reads an older host's unknown_method as engine_not_supported", async () => {
    const h = harness();
    const p = h.client.engines.draw.status("t1");
    h.refuse({ code: "unknown_method", message: "?" });
    await expect(p).rejects.toMatchObject({ code: "engine_not_supported" });
    const r = h.client.engines.draw.reveal("t1");
    h.refuse({ code: "unknown_method", message: "?" });
    await expect(r).rejects.toMatchObject({ code: "engine_not_supported" });
  });

  it("passes engine_not_declared on (the manifest lacks the engine)", async () => {
    const h = harness();
    const p = h.client.engines.draw.start("t1");
    h.refuse({ code: "engine_not_declared", message: "no" });
    await expect(p).rejects.toMatchObject({ code: "engine_not_declared" });
  });

  it("reveal resolves with nothing, whatever the host answers", async () => {
    const h = harness();
    const p = h.client.engines.draw.reveal("t1");
    expect(h.posted[0]).toMatchObject({ method: "engine.draw.reveal", params: { id: "t1" } });
    h.reply({ name: "Ben" });
    expect(await p).toBeUndefined();
  });

  it("hears status pushes from the host only, and stops on unsubscribe", async () => {
    const h = harness();
    const events: DrawEvent[] = [];
    const off = h.client.engines.draw.onEvent((e) => events.push(e));
    h.fromHost({ type: "engine:event", engine: "draw", event: { type: "status", id: "t1", status: status({ state: "ready", hasResult: true }) } });
    h.fromRogue({ type: "engine:event", engine: "draw", event: { type: "status", id: "t1", status: status() } });
    h.fromHost({ type: "engine:event", engine: "draw", event: { type: "status", id: "t1", status: { id: "t1" } } });
    await flush();
    expect(events).toHaveLength(1);
    expect(events[0].status.hasResult).toBe(true);
    // Another engine's push is not the draw's.
    h.fromHost({ type: "engine:event", engine: "quiz", event: { type: "status", id: "t1", status: status() } });
    h.fromHost({ type: "draw:event", event: { type: "status", id: "t1", status: status() } });
    expect(events).toHaveLength(1);
    off();
    h.fromHost({ type: "engine:event", engine: "draw", event: { type: "status", id: "t1", status: status() } });
    expect(events).toHaveLength(1);
  });

  it("a crashing subscriber doesn't stop the others", () => {
    const h = harness();
    const seen: string[] = [];
    h.client.engines.draw.onEvent(() => {
      throw new Error("boom");
    });
    h.client.engines.draw.onEvent((e) => seen.push(e.id));
    h.fromHost({ type: "engine:event", engine: "draw", event: { type: "status", id: "t1", status: status() } });
    expect(seen).toEqual(["t1"]);
  });
});
