# 三国棋局 / Shadow Xiangqi — 最终产品需求文档（FINAL PRD）

| 字段 | 内容 |
|------|------|
| 产品中文名 | 三国棋局 |
| 产品英文名 | Shadow Xiangqi |
| 版本 | **FINAL v1.0（冲奖提交版）** |
| 文档日期 | 2026-10-11（Asia/Shanghai） |
| 提交窗口 | Monad Metropolis Hackathon，约 2026-10-13 前提交 |
| 主赛道 | **04 Trust Identity & AI Infrastructure**（Primary） |
| 副叙事 | Social Gameplay / Deception（README 一句带过即可） |
| 链 | Monad Testnet `chainId 10143`（主网 143 仅文档，不阻塞） |

**一句话定位：**  
三人象棋桌上藏着一个押金 AI 卧底——**每步一笔 Monad 交易**烧 MON、吃子赚 Points；用诚意金 + ZK-ready 盟约秘密求援，背刺链上罚没；终局揭 AI 动机与声誉。

---

## 1. 定位

### 1.1 产品是什么

在 **Monad 快确认** 上跑的三人象棋社交欺骗局：三座中恰好 **1 座是 bonded AI 卧底**。人类不知谁是 AI；每步走子真实扣 MON；秘密结盟先付诚意金；违约 slash；终局揭示 AI 与 `motiveLog`，并写入 Agent 声誉。

棋规声明：**可执行简化版三人象棋**，inspired by Sanren Xiangqi——不做规则百科全书。

### 1.2 为什么能冲奖（赛道 04）

| 赛道诉求 | 本产品落地（Demo 可见） |
|----------|-------------------------|
| AI Agent 身份与声誉 | 最小 ERC-8004 风格 `AgentRegistry`：终局写入胜/负/slash/`forcedBurnMon` |
| 可信 AI（bonded） | AI 与人类对称锁 `seatStake = 1 MON`；背刺/违约可 slash；对局禁热补油 |
| 隐私证明（ZK-ready） | 诚意金与盟约 commitment 上链不露当事人；P0 = hash + 双 ECDSA + UI 隐匿；`IVerifier` + README 升级路径 |
| 链上可信交互 | **每步 = 一笔 tx**（commit→reveal）；扣费/slash/揭示均可审计 |

### 1.3 成功标准（提交即必须）

1. Testnet **10143** 完整一局可跑通（2 人 + 1 AI）。
2. Demo 脊骨全真上链：入座 → fee 预览走子 → 诚意金盟约 → 背刺 slash → AI 揭示 + 声誉。
3. 双账本可见：MON 扣费 + Points 记分；至少一次击败吞分或破产。
4. AI **永不接触**人类私钥；人类用临时会话钱包。
5. README：1 行 pitch + 架构 + **诚实失败/ZK 层级表** + Demo 脚本 + 部署地址与示例 tx。

---

## 2. 冲奖策略

### 2.1 原则

1. **Prize-first**：范围极窄；3 分钟戏剧峰值优先于功能广度。
2. **每步一笔 Monad tx**：走子确认快到可以当音效卡点——这是 Monad 叙事钩子。
3. **诚实非目标**：谣言店、指控投票、完整 ZK 电路、完整棋规全部延期并写清。
4. **一条强制情绪曲线**：paranoia → gas war → betrayal → slash → AI reveal。

### 2.2 冲奖优先级

| 优先级 | 模块 | 说明 |
|--------|------|------|
| **P0 必交（冲奖脊骨）** | 入座 + seatStake/playBalance | 三座满开局；恰好 1 AI |
| **P0** | Commit-reveal 走子 + moveFee | 合法格 fee 预览；reveal 扣 MON |
| **P0** | 吃子 Points + capturePenalty + 击败吞分 | 双账本 |
| **P0** | 破产 autoResign | 付不起任何合法着 → 出局 |
| **P0** | 诚意金 lockEarnest → Accept → Active | 第三方不见当事人 |
| **P0** | 盟约条款 ≥2 + challenge Slash | 戏剧高潮 |
| **P0** | ZK-ready：hash + 双 ECDSA + `IVerifier` 接口 | README 诚实表；禁止 stub 冒充完整 ZK |
| **P0** | AI Agent 一座 + 至少 1 种背刺（假诚意）可触发 | 自有 EOA；可脚本切油费刺客 |
| **P0** | 终局 AI 揭示 + motiveLog + AgentRegistry | 赛道 04 闭环 |
| **P0** | 部署 10143 + 3 分钟 Demo harness | 地址/tx 可复现 |
| **P1 有时间再做（不阻塞）** | 最小 preimage ZK（circom/Noir） | 接口已预留 |
| **P1** | 匿名「有人结盟了」信号、导演一键 drain | Demo 糖衣 |
| **P1** | `eth_sendRawTransactionSync` 同步确认动画 | 加分 |
| **P1 / 明确砍** | 谣言商店、指控投票 UI、G2 Slash 仍隐座位、主网运营、匹配大厅、完整冷门棋规 | **不进冲奖 MVP** |

