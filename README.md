# 三国棋局 · Shadow Xiangqi

三人象棋桌上藏着押金 AI 卧底——步步一笔交易烧 MON；氪金可补给，性价比靠省油逼破产。

Three-player Xiangqi with one staked AI mole — every move is a transaction that burns MON, captures earn points, earnest-bonded secret alliances, on-chain betrayal slashing.

| | |
|---|---|
| 赛道 | **04 Trust Identity & AI Infrastructure** |
| 本地链 | Anvil `31337` |
| 目标链 | Monad Testnet `10143`（有余额的私钥才广播，见下方） |
| 棋规 | inspired by Sanren Xiangqi，可执行简化版，不是规则百科 |
| License | MIT |

## 评委 3 分钟会看到什么

| 时间 | 看到 | 链上 |
|------|------|------|
| 0:00 | 三座各锁 1 MON，公开事件不写卧底座位 | `GameCreated(gameId)`、`Joined` 无 `isAi` |
| 0:20 | 卒走 1 格约 0.009 MON，车走 3 格约 0.050 MON | `MoveFeePaid` |
| 0:45 | 诚意金 0.10 MON，事件只有 hash | `EarnestLocked` |
| 1:10 | 盟约生效，座位仍不公开 | `CovenantActivated` |
| 1:40 | 绿营真的吃掉红方的士，然后才能 Slash | `CaptureSettled` 然后 `BetrayalSlashed` |
| 2:15 | 另外两座付不起最便宜的合法着，破产 | `SeatBankrupt` |
| 2:40 | 揭示卧底、`forcedBurnMon`、slash 次数 | `AiRevealed`、`AgentRegistry` |

没有吃士记录时，`challengeBetrayal` 会 revert。罚金进受害方 `playBalance`，不是打给任意调用者。

## 架构

```
[浏览器]
  棋盘（合法格 + fee）· 双账本 · 临时钱包 · 导演代走
        | JSON-RPC
[合约]
  GameTable      入座 / commit-reveal / 吃子 / 破产 / 终局
  Covenant       诚意金 + 双 ECDSA + 吃子证据 Slash
  AgentRegistry  终局写入胜负、slash、forcedBurnMon
  StubVerifier   空证明 = ECDSA 路径；任何非空证明失败
        |
[AI]
  页内 pickAiMove：盟约满 10 手后优先吃盟友的士
  3 分钟剧本用同一函数，forceBetrayal 打出真实吃士
  独立进程未做。AI 钥是另一把，不读人类 session key
```

`forcedBurnMon` = 另外两座已经付掉的 moveFee 之和。

## 诚实 ZK

| 层 | 内容 | 状态 |
|----|------|------|
| P0 | hash + 双 ECDSA + 事件不写座位 + `IVerifier` | 已做。空 `zkProof` 才通过 |
| P1 | circom/Noir preimage | 未做。见 `circuits/README.md` |
| P2 / G2 | Slash 时仍隐藏座位 | 不承诺 |

失败时这样说：电路还没做，所以这不是完整 ZK。扣费、诚意金、吃士、Slash、Points 是真交易。`StubVerifier` 拒绝任何非空证明，避免空验证器冒充 ZK。

## 本地跑通（含 AI 与水龙头）

```bash
pnpm install
pnpm test           # shared + 前端 + 合约 + 尺寸检查，全绿
pnpm anvil          # 终端 A：本地链
pnpm deploy:local   # 终端 B：部署（幂等，重复跑会复用）
pnpm indexer        # 终端 C：索引器（对局历史 / 排行榜）
pnpm dev            # 终端 D：前端
```

打开页面后有三条路径：

| 路径 | 怎么做 | 适合 |
|------|--------|------|
| **一键 Demo** | 点右上「一键 Demo 脊骨」 | 30 秒看完扣费→结盟→背刺→Slash→揭示 |
| **真人对局** | 点「创建房间」→ 复制邀请链接 → 发给两位朋友各自入座 | 体验真实的多人与钱包流程 |
| **AI 自动对局** | 另开终端 `AGENT_KEY=0x59c6… pnpm agent` | 让 AI 自己轮询回合、自己接盟与背刺 |

`pnpm demo` 是纯脚本版的同一条脊骨，只打 Anvil `31337`：它使用公开的 Anvil 私钥，
因此**禁止**对 `10143` 运行（脚本会自己拒绝）。

### 房间与邀请链接

房间号就是链上 `gameId`，对局的唯一真源是合约 —— **不需要房间服务器**。
邀请链接形如 `http://localhost:5173/#/r/12`，朋友点开即自动进入该房间并看到谁已入座。

### 索引器（对局历史 / 排行榜）

合约本身没有"列表"能力：`AgentRegistry` 的声誉只能按地址查，既没有 `agentCount`，
也没有"所有对局"。所以历史与排行榜由链下索引器提供，链仍是唯一真源（索引可重建）：

