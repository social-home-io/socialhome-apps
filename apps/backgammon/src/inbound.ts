/**
 * Backgammon messages and the judge for the ones another household's app
 * sent us. Pure, tested.
 *
 * One message type, always the whole game, so whichever message Social
 * Home's one-slot mailbox keeps is enough to catch up:
 *
 *   { t: "bg", v: 1, rules: "standard-1", suite: "sha256-chain-v1",
 *     youPlay, cube, days, tips: { w?, b? }, shown?: { n, link }, log,
 *     claim?: true, refused?: <ms> }
 *
 * `youPlay` is the receiver's colour as the sender sees it; `cube` and
 * `days` the setup; `tips` the two dice chains' tips (the inviter's from
 * the first message, the invitee's from its answer); `shown` the newest
 * link of the SENDER's chain it has shown (dice.ts), absent while it has
 * shown none; `log` every entry so far (game.ts). Only the keys listed are
 * taken: a message with any other key, another version, rules or dice suite
 * is "unsupported", so a later app that adds to the setup is never played
 * wrongly by this one.
 *
 * The handshake: the inviter's first message carries its tip; the invitee's
 * app answers with its own tip and link 1 (`kind: "invite"` → answer, then
 * `accepted` on the inviter's side). From then on `judgeInbound` takes ONE
 * step of the opponent's on top of the log we have (or one step and then
 * their resignation, made while it was our turn), and checks that the link
 * they show is exactly the one that step must show — not one earlier (they
 * would hold back our next roll), not one later (that would give away
 * their own next roll) — and that it hashes back to their tip. The board,
 * every roll, the cube and the score are rebuilt here; nothing else in the
 * message is read.
 *
 * The clock never travels as a time (as in Go): `claim: true` says "your
 * time ran out", the receiver decides from its own records and answers
 * with its own `timeout-*` entry or `refused`.
 */

import { other } from "./rules.js";
import type { Color } from "./rules.js";
import { CHAIN_LENGTH, DICE_SUITE, LINK_BYTES, bytesEqual, fromB64url, linksFrom, openingFor, rollFor, toB64url, verifyLink } from "./dice.js";
import type { Opening } from "./dice.js";
import { MAX_LOG, MAX_TURN_NUMBERS, actorOf, applyEntry, initialState, isResign, isTimeout, replay, sameEntry } from "./game.js";
import type { DiceSource, Entry, GameState, Setup } from "./game.js";

/** The clock choices: days per move (0 = no clock). */
export const CLOCK_DAYS: readonly number[] = [0, 1, 2, 3, 5, 7];
export const DAY_MS = 24 * 60 * 60 * 1000;

export function isClockDays(v: unknown): v is number {
  return typeof v === "number" && CLOCK_DAYS.includes(v);
}

export const PROTOCOL_VERSION = 1;
export const RULES = "standard-1";
/** Social Home keeps one held message of ≤ 64 KiB; stay well under it. */
export const MAX_MESSAGE_BYTES = 60 * 1024;

const KEYS = new Set(["t", "v", "rules", "suite", "youPlay", "cube", "days", "tips", "shown", "log", "claim", "refused"]);

export interface WireMessage {
  t: "bg";
  v: number;
  rules: string;
  suite: string;
  youPlay: Color;
  cube: boolean;
  days: number;
  tips: Partial<Record<Color, string>>;
  shown?: { n: number; link: string };
  log: Entry[];
  claim?: true;
  refused?: number;
}

/** A chain link we know: index n and its 32 bytes. */
export interface Shown {
  n: number;
  link: Uint8Array;
}

/** What we know of a game when a message comes in. */
export interface LocalGame {
  sid: string;
  role: "inviter" | "invitee";
  /** `null` for the invitee until the inviter's first message. */
  setup: Setup | null;
  myColor: Color | null;
  /** Our whole chain (index 0 the tip), `null` before we have one. */
  myChain: readonly Uint8Array[] | null;
  /** Their tip, `null` until we have it. */
  theirTip: Uint8Array | null;
  /** The newest link of theirs we checked, `null` while they showed none. */
  theirShown: Shown | null;
  log: readonly Entry[];
}

