/**
 * Open games in a space ("tables", Social Home v_77, SDK 1.9) — pure helpers
 * (no DOM, no SDK calls), unit-tested. The same shape as Chess's and Go's
 * table.ts.
 *
 * A member opens Backgammon as an open game in a space; when someone else
 * takes the seat, Social Home starts the table by itself (a table of two).
 * The game then runs over the table instead of a 1:1 session: our message
 * goes out with `sh.group.send(table, message, {turn: theirSeat})` and theirs
 * comes in as a group `message` event. Everything else is the same as for a
 * game from an invite: the same messages (`bg` v1, the whole game each time),
 * the same fair dice chains bound to the game's id (here: the table's id),
 * the same opening roll, the same judge (`judgeInbound`).
 *
 * **Seats → roles and colours.** Seats, not people: the seat that opened the
 * table is seat 1 (Social Home seats the opener there, and a waiting table
 * whose opener leaves is closed).
 *
 *   - seat 1 (the opener)           → role `invitee`, plays White;
 *   - any other seat (who sat down) → role `inviter`, plays Black.
 *
 * The 1:1 dice handshake starts with the inviter's tip (its commitment to
 * its dice chain); the invitee's app answers with its own tip and link 1.
 * Whoever takes the seat is in the app right then, so they are the inviter:
 * their app commits at once. The opener's app may be closed and nothing else
 * tells the opener that someone sat down, so that first message hands the
 * opener the turn (`turn: 1`, `opensTable`) — their app answers by itself as
 * soon as it opens. From the answer on, the player who sat down knows the
 * opening roll first: they play it when they won it, or their app shows its
 * link 1 ("open") so the opener can. Colours don't decide who starts in
 * Backgammon (the opening roll does), so the opener simply plays White.
 *
 * Both sides work the mapping out from their own seat; nothing about it
 * travels. A message acting as the other role is refused by the same judge:
 * the inviter (who sat down) never takes a commitment-only first message,
 * and the invitee (the opener) works out who invited from its own role.
 *
 * **The setup is fixed** — the New-game defaults, never anyone's choice and
 * never the lobby prefs: doubling cube on, no clock (`TABLE_SETUP`). The
 * player who sat down builds the game with it before any message. The
 * opener learns it from the first message, exactly like a 1:1 invitee, and
 * `judgeGame` refuses that first message (`refuse: "setup"`) unless it is
 * exactly the fixed setup with the opener playing White. From then on our
 * copy holds the fixed setup, and the judge refuses any message whose cube,
 * clock or colours differ — a tampered Backgammon can't drop the cube, add a
 * clock or swap colours. A saved table game whose setup, colour or role
 * doesn't follow from its seat is dropped on load (`parseSavedGame`).
 *
 * **Rolling without being asked** is this person's own choice for every game
 * with the cube (the "Roll without asking" switch), not part of the setup:
 * it travels in the log as `auto-*` entries, which the judge already checks,
 * so it applies at a table exactly as in a 1:1 game.
 *
 * **"Your turn".** `turn: theirSeat` whenever the 1:1 game would send
 * `turn: true` (`passesTurn`), and also on the first message of the player
 * who sat down (`opensTable`): at a 1:1 game the invite itself sits in the
 * other person's "Needs you", at a table nothing does.
 *
 * **Never trust the other side.** A table message is taken only for a table
 * this person has a game at (the table Social Home delivered it for, never an
 * id inside the payload), only from the other player's seat, and then judged
 * exactly like a 1:1 message. When both resign at once the inviter's (the
 * player who sat down) resignation counts on both sides, as in a 1:1 game.
 */

import type { GroupEvent, GroupMessage, GroupPlayer, GroupSession } from "@socialhome/app-sdk";
import type { Setup } from "./game.js";
import { passesTurn } from "./game.js";
import type { Color } from "./rules.js";
import { toB64url } from "./dice.js";
import { judgeInbound } from "./inbound.js";
import type { InboundVerdict } from "./inbound.js";
import { isOver, localOf, parseEntry, stateOf } from "./lifecycle.js";
import type { GameEntry, Role } from "./lifecycle.js";

/** The seat Social Home gives the person who opened a table. */
export const OPENER_SEAT = 1;

/**
 * The setup at an open game: the New-game defaults (doubling cube, no clock).
 * `inviter` is the colour of the player who took the seat.
 */
export const TABLE_SETUP: Readonly<Setup> = Object.freeze({ inviter: "b", cube: true, days: 0 });

/** Where a game played at a table sits. */
export interface TableInfo {
  /** Our seat. */
  me: number;
  /** The other player's seat; `null` while nobody has taken it. */
  them: number | null;
  /** The space the table was opened in. */
  spaceId?: string;
}

/** The colour a seat plays: the opener White, whoever takes the seat Black. */
export function tableColor(mySeat: number): Color {
  return mySeat === OPENER_SEAT ? "w" : TABLE_SETUP.inviter;
}

/** The 1:1 role a seat takes: whoever takes the seat commits first (inviter). */
export function tableRole(mySeat: number): Role {
  return mySeat === OPENER_SEAT ? "invitee" : "inviter";
}

