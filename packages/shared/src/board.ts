import { NODE_COUNT } from "./constants.js";
import { Piece, Seat, PIECE_POINTS } from "./pieces.js";
import { Coord, computeMoveFeeBySteps } from "./fees.js";
import { campNode, initialSanrenPieces } from "./sanrenSetup.js";
import {
  CITADEL,
  SANREN_GRAPH,
  bfsDist,
  horseLandingWithAdj,
  localFr,
  nodeCamp,
  type SanrenGraph,
} from "./sanrenGraph.js";
import { SANREN_MAP } from "./sanrenMap.js";

export type Cell = { piece: Piece; seat: Seat | null };

/** Node-graph board. `cells[nodeId]`. Coord.x = nodeId, Coord.y unused (0). */
export type BoardState = {
  cells: Cell[];
  turn: Seat;
  eliminated: boolean[];
  ply: number;
};

const G = SANREN_GRAPH;

export function emptyBoard(): BoardState {
  const cells: Cell[] = Array.from({ length: NODE_COUNT }, () => ({
    piece: Piece.Empty,
    seat: null,
  }));
  return { cells, turn: 0, eliminated: [false, false, false], ply: 0 };
}

export function initialBoard(): BoardState {
  const b = emptyBoard();
  for (const p of initialSanrenPieces()) {
    b.cells[p.node] = { piece: p.piece, seat: p.seat as Seat };
  }
  return b;
}

export function inBoundsNode(n: number): boolean {
  return n >= 0 && n < NODE_COUNT;
}

/** @deprecated use inBoundsNode — kept for callers that still pass x as node */
export function inBounds(x: number, _y?: number): boolean {
  return inBoundsNode(x);
}

function at(b: BoardState, node: number): Cell {
  return b.cells[node];
}

function occupied(b: BoardState, node: number): boolean {
  return at(b, node).piece !== Piece.Empty;
}

/** Walk along a line from `from` toward `to` (must share a map line). Returns intermediate nodes. */
function linePath(from: number, to: number): number[] | null {
  if (from === to) return [];
  for (const line of SANREN_MAP.lines) {
    const i = line.nodes.indexOf(from);
    const j = line.nodes.indexOf(to);
    if (i < 0 || j < 0) continue;
    const lo = Math.min(i, j);
    const hi = Math.max(i, j);
    const slice = line.nodes.slice(lo, hi + 1);
    if (i > j) slice.reverse();
    return slice.slice(1, -1); // between
  }
  // Also allow multi-hop along adjacency if on same polyline segments — already covered by lines.
  return null;
}

function clearBetween(b: BoardState, from: number, to: number): boolean {
  const mid = linePath(from, to);
  if (!mid) return false;
  return mid.every((n) => !occupied(b, n));
}

function countBetween(b: BoardState, from: number, to: number): number {
  const mid = linePath(from, to);
  if (!mid) return -1;
  return mid.filter((n) => occupied(b, n)).length;
}

function stepsAlong(from: number, to: number): number {
  const mid = linePath(from, to);
  if (!mid) return 0;
  return mid.length + 1;
}

function adjacent(a: number, b: number): boolean {
  return G.adj[a].includes(b);
}

function sameCampNode(node: number, seat: Seat): boolean {
  return G.campNodes[seat].has(node) && nodeCamp(SANREN_MAP, node) === seat;
}

function isPalace(node: number, seat: Seat): boolean {
  return G.palace[seat].has(node);
}

/** Soldier forward/sideways helpers */
function soldierOk(b: BoardState, seat: Seat, from: number, to: number): boolean {
  if (!adjacent(from, to)) return false;
  const fromCamp = nodeCamp(SANREN_MAP, from);
  const toCamp = nodeCamp(SANREN_MAP, to);

  // Own camp: 只能沿纵线朝中心前进，过河前不能横走。
  // 过河五口：f0→角、f2→左须、f4→门、f6→右须、f8→角。
  if (fromCamp === seat) {
    const a = localFr(SANREN_MAP, from, seat);
    const c = localFr(SANREN_MAP, to, seat);
    if (a && c && a.f === c.f && c.r === a.r + 1) return true;
    // 从河沿线一步踏进中宫图（门 / 须 / 角），已由 adjacency 约束
    if (a && a.r === 4 && toCamp === CITADEL) return true;
    return false;
  }

  // Citadel: 远离本营门 / 同距横移；或向心（边兵进角后 K→I→X→C，不走辅路撞车）
  if (fromCamp === CITADEL || toCamp === CITADEL) {
    const d0 = bfsDist(G.adj, G.gate[seat], from);
    const d1 = bfsDist(G.adj, G.gate[seat], to);
    if (d0 < 0 || d1 < 0) return false;
    if (d1 > d0 || d1 === d0) return true;
    const center = SANREN_MAP.nodes.find((n) => n.kind === "center");
    if (!center) return false;
    const a = SANREN_MAP.nodes[from];
    const b = SANREN_MAP.nodes[to];
    const r0 = (a.x - center.x) ** 2 + (a.y - center.y) ** 2;
    const r1 = (b.x - center.x) ** 2 + (b.y - center.y) ** 2;
    return r1 + 1e-9 < r0;
  }

  // Foreign camp: forward toward that camp's back (decreasing r); sideways same r
  const camp = fromCamp <= 2 ? fromCamp : toCamp;
  if (camp > 2) return false;
  const a = localFr(SANREN_MAP, from, camp);
  const c = localFr(SANREN_MAP, to, camp);
  if (!a || !c) return false;
  if (a.r === c.r && Math.abs(a.f - c.f) === 1) return true; // sideways
  if (a.f === c.f && c.r === a.r - 1) return true; // toward back rank
  return false;
}

