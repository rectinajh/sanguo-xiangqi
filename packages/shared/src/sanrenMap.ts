// Three-player board map (see docs/SANREN_RULES.md).
// Unit = one file spacing. Origin = board center, y grows downward.
// Camp geometry is built once in the black (bottom) frame and rotated 120°/240°.

export const CAMP_RED = 0;
export const CAMP_BLACK = 1;
export const CAMP_GREEN = 2;
export const CITADEL = 3;

export interface MapNode {
  id: number;
  key: string;
  x: number;
  y: number;
  /** 0 red, 1 black, 2 green, 3 citadel */
  camp: number;
  /** local file 0..8 (camp nodes only, else -1) */
  f: number;
  /** local rank 0..4 (camp nodes only, else -1) */
  r: number;
  /** other (camp,f,r) names this point carries */
  alias: { camp: number; f: number; r: number }[];
  kind: "point" | "gate" | "inner" | "center";
}

export type SegShape =
  | { type: "line" }
  | { type: "arc"; cx: number; cy: number; radius: number }
  | { type: "via"; points: [number, number][] };

export interface MapSegment {
  a: number;
  b: number;
  shape: SegShape;
}

export interface MapLine {
  name: string;
  nodes: number[];
}

export interface SanrenMap {
  nodes: MapNode[];
  segments: MapSegment[];
  lines: MapLine[];
  /** palace node ids per camp */
  palace: number[][];
  /** radius of the outermost node from center */
  extent: number;
}

export const GEOM = {
  /** r3 depth on the camp axis */
  h3: 3.63,
  /** rank spacing */
  s: 1,
  gate: 1.74,
  corner: 2.28,
  inner: 0.785,
  cross: 0.8,
  whiskerX: 1,
  /**
   * 每营横向收缩系数（相对标准 f0–f8 全宽）。
   * <1 会在邻营之间留出「河」缝，避免卒线外角贴死/叠子。
   */
  fileScale: 0.72,
};

const SQ3 = Math.sqrt(3);
/** angle (deg) that maps the black frame onto camp c */
const CAMP_ANGLE = [120, 0, 240];
/** rotation index k: black 0, red 1, green 2 */
const K_CAMP = [CAMP_BLACK, CAMP_RED, CAMP_GREEN];
/** camp sitting on the f0 side of camp c */
export const prevCamp = (c: number) => K_CAMP[(K_CAMP.indexOf(c) + 1) % 3];
/** camp sitting on the f8 side of camp c */
export const nextCamp = (c: number) => K_CAMP[(K_CAMP.indexOf(c) + 2) % 3];

function rot(p: [number, number], deg: number): [number, number] {
  const t = (deg * Math.PI) / 180;
  const c = Math.cos(t);
  const s = Math.sin(t);
  return [p[0] * c - p[1] * s, p[0] * s + p[1] * c];
}

