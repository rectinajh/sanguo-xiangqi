# 三国棋局 / Shadow Xiangqi Implementation Plan

> **Spec (source of truth):** FINAL PRD v1.0 — `docs/PRD.md` (source: workspace FINAL PRD)  
> 实现以 FINAL PRD **§8 P0** 为准；经济数值以 **§4.2** 为唯一冻结权威。P1 / 非目标不得阻塞演示。

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.
>
> **Writing skill:** This document follows the **superpowers:writing-plans** skill format (bite-sized checkbox tasks, exact files, verify commands, commit messages, YAGNI/TDD).

**Goal:** 在 Oct 11–13 CST 内交付可部署到 Monad Testnet `10143` 的三人象棋 **P0 冲奖脊骨**：每步一笔 tx 的 commit-reveal 走子 + MON 扣费、双账本 Points、诚意金/盟约（hash + 双 ECDSA + `IVerifier`）、AI 卧底一座假诚意背刺 slash、终局揭示 + 最小 AgentRegistry，支撑 3 分钟 Demo。

**Architecture:** 链上合约为真源（`GameTable` 座位/胜负、`Economy` 扣费与 Points、`MoveCommit` commit→reveal 每步一笔确认扣费、`Covenant` 诚意金与 slash、`AgentRegistry` 声誉、`IVerifier` Stub=ECDSA-only）；链下 TS 规则引擎与 `FeeLib` 镜像同一套 §4.2 常量；前端 2D 棋盘 + fee 预览 + 临时钱包；独立 Node AI Agent（自有 EOA，永不持有用户钥）。P0 隐私 = hash + 双 ECDSA + UI/事件隐座位（G1）；完整 ZK 电路 / 谣言店 / 指控投票 / 完整棋规全部延期。

**Tech Stack:** Foundry (Solidity), Vite+React (or Next.js), viem/wagmi, Monad Testnet `chainId 10143`, Node AI agent bot. Circom/Noir 仅 `circuits/README.md` P1 占位——不进关键路径。

## Global Constraints

从 FINAL PRD v1.0 §4.2 / §8 冻结，全任务隐式遵守：

- **每步走子 = 一笔 Monad tx**（`commitMove` → 窗口内 `revealMove`；reveal 合法后扣 `moveFee`）
- `seatStake = 1 MON`；`playBalanceInitial = 2 MON`；`minPlayBalanceToStart = 0.5 MON`；`minAgentStake = 1 MON`；`faucetPerHuman = 3.2 MON`
- `moveFee = (baseFee + distance * distUnit) * pieceMult`；`baseFee = 0.010 MON`；`distUnit = 0.005 MON/格`；distance = Chebyshev
- `pieceMult`：车 2.0 / 马炮 1.5 / 象士 1.2 / 将 1.0 / 卒 0.6
- `piecePoints`：卒 10 / 士象 30 / 马炮 50 / 车 100；`capturePenalty` = 分值×0.001 MON；`captivePointLossRatio = 0.5`
- `defeatStakeShareBps = 4000`（40% seatStake → killer playBalance；60% → prizePool）
- `pointToMonRate = 0.001 MON/Point`；终局 mainPool：70% 胜者 / 20% Points 第二 / 10% 协议金库；胜者 seatStake 全退；剩余 playBalance 全退
- `earnestBond = 0.10 MON`；`earnestTimeout = 90s 或 3 plies`（先到）；`bondPerClause = 0.15 MON`；`maxActiveCovenantsPerSeat = 1`
- `timeoutPenalty = 0.03 MON`；`illegalRevealPenalty = 0.05 MON`；`maxPlies = 80`
- **常量保留勿实现（P1 砍出脊骨）：** `rumorPrice` / `accuseStake` / `accuseSlashOnAI` — 写入 constants 即可，禁止做谣言店/指控投票 UI 或链上逻辑
- AI **永不持有**人类私钥；人类 ephemeral/session wallet；AI 对局中禁止热补 `playBalance`
- 主赛道 **04 Trust Identity & AI Infrastructure**；链 `chainId 10143`；主网 143 仅 README
- ZK：**P0** = hash + 双 ECDSA + UI/事件隐座位 + `IVerifier` 接口；Stub 仅 ECDSA 路径，禁止 `return true` 冒充完整 ZK；P1 最小 preimage ZK / G2 延期
- 破产唯一规则：`playBalance < minAffordableLegalMoveFee` → 立即 `autoResign`；seatStake **不得**垫走子费
- 棋规：可执行简化三人象棋，inspired by Sanren Xiangqi——不做规则百科
- 时间盒 Oct 11–13 CST；Buffer 日只修「不能完局 / 不能扣费 / 不能 slash」；禁止新功能与 P1

---

## File map (new repo structure)

