/**
 * @socialhome/app-sdk
 *
 * Runs inside a Social Home App's sandboxed iframe and communicates with the
 * host SPA over postMessage. Wire protocol:
 *
 *   App → host:  { id, method, params }                        posted to window.parent
 *   Host → app:  { id, ok: true, result }                       on success
 *                { id, ok: false, error }                        on failure — `error` is
 *                  `{code, message, permission?, retryAfterMs?}`  (a string on older hosts),
 *                  rejected as an {@link ShError}
 *   Host → app:  { type: 'app:event', kind, sessionId,          real-time relay of an
 *                  fromInstance, payload }                       inbound federation message
 *
 * `kind` is `'message'` for an in-game/app message and `'session'` for a
 * session-control event (e.g. a game invite). `sessionId` scopes the
 * conversation (a game), `fromInstance` identifies the sender household — so an
 * app can run many concurrent games with different friends and route each
 * message to the right one.
 *
 * Source validation: every inbound message whose source is not `window.parent`
 * is silently discarded so a rogue third-party frame cannot inject fake replies.
 * The SDK never has, and never exposes, the user's auth token.
 */

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/** Narrow an unknown value to a string-keyed record. */
function isRecord(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === "object";
}

/** Pending RPC call waiting for a host reply. */
interface PendingCall {
  resolve: (value: unknown) => void;
  reject: (reason: unknown) => void;
  timer: ReturnType<typeof setTimeout>;
}

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/**
 * Why the app was opened — {@link AppContext.launch}.
 *
 * Social Home keeps every game invite in the person's "Needs you" until they
 * tap **Play** there. Play opens the app with the invite's session: Social
 * Home accepts that one invite and hands it over here. Opening the app any
 * other way accepts nothing.
 *
 * - `{}` — opened normally (Apps page, a notification): no game to start.
 * - `{ sessionId, invite }` — opened by Play: `invite` was accepted just now;
 *   start that game (feed it to your `onSession` invite handler) and show it.
 * - `{ sessionId }` — opened by Play, but the invite no longer waits (played
 *   on another device, declined, withdrawn, expired): show that game if you
 *   already have it, else say the invite is gone.
 */
export interface LaunchContext {
  /** The game Play opened the app for. */
  sessionId?: string;
  /** The invite, when Social Home accepted it for this launch. */
  invite?: AppMessage;
}

/**
 * What the household agreed to when an admin added the app, in plain words:
 * `storage` (saves its own data), `people` (lets you pick people to play
 * with) and `federation` (sends to other households; implies `people`).
 * A call outside them is refused with {@link ShError.code} `"permission_denied"`.
 */
export type Permission = "storage" | "people" | "federation";

/** App context returned by {@link SocialHomeClient.context}. */
export interface AppContext {
  appId: string;
  selfUserId: string;
  /**
   * The permissions this app has (see {@link Permission}) — leave out what
   * the app may not do (e.g. "play someone in another household" without
   * `federation`). `undefined` on a Social Home from before permissions,
   * which offers everything.
   */
  permissions?: Permission[];
  /**
   * Why the app was opened — see {@link LaunchContext}. **`undefined` on a
   * Social Home from before launch contexts**: that host
   * hands every waiting invite to {@link SocialHomeClient.federation.pendingSessions}
   * and accepts them when the app opens, so keep that path for it. When
   * `launch` is present (even `{}`), invites are played from Social Home:
   * don't seat live `open` events as games — they still wait in "Needs you".
   */
  launch?: LaunchContext;
}

/** Read an invite as the host sends it in a launch context. */
function toAppMessage(v: unknown): AppMessage | undefined {
  if (!isRecord(v) || typeof v["sessionId"] !== "string" || !v["sessionId"]) return undefined;
  return {
    sessionId: v["sessionId"],
    fromInstance: String(v["fromInstance"] ?? ""),
    fromUser: typeof v["fromUser"] === "string" ? v["fromUser"] : undefined,
    payload: v["payload"],
  };
}

