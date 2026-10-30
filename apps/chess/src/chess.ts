/**
 * Self-contained chess engine — the full rules of chess.
 *
 *   - All piece movement, captures and turn alternation
 *   - Check: a move may never leave the mover's own king attacked
 *   - Castling (both sides): king and rook unmoved, the squares between them
 *     empty, and the king not in check, not passing through an attacked
 *     square and not landing on one. Played as the king's two-square move
 *     (e1→g1), as in UCI.
 *   - En passant, on the move right after the two-square pawn push only
 *   - Promotion to a queen, rook, bishop or knight (the mover chooses)
 *   - Endings: checkmate, stalemate, threefold repetition, the 50-move rule
 *     and insufficient material end the game at once (no claim needed in a
 *     correspondence game); a draw by agreement and resignation are entries
 *     in the history ("actions", below) so the latest message of a game
 *     carries the whole story.
 *
 * Actions (`{action, by}` entries in `history`) never move a piece:
 *   - `offer-draw` / `accept-draw` / `decline-draw` only on your own turn
 *     (an offer stands while you then make your move; your opponent accepts
 *     or declines on their turn, and a move of theirs declines it), so two
 *     households never both add something at the same time.
 *   - `resign` at any time while the game runs.
 *
 * The engine is pure (no DOM, no I/O). The whole state follows from
 * `history`: `replayHistory` rebuilds it, and that is what both households
 * do with every message (inbound.ts), so the same rules judge both sides.
 */

// ---------------------------------------------------------------------------
// Types & constants
// ---------------------------------------------------------------------------

export type Color = "w" | "b";

export type PieceType = "P" | "N" | "B" | "R" | "Q" | "K";

/** A piece on the board: type + color. */
export interface Piece {
  type: PieceType;
  color: Color;
}

/**
 * An 8×8 board represented as a flat array of 64 squares (row-major,
 * a8=index 0, h1=index 63). Each element is a Piece or null.
 *
 * Index formula: row * 8 + col where row 0 = rank 8 (Black's back rank)
 * and row 7 = rank 1 (White's back rank). col 0 = file a, col 7 = file h.
 */
export type Board = (Piece | null)[];

/** A move on the board. Castling is the king's two-square move. */
export interface Move {
  from: number; // square index 0..63
  to: number;   // square index 0..63
  /** The piece a pawn becomes on the last rank (required there). */
  promotion?: PieceType;
}

/** A step that moves no piece: a draw offer and its answer, or resigning. */
export type GameAction = "offer-draw" | "accept-draw" | "decline-draw" | "resign";

export const GAME_ACTIONS: readonly GameAction[] = ["offer-draw", "accept-draw", "decline-draw", "resign"];

export interface ActionPly {
  action: GameAction;
  /** Who took the step. */
  by: Color;
}

/** One entry of a game's history: a move on the board or an action. */
export type Ply = Move | ActionPly;

export type GameResult = "white" | "black" | "draw";

/** How a game ended. */
export type Ending =
  | "checkmate"
  | "stalemate"
  | "repetition"
  | "fifty-moves"
  | "insufficient"
  | "agreement"
  | "resign";

/** Castling still allowed: K/Q = White king/queen side, k/q = Black's. */
export interface CastlingRights {
  K: boolean;
  Q: boolean;
  k: boolean;
  q: boolean;
}

/** Fully serialisable game state (everything follows from `history`). */
export interface GameState {
  board: Board;
  sideToMove: Color;
  /** Every move and action so far, oldest first. */
  history: Ply[];
  /** Null while the game is ongoing. */
  result: GameResult | null;
  /** Why the game ended; null while it runs. */
  ending: Ending | null;
  castling: CastlingRights;
  /** The square a pawn skipped with its two-square move just now, else null. */
  epSquare: number | null;
  /** Half-moves since the last capture or pawn move (the 50-move rule). */
  halfmoveClock: number;
  /** Position keys since the last capture or pawn move, current last. */
  positions: string[];
  /** Who offered a draw that is still open, else null. */
  drawOffer: Color | null;
}

