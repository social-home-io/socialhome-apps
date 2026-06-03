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
import type { AppMessage, Peer } from "@socialhome/app-sdk";
import {
  initialState,
  legalMoves,
  applyMove,
  squareName,
  isInCheck,
  rowOf,
  colOf,
} from "./chess.js";
import type { GameState, Move, Color } from "./chess.js";

// Ensure the SDK is non-null (it is non-null in browser / iframe).
if (!sh) {
  throw new Error("Social Home SDK not available — must run inside an iframe.");
}
const client = sh;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface GameEntry {
  sessionId: string;
  opponentInstanceId: string;
  opponentName: string;
  myColor: Color;
  state: GameState;
}

type View = "lobby" | "board";

interface UIState {
  view: View;
  selfUserId: string;
  peers: Peer[];
  games: Map<string, GameEntry>;
  /** sessionId of the game currently shown on the board view. */
  activeBoardSession: string | null;
  /** Square index the player has clicked and selected. */
  selectedSquare: number | null;
  /** Legal target square indices for the selected piece. */
  legalTargets: number[];
  /** Toast queue: each is {id, message} shown for ~4 s. */
  toasts: { id: number; message: string }[];
}

const ui: UIState = {
  view: "lobby",
  selfUserId: "",
  peers: [],
  games: new Map(),
  activeBoardSession: null,
  selectedSquare: null,
  legalTargets: [],
  toasts: [],
};

let _toastCounter = 0;

// ---------------------------------------------------------------------------
// Wire message shapes
// ---------------------------------------------------------------------------

interface MovePayload {
  type: "move";
  sessionId: string;
  move: Move;
  state: GameState;
}

interface OpenPayload {
  type: "open";
  opponentName?: string;
}

function isMovePayload(v: unknown): v is MovePayload {
  if (typeof v !== "object" || v === null) return false;
  const p = v as Record<string, unknown>;
  return (
    p["type"] === "move" &&
    typeof p["sessionId"] === "string" &&
    typeof p["move"] === "object" && p["move"] !== null &&
    typeof p["state"] === "object" && p["state"] !== null
  );
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
      ui.games.set(e.sessionId, e as GameEntry);
    }
  }
}

// ---------------------------------------------------------------------------
// Piece glyphs
// ---------------------------------------------------------------------------

const PIECE_GLYPHS: Record<string, string> = {
  wK: "♔", wQ: "♕", wR: "♖", wB: "♗", wN: "♘", wP: "♙",
  bK: "♚", bQ: "♛", bR: "♜", bB: "♝", bN: "♞", bP: "♟",
};

