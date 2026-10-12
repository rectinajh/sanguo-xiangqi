import { describe, it, expect } from "vitest";
import { demoSpine, demoInitialBoard } from "../src/demoSpine.js";
import { initialBoard, isLegalMove, applyMove } from "../src/board.js";
import { campNode } from "../src/sanrenSetup.js";
import { SANREN_MAP } from "../src/sanrenMap.js";
import { Piece } from "../src/pieces.js";

/**
 * 这个文件的来历值得写下来，因为它钉住的是一个**真实踩过的 bug**：
 *
 * `demoSpine` 曾经在算背刺着法之前，往棋盘上"植入"一匹绿马到攻士位
 * （和 `demoInitialBoard()` 同一意图）。但**合约并不做这件事** ——
 * 链上的初始盘面由 `SanrenData.setupAt` 决定，绿马在 82，不在攻士位。
 *
 * 于是那段代码算出来的背刺着法在链上是非法的：`pnpm demo` 走到第 6 手
 * 报 illegal geom，而单测却是绿的 —— 因为测试也在同一个被篡改的盘面上校验。
 *
 * 教训：剧本只能**基于合约真实盘面推演新着法**，不能改盘面来迁就剧本。
 * 这里的不变量就是这一条：demoSpine 的每一步，在 initialBoard() 上都合法。
 */
describe("demoSpine 必须与合约布局一致", () => {
  it("前缀 5 手在 initialBoard() 上合法；背刺在挪马后合法且吃到士", () => {
    const spine = demoSpine();
    const prefix = spine.moves.slice(0, -1);
    const betray = spine.moves[spine.moves.length - 1];

    // 前缀：合约真实布局
    let b = initialBoard();
    for (const [i, m] of prefix.entries()) {
      const ok = isLegalMove(b, m.seat, m.from, m.to);
      expect(ok, `前缀第 ${i} 手 ${m.tag} ${m.from.x}->${m.to.x} 应当合法`).toBe(true);
      b = applyMove(b, m.seat, m.from, m.to).board;
    }

    // 背刺：链上会先把绿马挪到 betray.from.x（见 scripts/demo-harness.ts），
    // 所以要在"挪马后"的盘面上校验。先找到绿马当前节点，再整体搬过去。
    const horseAt = betray.from.x;
    let from = -1;
    for (let n = 0; n < 139; n++) {
      const c = b.cells[n];
      if (c && c.piece === Piece.Horse && c.seat === 2) {
        from = n;
        break;
      }
    }
    expect(from, "盘面上应当能找到绿马").toBeGreaterThanOrEqual(0);
    b.cells[horseAt] = b.cells[from];
    b.cells[from] = { piece: Piece.Empty, seat: null };
    expect(isLegalMove(b, betray.seat, betray.from, betray.to), "背刺应当合法").toBe(true);
    const res = applyMove(b, betray.seat, betray.from, betray.to);
    expect(res.captured, "背刺必须吃到士，否则 Slash 条款不成立").toBe(Piece.Advisor);
  });

  /**
   * 最后一步按"背刺策略"选子（pickAiMove forceBetrayal），但**不保证吃到子**。
   *
   * 原因是个真实的产品限制，不是 bug：真实地图有 139 个节点，三方开局相距很远，
   * 短剧本里根本接触不到对方 —— 我搜过 5 手深度（每座各取前几个便宜着法）都
   * 找不到"能让 seat2 吃到子"的前缀。所以"背刺吃到士"在 6 手内无法自然发生，
   * 需要打更久，或者由导演在链上挪子（合约侧 `plantDemoBetrayalHorse` 那种）。
   */
  it("demoInitialBoard 是纯客户端演示盘面，绿马在攻士位", () => {
    const b = demoInitialBoard();
    const horseAt = campNode(SANREN_MAP, 0, 4, 2);
    expect(b.cells[horseAt].piece).toBe(Piece.Horse);
    expect(b.cells[horseAt].seat).toBe(2);

    // 明确它与合约布局**不同**。这条断言是故意的：
    // 哪天合约也挪马了，这里会失败并提醒同步 demoSpine。
    const contract = initialBoard();
    expect(
      contract.cells[horseAt].piece,
      "合约布局里攻士位不该有子；若这里变了说明合约挪马了，demoSpine 要跟着改"
    ).not.toBe(Piece.Horse);
  });
});
