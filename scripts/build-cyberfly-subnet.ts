/**
 * build-cyberfly-subnet.ts —— 从 neuPrint 拉取真实连接组子网，导出为紧凑图格式。
 *
 * ── 为什么要裁剪 ──────────────────────────────────────────────────
 * male-cns:v1.0 实测有 **176,422 个神经元**（其中 164,506 个有类型标注，
 * 11,751 种细胞类型）。全量跑不动，也没必要 —— 我们只关心与
 * **攻击 / 求偶 / 决策输出**相关的回路。
 *
 * ── 选取策略（三步，全部用真实数据，不做人为连线）────────────────
 *   1. **种子**：下降神经元（DN*）—— 它们是"行为输出层"，把脑内决策
 *      送到腹神经索去驱动动作。这是唯一与"行为"有明确解剖学对应的族群。
 *   2. **扩张**：沿真实突触连接从种子向外扩 1–2 跳，把上游决策回路纳入。
 *   3. **裁剪**：总量控制在 --max-neurons 以内，按连接强度优先。
 *
 * 输出的边**全部来自 neuPrint 的 ConnectsTo.weight**，没有任何编造的连接。
 *
 * ── 用法 ────────────────────────────────────────────────────────
 *   NEUPRINT_TOKEN=xxx pnpm build:cyberfly-subnet
 *   # 或指定参数
 *   NEUPRINT_TOKEN=xxx npx tsx scripts/build-cyberfly-subnet.ts --max-neurons 3000 --min-weight 5
 *
 * 产物：agent/data/cyberfly-subnet.json
 *
 * ⚠️ 端点与字段名踩过坑（实测）：
 *     路径 /api/custom/custom（不是 customapi），字段 cypher（不是 query）。
 *     写错的表现是 404，与"路径不存在"无法区分。
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = join(HERE, "..", "agent", "data", "cyberfly-subnet.json");

const SERVER = (process.env.NEUPRINT_SERVER ?? "https://neuprint.janelia.org").replace(/\/$/, "");
const DATASET = process.env.NEUPRINT_DATASET ?? "male-cns:v1.0";
const TOKEN = process.env.NEUPRINT_TOKEN?.trim();

const arg = (name: string, dflt: number): number => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? Number(process.argv[i + 1]) : dflt;
};
const MAX_NEURONS = arg("max-neurons", 3000);
const MIN_WEIGHT = arg("min-weight", 5);

if (!TOKEN) {
  console.error("缺少 NEUPRINT_TOKEN。申请：https://neuprint.janelia.org/account");
  process.exit(1);
}

type Row = Record<string, unknown>;

/** 执行一次 cypher 查询，返回对象数组。 */
async function cypher(query: string): Promise<Row[]> {
  const r = await fetch(`${SERVER}/api/custom/custom`, {
    method: "POST",
    headers: { "content-type": "application/json", Authorization: `Bearer ${TOKEN}` },
    body: JSON.stringify({ dataset: DATASET, cypher: query }),
  });
  if (!r.ok) throw new Error(`neuPrint HTTP ${r.status}: ${(await r.text()).slice(0, 300)}`);
  const body = (await r.json()) as { columns?: string[]; data?: unknown[][] };
  const cols = body.columns ?? [];
  return (body.data ?? []).map((row) => {
    const o: Row = {};
    cols.forEach((c, i) => (o[c] = row[i]));
    return o;
  });
}

/**
 * 分批取行。
 *
 * 为什么必须分批：neuPrint 对单次响应有行数上限，超了会静默截断
 * （不报错，只是数据变少）。子网的边数轻易上万，所以用 SKIP/LIMIT 翻页，
 * 并以"返回行数 < 页大小"作为终止条件。
 */
async function cypherPaged(
  build: (skip: number, limit: number) => string,
  page = 5000,
  maxPages = 60
): Promise<Row[]> {
  const out: Row[] = [];
  for (let p = 0; p < maxPages; p++) {
    const rows = await cypher(build(p * page, page));
    out.push(...rows);
    if (rows.length < page) break;
  }
  return out;
}

