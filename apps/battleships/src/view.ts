/**
 * What the screens say and show — pure functions of a game, unit-tested.
 * main.ts only turns these into DOM.
 */

import { CELLS, SHIPS, cellName, placementCells, shipMap } from "./rules.js";
import type { Fleet } from "./rules.js";
import { firedBy, hitsByMe, hitsOnMe, isMine, phase, shotCount } from "./game.js";
import type { Game, Outcome, Shot } from "./game.js";
import type { GameEvent } from "./protocol.js";
import { personName } from "./lifecycle.js";
import type { GameEntry } from "./lifecycle.js";
import { isWaitingForPlayer } from "./table.js";
import { ago, t } from "./i18n.js";
import type { MessageKey } from "./i18n.js";

export function shipName(i: number): string {
  return t(`ship.${SHIPS[i].id}` as MessageKey);
}

export function shipTitle(i: number): string {
  return t(`shipTitle.${SHIPS[i].id}` as MessageKey);
}

// ---------------------------------------------------------------------------
// Boards
// ---------------------------------------------------------------------------

/** A square of the other side's waters as we know it. */
export type TargetCell =
  | { kind: "none" }
  /** We fired here and wait for the answer. */
  | { kind: "pending" }
  | { kind: "miss" }
  | { kind: "hit" }
  | { kind: "sunk"; ship: number };

export function targetBoard(game: Game): TargetCell[] {
  const out: TargetCell[] = Array.from({ length: CELLS }, () => ({ kind: "none" }) as TargetCell);
  game.shots.forEach((s, k) => {
    if (!isMine(game, k)) return;
    if (s.ans === undefined) out[s.cell] = { kind: "pending" };
    else if (s.ans === "m") out[s.cell] = { kind: "miss" };
    else out[s.cell] = { kind: "hit" };
  });
  game.shots.forEach((s, k) => {
    if (!isMine(game, k) || s.ans !== "s" || !s.sunk) return;
    for (const c of placementCells(s.sunk) ?? []) out[c] = { kind: "sunk", ship: s.sunk[0] };
  });
  return out;
}

/** A square of our own fleet: the ship on it (-1 = water) and what their shots did. */
export interface OwnCell {
  ship: number;
  shot: "none" | "miss" | "hit" | "sunk";
}

export function ownBoard(game: Game): OwnCell[] {
  return boardFor(game.fleet, firedBy(game, false));
}

/** The other fleet once revealed, with our shots on it. */
export function revealedBoard(game: Game): OwnCell[] | null {
  return game.theirReveal ? boardFor(game.theirReveal.fleet, firedBy(game, true)) : null;
}

function boardFor(fleet: Fleet, shotAt: Set<number>): OwnCell[] {
  const map = shipMap(fleet);
  const sunk = new Set<number>();
  for (const p of fleet) {
    if ((placementCells(p) ?? []).every((c) => shotAt.has(c))) sunk.add(p[0]);
  }
  return Array.from({ length: CELLS }, (_, c) => {
    const ship = map[c];
    if (!shotAt.has(c)) return { ship, shot: "none" };
    if (ship < 0) return { ship, shot: "miss" };
    return { ship, shot: sunk.has(ship) ? "sunk" : "hit" };
  });
}

/** The square of their answer that voided the game, on their board. */
export function lieAt(game: Game): number | null {
  const o = game.outcome;
  return o?.kind === "void" && (o.reason === "answer" || o.reason === "sunk") && o.at !== undefined ? o.at : null;
}

/** Their latest shot at us (ringed on our board). */
export function lastShotAtMe(game: Game): number | null {
  for (let k = game.shots.length - 1; k >= 0; k--) if (!isMine(game, k)) return game.shots[k].cell;
  return null;
}

/** Ships of theirs we sank. */
export function theirSunk(game: Game): Set<number> {
  const out = new Set<number>();
  game.shots.forEach((s, k) => {
    if (isMine(game, k) && s.ans === "s" && s.sunk) out.add(s.sunk[0]);
  });
  return out;
}

/** Per own ship: squares hit so far. */
export function ownHits(game: Game): number[] {
  const board = ownBoard(game);
  const hits = SHIPS.map(() => 0);
  for (const c of board) if (c.ship >= 0 && c.shot !== "none") hits[c.ship]++;
  return hits;
}

