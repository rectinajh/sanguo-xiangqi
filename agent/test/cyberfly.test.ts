import { describe, it, expect } from "vitest";
import {
  loadConnectome,
  simulate,
  simulateDetailed,
  buildSpikeFrame,
  drivesToBias,
  syntheticSubnet,
  sensorySeed,
  type SensoryInput,
} from "../src/cyberfly.js";

const base: SensoryInput = {
  myPointShare: 0.33,
  myFuelRatio: 0.8,
  contactWithAlly: 0.5,
  inCheck: false,
  aliveCount: 3,
  plyProgress: 0.2,
};

describe("cyberfly 脉冲仿真", () => {
  it("同一输入 + 同一 seed → 完全相同的冲动（演示必须可复现）", () => {
    const sub = syntheticSubnet(48);
    const seed = sensorySeed(base, 1n, 5);
    const a = simulate(sub, base, { seed });
    const b = simulate(sub, base, { seed });
    expect(a).toEqual(b);
  });

  it("不同局面 → 不同冲动（否则等于没接）", () => {
    const sub = syntheticSubnet(48);
    const calm = simulate(sub, base, { seed: sensorySeed(base, 1n, 5) });
    const tense: SensoryInput = { ...base, contactWithAlly: 0.95, myFuelRatio: 0.1, inCheck: true };
    const hot = simulate(sub, tense, { seed: sensorySeed(tense, 1n, 5) });
    expect(JSON.stringify(calm)).not.toBe(JSON.stringify(hot));
  });

  it("三个 drive 都落在 0..1（下游要当概率/权重用）", () => {
    const sub = syntheticSubnet(48);
    for (const inp of [base, { ...base, contactWithAlly: 0 }, { ...base, myFuelRatio: 0 }]) {
      const d = simulate(sub, inp, { seed: sensorySeed(inp, 2n, 3) });
      for (const [k, v] of Object.entries(d)) {
        expect(v, `${k} 越界`).toBeGreaterThanOrEqual(0);
        expect(v, `${k} 越界`).toBeLessThanOrEqual(1);
      }
    }
  });

  it("空子网不崩（没有 token 时的降级路径）", () => {
    const empty = { name: "empty", source: "test", neurons: [], synapses: [] };
    const d = simulate(empty, base, { seed: 1 });
    expect(d.aggression).toBeGreaterThanOrEqual(0);
    expect(d.avoidance).toBeGreaterThanOrEqual(0);
  });
});

describe("冲动 → 策略偏置", () => {
  it("高攻击 + 近距离盟友 → 背刺倾向高，且情绪描述提到盟友破绽", () => {
    const b = drivesToBias({ aggression: 0.95, avoidance: 0.1, courtship: 0.05 }, {
      ...base,
      contactWithAlly: 0.95,
    });
    expect(b.preferBetray).toBeGreaterThan(0.7);
    expect(b.mood).toContain("盟友");
  });

  it("高回避 + 点数落后 → 倾向走便宜着法", () => {
    const b = drivesToBias({ aggression: 0.1, avoidance: 0.95, courtship: 0.1 }, {
      ...base,
      myPointShare: 0,
    });
    expect(b.preferCheap).toBeGreaterThan(0.6);
  });

  it("偏置都在 0..1", () => {
    const b = drivesToBias({ aggression: 1, avoidance: 1, courtship: 1 }, base);
    for (const v of [b.preferCapture, b.preferCheap, b.preferBetray]) {
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThanOrEqual(1);
    }
  });
});

describe("sensorySeed", () => {
  it("同一局面同一 seed；不同局面不同 seed", () => {
    expect(sensorySeed(base, 1n, 5)).toBe(sensorySeed(base, 1n, 5));
    expect(sensorySeed(base, 1n, 5)).not.toBe(sensorySeed(base, 1n, 6));
  });
  it("输出是 32 位无符号整数", () => {
    const s = sensorySeed(base, 999999n, 77);
    expect(Number.isInteger(s)).toBe(true);
    expect(s).toBeGreaterThanOrEqual(0);
    expect(s).toBeLessThan(2 ** 32);
  });
});


describe("simulateDetailed / SpikeFrame", () => {
  it("rates 长度等于神经元数，同 seed 可复现", () => {
    const sub = syntheticSubnet(48);
    const seed = sensorySeed(base, 1n, 5);
    const a = simulateDetailed(sub, base, { seed });
    const b = simulateDetailed(sub, base, { seed });
    expect(a.rates.length).toBe(sub.neurons.length);
    expect(a.rates).toEqual(b.rates);
    expect(a.drives).toEqual(simulate(sub, base, { seed }));
  });

  it("buildSpikeFrame 带 neuronIds 与活跃边", () => {
    const sub = syntheticSubnet(48);
    const seed = sensorySeed(base, 1n, 5);
    const frame = buildSpikeFrame(sub, base, { seed, ply: 5, topEdges: 20 });
    expect(frame.neuronIds.length).toBe(48);
    expect(frame.rates.length).toBe(48);
    expect(frame.activeEdgeIndices!.length).toBeLessThanOrEqual(20);
  });
});

describe("neuPrint 接入（端点格式回归）", () => {
  it("没有 token 时直接返回 null，不发任何请求", async () => {
    const net = await loadConnectome({ token: undefined });
    expect(net).toBeNull();
  });

  it("token 被拒（非 2xx）时返回 null，不抛异常", async () => {
    // 用一个语法合法但必然无效的 token，确认失败路径是"静默降级"而不是崩溃
    const net = await loadConnectome({ token: "definitely-not-a-real-token" });
    expect(net).toBeNull();
  });

  /**
   * ⚠️ 这条是真正的回归保护。
   *
   * 我实测踩过：neuPrint 的查询端点是 /api/custom/custom（**不是** customapi），
   * 查询字段名是 cypher（**不是** query）。两者写错都返回
   * 404 {"message":"Not Found"} —— 而"路径根本不存在"也是 404，
   * 极容易误判成"token 无效"。权威来源是官方客户端 neuprint-python 的 client.py。
   *
   * 这里不断言真实网络结果（CI 里要能离线跑），只钉住"失败时降级为 null"的契约。
   */
  it("loadConnectome 永不抛异常（对局不能被连接组拖垮）", async () => {
    const net = await loadConnectome({ token: "x", server: "https://127.0.0.1:9", dataset: "d" });
    expect(net).toBeNull();
  });
});
