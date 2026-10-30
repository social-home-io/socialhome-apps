import { describe, expect, it } from "vitest";
import {
  LEAVES_BYTES,
  SALT_BYTES,
  SEAL_SUITE,
  SUPPORTED_SEAL_SUITES,
  deriveSalts,
  fingerprint,
  fromB64url,
  leafOf,
  newSeed,
  rootOf,
  sealBoard,
  toB64url,
  verifyOpening,
} from "./seal.js";
import { sha256, toHex, utf8 } from "./sha256.js";

const SID = "3f2a9c1e-0000-4000-8000-000000000001";
const seed = Uint8Array.from({ length: 32 }, (_, i) => i);

function bits(ones: number[]): Uint8Array {
  const b = new Uint8Array(100);
  for (const i of ones) b[i] = 1;
  return b;
}

describe("base64url", () => {
  it("round-trips every length 0..40 without padding", () => {
    for (let n = 0; n <= 40; n++) {
      const data = Uint8Array.from({ length: n }, (_, i) => (i * 37 + n) & 0xff);
      const text = toB64url(data);
      expect(text).not.toMatch(/[=+/]/);
      expect(fromB64url(text, n)).toEqual(data);
    }
  });

  it("matches the standard alphabet", () => {
    expect(toB64url(utf8("hello?>>"))).toBe("aGVsbG8_Pj4");
  });

  it("refuses the wrong length, foreign characters and non-canonical endings", () => {
    expect(fromB64url("AAAA", 2)).toBeNull();
    expect(fromB64url("AA=A", 3)).toBeNull();
    expect(fromB64url("AB", 1)).toBeNull(); // trailing bits set
    expect(fromB64url("AA", 1)).toEqual(new Uint8Array(1));
    expect(fromB64url(42, 1)).toBeNull();
    expect(fromB64url("ÿÿ", 1)).toBeNull();
  });
});

describe("the per-square seal", () => {
  it("derives 100 distinct 16-byte salts per seed, as specified", () => {
    const salts = deriveSalts(seed);
    expect(salts).toHaveLength(100);
    expect(new Set(salts.map(toHex)).size).toBe(100);
    const enc = new TextEncoder();
    const want = sha256(Uint8Array.from([...enc.encode("bs1/salt"), ...seed, 7])).slice(0, SALT_BYTES);
    expect(salts[7]).toEqual(want);
  });

  it("computes leaves and the root as specified", () => {
    const enc = new TextEncoder();
    const salt = deriveSalts(seed)[42];
    const sid = enc.encode(SID);
    const want = sha256(Uint8Array.from([...enc.encode("bs1/leaf"), sid.length, ...sid, 42, 1, ...salt]));
    expect(leafOf(SID, 42, 1, salt)).toEqual(want);
    const { leaves, root } = sealBoard(SID, seed, bits([42]));
    expect(leaves.length).toBe(LEAVES_BYTES);
    expect(leaves.subarray(42 * 32, 43 * 32)).toEqual(want);
    expect(root).toEqual(sha256(Uint8Array.from([...enc.encode("bs1/root"), ...leaves])));
    expect(rootOf(leaves)).toEqual(root);
  });

  it("opens a square only to its sealed bit", () => {
    const { leaves, salts } = sealBoard(SID, seed, bits([5, 6]));
    expect(verifyOpening(leaves, SID, 5, 1, salts[5])).toBe(true);
    expect(verifyOpening(leaves, SID, 5, 0, salts[5])).toBe(false);
    expect(verifyOpening(leaves, SID, 7, 0, salts[7])).toBe(true);
    expect(verifyOpening(leaves, SID, 7, 1, salts[7])).toBe(false);
    // Another square's salt doesn't open it.
    expect(verifyOpening(leaves, SID, 7, 0, salts[8])).toBe(false);
    // Wrong sizes never verify.
    expect(verifyOpening(leaves.subarray(1), SID, 7, 0, salts[7])).toBe(false);
    expect(verifyOpening(leaves, SID, 7, 0, salts[7].subarray(1))).toBe(false);
  });

  it("binds the seal to its game: the same board in another session doesn't open", () => {
    const { leaves, salts } = sealBoard(SID, seed, bits([5]));
    expect(verifyOpening(leaves, "other-session", 5, 1, salts[5])).toBe(false);
    expect(sealBoard("other-session", seed, bits([5])).root).not.toEqual(sealBoard(SID, seed, bits([5])).root);
  });

  it("hides the board: leaves of a ship and of water look alike, and differ per seed", () => {
    const a = sealBoard(SID, seed, bits([0]));
    const b = sealBoard(SID, seed, bits([]));
    expect(a.leaves.subarray(0, 32)).not.toEqual(b.leaves.subarray(0, 32));
    expect(a.leaves.subarray(32)).toEqual(b.leaves.subarray(32));
    expect(sealBoard(SID, newSeed(), bits([])).root).not.toEqual(b.root);
  });

  it("refuses an over-long session id", () => {
    expect(() => leafOf("x".repeat(256), 0, 0, new Uint8Array(16))).toThrow();
  });

  it("knows exactly one suite", () => {
    expect([...SUPPORTED_SEAL_SUITES]).toEqual([SEAL_SUITE]);
    expect(SEAL_SUITE).toBe("sha256-cells-v1");
  });

  it("shows a short fingerprint", () => {
    expect(fingerprint(Uint8Array.from([0x7f, 0x3a, 0x91, 0xc2, 0]))).toBe("7F3A·91C2");
  });
});