export const PROMOTION_PIECES: readonly PieceType[] = ["Q", "R", "B", "N"];

// ---------------------------------------------------------------------------
// Coordinate helpers
// ---------------------------------------------------------------------------

export function rowOf(sq: number): number {
  return Math.floor(sq / 8);
}

export function colOf(sq: number): number {
  return sq % 8;
}

export function sq(row: number, col: number): number {
  return row * 8 + col;
}

function inBounds(row: number, col: number): boolean {
  return row >= 0 && row < 8 && col >= 0 && col < 8;
}

export function opponent(color: Color): Color {
  return color === "w" ? "b" : "w";
}

/** True for a board move, false for an action. */
export function isBoardMove(p: Ply): p is Move {
  return (p as Move).from !== undefined;
}

// Corner and king squares used by castling.
const A8 = 0, E8 = 4, H8 = 7, A1 = 56, E1 = 60, H1 = 63;

// ---------------------------------------------------------------------------
// Initial position & FEN
// ---------------------------------------------------------------------------

const BACK_RANK: PieceType[] = ["R", "N", "B", "Q", "K", "B", "N", "R"];

function freshState(
  board: Board,
  sideToMove: Color,
  castling: CastlingRights,
  epSquare: number | null,
  halfmoveClock: number,
): GameState {
  const state: GameState = {
    board,
    sideToMove,
    history: [],
    result: null,
    ending: null,
    castling,
    epSquare,
    halfmoveClock,
    positions: [],
    drawOffer: null,
  };
  state.positions = [positionKey(state)];
  return state;
}

/** Return a fresh starting GameState. */
export function initialState(): GameState {
  const board: Board = new Array(64).fill(null);
  for (let col = 0; col < 8; col++) {
    board[col] = { type: BACK_RANK[col], color: "b" };
    board[8 + col] = { type: "P", color: "b" };
    board[48 + col] = { type: "P", color: "w" };
    board[56 + col] = { type: BACK_RANK[col], color: "w" };
  }
  return freshState(board, "w", { K: true, Q: true, k: true, q: true }, null, 0);
}

/** A position from a bare board (no castling, no en passant) — tests and tools. */
export function positionOf(board: Board, sideToMove: Color = "w"): GameState {
  return freshState(board, sideToMove, { K: false, Q: false, k: false, q: false }, null, 0);
}

/**
 * A state from a FEN string (tests and analysis). Throws on a malformed FEN.
 * Its `history` is empty: a real game always starts from `initialState()`.
 */
export function fromFen(fen: string): GameState {
  const [placement, side, castle = "-", ep = "-", half = "0"] = fen.trim().split(/\s+/);
  const rows = placement?.split("/") ?? [];
  if (rows.length !== 8) throw new Error("Bad FEN");
  const board: Board = new Array(64).fill(null);
  rows.forEach((rowText, row) => {
    let col = 0;
    for (const ch of rowText) {
      if (/[1-8]/.test(ch)) {
        col += Number(ch);
      } else {
        const type = ch.toUpperCase() as PieceType;
        if (!"PNBRQK".includes(type) || col > 7) throw new Error("Bad FEN");
        board[sq(row, col)] = { type, color: ch === type ? "w" : "b" };
        col++;
      }
    }
    if (col !== 8) throw new Error("Bad FEN");
  });
  if (side !== "w" && side !== "b") throw new Error("Bad FEN");
  const castling = {
    K: castle.includes("K"), Q: castle.includes("Q"), k: castle.includes("k"), q: castle.includes("q"),
  };
  const epSquare = ep === "-" ? -1 : parseSquare(ep);
  return freshState(board, side, castling, epSquare === -1 ? null : epSquare, Number(half) || 0);
}

