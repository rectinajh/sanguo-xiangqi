import { useMemo } from "react";
import { SANREN_MAP, nextCamp, sanrenPieceLabel, type MapPiece } from "@sanguo/shared";
import { segmentPath, type Project } from "./sanrenPath";

const U = 100;
const LINE = "#cf3a72";
const GUIDE = "#c44a6e";
const PAPER = "#f7f4ef";
const LABEL = "#d4416f";
const SEAT_INK = ["#c22a2f", "#1e2422", "#1f8a4c"];
const PIECE_R = 0.28 * U;
const RING_R = 0.14 * U;
const FACE = "Kaiti SC, STKaiti, KaiTi, Songti SC, Noto Serif SC, serif";
/** 三路过河入口（辅路 / 中路） */
const LANE_FILES = [2, 4, 6] as const;
/** 边兵所在文件；箭头单独画，避免与邻营边线叠成 X */
const EDGE_FILES = [0, 8] as const;

type Props = {
  pieces: MapPiece[];
  selected?: number | null;
  targets?: number[];
  onNode?: (node: number) => void;
};

const P: Project = (x, y) => [x * U, y * U];

function campNode(map: typeof SANREN_MAP, camp: number, f: number, r: number) {
  return map.nodes.find((n) => n.camp === camp && n.f === f && n.r === r);
}

function arrowHead(x0: number, y0: number, x1: number, y1: number, size = 0.14 * U) {
  const dx = x1 - x0;
  const dy = y1 - y0;
  const len = Math.hypot(dx, dy) || 1;
  const ux = dx / len;
  const uy = dy / len;
  const px = -uy;
  const py = ux;
  const tipX = x1;
  const tipY = y1;
  const bx = tipX - ux * size;
  const by = tipY - uy * size;
  return `${tipX},${tipY} ${bx + px * size * 0.55},${by + py * size * 0.55} ${bx - px * size * 0.55},${by - py * size * 0.55}`;
}

function midArrow(a: { x: number; y: number }, b: { x: number; y: number }, size?: number) {
  const ax = a.x * U;
  const ay = a.y * U;
  const bx = b.x * U;
  const by = b.y * U;
  const mx = ax * 0.35 + bx * 0.65;
  const my = ay * 0.35 + by * 0.65;
  return arrowHead(ax, ay, mx, my, size);
}

function exitArrowOffset(center: { x: number; y: number }, gate: { x: number; y: number }, size = 0.12 * U) {
  const dx = gate.x - center.x;
  const dy = gate.y - center.y;
  const len = Math.hypot(dx, dy) || 1;
  const ux = dx / len;
  const uy = dy / len;
  const ox = -uy * 0.22;
  const oy = ux * 0.22;
  const x0 = (center.x + ux * 0.35 + ox) * U;
  const y0 = (center.y + uy * 0.35 + oy) * U;
  const x1 = (center.x + ux * 0.7 + ox) * U;
  const y1 = (center.y + uy * 0.7 + oy) * U;
  return arrowHead(x0, y0, x1, y1, size);
}

