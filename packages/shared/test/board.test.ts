import { describe, it, expect } from "vitest";
import { initialBoard, legalMoves, applyMove, isLegalMove } from "../src/board";
import { demoSpine, demoInitialBoard } from "../src/demoSpine";
import { pickAiMove } from "../src/policy";
import { Piece } from "../src/pieces";
import { campNode } from "../src/sanrenSetup";
import { SANREN_MAP } from "../src/sanrenMap";
import { NODE_COUNT } from "../src/constants";

describe("sanren board", () => {
  it("has NODE_COUNT nodes and 48 pieces", () => {
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

  it("demo spine 在合约真实布局上全程合法", () => {
    const spine = demoSpine();
    expect(spine.cheapFee).toBe(9_000_000_000_000_000n);
    expect(spine.chariotFee).toBeGreaterThan(spine.cheapFee);
    expect(spine.moves[spine.moves.length - 1].tag).toBe("betray");

    // ⚠️ 必须用 initialBoard()（合约 _setupInitialBoard 用的就是这套布局）。
    //    以前这里用 demoInitialBoard()，把"剧本只在自己的盘面上合法"这个
    //    不一致掩盖掉了 —— 链上跑 pnpm demo 会在第 6 手报 illegal geom。
    // 前缀基于合约布局；背刺那一步链上会先挪马，所以只校验到前缀
    let board = initialBoard();
    for (const [i, m] of spine.moves.slice(0, -1).entries()) {
      expect(isLegalMove(board, m.seat, m.from, m.to), `第 ${i} 手 ${m.tag}`).toBe(true);
      board = applyMove(board, m.seat, m.from, m.to).board;
    }
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
