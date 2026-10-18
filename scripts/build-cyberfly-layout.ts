/**
 * Build frontend/public/cyberfly/layout.json (+ copy subnet.json) from agent data.
 * Run: pnpm exec tsx scripts/build-cyberfly-layout.ts
 */
import { readFileSync, writeFileSync, mkdirSync, copyFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const subnetPath = join(root, "agent/data/cyberfly-subnet.json");
const outDir = join(root, "frontend/public/cyberfly");

type Neu = { id: number; nt?: string; type?: string };

function groupOf(n: Neu): string {
  const t = n.type ?? "";
  const nt = n.nt ?? "";
  if (t.includes("P1") || t.toLowerCase().includes("fru") || t.includes("Courtship")) return "P1";
  if (t.startsWith("DN") || t.includes("DNa") || t.includes("DNb")) return "DN";
  if (nt === "gaba") return "GABA";
  return "other";
}

const data = JSON.parse(readFileSync(subnetPath, "utf8")) as { neurons: Neu[] };
const neurons = data.neurons;
const shellR: Record<string, number> = { P1: 1.0, DN: 1.6, GABA: 2.2, other: 2.9 };
const counts: Record<string, number> = { P1: 0, DN: 0, GABA: 0, other: 0 };
for (const n of neurons) counts[groupOf(n)]++;
const idxIn: Record<string, number> = { P1: 0, DN: 0, GABA: 0, other: 0 };
const positions: number[][] = [];
const groups: string[] = [];
for (const n of neurons) {
  const g = groupOf(n);
  groups.push(g);
  const i = idxIn[g]++;
  const N = Math.max(1, counts[g]);
  const h = createHash("sha256").update(String(n.id)).digest("hex");
  const jitter = (parseInt(h.slice(0, 6), 16) / 0xffffff - 0.5) * 0.08;
  const offset = 2 / N;
  const y = i * offset - 1 + offset / 2;
  const rXy = Math.sqrt(Math.max(0, 1 - y * y));
  const phi = i * 2.399963229728653;
  const r = shellR[g] + jitter;
  positions.push([
    Math.round(Math.cos(phi) * rXy * r * 10000) / 10000,
    Math.round(y * r * 10000) / 10000,
    Math.round(Math.sin(phi) * rXy * r * 10000) / 10000,
  ]);
}
mkdirSync(outDir, { recursive: true });
writeFileSync(join(outDir, "layout.json"), JSON.stringify({ version: 1, count: neurons.length, positions, groups }));
copyFileSync(subnetPath, join(outDir, "subnet.json"));
console.log(`wrote ${neurons.length} positions → frontend/public/cyberfly/`);
