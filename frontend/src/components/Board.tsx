import {
  BoardState,
  Piece,
  Seat,
  PIECE_LABEL_ZH,
  legalMoves,
  formatMon,
  Coord,
  type LegalMove,
  type Cell,
} from "@sanguo/shared";
import { campLines, cellPoint, HOLE, INK, LINE, PAPER, PIECE_R, place, sectorClip, VB } from "./sanrenGeometry";

type Props = {
  board: BoardState;
  mySeat: Seat | null;
  interactive: boolean;
  selected: Coord | null;
  onSelect: (c: Coord | null) => void;
  onMove: (from: Coord, to: Coord, piece: Piece) => void;
  hoverFee: { to: Coord; fee: bigint } | null;
  onHoverLegal: (info: { to: Coord; fee: bigint } | null) => void;
  ecoTargets?: Set<string>;
};

const SEAT_INK = ["#b4232a", "#245fbe", "#1c8a4e"];
const FACE = "Songti SC, STSong, Noto Serif SC, serif";

function mix(a: [number, number], b: [number, number], t: number): [number, number] {
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
}

/** Lantern inscribed in the triangular gap where the three camps meet. */
function Citadel() {
  const tip = (deg: number): [number, number] => {
    const a = (deg * Math.PI) / 180;
    return [500 - Math.sin(a) * HOLE, 500 + Math.cos(a) * HOLE];
  };
  const L = tip(120);
  const R = tip(240);
  const B = tip(0);
  const c: [number, number] = [500, 500];
  const l = mix(c, L, 0.94);
  const r = mix(c, R, 0.94);
  const b = mix(c, B, 0.94);
  const peak: [number, number] = [500, Math.min(L[1], R[1])];
  const top = mix(c, peak, 0.96);
  const inner = (p: [number, number]) => mix(c, p, 0.62);
  const n = inner(top);
  const e = inner(r);
  const s = inner(b);
  const w = inner(l);
  const ring = (p: [number, number], rad: number) => (
    <circle cx={p[0]} cy={p[1]} r={rad} fill={PAPER} />
  );
  return (
    <g fill="none" stroke={LINE} strokeWidth="1.45" strokeLinejoin="round">
      <path
        d={`M${top[0]} ${top[1]}
            C${top[0] + 36} ${top[1] + 28} ${r[0] + 8} ${r[1] - 20} ${r[0]} ${r[1]}
            C${r[0] - 6} ${r[1] + 36} ${b[0] + 28} ${b[1] - 8} ${b[0]} ${b[1]}
            C${b[0] - 28} ${b[1] - 8} ${l[0] + 6} ${l[1] + 36} ${l[0]} ${l[1]}
            C${l[0] - 8} ${l[1] - 20} ${top[0] - 36} ${top[1] + 28} ${top[0]} ${top[1]} Z`}
        fill={PAPER}
      />
      <path
        d={`M${n[0]} ${n[1]}
            Q${e[0]} ${e[1] - 8} ${e[0]} ${e[1]}
            Q${(e[0] + s[0]) / 2 + 4} ${(e[1] + s[1]) / 2} ${s[0]} ${s[1]}
            Q${(w[0] + s[0]) / 2 - 4} ${(w[1] + s[1]) / 2} ${w[0]} ${w[1]}
            Q${w[0]} ${w[1] - 8} ${n[0]} ${n[1]} Z`}
      />
      {ring(c, 16)}
      {ring(n, 10)}
      {ring(s, 10)}
      {ring(w, 10)}
      {ring(e, 10)}
      <line x1={n[0]} y1={n[1]} x2={s[0]} y2={s[1]} />
      <line x1={w[0]} y1={w[1]} x2={e[0]} y2={e[1]} />
      <line x1={n[0]} y1={n[1]} x2={w[0]} y2={w[1]} />
      <line x1={n[0]} y1={n[1]} x2={e[0]} y2={e[1]} />
      <line x1={w[0]} y1={w[1]} x2={s[0]} y2={s[1]} />
      <line x1={e[0]} y1={e[1]} x2={s[0]} y2={s[1]} />
    </g>
  );
}

