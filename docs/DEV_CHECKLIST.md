# 三国棋局 / Shadow Xiangqi — 代码评审 · 差距评估 · 开发清单

> **进度更新（第二轮已完成）**：P0-0 部署安全、P0 合约全部高危项、P1 钱包接入与配置化、
> P2 独立 AI agent 进程均已实现并实测通过。
> 测试 19 → **31**（forge）+ 8（shared）；新增全仓库 `pnpm typecheck` 与 GitHub Actions CI。
> 详见文末 **§10 附录：本轮已完成 / 仍未完成**。

| 字段 | 内容 |
|------|------|
| 评审日期 | 2026-10-11 |
| 被评审版本 | `2b8cd97` (main, 与 origin/main 同步) |
| 代码规模 | 合约 1,304 行 · 前端 1,933 行 · shared 803 行 · 脚本 134 行（合计约 4,174 行，不含依赖与测试） |
| 评审方式 | 全量阅读 + 本地实跑复现 + 在运行中的 EVM 上验证漏洞 |
| 结论 | **演示级 Demo（本机单机）可用；产品级不可用** |

---

## 0. 一句话结论

> 这套代码是一个**做得相当完整的本机演示控制台**，不是一个产品。
> 经济模型、费用公式、commit-reveal、诚意金/双签/罚没、终局 70/20/10 全部**真的上链且真的对**；
> 但**没有任何钱包接入、没有第二个真人能入座、AI 不会自己走棋、测试网一次都没部署过**，
> 外加**三个已实证的合约漏洞 + 一个差点造成真实资金损失的部署脚本缺陷**。

**距离"陌生人打开链接就能玩"：约 8–12 个工程师人日**（其中 3 项是架构级改造，不是修 bug）。
**距离"可上测试网公开体验的 Beta"：约 20–30 人日**（含撮合、索引、运维、规则补全）。

**动手顺序（重要）**：先做 **P0-0 部署安全** → 再做 **P0 合约三漏洞** → 再谈其余。
理由：不改部署脚本就动测试网，等于把公开私钥喂给真网络（实测已触发一次，仅因余额不足未成交）。

---

## 1. 实测基线（我实际跑出来的，不是推测）

| 检查项 | 命令 | 结果 |
|--------|------|------|
| 合约测试 | `forge test` | ✅ **19/19 通过** |
| shared 测试 | `pnpm --filter @sanguo/shared test` | ✅ **8/8 通过** |
| 前端类型检查 | `cd frontend && npx tsc -b` | ✅ **0 error**（类型系统很干净） |
| 前端生产构建 | `npx vite build` | ✅ 成功，499.5 kB / gzip 155 kB |
| 合约体积 | `forge build --sizes` | ✅ GameTable 15.6 KB（限 24 KB），无超限 |
| 本地部署 | `bash scripts/deploy-local.sh` | ✅ 成功，4 合约 + 地址回写 |
| **3 分钟 Demo 全链路** | `npx tsx scripts/demo-harness.ts` | ✅ **成功，21 笔真实交易，exit 0** |
| 测试网 10143 部署 | 查 `contracts/broadcast/` | ❌ **只有 31337，一次都没部署过**（README 已诚实承认） |

**Demo harness 实测输出**（节选，全部 `status success`）：

```
createGame → join×3 → commitMove/revealMove ×5 → lockEarnest → activateCovenant
→ commitMove/revealMove（真吃士）→ challengeBetrayal → directorDrain ×2 → finalizeGame
cheap 0.009  chariot 0.050
demo game 1 done
```

所以：**"能不能演示"这个问题的答案是能，而且脊骨是真的。** 下面讲"离产品有多远"。

---

## 2. 真正实现了的东西（不要重做）

这部分是资产的真实清单，避免后续重复劳动：

- **费用引擎三处一致**：`FeeLib.sol` ↔ `packages/shared/fees.ts` ↔ 前端。PRD §4.3 口播三例（卒 0.009 / 车 5 格 0.070 / 马 0.030）有单测钉死。
- **经济参数与 PRD §4.2 冻结表逐项对齐**：seatStake 1 / playBalanceInitial 2 / baseFee 0.010 / distUnit 0.005 / pieceMult / piecePoints / capturePenalty / captivePointLossRatio 0.5 / defeatStakeShareBps 4000（实测 40% 给击杀方、60% 进奖池）/ 终局 70/20/10 —— **全部核对无误**。
- **棋规两端一致**：`board.ts:111-156` 与 `GameTable.sol:580-617` 逐条对比（将/兵、士、象眼、马腿含挪过的 (6,9) 马、车射线、炮隔子、自吃禁止）**未发现分歧**；`initialBoard()` 与 `_setupInitialBoard` 逐格一致。**UI 不会给合约会拒绝的着法。**
- **commit-reveal 真实实现**：hash 格式 `keccak256(abi.encode(seat,fx,fy,tx,ty,piece,salt))` 三处一致；每步两笔真交易。
- **诚意金 → 双 ECDSA → 盟约 Active → 证据 Slash → 划入受害方 playBalance**，`StubVerifier` 只接受空证明（诚实，没冒充 ZK）。
- **破产判定按"最便宜合法着"**，且 seatStake 不垫油费；`expireCommit` 超时罚金；AI 座禁止热补。
- **前端 ABI 与编译产物零漂移**（4 个 ABI JSON 程序化比对通过）。
- **前端视觉完成度高**：三营三角棋盘 + 中宫灯笼、双账本、省油推荐、事件流。这部分可以直接留用。

---

## 3. 🔴 必须先修的三个漏洞（我已在运行中的 EVM 上实证复现）

> 这三条都**不是理论风险**。我用 `cast` 在本地链上真实打出了交易，下面是原始证据。

### B1 — 任何人都能在开局前弄死任意一局（已实证）

