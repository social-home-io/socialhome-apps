/**
 * A debounced, de-duplicating writer for one polite live region.
 *
 * Several things can want to speak at once (a move arrives, the board
 * re-renders, a turn nudge fires); screen readers drop or stutter when a live
 * region changes several times in a few milliseconds. The announcer collects
 * every message within `delayMs`, drops repeats inside that batch, and speaks
 * the batch as one sentence. The same text again within `dedupeMs` of being
 * spoken is skipped (a re-render or a second delivery of the same move must
 * not announce twice); after that window it is spoken again (pressing Escape
 * twice a minute apart should be heard twice).
 *
 * Pure apart from the injected `write` + clock, so it is unit-tested with
 * fake timers.
 */

export interface AnnouncerOptions {
  delayMs?: number;
  dedupeMs?: number;
  now?: () => number;
  schedule?: (fn: () => void, ms: number) => unknown;
  cancel?: (handle: unknown) => void;
}

export interface Announcer {
  announce(text: string): void;
  /** Drop anything queued (e.g. when leaving the board). */
  clear(): void;
}

export function createAnnouncer(
  write: (text: string) => void,
  opts: AnnouncerOptions = {},
): Announcer {
  const delayMs = opts.delayMs ?? 150;
  const dedupeMs = opts.dedupeMs ?? 2000;
  const now = opts.now ?? (() => Date.now());
  const schedule = opts.schedule ?? ((fn, ms) => setTimeout(fn, ms));
  const cancel = opts.cancel ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout>));

  let pending: string[] = [];
  let timer: unknown = null;
  let lastText = "";
  let lastAt = -Infinity;

  function flush(): void {
    timer = null;
    const text = pending.join(" ");
    pending = [];
    if (!text) return;
    const t = now();
    if (text === lastText && t - lastAt < dedupeMs) return;
    lastText = text;
    lastAt = t;
    write(text);
  }

  return {
    announce(text: string): void {
      const trimmed = text.trim();
      if (!trimmed || pending.includes(trimmed)) return;
      pending.push(trimmed);
      if (timer !== null) cancel(timer);
      timer = schedule(flush, delayMs);
    },
    clear(): void {
      if (timer !== null) cancel(timer);
      timer = null;
      pending = [];
    },
  };
}