```
sanguo-xiangqi/
├── README.md                          # 1行 pitch + 架构 + ZK 诚实表 + Demo 脚本 + 部署地址
├── foundry.toml
├── .env.example                       # MONAD_RPC, PRIVATE_KEY(deployer), AGENT_KEY
├── packages/
│   └── shared/                        # 费用公式与棋规常量（TS，前后端/Agent 共用）
│       ├── package.json
│       ├── src/
│       │   ├── constants.ts           # FINAL §4.2 冻结默认（wei）；rumor/accuse 仅常量
│       │   ├── fees.ts                # moveFee / capturePenalty / chebyshev
│       │   ├── board.ts               # 三人简化棋盘、初始布局、合法着
│       │   ├── pieces.ts              # PieceType + pieceMult/points 表
│       │   └── index.ts
│       └── test/
│           ├── fees.test.ts
│           └── board.test.ts
├── contracts/
│   ├── src/
│   │   ├── GameTable.sol              # join / 座位 / AI 隐藏 / 破产 / 胜负 / finalize
│   │   ├── Economy.sol                # playBalance / Points / treasury / 折算
│   │   ├── MoveCommit.sol             # commitMove / revealMove + 扣费（每步一 tx）
│   │   ├── Covenant.sol               # lockEarnest / activate / slash / fulfill
│   │   ├── AgentRegistry.sol          # 最小 ERC-8004 风格身份+声誉
│   │   ├── interfaces/
│   │   │   ├── IVerifier.sol          # ZK-ready；Stub = ECDSA-only
│   │   │   ├── IEconomy.sol
│   │   │   └── IGameTable.sol
│   │   ├── verifiers/
│   │   │   └── StubVerifier.sol       # 仅 ECDSA；README 诚实标注非完整 ZK
│   │   └── libraries/
│   │       └── FeeLib.sol             # 与 packages/shared/fees.ts 镜像
│   ├── script/
│   │   ├── Deploy.s.sol               # 部署到 10143
│   │   └── DemoSeed.s.sol             # 导演模式种子局
│   └── test/
│       ├── GameTable.t.sol
│       ├── Economy.t.sol
│       ├── MoveCommit.t.sol
│       ├── Covenant.t.sol
│       ├── Slash.t.sol
│       └── AgentRegistry.t.sol
├── frontend/
│   ├── package.json                   # Vite+React；viem/wagmi
│   ├── src/
│   │   ├── App.tsx
│   │   ├── lib/
│   │   │   ├── chain.ts               # monad testnet 10143
│   │   │   ├── wallet.ts              # ephemeral wallet + faucet 提示
│   │   │   ├── contracts.ts           # ABI + addresses
│   │   │   └── fees.ts                # re-export shared
│   │   ├── components/
│   │   │   ├── Board.tsx              # 2D；合法格 + moveFee 预览
│   │   │   ├── ScorePanel.tsx         # playBalance | points | seatStake
│   │   │   ├── AllianceModal.tsx      # 求援/条款/双签（无指控/谣言 UI）
│   │   │   ├── DemoDirector.tsx       # drain / 触发窗口（P0 Demo 糖衣）
│   │   │   └── EndgameReveal.tsx
│   │   └── hooks/
│   │       ├── useGame.ts
│   │       └── useMoveCommit.ts
│   └── vite.config.ts
├── agent/
│   ├── package.json
│   ├── src/
│   │   ├── index.ts                   # 轮询当前行棋方 == AI seat
│   │   ├── policy/
│   │   │   ├── heuristic.ts           # 吃子净分 − λ·fee − 被将军惩罚
│   │   │   ├── betrayal.ts            # 假诚意（P0 必做）
│   │   │   └── gasAssassin.ts         # 油费刺客（可脚本切换，非阻塞）
│   │   ├── motiveLog.ts               # forcedBurnMON 等；hash 上链
│   │   └── seatDriver.ts              # Agent EOA 签名 commit/reveal
│   └── .env.example
├── circuits/                          # P1 deferred — 仅 README 占位
│   └── README.md                      # 「P1: covenant_preimage circom/Noir」
├── scripts/
│   ├── demo-harness.ts                # 3 分钟剧本（FINAL §9）
│   └── faucet-hint.md
└── docs/
    ├── 三人象棋-最终PRD.md            # Spec 副本/链接
    └── superpowers/plans/
        └── 2026-10-11-shadow-xiangqi-implementation.md
```

**P1 / 明确砍（不建实现，仅常量或 README 占位）：** 谣言商店、指控投票 UI、完整 ZK 电路 / G2、完整冷门棋规、`eth_sendRawTransactionSync` 动画、主网 143 运营、匹配大厅、多 AI、大模型对话、UGC 条款。

---

## Day-by-day timeline (Oct 11–13 Asia/Shanghai) — P0 only

对齐 FINAL PRD §8.3：