export function buildSanrenMap(g = GEOM): SanrenMap {
  const yF1 = 5 / SQ3;
  const a = (9 + yF1 * yF1 - g.h3 * g.h3) / (2 * g.h3 - 2 * yF1);
  const radius = (r: number) => g.h3 + a + (3 - r) * g.s;
  const arcY = (x: number, r: number) => -a + Math.sqrt(radius(r) ** 2 - x * x);

  const nodes: MapNode[] = [];
  const byKey = new Map<string, number>();
  const add = (key: string, p: [number, number], camp: number, f: number, r: number, kind: MapNode["kind"] = "point") => {
    for (const n of nodes) {
      if (Math.hypot(n.x - p[0], n.y - p[1]) < 1e-6) {
        if (camp !== CITADEL) n.alias.push({ camp, f, r });
        byKey.set(key, n.id);
        return n.id;
      }
    }
    const id = nodes.length;
    nodes.push({ id, key, x: p[0], y: p[1], camp, f, r, alias: [], kind });
    byKey.set(key, id);
    return id;
  };
  const cn = (c: number, f: number, r: number) => byKey.get(`${c}:${f}:${r}`)!;
  const cz = (name: string) => byKey.get(`z:${name}`)!;

  const localPoint = (f: number, r: number): [number, number] => {
    // 横向收窄：三营之间留河缝；不再用外角共点几何（pCorner）
    const x = (f - 4) * g.fileScale;
    return [x, arcY(x, r)];
  };

  for (const c of [CAMP_BLACK, CAMP_RED, CAMP_GREEN]) {
    for (let r = 0; r <= 4; r++) {
      for (let f = 0; f <= 8; f++) {
        // r4 覆盖全宽：隔位兵在 f0/f8 也能向河沿（朝中宫）进一步
        add(`${c}:${f}:${r}`, rot(localPoint(f, r), CAMP_ANGLE[c]), c, f, r);
      }
    }
  }

  const dirL: [number, number] = [-SQ3 / 2, 0.5];
  const dirR: [number, number] = [SQ3 / 2, 0.5];
  const sideR = (() => {
    const k = [dirL[0] * g.corner, dirL[1] * g.corner];
    const yc = (k[0] ** 2 + k[1] ** 2 - g.gate ** 2) / (2 * (k[1] - g.gate));
    return { yc, rad: g.gate - yc };
  })();
  const sideY = (x: number) => sideR.yc + Math.sqrt(sideR.rad ** 2 - x * x);
  add("z:C", [0, 0], CITADEL, -1, -1, "center");
  for (const c of [CAMP_BLACK, CAMP_RED, CAMP_GREEN]) {
    const t = CAMP_ANGLE[c];
    add(`z:G${c}`, rot([0, g.gate], t), CITADEL, -1, -1, "gate");
    add(`z:X${c}`, rot([0, g.cross], t), CITADEL, -1, -1);
    add(`z:K${c}`, rot([dirL[0] * g.corner, dirL[1] * g.corner], t), CITADEL, -1, -1);
    add(`z:I${c}`, rot([dirL[0] * g.inner, dirL[1] * g.inner], t), CITADEL, -1, -1, "inner");
    add(`z:WL${c}`, rot([-g.whiskerX, sideY(g.whiskerX)], t), CITADEL, -1, -1);
    add(`z:WR${c}`, rot([g.whiskerX, sideY(g.whiskerX)], t), CITADEL, -1, -1);
  }

  const segments: MapSegment[] = [];
  const segKeys = new Set<string>();
  const seg = (a: number, b: number, shape: SegShape = { type: "line" }) => {
    const k = a < b ? `${a}-${b}` : `${b}-${a}`;
    if (segKeys.has(k)) return;
    segKeys.add(k);
    segments.push({ a, b, shape });
  };
  const arcAbout = (c: number, rad: number): SegShape => {
    const o = rot([0, -a], CAMP_ANGLE[c]);
    return { type: "arc", cx: o[0], cy: o[1], radius: rad };
  };

  const lines: MapLine[] = [];
  const palace: number[][] = [[], [], []];

  for (const c of [CAMP_BLACK, CAMP_RED, CAMP_GREEN]) {
    const p = prevCamp(c);
    const nx = nextCamp(c);
    const t = CAMP_ANGLE[c];

    for (let r = 0; r <= 2; r++) {
      const ids = [];
      for (let f = 0; f <= 8; f++) ids.push(cn(c, f, r));
      for (let i = 0; i < 8; i++) seg(ids[i], ids[i + 1], arcAbout(c, radius(r)));
      lines.push({ name: `${c}:r${r}`, nodes: ids });
    }
    const r4 = [0, 1, 2, 3, 4, 5, 6, 7, 8].map((f) => cn(c, f, 4));
    for (let i = 0; i < 8; i++) seg(r4[i], r4[i + 1], arcAbout(c, radius(4)));
    lines.push({ name: `${c}:r4`, nodes: r4 });

    // 卒线只连本营，不与邻营外角拼接 —— 营间是「河」，过河走中宫
    const r3 = [0, 1, 2, 3, 4, 5, 6, 7, 8].map((f) => cn(c, f, 3));
    for (let i = 0; i < 8; i++) seg(r3[i], r3[i + 1], arcAbout(c, radius(3)));
    lines.push({ name: `${c}:r3`, nodes: r3 });

    for (let f = 0; f <= 8; f++) {
      const ids = [];
      for (let r = 0; r <= 4; r++) ids.push(cn(c, f, r));
      for (let i = 0; i < ids.length - 1; i++) seg(ids[i], ids[i + 1]);
      if (f === 4) {
        const ext = [cz(`G${c}`), cz(`X${c}`), cz("C")];
        seg(ids[ids.length - 1], ext[0]);
        seg(ext[0], ext[1]);
        seg(ext[1], ext[2]);
        ids.push(...ext);
      }
      // 边线文件也记入纵线，便于车炮沿线计步
      lines.push({ name: `${c}:f${f}`, nodes: ids });
    }

    const d1 = [cn(c, 3, 0), cn(c, 4, 1), cn(c, 5, 2)];
    const d2 = [cn(c, 5, 0), cn(c, 4, 1), cn(c, 3, 2)];
    seg(d1[0], d1[1]); seg(d1[1], d1[2]); seg(d2[0], d2[1]); seg(d2[1], d2[2]);
    lines.push({ name: `${c}:pal1`, nodes: d1 }, { name: `${c}:pal2`, nodes: d2 });
    for (let f = 3; f <= 5; f++) for (let r = 0; r <= 2; r++) palace[c].push(cn(c, f, r));

    const side = [cz(`K${c}`), cz(`WL${c}`), cz(`G${c}`), cz(`WR${c}`), cz(`K${nx}`)];
    const sideShape: SegShape = (() => {
      const o = rot([0, sideR.yc], t);
      return { type: "arc", cx: o[0], cy: o[1], radius: sideR.rad };
    })();
    for (let i = 0; i < 4; i++) seg(side[i], side[i + 1], sideShape);
    lines.push({ name: `z:side${c}`, nodes: side });

    const gl = [cz(`G${c}`), cz(`I${c}`), cz(`G${p}`)];
    seg(gl[0], gl[1]); seg(gl[1], gl[2]);
    lines.push({ name: `z:gate${c}`, nodes: gl });
  }

  // Inner arc of sector c runs I(next) -> X(c) -> I(c); whiskers continue it straight through the inner circles.
  for (const c of [CAMP_BLACK, CAMP_RED, CAMP_GREEN]) {
    const nx = nextCamp(c);
    const p = prevCamp(c);
    const iA = nodes[cz(`I${nx}`)];
    const iB = nodes[cz(`I${c}`)];
    const xm = nodes[cz(`X${c}`)];
    const circ = circleThrough([iA.x, iA.y], [xm.x, xm.y], [iB.x, iB.y]);
    const arc: SegShape = { type: "arc", ...circ };
    seg(iA.id, xm.id, arc);
    seg(xm.id, iB.id, arc);
    const wA = cz(`WL${nx}`);
    const wB = cz(`WR${p}`);
    seg(wA, iA.id);
    seg(iB.id, wB);
    lines.push({ name: `z:inner${c}`, nodes: [wA, iA.id, xm.id, iB.id, wB] });
  }

  const extent = Math.max(...nodes.map((n) => Math.hypot(n.x, n.y)));
  return { nodes, segments, lines, palace, extent };
}

function circleThrough(p1: [number, number], p2: [number, number], p3: [number, number]) {
  const [ax, ay] = p1;
  const [bx, by] = p2;
  const [qx, qy] = p3;
  const d = 2 * (ax * (by - qy) + bx * (qy - ay) + qx * (ay - by));
  const ux = ((ax * ax + ay * ay) * (by - qy) + (bx * bx + by * by) * (qy - ay) + (qx * qx + qy * qy) * (ay - by)) / d;
  const uy = ((ax * ax + ay * ay) * (qx - bx) + (bx * bx + by * by) * (ax - qx) + (qx * qx + qy * qy) * (bx - ax)) / d;
  return { cx: ux, cy: uy, radius: Math.hypot(ax - ux, ay - uy) };
}

export const SANREN_MAP = buildSanrenMap();
