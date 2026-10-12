import { describe, it, expect } from "vitest";
import { initialBoard, legalMoves, applyMove, isLegalMove } from "../src/board";
import { demoSpine, demoInitialBoard } from "../src/demoSpine";
import { pickAiMove } from "../src/policy";
import { Piece } from "../src/pieces";
import { campNode } from "../src/sanrenSetup";
import { SANREN_MAP } from "../src/sanrenMap";
import { NODE_COUNT } from "../src/constants";

describe("sanren board", () => {
  it("has 142 nodes and 48 pieces", () => {
    expect(SANREN_MAP.nodes.length).toBe(NODE_COUNT);
    const b = initialBoard();
    expect(b.cells.length).toBe(NODE_COUNT);
    let n = 0;
    for (const c of b.cells) if (c.piece !== Piece.Empty) n++;
    expect(n).toBe(48);
  });

  it("three generals with seat-specific labels positions", () => {
    const b = initialBoard();
    let g = 0;
    for (const c of b.cells) if (c.piece === Piece.General) g++;
    expect(g).toBe(3);
  });

  it("each seat has legal moves", () => {
    const b = initialBoard();
    expect(legalMoves(b, 0).length).toBeGreaterThan(0);
    expect(legalMoves(b, 1).length).toBeGreaterThan(0);
    expect(legalMoves(b, 2).length).toBeGreaterThan(0);
  });

  it("soldier advances toward center on own file", () => {
    const b = initialBoard();
    const from = campNode(SANREN_MAP, 1, 4, 3);
    const to = campNode(SANREN_MAP, 1, 4, 4);
    expect(isLegalMove(b, 1, { x: from, y: 0 }, { x: to, y: 0 })).toBe(true);
  });

  it("demo spine contrasts fees then captures an advisor", () => {
    const spine = demoSpine();
    expect(spine.cheapFee).toBe(9_000_000_000_000_000n);
    expect(spine.chariotFee).toBeGreaterThan(spine.cheapFee);
    const betray = spine.moves[spine.moves.length - 1];
    expect(betray.tag).toBe("betray");
    expect(betray.piece).toBe(Piece.Horse);
    let board = demoInitialBoard();
    for (const m of spine.moves.slice(0, -1)) board = applyMove(board, m.seat, m.from, m.to).board;
    const forced = pickAiMove(board, { allySeat: 0, activatedPly: 0, forceBetrayal: true });
    expect(forced?.to).toEqual(betray.to);
    expect(forced?.capture).toBe(Piece.Advisor);
  });

  it("applyMove advances ply", () => {
    const b = initialBoard();
    const from = campNode(SANREN_MAP, 0, 4, 3);
    const to = campNode(SANREN_MAP, 0, 4, 4);
    const r = applyMove(b, 0, { x: from, y: 0 }, { x: to, y: 0 });
    expect(r.board.ply).toBe(1);
    expect(r.board.turn).toBe(1);
  });
});