| 日 | 时段 (CST) | 焦点 | Tasks | 可演示切片 |
|----|------------|------|-------|------------|
| **Day 1 · Oct 11** | 上午 | GameTable + Economy 扣费 + seatStake；共享 FeeLib | 1–2 | `forge test` 绿；入座 + 一步 commit-reveal 扣费 |
| Day 1 | 下午 | 棋盘 UI + fee 预览 + 吃子/破产 | 3–4 | 浏览器点卒/车看 fee；吃子改 Points；drain→autoResign |
| Day 1 | 夜 | AI 完局 + Covenant P0（诚意金 / 双 ECDSA） | 5–6 | AI 自动走子；lockEarnest→Accept→Active |
| **Day 2 · Oct 12** | 上午 | Slash + 终局揭示 + AgentRegistry | 7–8 | challenge→`BetrayalSlashed`；motiveLog + 声誉 |
| Day 2 | 下午 | Demo 串演、README、部署 10143、录屏 | 9 | 3 分钟剧本可走通；地址/tx 可复现 |
| **Day 3 · Oct 13** | Buffer / 提交 | **只修**不能完局 / 不能扣费 / 不能 slash | — | 禁止新功能与 P1 |

---

## Tasks — bite-sized with checkboxes

### Task 1: Repo + Foundry + board rules engine (off-chain TS + Solidity FeeLib)

**Goal:** 脚手架就绪；共享费用/棋盘库可单测；FeeLib 与 TS 数值一致（FINAL §4.2 / §4.3 口播三例）。

**Files:**
- Create: `foundry.toml`, `packages/shared/src/{constants,fees,board,pieces,index}.ts`, `packages/shared/test/{fees,board}.test.ts`, `contracts/src/libraries/FeeLib.sol`, `contracts/test/FeeLib.t.sol`, `README.md`（骨架）
- Test: `packages/shared/test/fees.test.ts`, `contracts/test/FeeLib.t.sol`

**Interfaces:**
- Produces: `computeMoveFee(piece, from, to) → uint256`（wei）；`chebyshev(from, to)`；`PIECE_MULT` / `PIECE_POINTS`；`Board` 初始三营简化布局 + `legalMoves(seat, board)`

- [ ] **Step 1: 初始化 monorepo + Foundry**

```bash
mkdir -p sanguo-xiangqi && cd sanguo-xiangqi
forge init contracts --no-commit
mkdir -p packages/shared/src packages/shared/test frontend agent scripts circuits docs
# packages/shared: npm init -y；加 vitest + typescript
```

- [ ] **Step 2: 写入 FINAL §4.2 冻结常量到 `packages/shared/src/constants.ts`**

```typescript
export const SEAT_STAKE = 10n ** 18n;                    // 1 MON
export const PLAY_BALANCE_INITIAL = 2n * 10n ** 18n;     // 2 MON
export const MIN_PLAY_BALANCE_TO_START = 5n * 10n ** 17n; // 0.5 MON
export const BASE_FEE = 10n ** 16n;                      // 0.010 MON
export const DIST_UNIT = 5n * 10n ** 15n;                // 0.005 MON
export const EARNEST_BOND = 10n ** 17n;                  // 0.10 MON
export const BOND_PER_CLAUSE = 15n * 10n ** 16n;         // 0.15 MON
export const TIMEOUT_PENALTY = 3n * 10n ** 16n;          // 0.03 MON
export const ILLEGAL_REVEAL_PENALTY = 5n * 10n ** 16n;   // 0.05 MON
export const POINT_TO_MON_RATE = 10n ** 15n;             // 0.001 MON / Point
export const DEFEAT_STAKE_SHARE_BPS = 4000n;
export const MAX_PLIES = 80;
export const EARNEST_TIMEOUT_SECS = 90;
export const EARNEST_TIMEOUT_PLIES = 3;
export const MAX_ACTIVE_COVENANTS_PER_SEAT = 1;
// P1 砍出脊骨 — 常量保留勿实现：
export const RUMOR_PRICE = 5n * 10n ** 16n;              // 0.05 MON
export const ACCUSE_STAKE = 10n ** 17n;                  // 0.10 MON
export const ACCUSE_SLASH_ON_AI = 4n * 10n ** 17n;       // 0.40 MON
```

- [ ] **Step 3: 写失败单测（口播示例）再实现 `fees.ts`**

```typescript
// packages/shared/test/fees.test.ts
import { describe, it, expect } from "vitest";
import { computeMoveFee } from "../src/fees";
import { Piece } from "../src/pieces";

it("卒走1格 = 0.009 MON", () => {
  expect(computeMoveFee(Piece.Soldier, {x:0,y:0}, {x:1,y:0}))
    .toBe(9n * 10n ** 15n);
});
it("车走5格 = 0.070 MON", () => {
  expect(computeMoveFee(Piece.Chariot, {x:0,y:0}, {x:5,y:0}))
    .toBe(70n * 10n ** 15n);
});
it("马 distance=2 = 0.030 MON", () => {
  expect(computeMoveFee(Piece.Horse, {x:0,y:0}, {x:2,y:1}))
    .toBe(30n * 10n ** 15n);
});
```

