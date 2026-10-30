/**
 * Battleships messages: one type, always the full game, so whichever message
 * Social Home's one-slot mailbox keeps is enough to catch up.
 *
 *   { t: "bs", v: 1, rules: "classic", sid, n,
 *     commit?: { suite, leaves },   // the SENDER's 100 leaves, until the receiver acks them
 *     root?, ack?,                  // the sender's seal root; the receiver's root as the sender holds it
 *     shots: [...],                 // the whole game, in order (the invitee's shots are the even ones)
 *     end?: { result, reason?, at? }, reveal?: { seed, fleet } }
 *
 * A shot entry as the SENDER writes it:
 *   - a shot AT the sender (the receiver fired it): `[cell]` while unanswered,
 *     then `[cell, answer, salt]` or `[cell, "s", salt, [ship, start, dir]]`
 *   - a shot BY the sender: `[cell]`, or `[cell, answer]` echoing the
 *     receiver's answer.
 *
 * `receive` is the receiver's judge, like Chess's `judgeInbound`: a message
 * may only add ONE step on top of our own log — the answer to our pending
 * shot and/or the other side's next shot — and every answer is checked
 * against the sealed leaf it opens. Nothing the sender says about the score,
 * the turn or the winner is taken; it is all rebuilt here.
 */

import { CELLS, FLEET_SQUARES, RULES, isCell, parsePlacement, placementCells } from "./rules.js";
import type { Placement } from "./rules.js";
import { LEAVES_BYTES, SALT_BYTES, SEAL_SUITE, SUPPORTED_SEAL_SUITES, fromB64url, rootOf, toB64url, verifyOpening } from "./seal.js";
import {
  answerShot,
  checkReveal,
  firedBy,
  hitsByMe,
  hitsOnMe,
  isMine,
  ownReveal,
  samePlacement,
  sunkByMe,
} from "./game.js";
import type { Answer, Game, Outcome, Reveal, Shot, VoidReason } from "./game.js";

export const PROTOCOL_VERSION = 1;
/** Social Home keeps one held message of ≤ 64 KiB; stay well under it. */
export const MAX_MESSAGE_BYTES = 60 * 1024;

export type WireShot = [number] | [number, Answer] | [number, Answer, string] | [number, Answer, string, Placement];

export type EndResult = "won" | "lost" | "resigned" | "void";

export interface WireEnd {
  result: EndResult;
  reason?: string;
  at?: number;
}

export interface WireMessage {
  t: "bs";
  v: number;
  rules: string;
  sid: string;
  n: number;
  commit?: { suite: string; leaves: string };
  root?: string;
  ack?: string;
  shots: WireShot[];
  end?: WireEnd;
  reveal?: Reveal;
}

/** Whether *payload* is a Battleships message at all (anything else is ignored). */
export function isBsMessage(payload: unknown): boolean {
  return typeof payload === "object" && payload !== null && (payload as Record<string, unknown>)["t"] === "bs";
}

function endFor(o: Outcome): WireEnd {
  switch (o.kind) {
    case "won":
      return { result: "won", reason: o.how === "resign" ? "resign" : "fleet" };
    case "lost":
      return o.how === "resign" ? { result: "resigned", reason: "resign" } : { result: "lost", reason: "fleet" };
    case "void":
      return { result: "void", reason: o.reason, ...(o.at !== undefined ? { at: o.at } : {}) };
  }
}

/** Our message with the whole game, as it stands. */
export function buildMessage(game: Game): WireMessage {
  if (!game.root || !game.leaves) throw new Error("not locked in");
  const shots: WireShot[] = game.shots.map((s, k) => {
    if (s.ans === undefined) return [s.cell];
    if (isMine(game, k)) return [s.cell, s.ans]; // their answer, echoed
    if (s.ans === "s" && s.sunk) return [s.cell, s.ans, s.salt!, [...s.sunk] as Placement];
    return [s.cell, s.ans, s.salt!];
  });
  const msg: WireMessage = {
    t: "bs",
    v: PROTOCOL_VERSION,
    rules: RULES,
    sid: game.sid,
    n: shots.length,
    root: game.root,
    shots,
  };
  if (!game.acked) msg.commit = { suite: SEAL_SUITE, leaves: game.leaves };
  if (game.theirRoot) msg.ack = game.theirRoot;
  if (game.outcome) {
    msg.end = endFor(game.outcome);
    const reveal = ownReveal(game);
    if (reveal) msg.reveal = reveal;
  }
  if (JSON.stringify(msg).length > MAX_MESSAGE_BYTES) throw new Error("message too large");
  return msg;
}

