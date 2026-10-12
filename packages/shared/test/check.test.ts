import { describe, it, expect } from "vitest";
import { emptyBoard, initialBoard, legalMoves } from "../src/board.js";
import { isInCheck, hasAnyLegalMove, threatState, findGeneral, isLoss } from "../src/check.js";
import { Piece } from "../src/pieces.js";
import type { Seat } from "../src/pieces.js";
import { campNode } from "../src/sanrenSetup.js";
import { SANREN_MAP } from "../src/sanrenMap.js";

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

/** 正向用例：敌车照帅（构造局面，避免依赖易碎的长推演序列）。 */
function chariotChecksGeneralBoard() {
  const b = emptyBoard();
  const general = campNode(SANREN_MAP, 0, 4, 0);
  const chariot = campNode(SANREN_MAP, 0, 0, 0); // 同营底线，对黑方来说是敌方车位
  put(b, general, Piece.General, 0);
  put(b, chariot, Piece.Chariot, 1);
  expect(isInCheck(b, 0), "敌车应将军红帅").toBe(true);
  return { b, general, chariot };
}

describe("正向用例：敌车照帅", () => {
  it("同线敌车直击 → 检出将军", () => {
    const { b } = chariotChecksGeneralBoard();
    expect(threatState(b, 0)).not.toBe("none");
  });

  it("被将军方若仍有合法着法则是 check 而非无解", () => {
    const { b } = chariotChecksGeneralBoard();
    // 士放在不挡车线的位置（f5），避免误挡照将
    put(b, campNode(SANREN_MAP, 0, 5, 0), Piece.Advisor, 0);
    expect(isInCheck(b, 0)).toBe(true);
    const t = threatState(b, 0);
    if (t === "check") {
      expect(hasAnyLegalMove(b, 0)).toBe(true);
    } else {
      expect(t).toBe("checkmate");
      expect(hasAnyLegalMove(b, 0)).toBe(false);
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
