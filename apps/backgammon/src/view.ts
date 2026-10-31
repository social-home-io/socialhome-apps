/**
 * Words and labels for what the board shows — pure (no DOM), tested.
 *
 * Every point is named in the viewer's own numbering (1 … 24, their home
 * board 1 … 6), the numbers the board shows; the other player's moves are
 * said in the same numbers, so a move can be found on the board as heard.
 */

import { BAR, OFF, other, pipCount } from "./rules.js";
import type { Board, Color, Step } from "./rules.js";
import { isResign, isTimeout, isTurn } from "./game.js";
import type { Entry, GameState, LastTurn, Setup } from "./game.js";
import { t } from "./i18n.js";
import { canClaim, hasPendingClaim, isAwaitingOpponent, isMyTurn, personName, stateOf } from "./lifecycle.js";
import type { GameEntry } from "./lifecycle.js";
import { splitLeft } from "./clock.js";
import { THEIR_BAR, THEIR_OFF } from "./board-nav.js";
import { turnsPlayed } from "./game.js";
import { TABLE_SETUP, isWaitingForPlayer, tableColor } from "./table.js";

/** Who the game is with — "Open game" while nobody has taken the seat at our table. */
export function opponentLabel(entry: GameEntry): string {
  return entry.opponentName || t("table.openGame");
}

export function colorName(c: Color): string {
  return t(c === "w" ? "color.w" : "color.b");
}

/** A place in the viewer's numbering: "8", "the bar", "off". */
export function placeName(p: number): string {
  if (p === BAR) return t("pt.bar");
  if (p === OFF) return t("pt.off");
  return String(p);
}

/** A place of *mover*'s in *viewer*'s numbering. */
export function seen(p: number, mover: Color, viewer: Color): number {
  if (mover === viewer || p === BAR || p === OFF) return p;
  return 25 - p;
}

/** "6 and 4", "double 3s". */
export function rollText(roll: readonly number[]): string {
  return roll[0] === roll[1] ? t("roll.double", { d: roll[0] }) : t("roll.two", { a: Math.max(roll[0], roll[1]), b: Math.min(roll[0], roll[1]) });
}

/** "13 to 8" / "the bar to 22" / "5 off". */
export function stepText(s: Pick<Step, "from" | "to">, mover: Color, viewer: Color): string {
  const from = placeName(seen(s.from, mover, viewer));
  if (s.to === OFF) return t("step.off", { from });
  return t("step.to", { from, to: placeName(seen(s.to, mover, viewer)) });
}

/** A whole turn's steps: "13 to 8, 8 to 5" (or "no move"). */
export function stepsText(steps: readonly Step[], mover: Color, viewer: Color): string {
  if (steps.length === 0) return t("step.none");
  return steps.map((s) => stepText(s, mover, viewer)).join(", ");
}

export type Tone = "turn" | "wait" | "good" | "bad" | "info";

/** The lobby chip of a game. */
export function chipFor(entry: GameEntry, now = Date.now()): { text: string; tone: Tone } {
  const st = stateOf(entry);
  const name = personName(entry);
  if (isWaitingForPlayer(entry)) return { text: t("chip.openGame"), tone: "wait" };
  if (!st) {
    if (isAwaitingOpponent(entry)) return { text: t("chip.inviteSent"), tone: "wait" };
    return { text: t("chip.waitSetup", { name }), tone: "wait" };
  }
  if (st.result) {
    if (st.result.winner === null) return { text: t("chip.draw"), tone: "info" };
    return st.result.winner === entry.myColor ? { text: t("chip.won"), tone: "good" } : { text: t("chip.lost"), tone: "bad" };
  }
  if (isMyTurn(entry)) return { text: st.phase === "cube" ? t("chip.doubled") : t("chip.yourTurn"), tone: "turn" };
  if (hasPendingClaim(entry)) return { text: t("chip.claimed"), tone: "wait" };
  if (canClaim(entry, now)) return { text: t("chip.timeUp", { name }), tone: "turn" };
  return { text: t("chip.theirTurn", { name }), tone: "wait" };
}

