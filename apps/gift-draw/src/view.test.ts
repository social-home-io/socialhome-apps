import { describe, expect, it } from "vitest";
import {
  canEditDetails,
  chipOf,
  drawBlock,
  blamedHomes,
  homesCount,
  isOurTable,
  listOrder,
  livePairs,
  namesOf,
  oneHousehold,
  twoHouseholds,
  organiserName,
  phaseOf,
  progressOf,
  seatedPeople,
  shownDetails,
  waitingHomes,
} from "./view.js";
import type { Phase } from "./view.js";
import { ANNA, BEN, CLEO, LENA, status, table } from "./fixtures.js";

describe("phaseOf: every state of a gift draw", () => {
  it.each([
    ["invited", table({ myState: "invited", me: null }), undefined, "invited"],
    ["joining", table({ myState: "joining", me: null }), undefined, "joining"],
    ["left", table({ myState: "left" }), status(), "gone"],
    ["removed", table({ myState: "removed" }), status(), "gone"],
    ["a closed table", table({ state: "ended", endReason: "cancelled" }), status({ state: "ready", hasResult: true }), "ended"],
    ["no state yet", table(), undefined, "loading"],
    ["gathering", table(), status(), "gathering"],
    ["drawing", table({ state: "playing" }), status({ state: "drawing", round: 1 }), "drawing"],
    ["ready with a name", table({ state: "playing" }), status({ state: "ready", hasResult: true }), "ready"],
    ["ready without a name", table({ state: "playing" }), status({ state: "ready" }), "readyNoName"],
    ["failed: rules", table({ state: "playing" }), status({ state: "failed", reason: "rules" }), "failedRules"],
    ["failed: too few", table({ state: "playing" }), status({ state: "failed", reason: "too_few" }), "failedTooFew"],
    ["failed: a reason we don't know", table({ state: "playing" }), status({ state: "failed", reason: "later" }), "failed"],
  ] as const)("%s", (_what, tb, st, want) => {
    expect(phaseOf(tb, st)).toBe(want);
  });

  it("says when the state didn't load", () => {
    expect(phaseOf(table(), undefined, true)).toBe("error");
  });
});

describe("the people", () => {
  it("lists only the seated, marks you and whoever started it", () => {
    const tb = table({ me: 2, isHost: false, players: [ANNA, BEN, { ...LENA, state: "left" }, CLEO] });
    const people = seatedPeople(tb);
    expect(people.map((p) => p.name)).toEqual(["Anna", "Ben", "Cleo"]);
    expect(people.find((p) => p.isMe)?.name).toBe("Ben");
    expect(people.find((p) => p.isOrganiser)?.name).toBe("Anna");
    expect(homesCount(people)).toBe(3);
    expect(organiserName(tb)).toBe("Anna");
    expect(namesOf(tb, [3, 9, 1])).toEqual(["Lena", "Anna"]);
  });

  it("knows when everyone is in one household (the About text's limit)", () => {
    const local = [ANNA, { ...BEN, household: null }, { ...LENA, household: null }];
    expect(oneHousehold(seatedPeople(table({ players: local })))).toBe(true);
    expect(oneHousehold(seatedPeople(table()))).toBe(false);
    expect(oneHousehold([])).toBe(false);
  });

  it("knows when everyone is in two households (the About text's second limit)", () => {
    expect(twoHouseholds(seatedPeople(table({ players: [ANNA, BEN, LENA] })))).toBe(true);
    expect(twoHouseholds(seatedPeople(table()))).toBe(false);
  });
});

describe("details and pairs", () => {
  it("shows Social Home's copy first, else what the organiser shared", () => {
    const shared = { name: "Shared", budget: "", day: null, pairs: [] };
    expect(shownDetails(status(), shared)?.name).toBe("Wichteln 2026");
    expect(shownDetails(status({ settings: null }), shared)?.name).toBe("Shared");
    expect(shownDetails(undefined, undefined)).toBeNull();
  });

  it("keeps only pairs whose two people are still seated", () => {
    const d = { name: "", budget: "", day: null, pairs: [[1, 2], [3, 4]] as [number, number][] };
    expect(livePairs(table({ players: [ANNA, BEN, LENA, { ...CLEO, state: "left" }] }), d)).toEqual([[1, 2]]);
  });

  it("lets only the organiser edit, and only before the names are drawn or after they failed", () => {
    expect(canEditDetails(status())).toBe(true);
    expect(canEditDetails(status({ state: "failed", reason: "rules" }))).toBe(true);
    expect(canEditDetails(status({ state: "drawing" }))).toBe(false);
    expect(canEditDetails(status({ state: "ready" }))).toBe(false);
    expect(canEditDetails(status({ isHost: false }))).toBe(false);
    expect(canEditDetails(undefined)).toBe(false);
  });

  it("blocks Draw names below 3 people or with pairs that don't fit", () => {
    expect(drawBlock(table({ players: [ANNA, BEN] }), [])).toBe("few");
    expect(drawBlock(table({ players: [ANNA, BEN, LENA] }), [[1, 2]])).toBe("pairs");
    expect(drawBlock(table(), [[1, 2]])).toBeNull();
    expect(drawBlock(table(), [])).toBeNull();
  });
});

describe("while names are drawn (the organiser only)", () => {
  const drawing = status({ state: "drawing", done: 2, waitingFor: [{ seats: [2, 3] }], blamed: [{ seats: [4] }] });

  it("shows progress in homes", () => {
    expect(progressOf(drawing, 3)).toEqual({ done: 2, of: 3 });
    expect(progressOf({ ...drawing, done: 9 }, 3)).toEqual({ done: 3, of: 3 });
    expect(progressOf({ ...drawing, isHost: false }, 3)).toBeNull();
    expect(progressOf({ ...drawing, done: undefined }, 3)).toBeNull();
  });

  it("names the homes it waits for, and the homes that stopped a round without proof", () => {
    expect(waitingHomes(table(), drawing)).toEqual([{ seats: [2, 3], names: ["Ben", "Lena"] }]);
    expect(waitingHomes(table(), { ...drawing, isHost: false })).toEqual([]);
    expect(waitingHomes(table(), { ...drawing, state: "ready" })).toEqual([]);
    expect(blamedHomes(table(), drawing)).toEqual([["Cleo"]]);
    expect(blamedHomes(table(), { ...drawing, isHost: false })).toEqual([]);
  });
});

describe("the list", () => {
  it("has a chip for every phase", () => {
    const all: Phase[] = ["invited", "joining", "gone", "ended", "loading", "error", "gathering", "drawing", "ready", "readyNoName", "failedRules", "failedTooFew", "failed"];
    expect(all.map(chipOf)).toEqual(["invited", "invited", "over", "over", null, null, "gathering", "drawing", "ready", "noName", "failed", "failed", "failed"]);
  });

  it("puts names to see first and finished ones last", () => {
    const phases: Phase[] = ["ended", "gathering", "ready", "drawing", "invited"];
    expect([...phases].sort(listOrder)).toEqual(["ready", "invited", "drawing", "gathering", "ended"]);
  });

  it("shows only this app's tables", () => {
    expect(isOurTable(table(), "gift-draw")).toBe(true);
    expect(isOurTable(table({ appId: "chess" }), "gift-draw")).toBe(false);
    expect(isOurTable(table({ appId: undefined }), "gift-draw")).toBe(true);
  });
});
