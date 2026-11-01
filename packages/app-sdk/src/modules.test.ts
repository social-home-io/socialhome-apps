// The SDK's modules (SDK 2.0): group games and engines join a client only
// when the app asks (withGroups / withDraw), and an app's bundle carries only
// the modules it uses — so an SDK addition an app doesn't use never changes
// that app's bundle (and never forces it a version bump).

import { build } from "esbuild";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { createClient, withDraw, withGroups, type SocialHomeClient } from "./index.js";

const SRC = path.dirname(fileURLToPath(import.meta.url));

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
  return { posted, client, fromHost };
}

let active: SocialHomeClient | null = null;
afterEach(() => {
  active?.destroy();
  active = null;
});

const table = {
  id: "t1",
  appId: "chess",
  state: "playing",
  me: 1,
  host: 1,
  min: 2,
  max: 2,
  players: [
    { seat: 1, name: "Anna", household: "Home", state: "seated" },
    { seat: 2, name: "Ben", household: "Away", state: "seated" },
  ],
};

describe("withGroups / withDraw", () => {
  it("a plain client has neither group nor engines", () => {
    const h = makeHarness();
    active = h.client;
    expect("group" in h.client).toBe(false);
    expect("engines" in h.client).toBe(false);
  });

  it("adds the calls once: calling again returns the same namespace", () => {
    const h = makeHarness();
    active = h.client;
    const a = withGroups(h.client);
    const group = a.group;
    expect(withGroups(a).group).toBe(group);
    const b = withDraw(a);
    const draw = b.engines.draw;
    expect(withDraw(b).engines.draw).toBe(draw);
    // Both on the same client, either order.
    expect(b.group).toBe(group);
  });

  it("a table event reaches withGroups' subscribers once (dedupe by seq)", () => {
    const h = makeHarness();
    active = h.client;
    const c = withGroups(h.client);
    const got: unknown[] = [];
    c.group.onEvent((e) => got.push(e));
    const push = { type: "group:event", event: { type: "message", id: "t1", seq: 3, from: 2, data: { m: 1 } } };
    h.fromHost(push);
    h.fromHost(push);
    expect(got).toHaveLength(1);
  });

  it("a push for a module the app didn't add is dropped quietly", () => {
    const h = makeHarness();
    active = h.client;
    const seen: unknown[] = [];
    h.client.onMessage((m) => seen.push(m));
    h.client.onSession((m) => seen.push(m));
    h.fromHost({ type: "group:event", event: { type: "started", id: "t1", session: table } });
    h.fromHost({ type: "engine:event", engine: "draw", event: { type: "status", id: "t1" } });
    expect(seen).toEqual([]);
    expect(h.posted).toEqual([]);
  });

  it("a throwing subscriber doesn't stop the others", () => {
    const h = makeHarness();
    active = h.client;
    const c = withGroups(h.client);
    const got: unknown[] = [];
    c.group.onEvent(() => {
      throw new Error("boom");
    });
    c.group.onEvent((e) => got.push(e));
    h.fromHost({ type: "group:event", event: { type: "started", id: "t1", session: table } });
    expect(got).toHaveLength(1);
  });

  it("withGroups leaves a missing client (outside a browser) as it is", () => {
    expect(withGroups(null as unknown as SocialHomeClient)).toBeNull();
    expect(withDraw(null as unknown as SocialHomeClient)).toBeNull();
  });
});

/** Bundle `code` (an app's entry) the way the apps build, and return the JS. */
async function bundle(code: string): Promise<string> {
  const out = await build({
    stdin: { contents: code, resolveDir: SRC, loader: "ts" },
    bundle: true,
    format: "iife",
    target: "es2022",
    minify: true,
    write: false,
    logLevel: "silent",
  });
  return out.outputFiles[0].text;
}

describe("tree-shaking: an app carries only the modules it uses", () => {
  it("an app without group games or engines carries neither", async () => {
    const js = await bundle(`import sh from "./index.ts"; sh?.context().then(console.log);`);
    expect(js).toContain("app.context");
    expect(js).not.toContain("group.held");
    expect(js).not.toContain("groups_not_supported");
    expect(js).not.toContain("engine.draw");
    expect(js).not.toContain("engine:event");
  });

  it("an app with group games carries them, and no engine", async () => {
    const js = await bundle(
      `import sh from "./index.ts"; import { withGroups } from "./group.ts";
       const c = withGroups(sh!); c.group.list().then(console.log);`,
    );
    expect(js).toContain("group.held");
    expect(js).not.toContain("engine.draw");
    expect(js).not.toContain("engine:event");
  });

  it("an app with the gift draw carries it", async () => {
    const js = await bundle(
      `import sh from "./index.ts"; import { withDraw } from "./draw.ts";
       const c = withDraw(sh!); c.engines.draw.status("t1").then(console.log);`,
    );
    expect(js).toContain("engine.draw.status");
    expect(js).toContain("engine:event");
  });

  it("importing a type or ShError from the root pulls in no module", async () => {
    const js = await bundle(
      `import sh, { ShError, type GroupSession, type DrawStatus } from "./index.ts";
       const x: GroupSession | DrawStatus | null = null;
       sh?.store.get("k").catch((e) => console.log(e instanceof ShError, x));`,
    );
    expect(js).not.toContain("group.held");
    expect(js).not.toContain("engine.draw");
  });
});