/** The FEN of a state (fullmove number counted from its board moves). */
export function toFen(state: GameState): string {
  const rows: string[] = [];
  for (let r = 0; r < 8; r++) {
    let text = "";
    let empty = 0;
    for (let c = 0; c < 8; c++) {
      const p = state.board[sq(r, c)];
      if (!p) { empty++; continue; }
      if (empty) { text += empty; empty = 0; }
      text += p.color === "w" ? p.type : p.type.toLowerCase();
    }
    if (empty) text += empty;
    rows.push(text);
  }
  const fullmove = Math.floor(state.history.filter(isBoardMove).length / 2) + 1;
  const ep = state.epSquare === null ? "-" : squareName(state.epSquare);
  return `${rows.join("/")} ${state.sideToMove} ${castlingText(state.castling)} ${ep} ${state.halfmoveClock} ${fullmove}`;
}

function castlingText(c: CastlingRights): string {
  const s = `${c.K ? "K" : ""}${c.Q ? "Q" : ""}${c.k ? "k" : ""}${c.q ? "q" : ""}`;
  return s || "-";
}

/**
 * What makes two positions "the same" for repetition: the pieces, the side
 * to move, castling rights, and an en passant square only when a capture
 * there is actually possible.
 */
function positionKey(state: GameState): string {
  let key = "";
  for (const p of state.board) key += p ? (p.color === "w" ? p.type : p.type.toLowerCase()) : ".";
  const ep = state.epSquare;
  const epLive =
    ep !== null && generateLegal(state).some((m) => m.to === ep && state.board[m.from]?.type === "P");
  return `${key} ${state.sideToMove} ${castlingText(state.castling)} ${epLive ? ep : "-"}`;
}

// ---------------------------------------------------------------------------
// Attacks & check
// ---------------------------------------------------------------------------

const KNIGHT_JUMPS = [[-2, -1], [-2, 1], [-1, -2], [-1, 2], [1, -2], [1, 2], [2, -1], [2, 1]];
const KING_STEPS = [[-1, -1], [-1, 0], [-1, 1], [0, -1], [0, 1], [1, -1], [1, 0], [1, 1]];
const DIAGONALS = [[-1, -1], [-1, 1], [1, -1], [1, 1]];
const LINES = [[-1, 0], [1, 0], [0, -1], [0, 1]];

/** True when a piece of colour `by` attacks `square`. */
export function isSquareAttacked(board: Board, square: number, by: Color): boolean {
  const r = rowOf(square);
  const c = colOf(square);
  const at = (row: number, col: number): Piece | null => (inBounds(row, col) ? board[sq(row, col)] : null);
  const is = (p: Piece | null, types: string): boolean => p !== null && p.color === by && types.includes(p.type);

  // A white pawn attacks upwards, so it stands on the row below the square.
  const pawnRow = by === "w" ? r + 1 : r - 1;
  if (is(at(pawnRow, c - 1), "P") || is(at(pawnRow, c + 1), "P")) return true;
  for (const [dr, dc] of KNIGHT_JUMPS) if (is(at(r + dr, c + dc), "N")) return true;
  for (const [dr, dc] of KING_STEPS) if (is(at(r + dr, c + dc), "K")) return true;
  const ray = (dirs: number[][], types: string): boolean => {
    for (const [dr, dc] of dirs) {
      let row = r + dr;
      let col = c + dc;
      while (inBounds(row, col)) {
        const p = board[sq(row, col)];
        if (p) {
          if (is(p, types)) return true;
          break;
        }
        row += dr;
        col += dc;
      }
    }
    return false;
  };
  return ray(DIAGONALS, "BQ") || ray(LINES, "RQ");
}

/** Find the square of the king of the given color. Returns -1 if not found. */
export function findKing(board: Board, color: Color): number {
  for (let i = 0; i < 64; i++) {
    const p = board[i];
    if (p !== null && p.type === "K" && p.color === color) return i;
  }
  return -1;
}

/** Return true if the given color's king is attacked (no king counts as check). */
export function isInCheck(board: Board, color: Color): boolean {
  const king = findKing(board, color);
  if (king === -1) return true;
  return isSquareAttacked(board, king, opponent(color));
}

