/**
 * Open games in a space ("tables", Social Home v_77, SDK 1.9) — pure helpers
 * (no DOM, no SDK calls), unit-tested.
 *
 * A member opens Chess as an open game in a space; when someone else takes
 * the seat, Social Home starts the table by itself (a table of two). The game
 * then runs over the table instead of a 1:1 session: moves go out with
 * `sh.group.send(table, state, {turn: theirSeat})` and come in as group
 * `message` events. Everything else — the history, the judge, the board — is
 * the same as for a game from an invite.
 *
 * **Who plays which colour.** Seats, not people: the seat that opened the
 * table is seat 1 (Social Home seats the opener there, and a waiting table
 * whose opener leaves is closed). Whoever takes the seat plays White and
 * moves first; the opener plays Black. Both sides work it out from their own
 * seat, nothing about it travels, and the person who just joined can play at
 * once while the opener gets "Your turn" after the first move.
 *
 * **Never trust the other side.** A table message is taken only for a table
 * this person has a game at (the table Social Home delivered it for, never an
 * id inside the payload), only from the other player's seat, and then judged
 * exactly like a 1:1 move (inbound.ts).
 */

import type { GroupEvent, GroupMessage, GroupPlayer, GroupSession } from "@socialhome/app-sdk";
import { initialState } from "./chess.js";
import type { Color } from "./chess.js";
import type { GameEntry } from "./lifecycle.js";

/** The seat Social Home gives the person who opened a table. */
export const OPENER_SEAT = 1;

/** Where a game played at a table sits. */
export interface TableInfo {
  /** Our seat. */
  me: number;
  /** The other player's seat; `null` while nobody has taken it. */
  them: number | null;
  /** The space the table was opened in. */
  spaceId?: string;
}

/** The colour a seat plays: whoever takes the seat moves first (White). */
export function tableColor(mySeat: number): Color {
  return mySeat === OPENER_SEAT ? "b" : "w";
}

/** The other player at a two-player table (seated first, else the one who left). */
export function otherPlayer(session: GroupSession): GroupPlayer | undefined {
  const others = session.players.filter((p) => p.seat !== session.me);
  return others.find((p) => p.state === "seated") ?? others[0];
}

/** Whether the person sits at this table and it can hold a game of chess. */
export function isPlayableTable(session: GroupSession): boolean {
  return (
    session.me !== null &&
    session.myState === "seated" &&
    session.state !== "ended" &&
    session.max === 2
  );
}

/**
 * A new game for a table the person sits at, or `null` when it can't hold one
 * (not seated, ended, not two players). Before someone takes the seat the
 * opener's game waits with an empty opponent.
 */
export function entryForTable(session: GroupSession, now = 0): GameEntry | null {
  if (!isPlayableTable(session)) return null;
  const me = session.me!;
  const other = otherPlayer(session);
  return {
    sessionId: session.id,
    opponentInstanceId: "",
    opponentRef: "",
    opponentIsLocal: other?.isLocal ?? false,
    opponentName: other?.name ?? "",
    myColor: tableColor(me),
    state: initialState(),
    inviter: false,
    accepted: true,
    table: {
      me,
      them: other?.seat ?? null,
      ...(session.spaceId ? { spaceId: session.spaceId } : {}),
    },
    updatedAt: now,
  };
}

/**
 * Take what the table now says about the other player into a game: their
 * seat the first time someone sits down, and their name. Our own seat and
 * colour never change. Returns whether anything changed, and whether this
 * was someone taking the seat.
 */
export function updateFromTable(entry: GameEntry, session: GroupSession): { changed: boolean; joined: boolean } {
  const table = entry.table;
  if (!table || session.id !== entry.sessionId) return { changed: false, joined: false };
  const other = otherPlayer(session);
  if (!other) return { changed: false, joined: false };
  let changed = false;
  let joined = false;
  if (table.them === null) {
    table.them = other.seat;
    changed = joined = true;
  }
  // Only the player in their seat names it (a hostile roster can't swap seats).
  if (other.seat === table.them) {
    if (other.name && other.name !== entry.opponentName) {
      entry.opponentName = other.name;
      changed = true;
    }
    if (other.isLocal !== entry.opponentIsLocal) {
      entry.opponentIsLocal = other.isLocal;
      changed = true;
    }
  }
  return { changed, joined };
}

