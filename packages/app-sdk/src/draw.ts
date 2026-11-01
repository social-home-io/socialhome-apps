/**
 * The gift draw — `@socialhome/app-sdk/draw` (SDK 1.11, Social Home v_78).
 *
 * The draw's types and parsers, and {@link withDraw}, which gives a client
 * its `engines.draw` calls. An app that never calls `withDraw` carries none
 * of them in its bundle.
 */

import {
  engineCall,
  field,
  GROUP_SEAT_MAX,
  isGroupId,
  isInt,
  isRecord,
  optText,
  ShError,
  type Unsubscribe,
} from "./shared.js";
import { GROUP_MAX_PLAYERS } from "./group.js";
import type { SocialHomeClient } from "./index.js";

// ---------------------------------------------------------------------------
// The gift draw — SDK 1.11, Social Home v_78
// ---------------------------------------------------------------------------

/**
 * The bridge contract for engines — work Social Home does itself at a
 * table, which an app declares in its manifest (`"engines": ["draw"]`) and
 * asks for (Social Home's `docs/protocol/app-groups.md`). The names live
 * here only, so they are easy to align with Social Home.
 *
 * The gift draw (`draw`, Social Home v_78) — every call takes the table's
 * `id` and needs the `people` permission:
 *
 * | Method | `params` | `result` |
 * |---|---|---|
 * | `engine.draw.configure` | `{id, settings: {name?, budget?, day?, pairs?}}` | {@link DrawStatus} |
 * | `engine.draw.setWishes` | `{id, text}` | `DrawStatus` |
 * | `engine.draw.start` | `{id, again?: true}` | `DrawStatus` |
 * | `engine.draw.status` | `{id}` | `DrawStatus` |
 * | `engine.draw.reveal` | `{id}` | `null` — Social Home shows the result in its own sheet |
 *
 * Host → app: `{type: "engine:event", engine: "draw", event: {type: "status", id, status}}`.
 * `app.context` lists `engines: ["draw"]` when the host serves these calls
 * for the app. **No call ever returns whom anybody gives to.**
 */
export const ENGINE_BRIDGE = /* @__PURE__ */ Object.freeze({
  /** `type` of every host → app engine push. */
  event: "engine:event",
  draw: /* @__PURE__ */ Object.freeze({
    name: "draw",
    configure: "engine.draw.configure",
    setWishes: "engine.draw.setWishes",
    start: "engine.draw.start",
    status: "engine.draw.status",
    reveal: "engine.draw.reveal",
  }),
});

/** People in one draw. */
export const DRAW_MIN_PEOPLE = 3;
export const DRAW_MAX_PEOPLE = GROUP_MAX_PLAYERS;
/** A draw with any pair needs at least this many people. */
export const DRAW_MIN_PEOPLE_WITH_PAIRS = 4;
/** A wish list's length, in characters (the whole card must also fit 1 KiB). */
export const DRAW_WISH_MAX_CHARS = 500;
/** How often a wish list may change after the reveal. */
export const DRAW_WISH_UPDATES_MAX = 5;
/** How often the organiser may draw again. */
export const DRAW_AGAIN_MAX = 10;
/** The draw's name and budget, in characters (one line each). */
export const DRAW_NAME_MAX = 80;
export const DRAW_BUDGET_MAX = 40;

/** Where a draw is: people gather, names are being drawn, everyone has
 *  their name, or it couldn't be drawn ({@link DrawStatus.reason}). */
export type DrawState = "gathering" | "drawing" | "ready" | "failed";

/** The organiser's settings. `pairs` are seats who must not draw each other. */
export interface DrawSettings {
  name: string;
  budget: string;
  /** The exchange day, `YYYY-MM-DD`, or `null`. */
  day: string | null;
  pairs: [number, number][];
}

/** A change to the settings for `engines.draw.configure` — a patch: only
 *  the fields given change, and `null` clears one (no name, no budget, no
 *  day, no pairs). */
export interface DrawSettingsInput {
  name?: string | null;
  budget?: string | null;
  day?: string | null;
  pairs?: [number, number][] | null;
}

/** The seats of one household: one the draw waits for, or one blamed for
 *  breaking a round. */
export interface DrawHome {
  seats: number[];
}

/**
 * A draw as the person using the app sees it — never whom anybody gives to.
 * `hasResult` says whether they have a name to see: `client.engines.draw.reveal(id)`
 * shows it in Social Home's own sheet.
 */
