/**
 * Game-invite lifecycle and the saved game entry — pure helpers (no DOM, no
 * SDK calls), unit-tested. The same patterns as Chess, Battleships and Go:
 *
 *  - Invites are played from Social Home ("Play" in Needs you): the app
 *    starts a received game only from `context().launch`; a live `open` is
 *    news, not a game (unless an older Social Home sends no launch).
 *  - `{verb: "close", reason}` session events: "declined" reaches the
 *    inviter, "withdrawn" the invitee, "ended" either side when the other
 *    household removed the app. A close never creates a game.
 *  - A send to a session Social Home no longer knows fails with
 *    `unknown_session`: offer "Continue game with Ben".
 *
 * A game is saved as its setup, our secret dice seed, the other chain's
 * tip and newest checked link, and the log; the board is always rebuilt
 * from them (`stateOf`), never read back.
 */

import { parseSessionPayload, ShError } from "@socialhome/app-sdk";
import type { AppMessage, Contact, GroupSession, LaunchContext, PickedPerson, SessionTarget } from "@socialhome/app-sdk";
import { t } from "./i18n.js";
import { other } from "./rules.js";
import type { Color, WinKind } from "./rules.js";
import { CHAIN_LENGTH, LINK_BYTES, buildChain, bytesEqual, fromB64url, toB64url } from "./dice.js";
import { replay } from "./game.js";
import type { DiceSource, Entry, GameState, Setup } from "./game.js";
import { diceSource, isClockDays, parseLog } from "./inbound.js";
import type { LocalGame, OwnSide, Shown } from "./inbound.js";
import { turnClock } from "./clock.js";
import type { ClockMark, TurnClock } from "./clock.js";
import type { TableInfo } from "./table.js";

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
  setup: Setup | null;
  myColor: Color | null;
  /** Our secret dice seed (base64url), `null` until we have one. Never sent. */
  seed: string | null;
  /** The other chain's tip and newest link we checked (base64url). */
  theirTip: string | null;
  theirShown: { n: number; link: string } | null;
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
  /** Clock: we claimed the win at this log length (their app has to confirm). */
  claimedAt?: number;
  /** Clock: their app refused our claim and counts until `at` (our clock) for log length `n`. */
  theirHint?: ClockMark;
  /** Clock: "Keep playing" hid the claim offer at this log length. */
  claimHiddenAt?: number;
  /** An open game in a space: played over that table (table.ts), not a 1:1 session. */
  table?: TableInfo;
}

const chains = new Map<string, Uint8Array[]>();

/** Our chain for *seed* (built once per seed). */
export function chainOf(seed: string): Uint8Array[] | null {
  const cached = chains.get(seed);
  if (cached) return cached;
  const bytes = fromB64url(seed, LINK_BYTES);
  if (!bytes) return null;
  const chain = buildChain(bytes);
  chains.set(seed, chain);
  return chain;
}

export function theirShownOf(entry: Pick<GameEntry, "theirShown">): Shown | null {
  const s = entry.theirShown;
  if (!s) return null;
  const link = fromB64url(s.link, LINK_BYTES);
  return link ? { n: s.n, link } : null;
}

/** The rolls this side can know in *entry*. */
export function diceOf(entry: GameEntry): DiceSource | null {
  if (!entry.seed || !entry.myColor) return null;
  const chain = chainOf(entry.seed);
  if (!chain) return null;
  return diceSource(entry.sessionId, entry.myColor, chain, theirShownOf(entry));
}

/** What the judge needs to know about *entry*. */
export function localOf(entry: GameEntry): LocalGame {
  return {
    sid: entry.sessionId,
    role: entry.role,
    setup: entry.setup,
    myColor: entry.myColor,
    myChain: entry.seed ? chainOf(entry.seed) : null,
    theirTip: entry.theirTip ? fromB64url(entry.theirTip, LINK_BYTES) : null,
    theirShown: theirShownOf(entry),
    log: entry.log,
  };
}

const cache = new WeakMap<readonly Entry[], { n: number; state: GameState | null }>();

