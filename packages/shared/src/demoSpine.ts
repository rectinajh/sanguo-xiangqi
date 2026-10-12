import { applyMove, initialBoard, isLegalMove, moveSteps, type BoardState } from "./board.js";
import { computeMoveFeeBySteps } from "./fees.js";
import { pickAiMove } from "./policy.js";
import { Piece, type Seat } from "./pieces.js";
import { campNode } from "./sanrenSetup.js";
import { SANREN_MAP } from "./sanrenMap.js";

export type DemoMove = {
  seat: Seat;
  from: { x: number; y: number };
  to: { x: number; y: number };
  piece: Piece;
  tag: "cheap" | "quiet" | "loyalty" | "expensive" | "betray";
};

/**
 * Demo 专用开局：把绿马前移到可一步吃红士的位置，压缩背刺演示手数。
 * 正式对局用 initialBoard()（马归位、兵隔位）。
 */
export function demoInitialBoard(): BoardState {
  const b = initialBoard();
  const horseFrom = campNode(SANREN_MAP, 2, 1, 0);
  const horseAt = 63;
  const hp = b.cells[horseFrom];
  b.cells[horseFrom] = { piece: Piece.Empty, seat: null };
  b.cells[horseAt] = hp;
  return b;
}

/** Scripted legal line: cheap soldier, expensive chariot, then a real advisor capture. */
export function demoSpine(): { moves: DemoMove[]; cheapFee: bigint; chariotFee: bigint } {
  const cheap = {
    seat: 0 as Seat,
    from: { x: campNode(SANREN_MAP, 0, 4, 3), y: 0 },
    to: { x: campNode(SANREN_MAP, 0, 4, 4), y: 0 },
    piece: Piece.Soldier,
    tag: "cheap" as const,
  };
  const quiet1 = {
    seat: 1 as Seat,
    from: { x: campNode(SANREN_MAP, 1, 4, 3), y: 0 },
    to: { x: campNode(SANREN_MAP, 1, 4, 4), y: 0 },
    piece: Piece.Soldier,
    tag: "quiet" as const,
  };
  const loyalty = {
    seat: 2 as Seat,
    from: { x: campNode(SANREN_MAP, 2, 4, 3), y: 0 },
    to: { x: campNode(SANREN_MAP, 2, 4, 4), y: 0 },
    piece: Piece.Soldier,
    tag: "loyalty" as const,
  };
  const expensive = {
    seat: 0 as Seat,
    from: { x: campNode(SANREN_MAP, 0, 8, 0), y: 0 },
    to: { x: 67, y: 0 },
    piece: Piece.Chariot,
    tag: "expensive" as const,
  };
  const quiet2 = {
    seat: 1 as Seat,
    from: { x: campNode(SANREN_MAP, 1, 2, 3), y: 0 },
    to: { x: campNode(SANREN_MAP, 1, 2, 4), y: 0 },
    piece: Piece.Soldier,
    tag: "quiet" as const,
  };

  let board = demoInitialBoard();
  const prefix = [cheap, quiet1, loyalty, expensive, quiet2];
  for (const m of prefix) {
    if (!isLegalMove(board, m.seat, m.from, m.to)) {
      throw new Error(`demo move illegal: ${m.tag} ${m.from.x}→${m.to.x}`);
    }
    board = applyMove(board, m.seat, m.from, m.to).board;
  }
  const betray = pickAiMove(board, { allySeat: 0, activatedPly: 0, forceBetrayal: true });
  if (!betray || betray.capture !== Piece.Advisor) {
    throw new Error("demo betrayal is not an advisor capture");
  }
  const betrayMove: DemoMove = {
    seat: board.turn,
    from: betray.from,
    to: betray.to,
    piece: board.cells[betray.from.x].piece,
    tag: "betray",
  };
  const chariotSteps = moveSteps(Piece.Chariot, expensive.from.x, expensive.to.x);
  return {
    moves: [...prefix, betrayMove],
    cheapFee: computeMoveFeeBySteps(Piece.Soldier, 1),
    chariotFee: computeMoveFeeBySteps(Piece.Chariot, chariotSteps),
  };
}

export function boardAfter(moves: DemoMove[], count: number): BoardState {
  let board = demoInitialBoard();
  for (let i = 0; i < count; i++) {
    const m = moves[i];
    board = applyMove(board, m.seat, m.from, m.to).board;
  }
  return board;
}

export { initialBoard };