/** "1 day per move" / "3 days per move". */
export function clockName(days: number): string {
  return days === 1 ? t("clock.day1") : t("clock.days", { n: days });
}

/** "Doubling cube · 2 days per move", or "No doubling cube". */
export function rulesLine(setup: Setup): string {
  const parts = [setup.cube ? t("meta.cube") : t("meta.noCube")];
  if (setup.days > 0) parts.push(clockName(setup.days));
  return parts.join(" · ");
}

/** "White · turn 12 · cube 2" for a lobby row. */
export function metaFor(entry: GameEntry): string {
  // An open game in a space: the fixed setup, our colour from our seat.
  if (entry.table && !entry.setup) return [colorName(tableColor(entry.table.me)), rulesLine(TABLE_SETUP)].join(" · ");
  if (!entry.setup || !entry.myColor) return t("meta.unknown", { name: personName(entry) });
  const color = colorName(entry.myColor);
  const parts = [color];
  const n = turnsPlayed(entry.log);
  parts.push(n === 0 ? t("meta.new") : t("meta.turn", { n }));
  const st = stateOf(entry);
  if (st && st.cube.value > 1) parts.push(t("meta.cubeAt", { n: st.cube.value }));
  if (entry.setup.days > 0) parts.push(clockName(entry.setup.days));
  return parts.join(" · ");
}

/** "2 days 5 h left", "1 day left", "3 h 20 min left", "12 min left", "Time ran out". */
export function timeLeftText(ms: number): string {
  if (ms <= 0) return t("clock.out");
  const { d, h, m } = splitLeft(ms);
  if (d >= 2) return h === 0 ? t("clock.leftDaysOnly", { d }) : t("clock.leftDays", { d, h });
  if (d === 1) return h === 0 ? t("clock.leftDay1Only") : t("clock.leftDay1", { h });
  if (h >= 1) return t("clock.leftHours", { h, m });
  return t("clock.leftMinutes", { m: Math.max(1, m) });
}

/** "You 5, Ben 3: you start." */
export function openingText(st: GameState, me: Color, name: string): string | null {
  const o = st.opening;
  if (!o) return null;
  const mine = o[me];
  const theirs = o[other(me)];
  const ties = o.ties.length > 0 ? `${t("opening.ties", { n: o.ties.length })} ` : "";
  return ties + (o.starter === me ? t("opening.youStart", { mine, theirs, name }) : t("opening.theyStart", { mine, theirs, name }));
}

/** What the other player's latest turn was: "Ben rolled 6 and 4: 1 to 7, 12 to 16." */
export function lastTurnText(last: LastTurn, me: Color, name: string): string {
  const roll = rollText(last.roll);
  if (last.by === me) {
    return last.steps.length === 0 ? t("last.youNone", { roll }) : t("last.you", { roll, steps: stepsText(last.steps, me, me) });
  }
  return last.steps.length === 0 ? t("last.theyNone", { name, roll }) : t("last.they", { name, roll, steps: stepsText(last.steps, last.by, me) });
}