### 2.3 评委会看到什么（3 分钟）

| 秒 | 评委感知 | 链上证据 |
|----|----------|----------|
| 0:00–0:20 | 「三座各锁 1 MON，必有卧底 AI；人不交钥」 | `join` ×3；AI 身份隐藏 |
| 0:20–0:45 | 「每步烧 MON——车远走很贵、卒很便宜」 | `MoveFeePaid`；fee 预览 UI |
| 0:45–1:10 | 「秘密求援掏诚意金；第三方不知是谁」 | `EarnestLocked(covenantHash)` 无 seat |
| 1:10–1:40 | 「假忠诚履约」 | Active 盟约；Points 变动 |
| 1:40–2:15 | **高潮：背刺 → Slash → 余额跳动** | `BetrayalSlashed` |
| 2:15–2:40 | 出局吞 Points / 破产 | `PointsSeized` / `SeatBankrupt` |
| 2:40–3:00 | 揭 AI + motiveLog + 声誉；点题赛道 04 | `AiRevealed` + Registry |

**口播收束：**「在 Monad 上，背刺罚没和扣油费确认快到可以当音效。」

---

## 3. 核心玩法

### 3.1 角色

| 角色 | 说明 |
|------|------|
| 人类 ×2 | 临时会话钱包；不知谁是 AI |
| AI 卧底 ×1 | 协议指定一座；自有 Agent EOA + 对称质押；目标：存活、逼人类互烧 MON、收割 Points |
| 观战 | 公开棋盘 / Points / playBalance / 公开事件；不见盟约当事人与 AI 身份 |

### 3.2 主循环（冲奖脊骨）

```
入座锁 seatStake(1 MON) + 注入 playBalance
    → 私下指定恰好 1 个 AI 座
    → 公开棋盘：commit-reveal 走子，每步扣 moveFee（一笔 tx）
    → 吃子：Points↑ / 被吃方 capturePenalty MON
    → 可选：加密求援 + 链上诚意金 → Accept → ZK-ready 盟约 Active
    → 背刺：条款违约 → challenge → Slash(bond→受害方)
    → 出局（将死 / 破产）→ 吞 Points + 40% seatStake 分成
    → 终局：Points 折现 → 揭 AI + motiveLog → 声誉 → 分锅
```

### 3.3 开局

1. 座位固定 **A / B / C**（三角三营简化布局）。
2. `join(seat)`：`msg.value >= seatStake + playBalanceInitial`；锁 1 MON stake、记 2 MON play、Points=0。
3. AI 座：commit-reveal / Demo 导演预选；人类 UI **不显示**。
4. 人类 ephemeral wallet（前端生成；faucet 灌测币）。AI 用运营方 Agent EOA——**钥匙隔离，禁止热补 playBalance**。

### 3.4 对局

- **公开：** 棋盘、行棋方、已揭示走子、Points、各座 playBalance、公开事件。
- **私有：** AI 身份、盟约明文、求援 DM、未揭示 commit。
- **行棋：** 点己子 → 高亮合法格（**同时显示预估 moveFee**）→ 点目标 → 校验余额 → `commitMove` → 窗口内 `revealMove` 扣费。
- **破产（唯一口径）：** 当前座 `playBalance < minAffordableLegalMoveFee` → **立即 autoResign**。seatStake **不得**垫走子费。
- **超时未 reveal：** 先扣 `timeoutPenalty`；再跑破产检查；否则弃权一步。
- **非法 reveal：** 扣 `illegalRevealPenalty`；同 ply 最多 2 次后按超时。

### 3.5 胜负（可执行简化）