**位置**：`contracts/src/GameTable.sol:359`（守卫）+ `:496-500`（`_aliveCount`）+ `:361-367`（胜者循环）

```solidity
require(g.phase == Phase.Finished || _aliveCount(g) <= 1 || g.ply >= MAX_PLIES, "not done");
```

`_aliveCount` 数的是"未出局且 player != 0"的座。**Lobby 阶段只有 1 人入座时，`_aliveCount == 1`，守卫直接通过。** 未分配的 gameId（结构体全零）同样通过。

**我的实测**（game 2，只有一个真人入座）：

```
攻击前:  phase = 0 (Lobby)
攻击者:  0x9965507D...（随机第三方，不是玩家，不是 owner）
调用:    finalizeGame(2, 0x00..01)  →  status 1 (success)
攻击后:  phase = 2 (Finished), aiRevealed = true, winnerSeat = 2  ← address(0) 被加冕为胜者
再入座:  join(2, 1)  →  revert "lobby"
```

**资金后果**（我读了链上状态）：

```
seat 0: player=0x90F7...b906, seatStake = 1e18 (还在账上), playBalance = 0
合约余额: 5.1576e18 wei
```

那 1 MON 的 `seatStake` **永远拿不回来了**——因为整个 `GameTable` **没有任何 withdraw/sweep/claim 函数**（我 grep 过，确实没有）。`AiRevealed`、`GameFinalized`、以及一条写到 `AgentRegistry` 的伪造战绩也一并产生了。

**修复**：
```solidity
require(g.phase == Phase.Finished ||
        (g.phase == Phase.Playing && (_aliveCount(g) <= 1 || g.ply >= MAX_PLIES)), "not done");
require(gameId > 0 && gameId < nextGameId, "unknown game");
// 胜者循环补上同样的谓词：
if (!g.seats[i].eliminated && g.seats[i].player != address(0)) { ... }
```

---

### B2 — 背刺者可以自己"履约"跑掉，罚没变成可选（已由代码确认，零违规检查）

**位置**：`contracts/src/Covenant.sol:283-297`

```solidity
function fulfillCovenant(bytes32 covenantHash) external {
    CovenantData storage c = covenants[covenantHash];
    require(c.status == Status.Active, "active");
    require(msg.sender == c.proposer || msg.sender == c.counterparty, "party");
    ...
```

**全文 15 行里没有任何 `advisorBetrayal` / `peaceBetrayal` / capture 检查**（我 grep 计数为 0）。

背刺者（按定义就是 party）只要抢在受害方 `challengeBetrayal` 之前调用 `fulfillCovenant`，盟约就变成 `Fulfilled`、bond 退回，受害方随后的 challenge 会以 `"active"` revert。

**这条打的是产品的核心卖点**：README / PRD §2.3 的戏剧最高潮"背刺 → Slash"目前依赖**作弊方的善意**。

**修复**：`fulfillCovenant` 增加终局/窗口守卫（例如 `require(phase == Finished)`），或改为 `requestFulfill` + 时间锁，保证 `challengeBetrayal` 永远先手。

---

### B3 — PRD 的 G1 隐私（"必交"）在链上是假的（已由代码确认）

**位置**：`contracts/src/Covenant.sol:57-58`

```solidity
mapping(uint256 => mapping(uint8 => bytes32)) public activeBySeat;
mapping(uint256 => mapping(uint8 => uint8)) public pendingCountBySeat;
```

两个映射都是 `public`。盟约一 Active，`activeBySeat(gameId, i)` 与 `activeBySeat(gameId, j)` 立刻变成同一个非零 hash，**谁和谁结盟一眼可见**——而 `getCovenant()` 还在很努力地把 `seatI/seatJ` 遮成 `255`（`Covenant.sol:308-315`）。**遮蔽是装饰性的。**

顺带两处泄漏：
- `pendingCountBySeat` 在激活前就暴露"哪个座在求援"；
- ~~**AI 座位在 calldata 里**~~：已改为 `createGame()`（无参数），`aiSeat=255`；第一个已注册 Agent 入座时绑定。事件仍然不写 `isAi`。

（`pendingCountBySeat` 激活前暴露求援座的问题仍在，见下。）

**修复**：两个映射改 `internal`（这是**两行**的修改）；`createGame` 改收 `aiSeatCommit`，终局再 reveal。

---

## 4. 🟠 高危（会让"真实体验"直接崩掉）

| # | 问题 | 位置 | 后果 |
|---|------|------|------|
| H1 | **非胜者的 seatStake 永不退还、也永不入账** | `GameTable.sol:526-559` | 只有胜者的 stake 被退（`:533`）；第 2 名和其余座只退 playBalance。实测 seat 0 留下 `seatStake=1e18` 而合约无提现函数 → **每局约 2 MON 永久卡死** |
| H2 | **`finalizeGame` 可重入** | `:380-381` | `_payout()` 外部调用在前，`g.settled = true` 在后 → 合约胜者可重入，重复写 `AgentRegistry`（战绩/trustScore/forcedBurn 双计），砸的是"Trust Identity"这条赛道 |
| H3 | **`activateCovenant` 让调用方替对方出 bond** | `Covenant.sol:183-187` | `require(msg.value >= proposerNeed + each)` 不管调用者是谁。0.15/0.15 的盟约变成 0.10/0.20，履约时对方白拿 0.05 |
| H4 | **`AgentRegistry.setGameTable` 是无权限的一次性初始化** | `AgentRegistry.sol:34-37` | 部署期可被抢跑。抢到后 `finalizeGame` 永远 revert，**且 GameTable 没有 `setRegistry`** → 所有质押永久锁死 |
| H5 | **任何人都能伪造 AI 的 motiveLogHash** | `GameTable.sol:394-401` | `revealAiOnly` 在 Finished 后对任何人开放，且没有 getter，UI 只能读事件 → 首个调用者**替 AI 写遗言** |
| H6 | **0.05 诚意金溢价收了但从不记账、从不退** | `Covenant.sol:106-110` vs `:139` | `premium` 从未存入 `earnestAmount`，`refundExpiredEarnest` 只退本金 → 0.05 永久留在 Covenant，无 sweep |
| H7 | **盟约 hash 根本不绑定条款** | `Covenant.sol:196-206` | 签名只签 32 字节 hash；`clauses` 来自 calldata 且**从未与 hash 校验**。条款集与 `bondTotal` 由调用者现选 → **对方可以激活你从没同意的条款**（PRD §5.2 的 `CovenantPreimage` 没实现） |
| H8 | **金库无法取出** | `GameTable.sol:63-64`（全库无 withdraw） | `protocolTreasury` / `moveFeeTreasury` 只进不出，"10% 协议金库"是死钱 |

