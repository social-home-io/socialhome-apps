/**
 * Chess app — multi-friend real-time multiplayer UI.
 *
 * Architecture:
 *  - `games` Map<sessionId, GameEntry> — all active / finished games this user
 *    has open, persisted to sh.store under keys "game:<sessionId>".
 *  - `peers` list loaded once at startup; used to resolve display names.
 *  - Two views: LOBBY (friends list + active-games list) and BOARD (one game).
 *  - Message routing: onMessage and onSession both carry sessionId; the
 *    handler looks up the matching GameEntry — no global mutable "active game".
 *  - Board orientation: White's pieces near the bottom; if myColor is "b"
 *    the board renders with row 7 (rank 1) at the top so Black's pieces are
 *    still near the player.
 */

import sh from "@socialhome/app-sdk";
import type { AppLook, AppMessage, Contact, PickedPerson, SessionTarget } from "@socialhome/app-sdk";
import {
  initialState,
  applyAction,
  applyMove,
  canTakeAction,
  isInCheck,
  positionOf,
  rowOf,
  colOf,
  lastMove,
  isMyTurn,
  PROMOTION_PIECES,
} from "./chess.js";
import type { GameAction, GameState, Move, Color, PieceType, Ply } from "./chess.js";
import {
  endGameButtonLabel,
  endGameConfirmCopy,
  continueCopy,
  entryForPicked,
  inviteMismatchMessage,
  isUnknownGame,
  isLocalOpponent,
  pickFailure,
  classifySessionEvent,
  declinedMessage,
  endedMessage,
  inviteGoneMessage,
  isAwaitingOpponent,
  launchAction,
  senderOf,
  withdrawnMessage,
} from "./lifecycle.js";
import type { ConfirmCopy, GameEntry } from "./lifecycle.js";
import { catchUpFromOwnCopy, judgeInbound, restoreState, routeInbound } from "./inbound.js";
import {
  activateSquare,
  boardHint,
  boardLabel,
  buildSquareOrder,
  checkedKing,
  endingText,
  initialCursor,
  isNavKey,
  moveAnnouncement,
  moveCursor,
  noneAnnouncement,
  selectionCleared,
  selectionAnnouncement,
  squareLabel,
} from "./board-nav.js";
import { createAnnouncer } from "./announcer.js";
import type { Announcer } from "./announcer.js";
import { t, tAround } from "./i18n.js";
import { applyLook } from "./look.js";

// The SDK singleton is non-null in the browser / iframe and `null` outside it
// (e.g. the Node test runner importing the pure helpers below). `client` is
// only dereferenced from `main()`, which is gated on a real browser context.
const client = sh as NonNullable<typeof sh>;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Pure helper: split contacts into the player's own household (`is_local`)
 * and remote friends. No DOM — unit-tested. Order within each group is
 * preserved from the input.
 */
export function groupContacts(
  contacts: Contact[],
): { household: Contact[]; friends: Contact[] } {
  const household: Contact[] = [];
  const friends: Contact[] = [];
  for (const c of contacts) {
    if (c.is_local) household.push(c);
    else friends.push(c);
  }
  return { household, friends };
}

/** Build a SessionTarget addressing the opponent of a game entry. */
function targetForEntry(entry: GameEntry): SessionTarget {
  return {
    instance_id: entry.opponentInstanceId,
    user_ref: entry.opponentRef,
    is_local: entry.opponentIsLocal,
  };
}

type View = "lobby" | "board";

interface UIState {
  view: View;
  selfUserId: string;
  contacts: Contact[];
  games: Map<string, GameEntry>;
  /** sessionId of the game currently shown on the board view. */
  activeBoardSession: string | null;
  /** Square index the player has clicked and selected. */
  selectedSquare: number | null;
  /** Legal target square indices for the selected piece. */
  legalTargets: number[];
  /** The board's keyboard cursor: the one square in the tab order. */
  cursor: number | null;
  /** Toast queue: each is {id, message} shown for ~4 s. */
  toasts: { id: number; message: string }[];
  /**
   * Seat live / drained invites as games — only on an older Social Home
   * (no launch context). A newer one keeps invites in "Needs you" until
   * Play, which opens chess with that game. `false` until the context says.
   */
  liveInvites: boolean;
  /**
   * An older Social Home without the invite sheet (`people.pick`): chess
   * lists the people itself and opens games with `openSession`. A newer one
   * lists only people played before, and "New game" opens Social Home's sheet.
   */
  legacyPicker: boolean;
  /** The person asked for less motion (Social Home's context). */
  reducedMotion: boolean;
}

const ui: UIState = {
  view: "lobby",
  selfUserId: "",
  contacts: [],
  games: new Map(),
  activeBoardSession: null,
  selectedSquare: null,
  legalTargets: [],
  cursor: null,
  toasts: [],
  liveInvites: false,
  legacyPicker: false,
  reducedMotion: false,
};

let _toastCounter = 0;

// ---------------------------------------------------------------------------
// Wire message shapes
// ---------------------------------------------------------------------------

/**
 * A move or action message. `move` is the newest history entry; `state` the
 * game in the shape every chess version reads (`history` is all a current
 * chess takes — the receiver replays it; the board and result are for older
 * versions only).
 */
interface MovePayload {
  type: "move";
  sessionId: string;
  move: Ply;
  state: Pick<GameState, "board" | "sideToMove" | "history" | "result">;
}

function movePayload(entry: GameEntry): MovePayload {
  const { board, sideToMove, history, result } = entry.state;
  return {
    type: "move",
    sessionId: entry.sessionId,
    move: history[history.length - 1],
    state: { board, sideToMove, history, result },
  };
}

interface OpenPayload {
  type: "open";
  opponentName?: string;
}

/** A move message of any chess version (judged in full by `judgeInbound`). */
function isMoveMessage(v: unknown): boolean {
  return typeof v === "object" && v !== null && (v as Record<string, unknown>)["type"] === "move";
}

// ---------------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------------

const STORE_PREFIX = "game:";

function storeKey(sessionId: string): string {
  return STORE_PREFIX + sessionId;
}

async function persistGame(entry: GameEntry): Promise<void> {
  await client.store.set(storeKey(entry.sessionId), entry);
}

async function deleteGame(sessionId: string): Promise<void> {
  await client.store.delete(storeKey(sessionId));
}

async function loadAllGames(): Promise<void> {
  const all = await client.store.list();
  for (const [key, value] of Object.entries(all)) {
    if (!key.startsWith(STORE_PREFIX)) continue;
    if (typeof value !== "object" || value === null) continue;
    const e = value as Partial<GameEntry>;
    if (
      typeof e.sessionId === "string" &&
      typeof e.opponentInstanceId === "string" &&
      typeof e.opponentName === "string" &&
      (e.myColor === "w" || e.myColor === "b") &&
      typeof e.state === "object" && e.state !== null
    ) {
      // Be tolerant of games persisted before the person-addressing fields
      // existed: fall back to "" / false so old games still resume. The game
      // itself is rebuilt from its moves (castling rights, clocks and the
      // rest follow), else kept as it was saved.
      const entry: GameEntry = {
        sessionId: e.sessionId,
        opponentInstanceId: e.opponentInstanceId,
        opponentRef: typeof e.opponentRef === "string" ? e.opponentRef : "",
        opponentIsLocal: e.opponentIsLocal === true,
        opponentName: e.opponentName,
        myColor: e.myColor,
        state: restoreState(e.state) ?? legacyState(e.state as GameState),
      };
      ui.games.set(entry.sessionId, entry);
    }
  }
}

/** A saved game today's engine can't replay: keep its board and moves as they are. */
function legacyState(raw: GameState): GameState {
  return {
    ...positionOf(raw.board, raw.sideToMove),
    history: Array.isArray(raw.history) ? raw.history : [],
    result: raw.result ?? null,
  };
}

