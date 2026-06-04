/**
 * Self-contained chess engine.
 *
 * Implemented rules:
 *   - All piece movement (pawn, knight, bishop, rook, queen, king)
 *   - Captures
 *   - Turn alternation
 *   - Check detection (moves that leave own king in check are illegal)
 *   - Pawn promotion → always promotes to queen
 *   - Basic checkmate / stalemate detection (isGameOver / gameResult)
 *
 * Deliberately omitted (documented):
 *   - Castling (king-side / queen-side): not implemented. The king and rooks
 *     move normally as individual pieces.
 *   - En-passant: not implemented. Pawns can only capture diagonally onto an
 *     occupied square.
 *   - Draw by repetition / fifty-move rule: not implemented.
 *
 * The engine is pure (no DOM, no I/O) and fully serialisable so GameState can
 * be round-tripped through JSON and the Social Home store / federation layer.
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

/** A half-move (ply) in the game. */
export interface Move {
  from: number; // square index 0..63
  to: number;   // square index 0..63
  /** Set when the move is a pawn promotion; always "Q" in this engine. */
  promotion?: PieceType;
}

/** Fully serialisable game state. */
export interface GameState {
  board: Board;
  sideToMove: Color;
  /** Move history (half-moves). */
  history: Move[];
  /** Null while the game is ongoing; set by applyMove or detectResult. */
  result: GameResult | null;
}

export type GameResult = "white" | "black" | "draw";

// ---------------------------------------------------------------------------
// Initial position
// ---------------------------------------------------------------------------

const BACK_RANK: PieceType[] = ["R", "N", "B", "Q", "K", "B", "N", "R"];

/** Return a fresh starting GameState. */
export function initialState(): GameState {
  const board: Board = new Array(64).fill(null);

  // Black back rank (row 0)
  for (let col = 0; col < 8; col++) {
    board[col] = { type: BACK_RANK[col], color: "b" };
  }
  // Black pawns (row 1)
  for (let col = 0; col < 8; col++) {
    board[8 + col] = { type: "P", color: "b" };
  }
  // White pawns (row 6)
  for (let col = 0; col < 8; col++) {
    board[48 + col] = { type: "P", color: "w" };
  }
  // White back rank (row 7)
  for (let col = 0; col < 8; col++) {
    board[56 + col] = { type: BACK_RANK[col], color: "w" };
  }

  return { board, sideToMove: "w", history: [], result: null };
}

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

function opponent(color: Color): Color {
  return color === "w" ? "b" : "w";
}

// ---------------------------------------------------------------------------
// Raw move generation (ignoring check)
// ---------------------------------------------------------------------------

/**
 * Generate all squares a piece on `from` can move to, without checking
 * whether the move leaves the moving side in check.
 */
function rawTargets(board: Board, from: number): number[] {
  const piece = board[from];
  if (piece === null) return [];

  const r = rowOf(from);
  const c = colOf(from);
  const color = piece.color;
  const targets: number[] = [];

  function push(row: number, col: number): boolean {
    if (!inBounds(row, col)) return false;
    const target = board[sq(row, col)];
    if (target !== null && target.color === color) return false; // blocked by own piece
    targets.push(sq(row, col));
    return target === null; // returns true iff square was empty (can continue sliding)
  }

  function slide(dr: number, dc: number): void {
    let row = r + dr;
    let col = c + dc;
    while (inBounds(row, col)) {
      const target = board[sq(row, col)];
      if (target !== null && target.color === color) break;
      targets.push(sq(row, col));
      if (target !== null) break; // capture: stop after
      row += dr;
      col += dc;
    }
  }

  switch (piece.type) {
    case "P": {
      const dir = color === "w" ? -1 : 1; // white moves up (decreasing row), black down
      const startRow = color === "w" ? 6 : 1;

      // Forward one square
      const oneAhead = r + dir;
      if (inBounds(oneAhead, c) && board[sq(oneAhead, c)] === null) {
        targets.push(sq(oneAhead, c));
        // Forward two squares from starting rank
        const twoAhead = r + dir * 2;
        if (r === startRow && board[sq(twoAhead, c)] === null) {
          targets.push(sq(twoAhead, c));
        }
      }

      // Diagonal captures
      for (const dc of [-1, 1]) {
        const tr = r + dir;
        const tc = c + dc;
        if (inBounds(tr, tc)) {
          const target = board[sq(tr, tc)];
          if (target !== null && target.color !== color) {
            targets.push(sq(tr, tc));
          }
        }
      }
      break;
    }

    case "N": {
      const knightJumps = [
        [-2, -1], [-2, 1], [-1, -2], [-1, 2],
        [1, -2], [1, 2], [2, -1], [2, 1],
      ];
      for (const [dr, dc] of knightJumps) {
        push(r + dr, c + dc);
      }
      break;
    }

    case "B":
      slide(-1, -1); slide(-1, 1); slide(1, -1); slide(1, 1);
      break;

    case "R":
      slide(-1, 0); slide(1, 0); slide(0, -1); slide(0, 1);
      break;

    case "Q":
      slide(-1, -1); slide(-1, 1); slide(1, -1); slide(1, 1);
      slide(-1, 0); slide(1, 0); slide(0, -1); slide(0, 1);
      break;

    case "K": {
      const kingMoves = [
        [-1, -1], [-1, 0], [-1, 1],
        [0, -1],           [0, 1],
        [1, -1],  [1, 0],  [1, 1],
      ];
      for (const [dr, dc] of kingMoves) {
        push(r + dr, c + dc);
      }
      break;
    }
  }

  return targets;
}