const PIECE_NAMES: Record<string, string> = {
  K: "king", Q: "queen", R: "rook", B: "bishop", N: "knight", P: "pawn",
};

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
    const h2 = make("h2", { cls: "section-heading", text: "Active games" });
    section.appendChild(h2);

    const list = make("ul", { cls: "game-list" });
    for (const [sessionId, entry] of ui.games) {
      const isMyTurn = entry.state.sideToMove === entry.myColor && entry.state.result === null;
      const isOver = entry.state.result !== null;

      const li = make("li", { cls: "game-item" });

      const info = make("div", { cls: "game-item-info" });
      const nameEl = make("span", { cls: "game-opponent-name", text: entry.opponentName });
      const colorEl = make("span", {
        cls: "game-my-color",
        text: entry.myColor === "w" ? "White" : "Black",
      });
      info.appendChild(nameEl);
      info.appendChild(colorEl);

      if (isOver) {
        const badge = make("span", { cls: "badge badge-over" });
        badge.textContent = resultLabel(entry.state.result!, entry.myColor);
        info.appendChild(badge);
      } else if (isMyTurn) {
        const badge = make("span", { cls: "badge badge-your-turn", text: "Your turn" });
        info.appendChild(badge);
      } else {
        const badge = make("span", { cls: "badge badge-waiting", text: "Waiting" });
        info.appendChild(badge);
      }

      li.appendChild(info);

      const actions = make("div", { cls: "game-item-actions" });
      const resumeBtn = make("button", { cls: "btn btn-primary", text: "Resume" });
      resumeBtn.addEventListener("click", () => {
        openBoardView(sessionId);
      });
      actions.appendChild(resumeBtn);

      const abandonBtn = make("button", { cls: "btn btn-ghost", text: "Abandon" });
      abandonBtn.addEventListener("click", () => void onAbandonGame(sessionId));
      actions.appendChild(abandonBtn);

      li.appendChild(actions);
      list.appendChild(li);
    }
    section.appendChild(list);
    root.appendChild(section);
  }

  // ---- Friends / peer list ----
  const section2 = make("section", { cls: "lobby-section" });
  const h2b = make("h2", { cls: "section-heading", text: "Challenge a friend" });
  section2.appendChild(h2b);

  if (ui.peers.length === 0) {
    const msg = make("p", {
      cls: "empty-state",
      text: "No paired households yet — pair a friend in Social Home to play.",
    });
    section2.appendChild(msg);
  } else {
    const list2 = make("ul", { cls: "peer-list" });
    for (const peer of ui.peers) {
      const li = make("li", { cls: "peer-item" });
      const nameEl = make("span", { cls: "peer-name", text: peer.display_name });
      li.appendChild(nameEl);
      const challengeBtn = make("button", { cls: "btn btn-primary", text: "Challenge" });
      challengeBtn.addEventListener("click", () => void onChallengePeer(peer));
      li.appendChild(challengeBtn);
      list2.appendChild(li);
    }
    section2.appendChild(list2);
  }
  root.appendChild(section2);
}

function resultLabel(result: "white" | "black" | "draw", myColor: Color): string {
  if (result === "draw") return "Draw";
  const iWon = (result === "white" && myColor === "w") || (result === "black" && myColor === "b");
  return iWon ? "You won!" : "You lost";
}

// ---------------------------------------------------------------------------
// Render: Board view
// ---------------------------------------------------------------------------

function openBoardView(sessionId: string): void {
  ui.activeBoardSession = sessionId;
  ui.selectedSquare = null;
  ui.legalTargets = [];
  ui.view = "board";
  renderBoard();
}