export interface DrawStatus {
  id: string;
  state: DrawState;
  /** Why it failed: `"rules"` (the pairs never fit), `"too_few"`, or
   *  `"broken"` (someone's home kept breaking the draw; the organiser can
   *  try again later). Treat another value as a plain failure. */
  reason?: string;
  /** The round of the current draw (a round is redone when a home proves
   *  something went wrong). */
  round: number;
  /** How often the names were drawn again after a reveal. */
  again: number;
  /** People in the draw. */
  of: number;
  /** Organiser only: how many homes are through the current step. */
  done?: number;
  /** Organiser only, after an hour: the homes the draw waits for. */
  waitingFor?: DrawHome[];
  /** Homes that broke a round — stopped it without proof, or sent a key
   *  nobody could seal to — as each household proved itself. Shown to
   *  everyone at the table. */
  blamed?: DrawHome[];
  /** The settings — `null` until the organiser saved them (or, for
   *  everyone else, until the names are drawn). */
  settings: DrawSettings | null;
  /** The person's own wish list. */
  wish: string;
  hasResult: boolean;
  /** The person started this draw (the organiser). */
  isHost: boolean;
}

/** What `client.engines.draw.onEvent` hears: the draw's new state. */
export interface DrawEvent {
  type: "status";
  id: string;
  status: DrawStatus;
}

const DRAW_STATES: readonly string[] = ["gathering", "drawing", "ready", "failed"];
const DRAW_DAY = /^\d{4}-\d{2}-\d{2}$/;