Run: `cd packages/shared && npx vitest run test/fees.test.ts`  
Expected: FAIL（模块未实现）→ 实现后 PASS。

- [ ] **Step 4: 简化三人棋盘（YAGNI，不做完整冷门棋规）**

在 `board.ts`：座位固定 A/B/C；每座将+士+象+马+炮+车+3卒；三角三营简化布局。`legalMoves`：卒进一、车直线无阻、马日字蹩腿、炮隔子打、士斜一步、象田字、将九宫——**冲突以 FINAL PRD 可执行简化为准**，README 写 inspired by Sanren Xiangqi。

- [ ] **Step 5: Solidity `FeeLib.sol` 镜像同一公式 + forge 测试对齐 TS 三例**

```solidity
library FeeLib {
    uint256 constant BASE_FEE = 0.01 ether;
    uint256 constant DIST_UNIT = 0.005 ether;
    function moveFee(uint8 piece, uint8 fromX, uint8 fromY, uint8 toX, uint8 toY) internal pure returns (uint256);
}
```

Run: `cd contracts && forge test --match-contract FeeLibTest -vv`  
Expected: PASS，三例与 TS 一致。

- [ ] **Step 6: Commit**

```bash
git add foundry.toml packages/shared contracts/src/libraries contracts/test/FeeLib.t.sol README.md
git commit -m "feat: scaffold repo, shared fee/board engine, FeeLib mirror"
```

---

### Task 2: Game contract — seatStake, playBalance, commit-reveal move, moveFee (one tx per move)

**Goal:** 三座可 join；当前方 commit→reveal（**每步一笔 tx 确认扣费**）；成功扣 `moveFee` 入 `moveFeeTreasury`；非法/超时罚金。

**Files:**
- Create: `contracts/src/GameTable.sol`, `contracts/src/Economy.sol`, `contracts/src/MoveCommit.sol`, `contracts/src/interfaces/IEconomy.sol`, `contracts/test/GameTable.t.sol`, `contracts/test/MoveCommit.t.sol`
- Modify: `foundry.toml`（如需 remappings）

**Interfaces:**
- Produces:
  - `GameTable.join(uint8 seat) payable` — `msg.value >= seatStake + playBalanceInitial`
  - `GameTable.startGame()` — 三座满；恰好 1 AI 座（commit-reveal / Demo 导演预选；人类 UI 不显示）
  - `MoveCommit.commitMove(bytes32 gameId, bytes32 commitHash)`
  - `MoveCommit.revealMove(bytes32 gameId, uint8 fromX, uint8 fromY, uint8 toX, uint8 toY, uint8 piece, bytes32 salt)`
  - Events: `MoveFeePaid(gameId, seat, moveFee, playBalanceAfter)`

- [ ] **Step 1: 写 `Economy` 账本**

```solidity
mapping(bytes32 => mapping(uint8 => uint256)) public playBalance;
mapping(bytes32 => mapping(uint8 => uint32)) public points;
mapping(bytes32 => mapping(uint8 => uint256)) public seatStakeOf;
uint256 public moveFeeTreasury;
uint256 public penaltyTreasury;
uint256 public prizePool;

function creditPlay(bytes32 g, uint8 s, uint256 amt) external;
function debitPlay(bytes32 g, uint8 s, uint256 amt) external returns (uint256 after);
```

- [ ] **Step 2: 写失败测试 `test_join_locks_one_mon_stake`**

```solidity
function test_join_locks_one_mon_stake() public {
    table.join{value: 3 ether}(0); // 1 stake + 2 play
    assertEq(table.seatStakeOf(gameId, 0), 1 ether);
    assertEq(economy.playBalance(gameId, 0), 2 ether);
}
```

Run: `forge test --match-test test_join_locks_one_mon_stake -vv` → FAIL → 实现 `join` → PASS。

- [ ] **Step 3: commit-reveal（每步一笔 tx）**

```solidity
// commitHash = keccak256(abi.encode(seat, fromX, fromY, toX, toY, piece, salt))
function commitMove(bytes32 gameId, bytes32 commitHash) external;
function revealMove(...) external {
    // verify hash, turn, legal
    // FeeLib.moveFee → economy.debitPlay → emit MoveFeePaid
    // apply board delta
}
```

MVP 回合制：当前方 commit → 立即进入 reveal 窗口。  
非法 reveal：`debitPlay(illegalRevealPenalty)`，同 ply 最多 2 次后按超时。  
超时：先扣 `timeoutPenalty`；再跑破产检查；否则弃权一步。

- [ ] **Step 4: 集成测试一步卒走扣 0.009 MON**

Run: `forge test --match-test test_reveal_soldier_step_fee -vv`  
Expected: `playBalance` 从 2e18 变为 `2e18 - 9e15`；`MoveFeePaid` 出现。

- [ ] **Step 5: Commit**