/** The game as it stands, rebuilt from the log (cached per log array and shown link). */
export function stateOf(entry: GameEntry): GameState | null {
  if (!entry.setup || !entry.theirTip || !entry.seed) return null;
  const n = entry.theirShown?.n ?? 0;
  const hit = cache.get(entry.log);
  if (hit && hit.n === n) return hit.state;
  const dice = diceOf(entry);
  const r = dice ? replay(entry.setup, entry.log, dice) : null;
  const st = r ? r.state : null;
  cache.set(entry.log, { n, state: st });
  return st;
}

/**
 * Another screen of this person answered the invite first (inbound.ts
 * "other-screen"): take its saved copy when its seed is the one the other
 * player holds (*myTip*). `null` while the store doesn't have that copy
 * yet (the other screen saves it with its next step); this screen's own
 * seed is never kept, so it can't overwrite the right one.
 */
export function adoptOwnCopy(entry: GameEntry, stored: GameEntry | null, myTip: Uint8Array): GameEntry | null {
  if (!stored || stored.sessionId !== entry.sessionId || !stored.seed || !stored.setup || !entry.setup) return null;
  if (stored.myColor !== entry.myColor || stored.setup.inviter !== entry.setup.inviter) return null;
  if (stored.setup.cube !== entry.setup.cube || stored.setup.days !== entry.setup.days) return null;
  const chain = chainOf(stored.seed);
  if (!chain || !bytesEqual(chain[0], myTip)) return null;
  return {
    ...entry,
    seed: stored.seed,
    theirTip: stored.theirTip,
    theirShown: stored.theirShown,
    log: stored.log,
    ...(stored.clockFrom ? { clockFrom: stored.clockFrom } : {}),
    outOfStep: 0,
  };
}

/** Seed the cache with a state we just built for *entry*'s log (no second replay). */
export function remember(entry: GameEntry, state: GameState): void {
  cache.set(entry.log, { n: entry.theirShown?.n ?? 0, state });
}

/** Our side of the next message: the link we must have shown now. */
export function ownSideOf(entry: GameEntry): OwnSide | null {
  if (!entry.setup || !entry.myColor || !entry.seed) return null;
  const chain = chainOf(entry.seed);
  if (!chain) return null;
  const st = stateOf(entry);
  const n = st ? st.reveals[entry.myColor] : 0;
  return {
    setup: entry.setup,
    myColor: entry.myColor,
    myTip: chain[0],
    theirTip: entry.theirTip ? fromB64url(entry.theirTip, LINK_BYTES) : null,
    shown: n > 0 ? { n, link: chain[n] } : null,
    log: entry.log,
  };
}

function parseSetup(v: unknown): Setup | null | undefined {
  if (v === null) return null;
  if (typeof v !== "object" || v === undefined) return undefined;
  const s = v as Record<string, unknown>;
  if ((s["inviter"] !== "w" && s["inviter"] !== "b") || typeof s["cube"] !== "boolean" || !isClockDays(s["days"])) return undefined;
  return { inviter: s["inviter"], cube: s["cube"], days: s["days"] };
}

