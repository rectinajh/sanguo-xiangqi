/**
 * cyberfly.ts —— agent 侧接入层。
 * 脉冲仿真 / SpikeFrame 在 `@sanguo/shared`（浏览器与 agent 共用）。
 * 本文件保留 neuPrint / 本地文件加载。
 */
export {
  type Neuron,
  type Synapse,
  type ConnectomeSubnet,
  type Drives,
  type SensoryInput,
  type SpikeFrame,
  type Bias,
  type SimulateDetailed,
  sensorySeed,
  simulate,
  simulateDetailed,
  buildSpikeFrame,
  drivesToBias,
  syntheticSubnet,
} from "@sanguo/shared";

import type { ConnectomeSubnet, Neuron } from "@sanguo/shared";

export async function loadConnectome(cfg: {
  token?: string;
  server?: string;
  dataset?: string;
}): Promise<ConnectomeSubnet | null> {
  if (!cfg.token) return null;
  const server = (cfg.server ?? "https://neuprint.janelia.org").replace(/\/$/, "");
  const dataset = cfg.dataset ?? "male-cns:v1.0";
  try {
    const r = await fetch(`${server}/api/custom/custom`, {
      method: "POST",
      headers: { "content-type": "application/json", Authorization: `Bearer ${cfg.token}` },
      body: JSON.stringify({
        dataset,
        cypher: `MATCH (n:Neuron)
                 WHERE n.type CONTAINS 'P1' OR n.type STARTS WITH 'DN'
                 RETURN n.bodyId AS id, n.type AS type, n.instance AS instance
                 LIMIT 3000`,
      }),
    });
    if (!r.ok) return null;
    const body = (await r.json()) as { columns?: string[]; data?: unknown[][] };
    const cols = body.columns ?? [];
    const rows = (body.data ?? []).map((row) => {
      const o: Record<string, unknown> = {};
      cols.forEach((c, i) => (o[c] = row[i]));
      return o;
    });
    if (rows.length === 0) return null;
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
