/**
 * Game-invite lifecycle and the saved game entry — pure helpers (no DOM, no
 * SDK calls), unit-tested. The same patterns as Chess and Battleships:
 *
 *  - Invites are played from Social Home ("Play" in Needs you): the app
 *    starts a received game only from `context().launch`; a live `open` is
 *    news, not a game (unless an older Social Home sends no launch).
 *  - `{verb: "close", reason}` session events: "declined" reaches the
 *    inviter, "withdrawn" the invitee, "ended" either side when the other
 *    household removed Go. A close never creates a game.
 *  - A send to a session Social Home no longer knows fails with
 *    `unknown_session`: offer "Continue game with Ben".
 *
 * A game is saved as its log (plus who plays which colour on which board);
 * the board is always rebuilt from the log (`stateOf`), never read back.
 */

import { parseSessionPayload, ShError } from "@socialhome/app-sdk";
import type { AppMessage, Contact, LaunchContext, PickedPerson, SessionTarget } from "@socialhome/app-sdk";
import { t } from "./i18n.js";
import { isHandicap, isSize, other } from "./rules.js";
import type { Color, Size } from "./rules.js";
import { NO_RULES, replay } from "./game.js";
import type { Entry, GameState, Rules } from "./game.js";
import { isClockDays, parseLog } from "./inbound.js";
import { turnClock } from "./clock.js";
import type { ClockMark, TurnClock } from "./clock.js";

export type Role = "inviter" | "invitee";

export interface GameEntry {
  sessionId: string;
  opponentInstanceId: string;
  /** The opponent's `user_ref` (local user_id or remote username). */
  opponentRef: string;
  opponentIsLocal: boolean;
  opponentName: string;
  role: Role;
  /** `null` for the invitee until the inviter's first message says. */
  size: Size | null;
  myColor: Color | null;
  /** Handicap stones for Black (0 = none) and days per move (0 = no clock). */
  handicap: number;
  days: number;
  log: Entry[];
  /** A message from the opponent was taken (their invite is answered). */
  heard: boolean;
  updatedAt: number;
  /** Our newest step didn't reach Social Home: "Retry". */
  unsent?: boolean;
  /** Messages refused in a row (shown as a calm notice from 1 on). */
  outOfStep?: number;
  /** Clock: when this side started counting the current turn (own clock only). */
  clockFrom?: ClockMark;
  /** Clock: we claimed the win at this log length (their Go has to confirm). */
  claimedAt?: number;
  /** Clock: their Go refused our claim and counts until `at` (our clock) for log length `n`. */
  theirHint?: ClockMark;
  /** Clock: "Keep playing" hid the claim offer at this log length. */
  claimHiddenAt?: number;
}

/** The handicap and clock of a game. */
export function rulesOf(entry: Pick<GameEntry, "handicap" | "days">): Rules {
  return { handicap: entry.handicap, days: entry.days };
}

const cache = new WeakMap<readonly Entry[], GameState | null>();

/** The game as it stands, rebuilt from the log (cached per log array). */
export function stateOf(entry: GameEntry): GameState | null {
  if (entry.size === null) return null;
  if (cache.has(entry.log)) return cache.get(entry.log)!;
  const r = replay(entry.size, entry.log, rulesOf(entry));
  const st = r ? r.state : null;
  cache.set(entry.log, st);
  return st;
}

/** Seed the cache with a state we just built for *log* (no second replay). */
export function remember(log: readonly Entry[], state: GameState): void {
  cache.set(log, state);
}

