/**
 * check.ts —— 将军 / 将死 / 困毙判定。
 *
 * 为什么判定在前端与 agent 而不是合约里：
 *   实测链上成本 —— `isInCheck` 379k gas、`hasAnyLegalMove` 533k gas，
 *   而一次 revealMove 才约 150k。把将死判定塞进每次走子会让对局成本翻几倍，
 *   在测试网上不可接受。判定是纯计算，前端/agent 里算力免费，所以放这边。
 *
 *   合约侧仍保留 `SanrenRules.isInCheck` / `hasAnyLegalMove` 作为**只读**查询，
 *   任何人都能独立复核前端给出的"将军"结论，不是黑箱。
 *
 * 术语（三人象棋没有"被将死就输"之外的和棋概念，所以只有三种结局）：
 *   - check：帅被攻击，必须应将
 *   - checkmate：被将军且无任何合法着法 → 判负
 *   - stalemate：没被将军但无任何合法着法（困毙）→ 本作里同样判负
 */

import { Piece } from "./pieces.js";
import { type BoardState, legalMoves } from "./board.js";
import { NODE_COUNT } from "./constants.js";
import { type Seat } from "./pieces.js";

/** 找出某座位的帅所在节点；不在盘上返回 null。 */
export function findGeneral(b: BoardState, seat: Seat): number | null {
  for (let n = 0; n < NODE_COUNT; n++) {
    const c = b.cells[n];
    if (c && c.piece === Piece.General && c.seat === seat) return n;
  }
  return null;
}

/**
 * 该座位是否正被将军。
 *
 * 实现方式：定位帅，然后看有没有任意敌方棋子能合法吃到那个节点。
 * 复用 legalMoves（与合约同一套规则），所以不会出现"引擎说将军、链上说没有"。
 */
export function isInCheck(b: BoardState, seat: Seat): boolean {
  const king = findGeneral(b, seat);
  if (king === null) return false; // 帅已被吃，游戏已经结束

  for (let s = 0 as Seat; s < 3; s = (s + 1) as Seat) {
    if (s === seat) continue;
    if (b.eliminated?.[s]) continue;
    for (const m of legalMoves(b, s)) {
      if (m.to.x === king) return true;
    }
  }
  return false;
}

/** 该座位是否还有任何合法着法。 */
export function hasAnyLegalMove(b: BoardState, seat: Seat): boolean {
  return legalMoves(b, seat).length > 0;
}

export type ThreatState = "none" | "check" | "checkmate" | "stalemate";

/**
 * 综合威胁状态。checkmate 与 stalemate 在本作里都算"该座位已无路可走"，
 * 区别只在于有没有正在被将军（用于文案：一个是"被将死"，一个是"困毙"）。
 */
export function threatState(b: BoardState, seat: Seat): ThreatState {
  if (b.eliminated?.[seat]) return "none";
  const anyMove = hasAnyLegalMove(b, seat);
  if (anyMove) return isInCheck(b, seat) ? "check" : "none";
  return isInCheck(b, seat) ? "checkmate" : "stalemate";
}

/** 面向玩家的中文文案。 */
export function threatLabel(t: ThreatState): string {
  switch (t) {
    case "check":
      return "将军！";
    case "checkmate":
      return "将死";
    case "stalemate":
      return "困毙（无子可动）";
    default:
      return "";
  }
}

/** 无路可走的两个状态都判负。 */
export function isLoss(t: ThreatState): boolean {
  return t === "checkmate" || t === "stalemate";
}
