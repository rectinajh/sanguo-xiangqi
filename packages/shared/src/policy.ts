import { BoardState, LegalMove, legalMoves } from "./board.js";
import { Piece, Seat } from "./pieces.js";

/** Prefer eating an ally advisor once a NO_CAPTURE_ADVISOR pact is ripe, else captures, else the cheapest legal move. */
export function pickAiMove(
  board: BoardState,
  opts: { allySeat: Seat | null; activatedPly: number | null; forceBetrayal?: boolean }
): LegalMove | null {
  const moves = legalMoves(board, board.turn);
  if (!moves.length) return null;
  const ripe =
    opts.allySeat !== null &&
    opts.activatedPly !== null &&
    board.ply - opts.activatedPly >= 10;
  if ((opts.forceBetrayal || ripe) && opts.allySeat !== null) {
    const hits = moves.filter(
      (m) => m.capture === Piece.Advisor && board.cells[m.to.x].seat === opts.allySeat
    );
    if (hits.length) {
      hits.sort((a, b) => (a.fee < b.fee ? -1 : a.fee > b.fee ? 1 : 0));
      return hits[0];
    }
  }
  const captures = moves.filter((m) => m.capture !== Piece.Empty);
  if (captures.length) {
    captures.sort((a, b) => (a.fee < b.fee ? -1 : a.fee > b.fee ? 1 : 0));
    return captures[0];
  }
  const quiet = [...moves].sort((a, b) => (a.fee < b.fee ? -1 : a.fee > b.fee ? 1 : 0));
  return quiet[0];
}
