# 三国棋局 / Shadow Xiangqi — 技术实现文档

| 字段 | 内容 |
|------|------|
| Spec | [PRD.md](./PRD.md) FINAL v1.0 |
| Plan | [IMPLEMENTATION_PLAN.md](./IMPLEMENTATION_PLAN.md) |
| 链 | Monad Testnet **`chainId 10143`** |
| 主赛道 | 04 Trust Identity & AI Infrastructure |
| 日期 | 2026-10-11（Asia/Shanghai） |

实现以 PRD **§8 P0** 为准；经济数值以 PRD **§4.2** 为唯一冻结权威。

---

## 1. 架构总览

```
[Web 前端]
  棋盘（合法格 + moveFee 预览）· 双账本面板 · 临时钱包
  求援/盟约签名 · DemoDirector · EndgameReveal
        | JSON-RPC
[Monad 合约 · 10143]
  GameTable     开局/座位/胜负/破产/终局
  Economy       playBalance / Points / treasury / 折算
  MoveCommit    commit-reveal + 扣费钩子
  Covenant      诚意金 + 状态机 + slash
  AgentRegistry 最小 8004 风格身份+声誉
  IVerifier     ZK-ready（Stub = ECDSA-only，诚实标注）
        |
[AI Agent 服务]
  假诚意 / 油费刺客（可切换）· motiveLog · 自有键 · 永不索取用户钥
        |
[证明器]
  P0：无电路；P1：本地 snarkjs/noir（延期）
```

**信任边界**

| 组件 | 信任 |
|------|------|
| 合约 | **真源** |
| 前端 | 可伪显示；以链上为准 |
| AI Agent | 半可信；靠质押 / 声誉约束 |
| 聊天中继 | 不可信 |
| ZK 电路 / trusted setup | P1；须声明 |

**Tech stack：** Foundry (Solidity) · Vite+React · viem/wagmi · Node AI bot · `packages/shared` 镜像费用与棋规常量。

---

## 2. 合约模块

| 合约 | 职责 | 关键入口 |
|------|------|----------|
| `GameTable` | join / 座位 / AI 隐藏 / 破产 / 胜负 / finalize | `join(seat)` · `startGame()` · `finalizeGame(gameId)` |
| `Economy` | playBalance / Points / treasury / 折算 | `creditPlay` · `debitPlay` · 击败/终局结算 |
| `MoveCommit` | commit → reveal；**每步一笔 tx** 扣费 | `commitMove` · `revealMove` |
| `Covenant` | 诚意金 + 盟约状态机 + slash | `lockEarnest` · `activateCovenant` · `challengeBetrayal` |
| `AgentRegistry` | 最小 ERC-8004 风格身份+声誉 | `registerAgent` · `recordGameResult` |
| `IVerifier` / `StubVerifier` | ZK-ready；Stub **仅** ECDSA 路径 | 禁止空 `return true` 冒充完整 ZK |
| `FeeLib` | 与 `packages/shared/fees.ts` 镜像 | `moveFee(piece, from, to)` |

### 2.1 公开事件（Demo 可见）

```text
MoveFeePaid(gameId, seat, moveFee, playBalanceAfter)
CaptureSettled(gameId, attacker, victim, piece, pointsDelta, penalty)
SeatBankrupt(gameId, seat, killerOrZero)
EarnestLocked(gameId, covenantHash, amount)   // 无 seat
EarnestRefunded(gameId, covenantHash)
PointsSeized(gameId, killer, defeated, points)
BetrayalSlashed(gameId, covenantHash, amount)
AiRevealed(gameId, seat, motiveLogHash)
```

---

## 3. 费用公式（§4.2 / §4.3 冻结）

### 3.1 走子费

```text
distance = chebyshev(from, to)   // max(|Δx|, |Δy|)
moveFee  = (baseFee + distance * distUnit) * pieceMult[piece]
```

| 参数 | 值 |
|------|-----|
| `baseFee` | 0.010 MON |
| `distUnit` | 0.005 MON/格 |
| `pieceMult` | 车 2.0 / 马炮 1.5 / 象士 1.2 / 将 1.0 / 卒 0.6 |

**口播三例（单测必须对齐）：** 卒走1格 **0.009** · 车走5格 **0.070** · 马 distance=2 **0.030** MON。

扣费时机：`revealMove` 合法通过后从行棋方 `playBalance` → `moveFeeTreasury`。

### 3.2 双账本与入座

| 账本 | 单位 | 用途 |
|------|------|------|
| MON | 18 decimals | seatStake、playBalance、诚意金、bond、罚金、slash、奖池 |
| Points | `uint32`（非 ERC-20） | 吃子、击败吞并；终局按汇率折进奖池 |