// ---------------------------------------------------------------------------
// Piece glyphs
// ---------------------------------------------------------------------------

// Both sides use the SOLID silhouette glyphs; colour (white vs black stone)
// is applied via the `piece--w` / `piece--b` CSS classes so each side reads as
// a real white or black piece on any square. (The Unicode "white" glyphs are
// outline-only and would render the same colour as black under a single fill.)
const PIECE_GLYPHS: Record<string, string> = {
  wK: "♚", wQ: "♛", wR: "♜", wB: "♝", wN: "♞", wP: "♟",
  bK: "♚", bQ: "♛", bR: "♜", bB: "♝", bN: "♞", bP: "♟",
};
const pieceColorClass = (key: string): string => (key[0] === "w" ? "piece--w" : "piece--b");

// ---------------------------------------------------------------------------
// Live region (screen-reader announcements)
// ---------------------------------------------------------------------------

/**
 * One polite live region, created once outside #app-root so re-renders never
 * replace it (a freshly inserted live region is often not read). Writes go
 * through a debounced, de-duplicating announcer.
 */
let announcer: Announcer | null = null;

function say(text: string): void {
  if (!announcer) {
    const region = make("div", {
      cls: "sr-only",
      attrs: { id: "chess-live", "aria-live": "polite", "aria-atomic": "true" },
    });
    document.body.appendChild(region);
    announcer = createAnnouncer((t) => {
      // Empty first so the same sentence later is still a DOM change.
      region.textContent = "";
      setTimeout(() => { region.textContent = t; }, 30);
    });
  }
  announcer.announce(text);
}

// ---------------------------------------------------------------------------
// Toast helpers
// ---------------------------------------------------------------------------

function showToast(message: string): void {
  const id = ++_toastCounter;
  ui.toasts.push({ id, message });
  renderToasts();
  setTimeout(() => {
    ui.toasts = ui.toasts.filter((t) => t.id !== id);
    renderToasts();
  }, 5000);
}

function notifyMyTurn(sessionId: string): void {
  // Haptic nudge on devices that support it (mobile); silently ignored elsewhere.
  try {
    if (typeof navigator !== "undefined" && typeof navigator.vibrate === "function") {
      navigator.vibrate([40, 30, 40]);
    }
  } catch { /* vibrate can throw if gated by the UA; ignore */ }
  // Visual cue: pulse the board if the player is viewing this game — not
  // when they asked for less motion (the announcer still says it).
  if (ui.view === "board" && ui.activeBoardSession === sessionId && !ui.reducedMotion) {
    const grid = document.getElementById("board-grid");
    if (grid) {
      grid.classList.remove("your-move-pulse");
      // force reflow so the animation restarts even on consecutive turns
      void grid.offsetWidth;
      grid.classList.add("your-move-pulse");
    }
  }
}

function renderToasts(): void {
  let container = document.getElementById("toast-container");
  if (!container) {
    container = document.createElement("div");
    container.id = "toast-container";
    container.setAttribute("aria-live", "polite");
    container.setAttribute("aria-atomic", "false");
    document.body.appendChild(container);
  }
  // Rebuild toasts
  container.innerHTML = "";
  for (const toast of ui.toasts) {
    const el = document.createElement("div");
    el.className = "toast";
    el.textContent = toast.message;
    container.appendChild(el);
  }
}

// ---------------------------------------------------------------------------
// DOM helpers
// ---------------------------------------------------------------------------

function el<T extends HTMLElement>(id: string): T {
  const elem = document.getElementById(id);
  if (!elem) throw new Error(`Missing element: #${id}`);
  return elem as T;
}

function clearChildren(node: HTMLElement): void {
  while (node.firstChild) node.removeChild(node.firstChild);
}

function make<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  opts: { cls?: string | string[]; text?: string; attrs?: Record<string, string> } = {}
): HTMLElementTagNameMap[K] {
  const elem = document.createElement(tag);
  if (opts.cls) {
    if (Array.isArray(opts.cls)) elem.className = opts.cls.join(" ");
    else elem.className = opts.cls;
  }
  if (opts.text !== undefined) elem.textContent = opts.text;
  if (opts.attrs) {
    for (const [k, v] of Object.entries(opts.attrs)) {
      elem.setAttribute(k, v);
    }
  }
  return elem;
}

// ---------------------------------------------------------------------------
// Render: Lobby
// ---------------------------------------------------------------------------

function renderLobby(): void {
  const root = el("app-root");
  clearChildren(root);
  root.className = "view-lobby";

  // ---- Active games ----
  if (ui.games.size > 0) {
    const section = make("section", { cls: "lobby-section" });
    const h2 = make("h2", { cls: "section-heading", text: t("lobby.active") });
    section.appendChild(h2);

    const list = make("ul", { cls: "game-list" });
    for (const [sessionId, entry] of ui.games) {
      const myTurn = isMyTurn(entry.state, entry.myColor);
      const isOver = entry.state.result !== null;

      const li = make("li", { cls: "game-item" });

      const info = make("div", { cls: "game-item-info" });
      const nameEl = make("span", { cls: "game-opponent-name", text: entry.opponentName });
      const colorEl = make("span", {
        cls: "game-my-color",
        text: t(entry.myColor === "w" ? "color.w" : "color.b"),
      });
      info.appendChild(nameEl);
      info.appendChild(colorEl);

      if (isOver) {
        const badge = make("span", { cls: "badge badge-over" });
        badge.textContent = resultLabel(entry.state.result!, entry.myColor);
        info.appendChild(badge);
      } else if (isAwaitingOpponent(entry)) {
        const badge = make("span", { cls: "badge badge-waiting", text: t("badge.inviteSent") });
        info.appendChild(badge);
      } else if (myTurn) {
        const badge = make("span", { cls: "badge badge-your-turn", text: t("badge.yourTurn") });
        info.appendChild(badge);
      } else {
        const badge = make("span", { cls: "badge badge-waiting", text: t("badge.waiting") });
        info.appendChild(badge);
      }

      li.appendChild(info);

      const actions = make("div", { cls: "game-item-actions" });
      const resumeBtn = make("button", {
        cls: "btn btn-primary",
        text: t("btn.resume"),
        attrs: { "aria-label": t("btn.resumeWith", { name: entry.opponentName }), "data-resume": sessionId },
      });
      resumeBtn.addEventListener("click", () => {
        openBoardView(sessionId);
      });
      actions.appendChild(resumeBtn);

      if (isAwaitingOpponent(entry)) {
        // Our invite hasn't been answered: take it back, so the invitee's
        // "Needs you" item goes too (not just our local copy).
        const cancelBtn = make("button", { cls: "btn btn-ghost", text: t("btn.cancelInvite") });
        cancelBtn.addEventListener("click", () => void onCancelInvite(sessionId));
        actions.appendChild(cancelBtn);
      } else {
        const label = endGameButtonLabel(entry);
        const labelWith = t(entry.state.result === null ? "btn.resignWith" : "btn.removeWith", {
          name: entry.opponentName,
        });
        const endBtn = make("button", {
          cls: "btn btn-ghost",
          text: label,
          attrs: { "aria-label": labelWith },
        });
        endBtn.addEventListener("click", () => void onEndGame(sessionId));
        actions.appendChild(endBtn);
      }

      li.appendChild(actions);
      list.appendChild(li);
    }
    section.appendChild(list);
    root.appendChild(section);
  }

  if (ui.legacyPicker) {
    // An older Social Home (no invite sheet): it still lists everyone the
    // person can message, and chess opens the game itself.
    const { household, friends } = groupContacts(ui.contacts);
    root.appendChild(
      buildContactSection(t("lobby.household"), household, t("lobby.householdEmpty"), "challenge"),
    );
    root.appendChild(
      buildContactSection(t("lobby.friends"), friends, t("lobby.friendsEmpty"), "challenge"),
    );
    return;
  }

  // ---- New game: Social Home's invite sheet picks the person ----
  const play = make("section", { cls: "lobby-section lobby-new-game" });
  play.appendChild(make("h2", { cls: "section-heading", text: t("lobby.playSomeone") }));
  play.appendChild(
    make("p", {
      cls: "lobby-hint",
      text: t("lobby.hint"),
    }),
  );
  const newGameBtn = make("button", { cls: "btn btn-primary", text: t("btn.newGame") });
  newGameBtn.addEventListener("click", () => void onNewGame());
  play.appendChild(newGameBtn);
  root.appendChild(play);

  // ---- People you've played: a rematch goes through the sheet too ----
  if (ui.contacts.length > 0) {
    root.appendChild(buildContactSection(t("lobby.playedBefore"), ui.contacts, "", "rematch"));
  }
}

