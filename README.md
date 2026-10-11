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

## 五条命令（本地）

```bash
pnpm install
pnpm test:forge
pnpm anvil          # 终端 A
pnpm deploy:local   # 终端 B
pnpm dev            # 终端 C，然后点「一键 Demo 脊骨」
```

同一条剧本也可以：

```bash
pnpm demo
```

`pnpm demo` 只打 Anvil `31337`。它使用公开的 Anvil 私钥，禁止对 `10143` 运行。

## Monad 10143

有测试网余额时：

```bash
MONAD_RPC=https://testnet-rpc.monad.xyz PRIVATE_KEY=0x... pnpm deploy:testnet
```

脚本会在余额为 0 或缺少变量时直接退出，不编造地址和交易哈希。广播成功后，地址写进 `frontend/src/lib/addresses.json`，终端会打出交易哈希，再把这两样抄回本节。

当前仓库没有一笔已确认的 10143 交易。主网 143 不在这一版。

## 已实现 / 未做

已实现：费用、commit-reveal、吃子与击败 40% 质押、按最便宜合法着破产、人类补给、AI 禁止补给、诚意金上限读链上余额、疏火、证据 Slash、60 秒未揭示扣 0.03 MON、终局 70/20/10、声誉。

未做：完整 ZK、谣言店、指控投票、代付盟友油费、独立 agent 进程、完整棋规。
