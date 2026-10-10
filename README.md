# 三国棋局 / Shadow Xiangqi

**三人象棋桌上藏着押金 AI 卧底——步步一笔 Monad 交易烧 MON、吃子赚分，诚意金隐匿结盟，背刺即罚没。**

> **English:** Three-player Xiangqi with one staked AI mole — every move is a Monad tx that burns MON, captures earn points, earnest-bonded secret alliances, on-chain betrayal slashing.

| | |
|---|---|
| 链 | Monad Testnet `chainId 10143` |
| 主赛道 | **04 Trust Identity & AI Infrastructure** |
| 版本 | MVP · FINAL PRD v1.0（冲奖提交） |
| License | MIT |

---

## 为什么是 Monad

- **快确认（~0.4s）**：每步走子 = 一笔 tx；扣费 / slash 快到可以当 Demo 音效卡点。
- **隐藏钱包体验**：人类用临时会话钱包 + faucet；AI 自有 Agent EOA，**永不接触用户私钥**。
- **并行友好**：每局 `gameId` 独立；盟约按 `covenantHash` 分片。
- 叙事金句：**「背刺罚没和扣油费确认快到可以当音效。」**

主网 `143` 仅文档步骤，不阻塞提交。

---

## Demo 脊骨（3 分钟）

必须真上链、可复现：

1. **入座** — 三座各锁 `seatStake = 1 MON` + `playBalance`；恰好 1 座是隐藏 AI
2. **走子烧 MON** — commit → reveal；合法格显示 `moveFee` 预览（车远走贵、卒便宜）
3. **诚意金盟约** — `lockEarnest` → Accept → Active；第三方事件不见当事人座位（G1）
4. **背刺 Slash** — 假诚意履约后违约 → `challengeBetrayal` → `BetrayalSlashed`
5. **终局揭示** — 吞 Points / 破产 → 揭 AI + `motiveLog` → `AgentRegistry` 声誉

详见 [docs/PRD.md §9](./docs/PRD.md) 与 [docs/TECHNICAL.md](./docs/TECHNICAL.md)。

---

## 赛道（04）

| 赛道诉求 | 本产品落地 |
|----------|------------|
| AI Agent 身份与声誉 | 最小 ERC-8004 风格 `AgentRegistry`：胜/负/slash/`forcedBurnMon` |
| 可信 AI（bonded） | AI 与人类对称锁 1 MON；背刺可 slash；对局禁热补油 |
| 隐私证明（ZK-ready） | 诚意金与盟约 commitment 上链不露当事人；P0 = hash + 双 ECDSA + UI 隐匿 |
| 链上可信交互 | 每步一笔 tx；扣费 / slash / 揭示可审计 |

副叙事：Social Gameplay / Deception（一句带过即可）。

---

## 如何运行（占位）

> 合约 / 前端 / Agent 脚手架尚未合入本仓库文档包；下列为目标命令，部署后补全地址与脚本。

```bash
# 1. 合约（Foundry）
cd contracts && forge test
forge script script/Deploy.s.sol:Deploy --rpc-url $MONAD_RPC --broadcast --chain 10143

# 2. 前端
cd frontend && npm i && npm run dev

# 3. AI Agent（自有 EOA，勿填人类钥）
cd agent && cp .env.example .env   # AGENT_PRIVATE_KEY=
npm run start:once

# 4. Demo 剧本
npx tsx scripts/demo-harness.ts
```

环境变量见 `.env.example`（待加）：`MONAD_RPC`、`PRIVATE_KEY`（deployer）、`AGENT_KEY`。

---

## 文档

| 文档 | 说明 |
|------|------|
| [docs/PRD.md](./docs/PRD.md) | FINAL 产品需求 v1.0（冲奖提交版） |
| [docs/TECHNICAL.md](./docs/TECHNICAL.md) | 技术实现：架构、合约、费用、盟约、AI、前端、P0 文件图 |
| [docs/IMPLEMENTATION_PLAN.md](./docs/IMPLEMENTATION_PLAN.md) | 分日任务与 checkbox 实现计划 |
| [REPO_SETUP.md](./REPO_SETUP.md) | 空 GitHub 仓库推送说明 |

棋规声明：**可执行简化版三人象棋**，inspired by Sanren Xiangqi——不做规则百科全书。

---

## 诚实 MVP / ZK 状态

| 层 | 内容 | Demo 标注 |
|----|------|-----------|
| **P0（本仓库承诺）** | hash + 双 ECDSA；UI/事件隐座位；诚意金不写座位；`IVerifier` 接口 + Stub 仅 ECDSA 路径 | 「隐私前端 + 密码学承诺；**ZK-ready**」 |
| **P1（延期）** | 最小 preimage 知识证明（circom/Noir + groth16） | ❌ deferred — 见 `circuits/README.md` |
| **P2 / G2** | Slash 仍隐藏座位 | ❌ 不承诺 |

**铁律：** 禁止空 `return true` Verifier 宣传「完整 ZK」。扣费、诚意金、slash、Points **均为真实上链**；ZK 电路未就绪时 Demo 切 P0「签名 + 承诺 + UI 隐匿」。

| 隐私档 | 行为 | 冲奖 |
|--------|------|------|
| G0 | 激活公开双方座位 | 不用 |
| **G1（MVP）** | 激活隐藏；Slash/终局揭示 | **必交** |
| G2 | Slash 仍隐藏座位 | 延期 |

**明确非目标（本版不做）：** 谣言商店、指控投票 UI、完整冷门棋规、匹配大厅、主网运营、大模型对话、用 seatStake 垫走子费。

---

## License

[MIT](./LICENSE) © 2026 H Jiang