/** The status line above the board: a title and an optional detail. */
export function statusFor(entry: GameEntry): { title: string; detail: string | null } {
  const st = stateOf(entry);
  const name = personName(entry);
  if (isWaitingForPlayer(entry)) return { title: t("status.waitingForPlayer"), detail: t("table.waiting") };
  if (!st) {
    if (isAwaitingOpponent(entry)) return { title: t("status.inviteSent", { name }), detail: t("status.inviteSentBody", { name }) };
    // At a table, our dice commitment went out: the opener's app answers it.
    if (entry.table && entry.role === "inviter") return { title: t("status.waitSetup", { name }), detail: t("table.waitAnswer", { name }) };
    return { title: t("status.waitSetup", { name }), detail: t("status.waitSetupBody", { name }) };
  }
  const me = entry.myColor!;
  const mine = isMyTurn(entry);
  if (st.phase === "start") {
    if (st.mover === me) return { title: t("status.yourTurn"), detail: openingText(st, me, name) };
    if (mine) return { title: t("status.opening"), detail: null };
    return { title: t("status.theirOpening", { name }), detail: t("status.theirOpeningBody", { name }) };
  }
  if (st.phase === "cube") {
    const v = st.cube.value * 2;
    if (mine) return { title: t("cube.offered", { name, n: v }), detail: t("cube.offeredBody", { name }) };
    return { title: t("cube.youOffered", { n: v }), detail: t("cube.waiting", { name }) };
  }
  if (st.phase === "dice") {
    if (mine) return { title: t("status.showing", { name }), detail: null };
    return { title: t("status.rolling"), detail: t("status.rollingBody", { name }) };
  }
  let detail: string | null = null;
  if (st.turn === 1 && st.opening) detail = openingText(st, me, name);
  else if (st.last) {
    detail = lastTurnText(st.last, me, name);
    // The other player opened: say the opening roll with it (this side learned it just now).
    if (st.last.turn === 1 && st.last.by !== me && st.opening) detail = `${openingText(st, me, name)} ${detail}`;
  }
  if (mine) return { title: st.roll ? t("status.yourRoll", { roll: rollText(st.roll) }) : t("status.yourTurn"), detail };
  return { title: t("status.theirTurn", { name }), detail };
}

/** Why our roll couldn't be played, in plain words. */
export function passText(reason: "bar" | "blocked", roll: readonly number[]): string {
  return reason === "bar" ? t("pass.bar", { roll: rollText(roll) }) : t("pass.blocked", { roll: rollText(roll) });
}

/** The result in one line from *me*'s side: "You won a gammon: 4 points." */
export function resultLine(st: GameState, me: Color, name: string): string | null {
  const r = st.result;
  if (!r) return null;
  if (r.winner === null) return t("end.limit");
  const won = r.winner === me;
  const n = r.points;
  const pts = n === 1 ? t("end.point1") : t("end.points", { n });
  switch (r.by) {
    case "single":
      return won ? t("end.youWon", { pts }) : t("end.theyWon", { name, pts });
    case "gammon":
      return won ? t("end.youGammon", { pts }) : t("end.theyGammon", { name, pts });
    case "backgammon":
      return won ? t("end.youBackgammon", { pts }) : t("end.theyBackgammon", { name, pts });
    case "drop":
      return won ? t("end.theyDropped", { name, pts }) : t("end.youDropped", { name, pts });
    case "resign":
      return won ? t("end.theyResigned", { name, pts }) : t("end.youResigned", { name, pts });
    case "time":
      return won ? t("end.theyTimedOut", { name, pts }) : t("end.youTimedOut", { name, pts });
  }
}

/** How the points were made: "cube 2 × gammon 2". Empty for a plain single game. */
export function pointsBreakdown(st: GameState): string {
  const r = st.result;
  if (!r || r.winner === null) return "";
  const mult = r.kind === "gammon" ? 2 : r.kind === "backgammon" ? 3 : 1;
  // Only when both count: "2 points" after a double, or "a gammon: 2 points", says it already.
  if (r.cube === 1 || mult === 1) return "";
  return t("end.breakdown", { cube: r.cube, mult });
}

/** One place on the board, as the viewer's screen reader hears it. */
export interface CellInfo {
  /** 1 … 24 a point, 25 our bar, 0 our borne-off tray, 26 their bar, 27 their tray. */
  id: number;
  mine: number;
  theirs: number;
  selected: boolean;
  target: boolean;
  source: boolean;
  lastFrom: boolean;
  lastTo: boolean;
}


/** The checkers on a place, from the viewer's side. */
export function cellCounts(board: Board, me: Color, id: number): { mine: number; theirs: number } {
  const them = other(me);
  if (id === BAR) return { mine: board[me][BAR], theirs: 0 };
  if (id === OFF) return { mine: board[me][OFF], theirs: 0 };
  if (id === THEIR_BAR) return { mine: 0, theirs: board[them][BAR] };
  if (id === THEIR_OFF) return { mine: 0, theirs: board[them][OFF] };
  return { mine: board[me][id], theirs: board[them][25 - id] };
}

