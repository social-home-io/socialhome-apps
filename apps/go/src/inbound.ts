/**
 * Go messages and the judge for the ones another household's Go sent us.
 *
 * One message type, always the whole game, so whichever message Social
 * Home's one-slot mailbox keeps is enough to catch up:
 *
 *   { t: "go", v: 1, rules: "area-7.5-psk", size, youPlay, log }
 *
 * `youPlay` is the receiver's colour as the sender sees it, `log` every
 * entry so far (game.ts). The inviter chooses size and colours; the invitee
 * takes them from the first message and from then on every message must say
 * the same.
 *
 * `judgeInbound` is like Chess's: a message may only add ONE step of the
 * opponent's on top of the log we already have (a move, a pass, a marking,
 * the agreement, resuming play), optionally followed by their resignation
 * (made while it was our turn). The board, captures, ko and the score are
 * rebuilt here by replaying the whole log; anything else in the message —
 * a board, a capture count, a score — is never read.
 *
 * One race is resolved rather than refused: resigning is allowed on either
 * turn, so a resignation can cross a step in flight. Both sides then end
 * with the step first and the resignation last.
 */

import { isPoint, isSize, other } from "./rules.js";
import type { Color, Size } from "./rules.js";
import { MAX_LOG, actorOf, applyEntry, isResign, replay, sameEntry } from "./game.js";
import type { Entry, GameState } from "./game.js";

export const PROTOCOL_VERSION = 1;
export const RULES = "area-7.5-psk";
/** Social Home keeps one held message of ≤ 64 KiB; stay well under it. */
export const MAX_MESSAGE_BYTES = 60 * 1024;

export interface WireMessage {
  t: "go";
  v: number;
  rules: string;
  size: Size;
  youPlay: Color;
  log: Entry[];
}

/** What we know of a game when a message comes in. */
export interface LocalGame {
  /** `null` until the inviter's first message (the invitee only). */
  size: Size | null;
  myColor: Color | null;
  log: readonly Entry[];
}

export type RefuseReason =
  /** Not a message Go can read. */
  | "malformed"
  /** Its board size or colours differ from the ones agreed. */
  | "setup"
  /** Its log differs from the one we have. */
  | "rewrite"
  /** An entry isn't allowed from its position (occupied, suicide, ko, after the end …). */
  | "illegal"
  /** A new entry is ours: the opponent can't play for us. */
  | "wrong-player"
  /** It adds more than one step of the opponent's. */
  | "too-many";

export type InboundVerdict =
  | { kind: "apply"; size: Size; myColor: Color; log: Entry[]; state: GameState; added: Entry[] }
  | { kind: "stale" }
  | { kind: "unsupported" }
  | { kind: "refuse"; reason: RefuseReason };

/** Whether *payload* is a Go message at all (anything else is ignored). */
export function isGoMessage(payload: unknown): boolean {
  return typeof payload === "object" && payload !== null && (payload as Record<string, unknown>)["t"] === "go";
}

/** Our message with the whole game. */
export function buildMessage(size: Size, myColor: Color, log: readonly Entry[]): WireMessage {
  const msg: WireMessage = { t: "go", v: PROTOCOL_VERSION, rules: RULES, size, youPlay: other(myColor), log: [...log] };
  if (JSON.stringify(msg).length > MAX_MESSAGE_BYTES) throw new Error("message too large");
  return msg;
}

/** A clean entry from untrusted input for a *size* board, or `null`. */
export function parseEntry(v: unknown, size: number): Entry | null {
  if (typeof v === "number") return isPoint(size, v) ? v : null;
  if (v === "pass" || v === "resume" || v === "resign-b" || v === "resign-w") return v;
  if (Array.isArray(v)) {
    if (v.length > size * size) return null;
    for (let i = 0; i < v.length; i++) {
      if (!isPoint(size, v[i])) return null;
      if (i > 0 && v[i] <= v[i - 1]) return null;
    }
    return [...(v as number[])];
  }
  return null;
}

/** A clean log, or `null` if it is too long or any entry is bad. */
export function parseLog(v: unknown, size: number): Entry[] | null {
  if (!Array.isArray(v) || v.length > MAX_LOG) return null;
  const out: Entry[] = [];
  for (const item of v) {
    const e = parseEntry(item, size);
    if (e === null) return null;
    out.push(e);
  }
  return out;
}

/** The most entries one message may add: one step, then a resignation. */
export const MAX_NEW = 2;

/**
 * Decide what an inbound message does to our copy of the game.
 * Pure and total: never throws, whatever the payload holds.
 */
