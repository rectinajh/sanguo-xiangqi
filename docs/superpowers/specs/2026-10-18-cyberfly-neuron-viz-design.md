# 赛博果蝇三维神经网络可视化 — 设计文档

- 日期：2026-10-18
- 仓库：`rectinajh/sanguo-xiangqi`
- 状态：已与产品方确认，待写实现计划

## 1. 摘要 / 目标 / 非目标

### 目标

在对局前端做出「人类棋手对账 AI 果蝇大脑」的观感：

1. **一期（旁观侧栏）**：棋盘旁固定侧栏展示三维连接组；AI 每思考一次，播放基于真实 `simulate` 发放率的神经电信号，并叠加戏剧化闪烁与路径高亮。
2. **二期（神经元浏览器）**：同一套场景进入全屏模式，可旋转缩放、点选关键节点、浏览邻居子图。

核心体验一句话：**真实决策骨架可复现 + 果蝇大闹式视觉张力**。

### 非目标（本期不做）

- 不声称「果蝇真在下棋」；文案必须保留诚实边界（动力学推断）。
- 不把棋盘 154 点图与连接组图混成一张图。
- 一期不做完整浏览器交互（点选/搜索/邻居展开留给二期）。
- 不在本期重做 `cyberfly` 生物物理模型本身。

## 2. 体验与布局

### 对局页布局

- 主区：现有三人象棋棋盘与座位面板。
- **右侧固定侧栏**「果蝇大脑」：
  - 上部：R3F 三维场景（全量子网点 + 边）。
  - 下部：三根 drive 条 — `aggression` / `avoidance` / `courtship`，与当前冲动同步。
  - 角标/脚注：数据来源与诚实声明（MaleCNS 子网；非真实思维）。
  - 入口：「打开神经元浏览器」（二期启用；一期可灰显或隐藏）。

### 状态

| 状态 | 视觉 |
|------|------|
| 空闲 | 全网点淡显；P1 / DN / GABA 等族群常驻色标 |
| AI 思考中 | 发放率抬亮度 + 短火花；活跃突触路径高亮（戏剧层） |
| 思考结束 | 余晖短暂衰减，回到空闲；drive 条停在本步最终值 |

### 关键节点呈现（已确认）

**族群色标 + 放电高亮同时存在**：平时靠颜色认族群，思考时再看谁在放。

## 3. 数据模型与通道

### 既有基础

- `agent/src/cyberfly.ts`：`simulate()`、`Drives`、`SensoryInput`。
- 子网文件：`agent/data/cyberfly-subnet.json`（约 2500 神经元 / 约 8 万突触）。
- 确定性：`sensorySeed` + mulberry32，同局面可复现。

### 新增：`SpikeFrame`

Agent 在每步 `simulate` 后导出一帧（名称可微调，语义固定）：

```ts
type SpikeFrame = {
  gameId: string;
  ply: number;
  seed: number;
  /** neuron bodyId → 发放强度 0..1（由仿真 rates 归一化） */
  rates: Record<number, number> | Float32ArrayPayload;
  /** 可选：本帧活跃边（pre, post, strength），供路径高亮 */
  activeEdges?: Array<{ pre: number; post: number; w: number }>;
  drives: { aggression: number; avoidance: number; courtship: number };
  mood?: string;
};
```

### 通道

1. **主路径**：agent → 现有游戏/事件通道（与走子事件同生命周期）→ 前端订阅。
2. **缺帧回退**：前端若只收到 drives/seed，可用同一 seed 与静态子网在本地重放轻量仿真（或播放预计算帧），保证演示可复现。
3. **静态资产**：预计算 3D 布局 JSON（每个 neuron 的 x,y,z + 族群标签），运行时不做力导向全量布局。

## 4. 架构

```
agent simulate ──▶ SpikeFrame ──▶ 事件通道 ──▶ frontend store
                      │                           │
                      │                           ▼
               cyberfly-subnet.json      ConnectomeScene (R3F)
               + layout.json             ├── InstancedNeurons
                                         ├── SynapseLines
                                         ├── SpikeDramaLayer
                                         └── DriveMeters (DOM/HTML)
```

- `ConnectomeScene`：旁观侧栏与二期浏览器共用。
- 布局与棋盘组件解耦；侧栏挂载失败不得阻断走子。

## 5. 渲染与性能

### 技术选型（已确认）

**React Three Fiber + 实例化点 / 边 buffer**。

### 策略

1. **点**：全量 ~2500，`InstancedMesh` 或 points；颜色 = 族群，亮度 = 发放率。
2. **边**：默认尝试全量线段；若 FPS 持续低于阈值（如 30），自动按权重/活跃度降采样边，并在 UI 轻提示「已降采样突触」。
3. **戏剧层**：在真实 rates 之上加短时 bloom/闪烁与路径描边，不改动写入账本的 drives。
4. **性能偏好（已确认）**：先全量点和边，卡了再优化。

## 6. 分期范围

### 一期（本设计首先交付）

- 对局侧栏三维图 + 族群色标 + 思考放电 + drive 条。
- Agent 导出 `SpikeFrame` 并接通前端。
- 预计算布局资产。
- 掉帧自动裁边。
- 诚实文案。

### 二期

- 全屏神经元浏览器：轨道控制、点选节点、邻居子图、按 bodyId/type 搜索。
- 从侧栏一键进入/返回对局。

## 7. 测试

- `SpikeFrame` 与同一 `seed` 重放结果一致（抽样神经元 rates / drives）。
- 侧栏挂载与卸载不破坏棋盘点击与合法着法提示。
- 无 agent 帧时回退路径仍可播放且不抛未捕获异常。
- 可选：人工/自动检查掉帧时边降采样开关触发。

## 8. 风险与约束

| 风险 | 处理 |
|------|------|
| 8 万边拖垮笔记本 GPU | 自动裁边 + 布局预计算 |
| 叙事越界（「果蝇真思维」） | UI 固定诚实声明；对外文案复用 README 口径 |
| 事件通道延迟 | seed 回退；思考态以「收到帧/开始思考」事件驱动 |
| Cloud / 本机实现分叉 | 实现以本仓库 frontend+agent 为准，布局资产入仓 |

## 9. 成功标准（一期）

1. 对局中打开侧栏能看到三维子网与族群色。
2. AI 每步思考时有可见电信号，且 drives 与 agent 一致。
3. 关闭/收起侧栏不影响下棋。
4. 文档与 UI 均不声称生物真实思维。
