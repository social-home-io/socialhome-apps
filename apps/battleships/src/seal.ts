/**
 * The per-square seal ("commitment") that keeps both fleets honest without a
 * referee. Suite `sha256-cells-v1`:
 *
 *   seed   = 32 random bytes
 *   salt_i = SHA-256("bs1/salt" ‖ seed ‖ u8 i)[0..16]                       i = 0..99
 *   leaf_i = SHA-256("bs1/leaf" ‖ u8 len(sid) ‖ sid ‖ u8 i ‖ u8 bit_i ‖ salt_i)
 *   root   = SHA-256("bs1/root" ‖ leaf_0 ‖ … ‖ leaf_99)
 *
 * At lock-in a player sends all 100 leaves. Each answer opens one square
 * (its salt); the shooter recomputes that leaf with the answered bit. At the
 * end the seed and fleet are revealed and every leaf is recomputed.
 *
 * - Binding: a square can't change after lock-in without a SHA-256 second
 *   preimage, so ships can't move.
 * - Hiding: each square has its own 128-bit salt; an opened salt says nothing
 *   about the seed or any other salt (each is a one-way hash of the seed).
 * - The session id is inside every leaf (length-prefixed, so it can't run
 *   into the square index), so a seal from another game can't be replayed.
 *   The `bs1/` tags keep the three hashes apart.
 */

import { CELLS } from "./rules.js";
import { sha256 } from "./sha256.js";

export const SEAL_SUITE = "sha256-cells-v1";
export const SUPPORTED_SEAL_SUITES: ReadonlySet<string> = new Set([SEAL_SUITE]);

export const SEED_BYTES = 32;
export const SALT_BYTES = 16;
export const LEAF_BYTES = 32;
export const LEAVES_BYTES = CELLS * LEAF_BYTES;

const enc = new TextEncoder();
const TAG_SALT = enc.encode("bs1/salt");
const TAG_LEAF = enc.encode("bs1/leaf");
const TAG_ROOT = enc.encode("bs1/root");

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
// base64url (no padding) — the wire encoding for every byte string
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

/**
 * Decode unpadded base64url of exactly *expectLen* bytes; `null` for anything
 * else (wrong length, foreign characters, non-canonical trailing bits).
 */
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
    acc = (acc << 6) | v;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out[o++] = (acc >> bits) & 0xff;
    }
  }
  // Leftover bits must be zero (one canonical spelling per byte string).
  if ((acc & ((1 << bits) - 1)) !== 0) return null;
  return o === expectLen ? out : null;
}

// ---------------------------------------------------------------------------
// The seal
// ---------------------------------------------------------------------------

/** Square *i*'s salt, derived from *seed*. */
export function saltAt(seed: Uint8Array, i: number): Uint8Array {
  return sha256(concat([TAG_SALT, seed, Uint8Array.of(i)])).slice(0, SALT_BYTES);
}

/** The 100 square salts derived from *seed*. */
export function deriveSalts(seed: Uint8Array): Uint8Array[] {
  const salts: Uint8Array[] = [];
  for (let i = 0; i < CELLS; i++) salts.push(saltAt(seed, i));
  return salts;
}

function sidBytes(sid: string): Uint8Array {
  const b = enc.encode(sid);
  if (b.length > 255) throw new Error("session id too long");
  return b;
}

/** One square's leaf. */
export function leafOf(sid: string, cell: number, bit: number, salt: Uint8Array): Uint8Array {
  const s = sidBytes(sid);
  return sha256(concat([TAG_LEAF, Uint8Array.of(s.length), s, Uint8Array.of(cell, bit ? 1 : 0), salt]));
}

/** The seal's short id over all 100 leaves (`leaves` is the 3,200-byte concatenation). */
export function rootOf(leaves: Uint8Array): Uint8Array {
  return sha256(concat([TAG_ROOT, leaves]));
}

/** Seal a board: *bits* has one 0/1 per square. */
export function sealBoard(
  sid: string,
  seed: Uint8Array,
  bits: Uint8Array,
): { leaves: Uint8Array; root: Uint8Array; salts: Uint8Array[] } {
  const salts = deriveSalts(seed);
  const leaves = new Uint8Array(LEAVES_BYTES);
  for (let i = 0; i < CELLS; i++) leaves.set(leafOf(sid, i, bits[i], salts[i]), i * LEAF_BYTES);
  return { leaves, root: rootOf(leaves), salts };
}

/** Whether *salt* opens square *cell* of the sealed *leaves* to *bit*. */
export function verifyOpening(
  leaves: Uint8Array,
  sid: string,
  cell: number,
  bit: number,
  salt: Uint8Array,
): boolean {
  if (leaves.length !== LEAVES_BYTES || salt.length !== SALT_BYTES) return false;
  const sealed = leaves.subarray(cell * LEAF_BYTES, (cell + 1) * LEAF_BYTES);
  return bytesEqual(leafOf(sid, cell, bit, salt), sealed);
}

/** A fresh seed from `crypto.getRandomValues` (available in every context). */
export function newSeed(): Uint8Array {
  return globalThis.crypto.getRandomValues(new Uint8Array(SEED_BYTES));
}

/** "7F3A·91C2": the first four bytes of a root, shown as the seal's fingerprint. */
export function fingerprint(root: Uint8Array): string {
  const hex = Array.from(root.subarray(0, 4), (b) => b.toString(16).padStart(2, "0"))
    .join("")
    .toUpperCase();
  return `${hex.slice(0, 4)}·${hex.slice(4, 8)}`;
}
