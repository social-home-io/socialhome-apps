/**
 * Shared by the SDK's modules: refusals ({@link ShError}), permissions and
 * small helpers. Apps import these from `@socialhome/app-sdk`.
 */

import type { SocialHomeClient } from "./index.js";

/** @internal A seat number's upper bound. */
export const GROUP_SEAT_MAX = 999;
const GROUP_ID = /^[A-Za-z0-9_-]{1,128}$/;

/** @internal An integer in `[min, max]`. */
export function isInt(v: unknown, min: number, max: number): v is number {
  return typeof v === "number" && Number.isInteger(v) && v >= min && v <= max;
}

/** @internal A table id. */
export function isGroupId(v: unknown): v is string {
  return typeof v === "string" && GROUP_ID.test(v);
}

/** @internal Text of at most `max` characters, else `undefined`. */
export function optText(v: unknown, max: number): string | undefined {
  return typeof v === "string" && v && [...v].length <= max ? v : undefined;
}

/** @internal A field in the bridge's camelCase, or core's snake_case. */
export function field(v: Record<string, unknown>, camel: string, snake: string): unknown {
  return camel in v ? v[camel] : v[snake];
}

/** @internal Narrow an unknown value to a string-keyed record. */
export function isRecord(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === "object";
}

/**
 * What the household agreed to when an admin added the app, in plain words:
 * `storage` (saves its own data), `people` (lets you pick people to play
 * with) and `federation` (sends to other households; implies `people`).
 * A call outside them is refused with {@link ShError.code} `"permission_denied"`.
 */
export type Permission = "storage" | "people" | "federation";

/**
 * Why the host refused a call — {@link ShError.code}. Unknown codes may appear
 * in later Social Home versions; treat them as a plain failure.
 *
 * - `"permission_denied"` — outside the app's permissions ({@link ShError.permission} says which).
 * - `"use_people_pick"` — `federation.openSession` is gone: invites go through `people.pick`.
 * - `"busy"` — an invite sheet is already open.
 * - `"too_soon"` — the sheet just closed; try again after {@link ShError.retryAfterMs}.
 * - `"unknown_session"` — `federation.send` to a game Social Home doesn't know
 *   for that person (not opened through the sheet, not taken in with Play,
 *   or quiet for more than 90 days) — offer `people.pick({purpose: "continue"})`.
 * - `"invalid"` — `people.pick({purpose: "continue"})` without `sessionId` or `suggest`.
 * - `"unavailable"` — this host can't show the invite sheet.
 * - `"unknown_method"` — an older Social Home without the call.
 * - `"groups_not_supported"` — a `client.group` call on a Social Home without
 *   group games: offer 1:1 games instead.
 * - Group games (`client.group`): `"group_not_found"` (no place at that table),
 *   `"group_not_host"` (only the host may), `"group_closed"` (the table
 *   ended, or you aren't seated), `"group_full"`, `"group_too_few"` (fewer
 *   than `min` seated), `"group_seat"` (a `to` / `turn` seat isn't seated,
 *   or is your own), `"group_busy"` (the table's send budget is spent; try
 *   again after {@link ShError.retryAfterMs}), `"too_large"` (over 64 KiB),
 *   `"cant_join"` (the household keeps the person out — no reason given).
 * - Engines (`client.engines`, SDK 1.11): `"engine_not_supported"` (an older
 *   Social Home, or one without that engine), `"engine_not_declared"` (the
 *   manifest doesn't list the engine). The gift draw (`client.engines.draw`):
 *   `"not_host"` (only the person who started it),
 *   `"host_elsewhere"` (the draw passed to another household's person:
 *   v1 draws only from the household it started in), `"state"` (not now —
 *   e.g. settings while names are being drawn), `"too_few"` (fewer than
 *   three people), `"pairs"` (the pairs don't fit the people), `"settings"`
 *   (a setting Social Home refused), `"wish_too_long"`, `"wish_updates"`
 *   (five changes after the reveal used up), `"household_too_old"`
 *   (someone's home needs a newer Social Home), `"again_limit"`,
 *   `"past_day"` (the exchange day is over), `"no_result"`.
 * - `"error"` — anything else (`message` says what).
 */
export type ShErrorCode =
  | "permission_denied"
  | "use_people_pick"
  | "busy"
  | "too_soon"
  | "unknown_session"
  | "invalid"
  | "unavailable"
  | "unknown_method"
  | "groups_not_supported"
  | "group_not_found"
  | "group_not_host"
  | "group_closed"
  | "group_full"
  | "group_too_few"
  | "group_seat"
  | "group_busy"
  | "too_large"
  | "cant_join"
  | "engine_not_supported"
  | "engine_not_declared"
  | "not_host"
  | "host_elsewhere"
  | "state"
  | "too_few"
  | "pairs"
  | "settings"
  | "wish_too_long"
  | "wish_updates"
  | "household_too_old"
  | "again_limit"
  | "past_day"
  | "no_result"
  | "error"
  | (string & {});

/** A refused call. An `Error`, so existing `catch` blocks keep working. */
export class ShError extends Error {
  readonly code: ShErrorCode;
  /** On `"permission_denied"`: the permission the call needed. */
  readonly permission?: Permission;
  /** On `"too_soon"`: how long until the sheet may open again. */
  readonly retryAfterMs?: number;

  constructor(
    code: ShErrorCode,
    message: string,
    extra: { permission?: Permission; retryAfterMs?: number } = {},
  ) {
    super(message);
    this.name = "ShError";
    this.code = code;
    if (extra.permission !== undefined) this.permission = extra.permission;
    if (extra.retryAfterMs !== undefined) this.retryAfterMs = extra.retryAfterMs;
  }
}

/** Read a host error reply (a string from older hosts, `{code, message, …}` since 2026.10). */
export function toShError(v: unknown): ShError {
  if (typeof v === "string") return new ShError("error", v);
  if (!isRecord(v)) return new ShError("error", "Unknown error from host");
  const code = typeof v["code"] === "string" && v["code"] ? v["code"] : "error";
  const message = typeof v["message"] === "string" && v["message"] ? v["message"] : code;
  const p = v["permission"];
  const permission = p === "storage" || p === "people" || p === "federation" ? p : undefined;
  const r = v["retryAfterMs"];
  const retryAfterMs = typeof r === "number" && Number.isFinite(r) && r >= 0 ? r : undefined;
  return new ShError(code, message, { permission, retryAfterMs });
}

/** Unsubscribe function returned by the `on*` subscription methods. */
export type Unsubscribe = () => void;

/** @internal How long a call waits for the host. */
export const CALL_TIMEOUT_MS = 15_000;
/** @internal `people.pick` and `group.open` wait for a person to choose: give them time. */
export const PICK_TIMEOUT_MS = 30 * 60_000;

/**
 * @internal An engine's call (the SDK's engine modules, e.g. `draw.ts`): an
 * older host's `unknown_method` reads as `engine_not_supported`.
 */
export function engineCall(
  client: SocialHomeClient,
  method: string,
  params: Record<string, unknown>,
): Promise<unknown> {
  return client._call(method, params).catch((err: unknown) => {
    if (err instanceof ShError && err.code === "unknown_method") {
      throw new ShError("engine_not_supported", "This Social Home doesn't run that engine.");
    }
    throw err;
  });
}
