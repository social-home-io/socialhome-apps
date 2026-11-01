import { describe, expect, it } from "vitest";
import type { GroupMessage } from "@socialhome/app-sdk";
import { DETAILS_KIND, detailsMessage, readDetails } from "./share.js";
import { table } from "./fixtures.js";

const SETTINGS = { name: "Wichteln 2026", budget: "about 20 €", day: "2026-12-24", pairs: [[2, 3]] as [number, number][] };
const msg = (over: Partial<GroupMessage> = {}): GroupMessage => ({ id: "t1", seq: 4, from: 1, data: detailsMessage(SETTINGS), direct: false, ...over });

describe("the shared details", () => {
  it("round-trip from the organiser", () => {
    expect(detailsMessage(SETTINGS)).toMatchObject({ kind: DETAILS_KIND, v: 1 });
    expect(readDetails(msg(), table({ me: 2, isHost: false }))).toEqual(SETTINGS);
  });

  it("count only from the organiser's seat, at the table Social Home delivered them for", () => {
    expect(readDetails(msg({ from: 2 }), table())).toBeNull();
    expect(readDetails(msg({ id: "t2" }), table())).toBeNull();
    expect(readDetails(msg(), undefined)).toBeNull();
    expect(readDetails(msg(), table({ host: null }))).toBeNull();
  });

  it("refuse anything that isn't what it says", () => {
    const t = table();
    for (const data of [
      null,
      "x",
      [1],
      { ...detailsMessage(SETTINGS), kind: "other" },
      { ...detailsMessage(SETTINGS), v: 2 },
      { ...detailsMessage(SETTINGS), name: "x".repeat(81) },
      { ...detailsMessage(SETTINGS), budget: "a\nb" },
      { ...detailsMessage(SETTINGS), day: "2026-13-01" },
      { ...detailsMessage(SETTINGS), pairs: [[1, 2], [2, 3]] },
    ]) {
      expect(readDetails(msg({ data }), t), JSON.stringify(data)).toBeNull();
    }
  });

  it("keep no field it doesn't know (a result can't ride along)", () => {
    const d = readDetails(msg({ data: { ...detailsMessage(SETTINGS), giver: "Anna", result: "Ben" } }), table());
    expect(Object.keys(d!).sort()).toEqual(["budget", "day", "name", "pairs"]);
  });
});