1. 将/帅被吃或无法解将 → 该阵营出局（触发击败结算）。
2. 破产 → 出局。
3. 仅剩一方未出局 → 该方胜。
4. 达 `maxPlies = 80` → Points + 子力价值决胜。
5. 规则细节冲突 → 以本 PRD 简化为准；README 声明 inspired by Sanren Xiangqi。

### 3.6 AI 策略（P0 最少交付）

| 策略 | P0 要求 | Demo 价值 |
|------|---------|-----------|
| **假诚意（必做）** | Active 盟约履约约 10 手后吃盟友士/攻帅 | 背刺高潮 |
| **油费刺客（可脚本切换）** | 远途车威胁；motiveLog 记 `forcedBurnMON` | 经济高光 |
| 启发式走子 | 吃子净分 − λ·fee − 被将军惩罚 | 能完局即可 |

禁止：持有人类钥、对局中热补油、复杂大模型对话（非必须）。

---

## 4. 经济

> 设计目标：每一步都是成本效益题；AI 可用油费战争折磨人类。  
> 下表为 **FINAL 冻结默认**；标〔可调〕者仅允许配置覆盖，禁止文档留白 TBD。

### 4.1 双账本

| 账本 | 单位 | 存哪 | 用途 |
|------|------|------|------|
| MON | 18 decimals | 合约余额 | seatStake、playBalance、诚意金、bond、罚金、slash、奖池 |
| Points | `uint32`（非 ERC-20） | 链上记分 | 吃子、击败吞并；终局按汇率折进奖池 |

UI 始终并排：`playBalance (MON)` | `points` | `seatStake 锁定中`。

### 4.2 冻结参数总表（v0.2 附录 C → FINAL 唯一权威）

| 参数 | 值 | 备注 |
|------|-----|------|
| `seatStake` | **1 MON** | 入座强制 |
| `playBalanceInitial` | **2 MON** 〔可调〕 | 作战余额 |
| `minPlayBalanceToStart` | **0.5 MON** 〔可调〕 | 低于不可入座 |
| `minAgentStake` | **1 MON** | 与人类对称 |
| `faucetPerHuman` | **3.2 MON** 〔可调〕 | 1+2+0.2 Gas 缓冲 |
| `baseFee` | **0.010 MON** 〔可调〕 | |
| `distUnit` | **0.005 MON/格** 〔可调〕 | Chebyshev 距离 |
| `pieceMult` | 车 **2.0** / 马炮 **1.5** / 象士 **1.2** / 将 **1.0** / 卒 **0.6** 〔可调〕 | |
| `piecePoints` | 卒10 / 士象30 / 马炮50 / 车100 〔可调〕 | |
| `capturePenalty` | **分值 × 0.001 MON** 〔可调〕 | 卒0.010 … 车0.100 |
| `captivePointLossRatio` | **0.5** 〔可调〕 | 被吃方丢一半对应分（地板） |
| `defeatStakeShareBps` | **4000（40%）** 〔可调〕 | 40%→killer playBalance；60%→prizePool |
| `pointToMonRate` | **0.001 MON/Point** 〔可调〕 | 100分=0.1 MON |
| 终局 mainPool 分配 | **70% 胜者 / 20% Points 第二 / 10% 协议金库** | 胜者自己 seatStake 全额退回；剩余 playBalance 全退 |
| `earnestBond` | **0.10 MON** 〔可调〕 | 求援单方锁 |
| `earnestTimeout` | **90s 或 3 plies**（先到）〔可调〕 | |
| `bondPerClause` | **0.15 MON** 〔可调〕 | |
| `maxActiveCovenantsPerSeat` | **1** | |
| `timeoutPenalty` | **0.03 MON** 〔可调〕 | |
| `illegalRevealPenalty` | **0.05 MON** 〔可调〕 | |
| `maxPlies` | **80** | |
| `rumorPrice` / `accuseStake` / `accuseSlashOnAI` | 0.05 / 0.10 / 0.40 MON | **P1 砍出冲奖脊骨；常量保留勿实现** |

### 4.3 走子费用

```text
distance = chebyshev(from, to)   // max(|Δx|,|Δy|)
moveFee  = (baseFee + distance * distUnit) * pieceMult[piece]
```

口播示例：卒走1格 **0.009 MON**；车走5格 **0.070 MON**；马 distance=2 **0.030 MON**。

扣费时机：`revealMove` 合法通过后从行棋方 `playBalance` 扣入 `moveFeeTreasury`。

### 4.4 吃子 / 击败 / 破产

