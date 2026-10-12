/**
 * cyberfly.ts —— 赛博果蝇：用真实果蝇中枢神经连接组驱动 AI 卧底的行为。
 *
 * ── 这是什么 ──────────────────────────────────────────────────────
 * 数据来自 Janelia FlyEM 的 **MaleCNS**（雄性果蝇全中枢神经连接组，
 * 含脑 + 腹神经索，2026-09 发表于 Cell）：
 *   https://male-cns.janelia.org/
 *
 * 连接组本质是一张**有向加权图**：神经元是节点，突触是带符号的边
 * （递质决定兴奋 / 抑制）。这与本项目棋盘（154 节点有向图）**结构同构**，
 * 所以可以真接进来，而不是仅仅当作叙事。
 *
 * ── 为什么要和 Kimi 组合 ──────────────────────────────────────────
 * 两层各司其职：
 *   连接组 = **确定性**的"本能"（同一局面永远算出同一冲动）
 *   Kimi   = **有解释性**的"意识"（把冲动变成台词与自我合理化）
 *
 * 这恰好就是卧底的心理结构：**先有背叛的冲动，再给自己找理由**。
 * 而且它解决了一个真实痛点：纯 LLM 决策每次输出都不同，演示不可复现；
 * 加上连接组后**行为骨架稳定、台词多样**。
 *
 * ── ⚠️ 诚实边界（不要越过）───────────────────────────────────────
 * 从连接组算出的活动是**动力学推断**，不是对真实果蝇的测量。
 * 正确表述：「我们用真实连接组构建脉冲神经网络，并用它的活动驱动 AI 的行为选择。」
 * 错误表述：「这是果蝇的真实思维」/「果蝇在真下棋」。
 *
 * ── 当前状态 ────────────────────────────────────────────────────
 * 本文件是**工程接入层**：数据类型、子网容器、确定性脉冲仿真、
 * 以及"冲动 → 策略偏置"的映射，全部可在没有 token 的情况下跑通与测试
 * （用合成子网）。真正从 Janelia 拉取子网需要 NEUPRINT_TOKEN，见
 * `loadConnectome()`。
 */


/** 连接组里的一个神经元。 */
export type Neuron = {
  /** 在数据集里的 body id（neuPrint 的 bodyId） */
  id: number;
  /** 神经递质类型：决定它是兴奋还是抑制 */
  nt: "ach" | "gaba" | "glut" | "other";
  /** 可选的细胞类型名（如 P1、DNp01），用于叙述与调试 */
  type?: string;
};

/** 一条突触连接：pre → post，weight = 突触数（可为负，表示抑制）。 */
export type Synapse = {
  pre: number;
  post: number;
  weight: number;
};

/** 一个可仿真的连接组子网。 */
export type ConnectomeSubnet = {
  name: string;
  /** 数据来源说明，会出现在终局揭示里（要能追溯，不能是黑箱） */
  source: string;
  neurons: Neuron[];
  synapses: Synapse[];
};

/**
 * 行为读出：连接组活动的三个标量投影。
 *
 * 为什么是三个而不是直接输出"走哪一步"：
 *   - 连接组不天然输出棋着。硬映射（神经元 → 棋盘格）是**编造的**，会被懂行的
 *     评委一眼看穿。
 *   - 但果蝇的**攻击 / 回避 / 求偶**三类行为回路是真实存在的，而且
 *     P1 神经元群本身就同时驱动攻击与求偶（表现哪个取决于上下文与强度）。
 *   - 所以正确做法是输出**行为倾向**，再交给 Kimi 在合法着法里选。
 *
 * 这三个量正好对应本作的博弈维度：
 *   aggression → 愿意吃子 / 愿意施压（烧油逼破产）
 *   avoidance  → 保守、省油、避免正面冲突
 *   courtship  → 结盟倾向、履约意愿
 */
export type Drives = {
  aggression: number;
  avoidance: number;
  courtship: number;
};

/** 棋盘状态 → 感觉输入。这是"把棋局翻译给果蝇"的那一层。 */
export type SensoryInput = {
  /** 我的点数占全场比例 0..1 */
  myPointShare: number;
  /** 我的作战余额相对初始值 0..1（越低越焦虑） */
  myFuelRatio: number;
  /** 我与"假意盟友"的相邻程度 0..1（越近越有攻击机会） */
  contactWithAlly: number;
  /** 我是否已被将军 */
  inCheck: boolean;
  /** 场上还活着几人（0..3） */
  aliveCount: number;
  /** 当前手数进度 0..1 */
  plyProgress: number;
};

