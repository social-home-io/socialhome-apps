/**
 * Game-invite lifecycle — pure helpers (no DOM, no SDK calls), unit-tested.
 *
 * Social Home tells an app when the other side ends a session through a
 * `session` event whose payload is `{verb: "close", reason}`:
 *
 *  - `reason: "declined"` reaches the CHALLENGER: the invitee said no from
 *    Social Home's "Needs you".
 *  - `reason: "withdrawn"` reaches the INVITEE: the challenger took the invite
 *    back (`federation.cancelSession`).
 *  - `reason: "ended"` reaches EITHER side: the opponent's household
 *    uninstalled Chess (Social Home v_72), so any game with them that isn't
 *    finished is over — invite or game in play.
 *
 * A close with no or an unknown reason changes nothing (as before), and a
 * close never creates a game.
 *
 * Invites are played from Social Home ("Play" in Needs you): on a host with
 * launch contexts (`context().launch` present) the app starts a received game
 * only from `launch` — a live `open` is news, not a game (no toast, no lobby
 * row), since the invite still waits in Needs you. An older host has no
 * `launch`, and chess keeps seating live / drained invites for it.
 */

import { parseSessionPayload, ShError } from "@socialhome/app-sdk";
import type { AppMessage, Contact, LaunchContext, PickedPerson } from "@socialhome/app-sdk";
import { initialState } from "./chess.js";
import { t } from "./i18n.js";
import type { Color, GameState } from "./chess.js";

export interface GameEntry {
  sessionId: string;
  opponentInstanceId: string;
  /** The opponent's `user_ref` (local user_id or remote username) — targets sends to the person. */
  opponentRef: string;
  /** Whether the opponent shares our household (local). */
  opponentIsLocal: boolean;
  opponentName: string;
  myColor: Color;
  state: GameState;
}

/** What the app does with an inbound `session` event. */
export type SessionAction =
  | { kind: "invite" }
  | { kind: "declined"; entry: GameEntry }
  | { kind: "withdrawn"; entry: GameEntry }
  | { kind: "ended"; entry: GameEntry }
  | { kind: "ignore" };

/**
 * True while our own invite has not been answered: we are the challenger
 * (White) and the opponent has made no move yet. The challenger may already
 * have played their first move — an invite waits for the reply, not for us.
 * Derived from the game itself, so games saved by older versions work too.
 */
export function isAwaitingOpponent(entry: GameEntry): boolean {
  return (
    entry.myColor === "w" &&
    entry.state.result === null &&
    entry.state.history.length <= 1
  );
}

/**
 * The person who sent a session event: the host's `fromUser`, else the
 * `from_user` a person-addressed session payload carries (some hosts relay
 * remote session events without the top-level `fromUser`). `undefined` when
 * neither names anyone.
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

/**
 * True when the event comes from the person this game is with: the same
 * household, and — when both sides name a person — the same person.
 */
function fromOpponent(entry: GameEntry, msg: AppMessage): boolean {
  if (msg.fromInstance !== entry.opponentInstanceId) return false;
  const sender = senderOf(msg);
  if (sender && entry.opponentRef && sender !== entry.opponentRef) {
    return false;
  }
  return true;
}

/** How chess takes in invites on this host. */
export interface InviteOptions {
  /**
   * Seat a live / drained `open` as a game (an older host without launch
   * contexts). `false` on a host with launch contexts — and until the
   * context says which host this is. Default `true`.
   */
  liveInvites?: boolean;
  /** Our own user id: an `open` from ourselves is never an invite to us. */
  selfUserId?: string;
}

/**
 * True for an `open` that we sent ourselves: an older Social Home echoed a
 * same-household invite back to the challenger, and the echo raced
 * `openSession`'s reply — chess read it as an invite from a stranger and
 * toasted "<our user id> invited you to play!".
 */
export function isOwnInvite(msg: AppMessage, selfUserId: string | undefined): boolean {
  return !!selfUserId && senderOf(msg) === selfUserId;
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
    // Declined: only our own invite that is still unanswered.
    if (reason === "declined" && isAwaitingOpponent(entry)) {
      return { kind: "declined", entry };
    }
    // Withdrawn: only an invite we received (we play Black) and haven't
    // answered with a move yet.
    if (
      reason === "withdrawn" &&
      entry.myColor === "b" &&
      entry.state.result === null &&
      entry.state.history.length <= 1
    ) {
      return { kind: "withdrawn", entry };
    }
    // Ended: the opponent's household no longer has Chess — any game with
    // them that is still going (a finished one stays as it was).
    if (reason === "ended" && entry.state.result === null) {
      return { kind: "ended", entry };
    }
    return { kind: "ignore" };
  }

  // An invite: `open`, or no verb at all (older hosts / replayed rows).
  if (verb === undefined || verb === "open") {
    if (opts.liveInvites === false) return { kind: "ignore" };
    if (isOwnInvite(msg, opts.selfUserId)) return { kind: "ignore" };
    return { kind: "invite" };
  }
  return { kind: "ignore" };
}

/** What chess does with the launch context it was opened with. */
export type LaunchAction =
  | { kind: "none" }
  | { kind: "start"; invite: AppMessage }
  | { kind: "open"; sessionId: string }
  | { kind: "mismatch" }
  | { kind: "gone" };

/**
 * Social Home opened chess for one game ("Play" in Needs you):
 * - `start` — the invite was accepted for this launch; seat it and show it.
 * - `open` — a game we already have (Play again, a reload, or its
 *   opponent picking it up again — "continue"): show it.
 * - `mismatch` — Play for a game we have, but from someone else than its
 *   opponent: refuse (a session id is never moved to another person).
 * - `gone` — the invite no longer waits and we don't know the game.
 * - `none` — opened normally, or by an older host (`launch` undefined).
 */