/** Build a lobby section listing people, with presence + empty state. */
function buildContactSection(
  heading: string,
  people: Contact[],
  emptyText: string,
  action: "challenge" | "rematch",
): HTMLElement {
  const section = make("section", { cls: "lobby-section" });
  section.appendChild(make("h2", { cls: "section-heading", text: heading }));

  if (people.length === 0) {
    section.appendChild(make("p", { cls: "empty-state", text: emptyText }));
    return section;
  }

  const list = make("ul", { cls: "peer-list" });
  for (const contact of people) {
    const li = make("li", { cls: "peer-item" });

    const presenceLabel = t(contact.online ? "presence.online" : "presence.offline");
    const dot = make("span", {
      cls: ["presence-dot", contact.online ? "presence-online" : "presence-offline"],
      attrs: { role: "img", "aria-label": presenceLabel, title: presenceLabel },
    });
    li.appendChild(dot);

    li.appendChild(make("span", { cls: "peer-name", text: contact.display_name }));

    const challenge = action === "challenge";
    const challengeBtn = make("button", {
      cls: challenge ? "btn btn-primary" : "btn btn-ghost",
      text: t(challenge ? "btn.challenge" : "btn.rematch"),
      attrs: {
        "aria-label": t(challenge ? "btn.challengeWho" : "btn.rematchWho", { name: contact.display_name }),
      },
    });
    challengeBtn.addEventListener("click", () =>
      void (challenge ? onChallengeContact(contact) : onNewGame(contact)),
    );
    li.appendChild(challengeBtn);

    list.appendChild(li);
  }
  section.appendChild(list);
  return section;
}

function resultLabel(result: "white" | "black" | "draw", myColor: Color): string {
  if (result === "draw") return t("result.draw");
  const iWon = (result === "white" && myColor === "w") || (result === "black" && myColor === "b");
  return t(iWon ? "result.won" : "result.lost");
}

// ---------------------------------------------------------------------------
// Render: Board view
// ---------------------------------------------------------------------------

function openBoardView(sessionId: string): void {
  ui.activeBoardSession = sessionId;
  ui.selectedSquare = null;
  ui.legalTargets = [];
  const entry = ui.games.get(sessionId);
  ui.cursor = entry ? initialCursor(entry.state, entry.myColor) : null;
  ui.view = "board";
  renderBoard();
  // Opening a game moves focus to the board's single tab stop, so a
  // keyboard player can start moving at once.
  focusCursor();
}

function backToLobby(): void {
  const from = ui.activeBoardSession;
  ui.view = "lobby";
  ui.activeBoardSession = null;
  ui.selectedSquare = null;
  ui.legalTargets = [];
  ui.cursor = null;
  announcer?.clear();
  renderLobby();
  // Land on the game we came from, not on <body>.
  const resume = from
    ? document.querySelector<HTMLElement>(`[data-resume="${CSS.escape(from)}"]`)
    : null;
  (resume ?? firstControl())?.focus();
}

/** The first button in the current view, for focus after a removal. */
function firstControl(): HTMLElement | null {
  return document.querySelector<HTMLElement>("#app-root button");
}

/** Focus the cursor square (the board's one tab stop), if it is drawn. */
function focusCursor(): void {
  if (ui.cursor === null) return;
  document
    .querySelector<HTMLElement>(`#board-grid [data-sq="${ui.cursor}"]`)
    ?.focus({ preventScroll: true });
}

