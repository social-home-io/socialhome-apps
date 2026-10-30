/** The live-region writer: debounced, batched, no duplicates. */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createAnnouncer } from "./announcer.js";

describe("createAnnouncer", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  function setup() {
    const spoken: string[] = [];
    const a = createAnnouncer((t) => spoken.push(t), { delayMs: 150, dedupeMs: 2000 });
    return { a, spoken };
  }

  it("waits for the debounce before speaking", () => {
    const { a, spoken } = setup();
    a.announce("Ben moved knight to f3. Your turn.");
    expect(spoken).toEqual([]);
    vi.advanceTimersByTime(150);
    expect(spoken).toEqual(["Ben moved knight to f3. Your turn."]);
  });

  it("batches messages in one window into one sentence, in order", () => {
    const { a, spoken } = setup();
    a.announce("You moved pawn to e4.");
    vi.advanceTimersByTime(100);
    a.announce("Ben moved pawn to e5. Your turn.");
    vi.advanceTimersByTime(150);
    expect(spoken).toEqual(["You moved pawn to e4. Ben moved pawn to e5. Your turn."]);
  });

  it("drops a repeat inside the batch", () => {
    const { a, spoken } = setup();
    a.announce("Selection cleared.");
    a.announce("Selection cleared.");
    vi.advanceTimersByTime(150);
    expect(spoken).toEqual(["Selection cleared."]);
  });

  it("does not repeat the same text right after speaking it", () => {
    const { a, spoken } = setup();
    a.announce("Ben moved knight to f3. Your turn.");
    vi.advanceTimersByTime(150);
    a.announce("Ben moved knight to f3. Your turn.");
    vi.advanceTimersByTime(150);
    expect(spoken).toHaveLength(1);
  });

  it("speaks the same text again once the dedupe window has passed", () => {
    const { a, spoken } = setup();
    a.announce("Selection cleared.");
    vi.advanceTimersByTime(150);
    vi.advanceTimersByTime(2500);
    a.announce("Selection cleared.");
    vi.advanceTimersByTime(150);
    expect(spoken).toEqual(["Selection cleared.", "Selection cleared."]);
  });

  it("ignores blank text and clear() drops the queue", () => {
    const { a, spoken } = setup();
    a.announce("   ");
    a.announce("Knight on g1. Moves to f3 and h3.");
    a.clear();
    vi.advanceTimersByTime(500);
    expect(spoken).toEqual([]);
  });
});
