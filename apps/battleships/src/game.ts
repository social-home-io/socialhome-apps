/**
 * One game of Battleships as this player's app keeps it — pure state and the
 * local steps (lock in, fire, answer, resign) plus the full end-of-game check
 * of the other fleet. No DOM, no SDK; every function returns a new `Game`.
 *
 * Turn order: the invited player fires first, so shot `k` is the invitee's
 * when `k` is even and the challenger's when it is odd. One shot per turn;
 * every shot is answered before the next one is fired.
 */

import {
  CELLS,
  fleetBits,
  isLegalFleet,
  parseFleet,
  placementCells,
  shipMap,
} from "./rules.js";
import type { Fleet, Placement } from "./rules.js";
import {
  SEED_BYTES,
  LEAVES_BYTES,
  bytesEqual,
  saltAt,
  fromB64url,
  sealBoard,
  toB64url,
} from "./seal.js";

export type Role = "challenger" | "invitee";
export type Answer = "m" | "h" | "s";

/** One shot of the log. `salt` is the opening of the answered square. */
export interface Shot {
  cell: number;
  ans?: Answer;
  salt?: string;
  /** With a "sunk" answer: the ship that sank, as `[index, start, dir]`. */
  sunk?: Placement;
}

/** Why a game is void (the honest side shows where). */
export type VoidReason =
  /** An answer's opening didn't match the sealed square (`at`). */
  | "answer"
  /** A "sunk" answer that can't be right (`at`). */
  | "sunk"
  /** A different seal than the one locked in at the start. */
  | "reseal"
  /** A shot fired before the shooter held the other seal. */
  | "order"
  /** The revealed fleet doesn't match the seal. */
  | "seal"
  /** The revealed fleet isn't the five standard ships. */
  | "fleet"
  /** Every square was fired at and fewer than 17 were ships. */
  | "short"
  /** The other app ended the game as void. */
  | "them";

export type Outcome =
  | { kind: "won"; how: "fleet" | "resign" }
  | { kind: "lost"; how: "fleet" | "resign" }
  | { kind: "void"; reason: VoidReason; at?: number };

/** What the other side's revealed fleet showed. */
export type FleetCheck = "pending" | "ok";

export interface Reveal {
  seed: string;
  fleet: Fleet;
}

export interface Game {
  sid: string;
  role: Role;
  /** Our fleet (a draft until `seed` is set). */
  fleet: Fleet;
  /** Our seal: seed, leaves and root (base64url), set at lock-in. */
  seed: string | null;
  leaves: string | null;
  root: string | null;
  /** The other side's seal, once received. */
  theirLeaves: string | null;
  theirRoot: string | null;
  /** The other side holds our seal (it acked our root): stop sending the leaves. */
  acked: boolean;
  shots: Shot[];
  outcome: Outcome | null;
  /** The other side's revealed fleet (verified) and the check's state. */
  theirReveal: Reveal | null;
  check: FleetCheck;
  /** We sent our final message: never send another (it would replace it). */
  sentFinal: boolean;
  /** Refused messages in a row (three → "out of step"). */
  outOfStep: number;
  /** Last change (ms since epoch) for "since 3 days". */
  updatedAt: number;
}

export function newGame(sid: string, role: Role, fleet: Fleet, now = Date.now()): Game {
  return {
    sid,
    role,
    fleet,
    seed: null,
    leaves: null,
    root: null,
    theirLeaves: null,
    theirRoot: null,
    acked: false,
    shots: [],
    outcome: null,
    theirReveal: null,
    check: "pending",
    sentFinal: false,
    outOfStep: 0,
    updatedAt: now,
  };
}

/** Who fires shot *k*. */
export function shooterAt(k: number): Role {
  return k % 2 === 0 ? "invitee" : "challenger";
}

export function isMine(game: Game, k: number): boolean {
  return shooterAt(k) === game.role;
}

/** Replace our draft fleet (only before lock-in). */
export function setFleet(game: Game, fleet: Fleet): Game {
  if (game.seed) throw new Error("fleet is locked in");
  if (!isLegalFleet(fleet)) throw new Error("illegal fleet");
  return { ...game, fleet };
}

/** Seal our fleet with *seed* (32 random bytes). */
export function lockIn(game: Game, seed: Uint8Array, now = Date.now()): Game {
  if (game.seed) throw new Error("already locked in");
  if (!isLegalFleet(game.fleet)) throw new Error("illegal fleet");
  if (seed.length !== SEED_BYTES) throw new Error("bad seed");
  const { leaves, root } = sealBoard(game.sid, seed, fleetBits(game.fleet));
  return { ...game, seed: toB64url(seed), leaves: toB64url(leaves), root: toB64url(root), updatedAt: now };
}

export type Phase =
  /** Our fleet isn't locked in yet. */
  | "place"
  /** Locked in; the other seal hasn't arrived (an invite not answered yet). */
  | "wait-seal"
  | "my-turn"
  | "their-turn"
  | "over";

export function phase(game: Game): Phase {
  if (game.outcome) return "over";
  if (!game.root) return "place";
  if (!game.theirLeaves) return "wait-seal";
  const n = game.shots.length;
  if (n > 0 && game.shots[n - 1].ans === undefined) {
    // A shot in flight: whoever didn't fire it answers.
    return isMine(game, n - 1) ? "their-turn" : "my-turn";
  }
  return isMine(game, n) ? "my-turn" : "their-turn";
}