/** "Point 13: 5 of yours (White)", "Your bar: empty", "Point 6: 2 of Ben's (Black), can move here". */
export function cellLabel(c: CellInfo, me: Color, name: string): string {
  const parts: string[] = [];
  if (c.id === BAR) parts.push(t("cell.bar"));
  else if (c.id === OFF) parts.push(t("cell.off"));
  else if (c.id === THEIR_BAR) parts.push(t("cell.theirBar", { name }));
  else if (c.id === THEIR_OFF) parts.push(t("cell.theirOff", { name }));
  else parts.push(t("cell.point", { n: c.id }));
  if (c.mine > 0) parts.push(c.mine === 1 ? t("cell.mine1", { color: colorName(me) }) : t("cell.mine", { n: c.mine, color: colorName(me) }));
  else if (c.theirs > 0) {
    const color = colorName(other(me));
    parts.push(c.theirs === 1 ? t("cell.theirs1", { name, color }) : t("cell.theirs", { name, n: c.theirs, color }));
  } else parts.push(t("cell.empty"));
  if (c.selected) parts.push(t("cell.selected"));
  else if (c.target) parts.push(t("cell.target"));
  else if (c.source) parts.push(t("cell.source"));
  if (c.lastTo) parts.push(t("cell.lastTo", { name }));
  else if (c.lastFrom) parts.push(t("cell.lastFrom", { name }));
  return parts.join(", ");
}

/** The pip counts line: "Pips: you 142, Ben 155". */
export function pipsText(board: Board, me: Color, name: string): string {
  return t("pips", { mine: pipCount(board[me]), theirs: pipCount(board[other(me)]), name });
}

/** What to say about the opponent's new entries (polite live region). */
export function announceInbound(entry: GameEntry, added: readonly Entry[], after: GameState): string[] {
  const name = personName(entry);
  const me = entry.myColor!;
  const out: string[] = [];
  for (const e of added) {
    if (isTurn(e) && after.last && after.last.by !== me) {
      if (after.last.turn === 1) {
        const o = openingText(after, me, name);
        if (o) out.push(o);
      }
      out.push(lastTurnText(after.last, me, name));
      const hits = after.last.steps.filter((s) => s.hit).length;
      if (hits > 0) out.push(hits === 1 ? t("say.hitYou1") : t("say.hitYou", { n: hits }));
    } else if (e === "double") {
      out.push(t("cube.offered", { name, n: after.cube.value * 2 }), t("cube.offeredBody", { name }));
    } else if (e === "take") {
      out.push(t("say.took", { name, n: after.cube.value }));
    } else if (e === "drop") {
      // The result line follows.
    } else if (e === "open") {
      const o = openingText(after, me, name);
      if (o) out.push(o);
    } else if (isResign(e)) {
      out.push(t("say.resigned", { name }));
    } else if (isTimeout(e)) {
      out.push(t("say.theyTimedOut", { name }));
    }
  }
  if (after.phase === "over") {
    const line = resultLine(after, me, name);
    if (line) out.push(line);
  } else if (after.toMove === me && after.phase === "play" && after.roll) {
    out.push(t("say.yourRoll", { roll: rollText(after.roll) }));
  } else if (after.toMove === me && after.phase === "ask") {
    out.push(t("say.yourAsk"));
  }
  return out;
}

/** What to say after one of our own steps on the board (before Done). */
export function announceStep(s: Step, me: Color, left: readonly number[], complete: boolean): string {
  const parts = [stepText(s, me, me)];
  if (s.hit) parts.push(t("say.youHit"));
  if (s.to === OFF) parts.push(t("say.borneOff"));
  if (complete) parts.push(t("say.turnDone"));
  else if (left.length > 0) parts.push(t("say.left", { dice: left.join(", ") }));
  return parts.join(". ");
}