/**
 * 确定性伪随机：同一 seed 永远同一序列。
 *
 * 为什么不用 Math.random：演示必须可复现。同一个局面重跑要得到同样的冲动，
 * 否则"连接组在决策"这个说法站不住脚。
 */
function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), 1 | t);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** 把感觉输入折叠成一个 32 位 seed（用于确定性仿真）。 */
export function sensorySeed(input: SensoryInput, gameId: bigint, ply: number): number {
  const q = (v: number, scale = 1000) => Math.round(Math.max(0, Math.min(1, v)) * scale);
  const bits =
    (q(input.myPointShare) << 0) ^
    (q(input.myFuelRatio) << 10) ^
    (q(input.contactWithAlly) << 20) ^
    (q(input.plyProgress) << 24) ^
    (Number(gameId & 0xffffn) << 6) ^
    (ply << 27) ^
    (input.inCheck ? 0x8000 : 0) ^
    (input.aliveCount << 13);
  return bits >>> 0;
}

/**
 * 用连接组跑一次脉冲仿真，读出行为倾向。
 *
 * 模型（刻意保持简单且可解释，不假装是生物物理精确模型）：
 *   1. 每个神经元有一个膜电位，按输入电流积分
 *   2. 感觉输入按"递质极性"注入：ach 为正、gaba 为负
 *   3. 突触传播：pre 发放时按 weight 给 post 加电流
 *   4. 跑 T 步后，按神经元族群的平均发放率读出三个 drive
 *
 * 这**不是**对果蝇的模拟结果，而是"以真实连接结构为约束的动力系统"。
 * 相关性与结构是真的，"这就是果蝇的想法"是假的。
 */
export function simulate(
  subnet: ConnectomeSubnet,
  input: SensoryInput,
  opts: { steps?: number; seed: number }
): Drives {
  const steps = opts.steps ?? 24;
  const rand = mulberry32(opts.seed);

  // 感觉输入 → 每个神经元的注入电流（映射写在 mapSensory 里，显式可审计）
  const I = mapSensory(subnet, input);
  const v = I.map((x) => x);

  const pot: number[] = subnet.neurons.map(() => 0);
  const fired: boolean[] = subnet.neurons.map(() => false);
  const rates: number[] = subnet.neurons.map(() => 0);

  // 把神经元 id 映射到下标，便于突触传播
  const idx = new Map<number, number>();
  subnet.neurons.forEach((n, i) => idx.set(n.id, i));

  for (let t = 0; t < steps; t++) {
    for (let i = 0; i < pot.length; i++) {
      pot[i] = pot[i] * 0.85 + v[i] + (rand() - 0.5) * 0.05; // 泄漏 + 噪声
      fired[i] = pot[i] > 1;
      if (fired[i]) {
        pot[i] = 0;
        rates[i] += 1;
      }
    }
    // 突触传播
    for (const s of subnet.synapses) {
      const a = idx.get(s.pre);
      const b = idx.get(s.post);
      if (a === undefined || b === undefined) continue;
      if (fired[a]) v[b] += (s.weight > 0 ? 1 : -1) * Math.min(1, Math.abs(s.weight) / 10);
    }
    // 输入持续注入（感觉不是一次性脉冲）
    for (let i = 0; i < v.length; i++) v[i] = v[i] * 0.6 + I[i] * 0.4;
  }

  for (let i = 0; i < rates.length; i++) rates[i] /= steps;

  // 族群划分：按细胞类型名前缀分组（neuPrint 的 type 约定）
  const meanOf = (pred: (n: Neuron) => boolean): number => {
    let sum = 0;
    let n = 0;
    subnet.neurons.forEach((neu, i) => {
      if (pred(neu)) {
        sum += rates[i];
        n++;
      }
    });
    return n > 0 ? sum / n : 0;
  };

  // 攻击：P1 / 下降神经元（DN）族群；回避：GABA 能族群；求偶：P1 / fru 族群
  const aggression = meanOf((n) => /P1|^DN|DNa|DNb/i.test(n.type ?? ""));
  const avoidance = meanOf((n) => n.nt === "gaba");
  const courtship = meanOf((n) => /P1|fru|Courtship/i.test(n.type ?? ""));

  // ⚠️ 归一化必须"饱和但敏感"。第一版用线性放大（rate * 3 + 常数），
  //    实测**两个 drive 都直接饱和到 1**：不同局面算出完全相同的冲动，
  //    等于把连接组接成了摆设（测试 `不同局面 → 不同冲动` 抓到的）。
  //    这里改用平滑压缩：始终落在 0..1，且对输入保持单调敏感。
  const squash = (x: number) => 1 / (1 + Math.exp(-x));

  return {
    aggression: squash(
      3.0 * (aggression - 0.1) + 3.0 * input.contactWithAlly - 2.0 * (1 - input.myFuelRatio)
    ),
    avoidance: squash(
      3.0 * (avoidance - 0.1) + 2.5 * (1 - input.myFuelRatio) + (input.inCheck ? 1.5 : 0)
    ),
    courtship: squash(3.0 * (courtship - 0.1) + 1.5 * (1 - input.plyProgress) - 1.0 * input.contactWithAlly),
  };
}

