import { BOARD_W, BOARD_H } from "./constants.js";
import { Piece, Seat, PIECE_POINTS } from "./pieces.js";
import { Coord, chebyshev, computeMoveFee } from "./fees.js";

export type Cell = { piece: Piece; seat: Seat | null };

export type BoardState = {
  cells: Cell[][]; // [y][x]
  turn: Seat;
  eliminated: boolean[]; // per seat
  ply: number;
};

export function emptyBoard(): BoardState {
  const cells: Cell[][] = [];
  for (let y = 0; y < BOARD_H; y++) {
    const row: Cell[] = [];
    for (let x = 0; x < BOARD_W; x++) {
      row.push({ piece: Piece.Empty, seat: null });
    }
    cells.push(row);
  }
  return { cells, turn: 0, eliminated: [false, false, false], ply: 0 };
}

function put(b: BoardState, x: number, y: number, piece: Piece, seat: Seat) {
  b.cells[y][x] = { piece, seat };
}

/**
 * Simplified 3-camp layout on 11×11:
 * Seat 0 (红) bottom, Seat 1 (蓝) top-leftish, Seat 2 (绿) top-rightish.
 * Each camp: 1帅 1士 1象 1马 1车 1炮 3卒 — playable, not encyclopedia.
 */
export function initialBoard(): BoardState {
  const b = emptyBoard();

  // Seat 0 — bottom (y=10 palace area)
  put(b, 5, 10, Piece.General, 0);
  put(b, 4, 10, Piece.Advisor, 0);
  put(b, 6, 10, Piece.Elephant, 0);
  put(b, 3, 10, Piece.Horse, 0);
  put(b, 7, 10, Piece.Chariot, 0);
  put(b, 5, 8, Piece.Cannon, 0);
  put(b, 3, 7, Piece.Soldier, 0);
  put(b, 5, 7, Piece.Soldier, 0);
  put(b, 7, 7, Piece.Soldier, 0);

  // Seat 1 — top-left
  put(b, 0, 0, Piece.General, 1);
  put(b, 1, 0, Piece.Advisor, 1);
  put(b, 0, 1, Piece.Elephant, 1);
  put(b, 2, 0, Piece.Horse, 1);
  put(b, 0, 2, Piece.Chariot, 1);
  put(b, 2, 2, Piece.Cannon, 1);
  put(b, 3, 1, Piece.Soldier, 1);
  put(b, 3, 3, Piece.Soldier, 1);
  put(b, 1, 3, Piece.Soldier, 1);

  // Seat 2 — top-right
  put(b, 10, 0, Piece.General, 2);
  put(b, 9, 0, Piece.Advisor, 2);
  put(b, 10, 1, Piece.Elephant, 2);
  // Closer to seat 0's advisor so a real betrayal capture is a few legal moves away.
  put(b, 6, 9, Piece.Horse, 2);
  put(b, 10, 2, Piece.Chariot, 2);
  put(b, 8, 2, Piece.Cannon, 2);
  put(b, 7, 1, Piece.Soldier, 2);
  put(b, 7, 3, Piece.Soldier, 2);
  put(b, 9, 3, Piece.Soldier, 2);

  return b;
}

export function inBounds(x: number, y: number): boolean {
  return x >= 0 && x < BOARD_W && y >= 0 && y < BOARD_H;
}

function at(b: BoardState, x: number, y: number): Cell {
  return b.cells[y][x];
}

function clearPath(b: BoardState, from: Coord, to: Coord): boolean {
  const dx = Math.sign(to.x - from.x);
  const dy = Math.sign(to.y - from.y);
  let x = from.x + dx;
  let y = from.y + dy;
  while (x !== to.x || y !== to.y) {
    if (at(b, x, y).piece !== Piece.Empty) return false;
    x += dx;
    y += dy;
  }
  return true;
}

function countBetween(b: BoardState, from: Coord, to: Coord): number {
  const dx = Math.sign(to.x - from.x);
  const dy = Math.sign(to.y - from.y);
  let x = from.x + dx;
  let y = from.y + dy;
  let n = 0;
  while (x !== to.x || y !== to.y) {
    if (at(b, x, y).piece !== Piece.Empty) n++;
    x += dx;
    y += dy;
  }
  return n;
}

