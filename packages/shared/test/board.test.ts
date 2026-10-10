import { describe, it, expect } from "vitest";
import { initialBoard, legalMoves, applyMove, isLegalMove } from "../src/board";
import { Piece } from "../src/pieces";

describe("board", () => {
  it("initial has 3 generals", () => {
    const b = initialBoard();
    let g = 0;
    for (const row of b.cells) for (const c of row) if (c.piece === Piece.General) g++;
    expect(g).toBe(3);
  });
  it("seat 0 has legal moves", () => {
    const b = initialBoard();
    const m = legalMoves(b, 0);
    expect(m.length).toBeGreaterThan(0);
  });
  it("soldier can step", () => {
    const b = initialBoard();
    expect(isLegalMove(b, 0, { x: 5, y: 7 }, { x: 5, y: 6 })).toBe(true);
  });
  it("applyMove advances ply", () => {
    const b = initialBoard();
    const r = applyMove(b, 0, { x: 5, y: 7 }, { x: 5, y: 6 });
    expect(r.board.ply).toBe(1);
    expect(r.board.turn).toBe(1);
  });
});
