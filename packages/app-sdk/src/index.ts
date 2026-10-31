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
 *   Host → app:  { type: 'app.context-changed', context }       the person switched language
 *                                                               or theme ({@link AppLook})
 *   Host → app:  { type: 'group:event', event }                  something happened at a table
 *                                                               ({@link GroupEvent}, {@link GROUP_BRIDGE})
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
  /**
   * The table Join or Play opened the app for (a group game, SDK 1.9) —
   * `sessionId` is its id. Show its lobby or the game.
   */
  group?: GroupSession;
}

/**
 * What the household agreed to when an admin added the app, in plain words:
 * `storage` (saves its own data), `people` (lets you pick people to play
 * with) and `federation` (sends to other households; implies `people`).
 * A call outside them is refused with {@link ShError.code} `"permission_denied"`.
 */
export type Permission = "storage" | "people" | "federation";

/**
 * The eight colours Social Home hands an app, each a plain `#rrggbb` /
 * `#rrggbbaa` string — see {@link applyTheme} for the CSS variable each one
 * becomes.
 *
 * - `bg` — the page background · `surface` — cards, panels, dialogs
 * - `text` — body text · `muted` — secondary text (≥ 4.5:1 on bg and surface)
 * - `accent` — primary buttons, highlights · `onAccent` — text on an accent fill
 * - `border` — hairlines, dividers · `focus` — the keyboard focus ring
 */
export interface ThemeTokens {
  bg: string;
  surface: string;
  text: string;
  muted: string;
  accent: string;
  onAccent: string;
  border: string;
  focus: string;
}

/** The token names, in a fixed order. */
export const TOKEN_NAMES = [
  "bg", "surface", "text", "muted", "accent", "onAccent", "border", "focus",
] as const satisfies readonly (keyof ThemeTokens)[];

/** The CSS variable {@link applyTheme} sets for each token. */
export const TOKEN_CSS_VARS: Record<keyof ThemeTokens, string> = {
  bg: "--sh-bg",
  surface: "--sh-surface",
  text: "--sh-text",
  muted: "--sh-muted",
  accent: "--sh-accent",
  onAccent: "--sh-on-accent",
  border: "--sh-border",
  focus: "--sh-focus",
};

/**
 * How the app should look (owner decision D14) — the person's language, its
 * direction, light or dark, reduced motion and the colour tokens. Every field
 * is `undefined` on an older Social Home: default to English, left-to-right
 * and your own colours.
 */
export interface AppLook {
  /** The person's Social Home language (`"en"`, `"de"`, `"pt-BR"`, …). Fall back to English. */
  locale?: string;
  dir?: "ltr" | "rtl";
  /** What Social Home shows right now (its Auto setting already resolved). */
  theme?: "light" | "dark";
  /** The person asked for less motion: skip animations. */
  reducedMotion?: boolean;
  /** The colours; a token that isn't a plain hex colour is left out. */
  tokens?: Partial<ThemeTokens>;
}

const HEX_COLOR = /^#[0-9a-f]{6}([0-9a-f]{2})?$/i;
const LOCALE_TAG = /^[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8})*$/;

/** Read the look the host sent without trusting its shape: a field that isn't
 *  what it says is left out — never a string that could carry CSS. */
export function parseLook(v: unknown): AppLook {
  if (!isRecord(v)) return {};
  const out: AppLook = {};
  const { locale, dir, theme, reducedMotion, tokens } = v;
  if (typeof locale === "string" && locale.length <= 35 && LOCALE_TAG.test(locale)) out.locale = locale;
  if (dir === "ltr" || dir === "rtl") out.dir = dir;
  if (theme === "light" || theme === "dark") out.theme = theme;
  if (typeof reducedMotion === "boolean") out.reducedMotion = reducedMotion;
  if (isRecord(tokens)) {
    const t: Partial<ThemeTokens> = {};
    for (const name of TOKEN_NAMES) {
      const c = tokens[name];
      if (typeof c === "string" && HEX_COLOR.test(c)) t[name] = c;
    }
    if (Object.keys(t).length > 0) out.tokens = t;
  }
  return out;
}

/**
 * Apply the look's colours to the app's own page: each token becomes a CSS
 * variable on `:root` ({@link TOKEN_CSS_VARS}: `--sh-bg`, `--sh-surface`,
 * `--sh-text`, `--sh-muted`, `--sh-accent`, `--sh-on-accent`, `--sh-border`,
 * `--sh-focus`), `color-scheme` follows `theme` (native controls, scrollbars),
 * and `data-theme` / `data-reduced-motion` are set for your CSS selectors.
 * Only valid hex colours are written. Write your CSS with fallbacks
 * (`var(--sh-bg, #1a1a2e)`) so an older Social Home still looks right.
 *
 * ```ts
 * const ctx = await sh.context();
 * applyTheme(ctx);
 * sh.onContextChange(applyTheme);
 * ```
 */