```bash
git add contracts/src/GameTable.sol contracts/src/Economy.sol contracts/src/MoveCommit.sol contracts/test
git commit -m "feat: join seatStake/playBalance + commit-reveal moveFee (1 tx/move)"
```

---

### Task 3: Capture/defeat Points + bankruptcy

**Goal:** 吃子双账本；击败吞 Points + 40% stake；破产 autoResign（FINAL §4.4）。

**Files:**
- Modify: `contracts/src/Economy.sol`, `contracts/src/GameTable.sol`, `contracts/src/MoveCommit.sol`
- Create: `contracts/test/Economy.t.sol`
- Test: `test_capture_awards_points_and_penalty`, `test_defeat_seizes_points`, `test_bankrupt_auto_resign`

**Interfaces:**
- Produces: `CaptureSettled`, `PointsSeized`, `SeatBankrupt`；`autoResign(seat)`；`checkBankruptcy(g, seat, minLegalFee)`  
  Demo 导演可 `drainPlayBalance(seat, leaveWei)`（P0 Demo 糖衣，非完整导演系统）

- [ ] **Step 1: 吃子结算（§4.4）**

```solidity
// attacker points += piecePoints
// victim points -= floor(piecePoints * 0.5)
// victim playBalance debit capturePenalty → penaltyTreasury
// attacker 仍付本次 moveFee
```

- [ ] **Step 2: 击败（吃将或 autoResign）原子结算**

```solidity
function onDefeat(bytes32 g, uint8 killer, uint8 defeated) internal {
    uint32 seized = points[g][defeated];
    points[g][killer] += seized;
    emit PointsSeized(g, killer, defeated, seized);
    points[g][defeated] = 0;
    uint256 stake = seatStakeOf[g][defeated];
    uint256 toKiller = stake * 4000 / 10000;
    playBalance[g][killer] += toKiller;
    prizePool += stake - toKiller;
    seatStakeOf[g][defeated] = 0;
    // PendingEarnest 直接退；Active 无违约则退剩余 bond（MVP）
}
```

破产无唯一杀手：Points 进 `orphanPoints`（终局折现）。

- [ ] **Step 3: 破产唯一规则**

```solidity
function checkBankruptcy(bytes32 g, uint8 seat, uint256 minLegalFee) public {
    if (playBalance[g][seat] < minLegalFee) {
        autoResign(g, seat); // seatStake 不得垫走子费
    }
}
```

- [ ] **Step 4: 测试三路径**

Run: `forge test --match-contract EconomyTest -vv`  
Expected: 吃马 +50/−25 points + 0.05 MON penalty；吃将吞分；drain 后 autoResign。

- [ ] **Step 5: Commit**

```bash
git commit -am "feat: capture points, defeat seize, bankruptcy autoResign"
```

---

### Task 4: Frontend board UI (2D) + legal moves + fee preview + ephemeral wallet

**Goal:** 浏览器可点己方子→高亮合法格与 `moveFee`→commit/reveal（每步一笔 tx）；临时钱包；双账本面板。**不做**谣言店/指控投票 UI。

**Files:**
- Create: `frontend/package.json`, `frontend/src/{App,components/Board,ScorePanel,DemoDirector}.tsx`, `frontend/src/lib/{chain,wallet,contracts,fees}.ts`, `frontend/src/hooks/{useGame,useMoveCommit}.ts`
- Depends: `packages/shared`

**Interfaces:**
- Consumes: shared `legalMoves`, `computeMoveFee`；合约 ABI
- Produces: 可玩 2D UI；`createEphemeralWallet()` → session storage；faucet 文案

- [ ] **Step 1: Vite+React+viem/wagmi 脚手架；配置 Monad 10143**

```typescript
// lib/chain.ts
export const monadTestnet = {
  id: 10143,
  name: "Monad Testnet",
  nativeCurrency: { name: "MON", symbol: "MON", decimals: 18 },
  rpcUrls: { default: { http: [import.meta.env.VITE_MONAD_RPC] } },
};
```

- [ ] **Step 2: ephemeral wallet**

```typescript
// lib/wallet.ts — generate private key in session; NEVER send to AI/agent
export function getOrCreateSessionAccount(): PrivateKeyAccount { ... }
```

- [ ] **Step 3: Board 组件**

- 顶视网格；三色阵营
- 点击己子 → `legalMoves` 高亮；每格标签预估 `moveFee`
- 点击目标 → 校验 `playBalance >= moveFee` → `commitMove` → 立即 `revealMove`（MVP 回合制窗口；每步一笔确认）
- ScorePanel：`playBalance | points | seatStake 锁定中`
- DemoDirector：`drainPlayBalance` 便于高潮（可选一键）

- [ ] **Step 4: 手动验证**

Run: `cd frontend && npm run dev`  
Expected: 入座后卒/车 fee 预览与 FINAL §4.3 口播一致；reveal 后面板余额下降。

