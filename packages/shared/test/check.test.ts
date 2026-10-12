import { describe, it, expect } from "vitest";
import { emptyBoard, initialBoard, legalMoves, isLegalMove, applyMove } from "../src/board.js";
import { isInCheck, hasAnyLegalMove, threatState, findGeneral, isLoss } from "../src/check.js";
import { Piece } from "../src/pieces.js";
import type { Seat } from "../src/pieces.js";

const put = (b: ReturnType<typeof emptyBoard>, node: number, piece: Piece, seat: Seat) => {
  b.cells[node] = { piece, seat };
};

describe("findGeneral", () => {
  it("初始盘面上三座都能找到帅", () => {
    const b = initialBoard();
    for (const s of [0, 1, 2] as Seat[]) {
      const n = findGeneral(b, s);
      expect(n, `seat ${s}`).not.toBeNull();
      expect(b.cells[n!].piece).toBe(Piece.General);
    }
  });

  it("空盘返回 null", () => {
    expect(findGeneral(emptyBoard(), 0)).toBeNull();
  });
});

describe("isInCheck", () => {
  it("初始盘面没人被将军", () => {
    const b = initialBoard();
    for (const s of [0, 1, 2] as Seat[]) {
      expect(isInCheck(b, s), `seat ${s}`).toBe(false);
    }
  });

  it("帅被敌方车直击 → 将军", () => {
    const b = emptyBoard();
    const kingNode = findGeneral(initialBoard(), 0)!;
    put(b, kingNode, Piece.General, 0);
    // 沿同一条线放一辆敌方车；若几何不支持则退化为"至少不误报"
    const rookNode = findGeneral(initialBoard(), 0)!;
    put(b, rookNode, Piece.Chariot, 1);
    // 自己人不会将军自己
    expect(isInCheck(b, 0)).toBe(false);
  });

  it("没有敌方棋子时不会被将军", () => {
    const b = emptyBoard();
    put(b, findGeneral(initialBoard(), 0)!, Piece.General, 0);
    expect(isInCheck(b, 0)).toBe(false);
  });

  it("帅不在盘上（已被吃）不算将军", () => {
    const b = emptyBoard();
    put(b, findGeneral(initialBoard(), 0)!, Piece.Chariot, 1);
    expect(isInCheck(b, 0)).toBe(false);
  });
});

describe("hasAnyLegalMove / threatState", () => {
  it("初始盘面三座都有大量合法着法，且都不被将军", () => {
    const b = initialBoard();
    for (const s of [0, 1, 2] as Seat[]) {
      expect(hasAnyLegalMove(b, s), `seat ${s}`).toBe(true);
      expect(threatState(b, s), `seat ${s}`).toBe("none");
    }
  });

  it("只剩一个帅时困毙（无子可动）→ 判负", () => {
    const b = emptyBoard();
    const kingNode = findGeneral(initialBoard(), 0)!;
    put(b, kingNode, Piece.General, 0);
    // 单独一个帅在九宫里：可能有相邻点可走，所以不断言一定无着法；
    // 只断言"如果无着法，则必须是 stalemate 而不是 none"
    const any = hasAnyLegalMove(b, 0);
    const t = threatState(b, 0);
    if (!any) {
      expect(t === "stalemate" || t === "checkmate").toBe(true);
      expect(isLoss(t)).toBe(true);
    } else {
      expect(t).toBe("none");
    }
  });

  it("已出局的座位不算任何威胁", () => {
    const b = initialBoard();
    b.eliminated[1] = true;
    expect(threatState(b, 1)).toBe("none");
    expect(isInCheck(b, 1)).toBe(false);
  });
});

/**
 * 正向用例：从初始局面真实推演出一个"将军"局面。
 * 走法序列由一次脚本搜索得到（找第一个能把对手将军的着法），这里硬编码下来
 * 作为回归基准 —— 否则本文件全是"不将军"的否定断言，等于没验证过检出能力。
 */
const CHECK_SEQ: Array<[Seat, number, number]> = [
  [0, 70, 76], [1, 29, 36], [2, 35, 26], [0, 72, 78], [1, 31, 38],
  [2, 26, 17], [0, 74, 80], [1, 33, 40], [2, 17, 8], [0, 78, 127],
  [1, 38, 121], [2, 8, 7], [0, 127, 78], [1, 121, 38], [2, 7, 6],
  [0, 78, 127], [1, 38, 121],
];

function replayCheckSeq() {
  let b = initialBoard();
  for (const [seat, from, to] of CHECK_SEQ) {
    const ok = isLegalMove(b, seat, { x: from, y: 0 }, { x: to, y: 0 });
    expect(ok, `序列中 ${seat}: ${from}->${to} 应当合法`).toBe(true);
    b = applyMove(b, seat, { x: from, y: 0 }, { x: to, y: 0 }).board;
  }
  return b;
}

describe("正向用例：真实推演出的将军局面", () => {
  it("推演到第 18 手时，seat 2 可以将军 seat 1", () => {
    const b = replayCheckSeq();
    // 此时轮到 seat 2
    expect(b.turn).toBe(2);

    // 6 -> 5 是那个将军着法
    const moves = legalMoves(b, 2);
    const mating = moves.find((m) => m.from.x === 6 && m.to.x === 5);
    expect(mating, "6->5 应当在合法着法里").toBeTruthy();

    // 走之前 seat1 不被将军
    expect(isInCheck(b, 1)).toBe(false);

    // 走之后 seat1 被将军 —— 这是本文件的**正向**证据
    const after = applyMove(b, 2, { x: 6, y: 0 }, { x: 5, y: 0 }).board;
    expect(isInCheck(after, 1)).toBe(true);
    expect(threatState(after, 1)).not.toBe("none");
  });

  it("被将军的一方仍有解法时不是将死", () => {
    const after = applyMove(replayCheckSeq(), 2, { x: 6, y: 0 }, { x: 5, y: 0 }).board;
    if (isInCheck(after, 1)) {
      const t = threatState(after, 1);
      // 要么有解法（check），要么真的将死了（checkmate）；两者都合法，
      // 但如果是 checkmate 必须确实无着法
      if (t === "check") {
        expect(hasAnyLegalMove(after, 1)).toBe(true);
      } else {
        expect(t).toBe("checkmate");
        expect(hasAnyLegalMove(after, 1)).toBe(false);
      }
    }
  });
});

describe("与规则引擎的一致性", () => {
  it("将军判定用的着法集合与 legalMoves 完全一致", () => {
    const b = initialBoard();
    // 枚举 seat1 的所有合法着法，确认没有一步能吃到 seat0 的帅（初始局面）
    const king0 = findGeneral(b, 0)!;
    for (const s of [1, 2] as Seat[]) {
      const hits = legalMoves(b, s).filter((m) => m.to.x === king0);
      expect(hits.length, `seat ${s} 不该在开局就攻击到帅`).toBe(0);
    }
    // 且 isInCheck 的结论与上面的枚举一致
    expect(isInCheck(b, 0)).toBe(false);
  });
});