/** Simplified move legality inspired by Xiangqi */
export function isLegalMove(b: BoardState, seat: Seat, from: Coord, to: Coord): boolean {
  if (!inBounds(from.x, from.y) || !inBounds(to.x, to.y)) return false;
  if (from.x === to.x && from.y === to.y) return false;
  const src = at(b, from.x, from.y);
  if (src.piece === Piece.Empty || src.seat !== seat) return false;
  const dst = at(b, to.x, to.y);
  if (dst.seat === seat) return false;

  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const adx = Math.abs(dx);
  const ady = Math.abs(dy);

  switch (src.piece) {
    case Piece.General:
      // Orthogonal 1 step, stay near own palace loosely (any cell within chebyshev 3 of start for MVP)
      if (!((adx === 1 && ady === 0) || (adx === 0 && ady === 1))) return false;
      return true;
    case Piece.Advisor:
      if (!(adx === 1 && ady === 1)) return false;
      return true;
    case Piece.Elephant:
      if (!(adx === 2 && ady === 2)) return false;
      // cannot jump eye
      return at(b, from.x + dx / 2, from.y + dy / 2).piece === Piece.Empty;
    case Piece.Horse: {
      if (!((adx === 2 && ady === 1) || (adx === 1 && ady === 2))) return false;
      const hx = adx === 2 ? from.x + Math.sign(dx) : from.x;
      const hy = ady === 2 ? from.y + Math.sign(dy) : from.y;
      return at(b, hx, hy).piece === Piece.Empty;
    }
    case Piece.Chariot:
      if (!(dx === 0 || dy === 0)) return false;
      return clearPath(b, from, to);
    case Piece.Cannon:
      if (!(dx === 0 || dy === 0)) return false;
      if (dst.piece === Piece.Empty) return clearPath(b, from, to);
      return countBetween(b, from, to) === 1;
    case Piece.Soldier:
      // one step orthogonal (forward preference relaxed for 3-player)
      if (!((adx === 1 && ady === 0) || (adx === 0 && ady === 1))) return false;
      return true;
    default:
      return false;
  }
}

export type LegalMove = { from: Coord; to: Coord; fee: bigint; capture: Piece };

export function legalMoves(b: BoardState, seat: Seat): LegalMove[] {
  const out: LegalMove[] = [];
  if (b.eliminated[seat]) return out;
  for (let y = 0; y < BOARD_H; y++) {
    for (let x = 0; x < BOARD_W; x++) {
      const c = at(b, x, y);
      if (c.seat !== seat || c.piece === Piece.Empty) continue;
      for (let ty = 0; ty < BOARD_H; ty++) {
        for (let tx = 0; tx < BOARD_W; tx++) {
          const from = { x, y };
          const to = { x: tx, y: ty };
          if (!isLegalMove(b, seat, from, to)) continue;
          const capture = at(b, tx, ty).piece;
          out.push({
            from,
            to,
            fee: computeMoveFee(c.piece, from, to),
            capture,
          });
        }
      }
    }
  }
  return out;
}

export function minAffordableLegalMoveFee(b: BoardState, seat: Seat): bigint | null {
  const moves = legalMoves(b, seat);
  if (moves.length === 0) return null;
  let min = moves[0].fee;
  for (const m of moves) if (m.fee < min) min = m.fee;
  return min;
}

export type ApplyResult = {
  board: BoardState;
  captured: Piece;
  capturedSeat: Seat | null;
  defeated: Seat | null;
};

export function applyMove(b: BoardState, seat: Seat, from: Coord, to: Coord): ApplyResult {
  if (!isLegalMove(b, seat, from, to)) throw new Error("非法走子");
  const next: BoardState = {
    cells: b.cells.map((row) => row.map((c) => ({ ...c }))),
    turn: b.turn,
    eliminated: [...b.eliminated],
    ply: b.ply + 1,
  };
  const src = next.cells[from.y][from.x];
  const dst = next.cells[to.y][to.x];
  const captured = dst.piece;
  const capturedSeat = dst.seat;
  let defeated: Seat | null = null;
  if (captured === Piece.General && capturedSeat !== null) {
    defeated = capturedSeat;
    next.eliminated[capturedSeat] = true;
  }
  next.cells[to.y][to.x] = { piece: src.piece, seat };
  next.cells[from.y][from.x] = { piece: Piece.Empty, seat: null };

  // advance turn to next non-eliminated
  let t = ((seat + 1) % 3) as Seat;
  for (let i = 0; i < 3; i++) {
    if (!next.eliminated[t]) break;
    t = ((t + 1) % 3) as Seat;
  }
  next.turn = t;
  return { board: next, captured, capturedSeat, defeated };
}

export function aliveSeats(b: BoardState): Seat[] {
  return ([0, 1, 2] as Seat[]).filter((s) => !b.eliminated[s]);
}

export function winner(b: BoardState): Seat | null {
  const a = aliveSeats(b);
  return a.length === 1 ? a[0] : null;
}

export function materialScore(b: BoardState, seat: Seat): number {
  let s = 0;
  for (let y = 0; y < BOARD_H; y++) {
    for (let x = 0; x < BOARD_W; x++) {
      const c = at(b, x, y);
      if (c.seat === seat) s += PIECE_POINTS[c.piece];
    }
  }
  return s;
}

export { chebyshev };
