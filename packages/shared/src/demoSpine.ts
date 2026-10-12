import { applyMove, initialBoard, isLegalMove, legalMoves, moveSteps, type BoardState } from "./board.js";
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
 *
 * ⚠️ **这个盘面与合约实际使用的布局不一致**：合约的 `_setupInitialBoard` 用
 *    `SanrenData.setupAt`（由 gen-sanren-solidity.ts 从 initialSanrenPieces()
 *    生成），绿马在 82 而不是 63。所以基于本函数的剧本在链上会走出非法着法。
 *
 *    正因如此 `demoSpine()` **不使用**这个盘面（见那里的注释）。本函数保留
 *    给"只想在纯客户端演示背刺吃士"的场景，或在合约侧同步挪马之后使用。
 */
export function demoInitialBoard(): BoardState {
  const b = initialBoard();
  const horseFrom = campNode(SANREN_MAP, 2, 1, 0);
  // 0:4:2 — 可一步吃到红士（48/50）；隔河后马无法从本营直达，仅客户端演示用
  const horseAt = campNode(SANREN_MAP, 0, 4, 2);
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
    to: { x: 71, y: 0 },
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

  // 前缀着法与合约 initialBoard 一致；背刺吃士在隔河地图上无法从本营一步到达，
  // 故在前缀之后切到 demoInitialBoard 同构盘面（绿马已在攻士位）再算背刺。
  // 一键链上 Demo 若要跑通背刺，需导演把绿马挪到同一格（见 App / forge 注释）。
  let board = initialBoard();
  const prefix = [cheap, quiet1, loyalty, expensive, quiet2];
  for (const m of prefix) {
    if (!isLegalMove(board, m.seat, m.from, m.to)) {
      throw new Error(`demo move illegal: ${m.tag} ${m.from.x}→${m.to.x}`);
    }
    board = applyMove(board, m.seat, m.from, m.to).board;
  }

  // 背刺那一步要在"绿马已被挪到攻士位"的盘面上算 —— 因为链上就是这么走的：
  // 脚本会先调 `directorRelocate` 把马挪过去（见 scripts/demo-harness.ts），
  // 再走这一步。两条事实要分清楚：
  //   - **前缀 5 手**必须基于合约真实布局（initialBoard），合约就是这么摆的
  //   - **背刺那 1 手**基于挪马后的盘面，因为链上确实先挪了马
  // 历史上这里出过两个 bug：前缀用了 demoInitialBoard（与合约不符），
  // 以及无条件把马挪到固定节点（重跑就撞 "occ"）。
  // 动态挑一个"绿马能一步吃到红方某个士"的空点。
  //   不写死节点号：士的位置随布局变（红士在 48/50），写死会静默失效。
  const home = campNode(SANREN_MAP, 2, 1, 0);
  let horseNode = -1;
  for (let n = 0; n < 139; n++) {
    const c = board.cells[n];
    if (c.piece === Piece.Horse && c.seat === 2) {
      horseNode = n;
      break;
    }
  }
  if (horseNode < 0) throw new Error("demoSpine: 盘面上找不到绿马");

  let relocateTo = -1;
  outer: for (const target of _advisorNodes(board, 0)) {
    for (let n = 0; n < 139; n++) {
      if (board.cells[n].piece !== Piece.Empty) continue;
      const probe = { ...board, cells: board.cells.slice() };
      probe.cells[n] = { piece: Piece.Horse, seat: 2 };
      const hit = legalMoves(probe, 2).some((m) => m.from.x === n && m.to.x === target);
      if (hit) {
        relocateTo = n;
        break outer;
      }
    }
  }
  if (relocateTo < 0) throw new Error("demoSpine: 找不到能让绿马吃到红士的空点");

  board.cells[relocateTo] = board.cells[horseNode];
  board.cells[horseNode] = { piece: Piece.Empty, seat: null };

  // 背刺那一步必须是**合法**的着法。不要求它一定吃到士 —— 能不能吃到
  // 取决于布局，而布局只有一份真源（合约的 setupAt）。要求"必须吃士"会让
  // 剧本在布局变更时直接抛错，反而掩盖了真正的问题。
  const betray = pickAiMove(board, { allySeat: 0, activatedPly: 0, forceBetrayal: true });
  if (!betray) {
    throw new Error("demo betrayal: 当前局面下 AI 没有任何合法着法");
  }
  if (!isLegalMove(board, board.turn, betray.from, betray.to)) {
    throw new Error(
      `demo betrayal illegal: ${betray.from.x}→${betray.to.x}。` +
        `剧本必须基于合约真实布局（initialBoard），不能基于 demoInitialBoard。`
    );
  }
  const betrayMove: DemoMove = {
    seat: 2 as Seat,
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

/** 盘面上某座位的士所在节点（士可能已被吃，所以要即时查）。 */
function _advisorNodes(b: BoardState, seat: Seat): number[] {
  const out: number[] = [];
  for (let n = 0; n < 139; n++) {
    const c = b.cells[n];
    if (c.piece === Piece.Advisor && c.seat === seat) out.push(n);
  }
  return out;
}

export { initialBoard };
