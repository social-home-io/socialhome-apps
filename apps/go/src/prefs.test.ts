import { describe, expect, it } from "vitest";
import { prefSaver } from "./prefs.js";

/** A store whose writes finish only when the test says so, in any order. */
function slowStore() {
  const saved = new Map<string, unknown>();
  const calls: { key: string; value: unknown; done: (fail?: boolean) => void }[] = [];
  const set = (key: string, value: unknown) =>
    new Promise<void>((resolve, reject) => {
      calls.push({
        key,
        value,
        done: (fail) => {
          if (fail) return reject(new Error("refused"));
          saved.set(key, value);
          resolve();
        },
      });
    });
  return { saved, calls, set };
}

const tick = () => new Promise((r) => setTimeout(r, 0));

describe("prefSaver", () => {
  it("keeps one key's saves in order: the last change lands last", async () => {
    const s = slowStore();
    const save = prefSaver(s.set);
    const all = [save("pref:size", 9), save("pref:size", 13), save("pref:size", 19)];
    // Only the first write is out; the others wait behind it.
    expect(s.calls.map((c) => c.value)).toEqual([9]);
    s.calls[0].done();
    await tick();
    // The waiting ones collapse into the newest value.
    expect(s.calls.map((c) => c.value)).toEqual([9, 19]);
    s.calls[1].done();
    await Promise.all(all);
    expect(s.saved.get("pref:size")).toBe(19);
  });

  it("never lets an older value overwrite a newer one, even if the store answers out of order", async () => {
    const s = slowStore();
    const save = prefSaver(s.set);
    void save("pref:color", "b");
    void save("pref:color", "w");
    // The store can't answer the second before the first: it isn't sent yet.
    expect(s.calls).toHaveLength(1);
    s.calls[0].done();
    await tick();
    s.calls[1].done();
    await tick();
    expect(s.saved.get("pref:color")).toBe("w");
  });

  it("different keys don't wait for each other", () => {
    const s = slowStore();
    const save = prefSaver(s.set);
    void save("pref:size", 13);
    void save("pref:color", "w");
    expect(s.calls.map((c) => c.key)).toEqual(["pref:size", "pref:color"]);
  });

  it("goes on after a refused save, and reports it", async () => {
    const s = slowStore();
    const failed: string[] = [];
    const save = prefSaver(s.set, (k) => failed.push(k));
    const p = save("pref:days", 1);
    void save("pref:days", 3);
    s.calls[0].done(true);
    await tick();
    s.calls[1].done();
    await p;
    expect(failed).toEqual(["pref:days"]);
    expect(s.saved.get("pref:days")).toBe(3);
    // A new change after everything settled starts a fresh save.
    void save("pref:days", 5);
    expect(s.calls).toHaveLength(3);
  });
});
