/** Browser-safe cyberfly pulse sim (MaleCNS-inspired subnet). */
export type Neuron = {
  id: number;
  nt: "ach" | "gaba" | "glut" | "other";
  type?: string;
};

export type Synapse = { pre: number; post: number; weight: number };

export type ConnectomeSubnet = {
  name: string;
  source: string;
  neurons: Neuron[];
  synapses: Synapse[];
};

export type Drives = {
  aggression: number;
  avoidance: number;
  courtship: number;
};

export type SensoryInput = {
  myPointShare: number;
  myFuelRatio: number;
  contactWithAlly: number;
  inCheck: boolean;
  aliveCount: number;
  plyProgress: number;
};

export type SpikeFrame = {
  seed: number;
  ply: number;
  gameId?: string;
  neuronIds: number[];
  rates: number[];
  drives: Drives;
  /** Optional indices into subnet.synapses for drama paths */
  activeEdgeIndices?: number[];
};

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

function clamp01(x: number): number {
  return Math.max(0, Math.min(1, x));
}

function mapSensory(subnet: ConnectomeSubnet, input: SensoryInput): number[] {
  return subnet.neurons.map((n) => {
    const sign = n.nt === "ach" ? 1 : -1;
    let cur = 0;
    cur += sign * input.contactWithAlly * 1.0;
    cur += -sign * (1 - input.myFuelRatio) * 0.8;
    if (input.inCheck) cur += -sign * 0.6;
    cur += sign * (input.myPointShare - 0.33) * 0.5;
    return cur;
  });
}

export type SimulateDetailed = {
  drives: Drives;
  rates: number[];
};

export function simulateDetailed(
  subnet: ConnectomeSubnet,
  input: SensoryInput,
  opts: { steps?: number; seed: number }
): SimulateDetailed {
  const steps = opts.steps ?? 24;
  const rand = mulberry32(opts.seed);
  const I = mapSensory(subnet, input);
  const v = I.map((x) => x);
  const pot: number[] = subnet.neurons.map(() => 0);
  const fired: boolean[] = subnet.neurons.map(() => false);
  const rates: number[] = subnet.neurons.map(() => 0);
  const idx = new Map<number, number>();
  subnet.neurons.forEach((n, i) => idx.set(n.id, i));

  for (let t = 0; t < steps; t++) {
    for (let i = 0; i < pot.length; i++) {
      pot[i] = pot[i] * 0.85 + v[i] + (rand() - 0.5) * 0.05;
      fired[i] = pot[i] > 1;
      if (fired[i]) {
        pot[i] = 0;
        rates[i] += 1;
      }
    }
    for (const s of subnet.synapses) {
      const a = idx.get(s.pre);
      const b = idx.get(s.post);
      if (a === undefined || b === undefined) continue;
      if (fired[a]) v[b] += (s.weight > 0 ? 1 : -1) * Math.min(1, Math.abs(s.weight) / 10);
    }
    for (let i = 0; i < v.length; i++) v[i] = v[i] * 0.6 + I[i] * 0.4;
  }

  for (let i = 0; i < rates.length; i++) rates[i] /= steps;

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

  const aggression = meanOf((n) => /P1|^DN|DNa|DNb/i.test(n.type ?? ""));
  const avoidance = meanOf((n) => n.nt === "gaba");
  const courtship = meanOf((n) => /P1|fru|Courtship/i.test(n.type ?? ""));
  const squash = (x: number) => 1 / (1 + Math.exp(-x));

  const drives: Drives = {
    aggression: squash(
      3.0 * (aggression - 0.1) + 3.0 * input.contactWithAlly - 2.0 * (1 - input.myFuelRatio)
    ),
    avoidance: squash(
      3.0 * (avoidance - 0.1) + 2.5 * (1 - input.myFuelRatio) + (input.inCheck ? 1.5 : 0)
    ),
    courtship: squash(3.0 * (courtship - 0.1) + 1.5 * (1 - input.plyProgress) - 1.0 * input.contactWithAlly),
  };

  return { drives, rates };
}

export function simulate(
  subnet: ConnectomeSubnet,
  input: SensoryInput,
  opts: { steps?: number; seed: number }
): Drives {
  return simulateDetailed(subnet, input, opts).drives;
}

export function buildSpikeFrame(
  subnet: ConnectomeSubnet,
  input: SensoryInput,
  opts: { seed: number; ply: number; gameId?: string; steps?: number; topEdges?: number }
): SpikeFrame {
  const detailed = simulateDetailed(subnet, input, opts);
  const topEdges = opts.topEdges ?? 400;
  // Rank synapses by |pre_rate * post_rate * weight| for drama paths
  const scored: { i: number; s: number }[] = [];
  const idToRate = new Map<number, number>();
  subnet.neurons.forEach((n, i) => idToRate.set(n.id, detailed.rates[i] ?? 0));
  subnet.synapses.forEach((syn, i) => {
    const a = idToRate.get(syn.pre) ?? 0;
    const b = idToRate.get(syn.post) ?? 0;
    const s = a * b * Math.abs(syn.weight);
    if (s > 0) scored.push({ i, s });
  });
  scored.sort((x, y) => y.s - x.s);
  const activeEdgeIndices = scored.slice(0, topEdges).map((x) => x.i);
  return {
    seed: opts.seed,
    ply: opts.ply,
    gameId: opts.gameId,
    neuronIds: subnet.neurons.map((n) => n.id),
    rates: detailed.rates,
    drives: detailed.drives,
    activeEdgeIndices,
  };
}

export type Bias = {
  preferCapture: number;
  preferCheap: number;
  preferBetray: number;
  mood: string;
};

export function drivesToBias(d: Drives, input: SensoryInput): Bias {
  const preferCapture = clamp01(d.aggression * 0.7 + (1 - input.myFuelRatio) * 0.3);
  const preferCheap = clamp01(d.avoidance * 0.8 + (1 - input.myPointShare) * 0.2);
  const preferBetray = clamp01(d.aggression * 0.6 + input.contactWithAlly * 0.5 - d.courtship * 0.4);
  let mood: string;
  if (preferBetray > 0.7) mood = "高度攻击性，且已经把盟友的破绽看得清清楚楚";
  else if (preferCapture > 0.6) mood = "躁动、想找机会吃子施压";
  else if (preferCheap > 0.6) mood = "紧张、想省油、避免正面冲突";
  else if (d.courtship > 0.6) mood = "倾向于维持盟约、不想先动手";
  else mood = "平静观察";
  return { preferCapture, preferCheap, preferBetray, mood };
}

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