/** Where a table message goes. */
export type TableRoute =
  | { kind: "game"; entry: GameEntry }
  | { kind: "drop"; reason: "unknown-game" | "not-opponent" | "no-opponent-yet" };

/**
 * Social Home delivered `msg` for table `msg.id` from seat `msg.from`: it is
 * a game only when we play at that table, and a move only from the other
 * player's seat (never ours, never a third seat). Ids inside the payload are
 * ignored.
 */
export function routeTableMessage(msg: GroupMessage, games: ReadonlyMap<string, GameEntry>): TableRoute {
  const entry = games.get(msg.id);
  if (!entry?.table) return { kind: "drop", reason: "unknown-game" };
  if (msg.from === entry.table.me) return { kind: "drop", reason: "not-opponent" };
  if (entry.table.them === null) return { kind: "drop", reason: "no-opponent-yet" };
  if (msg.from !== entry.table.them) return { kind: "drop", reason: "not-opponent" };
  return { kind: "game", entry };
}

/** What chess does with a table event (other than a message). */
export type TableAction =
  /** A table we have no game at yet, that we now sit at: start it. */
  | { kind: "seat"; session: GroupSession }
  /** Someone took the seat at our open game. */
  | { kind: "joined"; entry: GameEntry }
  /** The other player left or the table ended while the game was on. */
  | { kind: "gone"; entry: GameEntry; reason: "left" | "ended" }
  /** Our own place is over (left on another screen, removed). */
  | { kind: "mine-over"; entry: GameEntry }
  /** Take the table's names into the game. */
  | { kind: "update"; entry: GameEntry }
  | { kind: "ignore" };

/** A game that hasn't ended on our board. */
const unfinished = (entry: GameEntry): boolean => entry.state.result === null;

/** Decide what a table event means for the games we have. */
export function classifyTableEvent(event: GroupEvent, games: ReadonlyMap<string, GameEntry>): TableAction {
  if (event.type === "message") return { kind: "ignore" };
  const session = event.session;
  const entry = games.get(event.id);
  if (!entry) {
    // A table we don't have a game at: only one we now sit at, being played
    // or waiting (e.g. opened on another screen).
    return isPlayableTable(session) ? { kind: "seat", session } : { kind: "ignore" };
  }
  if (!entry.table) return { kind: "ignore" }; // a 1:1 game with that id: never moved to a table
  const table = entry.table;
  switch (event.type) {
    case "left":
    case "removed":
      if (event.seat === table.me) return { kind: "mine-over", entry };
      if (event.seat === table.them && unfinished(entry)) return { kind: "gone", entry, reason: "left" };
      return { kind: "ignore" };
    case "ended":
      return unfinished(entry) ? { kind: "gone", entry, reason: "ended" } : { kind: "ignore" };
    case "joined":
    case "started": {
      const wasWaiting = table.them === null;
      const { joined } = updateFromTable(entry, session);
      if (joined && wasWaiting) return { kind: "joined", entry };
      return { kind: "update", entry };
    }
    default:
      updateFromTable(entry, session);
      return { kind: "update", entry };
  }
}

/** A table game still waiting for someone to take the seat. */
export function isWaitingForPlayer(entry: GameEntry): boolean {
  return entry.table !== undefined && entry.table.them === null && unfinished(entry);
}

/** A clean `TableInfo` from a saved game, or `undefined`. */
export function parseTableInfo(v: unknown): TableInfo | undefined {
  if (typeof v !== "object" || v === null) return undefined;
  const r = v as Record<string, unknown>;
  const seat = (x: unknown): x is number => typeof x === "number" && Number.isInteger(x) && x >= 1;
  if (!seat(r["me"])) return undefined;
  if (r["them"] !== null && !seat(r["them"])) return undefined;
  if (r["them"] === r["me"]) return undefined;
  return {
    me: r["me"],
    them: (r["them"] as number | null) ?? null,
    ...(typeof r["spaceId"] === "string" ? { spaceId: r["spaceId"] } : {}),
  };
}