- [ ] **Step 5: Commit**

```bash
git add frontend
git commit -m "feat: 2D board with fee preview and ephemeral wallet"
```

---

### Task 5: AI agent seat (heuristic + fake-earnest betrayal)

**Goal:** 一座 Agent 用自有 EOA 完局；**假诚意背刺必做**；油费刺客可脚本切换（不阻塞）；写 motiveLog。禁止持有人类钥 / 热补油 / 复杂大模型对话。

**Files:**
- Create: `agent/src/{index,seatDriver,motiveLog}.ts`, `agent/src/policy/{heuristic,betrayal,gasAssassin}.ts`, `agent/package.json`, `agent/.env.example`

**Interfaces:**
- Consumes: 合约读状态；shared board/fees
- Produces: `AgentDriver.playIfMyTurn()`；`motiveLog` JSON + `keccak256` 供终局；**零用户钥**

- [ ] **Step 1: seatDriver — 仅 `AGENT_PRIVATE_KEY`**

```typescript
// 环境变量 AGENT_PRIVATE_KEY；断言与人类 session key 不同地址
```

- [ ] **Step 2: heuristic 选着**

评分：吃子净 Points − λ·moveFee − 被将军惩罚；能完局即可。

- [ ] **Step 3: betrayal 策略（假诚意 — P0 必做）**

```typescript
// 若 Active 盟约含 NO_CAPTURE_ADVISOR 且 ply - activatedPly >= 10
// 则优先吃盟友士 / 攻帅；motiveLog.push("fake-earnest betrayal")
```

- [ ] **Step 4: gasAssassin（可脚本切换，非关键路径阻塞项）**

优先远途车威胁；`motiveLog.forcedBurnMON += estimatedOpponentResponseFee`。

- [ ] **Step 5: 跑一轮 vs 两个脚本人类**

Run: `cd agent && npm run start:once`（配合 Anvil）  
Expected: AI 座自动 commit/reveal；日志含策略名；进程环境无人类钥。

- [ ] **Step 6: Commit**

```bash
git add agent
git commit -m "feat: AI agent seat with fake-earnest betrayal (+ optional gasAssassin)"
```

---

### Task 6: Alliance earnest + covenant activate (P0: hash + dual ECDSA + IVerifier)

**Goal:** lockEarnest → Accept → activateCovenant（双 ECDSA）；第三方事件无座位（G1）；`IVerifier` 接口预留。**不做**完整 ZK 电路。

**Files:**
- Create: `contracts/src/Covenant.sol`, `contracts/src/interfaces/IVerifier.sol`, `contracts/src/verifiers/StubVerifier.sol`, `contracts/test/Covenant.t.sol`, `frontend/src/components/AllianceModal.tsx`, `circuits/README.md`（P1 占位）

**Interfaces:**
- Produces:
  - `lockEarnest(bytes32 covenantHash) payable` — 仅记 hash+金额；`EarnestLocked(gameId, covenantHash, amount)` **无 seat**
  - `activateCovenant(bytes32 covenantHash, bytes sigI, bytes sigJ, bytes32 preimageHash, bytes zkProof)` — P0：双 ECDSA + `msg.sender` 为当事人；当事人座位写私有映射，**不 emit 座位**；`zkProof` 可空（空则仅 ECDSA）；非空才调 `IVerifier`
  - Status: `PendingEarnest → Active | Expired`；`Active → Slashed | Fulfilled`
  - 条款 ≥2：`NO_CAPTURE_ADVISOR`（Demo 主用）、`NO_EXPOSE_BEFORE_END`（指控模块未做则作占位谓词）；可选 `MUTUAL_NON_CHECK`
  - 诚意金抵扣：Accept 时发起方 earnest 计入其 bond 份额（例：2 条款 bondTotal=0.30，各方 0.15；已锁 0.10 → 再补 0.05）

- [ ] **Step 1: 数据结构与状态机按 FINAL PRD §5.2–5.3 实现**

```text
CovenantPreimage = { gameId, seat_i, seat_j, clauses[], bondAmount,
                     earnestBond, nonce, validFromPly, validToPly }
covenantHash = keccak256(abi.encode(CovenantPreimage))
```

- [ ] **Step 2: 测试 lock → timeout 退款不露座位**

```solidity
function test_earnest_timeout_refund_anonymous() public {
    // lock 0.1 MON; warp 91s; refund; event EarnestRefunded only (no seat)
}
```

- [ ] **Step 3: activate 双签 + bond 到齐；`maxActiveCovenantsPerSeat = 1`**

- [ ] **Step 4: AllianceModal — 链下构造 preimage、双方签名、选条款；公开 UI/事件监听不暴露盟友座位（G1）**

- [ ] **Step 5: StubVerifier + README 诚实表（铁律）**