// ---------------------------------------------------------------------------
// Receiving
// ---------------------------------------------------------------------------

/** Something the person should hear about (announced and shown by the UI). */
export type GameEvent =
  /** Their seal arrived. */
  | { type: "sealed" }
  /** Their answer to our shot. */
  | { type: "answered"; cell: number; ans: Answer; ship?: number }
  /** They fired at us; `ans` is our answer. */
  | { type: "fired"; cell: number; ans: Answer; ship?: number }
  /** The game ended (outcome is in the game). */
  | { type: "over" }
  /** Their revealed fleet checked out. */
  | { type: "checked" };

export type RefuseReason =
  /** Not a message we can read. */
  | "malformed"
  /** Its log differs from ours. */
  | "rewrite"
  /** It is more than one step ahead of ours. */
  | "ahead";

export type Verdict =
  /** Take this game; send our message when `reply`. */
  | { kind: "update"; game: Game; events: GameEvent[]; reply: boolean }
  /** A copy of what we have: nothing to do. */
  | { kind: "stale" }
  /** A version, rules or seal suite this app doesn't know ("update Battleships"). */
  | { kind: "unsupported" }
  /** Keep our game as it is. */
  | { kind: "refuse"; reason: RefuseReason };

interface ParsedShot {
  cell: number;
  ans?: Answer;
  salt?: string;
  sunk?: Placement;
}

function isAnswer(v: unknown): v is Answer {
  return v === "m" || v === "h" || v === "s";
}

/**
 * Parse the sender's shot list. `atSender(k)` says whether shot k was fired
 * at the sender (by us), which decides its shape. `null` when malformed.
 */
function parseShots(raw: unknown, atSender: (k: number) => boolean): ParsedShot[] | null {
  if (!Array.isArray(raw) || raw.length > CELLS * 2) return null;
  const out: ParsedShot[] = [];
  const seen = [new Set<number>(), new Set<number>()];
  for (let k = 0; k < raw.length; k++) {
    const e = raw[k];
    if (!Array.isArray(e) || e.length < 1 || !isCell(e[0])) return null;
    const cell = e[0];
    const side = seen[k % 2];
    if (side.has(cell)) return null; // a square is fired at once
    side.add(cell);
    if (e.length === 1) {
      if (k !== raw.length - 1) return null; // only the last shot may wait for its answer
      out.push({ cell });
      continue;
    }
    if (!isAnswer(e[1])) return null;
    if (atSender(k)) {
      // The sender's answer to our shot, with its opening.
      if (fromB64url(e[2], SALT_BYTES) === null) return null;
      if (e[1] === "s") {
        if (e.length !== 4) return null;
        const p = parsePlacement(e[3]);
        if (!p) return null;
        out.push({ cell, ans: "s", salt: e[2], sunk: p });
      } else {
        if (e.length !== 3) return null;
        out.push({ cell, ans: e[1], salt: e[2] });
      }
    } else {
      // The sender's own shot with our answer echoed.
      if (e.length !== 2) return null;
      out.push({ cell, ans: e[1] });
    }
  }
  return out;
}

function voided(game: Game, reason: VoidReason, now: number, at?: number): Verdict {
  const outcome: Outcome = { kind: "void", reason, ...(at !== undefined ? { at } : {}) };
  const g: Game = { ...game, outcome, outOfStep: 0, updatedAt: now };
  return { kind: "update", game: g, events: [{ type: "over" }], reply: !game.sentFinal };
}

/**
 * Judge a message from the other player against our copy of the game.
 * Pure and total: never throws, whatever the payload holds. The caller has
 * already checked it came from this game's opponent (Social Home's session
 * and `fromInstance`).
 */