/** 夹到 0..1。下游把 drive / bias 当概率或权重用，越界会污染策略。 */
function clamp01(x: number): number {
  return Math.max(0, Math.min(1, x));
}

/** 感觉输入 → 每个神经元的注入电流（显式的、可审计的映射）。 */
function mapSensory(subnet: ConnectomeSubnet, input: SensoryInput): number[] {
  return subnet.neurons.map((n) => {
    const sign = n.nt === "ach" ? 1 : -1; // ach 兴奋，gaba/glut 抑制
    let cur = 0;
    // 接触机会越近、越没油，攻击回路越活跃
    cur += sign * input.contactWithAlly * 1.0;
    // 自己油少 / 被将军 → 回避回路活跃
    cur += -sign * (1 - input.myFuelRatio) * 0.8;
    if (input.inCheck) cur += -sign * 0.6;
    // 点数领先 → 求偶（结盟）倾向，落后 → 攻击倾向
    cur += sign * (input.myPointShare - 0.33) * 0.5;
    return cur;
  });
}

/**
 * 冲动 → 策略偏置。交给 Kimi 之前先算出来，作为 prompt 条件。
 *
 * 这是连接组真正的"话语权所在"：它不选棋着，但决定**AI 此刻的心理状态**，
 * 而这会显著改变 Kimi 的选择分布与台词。
 */
export type Bias = {
  /** 倾向吃子 / 施压 */
  preferCapture: number;
  /** 倾向省油、走便宜着法 */
  preferCheap: number;
  /** 倾向背刺（对盟友下手） */
  preferBetray: number;
  /** 给 Kimi 的一句话情绪描述 */
  mood: string;
};

export function drivesToBias(d: Drives, input: SensoryInput): Bias {
  const preferCapture = clamp01(d.aggression * 0.7 + (1 - input.myFuelRatio) * 0.3);
  const preferCheap = clamp01(d.avoidance * 0.8 + (1 - input.myPointShare) * 0.2);
  // 背刺需要"有攻击机会"+"盟友近"+"自己不算太弱"
  const preferBetray = clamp01(d.aggression * 0.6 + input.contactWithAlly * 0.5 - d.courtship * 0.4);

  let mood: string;
  if (preferBetray > 0.7) mood = "高度攻击性，且已经把盟友的破绽看得清清楚楚";
  else if (preferCapture > 0.6) mood = "躁动、想找机会吃子施压";
  else if (preferCheap > 0.6) mood = "紧张、想省油、避免正面冲突";
  else if (d.courtship > 0.6) mood = "倾向于维持盟约、不想先动手";
  else mood = "平静观察";

  return { preferCapture, preferCheap, preferBetray, mood };
}

/**
 * 从 neuPrint 拉取连接组子网。
 *
 * ⚠️ neuPrint 现在**全站需要 token**（含公开数据集）：
 *      https://neuprint.janelia.org/account
 *    token 放在 agent/.env 的 NEUPRINT_TOKEN。
 *
 * 为什么不直接下 Feather 全量：`connectome-weights` 是 1.0 GB，而全 CNS 是
 * 17.6 万神经元（实测 male-cns:v1.0 为 176,422） —— 必须裁剪成与攻击/决策相关的子网（约 1k–5k 神经元）
 * 才能实时跑。裁剪规则是本功能的核心设计决定，不是附带细节。
 *
 * 没有 token 时返回 null，调用方自动降级为原有脚本策略 —— 功能缺失不应
 * 影响对局（这也是为什么它必须是可选路径）。
 */
