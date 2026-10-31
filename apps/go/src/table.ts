/**
 * Open games in a space ("tables", Social Home v_77, SDK 1.9) — pure helpers
 * (no DOM, no SDK calls), unit-tested. The same shape as Chess's table.ts.
 *
 * A member opens Go as an open game in a space; when someone else takes the
 * seat, Social Home starts the table by itself (a table of two). The game
 * then runs over the table instead of a 1:1 session: the whole game goes out
 * with `sh.group.send(table, message, {turn: theirSeat})` and comes in as
 * group `message` events. Everything else — the log, the judge, counting,
 * resignations — is the same as for a game from an invite.
 *
 * **Who plays which colour.** Seats, not people: the seat that opened the
 * table is seat 1 (Social Home seats the opener there, and a waiting table
 * whose opener leaves is closed). The opener plays White; whoever takes the
 * seat plays Black and so moves first (in Go Black moves first). Both sides
 * work it out from their own seat; nothing about it travels.
 *
 * **The setup is fixed** — the New-game defaults, never anyone's choice:
 * 9 × 9, no handicap, no clock, the usual komi (inbound.ts `RULES`). Both
 * sides build the game with it before any message, so the person who just
 * joined can play at once. Every message still carries size, colours,
 * handicap and clock (inbound.ts); because our copy already knows them, the
 * judge refuses any message whose setup differs (`refuse: "setup"`) — a
 * tampered Go can't give itself a handicap stone, a clock or another board.
 *
 * **Roles.** The 1:1 protocol has an inviter and an invitee; at a table the
 * opener is the inviter and whoever takes the seat the invitee. Both are
 * known from the seats, so both sides agree, which is what the judge needs:
 * when both resign at the same moment, the inviter's (opener's) resignation
 * counts on both sides. Unlike a 1:1 invitee, the joiner's game has its size
 * and colour from the start (`size` is never `null`), so it never waits for
 * a first message and every message is judged against the fixed setup. An
 * open game has no invite to cancel and no session to close: the opener
 * closes the table instead, and "Invite sent" never shows for it.
 *
 * **The game's end ends the table.** The message that ends the game (the
 * second pass, a resignation, a time win) goes out with `final: true`
 * (SDK 1.10): Social Home ends the table as `finished` right after
 * delivering it — the space shows it under Finished — instead of keeping it
 * "being played" for days. Its close can reach the other player before the
 * message itself (or the message waits in a closed app's mailbox), so a table
 * that ended `finished` while our game is still on keeps the game and waits
 * for that message. Two endings that cross (both resign at once) both arrive:
 * Social Home still passes on the players' messages for a few minutes after
 * the end, and the judge settles them as in a 1:1 game.
 *
 * **Never trust the other side.** A table message is taken only for a table
 * this person has a game at (the table Social Home delivered it for, never an
 * id inside the payload), only from the other player's seat, and then judged
 * exactly like a 1:1 message (inbound.ts).
 */

import { ShError } from "@socialhome/app-sdk";
import type { GroupEvent, GroupMessage, GroupPlayer, GroupSendOptions, GroupSession } from "@socialhome/app-sdk";
import { NO_RULES } from "./game.js";
import type { Rules } from "./game.js";
import type { Color, Size } from "./rules.js";
import { isOver, parseEntry } from "./lifecycle.js";
import type { GameEntry, Role } from "./lifecycle.js";

/** The seat Social Home gives the person who opened a table. */
export const OPENER_SEAT = 1;

/** The board at an open game: the New-game default. */
export const TABLE_SIZE: Size = 9;

/** No handicap and no clock at an open game (komi is the protocol's). */
export const TABLE_RULES: Rules = NO_RULES;

/** Where a game played at a table sits. */
export interface TableInfo {
  /** Our seat. */
  me: number;
  /** The other player's seat; `null` while nobody has taken it. */
  them: number | null;
  /** The space the table was opened in. */
  spaceId?: string;
}

/** The colour a seat plays: whoever takes the seat plays Black and moves first. */
export function tableColor(mySeat: number): Color {
  return mySeat === OPENER_SEAT ? "w" : "b";
}

/** The 1:1 role a seat takes: the opener invited, the joiner was invited. */
export function tableRole(mySeat: number): Role {
  return mySeat === OPENER_SEAT ? "inviter" : "invitee";
}

/** The other player at a two-player table (seated first, else the one who left). */
export function otherPlayer(session: GroupSession): GroupPlayer | undefined {
  const others = session.players.filter((p) => p.seat !== session.me);
  return others.find((p) => p.state === "seated") ?? others[0];
}

/** Whether the person sits at this table and it can hold a game of Go. */
export function isPlayableTable(session: GroupSession): boolean {
  return session.me !== null && session.myState === "seated" && session.state !== "ended" && session.max === 2;
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
    role: tableRole(me),
    size: TABLE_SIZE,
    myColor: tableColor(me),
    handicap: TABLE_RULES.handicap,
    days: TABLE_RULES.days,
    log: [],
    heard: false,
    updatedAt: now,
    table: {
      me,
      them: other?.seat ?? null,
      ...(session.spaceId ? { spaceId: session.spaceId } : {}),
    },
  };
}

/** A table game as it must be: the fixed setup, and colour and role from our seat. */
export function hasTableSetup(entry: GameEntry): boolean {
  const table = entry.table;
  if (!table) return false;
  return (
    entry.size === TABLE_SIZE &&
    entry.handicap === TABLE_RULES.handicap &&
    entry.days === TABLE_RULES.days &&
    entry.myColor === tableColor(table.me) &&
    entry.role === tableRole(table.me)
  );
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

/**
 * How a game's message goes out at its table: handing the other player's
 * seat the turn when it does, and `final` on the message that ends the game.
 */
export function tableSendOptions(them: number, passTurn: boolean, over: boolean): GroupSendOptions {
  return { ...(passTurn ? { turn: them } : {}), ...(over ? { final: true } : {}) };
}

/**
 * A send refused because the table already ended — after the game ended on
 * our board, that is our own last message being sent again (it went out the
 * first time) or one that crossed the other player's: nothing to retry.
 */
export function isSentAfterFinish(err: unknown, over: boolean): boolean {
  return over && err instanceof ShError && err.code === "group_closed";
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

/** What Go does with a table event (other than a message). */
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

/** Decide what a table event means for the games we have. A finished game is kept. */
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
      if (event.seat === table.them && !isOver(entry)) return { kind: "gone", entry, reason: "left" };
      return { kind: "ignore" };
    case "ended":
      if (isOver(entry)) return { kind: "ignore" };
      // The game's last message ended it: the message is on its way (or held).
      if (session.endReason === "finished") return { kind: "ignore" };
      return { kind: "gone", entry, reason: "ended" };
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
  return entry.table !== undefined && entry.table.them === null && !isOver(entry);
}

/** Our own open game, nobody seated yet: only the opener (the host) may close it. */
export function canCloseTable(entry: GameEntry): boolean {
  return isWaitingForPlayer(entry) && entry.table!.me === OPENER_SEAT;
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

/**
 * A saved game (1:1 or table), checked. A table game that can't be read as
 * one — a broken seat, another board, a handicap, a clock, a colour or role
 * that doesn't follow from its seat — is dropped, never kept as a 1:1 game.
 */
export function parseSavedGame(v: unknown): GameEntry | null {
  const entry = parseEntry(v);
  if (!entry) return null;
  const raw = (v as Record<string, unknown>)["table"];
  if (raw === undefined) return entry;
  const table = parseTableInfo(raw);
  if (!table) return null;
  entry.table = table;
  return hasTableSetup(entry) ? entry : null;
}