---

### 🚨 B0 — 部署脚本可能把你的真钱发到真网络（实测触发，未造成损失）

> 这是本次评审里**唯一一次差点造成真实损失**的发现，虽然属于运维而非合约逻辑，但优先级应高于一切。

`scripts/deploy-testnet.sh:9-14` 会**无条件 source 根目录 `.env`**：

```bash
if [[ -f "$ROOT/.env" ]]; then
  set -a
  source "$ROOT/.env"     # ← 覆盖调用者显式传入的环境变量
  set +a
fi
```

而 `.env.example:3` 里 `PRIVATE_KEY` 就是**公开的 Anvil 0 号钥** `0xac0974be…ff80`。
于是 `cp .env.example .env` 这个 README 指引的动作，会把一把全世界都知道的私钥喂给测试网部署脚本。

**实测经过**：把 `MONAD_RPC` 指向本地链以测试守卫时，脚本的 `source .env` 把它**静默覆盖**成了 `https://testnet-rpc.monad.xyz`，并向**真实的 Monad 测试网 RPC** 发起了广播尝试。仅因为该地址余额 0.00098 MON、低于所需的 1.68 MON 而失败（nonce 稳定在 468，`receipts: 0`，所有 hash 为 `None`），**没有产生任何交易**。

**顺带发现**：Anvil 0 号钥在真实 Monad 测试网上 **nonce = 468** —— 说明这把钥是公开且被大量人共用的。**任何人往它打钱，都会被别人立刻转走。**

**另外**：`deploy-testnet.sh` **从不校验 RPC 的 chain id**。实测把 `MONAD_RPC` 指向链 ID 31337 的本地链时，它照样执行 `forge script --chain 10143`；forge 忽略不匹配、在本地链上部署了 4 个合约，然后脚本因为找不到 `10143` 的 broadcast 文件而硬失败 —— 结果是**在任意链上产生部分真实广播，然后中途崩掉**。

**修复**：
```bash
# 只补齐缺失的变量，绝不覆盖显式传入的
: "${MONAD_RPC:=${MONAD_RPC_FALLBACK:-}}"
# 断言链 ID
[[ "$(cast chain-id --rpc-url "$RPC")" == "10143" ]] || { echo "wrong chain"; exit 1; }
# 拒绝公开 Anvil 钥
[[ "$PK" == "0xac0974be…" ]] && { echo "refusing public Anvil key"; exit 1; }
```
并且 **`.env.example` 不要填任何真实私钥**（留空 + 注释说明）。

---

## 5. 🟡 中危 / 产品级缺口

**合约侧**
- 没有将军/将死判定（PRD §3.5.1 的"无法解将"未实现），只有"吃掉将"；`_endByPoints` 也不算子力价值，平局偏向大座位号（`>=`）。
- `directorDrain`（`:345-354`）只清账上数字、不搬钱 → ETH 变成无归属资金。**仓库自己的测试还断言了这个状态**（`GameTable.t.sol:157`）。
- 同一地址可占 2–3 个座位（`join` 只查 `seats[seat].player == 0`），"2 人 + 1 AI"的约束是荣誉制。
- Lobby 局永不开始就没有任何退出/退款路径（叠加 B1，任何 `join` 都可被烧）。
- `expireCommit` 无递增惩罚，挂机方可以拖到 ply 80；没有自动 resign。
- `_payout` 选第二名不跳过已出局座位（20% 可能给已被击败的人）。
- 盟约完全不看 game phase（Lobby 期也能 `lockEarnest`，ply 窗口失去意义）。
- `require(_isLegal(...), "illegal geom")`（`:277`）是 revert 而非扣 `ILLEGAL_REVEAL_PENALTY`，与 PRD §3.4 不符，且把 commit 卡死。
- 条款 3（`MUTUAL_NON_CHECK`）在 `constants.ts:41` 存在但 `Covenant.sol:266-268` 直接 `revert("type")`；条款 2 被硬禁用（`:250`）；重复条款 `[1,1]` 能通过"≥2 条款"检查。
- `previewMoveFee`（`:200-202`）前端没用，费用在前端重算 → 镜像漂移风险。
- 死代码 `gameId;`（`:515`、`:561`）；`MIN_PLAY_BALANCE_TO_START` 永远不可能触发。

