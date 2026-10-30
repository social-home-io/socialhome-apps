/**
 * The lobby's list of games (pure, no DOM): three groups — your turn,
 * waiting (for the other player, or for them to accept), finished — newest
 * first, and the line that tells two games with the same person apart.
 */
import { boardMoveCount, isMyTurn } from "./chess.js";
import { moveRows } from "./notation.js";
import { t } from "./i18n.js";
import type { GameEntry } from "./lifecycle.js";

export interface GameGroups {
  yourTurn: GameEntry[];
  waiting: GameEntry[];
  finished: GameEntry[];
}

const newestFirst = (a: GameEntry, b: GameEntry): number => (b.updatedAt ?? 0) - (a.updatedAt ?? 0);

/** Split and sort games: your turn → waiting → finished, newest first in each. */
export function groupGames(games: Iterable<GameEntry>): GameGroups {
  const groups: GameGroups = { yourTurn: [], waiting: [], finished: [] };
  for (const g of games) {
    if (g.state.result !== null) groups.finished.push(g);
    else if (isMyTurn(g.state, g.myColor)) groups.yourTurn.push(g);
    else groups.waiting.push(g);
  }
  groups.yourTurn.sort(newestFirst);
  groups.waiting.sort(newestFirst);
  groups.finished.sort(newestFirst);
  return groups;
}

/** "White · move 12 · Nf3" — your colour, the move number and the last move. */
export function gameMeta(entry: GameEntry): string {
  const color = t(entry.myColor === "w" ? "color.w" : "color.b");
  const count = boardMoveCount(entry.state);
  if (count === 0) return t("game.metaNew", { color });
  const rows = moveRows(entry.state.history);
  const last = rows[rows.length - 1];
  const n = String(Math.floor((count - 1) / 2) + 1);
  if (!last) return t("game.meta", { color, n });
  return t("game.metaLast", { color, n, san: last.san });
}