export function receive(game: Game, payload: unknown, now = Date.now()): Verdict {
  if (typeof payload !== "object" || payload === null) return { kind: "refuse", reason: "malformed" };
  const p = payload as Record<string, unknown>;
  if (p["t"] !== "bs") return { kind: "refuse", reason: "malformed" };
  if (p["v"] !== PROTOCOL_VERSION || p["rules"] !== RULES) return { kind: "unsupported" };
  const commit = p["commit"];
  if (commit !== undefined) {
    if (typeof commit !== "object" || commit === null) return { kind: "refuse", reason: "malformed" };
    if (!SUPPORTED_SEAL_SUITES.has((commit as Record<string, unknown>)["suite"] as string)) {
      return { kind: "unsupported" };
    }
  }
  if (p["sid"] !== game.sid) return { kind: "refuse", reason: "malformed" };

  const R = parseShots(p["shots"], (k) => isMine(game, k));
  if (!R || p["n"] !== R.length) return { kind: "refuse", reason: "malformed" };
  const end = parseEnd(p["end"]);
  if (end === null) return { kind: "refuse", reason: "malformed" };

  const g: Game = { ...game };
  const events: GameEvent[] = [];
  let changed = false;
  let reply = false;

  // ---- Their seal --------------------------------------------------------
  let newSeal = false;
  if (commit !== undefined) {
    const leaves = fromB64url((commit as Record<string, unknown>)["leaves"], LEAVES_BYTES);
    if (!leaves) return { kind: "refuse", reason: "malformed" };
    const root = toB64url(rootOf(leaves));
    if (g.theirRoot) {
      if (root !== g.theirRoot) return voided(game, "reseal", now);
    } else {
      g.theirLeaves = toB64url(leaves);
      g.theirRoot = root;
      newSeal = true;
      changed = true;
      events.push({ type: "sealed" });
    }
  }
  if (p["root"] !== undefined) {
    if (typeof p["root"] !== "string") return { kind: "refuse", reason: "malformed" };
    if (g.theirRoot && p["root"] !== g.theirRoot) return voided(game, "reseal", now);
  }
  const ackRaw = p["ack"];
  if (ackRaw !== undefined && typeof ackRaw !== "string") return { kind: "refuse", reason: "malformed" };
  const ackOk = !!g.root && ackRaw === g.root;
  if (ackOk && !g.acked) {
    g.acked = true;
    changed = true;
  }

  // ---- The log must extend ours ------------------------------------------
  const L = game.shots;
  let behind = false;
  let newAnswer = -1;
  const shared = Math.min(L.length, R.length);
  for (let k = 0; k < shared; k++) {
    const l = L[k];
    const r = R[k];
    if (l.cell !== r.cell) return { kind: "refuse", reason: "rewrite" };
    if (isMine(game, k)) {
      if (r.ans !== undefined) {
        if (l.ans !== undefined) {
          if (l.ans !== r.ans || l.salt !== r.salt || !samePlacement(l.sunk, r.sunk)) {
            return { kind: "refuse", reason: "rewrite" };
          }
        } else {
          newAnswer = k; // only the last of ours can be unanswered
        }
      } else if (l.ans !== undefined) {
        behind = true;
      }
    } else if (r.ans !== undefined) {
      // An answer to their own shot can only be ours, as we gave it.
      if (l.ans === undefined || l.ans !== r.ans) return { kind: "refuse", reason: "rewrite" };
    } else if (l.ans !== undefined) {
      behind = true;
    }
  }
  if (R.length < L.length) behind = true;
  const extra = R.length - L.length;
  if (extra > 1) return { kind: "refuse", reason: "ahead" };
  let newShot: number | null = null;
  let echo: Answer | undefined;
  if (extra === 1) {
    const k = L.length;
    // The new shot must be theirs and come with the rest of the log up to
    // date. Usually it is unanswered and we answer it now. With an answer
    // already in it, it is a shot we answered but our saved copy missed
    // (the app closed before the store caught up): our answer is worked out
    // again from our own fleet and must be exactly the one echoed.
    if (isMine(game, k) || behind) return { kind: "refuse", reason: "rewrite" };
    newShot = R[k].cell;
    echo = R[k].ans;
  }
  if (behind && newAnswer >= 0) return { kind: "refuse", reason: "rewrite" };

  if (game.outcome) {
    // The game is over here: only the other fleet's reveal is still news.
    return takeReveal(game, g, end, p["reveal"], events, changed, now);
  }

  // ---- Their answer to our shot ------------------------------------------
  if (newAnswer >= 0) {
    const r = R[newAnswer];
    const theirLeaves = g.theirLeaves ? fromB64url(g.theirLeaves, LEAVES_BYTES) : null;
    if (!theirLeaves) return { kind: "refuse", reason: "rewrite" };
    const bit = r.ans === "m" ? 0 : 1;
    if (!verifyOpening(theirLeaves, game.sid, r.cell, bit, fromB64url(r.salt, SALT_BYTES)!)) {
      return voided(g, "answer", now, r.cell);
    }
    if (r.ans === "s" && !plausibleSunk(g, r)) return voided(g, "sunk", now, r.cell);
    const shot: Shot = { cell: r.cell, ans: r.ans, salt: r.salt, ...(r.sunk ? { sunk: r.sunk } : {}) };
    g.shots = [...g.shots.slice(0, newAnswer), shot];
    changed = true;
    events.push({ type: "answered", cell: r.cell, ans: r.ans!, ...(r.sunk ? { ship: r.sunk[0] } : {}) });
    if (hitsByMe(g) >= FLEET_SQUARES) {
      g.outcome = { kind: "won", how: "fleet" };
    } else if (firedBy(g, true).size >= CELLS) {
      // Every square fired at and fewer than 17 ships: the seal held a short fleet.
      return voided(g, "short", now);
    }
  }

  // ---- Their shot at us --------------------------------------------------
  if (newShot !== null && !g.outcome) {
    if (!ackOk) return voided(g, "order", now, newShot); // fired without holding our seal
    const answer = answerShot(g, newShot);
    if (echo !== undefined && echo !== answer.ans) return { kind: "refuse", reason: "rewrite" };
    g.shots = [...g.shots, answer];
    changed = true;
    reply = echo === undefined;
    events.push({
      type: "fired",
      cell: newShot,
      ans: answer.ans!,
      ...(answer.sunk ? { ship: answer.sunk[0] } : {}),
    });
    if (hitsOnMe(g) >= FLEET_SQUARES) g.outcome = { kind: "lost", how: "fleet" };
  }

  // ---- Their end -----------------------------------------------------------
  if (end && !g.outcome) {
    if (end.result === "resigned") g.outcome = { kind: "won", how: "resign" };
    else if (end.result === "void") g.outcome = { kind: "void", reason: "them" };
    // "won" / "lost" are never taken on their word: the log decides.
  }

  // Our seal to them: they sent theirs but don't hold ours yet.
  if (newSeal && !ackOk && g.root) reply = true;

  if (g.outcome && !game.outcome) {
    events.push({ type: "over" });
    changed = true;
  }
  const verdict = takeReveal(game, g, end, p["reveal"], events, changed, now);
  if (verdict.kind !== "update") return verdict;
  // Our final message goes out once, as soon as we know the game is over.
  const finalDue = !!verdict.game.outcome && !game.sentFinal;
  return { ...verdict, reply: (reply || finalDue) && !game.sentFinal };
}