function renderBoard(): void {
  const entry = ui.activeBoardSession ? ui.games.get(ui.activeBoardSession) : null;
  if (!entry) {
    ui.view = "lobby";
    renderLobby();
    return;
  }

  // Re-rendering replaces every square; if the player was on the board,
  // put focus back on the cursor square afterwards so it is never lost.
  const hadBoardFocus = document.activeElement?.closest("#board-grid") != null;
  if (ui.cursor === null) ui.cursor = initialCursor(entry.state, entry.myColor);

  const root = el("app-root");
  clearChildren(root);
  root.className = "view-board";

  // ---- Header row ----
  const header = make("div", { cls: "board-header" });

  const backBtn = make("button", { cls: "btn btn-ghost btn-back" });
  backBtn.setAttribute("aria-label", t("board.backLabel"));
  // The arrow points back in the reading direction (mirrored in RTL, CSS).
  backBtn.append(make("span", { cls: "flip-rtl", text: "←", attrs: { "aria-hidden": "true" } }), ` ${t("board.back")}`);
  backBtn.addEventListener("click", backToLobby);
  header.appendChild(backBtn);

  const opponentEl = make("div", { cls: "board-header-opponent" });
  const opponentGlyph = make("span", {
    cls: "color-indicator",
    text: entry.myColor === "w" ? "♟" : "♙",
    attrs: { "aria-hidden": "true" },
  });
  const opponentNameEl = make("span", { cls: "opponent-label", text: entry.opponentName });
  opponentEl.appendChild(opponentGlyph);
  opponentEl.appendChild(opponentNameEl);
  header.appendChild(opponentEl);

  const liveDot = make("span", {
    cls: "live-dot",
    attrs: { "aria-label": t("board.live"), title: t("board.connected") },
  });
  header.appendChild(liveDot);

  root.appendChild(header);

  // ---- Our invite not answered yet: say so, and let us take it back ----
  // Sits right under the header so it stays in view on short iframes.
  if (isAwaitingOpponent(entry)) {
    const banner = make("div", { cls: "invite-pending" });
    const note = make("p", { cls: "invite-pending-text" });
    const [before, after] = tAround("board.waitingAccept");
    note.append(before, make("strong", { text: entry.opponentName }), after);
    banner.appendChild(note);
    const cancelBtn = make("button", { cls: "btn btn-ghost", text: t("btn.cancelInvite") });
    cancelBtn.addEventListener("click", () => void onCancelInvite(entry.sessionId));
    banner.appendChild(cancelBtn);
    root.appendChild(banner);
  }

  // ---- Captured pieces (opponent's captures = your lost pieces) ----
  const { captured } = computeCaptured(entry.state);
  const theirColor: Color = entry.myColor === "w" ? "b" : "w";

  // Pieces the opponent captured (show above board = far side)
  const capturedTop = make("div", { cls: "captured-row captured-top" });
  capturedTop.setAttribute("aria-label", t("board.capturedBy", { name: entry.opponentName }));
  renderCapturedPieces(capturedTop, captured[theirColor]);
  root.appendChild(capturedTop);

  // ---- Board grid with rank/file labels ----
  // Always left to right, also in a right-to-left language: files a–h run
  // left→right (from White's side) as on every chess board and in every
  // chess app; only the text around the board follows the language.
  const boardWrap = make("div", { cls: "board-wrap", attrs: { dir: "ltr" } });

  const boardInner = make("div", { cls: "board-inner" });

  // File labels top
  boardInner.appendChild(buildFileLabels(entry.myColor));

  const boardAndRanks = make("div", { cls: "board-and-ranks" });

  // Rank labels left
  const rankLabelsLeft = buildRankLabels(entry.myColor);
  boardAndRanks.appendChild(rankLabelsLeft);

  // The 8×8 grid
  const boardGrid = make("div", { cls: "chess-board" });
  boardGrid.setAttribute("role", "grid");
  boardGrid.setAttribute("aria-label", boardLabel(entry.myColor));
  boardGrid.setAttribute("aria-describedby", "board-hint");
  boardGrid.id = "board-grid";
  boardGrid.addEventListener("keydown", onBoardKeydown);

  const game = entry.state;
  const lm = lastMove(game);
  const checked = checkedKing(game);

  // Determine rendering order: if I play Black, flip so my pieces are near me
  const squareIndices = buildSquareOrder(entry.myColor);

  // ARIA grid: 8 rows of 8 gridcells. The row wrappers are
  // `display: contents`, so the CSS grid still lays out the 64 squares.
  let row: HTMLElement | null = null;
  for (const [i, sqIdx] of squareIndices.entries()) {
    if (i % 8 === 0) {
      row = make("div", { cls: "board-row", attrs: { role: "row" } });
      boardGrid.appendChild(row);
    }
    const r = rowOf(sqIdx);
    const c = colOf(sqIdx);
    const isLight = (r + c) % 2 === 0;

    const cell = make("div", {
      cls: ["square", isLight ? "light" : "dark"],
    });
    cell.setAttribute("role", "gridcell");

    const piece = game.board[sqIdx];
    const selected = sqIdx === ui.selectedSquare;
    const legalTarget = ui.legalTargets.includes(sqIdx);
    const isLast = lm !== null && (sqIdx === lm.from || sqIdx === lm.to);
    cell.setAttribute("aria-label", squareLabel(game, sqIdx, { selected, legalTarget, lastMove: isLast }));
    cell.setAttribute("aria-selected", selected ? "true" : "false");
    // Roving tabindex: exactly one square (the cursor) is in the tab order.
    cell.setAttribute("tabindex", sqIdx === ui.cursor ? "0" : "-1");

    if (selected) cell.classList.add("selected");
    if (legalTarget) cell.classList.add("legal-target");
    if (isLast) cell.classList.add("last-move");
    if (sqIdx === checked) cell.classList.add("in-check");

    if (piece) {
      const glyph = make("span", {
        cls: ["piece", pieceColorClass(piece.color + piece.type)],
        text: PIECE_GLYPHS[piece.color + piece.type] ?? "?",
        attrs: { "aria-hidden": "true" },
      });
      cell.appendChild(glyph);
    }

    cell.dataset["sq"] = String(sqIdx);
    cell.addEventListener("click", onSquareClick);

    row!.appendChild(cell);
  }
  boardAndRanks.appendChild(boardGrid);

  // Rank labels right (duplicate for symmetry)
  const rankLabelsRight = buildRankLabels(entry.myColor);
  rankLabelsRight.classList.add("rank-labels-right");
  boardAndRanks.appendChild(rankLabelsRight);

  boardInner.appendChild(boardAndRanks);

  // File labels bottom
  boardInner.appendChild(buildFileLabels(entry.myColor));
  boardWrap.appendChild(boardInner);
  root.appendChild(boardWrap);
  root.appendChild(make("p", { cls: "sr-only", text: boardHint(), attrs: { id: "board-hint" } }));

  // ---- Captured pieces (mine = bottom row) ----
  const capturedBottom = make("div", { cls: "captured-row captured-bottom" });
  capturedBottom.setAttribute("aria-label", t("board.capturedByYou"));
  renderCapturedPieces(capturedBottom, captured[entry.myColor]);
  root.appendChild(capturedBottom);

  // ---- Status / turn indicator ----
  // Not a live region: moves, check and "your turn" are spoken once through
  // the shared announcer (#chess-live) instead of on every re-render.
  const statusEl = make("div", { cls: "game-status" });
  statusEl.appendChild(buildStatusContent(entry));
  root.appendChild(statusEl);
  const actionsEl = buildGameActions(entry);
  if (actionsEl) root.appendChild(actionsEl);

  if (hadBoardFocus) focusCursor();
}

function buildFileLabels(myColor: Color): HTMLElement {
  const row = make("div", { cls: "file-labels", attrs: { "aria-hidden": "true" } });
  const files = myColor === "w" ? "abcdefgh" : "hgfedcba";
  // Left offset cell to align with rank labels
  row.appendChild(make("span", { cls: "label-corner" }));
  for (const f of files) {
    const span = make("span", { cls: "file-label", text: f });
    row.appendChild(span);
  }
  row.appendChild(make("span", { cls: "label-corner" }));
  return row;
}

function buildRankLabels(myColor: Color): HTMLElement {
  const col = make("div", { cls: "rank-labels", attrs: { "aria-hidden": "true" } });
  const ranks = myColor === "w" ? [8, 7, 6, 5, 4, 3, 2, 1] : [1, 2, 3, 4, 5, 6, 7, 8];
  for (const r of ranks) {
    col.appendChild(make("span", { cls: "rank-label", text: String(r) }));
  }
  return col;
}

function renderCapturedPieces(container: HTMLElement, pieces: string[]): void {
  clearChildren(container);
  // Group by type for compact display
  const counts = new Map<string, number>();
  for (const p of pieces) {
    counts.set(p, (counts.get(p) ?? 0) + 1);
  }
  for (const [key, count] of counts) {
    for (let i = 0; i < count; i++) {
      const span = make("span", {
        cls: ["captured-piece", pieceColorClass(key)],
        text: PIECE_GLYPHS[key] ?? "?",
        attrs: { "aria-hidden": "true" },
      });
      container.appendChild(span);
    }
  }
}

/** Returns pieces captured by each side, keyed by the capturer's color. */
function computeCaptured(state: GameState): { captured: { w: string[]; b: string[] } } {
  const initialCounts: Record<string, number> = {
    wP: 8, wN: 2, wB: 2, wR: 2, wQ: 1,
    bP: 8, bN: 2, bB: 2, bR: 2, bQ: 1,
  };
  const remaining: Record<string, number> = { ...initialCounts };
  for (const sq of state.board) {
    if (sq) {
      const key = sq.color + sq.type;
      if (key in remaining) remaining[key]--;
    }
  }
  // Black captured = white pieces missing; white captured = black pieces missing
  const capturedByBlack: string[] = [];
  const capturedByWhite: string[] = [];
  for (const [key, lost] of Object.entries(remaining)) {
    if (lost <= 0) continue;
    const color = key[0] as Color;
    if (color === "w") {
      for (let i = 0; i < lost; i++) capturedByBlack.push(key);
    } else {
      for (let i = 0; i < lost; i++) capturedByWhite.push(key);
    }
  }
  return { captured: { w: capturedByWhite, b: capturedByBlack } };
}