// ---------------------------------------------------------------------------
// Check detection
// ---------------------------------------------------------------------------

/** Find the square of the king of the given color. Returns -1 if not found. */
function findKing(board: Board, color: Color): number {
  for (let i = 0; i < 64; i++) {
    const p = board[i];
    if (p !== null && p.type === "K" && p.color === color) return i;
  }
  return -1;
}

/**
 * Return true if the given color's king is currently in check on the board.
 */
export function isInCheck(board: Board, color: Color): boolean {
  const kingSquare = findKing(board, color);
  if (kingSquare === -1) return true; // no king = treated as in check

  // Check if any opponent piece can capture the king
  const opp = opponent(color);
  for (let from = 0; from < 64; from++) {
    const p = board[from];
    if (p === null || p.color !== opp) continue;
    if (rawTargets(board, from).includes(kingSquare)) return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Apply a move to a board (returns a new board)
// ---------------------------------------------------------------------------

/**
 * Apply a move to a board, returning the resulting board.
 * Does NOT validate legality — use legalMoves for that.
 * Handles pawn promotion (to queen).
 */
function applyMoveToBoard(board: Board, move: Move): Board {
  const next = board.slice();
  const piece = next[move.from]!;

  // Move piece
  next[move.to] = piece;
  next[move.from] = null;

  // Pawn promotion
  const promotionRow = piece.color === "w" ? 0 : 7;
  if (piece.type === "P" && rowOf(move.to) === promotionRow) {
    next[move.to] = { type: move.promotion ?? "Q", color: piece.color };
  }

  return next;
}

// ---------------------------------------------------------------------------
// Legal move generation (respects check)
// ---------------------------------------------------------------------------

/**
 * Return all legal moves for the piece on `from` in the given state.
 * A move is legal if it doesn't leave the moving side's own king in check.
 */
export function legalMoves(state: GameState, from: number): Move[] {
  const piece = state.board[from];
  if (piece === null || piece.color !== state.sideToMove) return [];
  if (state.result !== null) return []; // game over

  const rawTos = rawTargets(state.board, from);
  const legal: Move[] = [];

  for (const to of rawTos) {
    // Pawn promotion: expand into separate moves (only queen in this engine)
    const isPromotion =
      piece.type === "P" &&
      ((piece.color === "w" && rowOf(to) === 0) ||
        (piece.color === "b" && rowOf(to) === 7));

    const promotions: (PieceType | undefined)[] = isPromotion
      ? ["Q"] // expand here if you want more promotion choices later
      : [undefined];

    for (const promotion of promotions) {
      const move: Move = promotion !== undefined ? { from, to, promotion } : { from, to };
      const nextBoard = applyMoveToBoard(state.board, move);
      if (!isInCheck(nextBoard, piece.color)) {
        legal.push(move);
      }
    }
  }

  return legal;
}

/**
 * Return all legal moves for the current side to move.
 */
export function allLegalMoves(state: GameState): Move[] {
  if (state.result !== null) return [];
  const moves: Move[] = [];
  for (let i = 0; i < 64; i++) {
    const p = state.board[i];
    if (p !== null && p.color === state.sideToMove) {
      moves.push(...legalMoves(state, i));
    }
  }
  return moves;
}

// ---------------------------------------------------------------------------
// Apply a full move (returns new GameState or throws)
// ---------------------------------------------------------------------------

/**
 * Apply a move to the state, returning the new state.
 * Throws if the move is not legal.
 */
export function applyMove(state: GameState, move: Move): GameState {
  if (state.result !== null) {
    throw new Error("Game is already over");
  }

  const legal = legalMoves(state, move.from);
  const isLegal = legal.some(
    (m) => m.to === move.to && m.promotion === move.promotion
  );
  if (!isLegal) {
    throw new Error(
      `Illegal move: ${squareName(move.from)} → ${squareName(move.to)}`
    );
  }

  const nextBoard = applyMoveToBoard(state.board, move);
  const nextSide = opponent(state.sideToMove);
  const nextHistory = [...state.history, move];

  const nextState: GameState = {
    board: nextBoard,
    sideToMove: nextSide,
    history: nextHistory,
    result: null,
  };

  // Detect end-of-game
  nextState.result = detectResult(nextState);

  return nextState;
}

// ---------------------------------------------------------------------------
// Game-over detection
// ---------------------------------------------------------------------------

/**
 * Detect the game result for the current state (called after every move).
 * Returns null if the game is still ongoing.
 */
export function detectResult(state: GameState): GameResult | null {
  const moves = allLegalMoves(state);
  if (moves.length > 0) return null; // game ongoing

  // No legal moves: checkmate or stalemate
  if (isInCheck(state.board, state.sideToMove)) {
    // Current side is in checkmate — the other side wins
    return state.sideToMove === "w" ? "black" : "white";
  }
  return "draw"; // stalemate
}

/** Return true if the game is over. */
export function isGameOver(state: GameState): boolean {
  return state.result !== null;
}

// ---------------------------------------------------------------------------
// UX helpers (pure)
// ---------------------------------------------------------------------------

/** The most recent half-move, or null at the start. */
export function lastMove(state: GameState): Move | null {
  return state.history.length ? state.history[state.history.length - 1] : null;
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