export function Board({
  board,
  mySeat,
  interactive,
  selected,
  onSelect,
  onMove,
  hoverFee,
  onHoverLegal,
  ecoTargets,
}: Props) {
  const moves: LegalMove[] =
    selected && mySeat !== null && board.turn === mySeat
      ? legalMoves(board, mySeat).filter(
          (m: LegalMove) => m.from.x === selected.x && m.from.y === selected.y
        )
      : [];
  const legalKey = new Set(moves.map((m: LegalMove) => `${m.to.x},${m.to.y}`));
  const feeMap = new Map<string, LegalMove>(moves.map((m: LegalMove) => [`${m.to.x},${m.to.y}`, m]));

  const cells: { x: number; y: number; cell: Cell; pt: [number, number] }[] = [];
  board.cells.forEach((row: Cell[], y: number) => {
    row.forEach((cell: Cell, x: number) => {
      cells.push({ x, y, cell, pt: cellPoint(x, y) });
    });
  });

  return (
    <div className="sanren">
      <svg viewBox={`0 0 ${VB} ${VB}`} role="img" aria-label="三人象棋棋盘">
        <defs>
          <filter id="pieceShadow" x="-50%" y="-50%" width="200%" height="200%">
            <feDropShadow dx="0" dy="1" stdDeviation="1.1" floodColor="#6a3a3a" floodOpacity="0.28" />
          </filter>
          {[0, 120, 240].map((deg) => (
            <clipPath id={`camp-${deg}`} key={deg}>
              <polygon points={sectorClip(deg)} />
            </clipPath>
          ))}
        </defs>
        <rect x="18" y="18" width="964" height="964" fill={PAPER} stroke={LINE} strokeWidth="2.4" />
        <rect x="30" y="30" width="940" height="940" fill="none" stroke={LINE} strokeWidth="0.8" />

        <text x="500" y="86" textAnchor="middle" fill={INK} fontSize="52" fontWeight="700" fontFamily={FACE}>
          棋盘
        </text>
        <text x="108" y="730" textAnchor="middle" fill={INK} fontSize="56" fontWeight="700" fontFamily={FACE}>
          三
        </text>
        <text x="108" y="804" textAnchor="middle" fill={INK} fontSize="56" fontWeight="700" fontFamily={FACE}>
          人
        </text>
        <text x="892" y="730" textAnchor="middle" fill={INK} fontSize="56" fontWeight="700" fontFamily={FACE}>
          象
        </text>
        <text x="892" y="804" textAnchor="middle" fill={INK} fontSize="56" fontWeight="700" fontFamily={FACE}>
          棋
        </text>

        {[0, 120, 240].map((deg) => (
          <g key={deg} clipPath={`url(#camp-${deg})`} stroke={LINE} strokeWidth="1.35" fill="none" strokeLinejoin="miter">
            {campLines(deg).map((ln, i) => (
              <line key={`${deg}-${i}`} x1={ln.x1} y1={ln.y1} x2={ln.x2} y2={ln.y2} />
            ))}
          </g>
        ))}

        <Citadel />

        {cells.map(({ x, y, pt }) => {
          const key = `${x},${y}`;
          const isLegal = legalKey.has(key);
          const mv = feeMap.get(key);
          const eco = ecoTargets?.has(key);
          if (!isLegal && !eco) return null;
          const capture = mv && mv.capture !== Piece.Empty;
          return (
            <circle
              key={`mark-${key}`}
              cx={pt[0]}
              cy={pt[1]}
              r={isLegal ? 11 : 8}
              fill={capture ? "rgba(192,57,43,0.18)" : eco ? "rgba(30,157,90,0.16)" : "rgba(212,51,74,0.12)"}
              stroke={capture ? "#c0392b" : eco ? "#1e9d5a" : LINE}
              strokeWidth="2"
              strokeDasharray={eco && !isLegal ? "3 2" : undefined}
            />
          );
        })}

        {cells.map(({ x, y, cell, pt }) => {
          const key = `${x},${y}`;
          const isLegal = legalKey.has(key);
          const mv = feeMap.get(key);
          const canPick =
            interactive &&
            mySeat !== null &&
            board.turn === mySeat &&
            cell.seat === mySeat &&
            cell.piece !== Piece.Empty;
          return (
            <circle
              key={`hit-${key}`}
              cx={pt[0]}
              cy={pt[1]}
              r="20"
              fill="transparent"
              style={{ cursor: isLegal || canPick ? "pointer" : "default" }}
              onClick={() => {
                if (isLegal && selected && mv) {
                  onMove(selected, { x, y }, board.cells[selected.y][selected.x].piece);
                  onSelect(null);
                  onHoverLegal(null);
                  return;
                }
                if (canPick) onSelect({ x, y });
                else onSelect(null);
              }}
              onMouseEnter={() => {
                if (isLegal && mv) onHoverLegal({ to: { x, y }, fee: mv.fee });
              }}
              onMouseLeave={() => onHoverLegal(null)}
            />
          );
        })}

        {cells.map(({ x, y, cell, pt }) => {
          if (cell.piece === Piece.Empty || cell.seat === null) return null;
          const ink = SEAT_INK[cell.seat] ?? INK;
          const selectedHere = selected?.x === x && selected?.y === y;
          return (
            <g key={`p-${x}-${y}`} transform={`translate(${pt[0]} ${pt[1]})`} filter="url(#pieceShadow)" style={{ pointerEvents: "none" }}>
              {selectedHere && <circle r={PIECE_R + 4} fill="none" stroke="#e6b84d" strokeWidth="1.6" />}
              <circle r={PIECE_R} fill="#fffdf8" stroke={ink} strokeWidth="1.7" />
              <circle r={PIECE_R - 3.2} fill="none" stroke={ink} strokeWidth="0.7" />
              <text
                textAnchor="middle"
                dominantBaseline="central"
                y="0.6"
                fill={ink}
                fontSize="14"
                fontWeight="700"
                fontFamily={FACE}
              >
                {PIECE_LABEL_ZH[cell.piece]}
              </text>
            </g>
          );
        })}

        {hoverFee && (() => {
          const pt = cellPoint(hoverFee.to.x, hoverFee.to.y);
          const label = `${formatMon(hoverFee.fee)} MON`;
          const w = Math.max(78, label.length * 8 + 16);
          return (
            <g transform={`translate(${pt[0]} ${pt[1] - 36})`} style={{ pointerEvents: "none" }}>
              <rect x={-w / 2} y={-14} width={w} height="22" rx="4" fill="#2a1218" stroke={LINE} />
              <text textAnchor="middle" y="2" fill="#f6d5de" fontSize="13" fontFamily="JetBrains Mono, ui-monospace, monospace">
                {label}
              </text>
            </g>
          );
        })()}
      </svg>
    </div>
  );
}