export type RefuseReason =
  /** Not a message the app can read. */
  | "malformed"
  /** Its colours, cube, clock or a tip differ from the ones agreed. */
  | "setup"
  /** A link that isn't on their chain, or not the one their step must show. */
  | "dice"
  /** Its log differs from the one we have. */
  | "rewrite"
  /** An entry isn't allowed from its position. */
  | "illegal"
  /** A new entry is ours: the opponent can't play for us. */
  | "wrong-player"
  /** It adds more than one step of the opponent's. */
  | "too-many"
  /** A time claim that doesn't fit. */
  | "claim";

export interface Applied {
  kind: "apply";
  setup: Setup;
  myColor: Color;
  theirTip: Uint8Array;
  theirShown: Shown | null;
  log: Entry[];
  state: GameState;
  added: Entry[];
  /** The invitee's answer: the game starts now. */
  accepted?: boolean;
}

export type InboundVerdict =
  | Applied
  /** The invitee gets the inviter's setup and tip: answer with ours. */
  | { kind: "invite"; setup: Setup; myColor: Color; theirTip: Uint8Array }
  | { kind: "stale" }
  | { kind: "claim" }
  | { kind: "claim-refused"; leftMs: number }
  | { kind: "unsupported" }
  | { kind: "refuse"; reason: RefuseReason };

/** Whether *payload* is a Backgammon message at all (anything else is ignored). */
export function isBgMessage(payload: unknown): boolean {
  return typeof payload === "object" && payload !== null && (payload as Record<string, unknown>)["t"] === "bg";
}

export interface MessageExtras {
  claim?: boolean;
  refusedMs?: number;
}

export interface OwnSide {
  setup: Setup;
  myColor: Color;
  myTip: Uint8Array;
  theirTip: Uint8Array | null;
  /** Our newest shown link (`null` while we showed none). */
  shown: Shown | null;
  log: readonly Entry[];
}

/** Our message with the whole game. */
export function buildMessage(own: OwnSide, extras: MessageExtras = {}): WireMessage {
  const tips: Partial<Record<Color, string>> = { [own.myColor]: toB64url(own.myTip) };
  if (own.theirTip) tips[other(own.myColor)] = toB64url(own.theirTip);
  const msg: WireMessage = {
    t: "bg",
    v: PROTOCOL_VERSION,
    rules: RULES,
    suite: DICE_SUITE,
    youPlay: other(own.myColor),
    cube: own.setup.cube,
    days: own.setup.days,
    tips,
    log: own.log.map((e) => (Array.isArray(e) ? [...e] : e)),
  };
  if (own.shown && own.shown.n > 0) msg.shown = { n: own.shown.n, link: toB64url(own.shown.link) };
  if (own.setup.days > 0) {
    if (extras.claim) msg.claim = true;
    else if (extras.refusedMs !== undefined) msg.refused = Math.max(0, Math.round(extras.refusedMs));
  }
  if (JSON.stringify(msg).length > MAX_MESSAGE_BYTES) throw new Error("message too large");
  return msg;
}

const WORDS = new Set(["open", "roll", "show", "double", "take", "drop", "resign-w", "resign-b", "timeout-w", "timeout-b"]);

/** A clean entry from untrusted input, or `null`. */
export function parseEntry(v: unknown): Entry | null {
  if (typeof v === "string") return WORDS.has(v) ? (v as Entry) : null;
  if (Array.isArray(v)) {
    if (v.length > MAX_TURN_NUMBERS || v.length % 2 !== 0) return null;
    for (const x of v) if (typeof x !== "number" || !Number.isInteger(x) || x < 0 || x > 25) return null;
    return [...(v as number[])];
  }
  return null;
}

/** A clean log, or `null` if it is too long or any entry is bad. */
export function parseLog(v: unknown): Entry[] | null {
  if (!Array.isArray(v) || v.length > MAX_LOG) return null;
  const out: Entry[] = [];
  for (const item of v) {
    const e = parseEntry(item);
    if (e === null) return null;
    out.push(e);
  }
  return out;
}