**前端侧**
- **完全没有钱包接入**：`window.ethereum` / `eth_requestAccounts` / WalletConnect 命中数为 **0**。所有签名方都是硬编码私钥或 localStorage 临时钥，由 Anvil 的 0 号钥注资。
- **AI 私钥被打进公开产物**：`chain.ts:27` 的 `ANVIL_KEYS.ai` 出现在 `dist/assets/index-*.js` 里。`.env.example` 定义的 `AGENT_KEY` **全仓库无人读取**。所以"自有键、钥隔离"目前是两个相邻字符串之间的隔离。
- **AI 不会自己走棋**：`agent/package.json` 的 `start:once` 是一句 `echo`。真 AI 是 `pickAiMove`（`policy.ts:5-31`）被按钮 `导演代走`（`App.tsx:580-582`）点一下走一步。全 App **只有一个 useEffect**（RPC 探测），没有定时器、没有轮询 → **轮到 AI 就死局**。
- **第二个真人永远进不来**：`App.tsx:198-207` 永远把 humanA/humanB/aiAccount 塞进三个座；唯一的身份控制是 `操控红营/蓝营` 按钮——**一个人左右互搏**。两个浏览器各自生成新钥 → `join` 报 `"taken"` → toast 出 `String(e)`（渲染成 `[object Object]`）。
- **`hasAddresses()` 只查 2/3 个合约**（`contracts.ts:29-31`），缺 `AgentRegistry` 时 `finalizeGame` 永久 revert。
- **`commitAndReveal` 无半失败处理**（`contracts.ts:120-137`）：reveal 一旦 revert，commit 还在链上 → `"pending"` 锁 60 秒，salt 丢失，且前端从不调用 `expireCommit`。
- **`doSlash` 是硬编码的**（`App.tsx:318-333`）：`betrayer = AI_SEAT`、`clause = 1` 写死。按钮的启用条件是"盟约 Active"而非"有吃士证据"，所以在真吃士之前点必然 revert；**疏火（clause 4）永远无法被 slash**。
- **自然破产不可达**：最便宜着法约 0.006–0.009 MON 对 2 MON 开局，只有吃将或打满 80 手才会终局。README 里"2:15 破产"那一拍**只存在于 Demo 按钮内部**（靠 `directorDrain`，而它是 `onlyOwner`）。
- 无 faucet / 无区块浏览器链接 / 无网络切换；`chainOk` 只证明**某个** RPC 应答了 `eth_blockNumber`，链 ID 不对也显示绿色"链已连接"。
- 渲染性能：`ecoMode` 与 `Board` 每次渲染都调 `legalMoves`（O(121²)），且 `Board` 没 `React.memo`。
- 死代码：`SanrenBoard.tsx` / `sanrenPath.ts` / `sanrenMap.ts` / `sanrenSetup.ts` **只被未引用的 `dev-board.html` / `dev-overlay.html` 使用**；实际出货棋盘是另一个 11×11 的 `Board.tsx`。

**工程 / 可复现性**
- **完全没有 CI**：没有 `.github/`，没有任何 workflow。
- **没有 `engines`、没有 `.nvmrc`**；只钉了 `"packageManager": "pnpm@10.33.4"`。
- **没有根 `tsconfig.json`，也没有 `@types/node`**，所以 `scripts/` 从来没被类型检查过 —— 里面有 **2 个真实类型错误**（`demo-harness.ts(9,30) Cannot find module 'node:fs'`、`(133,3) Cannot find name 'process'`）。
- **`pnpm-workspace-build.yaml` 是死配置**（全仓库无人引用）；真正生效的 `onlyBuiltDependencies` 在根 `package.json` 的 `pnpm` 字段里。
- **`contracts/.gitmodules` 是假的**：`contracts/lib/forge-std` 以**普通文件**入库（mode 100644），不是 submodule gitlink，`git submodule status` 为空；里面还留着一个悬空的 `.git` 指针。
- **`frontend/dev-board.html` / `dev-overlay.html` 没配成 Vite 多页入口**，生产构建里根本不存在（`dist/` 只有 `index.html`）。
- **`pnpm audit`：9 个漏洞 —— 3 critical / 1 high / 5 moderate**（`vitest <3.2.6`、`tinypool`、`vite <=6.4.2` 的 `server.fs.deny` 绕过、`esbuild`）。都在 dev 依赖，但 specifier 全是 caret 范围，**lockfile 是唯一的真实钉版**。
- **`pnpm install` 在"脏"工作树里会硬失败**：`ERR_PNPM_ABORTED_REMOVE_MODULES_DIR_NO_TTY`（`node_modules/.pnpm-workspace-state-v1.json` 记着 `settings.production: true`）。全新 clone 24 秒装完、一切正常 —— 是本地状态问题，不是仓库问题。
- **`tsc -b` 会被过期的 `tsconfig.tsbuildinfo` 短路**：CI 里必须用 `tsc -b --force`，否则可能假通过。

### 5.1 部署与工程可靠性（实测）

| 项 | 结果 |
|----|------|
| 全新 clone 端到端 | ✅ **可用**：`pnpm install` → 8+19 测试 → `tsc -b` → `deploy:local` → `pnpm demo`（21 笔真交易）全通 |
| `contracts/out`·`cache`·`broadcast`·`packages/shared/dist`·`*.tsbuildinfo` | ✅ 全部被 ignore、未入库，clone 后可重建 |
| `frontend/src/lib/addresses.json`·`src/abi/*.json` | ⚠️ **已入库**（带着 31337 的 Anvil 地址）；`deploy:local` 会**改写这个受版本控制的源文件**，跑完 `git status` 就脏 |
| `pnpm install`（脏树） | ❌ 见上；需 `CI=true pnpm install` |
| `pnpm test:forge` / `pnpm anvil` / `pnpm dev` / `pnpm demo` | ✅ 全通 |
| `pnpm deploy:local`（**全新** anvil） | ✅ 通过，地址与入库值一致 |
| `pnpm deploy:local`（**复用** anvil） | ❌ `CreateCollision` 崩溃，而且**已经广播 5 笔交易后才挂**，`addresses.json` 也没写。**脚本不幂等，也没在文档里说明必须用全新节点** |
| `deploy-testnet.sh` chain id 校验 | ❌ 无（见 §4 B0） |
| 测试网 10143 部署 | ❌ **从未发生**；`grep -rl 10143 contracts/broadcast` 为空；工作树里只有 `31337`，且那批 hash 对应的 anvil 状态早已不存在、无法验证 |

