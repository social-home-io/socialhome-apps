/**
 * Group games — `@socialhome/app-sdk/group` (SDK 1.9, Social Home v_76).
 *
 * The table types and parsers, and {@link withGroups}, which gives a client
 * its `group` calls. An app that never calls `withGroups` carries none of
 * the calls in its bundle.
 */

import {
  CALL_TIMEOUT_MS,
  GROUP_SEAT_MAX,
  isGroupId,
  isInt,
  field,
  isRecord,
  optText,
  PICK_TIMEOUT_MS,
  ShError,
  type Unsubscribe,
} from "./shared.js";
import type { SessionTarget, SocialHomeClient } from "./index.js";
// ---------------------------------------------------------------------------
// Group games (tables) — SDK 1.9, Social Home v_76
// ---------------------------------------------------------------------------

/**
 * The bridge contract for group games, in one place (Social Home's
 * `docs/protocol/app-groups.md`, "the app bridge"). App → host calls are
 * `{id, method, params}` like every other call:
 *
 * | Method | `params` | `result` |
 * |---|---|---|
 * | `group.open` | `{suggest?: SessionTarget[]}` | a {@link GroupSession}, or `null` (cancelled) |
 * | `group.list` | — | `GroupSession[]` |
 * | `group.get` | `{id}` | `GroupSession` |
 * | `group.start` | `{id}` | `GroupSession` |
 * | `group.send` | `{id, data, to?: number[], turn?: number, final?: true}` | `{seq: number \| null}` |
 * | `group.leave` | `{id}` | `{ok: true}` |
 * | `group.remove` | `{id, seat}` | `GroupSession` |
 * | `group.close` | `{id}` | `{ok: true}` |
 * | `group.held` | — | `GroupEvent[]` (`message` events, oldest `seq` first) |
 *
 * Host → app: `{type: "group:event", event}` with a {@link GroupEvent}. The
 * host works out joined / left / … by comparing the table's snapshots.
 * `app.context` adds `groups: true` when the host serves these calls, and
 * `launch: {sessionId, group}` when Join / Play opened the app for a table.
 */
export const GROUP_BRIDGE = /* @__PURE__ */ Object.freeze({
  open: "group.open",
  list: "group.list",
  get: "group.get",
  start: "group.start",
  send: "group.send",
  leave: "group.leave",
  remove: "group.remove",
  close: "group.close",
  held: "group.held",
  /** `type` of every host → app group push. */
  event: "group:event",
});

/** The most players any table seats (Social Home's hard ceiling). */
export const GROUP_MAX_PLAYERS = 30;
/** The most players at a table opened by picking people (host included). */
export const GROUP_PICK_MAX_PLAYERS = 10;
const GROUP_NAME_MAX = 80;
const GROUP_SEEN_MAX = 1024;

/** Where a table is: waiting for players, being played, or over. */
export type GroupState = "lobby" | "playing" | "ended";

/**
 * Why a table ended — {@link GroupSession.endReason}. Unknown values may
 * appear in later Social Home versions: treat them as a plain end.
 */
export type GroupEndReason =
  | "finished"
  | "cancelled"
  | "expired"
  | "host_gone"
  | "app_removed"
  | "closed_by_moderator"
  | (string & {});

/**
 * The person's own place at a table: `invited` (hasn't answered), `joining`
 * (Join sent, the host's household hasn't seated them yet), `seated`, `left`
 * or `removed`.
 */
export type GroupMyState = "invited" | "joining" | "seated" | "left" | "removed" | (string & {});

/**
 * One seat at a table. **People are seats, never usernames**: an app gets a
 * seat number, a name and a household name — show them as plain text.
 */
export interface GroupPlayer {
  seat: number;
  name: string;
  /** Their household's name; `null` for your own household. */
  household: string | null;
  /** In the same household as the person using the app. */
  isLocal: boolean;
  state: "seated" | "left" | "removed";
}

/** A table (a group game) as the person using the app sees it. */
export interface GroupSession {
  /** The table's id — use it for every `client.group` call. */
  id: string;
  appId?: string;
  state: GroupState;
  /** Only when `state` is `"ended"`. */
  endReason?: GroupEndReason;
  /** The space the table was opened in (space tables, a later Social Home). */
  spaceId?: string;
  /** Their seat; `null` until the host's household seated them. */
  me: number | null;
  myState: GroupMyState;
  /** The host person's seat (`null` while unknown). */
  host: number | null;
  /** The person using the app is the host (may Start, Remove, Close). */
  isHost: boolean;
  /** Players needed to start / most players. */
  min: number;
  max: number;
  /** A game being played still takes people. */
  lateJoin: boolean;
  /** The last message number the host's household handed out, when known. */
  seq?: number;
  /** The host's words for the table (≤ 80 characters, one line). */
  note?: string;
  /** Everyone who sat down (seated, left or removed), by seat. */
  players: GroupPlayer[];
}