/** The rolls one side can know: all of its own chain, the other's up to the newest link shown. */
export function diceSource(sid: string, myColor: Color, myChain: readonly Uint8Array[], theirShown: Shown | null): DiceSource {
  const theirs = theirShown ? linksFrom(theirShown.n, theirShown.link) : [];
  const link = (c: Color, t: number): Uint8Array | null => {
    if (t < 1 || t > CHAIN_LENGTH) return null;
    if (c === myColor) return myChain[t] ?? null;
    return t < theirs.length ? theirs[t] : null;
  };
  let opening: Opening | null | undefined;
  const rolls = new Map<number, [number, number]>();
  return {
    opening() {
      if (opening !== undefined) return opening;
      const w = link("w", 1);
      const b = link("b", 1);
      opening = w && b ? openingFor(sid, w, b) : null;
      return opening;
    },
    roll(t) {
      if (rolls.has(t)) return rolls.get(t)!;
      const w = link("w", t);
      const b = link("b", t);
      if (!w || !b) return null;
      const r = rollFor(sid, t, w, b);
      rolls.set(t, r);
      return r;
    },
  };
}

/** Whether *link* is their link *n*, given the newest one we checked (or their tip). */
export function checkShown(tip: Uint8Array, known: Shown | null, n: number, link: Uint8Array): boolean {
  const k: Shown = known ?? { n: 0, link: tip };
  if (n >= k.n) return verifyLink(k, n, link);
  // Older than what we have: it must be the link we already derived.
  if (n < 0) return false;
  return bytesEqual(linksFrom(k.n, k.link)[n], link);
}

/** The most entries one message may add: one step, then a resignation. */
export const MAX_NEW = 2;

function parseTips(v: unknown): Partial<Record<Color, Uint8Array>> | null {
  if (typeof v !== "object" || v === null || Array.isArray(v)) return null;
  const out: Partial<Record<Color, Uint8Array>> = {};
  for (const [k, text] of Object.entries(v)) {
    if (k !== "w" && k !== "b") return null;
    const bytes = fromB64url(text, LINK_BYTES);
    if (!bytes) return null;
    out[k] = bytes;
  }
  return out;
}

function parseShown(v: unknown): Shown | null | undefined {
  if (v === undefined) return null;
  if (typeof v !== "object" || v === null) return undefined;
  const s = v as Record<string, unknown>;
  if (Object.keys(s).some((k) => k !== "n" && k !== "link")) return undefined;
  const n = s["n"];
  const link = fromB64url(s["link"], LINK_BYTES);
  if (typeof n !== "number" || !Number.isInteger(n) || n < 1 || n > CHAIN_LENGTH || !link) return undefined;
  return { n, link };
}

/**
 * Decide what an inbound message does to our copy of the game.
 * Pure and total: never throws, whatever the payload holds.
 */
export function judgeInbound(local: LocalGame, payload: unknown): InboundVerdict {
  try {
    return judge(local, payload);
  } catch {
    return { kind: "refuse", reason: "malformed" };
  }
}

