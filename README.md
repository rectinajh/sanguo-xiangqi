# 三国棋局 · Shadow Xiangqi

**三人象棋桌上藏着押金 AI 卧底——步步一笔交易烧 MON；氪金可疏火/多开诚意金，性价比靠省油逼破产。**

| | |
|---|---|
| 赛道 | **04 Trust Identity & AI Infrastructure** |
| 本地链 | Anvil `31337`（Monad-ready → testnet `10143`） |
| License | MIT |

## 五条命令开玩

```bash
# 0) 依赖（首次）
pnpm install

# 1) 合约测试
pnpm test:forge

# 2) 终端 A：本地链
pnpm anvil

# 3) 终端 B：部署并写地址
pnpm deploy:local

# 4) 终端 C：前端
pnpm dev
```

浏览器打开终端提示的地址 → 点 **「一键 Demo 脊骨」**。

## 双玩法

| 路线 | 怎么玩 |
|------|--------|
| **氪金** | 「补给油费」热补；多开诚意金（≥3 MON 作战余额）；**疏火**贿金买 N 手停火 |
| **性价比** | 「省油推荐」高亮最便宜合法格；拒贿 / 收钱背刺 / 廉价陷阱耗干鲸鱼 |

非法着法永远不可点、不可上链。

## Demo 脊骨

入座（隐藏 AI）→ 走子扣费 → 补给/省油 → 诚意金或疏火 → Slash → 终局揭示 + AgentRegistry。

## 诚实 ZK

| 层 | 状态 |
|----|------|
| P0 | hash + 双 ECDSA + 事件隐座位 + `IVerifier` Stub（仅 ECDSA）= **ZK-ready** |
| P1 | 完整 preimage 电路 — 见 `circuits/README.md` |

## 文档

- [docs/PRD.md](./docs/PRD.md) · [docs/TECHNICAL.md](./docs/TECHNICAL.md) · [docs/IMPLEMENTATION_PLAN.md](./docs/IMPLEMENTATION_PLAN.md)

## 已实现 / Stub

**已实现：** FeeLib、GameTable（入座/commit-reveal/吃子/破产/人类补给）、Covenant（多诚意金、疏火 BUY_PEACE、Slash）、AgentRegistry、前端棋盘+fee+省油+Demo。

**Stub / 延期：** 完整 ZK 电路、代付盟友油费、谣言店、独立 agent 进程、完整三人棋规百科。