/** Read a launch context without trusting its shape (`undefined` = an older host). */
export function parseLaunchContext(v: unknown): LaunchContext | undefined {
  if (!isRecord(v)) return undefined;
  const out: LaunchContext = {};
  if (typeof v["sessionId"] === "string" && v["sessionId"]) out.sessionId = v["sessionId"];
  const invite = toAppMessage(v["invite"]);
  if (out.sessionId && invite && invite.sessionId === out.sessionId) out.invite = invite;
  return out;
}

/** A paired household peer returned by {@link SocialHomeClient.peers}. */
export interface Peer {
  instance_id: string;
  display_name: string;
}

/**
 * A person returned by {@link SocialHomeClient.contacts}: someone the person
 * picked in Social Home's invite sheet, or plays with in this app.
 */
export interface Contact {
  instance_id: string;
  user_ref: string;      // local user_id when is_local, else the remote username
  /** "Ben · Familie Okafor" for someone in another household. */
  display_name: string;
  is_local: boolean;
  online: boolean;
  /** The bare name ("Ben"); Social Home 2026.10 and newer. */
  person_name?: string;
  /** Their household's name; `null` for your own. Social Home 2026.10 and newer. */
  household_name?: string | null;
}

/** Addresses a specific person for a session. */
export interface SessionTarget {
  instance_id: string;
  user_ref: string;
  is_local: boolean;
}

/**
 * A real-time message relayed from another household. `sessionId` is the
 * game/conversation it belongs to; `fromInstance` is the sender household's
 * `instance_id` (match it against {@link Peer.instance_id} to show a name).
 * `fromUser` carries the challenger/sender identity when the host includes it.
 */
export interface AppMessage {
  sessionId: string;
  fromInstance: string;
  fromUser?: string;   // challenger/sender identity for display (optional)
  payload: unknown;
}

/**
 * Why the other side ended a session, carried as `reason` on a
 * `{verb: "close"}` session event:
 *
 * - `"declined"` — the invitee said no (from Social Home's "Needs you").
 *   Reaches the challenger's app.
 * - `"withdrawn"` — the challenger took the invite back with
 *   {@link SocialHomeClient.federation.cancelSession}. Reaches the invitee's app.
 *
 * Other values may appear in later Social Home versions: treat an unknown
 * reason (or none) as a plain close.
 */
export type SessionCloseReason = "declined" | "withdrawn";

/**
 * The control fields of a `session` event's payload ({@link AppMessage.payload}
 * delivered to {@link SocialHomeClient.onSession}), as read by
 * {@link parseSessionPayload}.
 */
export interface SessionControl {
  /** `"open"` (an invite), `"accept"` or `"close"`; `undefined` when absent. */
  verb?: string;
  /** Only on a `"close"`: see {@link SessionCloseReason}. */
  reason?: string;
}

/**
 * Read the `verb` / `reason` of a session event's payload without trusting
 * its shape. Non-string fields read as `undefined`.
 */
export function parseSessionPayload(payload: unknown): SessionControl {
  if (!isRecord(payload)) return {};
  const verb = payload["verb"];
  const reason = payload["reason"];
  return {
    verb: typeof verb === "string" ? verb : undefined,
    reason: typeof reason === "string" ? reason : undefined,
  };
}

/**
 * A message Social Home kept for this person while the app was closed or
 * turned off — see {@link SocialHomeClient.federation.held}. The same fields
 * as a live event, plus which subscription it belongs to: `"message"` for
 * {@link SocialHomeClient.onMessage} (a move), `"session"` for
 * {@link SocialHomeClient.onSession} (a close: declined / withdrawn).
 */
export interface HeldMessage extends AppMessage {
  kind: "message" | "session";
}

/** Options for {@link SocialHomeClient.context}. */
export interface ContextOptions {
  /**
   * Fetch held messages yourself with {@link SocialHomeClient.federation.held}
   * once your own state is loaded (recommended). Without it, Social Home posts
   * them as ordinary live events right after `context()` answers — so they
   * reach only the handlers already subscribed by then.
   */
  pullHeld?: boolean;
}

/** Read the host's held-message rows without trusting their shape. */
export function parseHeldMessages(v: unknown): HeldMessage[] {
  if (!Array.isArray(v)) return [];
  const out: HeldMessage[] = [];
  for (const row of v) {
    const msg = toAppMessage(row);
    if (!msg || !isRecord(row)) continue;
    out.push({ ...msg, kind: row["kind"] === "session" ? "session" : "message" });
  }
  return out;
}