/** A saved entry, checked; `null` if it can't be read or its log doesn't replay. */
export function parseEntry(v: unknown): GameEntry | null {
  if (typeof v !== "object" || v === null) return null;
  const e = v as Record<string, unknown>;
  if (
    typeof e["sessionId"] !== "string" ||
    typeof e["opponentInstanceId"] !== "string" ||
    typeof e["opponentName"] !== "string" ||
    (e["role"] !== "inviter" && e["role"] !== "invitee")
  ) {
    return null;
  }
  const size = e["size"] === null ? null : isSize(e["size"]) ? e["size"] : undefined;
  const myColor = e["myColor"] === null ? null : e["myColor"] === "b" || e["myColor"] === "w" ? e["myColor"] : undefined;
  if (size === undefined || myColor === undefined || (size === null) !== (myColor === null)) return null;
  // Saved before handicap and clock existed: none of either.
  const handicap = e["handicap"] === undefined ? 0 : e["handicap"];
  const days = e["days"] === undefined ? 0 : e["days"];
  if (size !== null ? !isHandicap(size, handicap) : handicap !== 0) return null;
  if (!isClockDays(days)) return null;
  const log = size === null ? (Array.isArray(e["log"]) && e["log"].length === 0 ? [] : null) : parseLog(e["log"], size);
  if (!log) return null;
  const entry: GameEntry = {
    sessionId: e["sessionId"],
    opponentInstanceId: e["opponentInstanceId"],
    opponentRef: typeof e["opponentRef"] === "string" ? e["opponentRef"] : "",
    opponentIsLocal: e["opponentIsLocal"] === true,
    opponentName: e["opponentName"],
    role: e["role"],
    size,
    myColor,
    handicap: handicap as number,
    days: days as number,
    log,
    heard: e["heard"] === true,
    updatedAt: typeof e["updatedAt"] === "number" ? e["updatedAt"] : 0,
    ...(e["unsent"] === true ? { unsent: true } : {}),
  };
  const clockFrom = parseMark(e["clockFrom"]);
  if (clockFrom) entry.clockFrom = clockFrom;
  const theirHint = parseMark(e["theirHint"]);
  if (theirHint) entry.theirHint = theirHint;
  if (isCount(e["claimedAt"])) entry.claimedAt = e["claimedAt"];
  if (isCount(e["claimHiddenAt"])) entry.claimHiddenAt = e["claimHiddenAt"];
  if (size !== null && !stateOf(entry)) return null;
  return entry;
}

function isCount(v: unknown): v is number {
  return typeof v === "number" && Number.isInteger(v) && v >= 0;
}

function parseMark(v: unknown): ClockMark | null {
  if (typeof v !== "object" || v === null) return null;
  const m = v as Record<string, unknown>;
  return isCount(m["n"]) && typeof m["at"] === "number" && Number.isFinite(m["at"]) ? { n: m["n"], at: m["at"] } : null;
}

/** The running turn's clock as this side sees it (`null`: no clock, over, not answered yet). */
export function clockOf(entry: GameEntry, now = Date.now()): TurnClock | null {
  const st = stateOf(entry);
  if (!st || entry.myColor === null) return null;
  return turnClock(
    {
      state: st,
      myColor: entry.myColor,
      logLength: entry.log.length,
      clockFrom: entry.clockFrom,
      awaiting: isAwaitingOpponent(entry),
      theirHint: entry.theirHint,
    },
    now,
  );
}

/** We claimed the win for the game as it stands and wait for their Go to confirm. */
export function hasPendingClaim(entry: GameEntry): boolean {
  return entry.claimedAt === entry.log.length && !isOver(entry);
}

/** "Ben's time ran out": offer Claim the win (not after Keep playing, not twice). */
export function canClaim(entry: GameEntry, now = Date.now()): boolean {
  const c = clockOf(entry, now);
  return !!c && !c.mine && c.expired && !hasPendingClaim(entry) && !entry.unsent;
}

/** Show the "time ran out" banner with its two buttons. */
export function showClaimOffer(entry: GameEntry, now = Date.now()): boolean {
  return canClaim(entry, now) && entry.claimHiddenAt !== entry.log.length;
}

/** What gets saved: the entry without anything rebuilt. */
export function toStored(entry: GameEntry): GameEntry {
  return { ...entry, log: [...entry.log] };
}

/**
 * The person's name for sentences: Social Home names someone from another
 * household "Ben · Lakeside"; "Ben's turn" reads better. Headers keep the
 * full name.
 */
export function personName(entry: GameEntry): string {
  return entry.opponentName.split(" · ")[0].trim() || entry.opponentName;
}

/** The target that addresses the opponent of *entry*. */
export function targetFor(entry: GameEntry): SessionTarget {
  return { instance_id: entry.opponentInstanceId, user_ref: entry.opponentRef, is_local: entry.opponentIsLocal };
}

export function isOver(entry: GameEntry): boolean {
  return stateOf(entry)?.phase === "over";
}

/** Our own invite, not answered yet: we invited and nothing came back. */
export function isAwaitingOpponent(entry: GameEntry): boolean {
  return entry.role === "inviter" && !entry.heard && !isOver(entry);
}