function buildStatusContent(entry: GameEntry): DocumentFragment {
  const frag = document.createDocumentFragment();
  const game = entry.state;

  if (game.result !== null) {
    const p = make("p", { cls: "status-game-over", text: endingText(game, entry.myColor, entry.opponentName) });
    const lbl = make("span", { cls: "status-result-badge", text: resultLabel(game.result, entry.myColor) });
    p.appendChild(lbl);
    frag.appendChild(p);
    return frag;
  }

  const inCheck = isInCheck(game.board, game.sideToMove);
  const myTurn = isMyTurn(game, entry.myColor);
  const colorLabel = t(game.sideToMove === "w" ? "color.w" : "color.b");

  // Built as elements: the opponent's name is text, never markup.
  if (myTurn) {
    const p = make("p", { cls: "status-your-turn" });
    p.append(
      make("strong", { text: t("status.yourMove") }),
      " ",
      make("span", { cls: "status-color-chip", text: colorLabel }),
    );
    if (inCheck) {
      const chip = make("span", { cls: "status-check-chip", text: t("status.check") });
      p.appendChild(chip);
    }
    frag.appendChild(p);
  } else {
    const p = make("p", { cls: "status-waiting" });
    const [before, after] = tAround("status.waitingFor");
    p.append(before, make("strong", { text: entry.opponentName }), after);
    if (inCheck) {
      const chip = make("span", { cls: "status-check-chip", text: t("status.check") });
      p.appendChild(chip);
    }
    frag.appendChild(p);
  }
  return frag;
}

/**
 * The game's own buttons under the board: an open draw offer (theirs, with
 * Accept / Decline on our turn; ours, waiting for them), Offer draw on our
 * turn, and Resign while the game runs.
 */
function buildGameActions(entry: GameEntry): HTMLElement | null {
  const game = entry.state;
  if (game.result !== null) return null;
  const me = entry.myColor;
  const bar = make("div", { cls: "game-actions" });

  if (game.drawOffer !== null && game.drawOffer !== me) {
    const offer = make("div", { cls: "draw-offer", attrs: { role: "group", "aria-label": t("draw.theyOffer", { name: entry.opponentName }) } });
    offer.appendChild(make("p", { cls: "draw-offer-text", text: t("draw.theyOffer", { name: entry.opponentName }) }));
    if (canTakeAction(game, "accept-draw", me)) {
      const accept = make("button", { cls: "btn btn-primary", text: t("btn.acceptDraw"), attrs: { type: "button" } });
      accept.addEventListener("click", () => void onAction(entry, "accept-draw"));
      const decline = make("button", { cls: "btn btn-ghost", text: t("btn.declineDraw"), attrs: { type: "button" } });
      decline.addEventListener("click", () => void onAction(entry, "decline-draw"));
      offer.append(accept, decline);
    }
    bar.appendChild(offer);
  } else if (game.drawOffer === me) {
    bar.appendChild(make("p", { cls: "draw-offer-text", text: t("draw.youOffered", { name: entry.opponentName }) }));
  }

  const buttons = make("div", { cls: "game-actions-buttons" });
  if (canTakeAction(game, "offer-draw", me)) {
    const offerBtn = make("button", { cls: "btn btn-ghost", text: t("btn.offerDraw"), attrs: { type: "button" } });
    offerBtn.addEventListener("click", () => void onAction(entry, "offer-draw"));
    buttons.appendChild(offerBtn);
  }
  const resignBtn = make("button", {
    cls: "btn btn-ghost btn-resign",
    text: t("btn.resign"),
    attrs: { type: "button", "aria-label": t("btn.resignWith", { name: entry.opponentName }) },
  });
  resignBtn.addEventListener("click", () => void onEndGame(entry.sessionId));
  buttons.appendChild(resignBtn);
  bar.appendChild(buttons);
  return bar;
}

// ---------------------------------------------------------------------------
// Main render dispatch
// ---------------------------------------------------------------------------

function render(): void {
  if (ui.view === "lobby") {
    renderLobby();
  } else {
    renderBoard();
  }
}

// ---------------------------------------------------------------------------
// Interaction: Square click / keyboard
// ---------------------------------------------------------------------------

function onSquareClick(ev: Event): void {
  const cell = ev.currentTarget as HTMLElement;
  activate(Number(cell.dataset["sq"]));
}

/**
 * Board keys (on the grid, so they work from whichever square has focus):
 * arrows / Home / End / PageUp / PageDown move the cursor, Enter / Space
 * activate it, Escape puts a picked-up piece back.
 */
function onBoardKeydown(ev: KeyboardEvent): void {
  const entry = ui.activeBoardSession ? ui.games.get(ui.activeBoardSession) : null;
  if (!entry || ui.cursor === null) return;

  if (isNavKey(ev.key)) {
    ev.preventDefault();
    const next = moveCursor(ui.cursor, ev.key, entry.myColor, ev.ctrlKey || ev.metaKey);
    if (next === ui.cursor) return;
    // Move the single tab stop in place — no re-render needed.
    const grid = document.getElementById("board-grid");
    grid?.querySelector(`[data-sq="${ui.cursor}"]`)?.setAttribute("tabindex", "-1");
    ui.cursor = next;
    const cell = grid?.querySelector<HTMLElement>(`[data-sq="${next}"]`);
    cell?.setAttribute("tabindex", "0");
    cell?.focus();
    return;
  }
  if (ev.key === "Enter" || ev.key === " ") {
    ev.preventDefault();
    activate(ui.cursor);
    return;
  }
  if (ev.key === "Escape" && ui.selectedSquare !== null) {
    ev.preventDefault();
    ev.stopPropagation();
    ui.selectedSquare = null;
    ui.legalTargets = [];
    say(selectionCleared());
    renderBoard();
  }
}

/** Click or Enter/Space on a square: one decision, see `activateSquare`. */
function activate(sqIdx: number): void {
  const entry = ui.activeBoardSession ? ui.games.get(ui.activeBoardSession) : null;
  if (!entry) return;
  ui.cursor = sqIdx;

  const action = activateSquare(entry.state, entry.myColor, ui.selectedSquare, ui.legalTargets, sqIdx);
  switch (action.kind) {
    case "select":
      ui.selectedSquare = action.square;
      ui.legalTargets = action.targets;
      say(selectionAnnouncement(entry.state, action.square, action.targets));
      break;
    case "clear":
      ui.selectedSquare = null;
      ui.legalTargets = [];
      say(selectionCleared());
      break;
    case "move":
      void onMove(entry, action.move);
      break;
    case "promote":
      void onPromote(entry, action.from, action.to);
      return;
    case "none":
      say(noneAnnouncement(action.reason, entry.opponentName));
      break;
  }
  renderBoard();
}

/** A pawn reached the last rank: ask which piece it becomes, then move. */
async function onPromote(entry: GameEntry, from: number, to: number): Promise<void> {
  const piece = await promotionDialog(entry.myColor);
  if (!piece) {
    // Cancelled: the pawn stays picked up, so another target can be chosen.
    renderBoard();
    focusCursor();
    return;
  }
  await onMove(entry, { from, to, promotion: piece });
  focusCursor();
}

/**
 * The promotion picker: a native modal <dialog> with one button per piece
 * (queen first and focused), reachable by Tab / arrow keys; Escape cancels.
 */
