/**
 * The lobby's list of games (pure, no DOM): your turn → waiting →
 * finished, newest first in each.
 */
import { isMyTurn, isOver } from "./lifecycle.js";
import type { GameEntry } from "./lifecycle.js";

export interface GameGroups {
  yourTurn: GameEntry[];
  waiting: GameEntry[];
  finished: GameEntry[];
}

const newestFirst = (a: GameEntry, b: GameEntry): number => b.updatedAt - a.updatedAt;

export function groupGames(games: Iterable<GameEntry>): GameGroups {
  const groups: GameGroups = { yourTurn: [], waiting: [], finished: [] };
  for (const g of games) {
    if (isOver(g)) groups.finished.push(g);
    else if (isMyTurn(g)) groups.yourTurn.push(g);
    else groups.waiting.push(g);
  }
  groups.yourTurn.sort(newestFirst);
  groups.waiting.sort(newestFirst);
  groups.finished.sort(newestFirst);
  return groups;
}