function judge(local: LocalGame, payload: unknown): InboundVerdict {
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) return { kind: "refuse", reason: "malformed" };
  const p = payload as Record<string, unknown>;
  if (p["t"] !== "bg") return { kind: "refuse", reason: "malformed" };
  if (p["v"] !== PROTOCOL_VERSION || p["rules"] !== RULES || p["suite"] !== DICE_SUITE) return { kind: "unsupported" };
  // A key we don't know may change the game: never play it as if it weren't there.
  if (Object.keys(p).some((k) => !KEYS.has(k))) return { kind: "unsupported" };

  const youPlay = p["youPlay"];
  const cube = p["cube"];
  const days = p["days"];
  if ((youPlay !== "w" && youPlay !== "b") || typeof cube !== "boolean" || !isClockDays(days)) {
    return { kind: "refuse", reason: "malformed" };
  }
  const tips = parseTips(p["tips"]);
  const shown = parseShown(p["shown"]);
  const history = parseLog(p["log"]);
  if (!tips || shown === undefined || !history) return { kind: "refuse", reason: "malformed" };
  const claim = p["claim"];
  const refused = p["refused"];
  if (claim !== undefined && claim !== true) return { kind: "refuse", reason: "malformed" };
  if (refused !== undefined && (typeof refused !== "number" || !Number.isFinite(refused))) return { kind: "refuse", reason: "malformed" };
  if (claim !== undefined && refused !== undefined) return { kind: "refuse", reason: "malformed" };

  const me: Color = youPlay;
  const them = other(me);
  const inviter: Color = local.role === "inviter" ? me : them;
  const setup: Setup = { inviter, cube, days };

  // The invitee's first look: the inviter's setup and tip, nothing else.
  if (local.setup === null) {
    if (local.role !== "invitee") return { kind: "refuse", reason: "malformed" };
    const theirTip = tips[them];
    if (!theirTip || tips[me] || shown || history.length > 0 || claim !== undefined || refused !== undefined) {
      return { kind: "refuse", reason: "setup" };
    }
    return { kind: "invite", setup, myColor: me, theirTip };
  }

  const agreed = local.setup;
  if (me !== local.myColor || agreed.inviter !== inviter || agreed.cube !== cube || agreed.days !== days) {
    return { kind: "refuse", reason: "setup" };
  }
  const myChain = local.myChain;
  if (!myChain) return { kind: "refuse", reason: "setup" };
  // Our own tip, when they send it, must be ours; theirs never changes.
  if (tips[me] && !bytesEqual(tips[me]!, myChain[0])) return { kind: "refuse", reason: "setup" };
  const theirTip = tips[them];
  if (!theirTip) {
    // Only the inviter's own first message has no invitee tip: an echo of the setup.
    return local.role === "invitee" && history.length === 0 && !shown ? { kind: "stale" } : { kind: "refuse", reason: "setup" };
  }
  if (local.theirTip && !bytesEqual(theirTip, local.theirTip)) return { kind: "refuse", reason: "setup" };
  if (!tips[me]) return { kind: "refuse", reason: "setup" };

  const n = shown ? shown.n : 0;
  if (shown && !checkShown(theirTip, local.theirShown, shown.n, shown.link)) return { kind: "refuse", reason: "dice" };
  const newest: Shown | null = local.theirShown && local.theirShown.n >= n ? local.theirShown : shown;
  const dice = diceSource(local.sid, me, myChain, newest);

  // The invitee's answer: its tip and link 1, before anything is played.
  if (!local.theirTip) {
    if (local.role !== "inviter" || n !== 1 || history.length > 0 || claim !== undefined || refused !== undefined) {
      return { kind: "refuse", reason: n !== 1 && history.length === 0 ? "dice" : "setup" };
    }
    const state = initialState(agreed, dice);
    return { kind: "apply", setup: agreed, myColor: me, theirTip, theirShown: shown, log: [], state, added: [], accepted: true };
  }

  const ours = local.log;
  let shared = 0;
  while (shared < ours.length && shared < history.length && sameEntry(ours[shared], history[shared])) shared++;

  // A claim or its answer is about exactly the game we have now.
  if (claim === true || refused !== undefined) {
    if (days === 0 || shared < history.length) return { kind: "refuse", reason: "claim" };
    if (history.length < ours.length) return { kind: "stale" };
    const st = replay(agreed, ours, dice)?.state;
    if (!st || st.phase === "over") return { kind: "stale" };
    if (claim === true) return st.toMove === me ? { kind: "claim" } : { kind: "refuse", reason: "claim" };
    if (st.toMove !== them) return { kind: "refuse", reason: "claim" };
    return { kind: "claim-refused", leftMs: Math.min(Math.max(0, refused as number), days * DAY_MS) };
  }

  if (shared === history.length) return { kind: "stale" };
  if (shared < ours.length) return judgeResignRace(agreed, me, ours, history, shared, dice, n, theirTip, newest);

  const added = history.slice(ours.length);
  // Checked before any replay, so a huge forged list costs nothing.
  if (added.length > MAX_NEW) return { kind: "refuse", reason: "too-many" };
  const r = replay(agreed, history, dice);
  if (!r) return { kind: "refuse", reason: "illegal" };
  if (r.actors.slice(ours.length).some((c) => c !== them)) return { kind: "refuse", reason: "wrong-player" };
  // Two entries only as "a step, then they resigned". Running out of time is a step of its own.
  if (added.length === 2 && (!isResign(added[1]) || isTimeout(added[0]))) return { kind: "refuse", reason: "too-many" };
  // Exactly the link their steps must show: not held back, not given away early.
  if (r.state.reveals[them] !== n) return { kind: "refuse", reason: "dice" };
  return { kind: "apply", setup: agreed, myColor: me, theirTip, theirShown: newest, log: history, state: r.state, added };
}