**吃子：** 攻击方 +`piecePoints`；被吃方 −⌊points×0.5⌋ 且付 `capturePenalty`；攻击方仍付本次 `moveFee`。

**击败（原子）：**

1. `points[killer] += points[defeated]`；败者清零。
2. 败者 `seatStake` 的 40% → killer `playBalance`；60% → `prizePool`；败者 stake 记账清零。
3. 未决诚意金/盟约 MVP：无违约则退剩余 bond；PendingEarnest 直接退。

破产无唯一杀手时：Points 进 `orphanPoints`（终局折现）。

### 4.5 关键公开事件

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


### 4.6 双玩法一等公民（冲奖补丁 · 2026-10-11）

| 路线 | 体验 | 规则约束 |
|------|------|----------|
| **氪金 / Whale** | 高 `playBalance` 打得起远程车等昂贵合法着；UI 清晰展示 fee | **绝不允许非法着法**；人类可选 `depositPlayBalance`（「补给油费」）热补作战余额 |
| **性价比 / Budget** | 逐步精算；短步进（卒）省油；逼对手烧光后破产 | 棋盘「省油推荐」高亮**最便宜合法**目标格；fee 悬停预览 |

**公平性：** AI **禁止**热补（合约 `require(!isAi)`）。PRD 原「对局禁热补」收紧为 **仅禁 AI**；人类热补为可选 Whale 功能，README/UI 标明。


### 4.7 氪金货币化玩具（P0 已落地 / P1 文档）

| 玩具 | 状态 | 规则 |
|------|------|------|
| 多开诚意金要约 | **P0** | `playBalance ≥ 3 MON` 时 pending 上限 3；否则 1。第 2+ 条各付 `EXTRA_EARNEST_PREMIUM=0.05 MON` |
| 疏火 `BUY_PEACE` | **P0** | 诚意金 + 贿金上链承诺；接受后 N plies（默认 8）不得吃对方子；事件不露当事人；违约 Slash |
| 补给油费 | **P0** | 人类 `depositPlayBalance`；AI 合约禁止 |
| 代付盟友走子油费 | **文档 P1** | 一笔代付指定盟友下一步 `moveFee`（不改棋规） |
| 匿名谣言购买 | **P1 已砍** | 常量保留，不做 UI |

性价比反制：拒贿、收钱后背刺（吃 Slash 风险）、廉价着法耗干鲸鱼。**非法着法永远禁止。**

## 5. ZK / 盟约

### 5.1 目标

- **证明：** 我持有针对本 `gameId` 的有效双签盟约，且我是当事人。
- **不暴露（激活时）：** 盟友是谁、条款明文、求援当事人。
- **公开：** `covenantHash`、锁仓金额、状态机；Slash/终局按 G1 揭示当事人。
- **可玩：** 诚意金防空聊；背刺可罚；履约可退。

### 5.2 数据结构与状态机

```text
CovenantPreimage = { gameId, seat_i, seat_j, clauses[], bondAmount,
                     earnestBond, nonce, validFromPly, validToPly }
covenantHash = keccak256(abi.encode(CovenantPreimage))
```

状态：`PendingEarnest → (Accept) Active` | `Reject/Timeout → Expired(退 earnest)`；`Active → Slashed | Fulfilled`。

每座活跃盟约 ≤ 1。

### 5.3 求援 → 盟约 → Slash（P0 路径）

```
i 加密 DM → j；同时 lockEarnest(covenantHash, 0.10 MON)  // 事件无 seat
j Accept → 双方补签条款 → activateCovenant（双 ECDSA；zkProof 可空）
  诚意金计入发起方 bond 份额（例：2 条款 bondTotal=0.30，各方 0.15；
  发起方已锁 0.10 → 再补 0.05）
Active → 违约 reveal（如吃盟友士）→ 受害方 challengeBetrayal
  → Slash(bond→受害方)；G1：Slash/终局揭示当事人
```

**P0 条款（≥2）：** `NO_CAPTURE_ADVISOR`（不吃对方士）、`NO_EXPOSE_BEFORE_END`（终局前不揭穿 AI——指控模块若未做则本条款可作占位谓词/文档对齐；Demo 主用前者）。可选第三：`MUTUAL_NON_CHECK`。

### 5.4 隐私档位与 ZK 诚实交付

| 档 | 行为 | 冲奖承诺 |
|----|------|----------|
| G0 | 激活公开双方座位 | 不用 |
| **G1（MVP）** | 激活隐藏；Slash/终局揭示 | **必交** |
| G2 | Slash 仍隐藏座位 | **延期** |