function renderBoard(): void {
  const entry = ui.activeBoardSession ? ui.games.get(ui.activeBoardSession) : null;
  if (!entry) {
    ui.view = "lobby";
    renderLobby();
    return;
  }

  const root = el("app-root");
  clearChildren(root);
  root.className = "view-board";

  // ---- Header row ----
  const header = make("div", { cls: "board-header" });

  const backBtn = make("button", { cls: "btn btn-ghost btn-back" });
  backBtn.setAttribute("aria-label", "Back to lobby");
  backBtn.innerHTML = `<span aria-hidden="true">←</span> Lobby`;
  backBtn.addEventListener("click", () => {
    ui.view = "lobby";
    ui.activeBoardSession = null;
    ui.selectedSquare = null;
    ui.legalTargets = [];
    renderLobby();
  });
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
    attrs: { "aria-label": "Live game", title: "Connected" },
  });
  header.appendChild(liveDot);

  root.appendChild(header);

  // ---- Captured pieces (opponent's captures = your lost pieces) ----
  const { captured } = computeCaptured(entry.state);
  const theirColor: Color = entry.myColor === "w" ? "b" : "w";

  // Pieces the opponent captured (show above board = far side)
  const capturedTop = make("div", { cls: "captured-row captured-top" });
  capturedTop.setAttribute("aria-label", `Captured by ${entry.opponentName}`);
  renderCapturedPieces(capturedTop, captured[theirColor]);
  root.appendChild(capturedTop);

  // ---- Board grid with rank/file labels ----
  const boardWrap = make("div", { cls: "board-wrap" });
  boardWrap.setAttribute("role", "grid");
  boardWrap.setAttribute("aria-label", "Chess board");

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

  const game = entry.state;
  const isMyTurn = game.sideToMove === entry.myColor && game.result === null;

  // Determine rendering order: if I play Black, flip so my pieces are near me
  const squareIndices = buildSquareOrder(entry.myColor);

  for (const sqIdx of squareIndices) {
    const r = rowOf(sqIdx);
    const c = colOf(sqIdx);
    const isLight = (r + c) % 2 === 0;

    const cell = make("div", {
      cls: ["square", isLight ? "light" : "dark"],
    });
    cell.setAttribute("role", "gridcell");

    const sname = squareName(sqIdx);
    const piece = game.board[sqIdx];
    const pieceName = piece ? `${piece.color === "w" ? "white" : "black"} ${PIECE_NAMES[piece.type]}` : "empty";
    cell.setAttribute("aria-label", `${sname}, ${pieceName}`);
    cell.setAttribute("tabindex", isMyTurn && piece?.color === entry.myColor ? "0" : "-1");

    if (sqIdx === ui.selectedSquare) cell.classList.add("selected");
    if (ui.legalTargets.includes(sqIdx)) cell.classList.add("legal-target");

    if (piece) {
      const glyph = make("span", {
        cls: "piece",
        text: PIECE_GLYPHS[piece.color + piece.type] ?? "?",
        attrs: { "aria-hidden": "true" },
      });
      cell.appendChild(glyph);
    }

    cell.dataset["sq"] = String(sqIdx);
    cell.addEventListener("click", onSquareClick);
    cell.addEventListener("keydown", (ev) => {
      if (ev.key === "Enter" || ev.key === " ") {
        ev.preventDefault();
        onSquareClick(ev);
      }
    });

    boardGrid.appendChild(cell);
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

  // ---- Captured pieces (mine = bottom row) ----
  const capturedBottom = make("div", { cls: "captured-row captured-bottom" });
  capturedBottom.setAttribute("aria-label", "Captured by you");
  renderCapturedPieces(capturedBottom, captured[entry.myColor]);
  root.appendChild(capturedBottom);

  // ---- Status / turn indicator ----
  const statusEl = make("div", {
    cls: "game-status",
    attrs: { "aria-live": "polite", "aria-atomic": "true" },
  });
  statusEl.appendChild(buildStatusContent(entry));
  root.appendChild(statusEl);
}

function buildSquareOrder(myColor: Color): number[] {
  // White: row 0..7, col 0..7 → standard orientation (a8 top-left, h1 bottom-right)
  // Black: row 7..0, col 7..0 → flipped so Black's pieces are near the player
  const indices: number[] = [];
  if (myColor === "w") {
    for (let i = 0; i < 64; i++) indices.push(i);
  } else {
    for (let r = 7; r >= 0; r--) {
      for (let c = 7; c >= 0; c--) {
        indices.push(r * 8 + c);
      }
    }
  }
  return indices;
}

