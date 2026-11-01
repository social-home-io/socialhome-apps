/**
 * The details the organiser shares before the names are drawn (pure,
 * unit-tested).
 *
 * Social Home hands the draw's settings to the other households only when
 * the names are drawn. So that everyone sees the name, budget, exchange day
 * and pairs while people still join, the organiser's app sends them to the
 * table with `sh.group.send` each time they change (and when someone sits
 * down). It is state, not a step: a closed app gets the latest one.
 *
 * **Never trust it.** A details message counts only at the table Social
 * Home delivered it for, only from the organiser's seat (`session.host`),
 * and only when every field is what it says (the SDK's
 * `parseDrawSettings`: one-line name ≤ 80 and budget ≤ 40, a real day,
 * pairs of different seats). It is shown as plain text and never decides
 * anything: once the names are drawn, Social Home's own copy
 * (`status.settings`) is shown instead.
 */

import { parseDrawSettings } from "@socialhome/app-sdk";
import type { DrawSettings, GroupMessage, GroupSession } from "@socialhome/app-sdk";

/** What the message says it is. */
export const DETAILS_KIND = "gift-draw.details";
/** Its version: a later app may add fields; an unknown version is ignored. */
export const DETAILS_VERSION = 1;

/** The message the organiser sends. */
export function detailsMessage(settings: DrawSettings): Record<string, unknown> {
  return {
    kind: DETAILS_KIND,
    v: DETAILS_VERSION,
    name: settings.name,
    budget: settings.budget,
    day: settings.day,
    pairs: settings.pairs.map(([a, b]) => [a, b]),
  };
}

/**
 * The details in *msg*, or `null` when it isn't a details message from the
 * organiser of *table* (the table Social Home delivered it for).
 */
export function readDetails(msg: GroupMessage, table: GroupSession | undefined): DrawSettings | null {
  if (!table || msg.id !== table.id || table.host === null || msg.from !== table.host) return null;
  const d = msg.data;
  if (d === null || typeof d !== "object" || Array.isArray(d)) return null;
  const o = d as Record<string, unknown>;
  if (o["kind"] !== DETAILS_KIND || o["v"] !== DETAILS_VERSION) return null;
  return parseDrawSettings({ name: o["name"], budget: o["budget"], day: o["day"], pairs: o["pairs"] });
}
