import { describe, expect, it } from "vitest";
import {
  CHAIN_LENGTH,
  DICE_SUITE,
  SUPPORTED_DICE_SUITES,
  buildChain,
  bytesEqual,
  down,
  fromB64url,
  isLinkText,
  linksFrom,
  newSeed,
  openingFor,
  rollFor,
  toB64url,
  verifyLink,
} from "./dice.js";

const seed = (fill: number) => new Uint8Array(32).fill(fill);

describe("dice chains", () => {
  it("hash down from the seed to the tip, one link per turn", () => {
    const chain = buildChain(seed(1));
    expect(chain.length).toBe(CHAIN_LENGTH + 1);
    expect(bytesEqual(chain[CHAIN_LENGTH], seed(1))).toBe(true);
    for (const j of [1, 2, 300, CHAIN_LENGTH]) expect(bytesEqual(down(chain[j]), chain[j - 1])).toBe(true);
  });

  it("refuses a seed of the wrong size", () => {
    expect(() => buildChain(new Uint8Array(16))).toThrow();
  });

  it("checks a shown link against the tip or the newest checked link", () => {
    const chain = buildChain(seed(2), 40);
    const tip = { n: 0, link: chain[0] };
    expect(verifyLink(tip, 1, chain[1])).toBe(true);
    expect(verifyLink(tip, 17, chain[17])).toBe(true);
    expect(verifyLink({ n: 17, link: chain[17] }, 18, chain[18])).toBe(true);
    expect(verifyLink({ n: 17, link: chain[17] }, 17, chain[17])).toBe(true);
  });

  it("refuses a wrong link, a reused one, one at the wrong index, or one going backwards", () => {
    const chain = buildChain(seed(3), 40);
    const other = buildChain(seed(4), 40);
    const tip = { n: 0, link: chain[0] };
    // Another chain's link (a made-up roll) never hashes to this tip.
    expect(verifyLink(tip, 1, other[1])).toBe(false);
    // The same link again for the next turn (a reused link) fails.
    expect(verifyLink({ n: 5, link: chain[5] }, 6, chain[5])).toBe(false);
    // The right bytes under the wrong index fail.
    expect(verifyLink(tip, 2, chain[1])).toBe(false);
    expect(verifyLink(tip, 1, chain[2])).toBe(false);
    // Never backwards, never past the chain, never a fraction.
    expect(verifyLink({ n: 5, link: chain[5] }, 4, chain[4])).toBe(false);
    expect(verifyLink(tip, CHAIN_LENGTH + 1, chain[1])).toBe(false);
    expect(verifyLink(tip, 1.5, chain[1])).toBe(false);
    // One flipped bit.
    const flipped = chain[3].slice();
    flipped[0] ^= 1;
    expect(verifyLink(tip, 3, flipped)).toBe(false);
  });

  it("recovers every earlier link from the newest one", () => {
    const chain = buildChain(seed(5), 30);
    const links = linksFrom(12, chain[12]);
    expect(links.length).toBe(13);
    for (let j = 0; j <= 12; j++) expect(bytesEqual(links[j], chain[j])).toBe(true);
  });

  it("makes fresh random seeds", () => {
    const a = newSeed();
    const b = newSeed();
    expect(a.length).toBe(32);
    expect(bytesEqual(a, b)).toBe(false);
  });

  it("names its suite and knows only it", () => {
    expect(DICE_SUITE).toBe("sha256-chain-v1");
    expect([...SUPPORTED_DICE_SUITES]).toEqual([DICE_SUITE]);
  });
});

describe("base64url links", () => {
  it("round-trip 32 bytes in 43 characters", () => {
    const bytes = buildChain(seed(6), 2)[1];
    const text = toB64url(bytes);
    expect(text.length).toBe(43);
    expect(bytesEqual(fromB64url(text, 32)!, bytes)).toBe(true);
    expect(isLinkText(text)).toBe(true);
  });

  it("refuse the wrong length, foreign characters and non-canonical spellings", () => {
    const text = toB64url(seed(7));
    expect(fromB64url(text.slice(1), 32)).toBeNull();
    expect(fromB64url(`${text.slice(0, 42)}+`, 32)).toBeNull();
    expect(fromB64url(`${text.slice(0, 42)}é`, 32)).toBeNull();
    // The last character carries 2 spare bits: they must be zero.
    const last = text[42];
    const B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
    const bumped = B64[B64.indexOf(last) + 1];
    expect(fromB64url(text.slice(0, 42) + bumped, 32)).toBeNull();
    expect(fromB64url(42, 32)).toBeNull();
    expect(isLinkText("short")).toBe(false);
  });
});

describe("rolls", () => {
  const w = buildChain(seed(8), 60);
  const b = buildChain(seed(9), 60);

  it("are the same on both sides: both links in, the same dice out", () => {
    expect(rollFor("sid-1", 5, w[5], b[5])).toEqual(rollFor("sid-1", 5, w[5], b[5]));
    const [d1, d2] = rollFor("sid-1", 5, w[5], b[5]);
    expect(d1).toBeGreaterThanOrEqual(1);
    expect(d2).toBeLessThanOrEqual(6);
  });

  it("change with either link, the turn and the game (no replay from another game)", () => {
    const base = Array.from({ length: 40 }, (_, t) => rollFor("sid-1", t + 2, w[t + 2], b[t + 2]).join());
    const otherGame = Array.from({ length: 40 }, (_, t) => rollFor("sid-2", t + 2, w[t + 2], b[t + 2]).join());
    const swapped = Array.from({ length: 40 }, (_, t) => rollFor("sid-1", t + 2, b[t + 2], w[t + 2]).join());
    expect(otherGame).not.toEqual(base);
    expect(swapped).not.toEqual(base);
  });

  it("are fair: every face about 1/6 over many rolls", () => {
    const counts = [0, 0, 0, 0, 0, 0];
    const chainW = buildChain(seed(10));
    const chainB = buildChain(seed(11));
    let total = 0;
    for (let g = 0; g < 10; g++) {
      for (let t = 2; t <= CHAIN_LENGTH; t++) {
        for (const d of rollFor(`g${g}`, t, chainW[t], chainB[t])) {
          counts[d - 1]++;
          total++;
        }
      }
    }
    // 11 980 dice: each face expected ~1997; a fair die stays well within ±6 %.
    for (const c of counts) expect(Math.abs(c / total - 1 / 6)).toBeLessThan(0.01);
    // Chi-square with 5 degrees of freedom: below 20.5 (p = 0.001).
    const e = total / 6;
    const chi = counts.reduce((a, c) => a + ((c - e) * (c - e)) / e, 0);
    expect(chi).toBeLessThan(20.5);
  });

  it("decide the opening with one die each, never a tie, ties rolled again", () => {
    let sawTie = false;
    for (let g = 0; g < 200; g++) {
      const o = openingFor(`open-${g}`, w[1], b[1]);
      expect(o.w).not.toBe(o.b);
      expect(o.starter).toBe(o.w > o.b ? "w" : "b");
      for (const [x, y] of o.ties) expect(x).toBe(y);
      if (o.ties.length > 0) sawTie = true;
    }
    expect(sawTie).toBe(true);
  });
});
