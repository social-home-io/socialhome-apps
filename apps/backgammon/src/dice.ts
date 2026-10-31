/**
 * Fair dice without a referee — suite `sha256-chain-v1`. Pure, tested.
 *
 * Each player's app makes a secret 32-byte seed for the game and hashes it
 * into a chain:
 *
 *   c[L] = seed,  c[j-1] = SHA-256("bg1/chain" ‖ c[j]),  tip = c[0]    (L = CHAIN_LENGTH)
 *
 * The tips are exchanged at the start (the inviter's first, in the invite;
 * the invitee's in its answer). From then on a player shows its chain one
 * link at a time: the newest value it has shown, `c[n]`, travels in every
 * message, and anyone can check it by hashing it n times back to the tip.
 * Nobody can show a value that isn't on its chain (that would need a
 * SHA-256 preimage), so every link was fixed when the tips were exchanged.
 *
 * Turn t's roll (and the opening roll, t = 1) mixes link t of BOTH chains:
 *
 *   block_k = SHA-256("bg1/dice" ‖ u8 len(sid) ‖ sid ‖ u16 t ‖ w[t] ‖ b[t] ‖ u8 k)
 *
 * read byte by byte; a byte below 252 gives the die 1 + byte mod 6 (252 is
 * a multiple of 6, so every face is equally likely), a byte from 252 is
 * skipped. The session id keeps a chain from being replayed in another game.
 *
 * Who shows which link when is game.ts (`revealsAfter`): a player shows link
 * t + 1 only together with its finished turn t, so the next roller learns
 * its roll from that message alone (no extra round trip), and nobody learns
 * a roll before the other player's part of it was fixed.
 */

import { sha256 } from "./sha256.js";

export const DICE_SUITE = "sha256-chain-v1";
export const SUPPORTED_DICE_SUITES: ReadonlySet<string> = new Set([DICE_SUITE]);

export class UnsupportedDiceSuite extends Error {}

/** Links per chain: one per turn (a game averages about 55 turns). */
export const CHAIN_LENGTH = 600;
export const LINK_BYTES = 32;

const enc = new TextEncoder();
const TAG_CHAIN = enc.encode("bg1/chain");
const TAG_DICE = enc.encode("bg1/dice");

function concat(parts: Uint8Array[]): Uint8Array {
  let n = 0;
  for (const p of parts) n += p.length;
  const out = new Uint8Array(n);
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

export function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

// ---------------------------------------------------------------------------
// base64url (no padding) — the wire encoding of every link
// ---------------------------------------------------------------------------

const B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
const B64_INDEX = new Int16Array(128).fill(-1);
for (let i = 0; i < B64.length; i++) B64_INDEX[B64.charCodeAt(i)] = i;

export function toB64url(bytes: Uint8Array): string {
  let s = "";
  let i = 0;
  for (; i + 2 < bytes.length; i += 3) {
    const n = (bytes[i] << 16) | (bytes[i + 1] << 8) | bytes[i + 2];
    s += B64[n >> 18] + B64[(n >> 12) & 63] + B64[(n >> 6) & 63] + B64[n & 63];
  }
  const rest = bytes.length - i;
  if (rest === 1) {
    const n = bytes[i] << 16;
    s += B64[n >> 18] + B64[(n >> 12) & 63];
  } else if (rest === 2) {
    const n = (bytes[i] << 16) | (bytes[i + 1] << 8);
    s += B64[n >> 18] + B64[(n >> 12) & 63] + B64[(n >> 6) & 63];
  }
  return s;
}

/** Decode unpadded base64url of exactly *expectLen* bytes; `null` for anything else. */
export function fromB64url(text: unknown, expectLen: number): Uint8Array | null {
  if (typeof text !== "string") return null;
  if (text.length !== Math.ceil((expectLen * 4) / 3)) return null;
  const out = new Uint8Array(expectLen);
  let bits = 0;
  let acc = 0;
  let o = 0;
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    const v = code < 128 ? B64_INDEX[code] : -1;
    if (v < 0) return null;
    acc = ((acc << 6) | v) & 0xffffff;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out[o++] = (acc >> bits) & 0xff;
    }
  }
  // Leftover bits must be zero (one spelling per byte string).
  if ((acc & ((1 << bits) - 1)) !== 0) return null;
  return o === expectLen ? out : null;
}