> 注：`contracts/broadcast/` 虽然目录里有文件，但被**根** `.gitignore:7` 的 `contracts/broadcast/` 先行排除（`contracts/.gitignore:10` 的 `!/broadcast` 负向规则永远不会被 git 读到），所以这些产物**从未入库**。

---

## 6. ⚠️ 架构级问题：规则文档与实现是两个东西

这是我在评审中发现的最需要注意的一条，因为它影响后续所有排期。

| 文档 | 内容 |
|------|------|
| `docs/SANREN_RULES.md`（本日 17:22 新增） | 三营各 9 纵线 × 5 横线、**每方 16 子**、九宫、外角过渡区、中宫盾形区、"三个共用同一份地图数据（落点、线、格），由照片描图生成" |
| `packages/shared/src/sanrenSetup.ts` | `BACK` 数组恰好 **9 子**、5 兵 —— 与 SANREN_RULES 的 16 子一致 |
| **实际实现的 `board.ts` / `GameTable.sol`** | 11×11 方格、**每方 9 子**（1 将 1 士 1 象 1 马 1 车 1 炮 3 卒）、无九宫、无过渡区、无中宫、兵可后退 |
| `README.md` | "棋规：inspired by Sanren Xiangqi，**可执行简化版**" |

**SANREN_RULES.md 第 3 行白纸黑字写着"三处共用同一份地图数据"——但合约和 `board.ts` 用的是另一套表示法。** 最近一次提交 (`2b8cd97`) 加了地图数据、描图页面、棋盘照片，却**没有改 `board.ts`，也没有改 `GameTable` 的 `_setupInitialBoard`**。

**结论**：棋盘有两套互不相通的表示法，`sanrenMap.ts`（255 行、46 节点、已提交）目前是**孤岛**。

**排期含义（重要）**：
- 短期（冲奖）：**不要碰这个**。把 SANREN_RULES.md 标注为"下一版目标"，README 保持"可执行简化版"诚实声明即可。
- 中期（产品）：如果真要上 SANREN_RULES 的棋盘，**合约的 `uint8[11][11]` 必须换成图/节点表示**，`_isLegal`、`_minLegalFee`、费用距离（"沿线走过的点数"而非 Chebyshev）全都要重写。这是**一次大重构**（估 5–8 人日），不是加功能。**现在决定，别等到有用户了再决定。**

---

## 7. 距离"可体验产品"，还差什么

按"陌生人能不能打开就玩"这条标准，逐层拆：

| 层 | 现状 | 差距 |
|----|------|------|
| **L0 本机演示** | ✅ **完全可用**（我实跑通过 21 笔交易） | 无 |
| **L1 安全可信** | ❌ 三个已实证漏洞 | B1/B2/B3 + H1–H8 | 
| **L2 能上网** | ❌ 测试网零部署；RPC 与 chainId 在构建期烧死；无 faucet | 部署脚本 + 地址配置化 + 领币指引 |
| **L3 真人能连** | ❌ 没有任何钱包接入 | 注入式钱包 + 网络切换 + 每座位一钱包 |
| **L4 多人同桌** | ❌ 单浏览器包办三角；无房间/邀请/轮询 | 大厅 + 房间码 + 观战态 + 状态同步 |
| **L5 AI 自主** | ❌ `agent/` 是 echo；靠按钮代走 | 独立进程 + 自有钥 + 轮询 + 会自己开局/应招 |
| **L6 规则完整** | ⚠️ 简化 11×11，与 SANREN_RULES 不一致 | 见 §6 的架构决策 |
| **L7 可运营** | ❌ 无索引器、无历史对局、无排行榜、无监控、无金库提取 | 事件索引 + 数据库 + 运维 |

**分阶段人日估算**：

| 里程碑 | 内容 | 估时 |
|--------|------|------|
| **M1 可安心演示** | 修 B1/B2/B3 + H1–H8 + 补关键测试 | **1.5–2 人日** |
| **M2 陌生人可玩（单机版）** | 钱包接入 + 测试网部署 + faucet 指引 + 错误处理 + 去掉硬编码 | **3–5 人日** |
| **M3 多人真同桌** | 房间/邀请/轮询同步 + 观战 + 每人一钱包 | **3–5 人日** |
| **M4 AI 自主** | 独立 agent 进程 + 自有钥 + 服务端轮询 + 开局/应招 | **3–4 人日** |
| **M5 Beta 可运营** | 索引器 + 对局历史 + 排行榜 + 监控 + 金库提取 | **5–8 人日** |
| **M6 规则上位（可选）** | 按 §6 重构为 sanren 图表示 | **5–8 人日** |

> **M1 + M2 是"能给人体验"的最小闭环（约 5–7 人日）**；M3 之后才叫"产品"。

---

## 8. 开发清单（可勾选）

### 🚨 P0-0 — 部署安全（最高优先级，先于一切合约改动）

- [ ] **P0-0a** `deploy-testnet.sh` 的 `source .env` 改为**只补缺、不覆盖**显式传入的变量（或干脆不 source）；实测它会把显式 `MONAD_RPC` 覆盖成真测试网 — `deploy-testnet.sh:9-14`
- [ ] **P0-0b** `.env.example` 里的 `PRIVATE_KEY` 留空（**禁止**再放公开 Anvil 钥，实测该钥在真 Monad 测试网 nonce=468，任何人打钱即被转走） — `.env.example:3`
- [ ] **P0-0c** `deploy-testnet.sh` 加链 ID 断言（`cast chain-id` 必须 == 10143）+ 拒绝公开 Anvil 钥作为部署钥
- [ ] **P0-0d** 前端所有用钥路径统一 gate 在 `chainId === 31337`（现在只有 `runDemoSpine` 有守卫，注资路径没有） — `App.tsx:153-163`
- [ ] **P0-0e** `deploy-local.sh` 加幂等/`CreateCollision` 检测，提示"请重启 anvil"（复用节点时会广播 5 笔后崩溃）