// ---------------------------------------------------------------------------
// Move generation
// ---------------------------------------------------------------------------

/** Pseudo-legal moves for the side to move (may leave its king in check). */
function pseudoMoves(state: GameState, onlyFrom?: number): Move[] {
  const { board } = state;
  const color = state.sideToMove;
  const moves: Move[] = [];
  const lastRow = color === "w" ? 0 : 7;

  const addPawn = (from: number, to: number): void => {
    if (rowOf(to) === lastRow) {
      for (const promotion of PROMOTION_PIECES) moves.push({ from, to, promotion });
    } else {
      moves.push({ from, to });
    }
  };

  for (let from = 0; from < 64; from++) {
    if (onlyFrom !== undefined && from !== onlyFrom) continue;
    const piece = board[from];
    if (!piece || piece.color !== color) continue;
    const r = rowOf(from);
    const c = colOf(from);

    const step = (row: number, col: number): void => {
      if (!inBounds(row, col)) return;
      const target = board[sq(row, col)];
      if (target && target.color === color) return;
      moves.push({ from, to: sq(row, col) });
    };
    const slide = (dirs: number[][]): void => {
      for (const [dr, dc] of dirs) {
        let row = r + dr;
        let col = c + dc;
        while (inBounds(row, col)) {
          const target = board[sq(row, col)];
          if (target && target.color === color) break;
          moves.push({ from, to: sq(row, col) });
          if (target) break;
          row += dr;
          col += dc;
        }
      }
    };

    switch (piece.type) {
      case "P": {
        const dir = color === "w" ? -1 : 1;
        const startRow = color === "w" ? 6 : 1;
        if (inBounds(r + dir, c) && !board[sq(r + dir, c)]) {
          addPawn(from, sq(r + dir, c));
          if (r === startRow && !board[sq(r + 2 * dir, c)]) moves.push({ from, to: sq(r + 2 * dir, c) });
        }
        for (const dc of [-1, 1]) {
          if (!inBounds(r + dir, c + dc)) continue;
          const to = sq(r + dir, c + dc);
          const target = board[to];
          if ((target && target.color !== color) || to === state.epSquare) addPawn(from, to);
        }
        break;
      }
      case "N":
        for (const [dr, dc] of KNIGHT_JUMPS) step(r + dr, c + dc);
        break;
      case "B":
        slide(DIAGONALS);
        break;
      case "R":
        slide(LINES);
        break;
      case "Q":
        slide(DIAGONALS);
        slide(LINES);
        break;
      case "K": {
        for (const [dr, dc] of KING_STEPS) step(r + dr, c + dc);
        // Castling: rights kept, path empty, king not in, through or into check.
        const home = color === "w" ? E1 : E8;
        if (from !== home) break;
        const them = opponent(color);
        const kingSide = color === "w" ? state.castling.K : state.castling.k;
        const queenSide = color === "w" ? state.castling.Q : state.castling.q;
        const rook = (s: number): boolean => board[s]?.type === "R" && board[s]?.color === color;
        if ((kingSide || queenSide) && !isSquareAttacked(board, home, them)) {
          if (
            kingSide && rook(home + 3) && !board[home + 1] && !board[home + 2] &&
            !isSquareAttacked(board, home + 1, them) && !isSquareAttacked(board, home + 2, them)
          ) {
            moves.push({ from, to: home + 2 });
          }
          if (
            queenSide && rook(home - 4) && !board[home - 1] && !board[home - 2] && !board[home - 3] &&
            !isSquareAttacked(board, home - 1, them) && !isSquareAttacked(board, home - 2, them)
          ) {
            moves.push({ from, to: home - 2 });
          }
        }
        break;
      }
    }
  }
  return moves;
}

/** True when `move` is a castling move on this board (the king's two-square step). */
export function isCastling(board: Board, move: Move): boolean {
  return board[move.from]?.type === "K" && Math.abs(colOf(move.to) - colOf(move.from)) === 2;
}