/**
 * A message at a table. `from` is the sender's seat, `seq` the host
 * household's number for it (every player sees the same order; a gap is a
 * message meant for others). `direct` is `true` for a message sent to chosen
 * seats only — sealed so no other household could read it. `held` marks one
 * that waited while the app was closed.
 */
export interface GroupMessage {
  id: string;
  seq: number;
  from: number;
  data: unknown;
  direct: boolean;
  held?: true;
}

/**
 * What `client.group.onEvent` hears:
 *
 * - `message` — a player's message ({@link GroupMessage}).
 * - `joined` / `left` / `removed` — someone took, left or lost a seat. When
 *   `seat` is **your own** (`session.me`), your place is over: forget the
 *   table (you left on another device, were removed, the game started
 *   without you, or your household keeps you apart from someone who sat down).
 * - `started` — the host started the game (no more joins unless `lateJoin`).
 * - `host-changed` — the host left a game being played; `session.host` is the new one.
 * - `ended` — the table is over (`session.endReason`).
 *
 * `session` is the table after the change. Unknown `type`s from a later
 * Social Home are not passed on.
 */
export type GroupEvent =
  | ({ type: "message" } & GroupMessage)
  | { type: "joined" | "left" | "removed"; id: string; seat: number; session: GroupSession }
  | { type: "started" | "host-changed" | "ended"; id: string; session: GroupSession };

/** Options for `client.group.open`. */
export interface GroupOpenOptions {
  /** People to show ticked in the sheet (a rematch); the person still taps Send.
   *  At most {@link GROUP_PICK_MAX_PLAYERS} − 1. */
  suggest?: SessionTarget[];
}

/** Options for `client.group.send`. */
export interface GroupSendOptions {
  /** Only these seats get it (sealed to their households). Leave out to send
   *  to everyone. Never your own seat. */
  to?: number[];
  /** This message hands that seat the turn: while their app is closed Social
   *  Home shows them "Your turn". */
  turn?: number;
  /**
   * The game's last message (a win, a draw, a resignation, a claimed
   * timeout): Social Home ends the table right after this message — as
   * `ended` with `endReason: "finished"`, shown under Finished in the space —
   * and still delivers it to everyone, also to a closed app's mailbox. Only
   * while the table is being played; at a table of more than two only the
   * host may (`"group_not_host"`). A Social Home without it (before group
   * play shipped `final`) sends it as an ordinary message: the table stays open.
   */
  final?: boolean;
}

const GROUP_STATES: readonly string[] = ["lobby", "playing", "ended"];
const PLAYER_STATES: readonly string[] = ["seated", "left", "removed"];

/**
 * Read a table as the host sends it without trusting its shape: `undefined`
 * when it isn't a table; a player that isn't a well-formed seat is left out.
 * Reads the bridge's camelCase and core's snake_case view alike.
 */