```markdown
| ZK 层 | 内容 | Demo 标注 |
|-------|------|-----------|
| P0 | hash + 双 ECDSA；UI/事件隐座位；IVerifier 接口 | 「隐私前端 + 密码学承诺；ZK-ready」 |
| P1 | 最小 preimage ZK（circom/Noir） | ❌ deferred |
| P2 / G2 | Slash 仍隐藏座位 | ❌ 不承诺 |
```

`StubVerifier` **不得** `return true` 冒充完整 ZK；仅服务 ECDSA 路径。`circuits/README.md` 写 P1 升级路径一句即可。

- [ ] **Step 6: Commit**

```bash
git commit -am "feat: earnest bond + ECDSA covenant activate (IVerifier ZK-ready)"
```

---

### Task 7: Slash on clause violation

**Goal:** Active 盟约下违约 reveal（如吃盟友士）→ 受害方 challenge → bond 转受害方；emit `BetrayalSlashed`。G1：Slash/终局揭示当事人。**不做**指控投票 / 谣言店。

**Files:**
- Modify: `contracts/src/Covenant.sol`, `contracts/src/MoveCommit.sol`（reveal 后可选钩子）
- Create: `contracts/test/Slash.t.sol`
- Modify: `frontend` — 当事人可见 challenge 按钮（非公开指控 UI）

**Interfaces:**
- Produces: `challengeBetrayal(covenantHash, clauseId, moveEvidence, partyProof)`  
  - P0 partyProof = ECDSA 证明 caller 为当事人 / 知 preimage  
  - 成功：`status=Slashed`；违约方 bond → 受害方 playBalance；G1 揭示当事人

- [ ] **Step 1: 条款谓词 `NO_CAPTURE_ADVISOR`**

reveal 目标格为盟友士 → 受害方提交 evidence（from/to/piece/ply）或合约记 `pendingViolation`。

- [ ] **Step 2: challenge 成功路径单测**

Run: `forge test --match-test test_slash_on_capture_advisor -vv`  
Expected: bond 转移；`BetrayalSlashed`；第三方此前不知座位，slash 时按 G1 揭示当事人。

- [ ] **Step 3: 明确不做 accuse / rumor（P1 deferred）— 本任务只做盟约 slash**

- [ ] **Step 4: Commit**

```bash
git commit -am "feat: covenant clause slash on betrayal"
```

---

### Task 8: Endgame reveal AI + reputation registry (minimal ERC-8004-style)

**Goal:** 终局关闭盟约/诚意金 → Points 折现 → 揭示 AI + motiveLog → 更新声誉 → 分锅（赛道 04 闭环）。

**Files:**
- Create: `contracts/src/AgentRegistry.sol`, `contracts/test/AgentRegistry.t.sol`, `frontend/src/components/EndgameReveal.tsx`
- Modify: `contracts/src/GameTable.sol`（`finalizeGame`）

**Interfaces:**
- Produces:
  ```solidity
  struct Reputation {
      uint32 games; uint32 wins; uint32 slashed;
      uint32 betrayalIndex; uint32 trustScore;
      uint256 forcedBurnMonTotal;
  }
  function registerAgent(string calldata metadataURI) external payable;
  function recordGameResult(uint256 agentId, bool won, bool wasSlashed, uint256 forcedBurn) external;
  ```
  - `finalizeGame(gameId)`：mainPool 70/20/10；胜者 seatStake 退回；剩余 playBalance 全退；`AiRevealed(gameId, seat, motiveLogHash)`

- [ ] **Step 1: AgentRegistry 最小实现（简单 uint id 即可，非完整 NFT）**

- [ ] **Step 2: finalize 结算单测（§4.2 分配）**

- [ ] **Step 3: EndgameReveal UI — AI 座、motiveLog（建议含 forcedBurnMON）、trustScore 变化**

- [ ] **Step 4: Commit**

```bash
git commit -am "feat: endgame settle, AI reveal, AgentRegistry reputation"
```

---

### Task 9: Demo script harness + README + deploy to Monad testnet

**Goal:** 3 分钟剧本可脚本化（FINAL §9）；README 达标（诚实失败/ZK 层级表）；10143 部署地址可复现。

**Files:**
- Create: `scripts/demo-harness.ts`, `contracts/script/Deploy.s.sol`, `contracts/script/DemoSeed.s.sol`, `README.md`（完整）
- Modify: `.env.example`

**Interfaces:**
- Produces: 部署输出 `GameTable`, `Economy`, `Covenant`, `AgentRegistry`, `StubVerifier` 地址；demo-harness 对齐 FINAL §9 / §2.3

- [ ] **Step 1: `Deploy.s.sol`**

```bash
forge script script/Deploy.s.sol:Deploy --rpc-url $MONAD_RPC --broadcast --chain 10143
```

- [ ] **Step 2: demo-harness 步骤（FINAL §9）**