/**
 * Why the host refused a call — {@link ShError.code}. Unknown codes may appear
 * in later Social Home versions; treat them as a plain failure.
 *
 * - `"permission_denied"` — outside the app's permissions ({@link ShError.permission} says which).
 * - `"use_people_pick"` — `federation.openSession` is gone: invites go through `people.pick`.
 * - `"busy"` — an invite sheet is already open.
 * - `"too_soon"` — the sheet just closed; try again after {@link ShError.retryAfterMs}.
 * - `"unknown_session"` — `federation.send` to a game Social Home doesn't know
 *   for that person (not opened through the sheet, not taken in with Play).
 * - `"unavailable"` — this host can't show the invite sheet.
 * - `"unknown_method"` — an older Social Home without the call.
 * - `"error"` — anything else (`message` says what).
 */
export type ShErrorCode =
  | "permission_denied"
  | "use_people_pick"
  | "busy"
  | "too_soon"
  | "unknown_session"
  | "unavailable"
  | "unknown_method"
  | "error"
  | (string & {});

/** A refused call. An `Error`, so existing `catch` blocks keep working. */
export class ShError extends Error {
  readonly code: ShErrorCode;
  /** On `"permission_denied"`: the permission the call needed. */
  readonly permission?: Permission;
  /** On `"too_soon"`: how long until the sheet may open again. */
  readonly retryAfterMs?: number;

  constructor(
    code: ShErrorCode,
    message: string,
    extra: { permission?: Permission; retryAfterMs?: number } = {},
  ) {
    super(message);
    this.name = "ShError";
    this.code = code;
    if (extra.permission !== undefined) this.permission = extra.permission;
    if (extra.retryAfterMs !== undefined) this.retryAfterMs = extra.retryAfterMs;
  }
}

/** Read a host error reply (a string from older hosts, `{code, message, …}` since 2026.10). */
export function toShError(v: unknown): ShError {
  if (typeof v === "string") return new ShError("error", v);
  if (!isRecord(v)) return new ShError("error", "Unknown error from host");
  const code = typeof v["code"] === "string" && v["code"] ? v["code"] : "error";
  const message = typeof v["message"] === "string" && v["message"] ? v["message"] : code;
  const p = v["permission"];
  const permission = p === "storage" || p === "people" || p === "federation" ? p : undefined;
  const r = v["retryAfterMs"];
  const retryAfterMs = typeof r === "number" && Number.isFinite(r) && r >= 0 ? r : undefined;
  return new ShError(code, message, { permission, retryAfterMs });
}

/** Options for `people.pick`. */
export interface PickOptions {
  /** What the invite is for. A fixed word — Social Home writes the sheet. */
  purpose?: "play";
  /** How many people may be picked (1–10, default 1). */
  max?: number;
  /** One person to show selected (a rematch). The person still taps Send. */
  suggest?: SessionTarget;
}

/** A person picked in Social Home's invite sheet, with the game it opened. */
export interface PickedPerson extends SessionTarget {
  display_name: string;
  /** The session Social Home opened with them — use it for `federation.send`. */
  sessionId: string;
}

/** Read the host's picked people without trusting their shape. */
export function parsePicked(v: unknown): PickedPerson[] {
  if (!Array.isArray(v)) return [];
  const out: PickedPerson[] = [];
  for (const row of v) {
    if (!isRecord(row)) continue;
    const { instance_id, user_ref, is_local, display_name, session_id } = row;
    if (typeof instance_id !== "string" || !instance_id) continue;
    if (typeof user_ref !== "string" || !user_ref) continue;
    if (typeof is_local !== "boolean") continue;
    if (typeof session_id !== "string" || !session_id) continue;
    out.push({
      instance_id,
      user_ref,
      is_local,
      display_name: typeof display_name === "string" && display_name ? display_name : user_ref,
      sessionId: session_id,
    });
  }
  return out;
}

/** Unsubscribe function returned by the `on*` subscription methods. */
export type Unsubscribe = () => void;

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const CALL_TIMEOUT_MS = 15_000;
/** `people.pick` waits for a person to choose: give them time. */
const PICK_TIMEOUT_MS = 30 * 60_000;