export function parseGroupSession(v: unknown): GroupSession | undefined {
  if (!isRecord(v)) return undefined;
  const id = field(v, "id", "session_id");
  const state = v["state"];
  const min = v["min"];
  const max = v["max"];
  if (!isGroupId(id) || typeof state !== "string" || !GROUP_STATES.includes(state)) return undefined;
  if (!isInt(min, 2, GROUP_MAX_PLAYERS) || !isInt(max, min, GROUP_MAX_PLAYERS)) return undefined;
  const players: GroupPlayer[] = [];
  const seats = new Set<number>();
  const raw = Array.isArray(v["players"]) ? v["players"] : [];
  for (const p of raw.slice(0, GROUP_MAX_PLAYERS * 2)) {
    if (!isRecord(p)) continue;
    const seat = p["seat"];
    const ps = p["state"];
    if (!isInt(seat, 1, GROUP_SEAT_MAX) || seats.has(seat)) continue;
    if (typeof ps !== "string" || !PLAYER_STATES.includes(ps)) continue;
    const name = optText(p["name"], GROUP_NAME_MAX);
    if (name === undefined) continue;
    seats.add(seat);
    players.push({
      seat,
      name,
      household: optText(p["household"], GROUP_NAME_MAX) ?? null,
      isLocal: field(p, "isLocal", "is_local") === true,
      state: ps as GroupPlayer["state"],
    });
  }
  players.sort((a, b) => a.seat - b.seat);
  const host = v["host"];
  const me = v["me"];
  const out: GroupSession = {
    id,
    state: state as GroupState,
    me: isInt(me, 1, GROUP_SEAT_MAX) ? me : null,
    myState: optText(field(v, "myState", "my_state"), 40) ?? "joining",
    host: isInt(host, 1, GROUP_SEAT_MAX) ? host : null,
    isHost: field(v, "isHost", "is_host") === true,
    min,
    max,
    lateJoin: field(v, "lateJoin", "late_join") === true,
    players,
  };
  const appId = optText(field(v, "appId", "app_id"), 40);
  if (appId) out.appId = appId;
  const endReason = optText(field(v, "endReason", "end_reason"), 40);
  if (state === "ended" && endReason) out.endReason = endReason;
  const spaceId = optText(field(v, "spaceId", "space_id"), 128);
  if (spaceId) out.spaceId = spaceId;
  const seq = v["seq"];
  if (isInt(seq, 0, Number.MAX_SAFE_INTEGER)) out.seq = seq;
  const note = optText(v["note"], GROUP_NAME_MAX);
  if (note) out.note = note;
  return out;
}

/** Read a list of tables (bad rows left out). */
export function parseGroupSessions(v: unknown): GroupSession[] {
  if (!Array.isArray(v)) return [];
  const out: GroupSession[] = [];
  for (const row of v) {
    const g = parseGroupSession(row);
    if (g) out.push(g);
  }
  return out;
}

/**
 * Read a message at a table without trusting its shape (`undefined` when it
 * isn't one). Reads core's spelling too (`session_id`, `from_seat`).
 */
export function parseGroupMessage(v: unknown): GroupMessage | undefined {
  if (!isRecord(v)) return undefined;
  const id = v["id"] ?? v["session_id"];
  const seq = v["seq"];
  const from = v["from"] ?? v["from_seat"];
  if (!isGroupId(id) || !isInt(seq, 1, Number.MAX_SAFE_INTEGER) || !isInt(from, 1, GROUP_SEAT_MAX)) {
    return undefined;
  }
  const msg: GroupMessage = { id, seq, from, data: v["data"], direct: v["direct"] === true };
  if (v["held"] === true) msg.held = true;
  return msg;
}

/** Read one event the host pushed (`undefined` when malformed or unknown). */
export function parseGroupEvent(v: unknown): GroupEvent | undefined {
  if (!isRecord(v)) return undefined;
  const type = v["type"];
  if (type === "message") {
    const msg = parseGroupMessage(v);
    return msg ? { type, ...msg } : undefined;
  }
  const session = parseGroupSession(v["session"]);
  const id = v["id"];
  if (!session || !isGroupId(id) || session.id !== id) return undefined;
  switch (type) {
    case "joined":
    case "left":
    case "removed": {
      const seat = v["seat"];
      return isInt(seat, 1, GROUP_SEAT_MAX) ? { type, id, seat, session } : undefined;
    }
    case "started":
    case "host-changed":
    case "ended":
      return { type, id, session };
    default:
      return undefined;
  }
}

// ---------------------------------------------------------------------------
// The `group` calls
// ---------------------------------------------------------------------------