async function main() {
  console.log(`连接组子网构建 · ${DATASET} @ ${SERVER}`);
  console.log(`  上限 ${MAX_NEURONS} 神经元 · 最小突触权重 ${MIN_WEIGHT}\n`);

  // ── 1. 种子：下降神经元（行为输出层）──────────────────────────
  const seeds = await cypher(
    `MATCH (n:Neuron) WHERE n.type STARTS WITH 'DN'
     RETURN n.bodyId AS id, n.type AS type, n.instance AS instance
     ORDER BY n.pre + n.post DESC LIMIT ${MAX_NEURONS}`
  );
  console.log(`  1) 种子（DN*）        ${seeds.length} 个`);

  const chosen = new Map<number, { type: string; instance: string; nt: string }>();
  for (const s of seeds) {
    chosen.set(Number(s.id), {
      type: String(s.type ?? ""),
      instance: String(s.instance ?? ""),
      nt: "other",
    });
  }

  // ── 2. 扩张：沿真实突触连接向种子的上游扩一跳 ────────────────
  //    先取"指向种子"的强连接，把驱动这些行为输出的上游回路纳入。
  if (chosen.size < MAX_NEURONS) {
    const seedIds = [...chosen.keys()];
    const budget = MAX_NEURONS - chosen.size;
    const upstream = await cypherPaged(
      (skip, limit) =>
        `MATCH (a:Neuron)-[c:ConnectsTo]->(b:Neuron)
         WHERE b.bodyId IN [${seedIds.join(",")}] AND c.weight >= ${MIN_WEIGHT}
         RETURN a.bodyId AS id, a.type AS type, a.instance AS instance, c.weight AS w
         ORDER BY c.weight DESC SKIP ${skip} LIMIT ${limit}`,
      5000,
      4
    );
    for (const u of upstream) {
      if (chosen.size >= MAX_NEURONS) break;
      const id = Number(u.id);
      if (chosen.has(id)) continue;
      chosen.set(id, {
        type: String(u.type ?? ""),
        instance: String(u.instance ?? ""),
        nt: "other",
      });
    }
    console.log(`  2) +上游一跳          ${chosen.size} 个（预算 ${budget}）`);
  }

  // ── 3. 取神经递质（决定兴奋 / 抑制）────────────────────────────
  //    递质信息在神经元属性里；取不到就保持 "other"（仿真按兴奋处理，
  //    并在 meta 里标注覆盖率，绝不含糊过去）。
  const ids = [...chosen.keys()];
  let ntCovered = 0;
  try {
    const ntRows = await cypherPaged(
      (skip, limit) =>
        `MATCH (n:Neuron) WHERE n.bodyId IN [${ids.join(",")}]
         RETURN n.bodyId AS id, n.nt AS nt, n.transmitter AS transmitter, n.predictedNt AS predicted
         ORDER BY n.bodyId SKIP ${skip} LIMIT ${limit}`,
      5000,
      4
    );
    for (const r of ntRows) {
      const id = Number(r.id);
      const c = chosen.get(id);
      if (!c) continue;
      const raw = String(r.nt ?? r.transmitter ?? r.predicted ?? "").toLowerCase();
      if (!raw) continue;
      c.nt = raw.includes("gaba") ? "gaba" : raw.includes("glut") ? "glut" : raw.includes("acetyl") || raw === "ach" ? "ach" : "other";
      ntCovered++;
    }
  } catch {
    /* 属性名可能随数据集版本变化；取不到就跳过，不阻塞 */
  }
  console.log(`  3) 递质标注覆盖        ${ntCovered}/${chosen.size}`);

  // ── 4. 取子网内部的所有连接（边）──────────────────────────────
  const edges = await cypherPaged(
    (skip, limit) =>
      `MATCH (a:Neuron)-[c:ConnectsTo]->(b:Neuron)
       WHERE a.bodyId IN [${ids.join(",")}] AND b.bodyId IN [${ids.join(",")}]
         AND c.weight >= ${MIN_WEIGHT}
       RETURN a.bodyId AS pre, b.bodyId AS post, c.weight AS w
       ORDER BY c.weight DESC SKIP ${skip} LIMIT ${limit}`,
    5000,
    60
  );
  console.log(`  4) 子网内连接          ${edges.length} 条`);

  // ── 5. 导出 ──────────────────────────────────────────────────
  const neurons = [...chosen.entries()].map(([id, v]) => ({
    id,
    nt: v.nt,
    type: v.type,
    instance: v.instance,
  }));
  const synapses = edges.map((e) => ({
    pre: Number(e.pre),
    post: Number(e.post),
    // 抑制性递质 → 负权重。突触数本身是"强度"，符号由递质决定。
    weight: (chosen.get(Number(e.pre))?.nt === "gaba" || chosen.get(Number(e.pre))?.nt === "glut" ? -1 : 1) * Number(e.w),
  }));

  const out = {
    name: `${DATASET} / DN 种子 + 上游一跳`,
    source: "Janelia FlyEM MaleCNS v1.0（CC-BY）https://male-cns.janelia.org/",
    builtAt: new Date().toISOString(),
    params: { maxNeurons: MAX_NEURONS, minWeight: MIN_WEIGHT, dataset: DATASET },
    stats: {
      neurons: neurons.length,
      synapses: synapses.length,
      ntCovered,
      // 递质覆盖率：低覆盖率意味着"兴奋/抑制"判断不可靠，必须显式暴露
      ntCoverage: neurons.length ? ntCovered / neurons.length : 0,
    },
    neurons,
    synapses,
  };

  mkdirSync(dirname(OUT), { recursive: true });
  writeFileSync(OUT, JSON.stringify(out));
  const mb = (JSON.stringify(out).length / 1048576).toFixed(2);
  console.log(`\n  已写入 ${OUT}`);
  console.log(`  ${neurons.length} 神经元 / ${synapses.length} 突触 / ${mb} MB`);
  console.log(`  递质覆盖率 ${(out.stats.ntCoverage * 100).toFixed(1)}%`);
  if (out.stats.ntCoverage < 0.5) {
    console.log("  ⚠️ 递质覆盖率偏低：仿真的兴奋/抑制极性不可靠，对外表述必须说明这一点");
  }
}

main().catch((e) => {
  console.error("\n构建失败:", e instanceof Error ? e.message : e);
  process.exit(1);
});