function isLink(v: unknown): v is string {
  return fromB64url(v, LINK_BYTES) !== null;
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
  const setup = parseSetup(e["setup"]);
  const myColor = e["myColor"] === null ? null : e["myColor"] === "w" || e["myColor"] === "b" ? e["myColor"] : undefined;
  if (setup === undefined || myColor === undefined || (setup === null) !== (myColor === null)) return null;
  const seed = e["seed"] === null || e["seed"] === undefined ? null : isLink(e["seed"]) ? e["seed"] : undefined;
  const theirTip = e["theirTip"] === null || e["theirTip"] === undefined ? null : isLink(e["theirTip"]) ? e["theirTip"] : undefined;
  if (seed === undefined || theirTip === undefined) return null;
  let theirShown: { n: number; link: string } | null = null;
  const ts = e["theirShown"];
  if (ts !== null && ts !== undefined) {
    const s = ts as Record<string, unknown>;
    if (typeof ts !== "object" || !isCount(s["n"]) || s["n"] < 1 || s["n"] > CHAIN_LENGTH || !isLink(s["link"])) return null;
    theirShown = { n: s["n"], link: s["link"] };
  }
  if (setup && !seed) return null;
  const log = parseLog(e["log"]);
  if (!log) return null;
  const entry: GameEntry = {
    sessionId: e["sessionId"],
    opponentInstanceId: e["opponentInstanceId"],
    opponentRef: typeof e["opponentRef"] === "string" ? e["opponentRef"] : "",
    opponentIsLocal: e["opponentIsLocal"] === true,
    opponentName: e["opponentName"],
    role: e["role"],
    setup,
    myColor,
    seed,
    theirTip,
    theirShown,
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
  if (log.length > 0 && !stateOf(entry)) return null;
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

/** We claimed the win for the game as it stands and wait for their app to confirm. */
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
  return {
    ...entry,
    log: entry.log.map((e) => (Array.isArray(e) ? [...e] : e)),
    ...(entry.table ? { table: { ...entry.table } } : {}),
  };
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

/** Our own invite, not answered yet: we invited and nothing came back (never an open game: no invite). */
export function isAwaitingOpponent(entry: GameEntry): boolean {
  return entry.role === "inviter" && !entry.heard && !entry.table && !isOver(entry);
}

/** A received invite nobody has played in yet. */
export function isUnansweredInvite(entry: GameEntry): boolean {
  return entry.role === "invitee" && entry.log.length === 0;
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
    // An open game in a space has no 1:1 session to close.
    if (!entry || entry.table || !fromOpponent(entry, msg)) return { kind: "ignore" };
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
  /** Join / Play opened Backgammon for an open game in a space (a table). */
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
    // A table's id never names a 1:1 game we have.
    const mine = games.get(sessionId);
    if (mine && !mine.table) return { kind: "mismatch" };
    return { kind: "table", session: launch.group };
  }
  const known = games.get(sessionId);
  if (known) {
    // An invite never names a game played at a table.
    if (known.table && launch.invite) return { kind: "mismatch" };
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
  // A table game takes steps only from its table (table.ts), never a 1:1 session.
  if (!entry || entry.table) return { kind: "drop", reason: "unknown-game" };
  if (!fromOpponent(entry, msg)) return { kind: "drop", reason: "not-opponent" };
  return { kind: "game", entry };
}

/** The entry for a person picked in Social Home's invite sheet (we invited them), with a fresh seed. */
export function entryForPicked(p: PickedPerson, setup: Setup, seed: Uint8Array, now = Date.now()): GameEntry {
  return {
    sessionId: p.sessionId,
    opponentInstanceId: p.instance_id,
    opponentRef: p.user_ref,
    opponentIsLocal: p.is_local,
    opponentName: p.display_name,
    role: "inviter",
    setup,
    myColor: setup.inviter,
    seed: toB64url(seed),
    theirTip: null,
    theirShown: null,
    log: [],
    heard: false,
    updatedAt: now,
    clockFrom: { n: 0, at: now },
  };
}

/** The entry for an invite Play opened (we were invited; the setup follows). */
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
    setup: null,
    myColor: null,
    seed: null,
    theirTip: null,
    theirShown: null,
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
  if (choice === "random") return rand < 0.5 ? "w" : "b";
  return choice;
}

/** A rematch keeps the cube and the clock, swaps colours, and gets new dice chains. */
export function rematchOf(entry: GameEntry): { color: Color; cube: boolean; days: number } | null {
  if (!entry.setup || !entry.myColor) return null;
  return { color: other(entry.myColor), cube: entry.setup.cube, days: entry.setup.days };
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

export function resignCopy(entry: GameEntry, cost: { kind: WinKind; points: number }): ConfirmCopy {
  const name = personName(entry);
  const { kind, points: n } = cost;
  return {
    title: t("resign.title"),
    body: kind === "single" ? (n === 1 ? t("resign.body1", { name }) : t("resign.body", { name, n })) : t(kind === "gammon" ? "resign.bodyGammon" : "resign.bodyBackgammon", { name, n }),
    confirm: t("resign.confirm"),
    cancel: t("resign.cancel"),
  };
}

export function declineCopy(entry: GameEntry, points: number): ConfirmCopy {
  return {
    title: t("decline.title"),
    body: points === 1 ? t("decline.body1", { name: personName(entry) }) : t("decline.body", { name: personName(entry), n: points }),
    confirm: t("decline.confirm"),
    cancel: t("decline.cancel"),
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