| 参数 | 值 |
|------|-----|
| `seatStake` | **1 MON** |
| `playBalanceInitial` | 2 MON |
| `minPlayBalanceToStart` | 0.5 MON |
| `minAgentStake` | 1 MON（与人类对称） |
| `faucetPerHuman` | 3.2 MON |
| `timeoutPenalty` | 0.03 MON |
| `illegalRevealPenalty` | 0.05 MON |
| `maxPlies` | 80 |

`join`：`msg.value >= seatStake + playBalanceInitial`；锁 1 MON stake、记 2 MON play、Points=0。

### 3.3 吃子 / 击败 / 破产

| 项 | 规则 |
|----|------|
| 吃子 | 攻方 +`piecePoints`；被吃 −⌊points×0.5⌋ + 付 `capturePenalty`（分值×0.001 MON）；攻方仍付本次 `moveFee` |
| `piecePoints` | 卒10 / 士象30 / 马炮50 / 车100 |
| 击败 | 吞全部 Points；败者 seatStake **40%** → killer playBalance，**60%** → prizePool |
| 破产 | `playBalance < minAffordableLegalMoveFee` → **立即 autoResign**；seatStake **不得**垫走子费 |
| 终局 mainPool | 70% 胜者 / 20% Points 第二 / 10% 协议金库；胜者 seatStake 全退；剩余 playBalance 全退 |
| `pointToMonRate` | 0.001 MON/Point |

P1 砍出脊骨（常量保留勿实现）：`rumorPrice` / `accuseStake` / `accuseSlashOnAI`。

---

## 4. Commit-reveal 走子

```text
commitHash = keccak256(abi.encode(seat, from, to, piece, salt))
```

| 步骤 | 行为 |
|------|------|
| `commitMove(gameId, commitHash)` | 当前方提交承诺 |
| `revealMove(...)` | 校验 hash / 回合 / 合法着 → `FeeLib.moveFee` → `debitPlay` → `MoveFeePaid` → 更新棋盘 |

- MVP：**回合制**当前方 commit → 立即进入 reveal 窗口（每步一笔确认）。
- 非法 reveal：扣 `illegalRevealPenalty`；同 ply 最多 2 次后按超时。
- 超时：先扣 `timeoutPenalty` → 再跑破产检查 → 否则弃权一步。

---

## 5. 盟约 / 诚意金 / ZK-ready

### 5.1 预影像与状态机

```text
CovenantPreimage = { gameId, seat_i, seat_j, clauses[], bondAmount,
                     earnestBond, nonce, validFromPly, validToPly }
covenantHash = keccak256(abi.encode(CovenantPreimage))
```

```text
PendingEarnest → (Accept) Active | Reject/Timeout → Expired（退 earnest）
Active → Slashed | Fulfilled
```

每座活跃盟约 ≤ 1。

### 5.2 P0 路径

```text
i 加密 DM → j；同时 lockEarnest(covenantHash, 0.10 MON)   // 事件无 seat
j Accept → 双方补签条款 → activateCovenant（双 ECDSA；zkProof 可空）
  诚意金计入发起方 bond 份额（例：2 条款 bondTotal=0.30，各方 0.15；
  已锁 0.10 → 再补 0.05）
Active → 违约 reveal（如吃盟友士）→ challengeBetrayal
  → Slash(bond→受害方)；G1：Slash/终局揭示当事人
```

| 参数 | 值 |
|------|-----|
| `earnestBond` | 0.10 MON |
| `earnestTimeout` | 90s **或** 3 plies（先到） |
| `bondPerClause` | 0.15 MON |

**P0 条款（≥2）：** `NO_CAPTURE_ADVISOR`（Demo 主用）· `NO_EXPOSE_BEFORE_END`（占位谓词）· 可选 `MUTUAL_NON_CHECK`。

### 5.3 隐私档位与 ZK 诚实表

| 档 | 行为 | 冲奖 |
|----|------|------|
| G0 | 激活公开双方座位 | 不用 |
| **G1（MVP）** | 激活隐藏；Slash/终局揭示 | **必交** |
| G2 | Slash 仍隐藏座位 | 延期 |

| ZK 层 | 内容 | 标注 |
|-------|------|------|
| **P0** | hash + 双 ECDSA；UI/事件隐座位；`IVerifier` + Stub 仅 ECDSA | ZK-ready |
| **P1** | 最小 preimage ZK（circom/Noir） | deferred |
| **P2** | G2 | 不承诺 |