// ---------------------------------------------------------------------------
// Client implementation
// ---------------------------------------------------------------------------

/**
 * The main SDK client. Use the pre-built singleton {@link sh} or call
 * {@link createClient} to obtain an instance with injected windows (useful in
 * tests).
 */
export class SocialHomeClient {
  private readonly _parent: Window;
  private readonly _self: Window;
  private _nextId = 1;
  private readonly _pending = new Map<number, PendingCall>();
  private readonly _messageSubs = new Set<(msg: AppMessage) => void>();
  private readonly _sessionSubs = new Set<(msg: AppMessage) => void>();

  constructor(targetWindow: Window, parentWindow: Window) {
    this._parent = targetWindow;
    this._self = parentWindow;
    this._self.addEventListener("message", this._onMessage);
  }

  /** @internal Tear down the listener (used in tests). */
  destroy(): void {
    this._self.removeEventListener("message", this._onMessage);
    for (const pending of this._pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(new Error("SocialHomeClient destroyed"));
    }
    this._pending.clear();
  }

  // -------------------------------------------------------------------------
  // Core RPC machinery
  // -------------------------------------------------------------------------

  private _onMessage = (event: MessageEvent): void => {
    // Source validation: ignore anything not from the host frame.
    if (event.source !== this._parent) return;

    const data: unknown = event.data;
    if (!isRecord(data)) return;

    // Real-time relayed federation event.
    if (data["type"] === "app:event") {
      const msg: AppMessage = {
        sessionId: String(data["sessionId"] ?? ""),
        fromInstance: String(data["fromInstance"] ?? ""),
        fromUser: data["fromUser"] != null ? String(data["fromUser"]) : undefined,
        payload: data["payload"],
      };
      const subs = data["kind"] === "session" ? this._sessionSubs : this._messageSubs;
      for (const cb of subs) {
        try {
          cb(msg);
        } catch {
          // Never let a subscriber crash the message loop.
        }
      }
      return;
    }

    // RPC reply.
    if (typeof data["id"] !== "number") return;
    const id = data["id"];
    const pending = this._pending.get(id);
    if (pending === undefined) return;
    clearTimeout(pending.timer);
    this._pending.delete(id);
    if (data["ok"] === true) {
      pending.resolve(data["result"]);
    } else {
      pending.reject(toShError(data["error"]));
    }
  };

  private _call(method: string, params?: unknown, timeoutMs = CALL_TIMEOUT_MS): Promise<unknown> {
    return new Promise<unknown>((resolve, reject) => {
      const id = this._nextId++;
      const timer = setTimeout(() => {
        if (this._pending.has(id)) {
          this._pending.delete(id);
          reject(new Error(`RPC timeout: ${method} (id=${id})`));
        }
      }, timeoutMs);
      this._pending.set(id, { resolve, reject, timer });
      const msg =
        params !== undefined ? { id, method, params } : { id, method };
      this._parent.postMessage(msg, "*");
    });
  }

  // -------------------------------------------------------------------------
  // Public API
  // -------------------------------------------------------------------------

  /** Key-value store scoped to this app and the current user. */
  readonly store = {
    /** Retrieve a stored value by key. Resolves to `null` if absent. */
    get: (key: string): Promise<unknown> => this._call("store.get", { key }),
    /** Persist a value (any JSON-serialisable data) under `key`. */
    set: (key: string, value: unknown): Promise<void> =>
      this._call("store.set", { key, value }).then(() => undefined),
    /** Remove the entry for `key`. */
    delete: (key: string): Promise<void> =>
      this._call("store.delete", { key }).then(() => undefined),
    /** List all of this user's stored key-value pairs for this app. */
    list: (): Promise<Record<string, unknown>> =>
      this._call("store.list").then((r) => (isRecord(r) ? r : {})),
  };

