import { describe, expect, it } from "vitest";
import { ShError } from "@socialhome/app-sdk";
import { errorKey } from "./errors.js";
import { CATALOGS } from "./i18n.js";

describe("refusals in words", () => {
  it.each([
    ["not_host", "err.notHost"],
    ["host_elsewhere", "err.hostElsewhere"],
    ["state", "err.state"],
    ["too_few", "err.tooFew"],
    ["pairs", "err.pairs"],
    ["settings", "err.settings"],
    ["wish_too_long", "err.wishTooLong"],
    ["wish_updates", "err.wishUpdates"],
    ["household_too_old", "err.householdTooOld"],
    ["again_limit", "err.againLimit"],
    ["past_day", "err.pastDay"],
    ["no_result", "err.noResult"],
    ["unavailable", "err.unavailable"],
    ["invalid", "err.settings"],
    ["permission_denied", "err.permission"],
    ["engine_not_supported", "err.unsupported"],
    ["engine_not_declared", "err.unsupported"],
    ["group_closed", "err.closed"],
    ["too_soon", "err.busy"],
    ["something_new", "err.generic"],
  ])("%s → %s", (code, key) => {
    expect(errorKey(new ShError(code, "x"))).toBe(key);
    expect(CATALOGS.en[key as keyof typeof CATALOGS.en]).toBeTruthy();
  });

  it("a plain error is a plain failure", () => {
    expect(errorKey(new Error("RPC timeout"))).toBe("err.generic");
    expect(errorKey("x")).toBe("err.generic");
  });
});