/** True when `move` is an en passant capture in this position. */
export function isEnPassant(state: GameState, move: Move): boolean {
  return (
    state.board[move.from]?.type === "P" &&
    move.to === state.epSquare &&
    colOf(move.to) !== colOf(move.from)
  );
}

/** The board after `move` (castling's rook and en passant's pawn included). */
function moveOnBoard(state: GameState, move: Move): Board {
  const next = state.board.slice();
  const piece = next[move.from]!;
  if (isEnPassant(state, move)) {
    next[sq(rowOf(move.from), colOf(move.to))] = null;
  }
  if (isCastling(state.board, move)) {
    const kingSide = colOf(move.to) > colOf(move.from);
    const rookFrom = kingSide ? move.from + 3 : move.from - 4;
    const rookTo = kingSide ? move.from + 1 : move.from - 1;
    next[rookTo] = next[rookFrom];
    next[rookFrom] = null;
  }
  next[move.to] = move.promotion && piece.type === "P" ? { type: move.promotion, color: piece.color } : piece;
  next[move.from] = null;
  return next;
}

/** All legal moves for the side to move (whether or not the game is over). */
function generateLegal(state: GameState, onlyFrom?: number): Move[] {
  const color = state.sideToMove;
  return pseudoMoves(state, onlyFrom).filter((m) => !isInCheck(moveOnBoard(state, m), color));
}

/**
 * All legal moves for the piece on `from` (none when it isn't the side to
 * move's or the game is over). A promotion appears once per piece choice.
 */
export function legalMoves(state: GameState, from: number): Move[] {
  const piece = state.board[from];
  if (!piece || piece.color !== state.sideToMove) return [];
  if (state.result !== null) return [];
  return generateLegal(state, from);
}

/** All legal moves for the side to move. */
export function allLegalMoves(state: GameState): Move[] {
  if (state.result !== null) return [];
  return generateLegal(state);
}

/** True when `from`→`to` is a pawn move that needs a promotion choice. */
export function needsPromotion(state: GameState, from: number, to: number): boolean {
  const piece = state.board[from];
  return piece?.type === "P" && rowOf(to) === (piece.color === "w" ? 0 : 7);
}

// ---------------------------------------------------------------------------
// Making moves
// ---------------------------------------------------------------------------

/** The position after a legal board move, before the ending is worked out. */
function makeMove(state: GameState, move: Move): GameState {
  const { board } = state;
  const piece = board[move.from]!;
  const captured = board[move.to] !== null || isEnPassant(state, move);

  const castling = { ...state.castling };
  if (piece.type === "K") {
    if (piece.color === "w") { castling.K = false; castling.Q = false; } else { castling.k = false; castling.q = false; }
  }
  for (const s of [move.from, move.to]) {
    if (s === H1) castling.K = false;
    if (s === A1) castling.Q = false;
    if (s === H8) castling.k = false;
    if (s === A8) castling.q = false;
  }

  const twoStep = piece.type === "P" && Math.abs(rowOf(move.to) - rowOf(move.from)) === 2;
  const irreversible = piece.type === "P" || captured;

  const next: GameState = {
    board: moveOnBoard(state, move),
    sideToMove: opponent(state.sideToMove),
    history: [...state.history, move],
    result: null,
    ending: null,
    castling,
    epSquare: twoStep ? (move.from + move.to) / 2 : null,
    halfmoveClock: irreversible ? 0 : state.halfmoveClock + 1,
    positions: [],
    // The mover's own offer stands; a move answers the opponent's (declines it).
    drawOffer: state.drawOffer === piece.color ? state.drawOffer : null,
  };
  next.positions = [...(irreversible ? [] : state.positions), positionKey(next)];
  return next;
}

/**
 * Apply a board move, returning the new state (with the ending worked out).
 * Throws if the move is not legal — a promotion must name its piece.
 */