/** A received invite we haven't played in yet (no step of ours). */
export function isUnansweredInvite(entry: GameEntry): boolean {
  if (entry.role !== "invitee" || isOver(entry)) return false;
  const st = entry.size === null ? null : replay(entry.size, entry.log, rulesOf(entry));
  return !st || !st.actors.includes(entry.myColor!);
}

export function isMyTurn(entry: GameEntry): boolean {
  const st = stateOf(entry);
  return !!st && st.phase !== "over" && st.toMove === entry.myColor;
}

/** The person who sent an event: the host's `fromUser`, else the payload's `from_user`. */
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
    if (reason === "ended" && !isOver(entry)) return { kind: "ended", entry };
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
  | { kind: "start"; invite: AppMessage }
  | { kind: "open"; sessionId: string }
  | { kind: "mismatch" }
  | { kind: "gone" };

/** What to do with the launch context Social Home opened the app with. */
export function launchAction(launch: LaunchContext | undefined, games: ReadonlyMap<string, GameEntry>): LaunchAction {
  const sessionId = launch?.sessionId;
  if (!sessionId) return { kind: "none" };
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

/**
 * Social Home has checked that `msg.sessionId` is a game the sender plays
 * with this person; anything inside the payload naming a game is ignored.
 */
export function routeInbound(msg: AppMessage, games: ReadonlyMap<string, GameEntry>): InboundRoute {
  const entry = games.get(msg.sessionId);
  if (!entry) return { kind: "drop", reason: "unknown-game" };
  if (!fromOpponent(entry, msg)) return { kind: "drop", reason: "not-opponent" };
  return { kind: "game", entry };
}

/** The entry for a person picked in Social Home's invite sheet (we invited them). */
export function entryForPicked(p: PickedPerson, size: Size, myColor: Color, rules: Rules = NO_RULES, now = Date.now()): GameEntry {
  return {
    sessionId: p.sessionId,
    opponentInstanceId: p.instance_id,
    opponentRef: p.user_ref,
    opponentIsLocal: p.is_local,
    opponentName: p.display_name,
    role: "inviter",
    size,
    myColor,
    handicap: rules.handicap,
    days: rules.days,
    log: [],
    heard: false,
    updatedAt: now,
    clockFrom: { n: 0, at: now },
  };
}

/** The entry for an invite Play opened (we were invited; size and colours follow). */
export function entryForInvite(msg: AppMessage, contacts: readonly Contact[], now = Date.now()): GameEntry {
  const fromUser = senderOf(msg);
  const contact = contacts.find((c) => c.instance_id === msg.fromInstance && c.user_ref === fromUser);
  return {
    sessionId: msg.sessionId,
    opponentInstanceId: msg.fromInstance,
    opponentRef: fromUser ?? "",
    opponentIsLocal: isLocalOpponent(msg.fromInstance, fromUser, contacts),
    opponentName: contact?.display_name ?? fromUser ?? msg.fromInstance,
    role: "invitee",
    size: null,
    myColor: null,
    handicap: 0,
    days: 0,
    log: [],
    heard: false,
    updatedAt: now,
  };
}

/** Whether an inviter shares our household (from the contacts Social Home lists). */
export function isLocalOpponent(fromInstance: string, fromUser: string | undefined, contacts: readonly Contact[]): boolean {
  const known = contacts.find((c) => c.instance_id === fromInstance && c.user_ref === fromUser);
  if (known) return known.is_local;
  const own = contacts.find((c) => c.is_local)?.instance_id;
  return own !== undefined && own === fromInstance;
}

export type ColorChoice = Color | "random";

/** The inviter's colour for a choice; *rand* in [0, 1). */
export function resolveColor(choice: ColorChoice, rand: number = Math.random()): Color {
  if (choice === "random") return rand < 0.5 ? "b" : "w";
  return choice;
}

/**
 * A rematch keeps the board, the handicap and the clock. It swaps colours —
 * except with a handicap: the stones were for the player who took Black,
 * so they keep Black.
 */
export function rematchOf(entry: GameEntry): { size: Size; color: Color; rules: Rules } | null {
  if (entry.size === null || entry.myColor === null) return null;
  const color = entry.handicap > 0 ? entry.myColor : other(entry.myColor);
  return { size: entry.size, color, rules: rulesOf(entry) };
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