export function SanrenBoard({ pieces, selected = null, targets = [], onNode }: Props) {
  const map = SANREN_MAP;
  const paths = useMemo(() => map.segments.map((s) => segmentPath(map, s, P, U)), [map]);

  /** 三路并进：r3 → r4 */
  const advanceArrows = useMemo(() => {
    const out: { points: string; key: string }[] = [];
    for (const c of [0, 1, 2]) {
      for (const f of LANE_FILES) {
        const a = campNode(map, c, f, 3);
        const b = campNode(map, c, f, 4);
        if (!a || !b) continue;
        out.push({ key: `adv-${c}-${f}`, points: midArrow(a, b, 0.11 * U) });
      }
    }
    return out;
  }, [map]);

  /** 边兵：r3→r4 前进，再直进中宫角点（不横走） */
  const edgeSoldierArrows = useMemo(() => {
    const out: { points: string; key: string }[] = [];
    for (const c of [0, 1, 2]) {
      for (const f of EDGE_FILES) {
        const a = campNode(map, c, f, 3);
        const b = campNode(map, c, f, 4);
        if (a && b) out.push({ key: `edge-adv-${c}-${f}`, points: midArrow(a, b, 0.1 * U) });
      }
      const f0 = campNode(map, c, 0, 4);
      const f8 = campNode(map, c, 8, 4);
      const k = map.nodes.find((n) => n.key === `z:K${c}`);
      const kn = map.nodes.find((n) => n.key === `z:K${nextCamp(c)}`);
      if (f0 && k) out.push({ key: `edge-in-${c}-L`, points: midArrow(f0, k, 0.12 * U) });
      if (f8 && kn) out.push({ key: `edge-in-${c}-R`, points: midArrow(f8, kn, 0.12 * U) });
    }
    return out;
  }, [map]);

  /** 辅路/中路进环岛：f2→左须、f4→门、f6→右须 */
  const entryArrows = useMemo(() => {
    const out: { points: string; key: string }[] = [];
    for (const c of [0, 1, 2]) {
      const f2 = campNode(map, c, 2, 4);
      const f4 = campNode(map, c, 4, 4);
      const f6 = campNode(map, c, 6, 4);
      const wl = map.nodes.find((n) => n.key === `z:WL${c}`);
      const wr = map.nodes.find((n) => n.key === `z:WR${c}`);
      const gate = map.nodes.find((n) => n.key === `z:G${c}`);
      if (f2 && wl) out.push({ key: `in-${c}-L`, points: midArrow(f2, wl, 0.12 * U) });
      if (f4 && gate) out.push({ key: `in-${c}-M`, points: midArrow(f4, gate, 0.13 * U) });
      if (f6 && wr) out.push({ key: `in-${c}-R`, points: midArrow(f6, wr, 0.12 * U) });
    }
    return out;
  }, [map]);

  /** 边兵进角后的向心干道：角→内点→中点→中宫（不绕辅路，少横移） */
  const edgeThroughArrows = useMemo(() => {
    const out: { points: string; key: string }[] = [];
    const center = map.nodes.find((n) => n.kind === "center");
    if (!center) return out;
    for (const c of [0, 1, 2]) {
      const k = map.nodes.find((n) => n.key === `z:K${c}`);
      const inner = map.nodes.find((n) => n.key === `z:I${c}`);
      const x = map.nodes.find((n) => n.key === `z:X${c}`);
      if (k && inner) out.push({ key: `thru-${c}-KI`, points: midArrow(k, inner, 0.11 * U) });
      if (inner && x) out.push({ key: `thru-${c}-IX`, points: midArrow(inner, x, 0.1 * U) });
      if (x) out.push({ key: `thru-${c}-XC`, points: midArrow(x, center, 0.11 * U) });
    }
    return out;
  }, [map]);

  const islandRing = useMemo(() => {
    const gates = [0, 1, 2].map((c) => map.nodes.find((n) => n.key === `z:G${c}`)!);
    if (gates.some((g) => !g)) return "";
    return gates.map((g, i) => `${i === 0 ? "M" : "L"} ${g.x * U},${g.y * U}`).join(" ") + " Z";
  }, [map]);

  const exitArrows = useMemo(() => {
    const center = map.nodes.find((n) => n.kind === "center")!;
    return [0, 1, 2].map((c) => {
      const gate = map.nodes.find((n) => n.key === `z:G${c}`)!;
      return { key: `out-${c}`, points: exitArrowOffset(center, gate) };
    });
  }, [map]);

  const riverLabels = useMemo(() => {
    const edge = (c: number, f: number) => map.nodes.find((n) => n.camp === c && n.f === f && n.r === 3)!;
    const pairs: [number, number, number, number][] = [
      [0, 0, 2, 8],
      [0, 8, 1, 0],
      [1, 8, 2, 0],
    ];
    return pairs.map(([c0, f0, c1, f1], i) => {
      const a = edge(c0, f0);
      const b = edge(c1, f1);
      return { key: `river-${i}`, x: ((a.x + b.x) / 2) * U, y: ((a.y + b.y) / 2) * U };
    });
  }, [map]);

  const box = useMemo(() => {
    const xs = map.nodes.map((n) => n.x);
    const ys = map.nodes.map((n) => n.y);
    const pad = 0.85;
    return {
      x0: Math.min(...xs) - pad,
      y0: Math.min(...ys) - pad,
      x1: Math.max(...xs) + pad,
      y1: Math.max(...ys) + pad,
    };
  }, [map]);
  const vb = [box.x0 * U, box.y0 * U, (box.x1 - box.x0) * U, (box.y1 - box.y0) * U];
  const targetSet = new Set(targets);
  const occupied = new Map(pieces.map((p) => [p.node, p]));
  const center = map.nodes.find((n) => n.kind === "center")!;

  return (
    <div className="sanren">
      <svg viewBox={vb.join(" ")} role="img" aria-label="三国围棋棋盘">
        <defs>
          <filter id="sanrenShadow" x="-40%" y="-40%" width="180%" height="180%">
            <feDropShadow dx="0" dy="2" stdDeviation="2" floodColor="#3a2a22" floodOpacity="0.22" />
          </filter>
          <radialGradient id="sanrenFace" cx="42%" cy="36%" r="70%">
            <stop offset="0%" stopColor="#fffdf7" />
            <stop offset="100%" stopColor="#efe6d3" />
          </radialGradient>
        </defs>

        <rect x={vb[0]} y={vb[1]} width={vb[2]} height={vb[3]} fill={PAPER} />
        <rect x={vb[0] + 14} y={vb[1] + 14} width={vb[2] - 28} height={vb[3] - 28} fill="none" stroke={LINE} strokeWidth="5" />
        <rect x={vb[0] + 26} y={vb[1] + 26} width={vb[2] - 52} height={vb[3] - 52} fill="none" stroke={LINE} strokeWidth="1.6" />

        <g fill={LABEL} fontFamily={FACE} fontWeight="700" textAnchor="middle" dominantBaseline="central" opacity="0.92">
          <text x={-0.6 * U} y={-5.85 * U} fontSize={0.85 * U}>
            棋
          </text>
          <text x={0.6 * U} y={-5.85 * U} fontSize={0.85 * U}>
            盘
          </text>
          <text x={-5.75 * U} y={3.55 * U} fontSize={0.95 * U}>
            三
          </text>
          <text x={-5.75 * U} y={4.75 * U} fontSize={0.95 * U}>
            国
          </text>
          <text x={5.75 * U} y={3.55 * U} fontSize={0.95 * U}>
            围
          </text>
          <text x={5.75 * U} y={4.75 * U} fontSize={0.95 * U}>
            棋
          </text>
        </g>

        <g fill="none" stroke={LINE} strokeWidth="2.8" strokeLinecap="round" strokeLinejoin="round" opacity="0.88">
          {paths.map((d, i) => (
            <path key={i} d={d} />
          ))}
        </g>

        {islandRing && (
          <path d={islandRing} fill="none" stroke={GUIDE} strokeWidth="2.5" strokeDasharray="5 5" opacity="0.32" />
        )}

        <g fill={GUIDE} opacity="0.5">
          {advanceArrows.map((a) => (
            <polygon key={a.key} points={a.points} />
          ))}
        </g>
        <g fill={GUIDE} opacity="0.58">
          {edgeSoldierArrows.map((a) => (
            <polygon key={a.key} points={a.points} />
          ))}
        </g>
        <g fill={GUIDE} opacity="0.7">
          {entryArrows.map((a) => (
            <polygon key={a.key} points={a.points} />
          ))}
        </g>
        <g fill={GUIDE} opacity="0.72">
          {edgeThroughArrows.map((a) => (
            <polygon key={a.key} points={a.points} />
          ))}
        </g>
        <g fill={GUIDE} opacity="0.55">
          {exitArrows.map((a) => (
            <polygon key={a.key} points={a.points} />
          ))}
        </g>

        {riverLabels.map((r) => (
          <text
            key={r.key}
            x={r.x}
            y={r.y}
            fill={LABEL}
            fontFamily={FACE}
            fontSize={0.38 * U}
            fontWeight="700"
            textAnchor="middle"
            dominantBaseline="central"
            opacity="0.55"
          >
            河
          </text>
        ))}

        <text
          x={center.x * U}
          y={center.y * U}
          fill={GUIDE}
          fontFamily={FACE}
          fontSize={0.32 * U}
          fontWeight="700"
          textAnchor="middle"
          dominantBaseline="central"
          opacity="0.75"
        >
          中宫
        </text>

        {map.nodes
          .filter((n) => n.kind === "gate" || n.kind === "inner")
          .map((n) => (
            <circle key={`ring-${n.id}`} cx={n.x * U} cy={n.y * U} r={RING_R} fill={PAPER} stroke={LINE} strokeWidth="2.8" />
          ))}

        {map.nodes.map((n) => {
          if (!targetSet.has(n.id)) return null;
          const cap = occupied.has(n.id);
          return (
            <circle
              key={`t-${n.id}`}
              cx={n.x * U}
              cy={n.y * U}
              r={cap ? PIECE_R + 5 : 9}
              fill={cap ? "none" : "rgba(207,58,114,0.35)"}
              stroke={cap ? "#c0392b" : "none"}
              strokeWidth="3"
            />
          );
        })}

        {pieces.map((p) => {
          const n = map.nodes[p.node];
          const ink = SEAT_INK[p.seat];
          return (
            <g key={`p-${p.node}`} transform={`translate(${n.x * U} ${n.y * U})`} style={{ pointerEvents: "none" }}>
              {selected === p.node && <circle r={PIECE_R + 5} fill="none" stroke="#e0a43a" strokeWidth="3" />}
              <g filter="url(#sanrenShadow)">
                <circle r={PIECE_R} fill="url(#sanrenFace)" stroke="#d6c8ab" strokeWidth="1.6" />
              </g>
              <circle r={PIECE_R - 3.5} fill="none" stroke={ink} strokeWidth="1.3" opacity="0.55" />
              <text textAnchor="middle" dominantBaseline="central" y="0.5" fill={ink} fontSize={0.34 * U} fontWeight="700" fontFamily={FACE}>
                {sanrenPieceLabel(p.piece, p.seat)}
              </text>
            </g>
          );
        })}

        {onNode &&
          map.nodes.map((n) => (
            <circle
              key={`hit-${n.id}`}
              cx={n.x * U}
              cy={n.y * U}
              r={Math.max(PIECE_R, 0.32 * U)}
              fill="transparent"
              style={{ cursor: "pointer" }}
              onClick={() => onNode(n.id)}
            />
          ))}
      </svg>
      <p className="sanren-hint">
        <strong>过河：</strong>
        边兵进角后走向心干道「角→内点→中点→中宫」，不绕辅路、少横移；辅路/中路仍进门须。过河前只能往前。出环岛转另外两营。
      </p>
    </div>
  );
}