export function applyMove(state: GameState, move: Move): GameState {
  if (state.result !== null) {
    throw new Error("Game is already over");
  }
  const legal = legalMoves(state, move.from).some(
    (m) => m.to === move.to && (m.promotion ?? null) === (move.promotion ?? null),
  );
  if (!legal) {
    throw new Error(`Illegal move: ${squareName(move.from)} → ${squareName(move.to)}`);
  }
  const clean: Move = move.promotion
    ? { from: move.from, to: move.to, promotion: move.promotion }
    : { from: move.from, to: move.to };
  const next = makeMove(state, clean);
  const ending = detectEnding(next);
  if (ending) {
    next.ending = ending;
    next.result = ending === "checkmate" ? (next.sideToMove === "w" ? "black" : "white") : "draw";
    next.drawOffer = null;
  }
  return next;
}

/** Whether `by` may take `action` now (see the header for the rules). */
export function canTakeAction(state: GameState, action: GameAction, by: Color): boolean {
  if (state.result !== null) return false;
  switch (action) {
    case "resign":
      return true;
    case "offer-draw":
      return state.sideToMove === by && state.drawOffer === null;
    case "accept-draw":
    case "decline-draw":
      return state.sideToMove === by && state.drawOffer === opponent(by);
  }
}

/** Apply an action, returning the new state. Throws if it isn't allowed. */
export function applyAction(state: GameState, ply: ActionPly): GameState {
  if (!canTakeAction(state, ply.action, ply.by)) {
    throw new Error(`Not allowed: ${ply.action}`);
  }
  const next: GameState = { ...state, history: [...state.history, { action: ply.action, by: ply.by }] };
  switch (ply.action) {
    case "resign":
      next.result = ply.by === "w" ? "black" : "white";
      next.ending = "resign";
      next.drawOffer = null;
      break;
    case "offer-draw":
      next.drawOffer = ply.by;
      break;
    case "accept-draw":
      next.result = "draw";
      next.ending = "agreement";
      next.drawOffer = null;
      break;
    case "decline-draw":
      next.drawOffer = null;
      break;
  }
  return next;
}

/** Apply any history entry. Throws if it isn't allowed. */
export function applyPly(state: GameState, ply: Ply): GameState {
  return isBoardMove(ply) ? applyMove(state, ply) : applyAction(state, ply);
}

/** Who makes `ply` when it is played on `state`. */
export function actorOf(state: GameState, ply: Ply): Color {
  return isBoardMove(ply) ? state.sideToMove : ply.by;
}

/** Play `history` from the start; `null` if any entry isn't allowed. */
export function replayHistory(history: readonly Ply[]): GameState | null {
  let state = initialState();
  for (const ply of history) {
    try {
      state = applyPly(state, ply);
    } catch {
      return null;
    }
  }
  return state;
}

// ---------------------------------------------------------------------------
// Game-over detection
// ---------------------------------------------------------------------------

/**
 * Nobody can ever mate: only kings, a king and one bishop or knight against
 * a bare king, or bishops (any number) that all stand on one square colour.
 */
export function isInsufficientMaterial(board: Board): boolean {
  const minors: { type: PieceType; square: number }[] = [];
  for (let i = 0; i < 64; i++) {
    const p = board[i];
    if (!p || p.type === "K") continue;
    if (p.type === "P" || p.type === "R" || p.type === "Q") return false;
    minors.push({ type: p.type, square: i });
  }
  if (minors.length <= 1) return true;
  if (minors.every((m) => m.type === "B")) {
    const shade = (s: number): number => (rowOf(s) + colOf(s)) % 2;
    return minors.every((m) => shade(m.square) === shade(minors[0].square));
  }
  return false;
}

/** How the game ends in this position, or null while it goes on. */
export function detectEnding(state: GameState): Ending | null {
  if (generateLegal(state).length === 0) {
    return isInCheck(state.board, state.sideToMove) ? "checkmate" : "stalemate";
  }
  if (isInsufficientMaterial(state.board)) return "insufficient";
  if (state.halfmoveClock >= 100) return "fifty-moves";
  const current = state.positions[state.positions.length - 1];
  if (state.positions.filter((k) => k === current).length >= 3) return "repetition";
  return null;
}

