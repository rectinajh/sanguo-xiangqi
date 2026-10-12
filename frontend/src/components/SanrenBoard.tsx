import { useMemo } from "react";
import { SANREN_MAP, sanrenPieceLabel, type MapPiece } from "@sanguo/shared";
import { segmentPath, type Project } from "./sanrenPath";

const U = 100;
const LINE = "#cf3a72";
const PAPER = "#f7f4ef";
const LABEL = "#d4416f";
const SEAT_INK = ["#c22a2f", "#1e2422", "#1f8a4c"];
const PIECE_R = 0.4 * U;
const RING_R = 0.18 * U;
const FACE = "Kaiti SC, STKaiti, KaiTi, Songti SC, Noto Serif SC, serif";

type Props = {
  pieces: MapPiece[];
  selected?: number | null;
  targets?: number[];
  onNode?: (node: number) => void;
};

const P: Project = (x, y) => [x * U, y * U];

export function SanrenBoard({ pieces, selected = null, targets = [], onNode }: Props) {
  const map = SANREN_MAP;
  const paths = useMemo(() => map.segments.map((s) => segmentPath(map, s, P, U)), [map]);
  const box = useMemo(() => {
    const xs = map.nodes.map((n) => n.x);
    const ys = map.nodes.map((n) => n.y);
    const pad = 0.75;
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

  return (
    <div className="sanren">
      <svg viewBox={vb.join(" ")} role="img" aria-label="三国围棋棋盘">
        <defs>
          <filter id="sanrenShadow" x="-40%" y="-40%" width="180%" height="180%">
            <feDropShadow dx="0" dy="3" stdDeviation="3" floodColor="#3a2a22" floodOpacity="0.28" />
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
          <text x={-0.6 * U} y={-5.85 * U} fontSize={0.85 * U}>棋</text>
          <text x={0.6 * U} y={-5.85 * U} fontSize={0.85 * U}>盘</text>
          <text x={-5.75 * U} y={3.55 * U} fontSize={0.95 * U}>三</text>
          <text x={-5.75 * U} y={4.75 * U} fontSize={0.95 * U}>国</text>
          <text x={5.75 * U} y={3.55 * U} fontSize={0.95 * U}>围</text>
          <text x={5.75 * U} y={4.75 * U} fontSize={0.95 * U}>棋</text>
        </g>

        <g fill="none" stroke={LINE} strokeWidth="3.4" strokeLinecap="round" strokeLinejoin="round">
          {paths.map((d, i) => (
            <path key={i} d={d} />
          ))}
        </g>

        {map.nodes
          .filter((n) => n.kind === "gate" || n.kind === "inner")
          .map((n) => (
            <circle key={`ring-${n.id}`} cx={n.x * U} cy={n.y * U} r={RING_R} fill={PAPER} stroke={LINE} strokeWidth="3.4" />
          ))}

        {map.nodes.map((n) => {
          if (!targetSet.has(n.id)) return null;
          const cap = occupied.has(n.id);
          return (
            <circle
              key={`t-${n.id}`}
              cx={n.x * U}
              cy={n.y * U}
              r={cap ? PIECE_R + 6 : 11}
              fill={cap ? "none" : "rgba(207,58,114,0.35)"}
              stroke={cap ? "#c0392b" : "none"}
              strokeWidth="4"
            />
          );
        })}

        {pieces.map((p) => {
          const n = map.nodes[p.node];
          const ink = SEAT_INK[p.seat];
          return (
            <g key={`p-${p.node}`} transform={`translate(${n.x * U} ${n.y * U})`} style={{ pointerEvents: "none" }}>
              {selected === p.node && <circle r={PIECE_R + 7} fill="none" stroke="#e0a43a" strokeWidth="4" />}
              <g filter="url(#sanrenShadow)">
                <circle r={PIECE_R} fill="url(#sanrenFace)" stroke="#d6c8ab" strokeWidth="2" />
              </g>
              <circle r={PIECE_R - 5} fill="none" stroke={ink} strokeWidth="1.6" opacity="0.55" />
              <text textAnchor="middle" dominantBaseline="central" y="1" fill={ink} fontSize={0.46 * U} fontWeight="700" fontFamily={FACE}>
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
              r={PIECE_R}
              fill="transparent"
              style={{ cursor: "pointer" }}
              onClick={() => onNode(n.id)}
            />
          ))}
      </svg>
    </div>
  );
}