/** Verify a reveal that came with an end; returns the verdict for the message. */
function takeReveal(
  before: Game,
  g: Game,
  end: WireEnd | undefined,
  reveal: unknown,
  events: GameEvent[],
  changed: boolean,
  now: number,
): Verdict {
  if (end && reveal !== undefined && !g.theirReveal) {
    const check = checkReveal(g, reveal);
    if (!check.ok) {
      if (g.outcome?.kind === "void") {
        // Already void: keep the first reason.
        changed = true;
      } else {
        const outcome: Outcome = { kind: "void", reason: check.reason, ...(check.at !== undefined ? { at: check.at } : {}) };
        g = { ...g, outcome };
        if (!before.outcome || before.outcome.kind !== "void") events.push({ type: "over" });
        changed = true;
      }
    } else {
      g = { ...g, theirReveal: { seed: (reveal as Reveal).seed, fleet: check.fleet }, check: "ok" };
      events.push({ type: "checked" });
      changed = true;
    }
  }
  if (!changed) return { kind: "stale" };
  const finalDue = !!g.outcome && !before.sentFinal && !before.outcome;
  return { kind: "update", game: { ...g, outOfStep: 0, updatedAt: now }, events, reply: finalDue };
}

/**
 * A "sunk" answer we can already judge before the reveal: the named ship
 * covers the shot square, every one of its squares is a proven hit of ours
 * (this one included), and that ship hasn't sunk before.
 */
function plausibleSunk(game: Game, r: ParsedShot): boolean {
  if (!r.sunk) return false;
  const cells = placementCells(r.sunk);
  if (!cells || !cells.includes(r.cell)) return false;
  if (sunkByMe(game).has(r.sunk[0])) return false;
  const hits = new Set<number>([r.cell]);
  game.shots.forEach((s, k) => {
    if (isMine(game, k) && (s.ans === "h" || s.ans === "s")) hits.add(s.cell);
  });
  return cells.every((c) => hits.has(c));
}

/** `undefined` for no end, `null` for a malformed one. */
function parseEnd(v: unknown): WireEnd | undefined | null {
  if (v === undefined) return undefined;
  if (typeof v !== "object" || v === null) return null;
  const e = v as Record<string, unknown>;
  const result = e["result"];
  if (result !== "won" && result !== "lost" && result !== "resigned" && result !== "void") return null;
  return { result };
}

/** Whether our own message is due now (we're locked in and haven't ended). */
export function canSend(game: Game): boolean {
  return !!game.root && !game.sentFinal;
}

/** The game after our final message went out. */
export function markSent(game: Game): Game {
  return game.outcome ? { ...game, sentFinal: true } : game;
}

