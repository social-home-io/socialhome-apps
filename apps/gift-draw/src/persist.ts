/**
 * What the gift draw keeps in Social Home's per-person store (pure apart
 * from the store passed in, unit-tested).
 *
 * Exactly two kinds of entry, nothing else:
 *
 * - `details:<table>` — the organiser's shared details (share.ts), so they
 *   still show after Social Home handed the message over once;
 * - `draft` — the person's unsent New gift draw form (name, budget, day,
 *   wish list).
 *
 * **Never a result.** The app never learns whom anybody gives to (Social
 * Home shows it in its own sheet), and these functions take only the
 * fields named here, so nothing else can slip into storage.
 */

import { parseDrawSettings } from "@socialhome/app-sdk";
import type { DrawSettings } from "@socialhome/app-sdk";
import { BUDGET_MAX, NAME_MAX, WISH_MAX, cleanLine, isDay } from "./rules.js";

/** The slice of `sh.store` the app uses. */
export interface Store {
  get(key: string): Promise<unknown>;
  set(key: string, value: unknown): Promise<void>;
  delete(key: string): Promise<void>;
  list(): Promise<Record<string, unknown>>;
}

/** The New gift draw form while it isn't sent. */
export interface Draft {
  name: string;
  budget: string;
  day: string;
  wish: string;
}

export const EMPTY_DRAFT: Draft = { name: "", budget: "", day: "", wish: "" };

const DETAILS_PREFIX = "details:";
const DRAFT_KEY = "draft";

/** Only the named fields, each the right kind. */
export function toStoredDetails(s: DrawSettings): DrawSettings {
  return { name: s.name, budget: s.budget, day: s.day, pairs: s.pairs.map(([a, b]) => [a, b] as [number, number]) };
}

export function toStoredDraft(d: Draft): Draft {
  return {
    name: cleanLine(String(d.name ?? ""), NAME_MAX),
    budget: cleanLine(String(d.budget ?? ""), BUDGET_MAX),
    day: isDay(String(d.day ?? "")) ? d.day : "",
    wish: [...String(d.wish ?? "")].slice(0, WISH_MAX + 20).join(""),
  };
}

export function saveDetails(store: Store, tableId: string, s: DrawSettings): Promise<void> {
  return store.set(DETAILS_PREFIX + tableId, toStoredDetails(s));
}

export function forgetDetails(store: Store, tableId: string): Promise<void> {
  return store.delete(DETAILS_PREFIX + tableId);
}

/** Every table's kept details (bad entries left out). */
export function loadDetails(all: Record<string, unknown>): Map<string, DrawSettings> {
  const out = new Map<string, DrawSettings>();
  for (const [key, value] of Object.entries(all)) {
    if (!key.startsWith(DETAILS_PREFIX)) continue;
    const s = parseDrawSettings(value);
    if (s) out.set(key.slice(DETAILS_PREFIX.length), s);
  }
  return out;
}

export function saveDraft(store: Store, d: Draft): Promise<void> {
  return store.set(DRAFT_KEY, toStoredDraft(d));
}

export function clearDraft(store: Store): Promise<void> {
  return store.delete(DRAFT_KEY);
}

export function loadDraft(all: Record<string, unknown>): Draft {
  const v = all[DRAFT_KEY];
  if (v === null || typeof v !== "object") return { ...EMPTY_DRAFT };
  const o = v as Record<string, unknown>;
  return toStoredDraft({
    name: typeof o["name"] === "string" ? o["name"] : "",
    budget: typeof o["budget"] === "string" ? o["budget"] : "",
    day: typeof o["day"] === "string" ? o["day"] : "",
    wish: typeof o["wish"] === "string" ? o["wish"] : "",
  });
}