function promotionDialog(color: Color): Promise<PieceType | null> {
  return new Promise((resolve) => {
    const dlg = make("dialog", {
      cls: "confirm-dialog promotion-dialog",
      attrs: { "aria-labelledby": "promo-title", "aria-describedby": "promo-hint" },
    });
    dlg.appendChild(make("h2", { cls: "confirm-title", text: t("promo.title"), attrs: { id: "promo-title" } }));
    dlg.appendChild(make("p", { cls: "confirm-body", text: t("promo.hint"), attrs: { id: "promo-hint" } }));
    const choices = make("div", { cls: "promotion-choices", attrs: { role: "group", "aria-labelledby": "promo-title" } });
    let chosen: PieceType | null = null;
    const buttons: HTMLButtonElement[] = [];
    for (const type of PROMOTION_PIECES) {
      const btn = make("button", { cls: "btn promotion-choice", attrs: { type: "button", "data-piece": type } });
      btn.append(
        make("span", { cls: ["piece", pieceColorClass(color + type)], text: PIECE_GLYPHS[color + type], attrs: { "aria-hidden": "true" } }),
        make("span", { cls: "promotion-label", text: t(`promo.${type}` as "promo.Q") }),
      );
      btn.addEventListener("click", () => { chosen = type; dlg.close(); });
      buttons.push(btn);
      choices.appendChild(btn);
    }
    // Arrow keys move between the four pieces as well as Tab.
    choices.addEventListener("keydown", (ev) => {
      const i = buttons.indexOf(document.activeElement as HTMLButtonElement);
      if (i === -1) return;
      const step = ev.key === "ArrowRight" || ev.key === "ArrowDown" ? 1 : ev.key === "ArrowLeft" || ev.key === "ArrowUp" ? -1 : 0;
      if (!step) return;
      ev.preventDefault();
      buttons[(i + step + buttons.length) % buttons.length].focus();
    });
    dlg.appendChild(choices);
    const actions = make("div", { cls: "confirm-actions" });
    const cancel = make("button", { cls: "btn btn-ghost", text: t("promo.cancel"), attrs: { type: "button" } });
    cancel.addEventListener("click", () => dlg.close());
    actions.appendChild(cancel);
    dlg.appendChild(actions);
    dlg.addEventListener("click", (ev) => { if (ev.target === dlg) dlg.close(); });
    dlg.addEventListener("close", () => {
      dlg.remove();
      resolve(chosen);
    });
    document.body.appendChild(dlg);
    dlg.showModal();
    buttons[0].focus();
  });
}

async function onMove(entry: GameEntry, move: Move): Promise<void> {
  try {
    const before = entry.state;
    const next = applyMove(before, move);
    entry.state = next;
    ui.selectedSquare = null;
    ui.legalTargets = [];
    ui.cursor = move.to;
    say(moveAnnouncement({
      before, after: next, move, myColor: entry.myColor, opponentName: entry.opponentName,
    }));
    await persistAndSend(entry);
  } catch (err) {
    console.error("Move failed:", err);
    ui.selectedSquare = null;
    ui.legalTargets = [];
    renderBoard();
  }
}

/** Offer / accept / decline a draw, or resign — a history entry like a move. */
async function onAction(entry: GameEntry, action: GameAction): Promise<void> {
  const before = entry.state;
  const ply = { action, by: entry.myColor };
  let next: GameState;
  try {
    next = applyAction(before, ply);
  } catch (err) {
    console.warn("Chess: action not allowed", err);
    renderBoard();
    return;
  }
  entry.state = next;
  ui.selectedSquare = null;
  ui.legalTargets = [];
  say(moveAnnouncement({ before, after: next, move: ply, myColor: entry.myColor, opponentName: entry.opponentName }));
  await persistAndSend(entry);
}

/** Save our newest entry and send the game to the opponent. */
async function persistAndSend(entry: GameEntry): Promise<void> {
  await persistGame(entry);
  const payload = movePayload(entry);
  try {
    await client.federation.send(entry.sessionId, targetForEntry(entry), payload);
  } catch (err) {
    if (!isUnknownGame(err)) {
      console.error("Chess: send failed", err);
      render();
      return;
    }
    // Social Home no longer knows this game: offer to pick it up again
    // through its own sheet (the move stays on our board).
    render();
    await offerContinue(entry, payload);
    return;
  }
  render();
}

// ---------------------------------------------------------------------------
// Session management
// ---------------------------------------------------------------------------

/**
 * "New game" / "Rematch": Social Home shows its invite sheet (outside chess),
 * the person picks and taps Send, and Social Home sends the invite. Chess
 * learns only who was picked and the game's session id, then sends its opening
 * message in that session. A rematch only suggests the person; the sheet still
 * asks.
 */
async function onNewGame(suggest?: Contact): Promise<void> {
  let picked: PickedPerson[];
  try {
    picked = await client.people.pick({
      purpose: "play",
      max: 1,
      ...(suggest
        ? { suggest: { instance_id: suggest.instance_id, user_ref: suggest.user_ref, is_local: suggest.is_local } }
        : {}),
    });
  } catch (err) {
    const failure = pickFailure(err);
    if (failure.kind === "legacy") {
      // An older Social Home: fall back to chess's own list.
      ui.legacyPicker = true;
      ui.contacts = await client.contacts().catch(() => ui.contacts);
      render();
    } else if (failure.kind === "toast") {
      showToast(failure.message);
    }
    return;
  }
  let first: GameEntry | null = null;
  for (const p of picked) {
    const entry = entryForPicked(p);
    ui.games.set(entry.sessionId, entry);
    await persistGame(entry);
    // Tell the opponent's chess who challenged them (best effort: the
    // invite itself already reached them through Social Home).
    await client.federation
      .send(entry.sessionId, targetForEntry(entry), { type: "open" } satisfies OpenPayload)
      .catch(() => {});
    first ??= entry;
  }
  if (!first) {
    // Cancelled: back where they were.
    render();
    return;
  }
  ui.contacts = await client.contacts().catch(() => ui.contacts);
  openBoardView(first.sessionId);
}

/** An older Social Home only: chess opens the game itself. */
async function onChallengeContact(contact: Contact): Promise<void> {
  try {
    const target: SessionTarget = {
      instance_id: contact.instance_id,
      user_ref: contact.user_ref,
      is_local: contact.is_local,
    };
    const sessionId = await client.federation.openSession(target);
    const entry: GameEntry = {
      sessionId,
      opponentInstanceId: contact.instance_id,
      opponentRef: contact.user_ref,
      opponentIsLocal: contact.is_local,
      opponentName: contact.display_name,
      myColor: "w", // the challenger always plays White
      state: initialState(),
    };
    ui.games.set(sessionId, entry);
    await persistGame(entry);

    // Send an opening message so the opponent knows whom challenged them.
    // The session-open event already reaches them via onSession, but we also
    // send a move-0 payload so they can set up the game with our name.
    // (No-op if the host hasn't yet handled the session — they'll get it from onSession.)
    await client.federation.send(sessionId, target, {
      type: "open",
    } satisfies OpenPayload).catch(() => {
      // Best-effort; the session event is enough.
    });

    openBoardView(sessionId);
  } catch (err) {
    console.error("Failed to start game:", err);
    showToast(t("toast.challengeFailed"));
  }
}

/**
 * "Continue game with Ben": Social Home no longer knows this game (from
 * before it kept games, or quiet for more than 90 days). Ask first; then
 * Social Home's own sheet confirms the person and re-registers the game,
 * and the latest state goes out again. Ben gets it in Needs you and taps
 * Play.
 */
async function offerContinue(entry: GameEntry, latest: MovePayload): Promise<void> {
  if (!(await confirmDialog(continueCopy(entry)))) return;
  let picked: PickedPerson[];
  try {
    picked = await client.people.pick({
      purpose: "continue",
      sessionId: entry.sessionId,
      suggest: targetForEntry(entry),
    });
  } catch (err) {
    const failure = pickFailure(err);
    if (failure.kind === "toast") showToast(failure.message);
    return;
  }
  if (!picked.some((p) => p.sessionId === entry.sessionId)) return;
  try {
    await client.federation.send(entry.sessionId, targetForEntry(entry), latest);
    showToast(t("toast.askedContinue", { name: entry.opponentName }));
  } catch (err) {
    console.warn("Chess: resend after continue failed", err);
    showToast(t("toast.couldntReach", { name: entry.opponentName }));
  }
}

