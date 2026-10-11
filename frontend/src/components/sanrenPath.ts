import type { MapSegment, SanrenMap } from "@sanguo/shared";

export type Project = (x: number, y: number) => [number, number];

export function segmentPath(map: SanrenMap, s: MapSegment, P: Project, scale: number): string {
  const A = map.nodes[s.a];
  const B = map.nodes[s.b];
  const [ax, ay] = P(A.x, A.y);
  const [bx, by] = P(B.x, B.y);
  const sh = s.shape;
  if (sh.type === "arc") {
    const cross = (A.x - sh.cx) * (B.y - sh.cy) - (A.y - sh.cy) * (B.x - sh.cx);
    const r = sh.radius * scale;
    return `M${ax.toFixed(2)},${ay.toFixed(2)}A${r.toFixed(2)},${r.toFixed(2)} 0 0 ${cross > 0 ? 1 : 0} ${bx.toFixed(2)},${by.toFixed(2)}`;
  }
  if (sh.type === "via") {
    const mid = sh.points.map(([x, y]) => P(x, y).map((v) => v.toFixed(2)).join(",")).join("L");
    return `M${ax.toFixed(2)},${ay.toFixed(2)}L${mid}L${bx.toFixed(2)},${by.toFixed(2)}`;
  }
  return `M${ax.toFixed(2)},${ay.toFixed(2)}L${bx.toFixed(2)},${by.toFixed(2)}`;
}