/** The result for the current position (null while the game goes on). */
export function detectResult(state: GameState): GameResult | null {
  const ending = detectEnding(state);
  if (!ending) return null;
  if (ending === "checkmate") return state.sideToMove === "w" ? "black" : "white";
  return "draw";
}

/** Return true if the game is over. */
export function isGameOver(state: GameState): boolean {
  return state.result !== null;
}

// ---------------------------------------------------------------------------
// Counting (move-generator test)
// ---------------------------------------------------------------------------

/** Leaf positions `depth` plies deep — the standard move-generator check. */
export function perft(state: GameState, depth: number): number {
  if (depth === 0) return 1;
  const moves = generateLegal(state);
  if (depth === 1) return moves.length;
  let total = 0;
  for (const m of moves) total += perft(makeMoveFast(state, m), depth - 1);
  return total;
}

/** `makeMove` without the repetition bookkeeping (perft only). */
function makeMoveFast(state: GameState, move: Move): GameState {
  const piece = state.board[move.from]!;
  const castling = { ...state.castling };
  if (piece.type === "K") {
    if (piece.color === "w") { castling.K = false; castling.Q = false; } else { castling.k = false; castling.q = false; }
  }
  for (const s of [move.from, move.to]) {
    if (s === H1) castling.K = false;
    if (s === A1) castling.Q = false;
    if (s === H8) castling.k = false;
    if (s === A8) castling.q = false;
  }
  const twoStep = piece.type === "P" && Math.abs(rowOf(move.to) - rowOf(move.from)) === 2;
  return {
    ...state,
    board: moveOnBoard(state, move),
    sideToMove: opponent(state.sideToMove),
    castling,
    epSquare: twoStep ? (move.from + move.to) / 2 : null,
  };
}

// ---------------------------------------------------------------------------
// UX helpers (pure)
// ---------------------------------------------------------------------------

/** The most recent board move, or null when there is none yet. */
export function lastMove(state: GameState): Move | null {
  for (let i = state.history.length - 1; i >= 0; i--) {
    const ply = state.history[i];
    if (isBoardMove(ply)) return ply;
  }
  return null;
}

/** The number of board moves (half-moves) played. */
export function boardMoveCount(state: GameState): number {
  return state.history.filter(isBoardMove).length;
}

/**
 * Whether the message `myColor` sends with this state hands the opponent the
 * turn — the `turn: true` flag on `federation.send`, so Social Home can show
 * them "Your turn with … in Chess" while their app is closed. True only after
 * our own board move left a running game with them to move. A draw offer or
 * a declined offer keeps the turn here (you still make your move after it),
 * resigning, an accepted draw or a move that ends the game pass nothing.
 * Computed from the state alone, so a retry of the same state keeps the flag.
 */
export function passesTurn(state: GameState, myColor: Color): boolean {
  if (state.result !== null || state.sideToMove !== opponent(myColor)) return false;
  const last = state.history[state.history.length - 1];
  // With the opponent to move, a board move last was ours.
  return last !== undefined && isBoardMove(last);
}

/** True when it's `myColor`'s turn and the game isn't over. */
export function isMyTurn(state: GameState, myColor: Color): boolean {
  return state.result === null && state.sideToMove === myColor;
}

// ---------------------------------------------------------------------------
// Notation helpers
// ---------------------------------------------------------------------------

/** Convert a square index to algebraic notation ("a8" = 0, "h1" = 63). */
export function squareName(index: number): string {
  const file = "abcdefgh"[colOf(index)];
  const rank = 8 - rowOf(index);
  return `${file}${rank}`;
}

/** Parse algebraic square name to index. Returns -1 on invalid input. */
export function parseSquare(name: string): number {
  if (name.length !== 2) return -1;
  const col = "abcdefgh".indexOf(name[0]);
  const rank = parseInt(name[1], 10);
  if (col === -1 || isNaN(rank) || rank < 1 || rank > 8) return -1;
  return sq(8 - rank, col);
}
