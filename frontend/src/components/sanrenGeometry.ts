/**
 * Three-camp board matching the physical 三人象棋 map:
 * bottom camp upright, left and right camps rotated 120° / 240°,
 * a citadel where the three grids meet.
 * Logical cells stay on the 11×11 engine; each cell sits on an intersection.
 */

export const VB = 1000;

const CX = 500;
const CY = 500;
const S = 40;
const INNER = 52;
/** Radial cut that keeps the camps from drawing through one another. */
export const HOLE = 118;

export function rot(dx: number, dy: number, deg: number): [number, number] {
  const a = (deg * Math.PI) / 180;
  const c = Math.cos(a);
  const s = Math.sin(a);
  return [dx * c - dy * s, dx * s + dy * c];
}

/** u: file 0..10, v: rank 0..5 with 0 = back rank (outer). */
export function place(u: number, v: number, deg: number): [number, number] {
  const dx = (u - 5) * S;
  const dy = INNER + (5 - v) * S;
  const [rx, ry] = rot(dx, dy, deg);
  return [CX + rx, CY + ry];
}

export function cellPoint(x: number, y: number): [number, number] {
  if (y >= 5) return place(x, 10 - y, 0);
  if (x < 5) return place(5 - x, y, 120);
  if (x > 5) return place(x - 5, y, 240);
  const inner = place(5, 5, 0);
  return [inner[0], inner[1] - (5 - y) * S];
}

export const LINE = "#d6456a";
export const PAPER = "#f3ecdf";
export const INK = "#c73348";
export const PIECE_R = 14;

export function campCorners(deg: number): [number, number][] {
  return [place(0, 0, deg), place(10, 0, deg), place(10, 5, deg), place(0, 5, deg)];
}

/** Outward 120° wedge. Camps are clipped to this so shared edges stay clean. */
export function sectorClip(deg: number, hole = HOLE): string {
  const a = (deg * Math.PI) / 180;
  const ox = -Math.sin(a);
  const oy = Math.cos(a);
  const px = Math.cos(a);
  const py = Math.sin(a);
  const half = Math.PI / 3;
  const reach = 1100;
  const side = (sign: number): [number, number] => {
    const dx = ox * Math.cos(half) + sign * px * Math.sin(half);
    const dy = oy * Math.cos(half) + sign * py * Math.sin(half);
    return [CX + dx * reach, CY + dy * reach];
  };
  const apex: [number, number] = [CX + ox * hole, CY + oy * hole];
  const [left, right] = [side(-1), side(1)];
  return [left, right, apex].map((p) => `${p[0].toFixed(1)},${p[1].toFixed(1)}`).join(" ");
}

export function campLines(deg: number): { x1: number; y1: number; x2: number; y2: number }[] {
  const lines = [];
  for (let v = 0; v <= 5; v++) {
    const a = place(0, v, deg);
    const b = place(10, v, deg);
    lines.push({ x1: a[0], y1: a[1], x2: b[0], y2: b[1] });
  }
  for (let u = 0; u <= 10; u++) {
    const a = place(u, 0, deg);
    const b = place(u, 5, deg);
    lines.push({ x1: a[0], y1: a[1], x2: b[0], y2: b[1] });
  }
  const p00 = place(4, 0, deg);
  const p22 = place(6, 2, deg);
  const p20 = place(6, 0, deg);
  const p02 = place(4, 2, deg);
  lines.push({ x1: p00[0], y1: p00[1], x2: p22[0], y2: p22[1] });
  lines.push({ x1: p20[0], y1: p20[1], x2: p02[0], y2: p02[1] });
  return lines;
}