function buildFileLabels(myColor: Color): HTMLElement {
  const row = make("div", { cls: "file-labels" });
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
  const col = make("div", { cls: "rank-labels" });
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
        cls: "captured-piece",
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
    const label = resultLabel(game.result, entry.myColor);
    let detail = "";
    if (game.result === "draw") detail = "Stalemate — it's a draw!";
    else if (
      (game.result === "white" && entry.myColor === "w") ||
      (game.result === "black" && entry.myColor === "b")
    ) {
      detail = "Checkmate — you win!";
    } else {
      detail = `Checkmate — ${entry.opponentName} wins.`;
    }
    const p = make("p", { cls: "status-game-over", text: detail });
    const lbl = make("span", { cls: "status-result-badge", text: label });
    p.appendChild(lbl);
    frag.appendChild(p);
    return frag;
  }

  const inCheck = isInCheck(game.board, game.sideToMove);
  const isMyTurn = game.sideToMove === entry.myColor;
  const colorLabel = game.sideToMove === "w" ? "White" : "Black";

  if (isMyTurn) {
    const p = make("p", { cls: "status-your-turn" });
    p.innerHTML = `<strong>Your move</strong> <span class="status-color-chip">${colorLabel}</span>`;
    if (inCheck) {
      const chip = make("span", { cls: "status-check-chip", text: "Check!" });
      p.appendChild(chip);
    }
    frag.appendChild(p);
  } else {
    const p = make("p", { cls: "status-waiting" });
    p.innerHTML = `Waiting for <strong>${entry.opponentName}</strong>`;
    if (inCheck) {
      const chip = make("span", { cls: "status-check-chip", text: "Check!" });
      p.appendChild(chip);
    }
    frag.appendChild(p);
  }
  return frag;
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
  const sqIdx = Number(cell.dataset["sq"]);

  const entry = ui.activeBoardSession ? ui.games.get(ui.activeBoardSession) : null;
  if (!entry) return;

  const game = entry.state;
  if (game.result !== null) return;
  if (game.sideToMove !== entry.myColor) return; // not our turn

  const piece = game.board[sqIdx];

  if (ui.selectedSquare === null) {
    if (piece && piece.color === entry.myColor) {
      ui.selectedSquare = sqIdx;
      ui.legalTargets = legalMoves(game, sqIdx).map((m) => m.to);
    }
  } else {
    if (ui.legalTargets.includes(sqIdx)) {
      const move: Move = { from: ui.selectedSquare, to: sqIdx };
      // Auto-promote to queen
      const movingPiece = game.board[ui.selectedSquare];
      if (movingPiece?.type === "P") {
        const promotionRow = movingPiece.color === "w" ? 0 : 7;
        if (rowOf(sqIdx) === promotionRow) {
          move.promotion = "Q";
        }
      }
      void onMove(entry, move);
    } else if (piece && piece.color === entry.myColor) {
      // Re-select another piece
      ui.selectedSquare = sqIdx;
      ui.legalTargets = legalMoves(game, sqIdx).map((m) => m.to);
    } else {
      ui.selectedSquare = null;
      ui.legalTargets = [];
    }
  }

  renderBoard();
}

async function onMove(entry: GameEntry, move: Move): Promise<void> {
  try {
    const next = applyMove(entry.state, move);
    entry.state = next;
    ui.selectedSquare = null;
    ui.legalTargets = [];

    await persistGame(entry);
    await client.federation.send(entry.sessionId, entry.opponentInstanceId, {
      type: "move",
      sessionId: entry.sessionId,
      move,
      state: next,
    } satisfies MovePayload);

    renderBoard();
  } catch (err) {
    console.error("Move failed:", err);
    ui.selectedSquare = null;
    ui.legalTargets = [];
    renderBoard();
  }
}

// ---------------------------------------------------------------------------
// Session management
// ---------------------------------------------------------------------------

async function onChallengePeer(peer: Peer): Promise<void> {
  try {
    const sessionId = await client.federation.openSession(peer.instance_id);
    const entry: GameEntry = {
      sessionId,
      opponentInstanceId: peer.instance_id,
      opponentName: peer.display_name,
      myColor: "w",
      state: initialState(),
    };
    ui.games.set(sessionId, entry);
    await persistGame(entry);

    // Send an opening message so the opponent knows whom challenged them.
    // The session-open event already reaches them via onSession, but we also
    // send a move-0 payload so they can set up the game with our name.
    // (No-op if the host hasn't yet handled the session — they'll get it from onSession.)
    await client.federation.send(sessionId, peer.instance_id, {
      type: "open",
    } satisfies OpenPayload).catch(() => {
      // Best-effort; the session event is enough.
    });

    openBoardView(sessionId);
  } catch (err) {
    console.error("Failed to start game:", err);
    showToast("Could not reach that household — please try again.");
  }
}