export function judgeInbound(local: LocalGame, payload: unknown): InboundVerdict {
  if (typeof payload !== "object" || payload === null) return { kind: "refuse", reason: "malformed" };
  const p = payload as Record<string, unknown>;
  if (p["t"] !== "go") return { kind: "refuse", reason: "malformed" };
  if (p["v"] !== PROTOCOL_VERSION || p["rules"] !== RULES) return { kind: "unsupported" };
  const size = p["size"];
  const youPlay = p["youPlay"];
  if (!isSize(size) || (youPlay !== "b" && youPlay !== "w")) return { kind: "refuse", reason: "malformed" };
  if (local.size !== null && (size !== local.size || youPlay !== local.myColor)) {
    return { kind: "refuse", reason: "setup" };
  }
  const history = parseLog(p["log"], size);
  if (!history) return { kind: "refuse", reason: "malformed" };

  const me: Color = youPlay;
  const them = other(me);
  const ours = local.log;
  const fresh = local.size === null;

  let shared = 0;
  while (shared < ours.length && shared < history.length && sameEntry(ours[shared], history[shared])) shared++;

  if (shared === history.length && !fresh) return { kind: "stale" };
  if (shared < ours.length) return judgeResignRace(size, me, ours, history, shared);

  const added = history.slice(ours.length);
  // Checked before any replay, so a huge forged list costs nothing.
  if (added.length > MAX_NEW) return { kind: "refuse", reason: "too-many" };
  const r = replay(size, history);
  if (!r) return { kind: "refuse", reason: "illegal" };
  if (r.actors.slice(ours.length).some((c) => c !== them)) return { kind: "refuse", reason: "wrong-player" };
  // Two entries only as "a step, then they resigned".
  if (added.length === 2 && !isResign(added[1])) return { kind: "refuse", reason: "too-many" };
  return { kind: "apply", size, myColor: me, log: history, state: r.state, added };
}

/**
 * The logs part after `shared` entries. Fine only when one side's tail is
 * just a resignation and the other's is one step of the other player made
 * meanwhile: the result is that step, then the resignation (if the game was
 * still running after it).
 */
function judgeResignRace(
  size: Size,
  me: Color,
  ours: readonly Entry[],
  theirs: readonly Entry[],
  shared: number,
): InboundVerdict {
  const them = other(me);
  const ourTail = ours.slice(shared);
  const theirTail = theirs.slice(shared);
  if (theirTail.length > MAX_NEW || ourTail.length > MAX_NEW) return { kind: "refuse", reason: "rewrite" };
  const base = replay(size, ours.slice(0, shared));
  if (!base) return { kind: "refuse", reason: "rewrite" };

  const byOnly = (tail: readonly Entry[], who: Color): GameState | null => {
    let st = base.state;
    for (const e of tail) {
      if (actorOf(st, e) !== who) return null;
      try {
        st = applyEntry(st, e);
      } catch {
        return null;
      }
    }
    return st;
  };
  const resignOf = (who: Color): Entry => (who === "b" ? "resign-b" : "resign-w");

  // They resigned while we made our step: ours first, then theirs.
  if (theirTail.length === 1 && theirTail[0] === resignOf(them) && byOnly(ourTail, me)) {
    const merged = [...ours, theirTail[0]];
    const r = replay(size, merged);
    // Our own step ended the game already (the agreement): keep it.
    if (!r) return { kind: "stale" };
    return { kind: "apply", size, myColor: me, log: merged, state: r.state, added: [theirTail[0]] };
  }

  // We resigned while they made their step: theirs first, then our resignation.
  if (ourTail.length === 1 && ourTail[0] === resignOf(me) && theirTail.length === 1) {
    const moved = byOnly(theirTail, them);
    if (!moved) return { kind: "refuse", reason: "illegal" };
    const merged = moved.phase === "over" ? [...theirs] : [...theirs, ourTail[0]];
    const r = replay(size, merged);
    if (!r) return { kind: "refuse", reason: "illegal" };
    return { kind: "apply", size, myColor: me, log: merged, state: r.state, added: theirTail };
  }
  return { kind: "refuse", reason: "rewrite" };
}

/**
 * Our own saved copy of a game (this person's store) when it is ahead of
 * the copy on this screen — the same person played on another screen.
 * `null` unless it is legal and extends this screen's log.
 */
export function catchUpFromOwnCopy(size: Size, local: readonly Entry[], stored: unknown): Entry[] | null {
  const log = parseLog(stored, size);
  if (!log || log.length <= local.length) return null;
  if (!local.every((e, i) => sameEntry(e, log[i]))) return null;
  return replay(size, log) ? log : null;
}