### 🔴 P0 — 合约安全（在把地址公开给任何人之前必须做完）

- [ ] **P0-1** `finalizeGame` 加 phase 守卫：只允许 `Finished` 或 `Playing` 且（存活≤1 或 ply≥80）；加 `gameId < nextGameId` 校验 — `GameTable.sol:359`
- [ ] **P0-2** 胜者循环补 `player != address(0)` 谓词 — `GameTable.sol:361-367`
- [ ] **P0-3** `fulfillCovenant` 加违规/终局守卫或时间锁，确保 `challengeBetrayal` 不被抢跑 — `Covenant.sol:283`
- [ ] **P0-4** `activeBySeat` / `pendingCountBySeat` 改 `internal`（两行） — `Covenant.sol:57-58`
- [x] **P0-5** `createGame()` 不再带 aiSeat；Agent 入座时绑定卧底 — `GameTable.sol`
- [ ] **P0-6** 退还/入账非胜者 seatStake — `GameTable.sol:526-559`
- [ ] **P0-7** `g.settled = true` 提到 `_payout()` 之前（或加 `nonReentrant`） — `GameTable.sol:380`
- [ ] **P0-8** `activateCovenant` 按调用者身份收费 + 要求是当事人 — `Covenant.sol:183-187`
- [ ] **P0-9** `AgentRegistry.setGameTable` 首次接线改 `onlyOwner`；`GameTable` 构造加零地址/代码校验 + 加 `setRegistry` — `AgentRegistry.sol:34`
- [ ] **P0-10** `revealAiOnly` 限 AI 座位本人（或 owner 在终局前） — `GameTable.sol:394`
- [ ] **P0-11** 记录并退还 0.05 `EXTRA_EARNEST_PREMIUM`；`_lock` 退还多余 `msg.value` — `Covenant.sol:106-110`
- [ ] **P0-12** `activateCovenant` 改为校验 `keccak256(abi.encode(preimage)) == covenantHash`（条款与 bond 真正入承诺） — `Covenant.sol:196`
- [ ] **P0-13** 加 `withdrawTreasury(address)`（owner/协议方），让 `protocolTreasury` 可取 — `GameTable.sol:63`
- [ ] **P0-14** 补缺失测试：`fulfillCovenant`、Lobby 局 finalize、重入、`MAX_PLIES`、`peaceBetrayal`、`revealAiOnly` 权限、`join` 超付/同址多座、FeeLib 剩 4 个棋子 — `contracts/test/`

### 🟠 P1 — 让它能被人体验

- [x] **P1-1** 接入注入式钱包（`window.ethereum`）+ 网络切换 + 链 ID 校验 — Wave A1
- [x] **P1-2** `addresses.json` / RPC 改环境变量注入（`VITE_*` + `addresses.10143.json`）— Wave A
- [x] **P1-3** 去掉前端生产路径 AI 私钥，改由独立 agent 服务签名 — Wave A2
- [x] **P1-4** 每座位真实钱包 / 邀请入座（测试网不再双控 Anvil 钥）— Wave A/B
- [x] **P1-5** 部署 10143 并把地址与示例 tx 回填 README；faucet 指引 — Wave A5（`createGame()` 无 aiSeat 版）
- [ ] **P1-6** `hasAddresses()` 补查 `AgentRegistry` — `contracts.ts:29-31`
- [ ] **P1-7** `commitAndReveal` 加半失败处理：reveal 失败时保存 salt / 自动 `expireCommit` — `contracts.ts:120-137`
- [ ] **P1-8** `doSlash` 去掉硬编码：从 `Covenant.activatedPlyOf` 读激活手数，按实际吃子证据选择 clause — `App.tsx:318`
- [ ] **P1-9** 统一错误呈现：`String(e)` → 解析 viem `shortMessage`（现在渲染成 `[object Object]`）
- [ ] **P1-10** 加基础 loading / 空态 / 失败重试；`Board` 加 `React.memo`，`legalMoves` 加 memo
- [ ] **P1-11** 清理死代码：`SanrenBoard`/`sanrenPath`/`sanrenMap`/`sanrenSetup` 要么接入要么删除；删 `gameId;` 空语句

### 🟠 P1.5 — 工程可靠性（可与 P1 并行，成本低收益高）

- [ ] **P1.5-1** 加 CI（GitHub Actions）：`tsc -b --force` + `pnpm test:shared` + `pnpm test:forge` + `vite build` + `pnpm audit`。**注意 `tsc -b` 必须加 `--force`**，否则会被过期的 `tsconfig.tsbuildinfo` 短路成假通过
- [ ] **P1.5-2** 加根 `tsconfig.json` + `@types/node`，修掉 `scripts/demo-harness.ts` 的 2 个类型错误（`node:fs` / `process`）
- [ ] **P1.5-3** 加 `engines` 字段与 `.nvmrc`（当前零 Node 版本约束）
- [ ] **P1.5-4** 文档化 `CI=true pnpm install`（脏 `node_modules` 会 `ERR_PNPM_ABORTED_REMOVE_MODULES_DIR_NO_TTY`）；或设 `confirmModulesPurge=false`
- [ ] **P1.5-5** README 注明 `pnpm deploy:local` 会改写受版本控制的 `frontend/src/lib/addresses.json`；考虑把该文件改为生成物 + `.example`
- [ ] **P1.5-6** 删掉死的 `pnpm-workspace-build.yaml`；修掉假的 `contracts/.gitmodules` 与悬空的 `contracts/lib/forge-std/.git`（forge-std 实为普通文件入库）
- [ ] **P1.5-7** `dev-board.html`/`dev-overlay.html` 要么加进 Vite `build.rollupOptions.input`，要么删除
- [ ] **P1.5-8** 升级 dev 依赖处理 3 critical / 1 high 告警（`vitest`、`tinypool`、`vite`、`esbuild`）；或用 `pnpm.overrides` 钉住修复版