async function onAbandonGame(sessionId: string): Promise<void> {
  ui.games.delete(sessionId);
  if (ui.activeBoardSession === sessionId) {
    ui.activeBoardSession = null;
    ui.view = "lobby";
  }
  await deleteGame(sessionId);
  renderLobby();
}

// ---------------------------------------------------------------------------
// Inbound federation messages
// ---------------------------------------------------------------------------

function onInboundMessage(msg: AppMessage): void {
  if (!isMovePayload(msg.payload)) return;
  const sessionId = msg.payload.sessionId;
  const entry = ui.games.get(sessionId);
  if (!entry) return; // unknown session

  try {
    const verified = applyMove(entry.state, msg.payload.move);
    entry.state = verified;
  } catch {
    // Diverged — accept opponent's state, log it
    console.warn("Chess: local verify failed; accepting remote state", sessionId);
    entry.state = msg.payload.state;
  }

  void persistGame(entry);

  // Update the live board if this game is being viewed
  if (ui.view === "board" && ui.activeBoardSession === sessionId) {
    ui.selectedSquare = null;
    ui.legalTargets = [];
    renderBoard();
  } else {
    // Flash a toast so the player notices a move arrived in a background game
    showToast(`${entry.opponentName} moved in your game!`);
    // Re-render lobby if visible to update badges
    if (ui.view === "lobby") renderLobby();
  }
}

function onInboundSession(msg: AppMessage): void {
  // A friend opened a new game session targeting this household.
  const sessionId = msg.sessionId;
  const fromInstance = msg.fromInstance;

  if (ui.games.has(sessionId)) return; // duplicate

  const peer = ui.peers.find((p) => p.instance_id === fromInstance);
  const opponentName = peer?.display_name ?? fromInstance;

  const entry: GameEntry = {
    sessionId,
    opponentInstanceId: fromInstance,
    opponentName,
    myColor: "b", // the invitee always plays Black
    state: initialState(),
  };
  ui.games.set(sessionId, entry);
  void persistGame(entry);

  // Show a non-blocking invite toast with Accept action
  showInviteToast(opponentName, sessionId);

  if (ui.view === "lobby") renderLobby();
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
  const msgSpan = make("span", { text: `♟ ${opponentName} invited you to play!` });
  toastEl.appendChild(msgSpan);

  const acceptBtn = make("button", { cls: "btn btn-toast-accept", text: "Accept" });
  acceptBtn.addEventListener("click", () => {
    toastEl.remove();
    openBoardView(sessionId);
  });
  toastEl.appendChild(acceptBtn);

  const dismissBtn = make("button", { cls: "btn btn-toast-dismiss", text: "Later" });
  dismissBtn.addEventListener("click", () => {
    toastEl.remove();
  });
  toastEl.appendChild(dismissBtn);

  toastEl.dataset["toastId"] = String(id);
  container.appendChild(toastEl);

  // Auto-dismiss after 10 s (longer for invites)
  setTimeout(() => {
    toastEl.remove();
  }, 10000);
}

// ---------------------------------------------------------------------------
// Bootstrap
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  // Subscribe to real-time messages immediately so no events are missed.
  client.onMessage(onInboundMessage);
  client.onSession(onInboundSession);

  // Show initial loading skeleton
  const root = el("app-root");
  root.innerHTML = `<p class="loading-msg" aria-live="polite">Loading…</p>`;

  try {
    const [ctx, peers, _store] = await Promise.all([
      client.context(),
      client.peers(),
      loadAllGames(),
    ]);
    ui.selfUserId = ctx.selfUserId;
    ui.peers = peers;

    render();
  } catch (err) {
    console.error("Chess: init failed", err);
    root.innerHTML = `<p class="error-msg">Failed to load — please refresh.</p>`;
  }
}

void main();
