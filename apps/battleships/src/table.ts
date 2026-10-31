/**
 * Open games in a space ("tables", Social Home v_77, SDK 1.9) — pure helpers
 * (no DOM, no SDK calls), unit-tested.
 *
 * A member opens Battleships as an open game in a space; when someone else
 * takes the seat, Social Home starts the table by itself (a table of two).
 * The game then runs over the table instead of a 1:1 session: our message
 * goes out with `sh.group.send(table, message, {turn: theirSeat})` and theirs
 * comes in as a group `message` event. Everything else is the same as for a
 * game from an invite: the same messages (`bs` v1, the whole game each time),
 * the same fleet seals bound to the game's id (here: the table's id), the
 * same judge (`receive`) with the same void / cheat checks.
 *
 * **Seats → roles.** Seats, not people: the seat that opened the table is
 * seat 1 (Social Home seats the opener there, and a waiting table whose
 * opener leaves is closed).
 *
 *   - seat 1 (the opener)            → role `challenger`: fires second;
 *   - any other seat (who sat down)  → role `invitee`:    fires first.
 *
 * The person who takes the seat is in the app right then: they place their
 * fleet and lock it in at once. Their sealed fleet goes out handing the
 * opener the turn ("Your turn" — nobody else tells the opener someone sat
 * down); the opener places theirs and their seal goes back with the turn,
 * and the player who sat down fires the first shot. When the opener locked
 * their fleet in while waiting and their app is open as someone sits down,
 * the opener's seal goes out at once and the newcomer fires straight after
 * locking in (one message: seal + first shot) — the soonest the seals allow:
 * nobody can fire before holding the other fleet's seal.
 *
 * Both sides work the roles out from their own seat; nothing about them
 * travels. A message acting as the other role — a first shot from the
 * opener, a shot from a side that doesn't hold our seal — is refused or
 * voids the game exactly as in a 1:1 game (shot parity, `order`).
 *
 * **No setup to choose.** A 1:1 game has none either: the rules are always
 * "classic" (`RULES`) and a message with other rules or another version is
 * refused (`unsupported`) by the same judge.
 *
 * **"Your turn".** `turn: theirSeat` whenever the 1:1 game would send
 * `turn: true` (`passesTurn`), and also on our locked-in seal while theirs
 * hasn't come (`wait-seal`): at a 1:1 game the invite itself sits in the
 * other person's "Needs you", at a table nothing does — placing their fleet
 * is their move.
 *
 * **Never trust the other side.** A table message is taken only for a table
 * this person has a game at (the table Social Home delivered it for, never an
 * id inside the payload), only from the other player's seat, and then judged
 * exactly like a 1:1 message.
 */

import type { GroupEvent, GroupMessage, GroupPlayer, GroupSession } from "@socialhome/app-sdk";
import { newGame, phase } from "./game.js";
import type { Game, Role } from "./game.js";
import { canSend, passesTurn } from "./protocol.js";
import type { Fleet } from "./rules.js";
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

/** The role a seat plays: whoever takes the seat is the `invitee` and fires first. */
export function tableRole(mySeat: number): Role {
  return mySeat === OPENER_SEAT ? "challenger" : "invitee";
}

/** The other player at a two-player table (seated first, else the one who left). */
export function otherPlayer(session: GroupSession): GroupPlayer | undefined {
  const others = session.players.filter((p) => p.seat !== session.me);
  return others.find((p) => p.state === "seated") ?? others[0];
}

/** Whether the person sits at this table and it can hold a game of Battleships. */
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
 * (not seated, ended, not two players). `fleet` is the draft our player
 * places from. Before someone takes the seat the opener's game waits with an
 * empty opponent.
 */
export function entryForTable(session: GroupSession, fleet: Fleet, now = 0): GameEntry | null {
  if (!isPlayableTable(session)) return null;
  const me = session.me!;
  const other = otherPlayer(session);
  return {
    sessionId: session.id,
    opponentInstanceId: "",
    opponentRef: "",
    opponentIsLocal: other?.isLocal ?? false,
    opponentName: other?.name ?? "",
    game: newGame(session.id, tableRole(me), fleet, now),
    table: {
      me,
      them: other?.seat ?? null,
      ...(session.spaceId ? { spaceId: session.spaceId } : {}),
    },
  };
}

/** A saved table game whose role doesn't fit its seat is not ours to play. */
export function roleFitsSeat(entry: GameEntry): boolean {
  return !entry.table || (entry.game.role === tableRole(entry.table.me) && entry.game.sid === entry.sessionId);
}

/**
 * Take what the table now says about the other player into a game: their
 * seat the first time someone sits down, and their name. Our own seat and
 * role never change. Returns whether anything changed, and whether this was
 * someone taking the seat.
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
 * a game only when we play at that table, and from the other player only from
 * their seat (never ours, never a third seat). Ids inside the payload are
 * ignored here (the judge also checks the game id the seals are bound to).
 */
export function routeTableMessage(msg: GroupMessage, games: ReadonlyMap<string, GameEntry>): TableRoute {
  const entry = games.get(msg.id);
  if (!entry?.table) return { kind: "drop", reason: "unknown-game" };
  if (msg.from === entry.table.me) return { kind: "drop", reason: "not-opponent" };
  if (entry.table.them === null) return { kind: "drop", reason: "no-opponent-yet" };
  if (msg.from !== entry.table.them) return { kind: "drop", reason: "not-opponent" };
  return { kind: "game", entry };
}

/**
 * Whether our message hands the other seat the turn (`turn: theirSeat`): as
 * for a 1:1 game (`passesTurn`), and also our sealed fleet while theirs hasn't
 * come — they have to place theirs, and only "Your turn" tells them.
 */
export function tablePassesTurn(game: Game): boolean {
  return passesTurn(game) || (canSend(game) && phase(game) === "wait-seal");
}

/**
 * Whether locking our fleet in sends our seal at once. The player who fires
 * first and already holds the other seal sends it with their first shot; the
 * opener (second to fire) always sends it, so the other side can fire.
 * For a 1:1 game this is the invitee's old rule: send only without the
 * challenger's seal.
 */
export function sealGoesOutOnLockIn(game: Game): boolean {
  return game.role === "challenger" || !game.theirLeaves;
}

/** What Battleships does with a table event (other than a message). */
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
const unfinished = (entry: GameEntry): boolean => entry.game.outcome === null;

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
