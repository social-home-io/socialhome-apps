/**
 * Saving the lobby's choices (board size, colour, clock …) — pure, tested.
 *
 * Every change used to go out as its own `store.set`, fire and forget. Two
 * quick changes of one choice could then land in the wrong order and the
 * older one stay saved. Here the saves of one key run one after another,
 * and a save waiting behind a running one is replaced by the newest
 * value: the last change always lands last, and a burst of changes costs
 * at most two writes.
 */

export type StoreSet = (key: string, value: unknown) => Promise<void>;

/** A `save(key, value)` that keeps each key's saves in order, last one wins. */
export function prefSaver(set: StoreSet, onError: (key: string) => void = () => {}): StoreSet {
  const waiting = new Map<string, unknown>();
  const running = new Map<string, Promise<void>>();
  return (key, value) => {
    waiting.set(key, value);
    const busy = running.get(key);
    // The running save picks the newest value up when it is done.
    if (busy) return busy;
    const run = (async () => {
      try {
        while (waiting.has(key)) {
          const next = waiting.get(key);
          waiting.delete(key);
          try {
            await set(key, next);
          } catch {
            // A refused save (rate limit, offline): the choice stays on screen; the next change saves it again.
            onError(key);
          }
        }
      } finally {
        running.delete(key);
      }
    })();
    running.set(key, run);
    return run;
  };
}
