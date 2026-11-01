import { describe, expect, it } from "vitest";
import { clearDraft, forgetDetails, loadDetails, loadDraft, saveDetails, saveDraft, toStoredDraft } from "./persist.js";
import type { Store } from "./persist.js";

function memoryStore() {
  const data: Record<string, unknown> = {};
  const store: Store = {
    get: async (k) => data[k] ?? null,
    set: async (k, v) => { data[k] = JSON.parse(JSON.stringify(v)); },
    delete: async (k) => { delete data[k]; },
    list: async () => ({ ...data }),
  };
  return { data, store };
}

describe("what the app keeps", () => {
  it("keeps the shared details per table and reads them back", async () => {
    const { data, store } = memoryStore();
    await saveDetails(store, "t1", { name: "W", budget: "20 €", day: "2026-12-24", pairs: [[1, 2]] });
    expect(Object.keys(data)).toEqual(["details:t1"]);
    expect(loadDetails(await store.list()).get("t1")?.name).toBe("W");
    await forgetDetails(store, "t1");
    expect(data).toEqual({});
  });

  it("keeps only the named fields — never anything else that came along", async () => {
    const { data, store } = memoryStore();
    const sneaky = { name: "W", budget: "", day: null, pairs: [], result: "Ben", giver: "Anna" } as never;
    await saveDetails(store, "t1", sneaky);
    await saveDraft(store, { name: "W", budget: "", day: "", wish: "tea", recipient: "Ben" } as never);
    expect(Object.keys(data["details:t1"] as object).sort()).toEqual(["budget", "day", "name", "pairs"]);
    expect(Object.keys(data["draft"] as object).sort()).toEqual(["budget", "day", "name", "wish"]);
    expect(JSON.stringify(data)).not.toContain("Ben");
  });

  it("leaves out bad entries when reading", () => {
    const got = loadDetails({ "details:a": { name: 3 }, "details:b": { name: "ok" }, other: 1 });
    expect([...got.keys()]).toEqual(["b"]);
  });

  it("keeps the New gift draw form while it isn't sent", async () => {
    const { store } = memoryStore();
    await saveDraft(store, { name: " Wichteln\n2026 ", budget: "20 €", day: "2026-02-30", wish: "socks" });
    expect(loadDraft(await store.list())).toEqual({ name: "Wichteln 2026", budget: "20 €", day: "", wish: "socks" });
    await clearDraft(store);
    expect(loadDraft(await store.list())).toEqual({ name: "", budget: "", day: "", wish: "" });
    expect(loadDraft({ draft: "x" })).toEqual({ name: "", budget: "", day: "", wish: "" });
    expect(toStoredDraft({ name: "", budget: "", day: "", wish: "x".repeat(900) }).wish.length).toBe(520);
  });
});
