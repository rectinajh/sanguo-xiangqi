import { describe, it, expect } from "vitest";
import {
  simulate,
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
