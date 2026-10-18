import { useMemo } from "react";
import { SANREN_MAP, sanrenPieceLabel, type MapPiece } from "@sanguo/shared";
import { segmentPath, type Project } from "./sanrenPath";

const U = 100;
/** Paper diagram (clean-board-ref): cream field, thin single-weight red. */
const LINE = "#dc3035";
const PAPER = "#faf6ef";
const WATERMARK = "#e87a7e";
const SEAT_INK = ["#d4212a", "#1a1a1a", "#1a9a4a"];
const PIECE_FACE = "#fffcf7";
const PIECE_R = 0.255 * U;
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

  return (
    <div className="sanren">
      <svg viewBox={vb.join(" ")} role="img" aria-label="三国象棋棋盘">
        {/* Flat cream paper — no chrome / wood */}
        <rect x={vb[0]} y={vb[1]} width={vb[2]} height={vb[3]} fill={PAPER} />
        {/* Double red border like the reference */}
        <rect
          x={vb[0] + 16}
          y={vb[1] + 16}
          width={vb[2] - 32}
          height={vb[3] - 32}
          fill="none"
          stroke={LINE}
          strokeWidth="4.5"
        />
        <rect
          x={vb[0] + 28}
          y={vb[1] + 28}
          width={vb[2] - 56}
          height={vb[3] - 56}
          fill="none"
          stroke={LINE}
          strokeWidth="1.4"
        />

        {/* Soft watermark titles (optional, reference-like) */}
        <g
          fill={WATERMARK}
          fontFamily={FACE}
          fontWeight="700"
          textAnchor="middle"
          dominantBaseline="central"
          opacity="0.38"
        >
          <text x={-0.55 * U} y={-5.85 * U} fontSize={0.78 * U}>
            棋
          </text>
          <text x={0.55 * U} y={-5.85 * U} fontSize={0.78 * U}>
            盘
          </text>
          <text x={-5.7 * U} y={3.55 * U} fontSize={0.85 * U}>
            三
          </text>
          <text x={-5.7 * U} y={4.7 * U} fontSize={0.85 * U}>
            国
          </text>
          <text x={5.7 * U} y={3.55 * U} fontSize={0.85 * U}>
            围
          </text>
          <text x={5.7 * U} y={4.7 * U} fontSize={0.85 * U}>
            棋
          </text>
        </g>

        {/* Single-weight grid — no instructional arrows */}
        <g fill="none" stroke={LINE} strokeWidth="1.85" strokeLinecap="round" strokeLinejoin="round">
          {paths.map((d, i) => (
            <path key={i} d={d} />
          ))}
        </g>

        {riverLabels.map((r) => (
          <text
            key={r.key}
            x={r.x}
            y={r.y}
            fill={WATERMARK}
            fontFamily={FACE}
            fontSize={0.36 * U}
            fontWeight="700"
            textAnchor="middle"
            dominantBaseline="central"
            opacity="0.5"
          >
            河
          </text>
        ))}

        <text
          x={center.x * U}
          y={center.y * U}
          fill={WATERMARK}
          fontFamily={FACE}
          fontSize={0.28 * U}
          fontWeight="700"
          textAnchor="middle"
          dominantBaseline="central"
          opacity="0.45"
        >
          中宫
        </text>

        {/* Subtle legal / eco targets — soft wash, not neon */}
        {map.nodes.map((n) => {
          if (!targetSet.has(n.id)) return null;
          const cap = occupied.has(n.id);
          return (
            <circle
              key={`t-${n.id}`}
              cx={n.x * U}
              cy={n.y * U}
              r={cap ? PIECE_R + 3 : 8}
              fill={cap ? "none" : "rgba(220,48,53,0.18)"}
              stroke={cap ? "rgba(220,48,53,0.55)" : "none"}
              strokeWidth="2"
            />
          );
        })}

        {/* Flat cream disks + seat-color ink (no 3D / heavy shadow) */}
        {pieces.map((p) => {
          const n = map.nodes[p.node];
          const ink = SEAT_INK[p.seat];
          return (
            <g key={`p-${p.node}`} transform={`translate(${n.x * U} ${n.y * U})`} style={{ pointerEvents: "none" }}>
              {selected === p.node && (
                <circle r={PIECE_R + 4} fill="none" stroke="rgba(224,164,58,0.75)" strokeWidth="2.2" />
              )}
              <circle r={PIECE_R} fill={PIECE_FACE} stroke={ink} strokeWidth="1.55" />
              <text
                textAnchor="middle"
                dominantBaseline="central"
                y="0.5"
                fill={ink}
                fontSize={0.34 * U}
                fontWeight="700"
                fontFamily={FACE}
              >
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
      {/* Hint lives under the diagram, not painted onto the play surface */}
      <p className="sanren-hint">
        <strong>过河：</strong>
        边兵进角后走向心干道「角→内点→中点→中宫」；辅路/中路仍进门须。过河前只能往前。出环岛转另外两营。
      </p>
    </div>
  );
}