/** Drop a game locally (memory + store) and return to the lobby if it was shown. */
async function removeGame(sessionId: string): Promise<void> {
  ui.games.delete(sessionId);
  if (ui.activeBoardSession === sessionId) {
    ui.activeBoardSession = null;
    ui.selectedSquare = null;
    ui.legalTargets = [];
    ui.cursor = null;
    ui.view = "lobby";
  }
  // An invite toast for this game would now open nothing.
  document
    .querySelectorAll(`.toast-invite[data-session-id="${CSS.escape(sessionId)}"]`)
    .forEach((t) => t.remove());
  await deleteGame(sessionId);
  render();
}

/**
 * Resign a game in play (the opponent is told and wins; the game stays in
 * the list as finished) or remove a finished one from this list.
 */
async function onEndGame(sessionId: string): Promise<void> {
  const entry = ui.games.get(sessionId);
  if (!entry) return;
  if (!(await confirmDialog(endGameConfirmCopy(entry)))) return;
  if (entry.state.result === null) {
    await onAction(entry, "resign");
    return;
  }
  await removeGame(sessionId);
  firstControl()?.focus();
}

/**
 * In-app confirm (the sandboxed iframe can't use window.confirm). A native
 * modal <dialog>: focus is trapped inside, Escape and a backdrop click
 * cancel, and focus starts on the safe choice (cancel). Resolves true only
 * on the confirm button.
 */
function confirmDialog(copy: ConfirmCopy): Promise<boolean> {
  return new Promise((resolve) => {
    const returnFocus = document.activeElement as HTMLElement | null;
    const dlg = make("dialog", {
      cls: "confirm-dialog",
      attrs: { "aria-labelledby": "confirm-title", "aria-describedby": "confirm-body" },
    });
    dlg.appendChild(make("h2", { cls: "confirm-title", text: copy.title, attrs: { id: "confirm-title" } }));
    dlg.appendChild(make("p", { cls: "confirm-body", text: copy.body, attrs: { id: "confirm-body" } }));
    const actions = make("div", { cls: "confirm-actions" });
    const cancelBtn = make("button", { cls: "btn btn-ghost", text: copy.cancel, attrs: { type: "button" } });
    const okBtn = make("button", {
      cls: copy.primary ? "btn btn-primary" : "btn btn-danger",
      text: copy.confirm,
      attrs: { type: "button" },
    });
    actions.append(cancelBtn, okBtn);
    dlg.appendChild(actions);

    let confirmed = false;
    cancelBtn.addEventListener("click", () => dlg.close());
    okBtn.addEventListener("click", () => { confirmed = true; dlg.close(); });
    // A click on the backdrop lands on the <dialog> itself.
    dlg.addEventListener("click", (ev) => { if (ev.target === dlg) dlg.close(); });
    dlg.addEventListener("close", () => {
      dlg.remove();
      if (!confirmed && returnFocus?.isConnected) returnFocus.focus();
      resolve(confirmed);
    });

    document.body.appendChild(dlg);
    dlg.showModal();
    cancelBtn.focus();
  });
}

/**
 * The challenger takes back an invite nobody answered: tell Social Home
 * (`federation.cancelSession`) so the invitee's "Needs you" item clears and
 * their app drops the game, then drop it here. Local removal happens even if
 * the call fails (e.g. an older host) — the invite then just expires there.
 */
async function onCancelInvite(sessionId: string): Promise<void> {
  const entry = ui.games.get(sessionId);
  if (!entry) return;
  try {
    await client.federation.cancelSession(sessionId, targetForEntry(entry));
    showToast(t("toast.inviteCancelled", { name: entry.opponentName }));
  } catch (err) {
    console.warn("Chess: cancelSession failed", err);
    showToast(t("toast.inviteMayShow", { name: entry.opponentName }));
  }
  await removeGame(sessionId);
}

// ---------------------------------------------------------------------------
// Inbound federation messages
// ---------------------------------------------------------------------------

function onInboundMessage(msg: AppMessage): void {
  void takeInboundMove(msg).catch((err) => {
    console.error("Chess: inbound move failed", err);
  });
}

/**
 * Our copy of a game is ours: a message adds at most ONE opponent move that
 * our own engine finds legal on top of the moves we have (`judgeInbound`).
 * Anything else leaves the game unchanged, is logged (never its content) and
 * gets a calm notice. Routed by the session Social Home delivered it in.
 */
async function takeInboundMove(msg: AppMessage): Promise<void> {
  if (!isMoveMessage(msg.payload)) return;
  const route = routeInbound(msg, ui.games);
  if (route.kind === "drop") {
    console.warn("chess.inbound_dropped", { session_id: msg.sessionId, reason: route.reason });
    return;
  }
  const entry = route.entry;
  const sessionId = entry.sessionId;

  let verdict = judgeInbound(entry.state, entry.myColor, msg.payload);
  if (verdict.kind === "refuse" && (verdict.reason === "too-many" || verdict.reason === "wrong-colour")) {
    // This screen may hold an older copy than our store (the same person
    // played on another screen): catch up from our own copy and judge again.
    const stored = await client.store.get(storeKey(sessionId)).catch(() => null);
    const own = catchUpFromOwnCopy(entry.state, (stored as Partial<GameEntry> | null)?.state);
    if (own) {
      entry.state = own;
      verdict = judgeInbound(entry.state, entry.myColor, msg.payload);
    }
  }

  if (verdict.kind === "stale") return;
  if (verdict.kind === "refuse") {
    console.warn("chess.inbound_refused", { session_id: sessionId, reason: verdict.reason });
    showToast(t("toast.moveRefused", { name: entry.opponentName }));
    return;
  }

  const before = entry.state;
  entry.state = verdict.state;
  void persistGame(entry);

  const becameMyTurn = isMyTurn(entry.state, entry.myColor);

  // Update the live board if this game is being viewed
  if (ui.view === "board" && ui.activeBoardSession === sessionId) {
    ui.selectedSquare = null;
    ui.legalTargets = [];
    say(announceAdded(entry, before, verdict.added));
    renderBoard();
  } else {
    // A toast so the player notices what happened in a background game.
    showToast(backgroundToast(entry, verdict.added));
    // Re-render lobby if visible to update badges
    if (ui.view === "lobby") renderLobby();
  }

  // Alert (vibrate + board pulse) when the opponent's move handed us the turn.
  // Runs after renderBoard so the freshly-rendered #board-grid is present.
  if (becameMyTurn) notifyMyTurn(sessionId);
}

/** The live-region sentence for the opponent's new entries, oldest first. */
function announceAdded(entry: GameEntry, before: GameState, added: readonly Ply[]): string {
  // Replay from the shared start of the new entries for each sentence.
  const base = before.history.length;
  const parts: string[] = [];
  let st = before;
  for (const [i, ply] of added.entries()) {
    const next = i === added.length - 1 ? entry.state : stateAt(entry.state, base + i + 1) ?? entry.state;
    parts.push(moveAnnouncement({ before: st, after: next, move: ply, myColor: entry.myColor, opponentName: entry.opponentName }));
    st = next;
  }
  return parts.join(" ");
}

/** The game after its first `n` history entries (replayed), or null. */
function stateAt(state: GameState, n: number): GameState | null {
  return restoreState({ history: state.history.slice(0, n) });
}

/** The toast for an opponent's news in a game that isn't on screen. */
function backgroundToast(entry: GameEntry, added: readonly Ply[]): string {
  const name = entry.opponentName;
  const last = added[added.length - 1];
  if (last && "action" in last) {
    if (last.action === "resign") return t("toast.resigned", { name });
    if (last.action === "accept-draw") return t("toast.drawAccepted", { name });
  }
  if (entry.state.drawOffer !== null && entry.state.drawOffer !== entry.myColor) return t("toast.drawOffered", { name });
  return t("toast.moved", { name });
}