---

## 6. AI Agent

| 项 | 约定 |
|----|------|
| 身份 | 协议指定恰好 1 座；自有 Agent EOA |
| 密钥 | **永不持有**人类私钥；对局禁热补 `playBalance` |
| P0 必做 | **假诚意**：Active 盟约履约约 10 手后吃盟友士 / 攻帅 |
| 可脚本切换 | **油费刺客**：远途车威胁；`motiveLog.forcedBurnMON` |
| 启发式 | 吃子净分 − λ·fee − 被将军惩罚；能完局即可 |
| 终局 | `motiveLog` 哈希上链 → `AiRevealed` → `AgentRegistry.recordGameResult` |

声誉字段（最小）：`games` / `wins` / `slashed` / `betrayalIndex` / `trustScore` / `forcedBurnMonTotal`。

---

## 7. 前端

| 模块 | 说明 |
|------|------|
| `Board` | 2D 顶视；点己子 → 高亮合法格 + **moveFee 预览** → commit/reveal |
| `ScorePanel` | `playBalance (MON)` \| `points` \| `seatStake 锁定中` |
| `AllianceModal` | 求援 / 条款 / 双签；**无**指控/谣言 UI |
| `DemoDirector` | drain / 触发窗口（Demo 糖衣） |
| `EndgameReveal` | AI 座、motiveLog、trustScore |
| `wallet` | ephemeral session wallet；faucet 提示；钥不发 Agent |
| `chain` | Monad Testnet `10143` |

公开可见：棋盘、行棋方、已揭示走子、Points、playBalance、公开事件。  
私有：AI 身份、盟约明文、求援 DM、未揭示 commit。

---

## 8. 部署 Monad 10143

```bash
# foundry
forge script script/Deploy.s.sol:Deploy \
  --rpc-url $MONAD_RPC --broadcast --chain 10143
```

部署输出应包含：`GameTable` · `Economy` · `Covenant` · `AgentRegistry` · `StubVerifier` 地址。

| 项 | 值 |
|----|-----|
| chainId | **10143**（testnet） |
| 主网 143 | 仅 README 步骤，不阻塞 |
| Demo | `scripts/demo-harness.ts` 对齐 PRD §9 |
| 环境 | `MONAD_RPC` · deployer `PRIVATE_KEY` · `AGENT_KEY` |

同步确认动画 `eth_sendRawTransactionSync` 为 **P1 加分**，非阻塞。

---

## 9. P0 文件图

```
sanguo-xiangqi/
├── README.md
├── foundry.toml
├── .env.example
├── packages/shared/
│   └── src/{constants,fees,board,pieces,index}.ts
├── contracts/
│   ├── src/
│   │   ├── GameTable.sol
│   │   ├── Economy.sol
│   │   ├── MoveCommit.sol
│   │   ├── Covenant.sol
│   │   ├── AgentRegistry.sol
│   │   ├── interfaces/{IVerifier,IEconomy,IGameTable}.sol
│   │   ├── verifiers/StubVerifier.sol
│   │   └── libraries/FeeLib.sol
│   ├── script/{Deploy,DemoSeed}.s.sol
│   └── test/*.t.sol
├── frontend/src/
│   ├── components/{Board,ScorePanel,AllianceModal,DemoDirector,EndgameReveal}.tsx
│   ├── lib/{chain,wallet,contracts,fees}.ts
│   └── hooks/{useGame,useMoveCommit}.ts
├── agent/src/
│   ├── index.ts · seatDriver.ts · motiveLog.ts
│   └── policy/{heuristic,betrayal,gasAssassin}.ts
├── circuits/README.md          # P1 占位
├── scripts/demo-harness.ts
└── docs/{PRD,TECHNICAL,IMPLEMENTATION_PLAN}.md
```

---

## 10. 非目标（本版不做）

- 谣言商店、完整指控投票 UI  
- 完整 ZK 电路 / G2 Slash 隐座位  
- 完整冷门三人象棋规则与残局库  
- 去中心化聊天、生产级 Paymaster、匹配大厅、排行榜、移动端  
- 主网 143 正式运营、多 AI / 0 AI 房、大模型对话  
- 借贷垫付 seatStake、跨局 Points NFT  
- 向评委隐瞒 mock 组件  
- 用 seatStake 垫走子费  

Buffer 日（约 10/13 CST）**只修**：不能完局 / 不能扣费 / 不能 slash——禁止新功能与 P1。

---

*TECHNICAL · 对齐 FINAL PRD v1.0 与 IMPLEMENTATION_PLAN · 2026-10-11 Asia/Shanghai*