/**
 * The logs part after `shared` entries. Fine only when one side's tail is
 * just a resignation and the other's is one step of the other player made
 * meanwhile: the result is that step, then the resignation.
 */
function judgeResignRace(
  setup: Setup,
  me: Color,
  ours: readonly Entry[],
  theirs: readonly Entry[],
  shared: number,
  dice: DiceSource,
  n: number,
  theirTip: Uint8Array,
  newest: Shown | null,
): InboundVerdict {
  const them = other(me);
  const ourTail = ours.slice(shared);
  const theirTail = theirs.slice(shared);
  if (theirTail.length > MAX_NEW || ourTail.length > MAX_NEW) return { kind: "refuse", reason: "rewrite" };
  const base = replay(setup, ours.slice(0, shared), dice);
  if (!base) return { kind: "refuse", reason: "rewrite" };

  const byOnly = (tail: readonly Entry[], who: Color): GameState | null => {
    let st = base.state;
    for (const e of tail) {
      if (actorOf(st, e) !== who) return null;
      try {
        st = applyEntry(st, e, dice);
      } catch {
        return null;
      }
    }
    return st;
  };
  const resignOf = (who: Color): Entry => (who === "w" ? "resign-w" : "resign-b");

  // They resigned while we made our step: ours first, then theirs.
  if (theirTail.length === 1 && theirTail[0] === resignOf(them) && byOnly(ourTail, me)) {
    if (base.state.reveals[them] !== n) return { kind: "refuse", reason: "dice" };
    const merged = [...ours, theirTail[0]];
    const r = replay(setup, merged, dice);
    if (!r) return { kind: "stale" };
    return { kind: "apply", setup, myColor: me, theirTip, theirShown: newest, log: merged, state: r.state, added: [theirTail[0]] };
  }

  // We resigned while they made their step: theirs first, then our resignation.
  if (ourTail.length === 1 && ourTail[0] === resignOf(me) && theirTail.length === 1) {
    const moved = byOnly(theirTail, them);
    if (!moved) return { kind: "refuse", reason: "illegal" };
    if (moved.reveals[them] !== n) return { kind: "refuse", reason: "dice" };
    const merged = moved.phase === "over" ? [...theirs] : [...theirs, ourTail[0]];
    const r = replay(setup, merged, dice);
    if (!r) return { kind: "refuse", reason: "illegal" };
    return { kind: "apply", setup, myColor: me, theirTip, theirShown: newest, log: merged, state: r.state, added: theirTail };
  }
  return { kind: "refuse", reason: "rewrite" };
}

/**
 * Our own saved log (this person's store) when it is ahead of the copy on
 * this screen — the same person played on another screen. `null` unless it
 * replays and extends this screen's log.
 */
export function catchUpFromOwnCopy(setup: Setup, local: readonly Entry[], stored: unknown, dice: DiceSource): Entry[] | null {
  const log = parseLog(stored);
  if (!log || log.length <= local.length) return null;
  if (!local.every((e, i) => sameEntry(e, log[i]))) return null;
  return replay(setup, log, dice) ? log : null;
}