/** A link as it travels: 43 base64url characters. */
export function isLinkText(v: unknown): v is string {
  return fromB64url(v, LINK_BYTES) !== null;
}

// ---------------------------------------------------------------------------
// Chains
// ---------------------------------------------------------------------------

/** One step down the chain: the link before *link*. */
export function down(link: Uint8Array): Uint8Array {
  return sha256(concat([TAG_CHAIN, link]));
}

/** The whole chain of *seed*: index j is c[j], index 0 the tip, index L the seed. */
export function buildChain(seed: Uint8Array, length = CHAIN_LENGTH): Uint8Array[] {
  if (seed.length !== LINK_BYTES) throw new Error("seed must be 32 bytes");
  const chain = new Array<Uint8Array>(length + 1);
  chain[length] = seed;
  for (let j = length; j > 0; j--) chain[j - 1] = down(chain[j]);
  return chain;
}

/** A fresh secret seed (crypto.getRandomValues works on plain HTTP too). */
export function newSeed(): Uint8Array {
  const seed = new Uint8Array(LINK_BYTES);
  globalThis.crypto.getRandomValues(seed);
  return seed;
}

/**
 * Whether *link* is c[n] of the chain we know up to c[known.n] (the tip has
 * n 0): hashing it n − known.n times must give the known link. Never more
 * than the chain is long, never backwards.
 */
export function verifyLink(known: { n: number; link: Uint8Array }, n: number, link: Uint8Array): boolean {
  if (!Number.isInteger(n) || n < known.n || n > CHAIN_LENGTH || link.length !== LINK_BYTES) return false;
  let h = link;
  for (let i = n; i > known.n; i--) h = down(h);
  return bytesEqual(h, known.link);
}

/** The shown part of a chain from its newest shown link c[n]: index j is c[j], j = 0 … n. */
export function linksFrom(n: number, link: Uint8Array): Uint8Array[] {
  const out = new Array<Uint8Array>(n + 1);
  out[n] = link;
  for (let j = n; j > 0; j--) out[j - 1] = down(out[j]);
  return out;
}

// ---------------------------------------------------------------------------
// Dice
// ---------------------------------------------------------------------------

function sidBytes(sid: string): Uint8Array {
  const b = enc.encode(sid);
  if (b.length > 255) throw new Error("session id too long");
  return b;
}

/** An endless stream of fair dice for turn *t* from both links. */
function* dieStream(sid: string, t: number, w: Uint8Array, b: Uint8Array): Generator<number> {
  const s = sidBytes(sid);
  for (let k = 0; k < 256; k++) {
    const block = sha256(concat([TAG_DICE, Uint8Array.of(s.length), s, Uint8Array.of((t >> 8) & 0xff, t & 0xff), w, b, Uint8Array.of(k)]));
    for (const byte of block) if (byte < 252) yield 1 + (byte % 6);
  }
  // 256 blocks of only bytes ≥ 252: never happens (probability < 2^-8000).
  throw new Error("dice stream exhausted");
}

/** Turn *t*'s two dice (t ≥ 2) from link t of White's and Black's chains. */
export function rollFor(sid: string, t: number, w: Uint8Array, b: Uint8Array): [number, number] {
  const it = dieStream(sid, t, w, b);
  return [it.next().value as number, it.next().value as number];
}

export interface Opening {
  /** White's and Black's die that decided (never equal). */
  w: number;
  b: number;
  /** Rolls that tied before, in order ([w, b], equal). */
  ties: number[][];
  /** Who starts: the higher die. They play both numbers. */
  starter: "w" | "b";
}

/** The opening roll from link 1 of both chains: one die each, ties roll again. */
export function openingFor(sid: string, w: Uint8Array, b: Uint8Array): Opening {
  const it = dieStream(sid, 1, w, b);
  const ties: number[][] = [];
  for (;;) {
    const dw = it.next().value as number;
    const db = it.next().value as number;
    if (dw !== db) return { w: dw, b: db, ties, starter: dw > db ? "w" : "b" };
    ties.push([dw, db]);
  }
}
