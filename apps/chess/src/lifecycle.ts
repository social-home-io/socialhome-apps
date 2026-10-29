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
 *
 * A close with no or an unknown reason changes nothing (as before), and a
 * close never creates a game.
 */

import { parseSessionPayload } from "@socialhome/app-sdk";
import type { AppMessage } from "@socialhome/app-sdk";
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

/** Decide what an inbound `session` event means for the games we know. */
export function classifySessionEvent(
  msg: AppMessage,
  games: ReadonlyMap<string, GameEntry>,
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
    return { kind: "ignore" };
  }

  // An invite: `open`, or no verb at all (older hosts / replayed rows).
  if (verb === undefined || verb === "open") return { kind: "invite" };
  return { kind: "ignore" };
}

/** Toast shown to the challenger when the invitee declines. */
export function declinedMessage(name: string): string {
  return `${name} declined the game.`;
}

/** Toast shown to the invitee when the challenger withdraws the invite. */
export function withdrawnMessage(name: string): string {
  return `${name} took the invite back.`;
}

/** Copy for the in-app confirm shown before a game is abandoned or removed. */
export interface ConfirmCopy {
  title: string;
  body: string;
  confirm: string;
  cancel: string;
}

/** Lobby button label: "Abandon" for a game in play, "Remove" for a finished one. */
export function abandonButtonLabel(entry: GameEntry): string {
  return entry.state.result === null ? "Abandon" : "Remove";
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
      title: `Remove your game with ${name}?`,
      body: "The finished game is removed from your games. This can't be undone.",
      confirm: "Remove game",
      cancel: "Keep it",
    };
  }
  return {
    title: `Abandon your game with ${name}?`,
    body: `The game is removed from your games and can't be resumed. ${name} isn't told, so their copy stays open.`,
    confirm: "Abandon game",
    cancel: "Keep playing",
  };
}