function onInboundSession(msg: AppMessage): void {
  const action = classifySessionEvent(msg, ui.games, {
    liveInvites: ui.liveInvites,
    selfUserId: ui.selfUserId,
  });
  switch (action.kind) {
    case "declined":
      showToast(declinedMessage(action.entry.opponentName));
      void removeGame(action.entry.sessionId);
      return;
    case "withdrawn":
      showToast(withdrawnMessage(action.entry.opponentName));
      void removeGame(action.entry.sessionId);
      return;
    case "ended":
      showToast(endedMessage(action.entry.opponentName));
      void removeGame(action.entry.sessionId);
      return;
    case "ignore":
      return;
    case "invite":
      onInvite(msg);
      return;
  }
}

/** An older host: seat the invite and offer it with a toast. */
function onInvite(msg: AppMessage): void {
  const entry = seatInvite(msg);
  if (!entry) return;
  // Show a non-blocking invite toast with Accept action
  showInviteToast(entry.opponentName, entry.sessionId);
  if (ui.view === "lobby") renderLobby();
}

/**
 * A friend opened a new game session targeting this person: add it to our
 * games (we play Black). `null` when we already have it.
 */
function seatInvite(msg: AppMessage): GameEntry | null {
  const sessionId = msg.sessionId;
  const fromInstance = msg.fromInstance;
  const fromUser = senderOf(msg);

  if (ui.games.has(sessionId)) {
    // Structured dedupe instrumentation — never log payload/game content.
    console.info("chess.onInboundSession", { session_id: sessionId, dedupe: "hit" });
    return null;
  }
  console.info("chess.onInboundSession", { session_id: sessionId, dedupe: "miss" });

  // Resolve the opponent's display name from the contact directory, matching
  // both the sender household and the person (user_ref); fall back to the raw
  // identity, then the household id.
  const contact = ui.contacts.find(
    (c) => c.instance_id === fromInstance && c.user_ref === fromUser,
  );
  const opponentName = contact?.display_name ?? fromUser ?? fromInstance;

  // The challenger is local iff they share our household: after Play,
  // Social Home lists them as a contact and says so; else any local contact
  // carries our household's id; if we know none, default to remote.
  const opponentIsLocal = isLocalOpponent(fromInstance, fromUser, ui.contacts);

  const entry: GameEntry = {
    sessionId,
    opponentInstanceId: fromInstance,
    opponentRef: fromUser ?? "",
    opponentIsLocal,
    opponentName,
    myColor: "b", // the invitee always plays Black
    state: initialState(),
  };
  ui.games.set(sessionId, entry);
  void persistGame(entry);
  return entry;
}

function showInviteToast(opponentName: string, sessionId: string): void {
  const id = ++_toastCounter;

  let container = document.getElementById("toast-container");
  if (!container) {
    container = document.createElement("div");
    container.id = "toast-container";
    container.setAttribute("aria-live", "polite");
    container.setAttribute("aria-atomic", "false");
    document.body.appendChild(container);
  }

  const toastEl = make("div", { cls: "toast toast-invite" });
  const msgSpan = make("span", { text: `♟ ${t("toast.invited", { name: opponentName })}` });
  toastEl.appendChild(msgSpan);

  const acceptBtn = make("button", { cls: "btn btn-toast-accept", text: t("btn.accept") });
  acceptBtn.addEventListener("click", () => {
    toastEl.remove();
    openBoardView(sessionId);
  });
  toastEl.appendChild(acceptBtn);

  const dismissBtn = make("button", { cls: "btn btn-toast-dismiss", text: t("btn.later") });
  dismissBtn.addEventListener("click", () => {
    toastEl.remove();
  });
  toastEl.appendChild(dismissBtn);

  toastEl.dataset["toastId"] = String(id);
  toastEl.dataset["sessionId"] = sessionId;
  container.appendChild(toastEl);

  // Auto-dismiss after 10 s (longer for invites)
  setTimeout(() => {
    toastEl.remove();
  }, 10000);
}

// ---------------------------------------------------------------------------
// Bootstrap
// ---------------------------------------------------------------------------

/**
 * What Social Home kept while chess was closed or turned off: the latest
 * message of each game — a move (applied unless we already have it, see
 * `isStaleMove`), or a close (declined / withdrawn, handled like a live one).
 * An older Social Home doesn't keep them (the call fails): nothing to do.
 */
async function applyHeld(): Promise<void> {
  let held;
  try {
    held = await client.federation.held();
  } catch (err) {
    console.info("Chess: no held moves from this Social Home", err);
    return;
  }
  for (const msg of held) {
    if (msg.kind === "session") onInboundSession(msg);
    else onInboundMessage(msg);
  }
}

/** Apply Social Home's look and put the shell's own words in its language. */
function onLook(look: AppLook): void {
  applyLook(look, document.documentElement);
  document.title = t("app.docTitle");
  const title = document.getElementById("app-title");
  if (title) title.textContent = t("app.title");
  document.getElementById("app-root")?.setAttribute("aria-label", t("app.mainLabel"));
  ui.reducedMotion = look.reducedMotion === true;
}

async function main(): Promise<void> {
  if (!sh) {
    throw new Error("Social Home SDK not available — must run inside an iframe.");
  }
  // Subscribe to real-time messages immediately so no events are missed.
  client.onMessage(onInboundMessage);
  client.onSession(onInboundSession);

  // Show initial loading skeleton
  const root = el("app-root");
  root.replaceChildren(make("p", { cls: "loading-msg", text: t("app.loading"), attrs: { "aria-live": "polite" } }));

  try {
    const [ctx, _store] = await Promise.all([
      // Held moves are fetched below, once our games are loaded.
      client.context({ pullHeld: true }),
      loadAllGames(),
    ]);
    // Social Home's language, light/dark and colours (D14); live changes
    // re-apply and redraw (an older Social Home sends none: English, dark).
    onLook(ctx);
    client.onContextChange((look) => {
      onLook(look);
      render();
    });
    ui.selfUserId = ctx.selfUserId;
    // After the context: a Play launch has taken its invite in by then, so
    // the inviter is among the people chess may know.
    ui.contacts = await client.contacts();
    // A Social Home from before permissions has no invite sheet either.
    ui.legacyPicker = ctx.permissions === undefined;

    if (ctx.launch === undefined) {
      // An older Social Home: it accepts every waiting invite when chess
      // opens and hands them over here. Seat them (deduped by sessionId
      // against the games we just loaded) and keep seating live ones.
      ui.liveInvites = true;
      try {
        const pending = await client.federation.pendingSessions();
        for (const invite of pending) onInboundSession(invite);
      } catch (err) {
        console.warn("Chess: pending-invite replay failed", err);
      }
      render();
      return;
    }

    // Invites wait in Social Home's "Needs you"; "Play" there opens chess
    // with that one game (D12). Opened any other way, nothing is accepted.
    render();
    const launch = launchAction(ctx.launch, ui.games);
    switch (launch.kind) {
      case "start": {
        const entry = seatInvite(launch.invite);
        if (entry) openBoardView(entry.sessionId);
        break;
      }
      case "open":
        openBoardView(launch.sessionId);
        break;
      case "gone":
        showToast(inviteGoneMessage());
        break;
      case "mismatch":
        showToast(inviteMismatchMessage());
        break;
      case "none":
        break;
    }
    await applyHeld();
  } catch (err) {
    console.error("Chess: init failed", err);
    root.replaceChildren(make("p", { cls: "error-msg", text: t("app.loadFailed") }));
  }
}

// Auto-boot only inside a real browser/iframe. Imported in Node (the test
// runner) the module exposes its pure helpers without touching the DOM.
if (typeof window !== "undefined") {
  void main();
}
