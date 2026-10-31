/**
 * Game-invite lifecycle — pure helpers (no DOM, no SDK calls), unit-tested.
 * The same patterns as Chess:
 *
 *  - Invites are played from Social Home ("Play" in Needs you): the app
 *    starts a received game only from `context().launch`; a live `open` is
 *    news, not a game.
 *  - `{verb: "close", reason}` session events: "declined" reaches the
 *    challenger, "withdrawn" the invitee, "ended" either side when the other
 *    household removed Battleships. A close never creates a game.
 *  - A send to a session Social Home no longer knows fails with
 *    `unknown_session`: offer "Continue game with Ben".
 *
 * Unlike Chess, a finished game's last message must stay in the mailbox (it
 * carries the reveal), so nothing here ever sends a close after it.
 */

import { parseSessionPayload, ShError } from "@socialhome/app-sdk";
import type { AppMessage, Contact, GroupSession, LaunchContext, PickedPerson, SessionTarget } from "@socialhome/app-sdk";
import { t } from "./i18n.js";
import type { Game } from "./game.js";
import type { TableInfo } from "./table.js";

export interface GameEntry {
  sessionId: string;
  opponentInstanceId: string;
  /** The opponent's `user_ref` (local user_id or remote username). */
  opponentRef: string;
  opponentIsLocal: boolean;
  opponentName: string;
  game: Game;
  /** An open game in a space: played over that table (table.ts), not a 1:1 session. */
  table?: TableInfo;
}

/**
 * The person's name for sentences: Social Home names someone from another
 * household "Ben · Lakeside"; "Ben's waters" reads better than
 * "Ben · Lakeside's waters". Headers keep the full name.
 */
export function personName(entry: GameEntry): string {
  return entry.opponentName.split(" · ")[0].trim() || entry.opponentName;
}

/** Who the game is with, for headers — "Open game" while nobody has taken the seat at our table. */
export function opponentLabel(entry: GameEntry): string {
  return entry.opponentName || t("table.openGame");
}

/** The target that addresses the opponent of *entry*. */
export function targetFor(entry: GameEntry): SessionTarget {
  return { instance_id: entry.opponentInstanceId, user_ref: entry.opponentRef, is_local: entry.opponentIsLocal };
}

/** Our own invite, not answered yet: we challenged and nothing came back. */
export function isAwaitingOpponent(entry: GameEntry): boolean {
  if (entry.table) return false; // an open game in a space waits for a seat, not an answer
  const g = entry.game;
  return g.role === "challenger" && !g.outcome && !g.theirLeaves && g.shots.length === 0;
}

/** A received invite we haven't played in yet (no shot of ours). */
export function isUnansweredInvite(entry: GameEntry): boolean {
  if (entry.table) return false;
  const g = entry.game;
  return g.role === "invitee" && !g.outcome && g.shots.length === 0;
}

/**
 * The person who sent an event: the host's `fromUser`, else the `from_user`
 * a person-addressed payload carries. `undefined` when neither names anyone.
 */
export function senderOf(msg: AppMessage): string | undefined {
  if (msg.fromUser) return msg.fromUser;
  const p = msg.payload;
  if (typeof p === "object" && p !== null) {
    const u = (p as Record<string, unknown>)["from_user"];
    if (typeof u === "string" && u) return u;
  }
  return undefined;
}

/** The event comes from this game's opponent: same household and, when both name one, same person. */
export function fromOpponent(entry: GameEntry, msg: AppMessage): boolean {
  if (entry.table) return false; // a table game only takes table messages, by seat (table.ts)
  if (msg.fromInstance !== entry.opponentInstanceId) return false;
  const sender = senderOf(msg);
  return !(sender && entry.opponentRef && sender !== entry.opponentRef);
}

export type SessionAction =
  | { kind: "invite" }
  | { kind: "declined"; entry: GameEntry }
  | { kind: "withdrawn"; entry: GameEntry }
  | { kind: "ended"; entry: GameEntry }
  | { kind: "ignore" };

export interface InviteOptions {
  /** Seat a live `open` as a game (an older host without launch contexts). Default false. */
  liveInvites?: boolean;
  selfUserId?: string;
}

/** Decide what an inbound `session` event means for the games we know. */
export function classifySessionEvent(
  msg: AppMessage,
  games: ReadonlyMap<string, GameEntry>,
  opts: InviteOptions = {},
): SessionAction {
  const { verb, reason } = parseSessionPayload(msg.payload);
  if (verb === "close") {
    const entry = games.get(msg.sessionId);
    if (!entry || !fromOpponent(entry, msg)) return { kind: "ignore" };
    if (reason === "declined" && isAwaitingOpponent(entry)) return { kind: "declined", entry };
    if (reason === "withdrawn" && isUnansweredInvite(entry)) return { kind: "withdrawn", entry };
    if (reason === "ended" && !entry.game.outcome) return { kind: "ended", entry };
    return { kind: "ignore" };
  }
  if (verb === undefined || verb === "open") {
    if (!opts.liveInvites) return { kind: "ignore" };
    if (opts.selfUserId && senderOf(msg) === opts.selfUserId) return { kind: "ignore" };
    if (games.has(msg.sessionId)) return { kind: "ignore" };
    return { kind: "invite" };
  }
  return { kind: "ignore" };
}