export function targetCellLabel(game: Game, cell: number, name: string, aimed: boolean): string {
  const at = cellName(cell);
  const revealed = revealedBoard(game);
  const v = targetBoard(game)[cell];
  let label: string;
  switch (v.kind) {
    case "sunk":
      label = t("cell.sunk", { cell: at, ship: shipName(v.ship) });
      break;
    case "hit":
      label = t("cell.hit", { cell: at });
      break;
    case "miss":
      label = t("cell.miss", { cell: at });
      break;
    case "pending":
      label = t("cell.pending", { cell: at });
      break;
    default:
      label =
        revealed && revealed[cell].ship >= 0
          ? t("cell.theirShip", { cell: at, name, ship: shipName(revealed[cell].ship) })
          : t("cell.notFired", { cell: at });
  }
  if (lieAt(game) === cell) label = t("cell.lie", { label });
  return aimed ? t("cell.aimed", { label }) : label;
}

export function ownCellLabel(game: Game, cell: number, name: string): string {
  const at = cellName(cell);
  const c = ownBoard(game)[cell];
  let label: string;
  if (c.ship < 0) label = c.shot === "miss" ? t("cell.waterMiss", { cell: at, name }) : t("cell.water", { cell: at });
  else {
    const ship = shipName(c.ship);
    const key = c.shot === "sunk" ? "cell.ownShipSunk" : c.shot === "hit" ? "cell.ownShipHit" : "cell.ownShip";
    label = t(key, { cell: at, ship });
  }
  return lastShotAtMe(game) === cell ? t("cell.lastShot", { label, name }) : label;
}

// ---------------------------------------------------------------------------
// Words
// ---------------------------------------------------------------------------

/** One shot as a sentence ("Ben fired at C2: hit on your carrier."). */
export function shotSentence(game: Game, k: number, name: string): string {
  const s: Shot = game.shots[k];
  const cell = cellName(s.cell);
  if (isMine(game, k)) {
    if (s.ans === undefined) return t("ev.youWaiting", { cell, name });
    if (s.ans === "m") return t("ev.youMiss", { cell });
    if (s.ans === "s" && s.sunk) return t("ev.youSunk", { cell, name, ship: shipName(s.sunk[0]) });
    return t("ev.youHit", { cell });
  }
  const ship = shipMap(game.fleet)[s.cell];
  if (s.ans === "m" || ship < 0) return t("ev.theyMiss", { cell, name });
  if (s.ans === "s") return t("ev.theySunk", { cell, name, ship: shipName(ship) });
  return t("ev.theyHit", { cell, name, ship: shipName(ship) });
}

/** The latest thing that happened, or "". */
export function lastEvent(entry: GameEntry): string {
  const g = entry.game;
  const k = g.shots.length - 1;
  if (k < 0) return "";
  // An unanswered shot of theirs is answered at once; show the last answered one.
  if (g.shots[k].ans === undefined && !isMine(g, k)) return k > 0 ? shotSentence(g, k - 1, personName(entry)) : "";
  return shotSentence(g, k, personName(entry));
}

export interface Status {
  title: string;
  detail: string;
}

export function statusFor(entry: GameEntry): Status {
  const g = entry.game;
  const name = personName(entry);
  if (isWaitingForPlayer(entry)) {
    return { title: t("status.waitingForPlayer"), detail: t(g.root ? "progress.openLocked" : "progress.openPlace") };
  }
  switch (phase(g)) {
    case "place":
      return { title: t("place.title"), detail: t("place.seal", { name }) };
    case "wait-seal":
      return g.role === "challenger"
        ? {
            title: entry.table ? t("status.waitSeal", { name }) : t("status.inviteSent"),
            detail: t("status.inviteSentDetail", { name }),
          }
        : { title: t("status.waitSeal", { name }), detail: t("status.waitSealDetail", { name }) };
    case "my-turn": {
      const last = lastEvent(entry);
      if (!last) return { title: t("status.yourTurn"), detail: t("status.firstShot", { name }) };
      return { title: t("status.yourTurn"), detail: `${last} ${t("status.pickSquare", { name })}` };
    }
    case "their-turn":
      return { title: t("status.theirTurn", { name }), detail: lastEvent(entry) };
    case "over":
      return { title: t("status.over"), detail: lastEvent(entry) };
  }
}

export type ChipTone = "turn" | "ok" | "bad" | "plain";

