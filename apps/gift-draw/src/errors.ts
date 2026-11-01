/**
 * A refused call as words for people (pure, unit-tested): every code
 * Social Home may answer for a gift-draw or table call maps to a message
 * key; anything else is a plain "That didn't work".
 */

import { ShError } from "@socialhome/app-sdk";
import type { MessageKey } from "./i18n.js";

const KEYS: Record<string, MessageKey> = {
  not_host: "err.notHost",
  group_not_host: "err.notHost",
  host_elsewhere: "err.hostElsewhere",
  state: "err.state",
  too_few: "err.tooFew",
  group_too_few: "err.tooFew",
  pairs: "err.pairs",
  settings: "err.settings",
  invalid: "err.settings",
  wish_too_long: "err.wishTooLong",
  wish_updates: "err.wishUpdates",
  household_too_old: "err.householdTooOld",
  again_limit: "err.againLimit",
  past_day: "err.pastDay",
  no_result: "err.noResult",
  unavailable: "err.unavailable",
  permission_denied: "err.permission",
  engine_not_supported: "err.unsupported",
  engine_not_declared: "err.unsupported",
  groups_not_supported: "err.unsupported",
  unknown_method: "err.unsupported",
  busy: "err.busy",
  too_soon: "err.busy",
  group_busy: "err.busy",
  group_closed: "err.closed",
  group_not_found: "err.closed",
};

export function errorKey(err: unknown): MessageKey {
  if (err instanceof ShError) return KEYS[err.code] ?? "err.generic";
  return "err.generic";
}
