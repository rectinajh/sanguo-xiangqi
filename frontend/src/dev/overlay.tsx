import React, { useMemo, useState } from "react";
import ReactDOM from "react-dom/client";
import { buildSanrenMap, GEOM } from "@sanguo/shared";
import { segmentPath } from "../components/sanrenPath";

const W = 1024;
const H = 957;

function Overlay() {
  const q = new URLSearchParams(location.search);
  const [cx, setCx] = useState(Number(q.get("cx") ?? 503.5));
  const [cy, setCy] = useState(Number(q.get("cy") ?? 474.5));
  const [d, setD] = useState(Number(q.get("d") ?? 67));
  const [h3, setH3] = useState(GEOM.h3);
  const [op, setOp] = useState(0.6);
  const vx = Number(q.get("vx") ?? 0);
  const vy = Number(q.get("vy") ?? 0);
  const vw = Number(q.get("vw") ?? W);
  const map = useMemo(() => buildSanrenMap({ ...GEOM, h3 }), [h3]);
  const P = (x: number, y: number): [number, number] => [cx + x * d, cy + y * d];
  const num = (label: string, v: number, set: (n: number) => void, step: number) => (
    <label style={{ marginRight: 12 }}>
      {label} <input type="number" step={step} value={v} onChange={(e) => set(Number(e.target.value))} style={{ width: 70 }} />
    </label>
  );
  return (
    <div>
      <div style={{ marginBottom: 6 }}>
        {num("cx", cx, setCx, 0.5)}
        {num("cy", cy, setCy, 0.5)}
        {num("d", d, setD, 0.5)}
        {num("h3", h3, setH3, 0.02)}
        {num("照片", op, setOp, 0.1)}
        <span>节点 {map.nodes.length} · 线段 {map.segments.length} · 线 {map.lines.length}</span>
      </div>
      <svg id="overlay" viewBox={`${vx} ${vy} ${vw} ${vw * (H / W)}`} style={{ background: "#fff", width: `min(98vw, ${(92 * W) / H}vh)` }}>
        <image href="/dev/board-photo.jpg" width={W} height={H} opacity={op} />
        {map.segments.map((s, i) => (
          <path key={i} d={segmentPath(map, s, P, d)} fill="none" stroke="#0070ff" strokeWidth={1.6} opacity={0.85} />
        ))}
        {map.nodes.map((n) => {
          const [x, y] = P(n.x, n.y);
          return <circle key={n.id} cx={x} cy={y} r={n.kind === "point" ? 3 : 6} fill="none" stroke="#00c060" strokeWidth={1.6} />;
        })}
      </svg>
    </div>
  );
}

ReactDOM.createRoot(document.getElementById("root")!).render(<Overlay />);