export async function loadConnectome(cfg: {
  token?: string;
  server?: string;
  dataset?: string;
}): Promise<ConnectomeSubnet | null> {
  if (!cfg.token) return null;
  const server = (cfg.server ?? "https://neuprint.janelia.org").replace(/\/$/, "");
  const dataset = cfg.dataset ?? "male-cns:v1.0";
  try {
    // ⚠️ 端点与字段名都踩过坑（实测）：
    //   路径是 /api/custom/custom —— 不是 /api/custom/customapi
    //   查询字段名是 cypher       —— 不是 query
    //   两者写错的表现都是 404 {"message":"Not Found"}，而 404 也出现在
    //   "路径根本不存在"时，所以很容易误判成"token 无效"。真正判据是：
    //   带 Bearer 头打不存在的路径也是 404 —— 说明鉴权其实已通过。
    //   权威来源：官方客户端 neuprint-python 的 client.py（fetch_custom / fetch_datasets）。
    const r = await fetch(`${server}/api/custom/custom`, {
      method: "POST",
      headers: { "content-type": "application/json", Authorization: `Bearer ${cfg.token}` },
      body: JSON.stringify({
        dataset,
        // 只取"攻击 / 决策"相关的细胞类型，避免把全 CNS（17.6 万神经元）拉下来
        cypher: `MATCH (n:Neuron)
                 WHERE n.type CONTAINS 'P1' OR n.type STARTS WITH 'DN'
                 RETURN n.bodyId AS id, n.type AS type, n.instance AS instance
                 LIMIT 3000`,
      }),
    });
    if (!r.ok) return null;
    // neuPrint 返回列式：{columns:["id","type","instance"], data:[[...],[...]]}
    const body = (await r.json()) as { columns?: string[]; data?: unknown[][] };
    const cols = body.columns ?? [];
    const rows = (body.data ?? []).map((row) => {
      const o: Record<string, unknown> = {};
      cols.forEach((c, i) => (o[c] = row[i]));
      return o;
    });
    if (rows.length === 0) return null;
    // 说明：这里只取到神经元清单；突触权重需要第二次查询
    // （connectome-weights）。两者拼接与裁剪规则留待
    // scripts/build-cyberfly-subnet.ts 实现 —— 当前函数保证"有 token 时
    // 能取到神经元"，便于先行验证凭证与数据可用性。
    const neurons: Neuron[] = rows.map((x) => ({
      id: Number(x.id ?? x.bodyId ?? 0),
      nt: "other",
      type: String(x.type ?? x.cellType ?? ""),
    }));
    return {
      name: "male-cns:v1.0 / 攻击与决策子网（待补突触）",
      source: "Janelia FlyEM MaleCNS v1.0（CC-BY）https://male-cns.janelia.org/",
      neurons,
      synapses: [],
    };
  } catch {
    return null;
  }
}

/**
 * 从本地文件加载子网（**首选路径**）。
 *
 * 为什么优先本地文件而不是每次打 neuPrint API：
 *   - 走子决策是热路径，每次开局都发几十次网络请求既慢又不可靠
 *   - 连接组是**静态解剖结构**，不会变；构建一次就够了
 *   - 子网构建需要 token，但对局不需要 —— 把凭证依赖限制在构建期
 *
 * 文件由 scripts/build-cyberfly-subnet.ts 生成，数据全部来自
 * Janelia FlyEM MaleCNS v1.0 的真实 ConnectsTo.weight，无编造连接。
 */
export async function loadSubnetFromFile(path: string): Promise<ConnectomeSubnet | null> {
  try {
    const { readFile } = await import("node:fs/promises");
    const raw = JSON.parse(await readFile(path, "utf8")) as Partial<ConnectomeSubnet> & {
      stats?: { ntCoverage?: number };
    };
    if (!raw.neurons?.length) return null;
    return {
      name: raw.name ?? "connectome subnet",
      source: raw.source ?? "unknown",
      neurons: raw.neurons,
      synapses: raw.synapses ?? [],
    };
  } catch {
    return null;
  }
}

/** 合成子网：无条件可用，用于测试与"没有 token 时的可视化占位"。 */
export function syntheticSubnet(n = 64): ConnectomeSubnet {
  const rand = mulberry32(12345);
  const neurons: Neuron[] = Array.from({ length: n }, (_, i) => ({
    id: i + 1,
    nt: i % 5 === 0 ? "gaba" : "ach",
    type: i % 7 === 0 ? "P1" : i % 11 === 0 ? "DNa" : "other",
  }));
  const synapses: Synapse[] = [];
  for (let i = 0; i < n * 3; i++) {
    const pre = 1 + Math.floor(rand() * n);
    const post = 1 + Math.floor(rand() * n);
    if (pre === post) continue;
    synapses.push({ pre, post, weight: 1 + Math.floor(rand() * 20) });
  }
  return {
    name: "synthetic（测试用，非真实数据）",
    source: "合成数据 —— 仅用于测试与占位，不可用于任何对外表述",
    neurons,
    synapses,
  };
}