export function launchAction(
  launch: LaunchContext | undefined,
  games: ReadonlyMap<string, GameEntry>,
): LaunchAction {
  const sessionId = launch?.sessionId;
  if (!sessionId) return { kind: "none" };
  const known = games.get(sessionId);
  if (known) {
    // A game we have, invited by someone else than its opponent (a
    // "continue" naming our game's id): never seat them in it.
    if (launch.invite && !fromOpponent(known, launch.invite)) return { kind: "mismatch" };
    return { kind: "open", sessionId };
  }
  if (launch.invite) return { kind: "start", invite: launch.invite };
  return { kind: "gone" };
}

/** Toast when Play names a game we have but someone else than its opponent. */
export function inviteMismatchMessage(): string {
  return t("invite.mismatch");
}

/** Toast when Play opened chess for an invite that no longer waits. */
export function inviteGoneMessage(): string {
  return t("invite.gone");
}

/** Toast shown to the challenger when the invitee declines. */
export function declinedMessage(name: string): string {
  return t("invite.declined", { name });
}

/** Toast shown when the opponent's household uninstalled Chess. */
export function endedMessage(name: string): string {
  return t("invite.ended", { name });
}

/** Toast shown to the invitee when the challenger withdraws the invite. */
export function withdrawnMessage(name: string): string {
  return t("invite.withdrawn", { name });
}

/**
 * True when an incoming move's game is not ahead of ours: we already have it
 * (a live move repeated by Social Home's held copy on open) or something newer.
 * Social Home keeps only the latest message of each game while chess is closed
 * or turned off, and may hand over one chess already saw — chess sends the
 * whole game with every move, so the move count decides. Such a message
 * changes nothing (it must never roll the board back).
 */
export function isStaleMove(entry: GameEntry, incoming: GameState): boolean {
  return incoming.history.length <= entry.state.history.length;
}

/** Copy for the in-app confirm shown before a game is abandoned or removed. */
export interface ConfirmCopy {
  title: string;
  body: string;
  confirm: string;
  cancel: string;
  /** The confirm is the safe, wanted step (not destructive). */
  primary?: boolean;
}

/** Lobby button label: "Abandon" for a game in play, "Remove" for a finished one. */
export function abandonButtonLabel(entry: GameEntry): string {
  return entry.state.result === null ? t("btn.abandon") : t("btn.remove");
}

/**
 * What the confirm says before a game leaves this player's list. States the
 * real consequence: the game is gone here for good, and (today) the opponent
 * is not told — their copy stays open.
 */
export function abandonConfirmCopy(entry: GameEntry): ConfirmCopy {
  const name = entry.opponentName;
  if (entry.state.result !== null) {
    return {
      title: t("remove.title", { name }),
      body: t("remove.body"),
      confirm: t("remove.confirm"),
      cancel: t("remove.cancel"),
    };
  }
  return {
    title: t("abandon.title", { name }),
    body: t("abandon.body", { name }),
    confirm: t("abandon.confirm"),
    cancel: t("abandon.cancel"),
  };
}

// ---------------------------------------------------------------------------
// New games go through Social Home's invite sheet (`people.pick`)
// ---------------------------------------------------------------------------

/**
 * The game Social Home opened for a person picked in its invite sheet: we
 * challenged them, so we play White and the board starts fresh. The opponent
 * is exactly who was picked — the session only takes messages to them.
 */
export function entryForPicked(p: PickedPerson): GameEntry {
  return {
    sessionId: p.sessionId,
    opponentInstanceId: p.instance_id,
    opponentRef: p.user_ref,
    opponentIsLocal: p.is_local,
    opponentName: p.display_name,
    myColor: "w", // the challenger always plays White
    state: initialState(),
  };
}

/**
 * Whether an invitee shares our household — from the contact Social Home
 * lists for them (after Play they are one), else by our own household's id
 * when known, else remote.
 */
export function isLocalOpponent(
  fromInstance: string,
  fromUser: string | undefined,
  contacts: readonly Contact[],
): boolean {
  const known = contacts.find((c) => c.instance_id === fromInstance && c.user_ref === fromUser);
  if (known) return known.is_local;
  const own = contacts.find((c) => c.is_local)?.instance_id;
  return own !== undefined && own === fromInstance;
}

/** What "New game" does when the invite sheet can't open. */
export type PickFailure =
  | { kind: "legacy" } // an older Social Home: pick from chess's own list
  | { kind: "quiet" } // a sheet is already open: nothing to say
  | { kind: "toast"; message: string };

/** Read why `people.pick` failed. */
export function pickFailure(err: unknown): PickFailure {
  const code = err instanceof ShError ? err.code : undefined;
  switch (code) {
    case "unknown_method":
      return { kind: "legacy" };
    case "busy":
      return { kind: "quiet" };
    case "too_soon":
      return { kind: "toast", message: t("pick.tooSoon") };
    case "permission_denied":
      return { kind: "toast", message: t("pick.denied") };
    default:
      return { kind: "toast", message: t("pick.failed") };
  }
}

// ---------------------------------------------------------------------------
// Continue a game Social Home no longer knows
// ---------------------------------------------------------------------------

/** Whether a send failed because Social Home no longer knows the game
 *  (from before the mailbox, or quiet for more than 90 days). */
export function isUnknownGame(err: unknown): boolean {
  return err instanceof ShError && err.code === "unknown_session";
}

/** What chess asks before opening Social Home's "Continue game" sheet. */
export function continueCopy(entry: GameEntry): ConfirmCopy {
  const name = entry.opponentName;
  return {
    title: t("continue.title"),
    body: t("continue.body", { name }),
    confirm: t("continue.confirm", { name }),
    cancel: t("continue.cancel"),
    primary: true,
  };
}
