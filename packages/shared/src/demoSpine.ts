import { applyMove, initialBoard, isLegalMove, type BoardState } from "./board.js";
import { computeMoveFee } from "./fees.js";
import { pickAiMove } from "./policy.js";
import { Piece, type Seat } from "./pieces.js";

export type DemoMove = {
  seat: Seat;
  from: { x: number; y: number };
  to: { x: number; y: number };
  piece: Piece;
  tag: "cheap" | "quiet" | "loyalty" | "expensive" | "betray";
};

/** Scripted legal line: cheap soldier, expensive chariot, then a real advisor capture. */
export function demoSpine(): { moves: DemoMove[]; cheapFee: bigint; chariotFee: bigint } {
  const cheap = { seat: 0 as Seat, from: { x: 5, y: 7 }, to: { x: 5, y: 6 }, piece: Piece.Soldier, tag: "cheap" as const };
  const quiet1 = { seat: 1 as Seat, from: { x: 3, y: 1 }, to: { x: 4, y: 1 }, piece: Piece.Soldier, tag: "quiet" as const };
  const loyalty = { seat: 2 as Seat, from: { x: 9, y: 3 }, to: { x: 9, y: 4 }, piece: Piece.Soldier, tag: "loyalty" as const };
  const expensive = {
    seat: 0 as Seat,
    from: { x: 7, y: 10 },
    to: { x: 10, y: 10 },
    piece: Piece.Chariot,
    tag: "expensive" as const,
  };
  const quiet2 = { seat: 1 as Seat, from: { x: 1, y: 3 }, to: { x: 1, y: 4 }, piece: Piece.Soldier, tag: "quiet" as const };

  let board = initialBoard();
  const prefix = [cheap, quiet1, loyalty, expensive, quiet2];
  for (const m of prefix) {
    if (!isLegalMove(board, m.seat, m.from, m.to)) {
      throw new Error(`demo move illegal: ${m.tag}`);
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
    piece: board.cells[betray.from.y][betray.from.x].piece,
    tag: "betray",
  };
  return {
    moves: [...prefix, betrayMove],
    cheapFee: computeMoveFee(Piece.Soldier, cheap.from, cheap.to),
    chariotFee: computeMoveFee(Piece.Chariot, expensive.from, expensive.to),
  };
}

export function boardAfter(moves: DemoMove[], count: number): BoardState {
  let board = initialBoard();
  for (let i = 0; i < count; i++) {
    const m = moves[i];
    board = applyMove(board, m.seat, m.from, m.to).board;
  }
  return board;
}