1. 三座 join（2 ephemeral + 1 agent）；各锁 1 MON + playBalance；「1 名 AI 已隐藏」  
2. 2–3 手展示车远走 fee vs 卒便宜（每步一笔 tx）  
3. lockEarnest 0.1 → accept → Active（第三方不知是谁）  
4. 履约数手 → 背刺吃士 → challenge → Slash  
5. 出局吞 Points + 40% stake（或导演 drain 破产）  
6. finalize → AiRevealed + motiveLog + 声誉；点题赛道 04  

Run: `npx tsx scripts/demo-harness.ts`  
Expected: 全绿；打印关键 tx hash。

- [ ] **Step 3: README 必含**

- 1 行 pitch（FINAL 附录 B 中英）  
- 架构图（ASCII 即可）  
- **诚实失败模式 + P0/P1/P2 ZK 层级表**（禁止 stub 冒充完整 ZK）  
- Demo 脚本 + 「评委会看到什么」对齐 §2.3  
- 部署地址、示例 tx  
- AI 不持用户钥声明  
- inspired by Sanren Xiangqi  
- 备用话术：ZK 电路未就绪 → 切 P0「签名+承诺+UI 隐匿」；扣费/诚意金/slash/Points 仍真上链  

- [ ] **Step 4: 验收对照 FINAL PRD §11 勾选 P0 项**

- [ ] **Step 5: Commit + tag**

```bash
git add README.md scripts contracts/script
git commit -m "chore: demo harness, README, Monad 10143 deploy scripts"
git tag v1.0.0-mvp
```

---

## P1 Deferred（明确不进冲奖关键路径）

| 项 | 原因 |
|----|------|
| circom/Noir groth16 真证明 | 时间；`IVerifier` 已预留 |
| G2 Slash 仍隐藏座位 | 电路复杂；不承诺 |
| 谣言商店 / 指控投票 UI | FINAL §8.2 明确非目标；常量保留勿实现 |
| 完整冷门三人象棋规则与残局库 | 可执行简化即可 |
| `eth_sendRawTransactionSync` 动画 | 加分项 |
| 主网 143 运营 | 仅 README 步骤 |
| 匹配大厅、排行榜、移动端、多 AI、大模型对话 | 范围外 |
| 去中心化聊天、生产级 Paymaster | 范围外 |
| 借贷垫付 seatStake、跨局 Points NFT | 与破产规则冲突 / 非必须 |

---

## 附录 — MVP 经济参数速查（FINAL §4.2 唯一权威）

| 参数 | 值 | 备注 |
|------|-----|------|
| seatStake | 1 MON | 入座强制 |
| playBalanceInitial | 2 MON | 〔可调〕 |
| minPlayBalanceToStart | 0.5 MON | 〔可调〕 |
| minAgentStake | 1 MON | 与人类对称 |
| faucetPerHuman | 3.2 MON | 〔可调〕 |
| baseFee | 0.010 MON | 〔可调〕 |
| distUnit | 0.005 MON/格 | Chebyshev |
| pieceMult | 车2.0 / 马炮1.5 / 象士1.2 / 将1.0 / 卒0.6 | 〔可调〕 |
| piecePoints | 卒10 士象30 马炮50 车100 | 〔可调〕 |
| capturePenalty | 分值×0.001 MON | 〔可调〕 |
| captivePointLossRatio | 0.5 | 〔可调〕 |
| defeatStakeShareBps | 4000（40%） | 〔可调〕 |
| pointToMonRate | 0.001 MON/Point | 〔可调〕 |
| 终局 mainPool | 70% 胜者 / 20% Points 第二 / 10% 协议金库 | |
| earnestBond | 0.10 MON | 〔可调〕 |
| earnestTimeout | 90s 或 3 plies | 先到 |
| bondPerClause | 0.15 MON | 〔可调〕 |
| maxActiveCovenantsPerSeat | 1 | |
| timeoutPenalty | 0.03 MON | 〔可调〕 |
| illegalRevealPenalty | 0.05 MON | 〔可调〕 |
| maxPlies | 80 | |
| rumorPrice / accuseStake / accuseSlashOnAI | 0.05 / 0.10 / 0.40 MON | **P1 砍；常量保留勿实现** |

---

## Self-review (writing-plans)

1. **Spec coverage:** FINAL PRD §8.1 P0 → Tasks 1–9 均可映射；每步一笔 tx、双账本、诚意金、ECDSA+IVerifier、AI 隔离钥、假诚意 slash、10143、Demo §9 均有任务；谣言/指控/完整 ZK/完整棋规已表列延期且不在关键路径。
2. **Placeholder scan:** 无 TBD；数值均来自 FINAL §4.2；ZK 诚实表强制。
3. **Type consistency:** `gameId bytes32`、`seat uint8`、`covenantHash bytes32`、费用 `uint256` wei 贯穿任务。

---

*Plan date: 2026-10-11 (Asia/Shanghai). Spec = FINAL PRD v1.0 — `docs/PRD.md`. Keep in sync with workspace FINAL PRD source.*