function isDrawDay(v: unknown): v is string {
  if (typeof v !== "string" || !DRAW_DAY.test(v)) return false;
  const d = new Date(`${v}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === v;
}

function oneLine(v: unknown, max: number): v is string {
  return typeof v === "string" && [...v].length <= max && !/[\r\n]/.test(v);
}

function isPairs(v: unknown): v is [number, number][] {
  if (!Array.isArray(v) || v.length > Math.floor(DRAW_MAX_PEOPLE / 3)) return false;
  const seen = new Set<number>();
  for (const p of v) {
    if (!Array.isArray(p) || p.length !== 2) return false;
    const [a, b] = p;
    if (!isInt(a, 1, GROUP_SEAT_MAX) || !isInt(b, 1, GROUP_SEAT_MAX) || a === b) return false;
    if (seen.has(a) || seen.has(b)) return false;
    seen.add(a);
    seen.add(b);
  }
  return true;
}

/** Read the draw's settings without trusting their shape (`null` when they
 *  aren't settings). */
export function parseDrawSettings(v: unknown): DrawSettings | null {
  if (!isRecord(v)) return null;
  const name = v["name"] ?? "";
  const budget = v["budget"] ?? "";
  const day = v["day"] ?? null;
  const pairs = v["pairs"] ?? [];
  if (!oneLine(name, DRAW_NAME_MAX) || !oneLine(budget, DRAW_BUDGET_MAX)) return null;
  if (day !== null && !isDrawDay(day)) return null;
  if (!isPairs(pairs)) return null;
  return { name, budget, day, pairs: pairs.map(([a, b]) => [a, b] as [number, number]) };
}

function parseHomes(v: unknown): DrawHome[] | undefined {
  if (!Array.isArray(v)) return undefined;
  const out: DrawHome[] = [];
  for (const row of v.slice(0, DRAW_MAX_PEOPLE)) {
    if (!isRecord(row) || !Array.isArray(row["seats"])) continue;
    const seats = row["seats"].filter((s): s is number => isInt(s, 1, GROUP_SEAT_MAX));
    if (seats.length > 0) out.push({ seats: [...new Set(seats)] });
  }
  return out;
}

/**
 * Read a draw's state as the host sends it, without trusting its shape:
 * `undefined` when it isn't one. Reads the bridge's camelCase and core's
 * snake_case alike. A result — whom anybody gives to — is never read, even
 * if a host sent one.
 */
export function parseDrawStatus(v: unknown): DrawStatus | undefined {
  if (!isRecord(v)) return undefined;
  const id = v["id"];
  const state = v["state"];
  if (!isGroupId(id) || typeof state !== "string" || !DRAW_STATES.includes(state)) return undefined;
  const round = v["round"];
  const again = v["again"];
  const of = v["of"];
  if (!isInt(round, 0, 1000) || !isInt(again, 0, 1000) || !isInt(of, 0, GROUP_SEAT_MAX)) return undefined;
  const wish = v["wish"] ?? "";
  if (typeof wish !== "string" || [...wish].length > DRAW_WISH_MAX_CHARS) return undefined;
  const out: DrawStatus = {
    id,
    state: state as DrawState,
    round,
    again,
    of,
    settings: parseDrawSettings(v["settings"]),
    wish,
    hasResult: field(v, "hasResult", "has_result") === true,
    isHost: field(v, "isHost", "is_host") === true,
  };
  const reason = optText(v["reason"], 40);
  if (state === "failed" && reason) out.reason = reason;
  const done = v["done"];
  if (isInt(done, 0, GROUP_SEAT_MAX)) out.done = done;
  const waiting = parseHomes(field(v, "waitingFor", "waiting_for"));
  if (waiting && waiting.length > 0) out.waitingFor = waiting;
  const blamed = parseHomes(v["blamed"]);
  if (blamed && blamed.length > 0) out.blamed = blamed;
  return out;
}

/** Read the `event` of one draw push (`undefined` when malformed or unknown). */
export function parseDrawEvent(v: unknown): DrawEvent | undefined {
  if (!isRecord(v) || v["type"] !== "status") return undefined;
  const id = v["id"];
  const status = parseDrawStatus(v["status"]);
  if (!isGroupId(id) || !status || status.id !== id) return undefined;
  return { type: "status", id, status };
}

/** Check a `draw.configure` patch before anything is sent (`null` clears a field). */
function checkSettingsInput(s: unknown): Record<string, unknown> {
  if (!isRecord(s)) throw new ShError("invalid", "settings must be an object.");
  const out: Record<string, unknown> = {};
  if (s["name"] !== undefined) {
    if (s["name"] !== null && !oneLine(s["name"], DRAW_NAME_MAX)) throw new ShError("invalid", `name: one line, at most ${DRAW_NAME_MAX} characters.`);
    out["name"] = s["name"];
  }
  if (s["budget"] !== undefined) {
    if (s["budget"] !== null && !oneLine(s["budget"], DRAW_BUDGET_MAX)) throw new ShError("invalid", `budget: one line, at most ${DRAW_BUDGET_MAX} characters.`);
    out["budget"] = s["budget"];
  }
  if (s["day"] !== undefined) {
    if (s["day"] !== null && !isDrawDay(s["day"])) throw new ShError("invalid", "day must be YYYY-MM-DD or null.");
    out["day"] = s["day"];
  }
  if (s["pairs"] !== undefined) {
    const pairs = s["pairs"];
    if (pairs === null) out["pairs"] = null;
    else if (!isPairs(pairs)) throw new ShError("invalid", "pairs must be different seats, each in one pair at most.");
    else out["pairs"] = pairs.map(([a, b]) => [a, b]);
  }
  return out;
}

// ---------------------------------------------------------------------------
// The `engines.draw` calls
// ---------------------------------------------------------------------------

/** The `engines.draw` calls of one client (see {@link withDraw}). */
function drawApi(client: SocialHomeClient) {
  const subs = new Set<(event: DrawEvent) => void>();

  /** A gift-draw call; a reply that isn't that table's draw is refused. */
  const call = (method: string, params: Record<string, unknown>): Promise<DrawStatus> =>
    engineCall(client, method, params).then((r) => {
      const st = parseDrawStatus(r);
      if (!st || st.id !== params["id"]) throw new ShError("error", "Social Home answered without the draw.");
      return st;
    });

  // A draw's new state.
  client._onPush(ENGINE_BRIDGE.event, (data) => {
    if (data["engine"] !== ENGINE_BRIDGE.draw.name) return;
    const event = parseDrawEvent(data["event"]);
    if (!event) return;
    for (const cb of subs) {
      try {
        cb(event);
      } catch {
        // Never let a subscriber crash the message loop.
      }
    }
  });

  return {
    /**
     * Organiser only, before the names are drawn (or after a draw gave up):
     * change the settings. A **patch**: only the fields given change, and
     * `null` clears one. Other
     * households get them only when the names are drawn, so share them
     * with `client.group.send` if people should see them before.
     */
    configure: (id: string, settings: DrawSettingsInput): Promise<DrawStatus> => {
      if (!isGroupId(id)) return Promise.reject(new ShError("invalid", "id must be a table id."));
      let clean: Record<string, unknown>;
      try {
        clean = checkSettingsInput(settings);
      } catch (err) {
        return Promise.reject(err);
      }
      return call(ENGINE_BRIDGE.draw.configure, { id, settings: clean });
    },

    /**
     * The person's own wish list (≤ {@link DRAW_WISH_MAX_CHARS} characters;
     * the whole card must also fit 1 KiB, else `"wish_too_long"`). After
     * the reveal it reaches their giver, at most
     * {@link DRAW_WISH_UPDATES_MAX} times (`"wish_updates"`).
     */
    setWishes: (id: string, text: string): Promise<DrawStatus> => {
      if (!isGroupId(id)) return Promise.reject(new ShError("invalid", "id must be a table id."));
      if (typeof text !== "string") return Promise.reject(new ShError("invalid", "text must be a string."));
      if ([...text.trim()].length > DRAW_WISH_MAX_CHARS) {
        return Promise.reject(new ShError("wish_too_long", `At most ${DRAW_WISH_MAX_CHARS} characters.`));
      }
      return call(ENGINE_BRIDGE.draw.setWishes, { id, text });
    },

    /**
     * Organiser only: draw names (starts the table if it still waits for
     * people; at least three seated, `"too_few"`). `{again: true}` after
     * everyone has their name draws again for everyone still in — everyone
     * is told, at most {@link DRAW_AGAIN_MAX} times, until the exchange day.
     */
    start: (id: string, options: { again?: boolean } = {}): Promise<DrawStatus> => {
      if (!isGroupId(id)) return Promise.reject(new ShError("invalid", "id must be a table id."));
      const params: Record<string, unknown> = { id };
      if (options.again === true) params["again"] = true;
      return call(ENGINE_BRIDGE.draw.start, params);
    },

    /** The draw's state now. */
    status: (id: string): Promise<DrawStatus> => {
      if (!isGroupId(id)) return Promise.reject(new ShError("invalid", "id must be a table id."));
      return call(ENGINE_BRIDGE.draw.status, { id });
    },

    /**
     * Show the person whom they give to — in Social Home's own sheet,
     * outside the app. Resolves with nothing once the sheet is open; the
     * app never sees the name. Call it from a button the person pressed.
     */
    reveal: (id: string): Promise<void> => {
      if (!isGroupId(id)) return Promise.reject(new ShError("invalid", "id must be a table id."));
      return engineCall(client, ENGINE_BRIDGE.draw.reveal, { id }).then(() => undefined);
    },

    /**
     * Hear a draw's new state (names being drawn, ready, failed, a home
     * the draw waits for). Never a result.
     * @returns an unsubscribe function.
     */
    onEvent: (cb: (event: DrawEvent) => void): Unsubscribe => {
      subs.add(cb);
      return () => {
        subs.delete(cb);
      };
    },
  };
}

/** The gift-draw calls: `client.engines.draw` after {@link withDraw}. */
export type DrawApi = ReturnType<typeof drawApi>;

/**
 * The gift draw at a table (Social Home v_78) — Social Home
 * draws the names, the app only asks. Every person draws one other person
 * to give a gift to; couples the organiser lists don't draw each other.
 * **The app never learns whom anybody gives to**: `reveal` opens Social
 * Home's own sheet, outside the app, and no call returns a result.
 *
 * Check `ctx.engines?.includes("draw")` first: on an older Social Home
 * every call is refused `"engine_not_supported"`. Every call needs the `people`
 * permission and the table's `id`; the person must be seated there.
 * Refusals: see {@link ShErrorCode}.
 *
 * ```ts
 * import sh from "@socialhome/app-sdk";
 * import { withGroups } from "@socialhome/app-sdk/group";
 * import { withDraw } from "@socialhome/app-sdk/draw";
 * const client = withDraw(withGroups(sh!));
 * client.engines.draw.onEvent((e) => show(e.status));
 * ```
 *
 * Call it once, at start-up, before `context()`. Calling it again on the
 * same client returns it as it is. Each engine is its own module, so an app
 * carries only the engines it uses (SDK 2.0; before, every client had
 * `engines`).
 */
export function withDraw<C extends SocialHomeClient>(
  client: C,
): C & { readonly engines: { readonly draw: DrawApi } } {
  const c = client as C & { engines?: { draw?: DrawApi } };
  if (c) {
    if (c.engines === undefined) Object.defineProperty(c, "engines", { value: {}, enumerable: true });
    const engines = c.engines as { draw?: DrawApi };
    if (engines.draw === undefined) Object.defineProperty(engines, "draw", { value: drawApi(c), enumerable: true });
  }
  return c as C & { readonly engines: { readonly draw: DrawApi } };
}