### 🟡 P2 — 让它成为"产品"

- [ ] **P2-1** 独立 AI agent 进程：自有 EOA、轮询回合、自动 commit/reveal、会自己开局与应招（补上 `agent/` 真实现 + 读 `AGENT_KEY`）
- [ ] **P2-2** 房间/撮合：创建房间 → 邀请链接 → 入座 → 开局；观战模式
- [ ] **P2-3** 状态同步：轮询或订阅，让"别人走了一步"能实时反映（现在只有动作后才刷新）
- [ ] **P2-4** 索引器 + 对局历史 + 排行榜（`AgentRegistry` 声誉目前只能读单个地址）
- [ ] **P2-5** 补棋规：将军/将死判定、`_endByPoints` 算子力价值、平局规则 — `GameTable.sol:580-617`
- [ ] **P2-6** 破产可达性调参：让"逼破产"成为真实策略而非只在 Demo 按钮里（当前 2 MON 开局 vs 0.006 最便宜着法）
- [ ] **P2-7** `directorDrain` 改为真搬钱或彻底移除（现在只清数字、留死钱）
- [ ] **P2-8** 加 Lobby 退出/超时退款；`join` 禁止同址多座
- [ ] **P2-9** 加递增挂机惩罚 / 自动 resign，避免拖到 ply 80
- [ ] **P2-10** 监控 / 告警 / 金库对账脚本

### 🔵 P3 — 战略决策（建议尽早拍板）

- [ ] **P3-1** 决定是否上 `SANREN_RULES.md` 的真三人象棋棋盘。**要上就是一次合约大重构**（棋盘表示 + 合法性 + 费用距离全部重写，5–8 人日）；不上就把该文档标注为"下一版目标"，避免文档与实现长期打架
- [ ] **P3-2** 决定 P1 ZK 电路做不做（当前 `StubVerifier` 诚实但验证是空的）；不做就维持 README 诚实表
- [ ] **P3-3** 决定是否引入服务端（AI 托管、房间状态、索引）—— 目前是全静态前端，多人必然需要

---

## 9. 给冲奖（10/13）的现实建议

如果目标仍是**冲奖提交**而不是产品化，按 ROI 排序只需做 5 件事：

0. **P0-0a / P0-0b**（20 分钟）：先把 `deploy-testnet.sh` 的 `.env` 覆盖问题和 `.env.example` 里的公开私钥处理掉。**这是唯一可能造成真实资金损失的项**，而且实测已经触发过一次（仅因余额不足没成交）。在修好之前**不要执行 `deploy:testnet`**。
1. **P0-1 / P0-2 / P0-4 / P0-5**（半天）：B1 与 B3 修掉。这两条是评委会**当场用区块浏览器就能验证**的——"任何人都能弄死一局"和"G1 隐私是假的"会直接摧毁赛道 04 的可信度叙事。
2. **P0-3**（1–2 小时）：`fulfillCovenant` 守卫。这是核心卖点（背刺罚没）能不能站住的问题。
3. **P1-5 部署 10143**（1–2 小时，前置 P0-0）：README 现在诚实写着"没有一笔已确认的 10143 交易"。有测试网地址和 tx hash，说服力完全不同量级。
4. **P1-3 / P1-4 说明清楚**：如果来不及做真多人，就在 README 和 Demo 里**明确说这是单机演示、AI 由前端代走**——README 其实已经写了"独立进程未做"，保持这份诚实，别让评委自己发现。

**明确不要做的事**：不要为了补多人/独立 agent/新棋盘而在 10/13 前动合约大结构——B0/B1/B2/B3 之外的改动都建议推迟。

---

*评审基于 `2b8cd97`。标"已实证 / 实测"的结论均在本地 Anvil（独立端口 8599）上真实复现；测试用 anvil 进程与临时改动的 `addresses.json` 已还原，未改动任何源码。工作区仅新增 `docs/FRONTEND_REVIEW.md` 与本文档。*

---

## 10. 附录：本轮已完成 / 仍未完成

### ✅ 已完成并实测（4 个提交）

