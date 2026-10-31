import { describe, expect, it } from "vitest";
import { sha256, toHex, utf8 } from "./sha256.js";

async function webcrypto(data: Uint8Array): Promise<string> {
  const d = await globalThis.crypto.subtle.digest("SHA-256", data as BufferSource);
  return toHex(new Uint8Array(d));
}

describe("sha256 — FIPS 180-4 vectors", () => {
  it("hashes the empty message", () => {
    expect(toHex(sha256(new Uint8Array(0)))).toBe(
      "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    );
  });

  it('hashes "abc" (one block)', () => {
    expect(toHex(sha256(utf8("abc")))).toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
  });

  it("hashes the 448-bit message (padding spills into a second block)", () => {
    expect(toHex(sha256(utf8("abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq")))).toBe(
      "248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1",
    );
  });

  it("hashes the 896-bit message", () => {
    const m =
      "abcdefghbcdefghicdefghijdefghijkefghijklfghijklmghijklmnhijklmnoijklmnopjklmnopqklmnopqrlmnopqrsmnopqrstnopqrstu";
    expect(toHex(sha256(utf8(m)))).toBe(
      "cf5b16a778af8380036ce59e7b0492370b249b11e8f07a51afac45037afee9d1",
    );
  });

  it("hashes one million 'a'", () => {
    expect(toHex(sha256(new Uint8Array(1_000_000).fill(0x61)))).toBe(
      "cdc76e5c9914fb9281a1c7e284d73e67f1809a48a497200e046d39ccc7112cd0",
    );
  });
});

describe("sha256 — matches WebCrypto", () => {
  it("for every length 0..200 and around block edges", async () => {
    for (let len = 0; len <= 200; len++) {
      const data = new Uint8Array(len);
      for (let i = 0; i < len; i++) data[i] = (i * 31 + len * 7) & 0xff;
      expect(toHex(sha256(data)), `len ${len}`).toBe(await webcrypto(data));
    }
  });

  it("for random inputs up to 4 KiB", async () => {
    for (let n = 0; n < 50; n++) {
      const data = globalThis.crypto.getRandomValues(new Uint8Array(Math.floor(Math.random() * 4096)));
      expect(toHex(sha256(data))).toBe(await webcrypto(data));
    }
  });
});
