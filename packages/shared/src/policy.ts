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
    // ⚠️ 显式要求背刺时，**不能**静默回退成普通着法。
    //    历史 bug：这里原本直接往下走到"吃任意子/最便宜着法"，于是调用方拿到
    //    一个不违反任何条款的普通着法，却以为是背刺 —— 链上
    //    `challengeBetrayal` 随后报 "no capture"（实测踩过），而剧本还以为
    //    自己已经完成了背刺。宁可在这里失败，也不要静默降级。
    if (opts.forceBetrayal) {
      throw new Error(
        "forceBetrayal：当前局面下吃不到盟友的士（Slash 条款 NO_CAPTURE_ADVISOR 无法满足）"
      );
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