export function chipFor(entry: GameEntry, now = Date.now()): { text: string; tone: ChipTone } {
  const g = entry.game;
  const name = personName(entry);
  const o = g.outcome;
  if (o) {
    if (o.kind === "void") return { text: t("chip.void"), tone: "bad" };
    if (o.kind === "won") return g.check === "ok" ? { text: t("chip.wonChecked"), tone: "ok" } : { text: t("chip.wonPending"), tone: "plain" };
    return g.check === "ok" ? { text: t("chip.lost"), tone: "plain" } : { text: t("chip.lostUnshown", { name }), tone: "plain" };
  }
  if (isWaitingForPlayer(entry)) return { text: t("chip.openGame"), tone: "plain" };
  switch (phase(g)) {
    case "place":
      return { text: t("chip.place"), tone: "turn" };
    case "wait-seal":
      return g.role === "challenger" && !entry.table ? { text: t("chip.inviteSent"), tone: "plain" } : { text: t("chip.waitSeal", { name }), tone: "plain" };
    case "my-turn":
      return { text: t("chip.yourTurn"), tone: "turn" };
    default:
      return now - g.updatedAt > 3600_000
        ? { text: t("chip.theirTurnSince", { name, ago: ago(g.updatedAt, now) }), tone: "plain" }
        : { text: t("chip.theirTurn", { name }), tone: "plain" };
  }
}

export function scoreLine(entry: GameEntry): string {
  return t("progress.score", { mine: hitsByMe(entry.game), theirs: hitsOnMe(entry.game), name: personName(entry) });
}

/** The lobby card's second line. */
export function progressFor(entry: GameEntry): string {
  const g = entry.game;
  const name = personName(entry);
  if (g.outcome?.kind === "void") return voidReason(g.outcome, name);
  if (g.outcome?.kind === "won" && g.check === "ok") return t("progress.wonChecked", { name });
  if (isWaitingForPlayer(entry)) return t(g.root ? "progress.openLocked" : "progress.openPlace");
  switch (phase(g)) {
    case "place":
      return t(entry.table ? "progress.placeTable" : "progress.place", { name });
    case "wait-seal":
      return t(g.role === "challenger" ? "progress.inviteSent" : "progress.waitSeal", { name });
    default: {
      const last = lastEvent(entry);
      return last ? `${scoreLine(entry)} · ${last}` : scoreLine(entry);
    }
  }
}

export function voidReason(o: Extract<Outcome, { kind: "void" }>, name: string): string {
  const cell = o.at !== undefined ? cellName(o.at) : "";
  return t(`void.${o.reason}` as MessageKey, { name, cell });
}

export interface Verdict {
  tone: "ok" | "bad" | "plain";
  title: string;
  lines: string[];
  checks: string[];
}

export function verdictFor(entry: GameEntry): Verdict | null {
  const g = entry.game;
  const o = g.outcome;
  const name = personName(entry);
  if (!o) return null;
  if (o.kind === "void") {
    return { tone: "bad", title: t("end.void"), lines: [voidReason(o, name), t("end.voidNote")], checks: [] };
  }
  const shots = shotCount(g);
  const title =
    o.kind === "won"
      ? o.how === "fleet"
        ? t("end.wonFleet", { name, n: shots.mine })
        : t("end.wonResign", { name })
      : o.how === "fleet"
        ? t("end.lostFleet", { name, n: shots.theirs })
        : t("end.lostResign");
  if (g.check === "ok") {
    return {
      tone: o.kind === "won" ? "ok" : "plain",
      title,
      lines: [t("end.checked", { name })],
      checks: [t("check.seal"), t("check.answers"), t("check.fleet")],
    };
  }
  return { tone: "plain", title, lines: [t(o.kind === "won" ? "end.checking" : "end.notShown", { name })], checks: [] };
}

/** What to announce for the events of one message. */
export function announce(events: readonly GameEvent[], entry: GameEntry): { polite: string[]; assertive: string[] } {
  const g = entry.game;
  const name = personName(entry);
  const polite: string[] = [];
  const assertive: string[] = [];
  for (const e of events) {
    if (e.type === "answered" || e.type === "fired") {
      const k = g.shots.findIndex((s, i) => s.cell === e.cell && isMine(g, i) === (e.type === "answered"));
      if (k >= 0) polite.push(shotSentence(g, k, name));
    } else if (e.type === "sealed" && phase(g) === "my-turn" && g.shots.length === 0) {
      polite.push(t("ann.sealed", { name }));
    } else if (e.type === "over") {
      const o = g.outcome;
      if (o?.kind === "void") assertive.push(t("ann.void", { reason: voidReason(o, name) }));
      else if (o?.kind === "won") polite.push(t("ann.won", { name }));
      else if (o?.kind === "lost") polite.push(t("ann.lost"));
    } else if (e.type === "checked") {
      polite.push(t("ann.checked", { name }));
    }
  }
  if (phase(g) === "my-turn" && events.some((e) => e.type === "fired")) polite.push(t("ann.yourTurn"));
  return { polite, assertive };
}

