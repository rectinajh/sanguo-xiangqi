/**
 * Build frontend/public/cyberfly/layout.json (+ copy subnet.json) from agent data.
 * Positions map ~2500 neurons onto a MaleCNS-like brain + ventral nerve cord silhouette
 * (not a sphere blob). Run: pnpm exec tsx scripts/build-cyberfly-layout.ts
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

/** Deterministic [0,1) from neuron id + salt. */
function hash01(id: number, salt: string): number {
  const h = createHash("sha256").update(`${id}:${salt}`).digest();
  return ((h[0] << 16) | (h[1] << 8) | h[2]) / 0xffffff;
}

/**
 * Sample t along A–P axis (0=brain anterior, 1=VNC tip) with group bias
 * so P1 cluster in brain, DN lean descending/upper cord, others fill volume.
 */
function sampleT(g: string, u: number): number {
  if (g === "P1") return 0.04 + u * 0.28; // brain
  if (g === "DN") {
    // ~55% brain/neck, rest upper–mid VNC (descending)
    if (u < 0.55) return 0.06 + (u / 0.55) * 0.36;
    return 0.42 + ((u - 0.55) / 0.45) * 0.4;
  }
  if (g === "GABA") return 0.05 + u * 0.88;
  return 0.08 + u * 0.9;
}

/**
 * Cross-section radius of the CNS silhouette at parameter t.
 * Brain: large bilateral bulb; neck: pinch; VNC: long taper with slight swell.
 */
function radiusAt(t: number): number {
  if (t < 0.36) {
    // brain ellipsoid — fat middle of lobe
    const local = t / 0.36;
    return 1.55 * Math.sin(Math.PI * Math.min(1, local * 0.92 + 0.04)) + 0.35;
  }
  if (t < 0.44) {
    // cervical connective
    const local = (t - 0.36) / 0.08;
    return 0.55 * (1 - local) + 0.32 * local;
  }
  // ventral nerve cord
  const local = (t - 0.44) / 0.56;
  const taper = 0.48 * (1 - local * 0.72);
  const segments = 0.06 * Math.sin(local * Math.PI * 5);
  return Math.max(0.14, taper + segments);
}

/** Centerline curve: slight S so cord reads anatomical, not a stick. */
function centerline(t: number): { x: number; y: number; z: number } {
  // y: anterior (brain) high → posterior (VNC tip) low
  const y = 2.05 - t * 4.35;
  const x = t < 0.4 ? 0 : 0.22 * Math.sin(((t - 0.4) / 0.6) * Math.PI);
  const z = t < 0.4 ? 0.05 * Math.sin(t * 8) : -0.12 * (t - 0.4);
  return { x, y, z };
}

/** Bilateral lobe offset in brain (left/right optic/hemi feel). */
function lobeOffset(t: number, side: number): number {
  if (t >= 0.36) return 0;
  const local = t / 0.36;
  const lobe = Math.sin(Math.PI * local) * 0.55;
  return side * lobe;
}

function positionOf(n: Neu, g: string): number[] {
  const u0 = hash01(n.id, "t");
  const u1 = hash01(n.id, "theta");
  const u2 = hash01(n.id, "r");
  const u3 = hash01(n.id, "side");

  const t = sampleT(g, u0);
  const theta = u1 * Math.PI * 2;
  const rFrac = Math.sqrt(u2); // denser toward axis
  const R = radiusAt(t) * (0.22 + 0.78 * rFrac);
  const c = centerline(t);
  const side = u3 < 0.5 ? -1 : 1;
  const lx = lobeOffset(t, side);

  // Brain: flatten slightly in z (dorso-ventral), stretch x for lobes
  const xScale = t < 0.36 ? 1.15 : 1;
  const zScale = t < 0.36 ? 0.78 : 0.92;

  const x = c.x + lx + Math.cos(theta) * R * xScale;
  const y = c.y + (hash01(n.id, "yj") - 0.5) * 0.06;
  const z = c.z + Math.sin(theta) * R * zScale;

  return [
    Math.round(x * 10000) / 10000,
    Math.round(y * 10000) / 10000,
    Math.round(z * 10000) / 10000,
  ];
}

const data = JSON.parse(readFileSync(subnetPath, "utf8")) as { neurons: Neu[] };
const neurons = data.neurons;
const positions: number[][] = [];
const groups: string[] = [];
const counts: Record<string, number> = { P1: 0, DN: 0, GABA: 0, other: 0 };

for (const n of neurons) {
  const g = groupOf(n);
  groups.push(g);
  counts[g]++;
  positions.push(positionOf(n, g));
}

mkdirSync(outDir, { recursive: true });
writeFileSync(
  join(outDir, "layout.json"),
  JSON.stringify({ version: 2, count: neurons.length, positions, groups }),
);
copyFileSync(subnetPath, join(outDir, "subnet.json"));
console.log(`wrote ${neurons.length} CNS-silhouette positions → frontend/public/cyberfly/`, counts);
