import type { BoardState, SensoryInput, Seat } from "@sanguo/shared";
import { Piece } from "@sanguo/shared";

const AI_SEAT: Seat = 2;

/** Map board snapshot → cyberfly sensory scalars (demo / sidebar path). */
export function boardToSensory(board: BoardState, allySeat: Seat | null = 0): SensoryInput {
  let total = 0;
  let mine = 0;
  let myPieces = 0;
  for (const c of board.cells) {
    if (c.piece === Piece.Empty || c.seat === null) continue;
    const pts = c.piece === Piece.General ? 1 : 10;
    total += pts;
    if (c.seat === AI_SEAT) {
      mine += pts;
      myPieces++;
    }
  }
  const allyContact = allySeat !== null ? Math.min(1, myPieces / 16) : 0;
  const alive = board.eliminated.filter((e) => !e).length;
  return {
    myPointShare: total > 0 ? mine / total : 0.33,
    myFuelRatio: 0.7,
    contactWithAlly: allyContact,
    inCheck: false,
    aliveCount: alive,
    plyProgress: Math.min(1, board.ply / 80),
  };
}
