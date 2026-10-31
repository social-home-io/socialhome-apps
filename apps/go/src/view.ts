/**
 * Words and labels for what the board shows — pure (no DOM), tested.
 */

import { BLACK, WHITE, pointName } from "./rules.js";
import type { Color } from "./rules.js";
import { isMark, isResign } from "./game.js";
import type { Entry, GameState } from "./game.js";
import { num, t } from "./i18n.js";
import { isAwaitingOpponent, isMyTurn, personName, stateOf } from "./lifecycle.js";
import type { GameEntry } from "./lifecycle.js";
import { stonesPlayed } from "./game.js";

export function colorName(c: Color): string {
  return t(c === "b" ? "color.b" : "color.w");
}

export function sizeName(n: number): string {
  return t("size.n", { n });
}

export type Tone = "turn" | "wait" | "good" | "bad" | "info";

/** The lobby chip of a game. */
export function chipFor(entry: GameEntry): { text: string; tone: Tone } {
  const st = stateOf(entry);
  const name = personName(entry);
  if (!st) return { text: t("chip.waitSetup", { name }), tone: "wait" };
  if (st.result) {
    return st.result.winner === entry.myColor ? { text: t("chip.won"), tone: "good" } : { text: t("chip.lost"), tone: "bad" };
  }
  if (isMyTurn(entry)) return { text: st.phase === "counting" ? t("chip.counting") : t("chip.yourTurn"), tone: "turn" };
  if (isAwaitingOpponent(entry)) return { text: t("chip.inviteSent"), tone: "wait" };
  return { text: t("chip.theirTurn", { name }), tone: "wait" };
}

/** "Black · 9 × 9 · move 23" for a lobby row. */
export function metaFor(entry: GameEntry): string {
  if (entry.size === null || entry.myColor === null) return t("meta.unknown", { name: personName(entry) });
  const color = colorName(entry.myColor);
  const size = sizeName(entry.size);
  const n = stonesPlayed(entry.log);
  return n === 0 ? t("meta.new", { color, size }) : t("meta.line", { color, size, n });
}

/** The status line above the board: a title and an optional detail. */
export function statusFor(entry: GameEntry): { title: string; detail: string | null } {
  const st = stateOf(entry);
  const name = personName(entry);
  if (!st) return { title: t("status.waitSetup", { name }), detail: t("status.waitSetupBody", { name }) };
  const last = entry.log[entry.log.length - 1];
  const mine = isMyTurn(entry);
  if (st.phase === "counting") {
    if (!mine) return { title: t("count.title"), detail: t("count.waiting", { name }) };
    if (st.proposal) return { title: t("count.title"), detail: t("count.theirs", { name, n: st.proposal.dead.length }) };
    return { title: t("count.title"), detail: t("count.first", { name }) };
  }
  const title = mine ? t("status.yourTurn") : t("status.theirTurn", { name });
  let detail: string | null = null;
  if (last === "pass") detail = mine ? t("status.theyPassed", { name }) : t("status.youPassed");
  else if (last === "resume") detail = t("status.resumed");
  else if (isAwaitingOpponent(entry)) detail = t("status.inviteSent", { name });
  return { title, detail };
}

export interface CellView {
  /** 0 empty, 1 black, 2 white. */
  stone: number;
  last: boolean;
  dead: boolean;
  /** In counting / at the end: whose area an empty (or dead) point is. */
  area: number;
  preview: boolean;
}

/** "D4, black stone, last move" for a screen reader. */
export function cellLabel(size: number, p: number, v: CellView, mine: Color | null): string {
  const parts = [pointName(size, p)];
  if (v.stone === BLACK) parts.push(t("cell.black"));
  else if (v.stone === WHITE) parts.push(t("cell.white"));
  else if (v.preview && mine) parts.push(t("cell.preview"));
  else parts.push(t("cell.empty"));
  if (v.dead) parts.push(t("cell.dead"));
  if (v.last) parts.push(t("cell.last"));
  if (v.area === BLACK && (v.stone === 0 || v.dead)) parts.push(t("cell.areaB"));
  else if (v.area === WHITE && (v.stone === 0 || v.dead)) parts.push(t("cell.areaW"));
  return parts.join(", ");
}

/** The result in one line: "Black wins by 3.5" / "White wins by resignation". */
export function resultLine(st: GameState): string | null {
  const r = st.result;
  if (!r) return null;
  const winner = colorName(r.winner);
  return r.by === "resign" ? t("end.byResign", { winner }) : t("end.byScore", { winner, margin: num(r.margin) });
}

/** What to say about the opponent's new entries (polite live region). */
export function announceInbound(entry: GameEntry, added: readonly Entry[], before: GameState | null, after: GameState): string[] {
  const name = personName(entry);
  const out: string[] = [];
  let st = before;
  for (const e of added) {
    if (typeof e === "number") {
      out.push(t("say.played", { name, point: pointName(after.size, e) }));
      const taken = after.lastMove === e ? after.lastCaptured.length : 0;
      if (taken > 0) out.push(t("say.capturedYours", { n: taken }));
    } else if (e === "pass") {
      out.push(st?.passes === 1 ? t("say.passedEnd", { name }) : t("say.passed", { name }));
    } else if (e === "resume") {
      out.push(t("say.resumed", { name }));
    } else if (isResign(e)) {
      out.push(t("say.resigned", { name }));
    } else if (isMark(e) && !(after.phase === "over" && after.result?.by === "score")) {
      out.push(t("say.marked", { name, n: e.length }));
    }
    st = null;
  }
  if (after.phase === "over") {
    const line = resultLine(after);
    if (line && after.result?.by === "score") out.push(line);
  } else if (after.toMove === entry.myColor && after.phase === "play") {
    out.push(t("say.yourTurn"));
  }
  return out;
}

/** What to say about our own step. */
export function announceOwn(e: Entry, after: GameState): string[] {
  if (typeof e === "number") {
    const out = [t("say.youPlayed", { point: pointName(after.size, e) })];
    if (after.lastCaptured.length > 0) out.push(t("say.youCaptured", { n: after.lastCaptured.length }));
    return out;
  }
  if (e === "pass") return [t("say.youPassed")];
  if (after.phase === "over") return [resultLine(after) ?? ""];
  return [];
}