export function applyTheme(look: AppLook, root: HTMLElement = document.documentElement): void {
  const tokens = look.tokens ?? {};
  for (const name of TOKEN_NAMES) {
    const c = tokens[name];
    if (typeof c === "string" && HEX_COLOR.test(c)) root.style.setProperty(TOKEN_CSS_VARS[name], c);
  }
  if (look.theme === "light" || look.theme === "dark") {
    root.style.colorScheme = look.theme;
    root.dataset["theme"] = look.theme;
  }
  if (typeof look.reducedMotion === "boolean") {
    root.dataset["reducedMotion"] = String(look.reducedMotion);
  }
}

/** App context returned by {@link SocialHomeClient.context}. */
export interface AppContext extends AppLook {
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
  /**
   * `true` when this Social Home hosts group games — the `sh.group` calls
   * work (SDK 1.9). `undefined` on an older Social Home: offer 1:1 games
   * only. (Opening a table also needs `tables: true` in the manifest.)
   */
  groups?: boolean;
}

/** Options for {@link SocialHomeClient.federation} `send` (SDK ≥ 1.8). */
export interface SendOptions {
  /**
   * `true` when this message passes the turn to the other player. Social
   * Home (2026.10.30+) then shows them "Your turn with … in …" while the app
   * is closed. Only an exact `true` counts.
   */
  turn?: boolean;
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
  const group = parseGroupSession(v["group"]);
  if (group && (out.sessionId === undefined || out.sessionId === group.id)) {
    out.sessionId = group.id;
    out.group = group;
  }
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
 * - `"ended"` — the other household uninstalled the app, so the game is over
 *   (Social Home v_72, SDK 1.7). Reaches either side, for a game being played
 *   or an invite; Social Home also tells the person in its own notifications.
 *   Clear the game. A household on an older Social Home sends `"withdrawn"`
 *   for an invite instead, and nothing for a game.
 *
 * Other values may appear in later Social Home versions: treat an unknown
 * reason (or none) as a plain close.
 */
export type SessionCloseReason = "declined" | "withdrawn" | "ended";

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
 * {@link SocialHomeClient.onSession} (a close: declined / withdrawn / ended).
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
 *   for that person (not opened through the sheet, not taken in with Play,
 *   or quiet for more than 90 days) — offer `people.pick({purpose: "continue"})`.
 * - `"invalid"` — `people.pick({purpose: "continue"})` without `sessionId` or `suggest`.
 * - `"unavailable"` — this host can't show the invite sheet.
 * - `"unknown_method"` — an older Social Home without the call.
 * - `"groups_not_supported"` — a `sh.group` call on a Social Home without
 *   group games: offer 1:1 games instead.
 * - Group games (`sh.group`): `"group_not_found"` (no place at that table),
 *   `"group_not_host"` (only the host may), `"group_closed"` (the table
 *   ended, or you aren't seated), `"group_full"`, `"group_too_few"` (fewer
 *   than `min` seated), `"group_seat"` (a `to` / `turn` seat isn't seated,
 *   or is your own), `"group_busy"` (the table's send budget is spent; try
 *   again after {@link ShError.retryAfterMs}), `"too_large"` (over 64 KiB),
 *   `"cant_join"` (the household keeps the person out — no reason given).
 * - `"error"` — anything else (`message` says what).
 */
export type ShErrorCode =
  | "permission_denied"
  | "use_people_pick"
  | "busy"
  | "too_soon"
  | "unknown_session"
  | "invalid"
  | "unavailable"
  | "unknown_method"
  | "groups_not_supported"
  | "group_not_found"
  | "group_not_host"
  | "group_closed"
  | "group_full"
  | "group_too_few"
  | "group_seat"
  | "group_busy"
  | "too_large"
  | "cant_join"
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
  /**
   * What the sheet is for. A fixed word — Social Home writes the sheet.
   * - `"play"` (default): invite someone to a new game.
   * - `"continue"`: pick up a game Social Home no longer knows (a send was
   *   refused with `"unknown_session"`) with the person you name in
   *   `suggest` — the sheet asks "Continue game with Ben"; needs `sessionId`.
   */
  purpose?: "play" | "continue";
  /** How many people may be picked (1–10, default 1; always 1 to continue). */
  max?: number;
  /** One person to show selected (a rematch), or the opponent to continue
   *  with. The person still taps Send. */
  suggest?: SessionTarget;
  /** `"continue"` only: your own id for the game to pick up again. */
  sessionId?: string;
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
 * | `group.send` | `{id, data, to?: number[], turn?: number}` | `{seq: number \| null}` |
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
export const GROUP_BRIDGE = Object.freeze({
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
const GROUP_SEAT_MAX = 999;
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
  /** The table's id — use it for every `sh.group` call. */
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
 * What `sh.group.onEvent` hears:
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

/** Options for `sh.group.open`. */
export interface GroupOpenOptions {
  /** People to show ticked in the sheet (a rematch); the person still taps Send.
   *  At most {@link GROUP_PICK_MAX_PLAYERS} − 1. */
  suggest?: SessionTarget[];
}

/** Options for `sh.group.send`. */
export interface GroupSendOptions {
  /** Only these seats get it (sealed to their households). Leave out to send
   *  to everyone. Never your own seat. */
  to?: number[];
  /** This message hands that seat the turn: while their app is closed Social
   *  Home shows them "Your turn". */
  turn?: number;
}

const GROUP_ID = /^[A-Za-z0-9_-]{1,128}$/;
const GROUP_STATES: readonly string[] = ["lobby", "playing", "ended"];
const PLAYER_STATES: readonly string[] = ["seated", "left", "removed"];

function isInt(v: unknown, min: number, max: number): v is number {
  return typeof v === "number" && Number.isInteger(v) && v >= min && v <= max;
}

function optText(v: unknown, max: number): string | undefined {
  return typeof v === "string" && v && [...v].length <= max ? v : undefined;
}

function isGroupId(v: unknown): v is string {
  return typeof v === "string" && GROUP_ID.test(v);
}

/** A field in the bridge's camelCase, or core's snake_case. */
function field(v: Record<string, unknown>, camel: string, snake: string): unknown {
  return camel in v ? v[camel] : v[snake];
}

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
  private readonly _contextSubs = new Set<(look: AppLook) => void>();
  private readonly _groupSubs = new Set<(event: GroupEvent) => void>();
  /** The `seq`s of each table already handed to the app (dedupe). */
  private readonly _groupSeen = new Map<string, Set<number>>();

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

    // The person switched language or theme while the app is open.
    if (data["type"] === "app.context-changed") {
      const look = parseLook(data["context"]);
      for (const cb of this._contextSubs) {
        try {
          cb(look);
        } catch {
          // Never let a subscriber crash the message loop.
        }
      }
      return;
    }

    // A table changed, or a message at a table (SDK 1.9).
    if (data["type"] === GROUP_BRIDGE.event) {
      this._onGroupPush(data);
      return;
    }

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

  private _emitGroup(event: GroupEvent): void {
    for (const cb of this._groupSubs) {
      try {
        cb(event);
      } catch {
        // Never let a subscriber crash the message loop.
      }
    }
  }

  /** Mark a message seen; `false` when it already was (a repeat). */
  private _firstSeen(msg: GroupMessage): boolean {
    let seen = this._groupSeen.get(msg.id);
    if (!seen) {
      seen = new Set();
      this._groupSeen.set(msg.id, seen);
    }
    if (seen.has(msg.seq)) return false;
    seen.add(msg.seq);
    if (seen.size > GROUP_SEEN_MAX) {
      // Forget the oldest; a repeat that old is no longer expected.
      const oldest = seen.values().next().value;
      if (oldest !== undefined) seen.delete(oldest);
    }
    return true;
  }

  private _onGroupPush(data: Record<string, unknown>): void {
    const event = parseGroupEvent(data["event"]);
    if (!event) return;
    if (event.type === "message" && !this._firstSeen(event)) return;
    this._emitGroup(event);
  }

  /** A `sh.group` call: an older host's `unknown_method` reads as
   *  `groups_not_supported`. */
  private _groupCall(method: string, params?: unknown, timeoutMs = CALL_TIMEOUT_MS): Promise<unknown> {
    return this._call(method, params, timeoutMs).catch((err: unknown) => {
      if (err instanceof ShError && err.code === "unknown_method") {
        throw new ShError("groups_not_supported", "This Social Home has no group games.");
      }
      throw err;
    });
  }

  /** A table reply, else a typed refusal. */
  private _groupReply(r: unknown): GroupSession {
    const g = parseGroupSession(r);
    if (!g) throw new ShError("error", "Social Home answered without a table.");
    return g;
  }

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
        ...parseLook(o),
        appId: String(o["appId"] ?? ""),
        selfUserId: String(o["selfUserId"] ?? ""),
      };
      const launch = parseLaunchContext(o["launch"]);
      if (launch !== undefined) {
        ctx.launch = launch;
      }
      if (o["groups"] === true) ctx.groups = true;
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
      if (options.sessionId !== undefined) params["sessionId"] = options.sessionId;
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
     * @param options `{ turn: true }` when this message hands the other
     *   player the turn (a move, a shot): while their app is closed Social
     *   Home shows them one "Your turn with … in …" row per game. Leave it
     *   out for anything informational (a chat line, a final result). An
     *   older Social Home ignores it and delivers the message as before.
     */
    send: (
      sessionId: string,
      target: SessionTarget,
      payload: unknown,
      options?: SendOptions,
    ): Promise<void> =>
      this._call("app.send", {
        session_id: sessionId,
        target,
        payload,
        ...(options?.turn === true ? { turn: true } : {}),
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
   */
  readonly group = {
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
      return this._groupCall(GROUP_BRIDGE.open, params, PICK_TIMEOUT_MS).then((r) =>
        r === null || r === undefined ? null : this._groupReply(r),
      );
    },

    /** The tables the person has a place at in this app (invited, joining,
     *  seated, or one they left that Social Home still keeps). */
    list: (): Promise<GroupSession[]> => this._groupCall(GROUP_BRIDGE.list).then(parseGroupSessions),

    /** One table the person has a place at (`"group_not_found"` otherwise). */
    get: (id: string): Promise<GroupSession> =>
      this._groupCall(GROUP_BRIDGE.get, { id }).then((r) => this._groupReply(r)),

    /** Host only: start the game once at least `min` players are seated
     *  (`"group_too_few"` before). Unanswered invites are withdrawn unless the
     *  app takes late joiners. A table of two starts by itself. */
    start: (id: string): Promise<GroupSession> =>
      this._groupCall(GROUP_BRIDGE.start, { id }).then((r) => this._groupReply(r)),

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
     * be seated now (`"group_seat"`).
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
      return this._groupCall(GROUP_BRIDGE.send, params).then((r) => {
        const seq = isRecord(r) ? r["seq"] : undefined;
        return isInt(seq, 1, Number.MAX_SAFE_INTEGER) ? seq : null;
      });
    },

    /** Leave a table (before Start the seat is free again; a host who leaves
     *  a lobby closes it, after Start the host passes on). */
    leave: (id: string): Promise<void> =>
      this._groupCall(GROUP_BRIDGE.leave, { id }).then(() => {
        this._groupSeen.delete(id);
      }),

    /** Host only: take the player in `seat` out; they can't come back. */
    remove: (id: string, seat: number): Promise<GroupSession> => {
      if (!isInt(seat, 1, GROUP_SEAT_MAX)) {
        return Promise.reject(new ShError("invalid", "seat must be a seat number."));
      }
      return this._groupCall(GROUP_BRIDGE.remove, { id, seat }).then((r) => this._groupReply(r));
    },

    /** Host only: close the table for everyone (it ends `cancelled`). */
    close: (id: string): Promise<void> =>
      this._groupCall(GROUP_BRIDGE.close, { id }).then(() => undefined),

    /**
     * Messages at tables that arrived while the app was closed: **each
     * player's latest message** per table, oldest `seq` first, minus any the
     * app already got live. Social Home hands them over once per open, so
     * call it once your own state is loaded, with `context({ pullHeld: true })`
     * — without it they arrive as `message` events right after `context()`.
     */
    held: (): Promise<GroupMessage[]> =>
      this._groupCall(GROUP_BRIDGE.held).then((r) => {
        const msgs: GroupMessage[] = [];
        for (const row of Array.isArray(r) ? r : []) {
          if (isRecord(row) && row["type"] !== undefined && row["type"] !== "message") continue;
          const m = parseGroupMessage(row);
          if (m) msgs.push(m);
        }
        // Tables in the order the host gave them, each table by seq.
        const order = [...new Set(msgs.map((m) => m.id))];
        msgs.sort((a, b) => order.indexOf(a.id) - order.indexOf(b.id) || a.seq - b.seq);
        return msgs.filter((m) => this._firstSeen(m));
      }),

    /**
     * Hear what happens at tables: messages, people joining and leaving, the
     * start, a new host, the end — see {@link GroupEvent}. A message the app
     * already got (by `seq`) is not passed on twice.
     * @returns an unsubscribe function.
     */
    onEvent: (cb: (event: GroupEvent) => void): Unsubscribe => {
      this._groupSubs.add(cb);
      return () => {
        this._groupSubs.delete(cb);
      };
    },
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

  /**
   * Hear when the person switches language or theme (or the system flips
   * light/dark under Social Home's Auto) while the app is open. The callback
   * gets the whole new {@link AppLook}: re-apply it
   * (`sh.onContextChange(applyTheme)`) and re-render your strings. Never fires
   * on an older Social Home.
   * @returns an unsubscribe function.
   */
  onContextChange(cb: (look: AppLook) => void): Unsubscribe {
    this._contextSubs.add(cb);
    return () => {
      this._contextSubs.delete(cb);
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