export function moveSteps(piece: Piece, from: number, to: number): number {
  if (piece === Piece.Horse || piece === Piece.Elephant) return 2;
  if (piece === Piece.Advisor) return 1;
  const s = stepsAlong(from, to);
  return s > 0 ? s : 1;
}

export function isLegalMove(b: BoardState, seat: Seat, from: Coord, to: Coord): boolean {
  const f = from.x;
  const t = to.x;
  if (!inBoundsNode(f) || !inBoundsNode(t) || f === t) return false;
  const src = at(b, f);
  if (src.piece === Piece.Empty || src.seat !== seat) return false;
  const dst = at(b, t);
  if (dst.seat === seat) return false;

  switch (src.piece) {
    case Piece.General: {
      if (!isPalace(f, seat) || !isPalace(t, seat)) return false;
      return adjacent(f, t);
    }
    case Piece.Advisor: {
      if (!isPalace(f, seat) || !isPalace(t, seat)) return false;
      // diagonal one step: share a palace diagonal segment
      for (const line of SANREN_MAP.lines) {
        if (!line.name.startsWith(`${seat}:pal`)) continue;
        const i = line.nodes.indexOf(f);
        const j = line.nodes.indexOf(t);
        if (i >= 0 && j >= 0 && Math.abs(i - j) === 1) return true;
      }
      // also allow any diagonal adjacency inside palace (corner step)
      if (!adjacent(f, t)) return false;
      const a = localFr(SANREN_MAP, f, seat);
      const c = localFr(SANREN_MAP, t, seat);
      return !!a && !!c && Math.abs(a.f - c.f) === 1 && Math.abs(a.r - c.r) === 1;
    }
    case Piece.Elephant: {
      if (!sameCampNode(f, seat) || !sameCampNode(t, seat)) return false;
      const a = localFr(SANREN_MAP, f, seat);
      const c = localFr(SANREN_MAP, t, seat);
      if (!a || !c) return false;
      if (Math.abs(a.f - c.f) !== 2 || Math.abs(a.r - c.r) !== 2) return false;
      const ef = (a.f + c.f) / 2;
      const er = (a.r + c.r) / 2;
      if (!Number.isInteger(ef) || !Number.isInteger(er)) return false;
      try {
        const eye = campNode(SANREN_MAP, seat, ef, er);
        return !occupied(b, eye);
      } catch {
        return false;
      }
    }
    case Piece.Horse: {
      for (const leg of G.adj[f]) {
        if (occupied(b, leg)) continue;
        for (const face of G.faces) {
          const land = horseLandingWithAdj(G.adj, face, f, leg);
          if (land === t) return true;
        }
      }
      return false;
    }
    case Piece.Chariot: {
      if (!linePath(f, t)) return false;
      return clearBetween(b, f, t);
    }
    case Piece.Cannon: {
      if (!linePath(f, t)) return false;
      if (dst.piece === Piece.Empty) return clearBetween(b, f, t);
      return countBetween(b, f, t) === 1;
    }
    case Piece.Soldier:
      return soldierOk(b, seat, f, t);
    default:
      return false;
  }
}

export type LegalMove = { from: Coord; to: Coord; fee: bigint; capture: Piece };

export function legalMoves(b: BoardState, seat: Seat): LegalMove[] {
  const out: LegalMove[] = [];
  if (b.eliminated[seat]) return out;
  for (let f = 0; f < NODE_COUNT; f++) {
    const c = at(b, f);
    if (c.seat !== seat || c.piece === Piece.Empty) continue;
    for (let t = 0; t < NODE_COUNT; t++) {
      const from = { x: f, y: 0 };
      const to = { x: t, y: 0 };
      if (!isLegalMove(b, seat, from, to)) continue;
      const steps = moveSteps(c.piece, f, t);
      out.push({
        from,
        to,
        fee: computeMoveFeeBySteps(c.piece, steps),
        capture: at(b, t).piece,
      });
    }
  }
  return out;
}

export function minAffordableLegalMoveFee(b: BoardState, seat: Seat): bigint | null {
  const moves = legalMoves(b, seat);
  if (!moves.length) return null;
  return moves.reduce((a, m) => (m.fee < a ? m.fee : a), moves[0].fee);
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
    cells: b.cells.map((c) => ({ ...c })),
    turn: b.turn,
    eliminated: [...b.eliminated],
    ply: b.ply + 1,
  };
  const src = next.cells[from.x];
  const dst = next.cells[to.x];
  const captured = dst.piece;
  const capturedSeat = dst.seat;
  let defeated: Seat | null = null;
  if (captured === Piece.General && capturedSeat !== null) {
    defeated = capturedSeat;
    next.eliminated[capturedSeat] = true;
  }
  next.cells[to.x] = { piece: src.piece, seat };
  next.cells[from.x] = { piece: Piece.Empty, seat: null };

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
  for (const c of b.cells) if (c.seat === seat) s += PIECE_POINTS[c.piece];
  return s;
}

export function graph(): SanrenGraph {
  return G;
}