export type LaunchAction =
  | { kind: "none" }
  | { kind: "table"; session: GroupSession }
  | { kind: "start"; invite: AppMessage }
  | { kind: "open"; sessionId: string }
  | { kind: "mismatch" }
  | { kind: "gone" };

/** What to do with the launch context Social Home opened the app with. */
export function launchAction(launch: LaunchContext | undefined, games: ReadonlyMap<string, GameEntry>): LaunchAction {
  const sessionId = launch?.sessionId;
  if (!sessionId) return { kind: "none" };
  if (launch.group) {
    // Join / Play for an open game in a space. A table's id never names a 1:1 game we have.
    const mine = games.get(sessionId);
    if (mine && !mine.table) return { kind: "mismatch" };
    return { kind: "table", session: launch.group };
  }
  const known = games.get(sessionId);
  if (known) {
    if (launch.invite && !fromOpponent(known, launch.invite)) return { kind: "mismatch" };
    return { kind: "open", sessionId };
  }
  if (launch.invite) return { kind: "start", invite: launch.invite };
  return { kind: "gone" };
}

/** Where an inbound message goes: the game Social Home delivered it in, from its opponent. */
export type InboundRoute = { kind: "game"; entry: GameEntry } | { kind: "drop"; reason: "unknown-game" | "not-opponent" };

export function routeInbound(msg: AppMessage, games: ReadonlyMap<string, GameEntry>): InboundRoute {
  const entry = games.get(msg.sessionId);
  if (!entry) return { kind: "drop", reason: "unknown-game" };
  if (!fromOpponent(entry, msg)) return { kind: "drop", reason: "not-opponent" };
  return { kind: "game", entry };
}

/** The entry for a person picked in Social Home's invite sheet (we challenged them). */
export function entryForPicked(p: PickedPerson, game: Game): GameEntry {
  return {
    sessionId: p.sessionId,
    opponentInstanceId: p.instance_id,
    opponentRef: p.user_ref,
    opponentIsLocal: p.is_local,
    opponentName: p.display_name,
    game,
  };
}

/** The entry for an invite Play opened (we were invited). */
export function entryForInvite(msg: AppMessage, contacts: readonly Contact[], game: Game): GameEntry {
  const fromUser = senderOf(msg);
  const contact = contacts.find((c) => c.instance_id === msg.fromInstance && c.user_ref === fromUser);
  return {
    sessionId: msg.sessionId,
    opponentInstanceId: msg.fromInstance,
    opponentRef: fromUser ?? "",
    opponentIsLocal: isLocalOpponent(msg.fromInstance, fromUser, contacts),
    opponentName: contact?.display_name ?? fromUser ?? msg.fromInstance,
    game,
  };
}

/** Whether an inviter shares our household (from the contacts Social Home lists). */
export function isLocalOpponent(fromInstance: string, fromUser: string | undefined, contacts: readonly Contact[]): boolean {
  const known = contacts.find((c) => c.instance_id === fromInstance && c.user_ref === fromUser);
  if (known) return known.is_local;
  const own = contacts.find((c) => c.is_local)?.instance_id;
  return own !== undefined && own === fromInstance;
}

/** What "New game" does when the invite sheet can't open. */
export type PickFailure = { kind: "quiet" } | { kind: "toast"; message: string };

export function pickFailure(err: unknown): PickFailure {
  const code = err instanceof ShError ? err.code : undefined;
  switch (code) {
    case "busy":
      return { kind: "quiet" };
    case "too_soon":
      return { kind: "toast", message: t("pick.tooSoon") };
    case "permission_denied":
      return { kind: "toast", message: t("pick.denied") };
    case "unknown_method":
      return { kind: "toast", message: t("pick.update") };
    default:
      return { kind: "toast", message: t("pick.failed") };
  }
}

/** Social Home no longer knows the game (quiet for more than 90 days). */
export function isUnknownGame(err: unknown): boolean {
  return err instanceof ShError && err.code === "unknown_session";
}

export interface ConfirmCopy {
  title: string;
  body: string;
  confirm: string;
  cancel: string;
  /** The confirm is the wanted step (not destructive). */
  primary?: boolean;
}

export function continueCopy(entry: GameEntry): ConfirmCopy {
  const name = personName(entry);
  return {
    title: t("continue.title"),
    body: t("continue.body", { name }),
    confirm: t("continue.confirm", { name }),
    cancel: t("continue.cancel"),
    primary: true,
  };
}

export function resignCopy(entry: GameEntry): ConfirmCopy {
  return {
    title: t("resign.title"),
    body: t("resign.body", { name: personName(entry) }),
    confirm: t("resign.confirm"),
    cancel: t("resign.cancel"),
  };
}

export function removeCopy(entry: GameEntry): ConfirmCopy {
  return {
    title: t("remove.title", { name: entry.opponentName }),
    body: t("remove.body"),
    confirm: t("remove.confirm"),
    cancel: t("remove.cancel"),
  };
}