| ZK 层 | 内容 | Demo 标注 |
|-------|------|-----------|
| **P0 必交** | hash + 双 ECDSA；UI/事件隐座位；诚意金不写座位；`IVerifier` 接口 + Stub 仅 ECDSA 路径 | 「隐私前端 + 密码学承诺；ZK-ready」 |
| **P1** | 最小 preimage 知识证明（circom/Noir + groth16） | README 升级路径 |
| **P2** | G2 | 不承诺 |

**铁律：** 禁止 `return true` 空 Verifier 宣传「完整 ZK」。README 必须有真验证 vs stub 对照表。

---

## 6. Monad 落地

| Monad 特性 | 产品用法 |
|------------|----------|
| 快出块（~0.4s） | 每步一笔 tx；扣费/slash 可卡音效 |
| 隐藏钱包体验 | 临时会话钱包 + faucet（含作战余额） |
| `eth_sendRawTransactionSync` | P1：含收据确认后再播动画 |
| chainId **10143** | 提交部署 testnet；主网 143 仅 README 步骤 |
| 并行友好 | 每局 `gameId` 独立；盟约按 `covenantHash` 分片 |
| 叙事金句 | 「背刺罚没和扣油费确认快到可以当音效卡点」 |

Commit-reveal：`commitHash = keccak256(abi.encode(seat, from, to, piece, salt))`；MVP 回合制当前方 commit→立即 reveal 窗口。

---

## 7. 架构

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
  IVerifier     ZK-ready 接口（Stub = ECDSA-only，诚实标注）
        |
[AI Agent 服务]
  假诚意 / 油费刺客（可切换）· motiveLog · 自有键 · 永不索取用户钥
        |
[证明器]
  P0：无电路；P1：本地 snarkjs/noir（延期）