/** Squares we fired at, and squares fired at us. */
export function firedBy(game: Game, mine: boolean): Set<number> {
  const out = new Set<number>();
  game.shots.forEach((s, k) => {
    if (isMine(game, k) === mine) out.add(s.cell);
  });
  return out;
}

/** Our proven hits on their fleet (answered hit/sunk, each opening checked). */
export function hitsByMe(game: Game): number {
  return game.shots.filter((s, k) => isMine(game, k) && (s.ans === "h" || s.ans === "s")).length;
}

/** Their hits on our fleet (our own answers). */
export function hitsOnMe(game: Game): number {
  return game.shots.filter((s, k) => !isMine(game, k) && (s.ans === "h" || s.ans === "s")).length;
}

/** The other side's ships we sank, by index. */
export function sunkByMe(game: Game): Set<number> {
  const out = new Set<number>();
  game.shots.forEach((s, k) => {
    if (isMine(game, k) && s.ans === "s" && s.sunk) out.add(s.sunk[0]);
  });
  return out;
}

/** Fire at *cell* (our turn, a square we haven't fired at). */
export function fire(game: Game, cell: number, now = Date.now()): Game {
  if (phase(game) !== "my-turn") throw new Error("not our turn");
  if (!Number.isInteger(cell) || cell < 0 || cell >= CELLS) throw new Error("bad square");
  if (firedBy(game, true).has(cell)) throw new Error("already fired there");
  return { ...game, shots: [...game.shots, { cell }], updatedAt: now };
}

/**
 * Answer the other side's shot at *cell* from our own fleet: miss, hit, or
 * sunk with the ship (when this square was the ship's last one not yet hit).
 * The opening is our seed-derived salt for that square.
 */
export function answerShot(game: Game, cell: number): Shot {
  if (!game.seed) throw new Error("not locked in");
  const seed = fromB64url(game.seed, SEED_BYTES)!;
  const salt = toB64url(saltAt(seed, cell));
  const map = shipMap(game.fleet);
  const ship = map[cell];
  if (ship < 0) return { cell, ans: "m", salt };
  const hitBefore = firedBy(game, false);
  const cells = placementCells(game.fleet[ship])!;
  const sunk = cells.every((c) => c === cell || hitBefore.has(c));
  if (!sunk) return { cell, ans: "h", salt };
  return { cell, ans: "s", salt, sunk: [...game.fleet[ship]] as Placement };
}

/** We give up: the game is over and lost (our final message tells them and reveals). */
export function resign(game: Game, now = Date.now()): Game {
  if (game.outcome) throw new Error("game is over");
  if (!game.root) throw new Error("not locked in");
  return { ...game, outcome: { kind: "lost", how: "resign" }, updatedAt: now };
}

/** Our own reveal, for the final message. */
export function ownReveal(game: Game): Reveal | null {
  if (!game.seed) return null;
  return { seed: game.seed, fleet: game.fleet.map((p) => [...p] as Placement) };
}

/** Result of checking the other side's revealed fleet. */
export type RevealCheck = { ok: true; fleet: Fleet } | { ok: false; reason: VoidReason; at?: number };

/**
 * The full end-of-game check of the other fleet: the seed and fleet must
 * rebuild exactly the sealed leaves, the fleet must be the five standard
 * ships, and every answer they gave to our shots must be the one that fleet
 * gives — "sunk" exactly on each ship's last square, naming that ship.
 */
export function checkReveal(game: Game, reveal: unknown): RevealCheck {
  if (typeof reveal !== "object" || reveal === null) return { ok: false, reason: "seal" };
  const r = reveal as Record<string, unknown>;
  const seed = fromB64url(r["seed"], SEED_BYTES);
  if (!seed) return { ok: false, reason: "seal" };
  const fleet = parseFleet(r["fleet"]);
  if (!fleet) return { ok: false, reason: "fleet" };
  const leaves = game.theirLeaves ? fromB64url(game.theirLeaves, LEAVES_BYTES) : null;
  if (!leaves) return { ok: false, reason: "seal" };
  const rebuilt = sealBoard(game.sid, seed, fleetBits(fleet));
  if (!bytesEqual(rebuilt.leaves, leaves)) return { ok: false, reason: "seal" };

  const map = shipMap(fleet);
  const hit = new Set<number>();
  for (let k = 0; k < game.shots.length; k++) {
    if (!isMine(game, k)) continue;
    const s = game.shots[k];
    if (s.ans === undefined) continue;
    const ship = map[s.cell];
    if (ship < 0) {
      if (s.ans !== "m") return { ok: false, reason: "answer", at: s.cell };
      continue;
    }
    hit.add(s.cell);
    const sinks = placementCells(fleet[ship])!.every((c) => hit.has(c));
    if (s.ans === "m") return { ok: false, reason: "answer", at: s.cell };
    if (sinks !== (s.ans === "s")) return { ok: false, reason: "sunk", at: s.cell };
    if (sinks && !samePlacement(s.sunk, fleet[ship])) return { ok: false, reason: "sunk", at: s.cell };
  }
  return { ok: true, fleet };
}

export function samePlacement(a: Placement | undefined, b: Placement | undefined): boolean {
  if (!a || !b) return a === b;
  return a[0] === b[0] && a[1] === b[1] && a[2] === b[2];
}

/** Shots fired by each side so far. */
export function shotCount(game: Game): { mine: number; theirs: number } {
  let mine = 0;
  game.shots.forEach((_, k) => {
    if (isMine(game, k)) mine++;
  });
  return { mine, theirs: game.shots.length - mine };
}