```bash
pnpm indexer          # 持续运行，默认 http://127.0.0.1:8788
pnpm indexer:once     # 只扫一轮后退出（适合 CI / 定时任务）
```

接口：`/health` · `/games` · `/games/:id` · `/players/:address` · `/leaderboard` · `/agents`

用 `node:sqlite`（Node 22+ 内置，零额外依赖），数据落在 `server/.data/index.sqlite`，
删掉即可重建。前端面板通过 `VITE_INDEXER_URL` 指向它。

地址文件按 `CHAIN_ID` 自动选择：`CHAIN_ID=10143` 读 `addresses.10143.json`，
否则读本地 `addresses.json`。指向测试网：

```bash
RPC_URL=https://testnet-rpc.monad.xyz \
CHAIN_ID=10143 \
INDEXER_START_BLOCK=70345306 \
pnpm indexer
```

> ⚠️ **公网 RPC 的两个硬限制**（都实测踩过，本地 Anvil 不会暴露）：
> 1. `eth_getLogs` 的区块区间被限制（Monad 公共 RPC 只允许 **100 个块**）。
>    索引器已做自适应分块，但仍**不要从创世块扫** —— 7000 万块等于 70 万次请求。
>    用 `INDEXER_START_BLOCK` 指定部署块（可用二分找：`cast code <地址> --block N`）。
> 2. 逐节点读盘面（`cell()`）一局要 100+ 次并发调用，会被限流。agent 因此改为
>    **事件驱动**维护棋盘（`MoveRevealed`），不再整盘读链。

> 注意：合约在终局结算时会把 `points` 用掉（进奖池/孤儿池），结算后链上读到的是 0。
> 所以索引器另用 `CaptureSettled` / `PointsSeized` 事件累计"累计赚分"，
> 历史统计一律用这个值，而不是 `getSeat` 的当前 points。

### 测试币（不自建水龙头）

**我们用官方水龙头，不自建。** 自建需要一个常驻的、有 MON 余额的热钱包，还要对
公网暴露发钱接口 —— 运维成本和被刷风险都不值得，何况这只是测试网。

官方入口：**<https://faucet.monad.xyz>**

| 项 | 值 |
|---|---|
| 网络 | Monad Testnet |
| Chain ID | `10143` |
| 代币 | `MON` |
| RPC | `https://testnet-rpc.monad.xyz` |
| 浏览器 | [monadvision.com](https://monadvision.com) · [monadscan.com](https://monadscan.com) |

前端余额面板里有「去领测试币 ↗」按钮直接跳转。入座需 3 MON（1 质押 + 2 作战）。

> 本地 Anvil 不需要水龙头：Anvil 自带 10000 ETH 的测试账户。
> 若确实要换成自建水龙头，把 `VITE_FAUCET_URL` 指向你的服务即可，前端无需改动。

## Monad 10143

有测试网余额时（**请用你自己新建、只有你持有的钥**）：

```bash
MONAD_RPC=https://testnet-rpc.monad.xyz PRIVATE_KEY=0x... pnpm deploy:testnet
```

脚本会断言 RPC 的 chainId 就是 `10143`、拒绝公开 Anvil 钥、余额为 0 或缺变量时直接退出，
不编造地址和交易哈希。广播成功后地址写入 `frontend/src/lib/addresses.10143.json`
（**不会**覆盖本地演示用的 `addresses.json`），终端会打出交易哈希。

前端指向测试网有两种方式：把上面那个文件的内容配上 `VITE_*` 环境变量（见 `frontend/.env.example`），
或让 `deploy:testnet` 的产物走 CI 注入。

当前仓库没有一笔已确认的 10143 交易。主网 143 不在这一版。

## 已实现 / 未做

已实现：费用、commit-reveal、吃子与击败 40% 质押、按最便宜合法着破产、人类补给、AI 禁止补给、诚意金上限读链上余额、疏火、证据 Slash、60 秒未揭示扣 0.03 MON、终局 70/20/10、声誉；**浏览器钱包接入**、**邀请链接房间（含实时轮询）**、**水龙头服务**、**独立 AI agent 进程**。

未做：完整 ZK、谣言店、指控投票、代付盟友油费、完整棋规、将军/将死判定、匹配大厅与排行榜。

### 安全说明（评审修复）

第一轮代码评审确认的三个漏洞已修复并有回归测试钉死，详见 [docs/DEV_CHECKLIST.md](docs/DEV_CHECKLIST.md)：
结算任意 Lobby 局（可锁死他人质押）、背刺者自行"履约"逃掉罚没、G1 隐私映射对外可见。
另有 8 项高危（非胜者质押不退、结算重入、金库不可提取等）一并修复。测试从 19 项增至 31 项。