```

**建议目录：** `contracts/` · `frontend/` · `agent/` · `packages/shared/`（费用与棋规常量镜像）· `circuits/README.md`（P1 占位）· `scripts/demo-harness.ts` · `docs/`。

**信任边界：** 合约为真源；前端可伪显示以链上为准；AI 半可信靠质押/声誉约束；聊天中继不可信；ZK 电路正确性与 trusted setup 须声明。

---

## 8. P0 范围（冲奖 MVP）

### 8.1 必交

| 模块 | 范围 |
|------|------|
| 棋盘 | 三人简化布局；点合法格；三座轮流；**fee 预览** |
| 经济 | seatStake=1；moveFee；吃子 Points+penalty；击败吞分；破产；终局折现 70/20/10 |
| 诚意金/盟约 | lock/refund/Accept；≥2 条款；Active/Slash/Fulfill；G1 隐私 |
| ZK-ready | ECDSA + `IVerifier` + README 升级路径与诚实表 |
| AI | 1 座；假诚意背刺必做；油费刺客可脚本触发；完局；无用户钥 |
| Commit-reveal | 当前方；非法/超时罚 MON |
| 揭示/声誉 | AI 座 + motiveLog（建议含 forcedBurn）+ Registry 更新 |
| 部署/Demo | 10143；3 分钟剧本自动化 |

### 8.2 明确非目标（本版不进）

- 谣言商店、完整指控投票 UI  
- 完整 ZK 电路 / G2  
- 完整冷门三人象棋规则与残局库  
- 去中心化聊天、生产级 Paymaster、匹配大厅、排行榜、移动端  
- 主网 143 正式运营、多 AI / 0 AI 房、大模型对话  
- 借贷垫付 seatStake、跨局 Points NFT  
- 向评委隐瞒 mock 组件  

### 8.3 时间盒（10/11–10/13 CST）

| 日 | 焦点 |
|----|------|
| Day1 上午 | GameTable + Economy 扣费 + seatStake |
| Day1 下午 | 棋盘 UI + fee 预览 + 吃子/破产 |
| Day1 夜 | AI 完局 + Covenant P0（诚意金/ECDSA） |
| Day2 上午 | Slash + 终局揭示 + AgentRegistry |
| Day2 下午 | Demo 串演、README、部署 10143、录屏 |
| Buffer | **只修**不能完局/不能扣费/不能 slash；禁止新功能 |

---

## 9. Demo 脚本（3 分钟 · 必须可走通）

**标题（10s）：**  
「三国棋局——三人象棋里藏着押了真金的 AI 卧底。每步一笔 Monad 交易烧 MON；诚意金秘密结盟，背刺即罚没。」

| 时间 | 操作 | 解说 |
|------|------|------|
| 0:00–0:20 | 三座 join，各锁 **1 MON** + 作战余额；「1 名 AI 已隐藏」 | 对称质押；人不交钥 |
| 0:20–0:45 | 走 2–3 手；特写 **车远走 fee 跳升** vs 卒便宜 | 性价比；每步一笔 tx |
| 0:45–1:10 | A 危局 → 加密求援 + **诚意金 0.1 MON** → Accept → Active | 第三方不知是谁 |
| 1:10–1:40 | 履约数手；AI 装忠诚；Points 变化 | 建立信任 |
| 1:40–2:15 | **高潮：** 背刺吃士 → challenge → **Slash** | 戏剧峰值 |
| 2:15–2:40 | 出局 → **吞 Points** + 40% stake 分成（或导演 drain 破产） | 经济闭环 |
| 2:40–3:00 | 揭 AI、motiveLog、声誉；点题 **04 Trust/Identity/AI Infra** | 收束 |

**备用失败话术：** ZK 电路未就绪 → 切 P0「签名+承诺+UI 隐匿」；扣费、诚意金、slash、Points **仍真实上链**，指向 README 诚实表。

---

## 10. 非目标 / 风险

### 10.1 非目标（再强调）

不成完整象棋平台或赌场；不保证职业级 AI 棋力；不提供法律级匿名；不隐瞒 mock；不用 seatStake 垫油费。

### 10.2 风险与缓解

| 风险 | 缓解 |
|------|------|
| 两天做不完真 ZK | P0 ECDSA + 接口；剧本不依赖 G2/P1 |
| 经济参数失衡 | 冻结表 + DemoDirector 预置余额 |
| 三人规则争议 | 可执行简化 + inspired-by 声明 |
| AI 宕机 | 导演预录走子序列 |
| 临时钱包丢钥 | 仅测试币；faucet 重发 |
| 破产误触（fee 算错） | 合约 FeeLib 与 `packages/shared` 镜像；单测对齐口播三例 |
| 诚意金粉尘 | 默认每座 1 笔 PendingEarnest（Whale 可并行至 3）；超时 90s |
| 评委听不懂棋规 | **少讲规则，多讲背叛与油费与 AI 声誉** |

---

## 11. 验收清单

### 功能（P0）

- [ ] 部署 Monad Testnet `10143`；地址与示例 tx 可复现
- [ ] 开局 3 座、恰好 1 AI；各座 `seatStake = 1 MON` + `playBalance`
- [ ] 人类临时钱包；AI 不持用户键；对局无热补油
- [ ] 合法走子可至终局；合法格显示 `moveFee`
- [ ] Commit-reveal 上链；reveal 后 `MoveFeePaid` 可见（**每步一笔 tx**）
- [ ] 吃子：Points↑ + `capturePenalty`；击败吞全部分 + 40% stake
- [ ] 破产：付不起任何合法着 → autoResign
- [ ] 诚意金：lock → accept 入盟 / reject|timeout 退款；事件无当事人座位
- [ ] 盟约 ≥2 条款；Active → Slash 或 Fulfill；`BetrayalSlashed` 可观察
- [ ] 终局：Points 折现、AI + motiveLog、声誉更新
- [ ] `IVerifier` 存在；README 诚实标注 P0/P1/P2（无空 verifier 冒充）

### 演示与文档

- [ ] 1 行 pitch（中英）
- [ ] 3 分钟剧本可走通（扣费 + slash + 吞分/破产 + 揭示）
- [ ] 架构图 + 失败模式 + 「评委会看到什么」对齐本 PRD §2.3
- [ ] 棋规声明 inspired by Sanren Xiangqi
- [ ] 本 FINAL PRD 存放于 docs/PRD.md（与 workspace 源一致）

### 赛道

- [ ] 主文案对齐 **04 Trust Identity & AI Infrastructure**
- [ ] README 点到社交欺骗 + 油费性价比，但不喧宾夺主赛道

---

## 附录 A — 术语

| 术语 | 含义 |
|------|------|
| 三国棋局 / Shadow Xiangqi | 产品中英文名 |
| seatStake | 入座锁定 1 MON |
| playBalance | 作战余额（走子/罚金/诚意金） |
| Points | 吃子/击败记分；终局折现 |
| 诚意金 / earnestBond | 秘密求援单方锁定 MON |
| 盟约 / Covenant | 结构化秘密条约 + bond |
| 卧底 AI | 三座中唯一 Agent |
| Slash | 罚没违约 bond |
| motiveLog | AI 动机日志（哈希上链，终局公开） |
| G1 | 激活隐当事人；Slash/终局揭示 |

## 附录 B — Pitch

- **中文：** 三人象棋桌上藏着押金 AI 卧底——步步一笔 Monad 交易烧 MON、吃子赚分，诚意金隐匿结盟，背刺即罚没。
- **English:** Three-player Xiangqi with one staked AI mole — every move is a Monad tx that burns MON, captures earn points, earnest-bonded secret alliances, on-chain betrayal slashing.

## 附录 C — 示例盟约预影像

```json
{
  "gameId": "0x…",
  "seats": [0, 2],
  "clauses": [
    { "id": "NO_CAPTURE_ADVISOR", "params": {} },
    { "id": "NO_EXPOSE_BEFORE_END", "params": {} }
  ],
  "bondAmount": "300000000000000000",
  "earnestBond": "100000000000000000",
  "nonce": "0xabc…",
  "validFromPly": 8,
  "validToPly": 80
}
```

> `bondAmount = 0.30 MON`，`earnestBond = 0.10 MON`（18 decimals）。

## 附录 D — 氪金与性价比双玩法

同一套规则下两条体验路径，**合法走子永远优先于烧钱**。

| 路径 | 核心打法 | 经济动作 |
|------|----------|----------|
| **氪金（Whale）** | MON 多 → 敢走贵着法（远途车、高系数连动），用油费买节奏与压迫；**禁止非法着** | 中盘 **补给油费**；多线诚意金 / 疏火贿赂 / 代付盟友油费（见下） |
| **性价比（Budget）** | 压低每步 `moveFee`：短距、低系数；逼对手破产；Points/油耗比以小博大 | 不充值也能打完；破产规则仍生效 |

### 氪金具体玩法（可调数值）

- **多线诚意金求援 / 结盟：** 默认每座同时仅 **1** 笔 `PendingEarnest`；`playBalance` 高于阈值（建议 **≥ 3 MON**）可并行最多 **3** 笔 Pending，把战火引开、多头试探。每笔诚意金建议 **0.1 MON**（可调）。
- **疏火贿赂 `BUY_PEACE`：** 付钱换对方 **N 步**（建议 **3**）不攻己方 / 不吃约定子；对方可拒。上链只锁金额与承诺哈希，隐私同诚意金（事件不露当事人座位）。贿赂额建议 **0.15–0.5 MON**（可调）；接受后违约 → 走既有 Slash。
- **代付盟友一步油费：** 活跃盟约内，可代付盟友本步 `moveFee`（从己方 `playBalance` 扣）；每局上限建议 **5** 次或合计 **0.5 MON**（可调）。代付不改变走子合法性。
- **补给油费：** 人类中盘向 `playBalance` 充值；不改动 `seatStake`。

### 反制（性价比 / 收钱方）

- **收钱背刺：** 收诚意金或 `BUY_PEACE` 后违约 → 受害方 challenge → **Slash** 罚没。
- **拒贿：** 拒绝 / 超时退款，不暴露是谁拒了谁（同诚意金隐私）。
- **省油逼破产：** 短途缠斗抬对手油耗；逼其连最低合法着都付不起 → `autoResign`。

**UI（产品级）：**

- 合法格显示预估 `moveFee`（非法格不出现）。
- 可选 **「省油推荐」**：标出低费用 / 高 Points 效率候选（建议层）。
- **「补给油费」**、**「疏火贿赂」**、**「代付盟友」** 入口；余额与下一笔链上交易同步反馈。
- 多线 Pending 时 UI 显示「并行求援 N/上限」。

> 本附录不改动 §4.2 冻结表权威；并行 Pending、贿赂额、代付上限均为可调。实现分期：补给油费与多线诚意金可进演示增强；`BUY_PEACE` / 代付标 P1 亦可，但 README 须诚实标注。

---

*FINAL v1.0（冲奖提交版）· 2026-10-11 Asia/Shanghai · 主赛道 04 · 实现以 §8 P0 为准；P1/非目标不得阻塞演示。经济数值以 §4.2 为唯一冻结权威；双玩法见附录 D。*