  /**
   * Identity context for the running app instance (no auth token), and why
   * it was opened ({@link AppContext.launch}). Call it first, as soon as the
   * app starts — Social Home shows the app once it asks. Pass
   * `{ pullHeld: true }` to fetch messages kept while the app was closed with
   * {@link SocialHomeClient.federation.held} yourself (see {@link ContextOptions}).
   */
  context(options: ContextOptions = {}): Promise<AppContext> {
    const params = options.pullHeld ? { held: "pull" } : undefined;
    return this._call("app.context", params).then((r) => {
      const o = isRecord(r) ? r : {};
      const ctx: AppContext = {
        appId: String(o["appId"] ?? ""),
        selfUserId: String(o["selfUserId"] ?? ""),
      };
      const launch = parseLaunchContext(o["launch"]);
      if (launch !== undefined) ctx.launch = launch;
      const perms = o["permissions"];
      if (Array.isArray(perms)) {
        ctx.permissions = perms.filter(
          (p): p is Permission => p === "storage" || p === "people" || p === "federation",
        );
      }
      return ctx;
    });
  }

  /** List the confirmed peer households this app can play with. */
  peers(): Promise<Peer[]> {
    return this._call("peers.list").then((r) => (Array.isArray(r) ? (r as Peer[]) : []));
  }

  /**
   * The people this app knows about for the person using it: whom they
   * picked in Social Home's invite sheet and whom they play with in this app
   * (invites they sent, games they took in with Play). Never the household
   * or friends list — to play someone new, use `people.pick`. (A Social Home
   * from before the invite sheet still lists everyone the person can message.)
   */
  contacts(): Promise<Contact[]> {
    return this._call("contacts.list").then((r) => (Array.isArray(r) ? (r as Contact[]) : []));
  }

  /** Invite people — through Social Home, never straight from the app. */
  readonly people = {
    /**
     * Ask Social Home to show its invite sheet. Social Home draws it outside
     * the app (from the people the person may invite — the app never sees
     * that list), the person picks and taps Send, and Social Home sends the
     * invite(s). Resolves with who was picked and the session Social Home
     * opened with each — `[]` when they cancel. Then send your opening state
     * with `federation.send(person.sessionId, person, …)`.
     *
     * One sheet at a time (`"busy"`); after one closes the same app waits
     * 5 s (`"too_soon"`, {@link ShError.retryAfterMs}). Call it from a button
     * the person pressed ("New game", "Rematch"). An older Social Home
     * rejects it with `"unknown_method"`.
     */
    pick: (options: PickOptions = {}): Promise<PickedPerson[]> => {
      const params: Record<string, unknown> = {
        purpose: options.purpose ?? "play",
        max: options.max ?? 1,
      };
      if (options.suggest) {
        const { instance_id, user_ref, is_local } = options.suggest;
        params["suggest"] = { instance_id, user_ref, is_local };
      }
      return this._call("people.pick", params, PICK_TIMEOUT_MS).then(parsePicked);
    },
  };