/** The other player at a two-player table (seated first, else the one who left). */
export function otherPlayer(session: GroupSession): GroupPlayer | undefined {
  const others = session.players.filter((p) => p.seat !== session.me);
  return others.find((p) => p.state === "seated") ?? others[0];
}

/** Whether the person sits at this table and it can hold a game of Backgammon. */
export function isPlayableTable(session: GroupSession): boolean {
  return session.me !== null && session.myState === "seated" && session.state !== "ended" && session.max === 2;
}

/**
 * A new game for a table the person sits at, or `null` when it can't hold one
 * (not seated, ended, not two players). The player who sat down gets the
 * fixed setup and our secret dice seed (`seed`, never sent) at once; the
 * opener's game, like a 1:1 invitee's, learns both with the first message.
 * Before someone takes the seat the opener's game waits with an empty
 * opponent.
 */
export function entryForTable(session: GroupSession, seed: Uint8Array, now = 0): GameEntry | null {
  if (!isPlayableTable(session)) return null;
  const me = session.me!;
  const other = otherPlayer(session);
  const role = tableRole(me);
  const inviter = role === "inviter";
  return {
    sessionId: session.id,
    opponentInstanceId: "",
    opponentRef: "",
    opponentIsLocal: other?.isLocal ?? false,
    opponentName: other?.name ?? "",
    role,
    setup: inviter ? { ...TABLE_SETUP } : null,
    myColor: inviter ? tableColor(me) : null,
    seed: inviter ? toB64url(seed) : null,
    theirTip: null,
    theirShown: null,
    log: [],
    heard: false,
    updatedAt: now,
    ...(inviter ? { clockFrom: { n: 0, at: now } } : {}),
    table: {
      me,
      them: other?.seat ?? null,
      ...(session.spaceId ? { spaceId: session.spaceId } : {}),
    },
  };
}

function isTableSetup(setup: Setup): boolean {
  return setup.inviter === TABLE_SETUP.inviter && setup.cube === TABLE_SETUP.cube && setup.days === TABLE_SETUP.days;
}

/**
 * A table game as it must be: role from our seat, and the fixed setup with
 * our colour from our seat — or, for the opener only, nothing yet (no
 * setup, seed, tip or step before the first message).
 */
export function hasTableSetup(entry: GameEntry): boolean {
  const table = entry.table;
  if (!table || entry.role !== tableRole(table.me)) return false;
  if (entry.setup === null) {
    return entry.role === "invitee" && entry.myColor === null && entry.seed === null && entry.theirTip === null && entry.log.length === 0;
  }
  return isTableSetup(entry.setup) && entry.myColor === tableColor(table.me);
}

/**
 * The judge for any game: exactly `judgeInbound`; at a table the opener also
 * refuses a first message whose setup isn't the fixed one, or that gives it
 * another colour than its seat's.
 */
export function judgeGame(entry: GameEntry, payload: unknown): InboundVerdict {
  const v = judgeInbound(localOf(entry), payload);
  if (!entry.table || v.kind !== "invite") return v;
  if (!isTableSetup(v.setup) || v.myColor !== tableColor(entry.table.me)) return { kind: "refuse", reason: "setup" };
  return v;
}

/**
 * The first message of the player who sat down (their dice commitment):
 * the opener's app has to answer it, and only "Your turn" tells them.
 */
export function opensTable(entry: GameEntry): boolean {
  return !!entry.table && entry.role === "inviter" && entry.theirTip === null && entry.log.length === 0 && !!entry.seed;
}

/**
 * Whether our message hands the other player the turn: as for a 1:1 game
 * (`passesTurn`), and at a table also our opening commitment.
 */
export function handsTurn(entry: GameEntry): boolean {
  const st = stateOf(entry);
  if (st && entry.myColor && passesTurn(st, entry.myColor)) return true;
  return opensTable(entry);
}

/**
 * Take what the table now says about the other player into a game: their
 * seat the first time someone sits down, and their name. Our own seat, role
 * and colour never change. Returns whether anything changed, and whether
 * this was someone taking the seat.
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
 * a game only when we play at that table, and a step only from the other
 * player's seat (never ours, never a third seat). Ids inside the payload are
 * ignored (the dice are bound to the table's id by our own copy).
 */
export function routeTableMessage(msg: GroupMessage, games: ReadonlyMap<string, GameEntry>): TableRoute {
  const entry = games.get(msg.id);
  if (!entry?.table) return { kind: "drop", reason: "unknown-game" };
  if (msg.from === entry.table.me) return { kind: "drop", reason: "not-opponent" };
  if (entry.table.them === null) return { kind: "drop", reason: "no-opponent-yet" };
  if (msg.from !== entry.table.them) return { kind: "drop", reason: "not-opponent" };
  return { kind: "game", entry };
}

/** What Backgammon does with a table event (other than a message). */
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
      return isOver(entry) ? { kind: "ignore" } : { kind: "gone", entry, reason: "ended" };
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
 * one — a broken seat, another cube or clock, a colour or role that doesn't
 * follow from its seat — is dropped, never kept as a 1:1 game.
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