/** The `group` calls of one client (see {@link withGroups}). */
function groupApi(client: SocialHomeClient) {
  const subs = new Set<(event: GroupEvent) => void>();
  /** The `seq`s of each table already handed to the app (dedupe). */
  const seenByTable = new Map<string, Set<number>>();

  /** Mark a message seen; `false` when it already was (a repeat). */
  const firstSeen = (msg: GroupMessage): boolean => {
    let seen = seenByTable.get(msg.id);
    if (!seen) {
      seen = new Set();
      seenByTable.set(msg.id, seen);
    }
    if (seen.has(msg.seq)) return false;
    seen.add(msg.seq);
    if (seen.size > GROUP_SEEN_MAX) {
      // Forget the oldest; a repeat that old is no longer expected.
      const oldest = seen.values().next().value;
      if (oldest !== undefined) seen.delete(oldest);
    }
    return true;
  };

  /** A `group` call: an older host's `unknown_method` reads as
   *  `groups_not_supported`. */
  const call = (method: string, params?: unknown, timeoutMs = CALL_TIMEOUT_MS): Promise<unknown> =>
    client._call(method, params, timeoutMs).catch((err: unknown) => {
      if (err instanceof ShError && err.code === "unknown_method") {
        throw new ShError("groups_not_supported", "This Social Home has no group games.");
      }
      throw err;
    });

  /** A table reply, else a typed refusal. */
  const reply = (r: unknown): GroupSession => {
    const g = parseGroupSession(r);
    if (!g) throw new ShError("error", "Social Home answered without a table.");
    return g;
  };

  // A table changed, or a message at a table.
  client._onPush(GROUP_BRIDGE.event, (data) => {
    const event = parseGroupEvent(data["event"]);
    if (!event) return;
    if (event.type === "message" && !firstSeen(event)) return;
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
     * Ask Social Home to open a table: its sheet asks the person who to play
     * with (up to {@link GROUP_PICK_MAX_PLAYERS} players, them included,
     * within the app's `players`), they tap Send, and Social Home invites
     * them. Resolves with the new table (in `lobby`, the person seated as
     * host) — `null` when they cancel. Call it from a button the person
     * pressed. A Social Home without the group sheet yet refuses it
     * `"unavailable"`.
     */
    open: (options: GroupOpenOptions = {}): Promise<GroupSession | null> => {
      const params: Record<string, unknown> = {};
      if (options.suggest !== undefined) {
        if (!Array.isArray(options.suggest) || options.suggest.length > GROUP_PICK_MAX_PLAYERS - 1) {
          return Promise.reject(
            new ShError("invalid", `suggest takes at most ${GROUP_PICK_MAX_PLAYERS - 1} people.`),
          );
        }
        params["suggest"] = options.suggest.map(({ instance_id, user_ref, is_local }) => ({
          instance_id,
          user_ref,
          is_local,
        }));
      }
      return call(GROUP_BRIDGE.open, params, PICK_TIMEOUT_MS).then((r) =>
        r === null || r === undefined ? null : reply(r),
      );
    },

    /** The tables the person has a place at in this app (invited, joining,
     *  seated, or one they left that Social Home still keeps). */
    list: (): Promise<GroupSession[]> => call(GROUP_BRIDGE.list).then(parseGroupSessions),

    /** One table the person has a place at (`"group_not_found"` otherwise). */
    get: (id: string): Promise<GroupSession> =>
      call(GROUP_BRIDGE.get, { id }).then((r) => reply(r)),

    /** Host only: start the game once at least `min` players are seated
     *  (`"group_too_few"` before). Unanswered invites are withdrawn unless the
     *  app takes late joiners. A table of two starts by itself. */
    start: (id: string): Promise<GroupSession> =>
      call(GROUP_BRIDGE.start, { id }).then((r) => reply(r)),

    /**
     * Send `data` to everyone at the table, or only to the seats in `to`
     * (sealed to their households: nobody else — not even the host's
     * household — can read it). Resolves once the person's household took it,
     * with its `seq` when this household is the host's (else `null`: the host
     * numbers it). Your own message is not echoed back: apply it yourself.
     *
     * A closed app gets only **each player's latest message** when it opens
     * (`group.held`): send state, not steps (≤ 16 KiB to be kept; up to
     * 64 KiB goes out live only, `"too_large"` above). For many players
     * answering at once (a quiz), send answers **to the host's seat only** and
     * let the host send one result to everyone — the table has a send budget
     * (`"group_busy"`, {@link ShError.retryAfterMs}).
     *
     * `turn` names the seat this message hands the turn to: while their app
     * is closed Social Home shows them "Your turn". `to` / `turn` seats must
     * be seated now (`"group_seat"`). `final: true` on the game's last
     * message ends the table (`endReason: "finished"`) once it is delivered.
     * An `ended` event can reach the other player before that last message:
     * take `group.held` and later messages before you call a game
     * unfinished when its table ended `"finished"`.
     */
    send: (id: string, data: unknown, options: GroupSendOptions = {}): Promise<number | null> => {
      const params: Record<string, unknown> = { id, data };
      if (options.to !== undefined) {
        const to = options.to;
        if (
          !Array.isArray(to) ||
          to.length === 0 ||
          to.length >= GROUP_MAX_PLAYERS ||
          !to.every((s) => isInt(s, 1, GROUP_SEAT_MAX)) ||
          new Set(to).size !== to.length
        ) {
          return Promise.reject(new ShError("invalid", "to must name one or more different seats."));
        }
        params["to"] = [...to];
      }
      if (options.turn !== undefined) {
        if (!isInt(options.turn, 1, GROUP_SEAT_MAX)) {
          return Promise.reject(new ShError("invalid", "turn must be a seat number."));
        }
        params["turn"] = options.turn;
      }
      if (options.final !== undefined) {
        if (typeof options.final !== "boolean") {
          return Promise.reject(new ShError("invalid", "final must be true or false."));
        }
        if (options.final) params["final"] = true;
      }
      return call(GROUP_BRIDGE.send, params).then((r) => {
        const seq = isRecord(r) ? r["seq"] : undefined;
        return isInt(seq, 1, Number.MAX_SAFE_INTEGER) ? seq : null;
      });
    },

    /** Leave a table (before Start the seat is free again; a host who leaves
     *  a lobby closes it, after Start the host passes on). */
    leave: (id: string): Promise<void> =>
      call(GROUP_BRIDGE.leave, { id }).then(() => {
        seenByTable.delete(id);
      }),

    /** Host only: take the player in `seat` out; they can't come back. */
    remove: (id: string, seat: number): Promise<GroupSession> => {
      if (!isInt(seat, 1, GROUP_SEAT_MAX)) {
        return Promise.reject(new ShError("invalid", "seat must be a seat number."));
      }
      return call(GROUP_BRIDGE.remove, { id, seat }).then((r) => reply(r));
    },

    /** Host only: close the table for everyone (it ends `cancelled`). */
    close: (id: string): Promise<void> =>
      call(GROUP_BRIDGE.close, { id }).then(() => undefined),

    /**
     * Messages at tables that arrived while the app was closed: **each
     * player's latest message** per table, oldest `seq` first, minus any the
     * app already got live. Social Home hands them over once per open, so
     * call it once your own state is loaded, with `context({ pullHeld: true })`
     * — without it they arrive as `message` events right after `context()`.
     */
    held: (): Promise<GroupMessage[]> =>
      call(GROUP_BRIDGE.held).then((r) => {
        const msgs: GroupMessage[] = [];
        for (const row of Array.isArray(r) ? r : []) {
          if (isRecord(row) && row["type"] !== undefined && row["type"] !== "message") continue;
          const m = parseGroupMessage(row);
          if (m) msgs.push(m);
        }
        // Tables in the order the host gave them, each table by seq.
        const order = [...new Set(msgs.map((m) => m.id))];
        msgs.sort((a, b) => order.indexOf(a.id) - order.indexOf(b.id) || a.seq - b.seq);
        return msgs.filter((m) => firstSeen(m));
      }),

    /**
     * Hear what happens at tables: messages, people joining and leaving, the
     * start, a new host, the end — see {@link GroupEvent}. A message the app
     * already got (by `seq`) is not passed on twice.
     * @returns an unsubscribe function.
     */
    onEvent: (cb: (event: GroupEvent) => void): Unsubscribe => {
      subs.add(cb);
      return () => {
        subs.delete(cb);
      };
    },
  };
}

/** The group-game calls: `client.group` after {@link withGroups}. */
export type GroupApi = ReturnType<typeof groupApi>;

/**
 * Group games — tables of 2–30 players (SDK 1.9, Social Home v_76). The app
 * never opens anything itself: `open` asks Social Home's sheet, where the
 * person picks who to play with. The household of the person who opened the
 * table (the *host household*) keeps the seats and passes every message on,
 * numbered (`seq`) so every player sees the same order.
 *
 * People are **seats**, never usernames: each player is a seat number, a
 * name and a household name ({@link GroupPlayer}).
 *
 * Check {@link AppContext.groups} first: on an older Social Home every call
 * is refused with {@link ShError} code `"groups_not_supported"` — offer 1:1
 * games instead.
 *
 * ```ts
 * import sh from "@socialhome/app-sdk";
 * import { withGroups } from "@socialhome/app-sdk/group";
 * const client = withGroups(sh!);
 * client.group.onEvent(onTableEvent);
 * ```
 *
 * Call it once, at start-up, before `context()`: the client hears table
 * events from then on. Calling it again on the same client returns it as it
 * is. The calls live in this module, so an app that doesn't use group games
 * doesn't carry them (SDK 2.0; before, every client had `group`).
 */
export function withGroups<C extends SocialHomeClient>(client: C): C & { readonly group: GroupApi } {
  const c = client as C & { group?: GroupApi };
  if (c && c.group === undefined) {
    Object.defineProperty(c, "group", { value: groupApi(c), enumerable: true });
  }
  return c as C & { readonly group: GroupApi };
}