  /** Cross-household federation helpers. */
  readonly federation = {
    /**
     * @deprecated Invites go through Social Home: use `people.pick`. A Social
     * Home with the invite sheet refuses this ({@link ShError} code
     * `"use_people_pick"`); older ones still open the session.
     */
    openSession: (target: SessionTarget): Promise<string> =>
      this._call("app.openSession", { target }).then((r) => String(r)),

    /**
     * Send a payload to a specific person within an existing session — one
     * Social Home opened for them (`people.pick`) or one they took in with
     * Play. Any other session id is refused with {@link ShError} code
     * `"unknown_session"`. The recipient receives it via
     * {@link SocialHomeClient.onMessage}.
     * @param target  the person on the other side of that session.
     */
    send: (
      sessionId: string,
      target: SessionTarget,
      payload: unknown,
    ): Promise<void> =>
      this._call("app.send", {
        session_id: sessionId,
        target,
        payload,
      }).then(() => undefined),

    /**
     * Withdraw an invite you sent (e.g. the person never answered and you
     * cancel the game). The invitee's "Needs you" item goes away and their
     * app receives a `session` event with payload
     * `{verb: "close", reason: "withdrawn"}`.
     * Needs a Social Home host that knows `app.cancelSession` (2026.10+);
     * older hosts reject the call.
     * @param sessionId  the id {@link federation.openSession} returned.
     * @param target     the same person the session was opened with.
     */
    cancelSession: (sessionId: string, target: SessionTarget): Promise<void> =>
      this._call("app.cancelSession", { sessionId, target }).then(() => undefined),

    /**
     * Messages Social Home kept while this app was closed or turned off — the
     * **latest message of each session** only, oldest first. Social Home
     * hands them over once per open (they are cleared then), so call it once
     * your own state is loaded and feed each one to the handler you pass to
     * {@link SocialHomeClient.onMessage} (`kind: "message"`) or
     * {@link SocialHomeClient.onSession} (`kind: "session"`).
     *
     * Because only the latest message waits, **send state, not deltas** (or
     * resync from your own store on open), and dedupe: a held message may
     * repeat one you already received live, or be older than what you have.
     *
     * Pair it with `context({ pullHeld: true })`; without that Social Home
     * has already pushed them as live events, and this returns the same ones.
     * An older Social Home (before held messages) rejects the call.
     */
    held: (): Promise<HeldMessage[]> =>
      this._call("app.held").then(parseHeldMessages),

    /**
     * For a Social Home **without** launch contexts ({@link AppContext.launch}
     * `undefined`): drain session invites the host buffered while this app
     * was closed. Returns each invite once, as an {@link AppMessage} — feed
     * them into the same handler you pass to {@link SocialHomeClient.onSession}.
     *
     * On a Social Home with launch contexts it returns only the invite Play
     * opened the app for (the same as `launch.invite`), else `[]` — the host
     * never hands out every waiting invite. Prefer `launch`.
     */
    pendingSessions: (): Promise<AppMessage[]> =>
      this._call("app.pendingSessions").then((r) =>
        Array.isArray(r)
          ? r.map((row): AppMessage => {
              const o = isRecord(row) ? row : {};
              return {
                sessionId: String(o["session_id"] ?? ""),
                fromInstance: String(o["from_instance"] ?? ""),
                fromUser:
                  typeof o["from_user"] === "string" ? o["from_user"] : undefined,
                payload: o["payload"],
              };
            })
          : [],
      ),
  };

  /**
   * Subscribe to in-session real-time messages from peer households (e.g. an
   * opponent's chess move). The callback receives `{sessionId, fromInstance,
   * payload}` so you can route to the right game and identify the sender.
   * @returns an unsubscribe function.
   */
  onMessage(cb: (msg: AppMessage) => void): Unsubscribe {
    this._messageSubs.add(cb);
    return () => {
      this._messageSubs.delete(cb);
    };
  }

  /**
   * Subscribe to incoming session events (e.g. "a friend invited you to play").
   * Fires when a peer calls {@link federation.openSession} targeting this
   * person. With launch contexts ({@link AppContext.launch} present) a live
   * `open` is news only — the invite waits in Social Home's "Needs you" and
   * reaches you as `launch.invite` when the person taps Play. Your own
   * invites are never echoed back to you. The callback receives `{sessionId, fromInstance, payload}`
   * (payload carries the session info, e.g. `{verb:'open'}`). The same
   * subscription receives `{verb: "close", reason}` when the other side ends
   * the session — read it with {@link parseSessionPayload}; see
   * {@link SessionCloseReason}.
   * @returns an unsubscribe function.
   */
  onSession(cb: (msg: AppMessage) => void): Unsubscribe {
    this._sessionSubs.add(cb);
    return () => {
      this._sessionSubs.delete(cb);
    };
  }
}

// ---------------------------------------------------------------------------
// Singleton
// ---------------------------------------------------------------------------

/**
 * Factory used by the singleton and by tests.
 * @param targetWindow  the window to post to (default `window.parent`).
 * @param parentWindow  the window whose `message` events to listen on (default `window`).
 */
export function createClient(
  targetWindow: Window = window.parent,
  parentWindow: Window = window,
): SocialHomeClient {
  return new SocialHomeClient(targetWindow, parentWindow);
}

/**
 * Pre-built singleton. Import and use directly inside an app:
 *
 * ```ts
 * import { sh } from '@socialhome/app-sdk';
 * const { appId } = await sh!.context();
 * ```
 *
 * `null` in non-browser environments (e.g. test runners) — use
 * {@link createClient} with injected windows in tests.
 */
const sh: SocialHomeClient | null =
  typeof window !== "undefined" ? createClient() : null;

export default sh;
export { sh };