| 编号 | 项 | 验证方式 |
|------|-----|----------|
| P0-0a | `deploy-testnet.sh` 的 `.env` 改为只补缺不覆盖 | 实测：显式 `MONAD_RPC` 不再被静默改写 |
| P0-0b | `.env.example` 移除全部私钥 | 人工核对 |
| P0-0c | 加 `chainId == 10143` 断言 + 拒绝公开 Anvil 钥 | 代码 + 守卫分支 |
| P0-0d | `fundFromAnvil` 强制本地演示模式且校验实际 chainId | 非 31337 直接抛错 |
| P0-0e | `deploy-local.sh` 幂等（复用已有部署，`FORCE_REDEPLOY=1` 强刷） | 实测：连跑两次第二次跳过 |
| — | `Deploy.s.sol` 移除公开 Anvil 钥默认值 | `forge script` 不再默认用公开钥 |
| P0-1 | `finalizeGame` 加 phase/gameId 守卫 | 新增 `test_FinalizeLobbyGameReverts` / `test_FinalizeUnknownGameReverts` |
| P0-2 | 胜者循环补 `player != address(0)` | 同上 |
| P0-3 | `fulfillCovenant` 加违规检查 + 冷静期 | 新增 `test_BetrayerCannotEscapeViaFulfill` |
| P0-4 | `activeBySeat`/`pendingCountBySeat` 改 internal | 新增 `test_ActiveCovenantPartiesNotPubliclyReadable` |
| P0-6 | 非胜者 seatStake 全额退回 | 新增 `test_NonWinnerStakeIsRefunded`；并修正"金库记账 == 合约余额"不变式 |
| P0-7 | `settled` 提到 `_payout` 之前 | 新增 `test_FinalizeSetsSettledBeforePayout` |
| P0-8 | bond 按身份计费 + 要求调用者是当事人 | 新增 `test_ActivateChargesByCallerIdentity` / `test_ActivateRejectsNonPartyCaller` |
| P0-9 | `AgentRegistry.setGameTable` 改 onlyOwner + 对端认领；不再自动注册陌生地址 | 初始化路径收口 |
| P0-10 | `revealAiOnly` 限 AI 座位本人 | 新增 `test_RevealAiOnlyRejectsNonAi` |
| P0-11 | 0.05 premium 记账并参与退款；`_lock` 退还多余 value | `refundExpiredEarnest` 断言金额 |
| P0-12 | `activateCovenant` 校验完整 `CovenantPreimage` | 新增 `test_ActivateRejectsTamperedBondAmount` |
| P0-13 | 新增 `withdrawTreasury` / `protocolTreasuryOf` | 提现后余额与记账同步扣减 |
| P1-1 | 注入式钱包接入（EIP-1193）+ 网络切换 + 真实 chainId 校验 | 代码 + 构建通过 |
| P1-2 | `VITE_*` 环境变量覆盖 chainId/RPC/地址 | 新增 `frontend/.env.example` |
| P1-6 | `hasAddresses()` 要求三个地址齐全 | 缺 `AgentRegistry` 不再静默 |
| P1-7 | `friendlyError()` 取代 `String(e)` | 不再渲染 `[object Object]` |
| P1-8 | `doSlash` 去掉硬编码，改为从链上读回条款逐个尝试 | 代码 |
| P1-9 | 前端链状态区分"未就绪 / 链不匹配" | 代码 |
| — | **多人在同一局各自入座**：一个钱包只能操控自己那一座 | `seatOwningWallet` / `canSignFor` |
| P2-1 | **独立 AI agent 进程**（自有 EOA、自主轮询、自动走子、可接盟背刺、motiveLog） | 实测连续两轮自动落子，`feesPaidOf` 真实增长 |
| P1.5-1 | GitHub Actions CI（install→typecheck→test→build→forge→audit） | 新增 workflow |
| P1.5-2 | 根 `tsconfig.json` + `@types/node`；修复 `scripts/` 的 2 个类型错误 | `pnpm typecheck` 三处全绿 |

**实测数据**：`forge test` 31 项全过；`pnpm test:shared` 8 项全过；
`pnpm typecheck`（frontend + agent + scripts）0 error；前端生产构建成功（511 kB / 158 kB gzip）；
本地 `pnpm demo` 21 笔交易全 success；AI agent 在本地链上自动走子并真实烧掉 `moveFee`。

**评审时确认的三个漏洞现在都有回归测试钉死**（B1/B2/B3），不会再无声回归。

### ⛔ 仍未完成 —— 需要你提供外部资源

| 编号 | 项 | 卡在哪 |
|------|-----|--------|
| **P1-5** | 部署 Monad 测试网 10143 | **需要你提供**：一把只有你持有的、有测试网 MON 的私钥。脚本已就绪（`MONAD_RPC=... PRIVATE_KEY=0x... pnpm deploy:testnet`），会写 `addresses.10143.json` 且不破坏本地演示。**我不会也不应该替你生成或使用任何私钥。** |
| **P2-1b** | AI agent 上公网 | 需要一个能长期运行 Node 进程的机器/容器，以及一把专用的 `AGENT_KEY`（有测试网 MON 付 AI 座位的 3 MON 入座费 + 油费）。 |
| **P2-2** | 房间/撮合：邀请链接、房间码、观战 | 纯代码工作，约 3–5 人日。目前是"一个人 `新开一局`，其余人用地址入座"，没有发现房间的入口。 |
| **P2-3** | 状态实时同步 | 目前只有动作后刷新；别人走了一步不会自动出现。需要轮询或订阅（约 1 人日）。 |
| **P2-4** | 索引器 + 对局历史 + 排行榜 | 需要数据库/服务端。 |
| **P2-5** | 将军/将死判定、子力价值决胜 | 合约棋规仍是简化版（只有吃将、破产、80 手三种终局）。 |
| **P2-6** | 破产可达性调参 | 2 MON 开局 vs 0.006 最便宜着法，"逼破产"仍不是实战策略。 |
| **P3-1** | 是否上 `SANREN_RULES.md` 的真三人象棋棋盘 | **需要你拍板**：要上是合约大重构（5–8 人日）。 |
| **P1-3 收尾** | 删除前端里的 Anvil 私钥 | 本地演示仍依赖 `ANVIL_KEYS`；彻底删掉需要前端只保留"本地演示"这一独立入口。 |

### ⚠️ 方向提醒

`docs/` 下新增了两份消费版 PRD（`PRD-微信小游戏-积分版.md`、`PRD-暗黑卧底象棋-产品需求.md`），
明确写的是 **微信小游戏 + 纯积分经济，无链无 Token 无钱包**。

这与本仓库当前实现的**链上版本是两条不同的产品线**：

- 本轮的 P0/P1/P2 工作把**链上版**做到了"可安全部署、真人可各自入座、AI 会自己下"。
- 若目标转向消费版，那么**合约、钱包、Covenant/AgentRegistry 全部不在关键路径上**；
  真正能复用的是 `packages/shared`（棋规 + 费用 + AI 策略，约 800 行）与前端棋盘组件。
  消费版还需要的是：微信小游戏容器与虚拟支付、服务端房间与匹配、断线重连、以及合规（版号/内容审核）。
- **建议尽早明确主攻哪一条**，因为两者的排期几乎不重叠，同时推进会让两份投入都变薄。
