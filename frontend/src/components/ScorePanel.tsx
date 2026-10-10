import { Seat, SEAT_LABEL_ZH, SEAT_COLOR, formatMon } from "@sanguo/shared";

export type SeatView = {
  seat: Seat;
  playBalance: bigint;
  points: number;
  seatStake: bigint;
  eliminated: boolean;
  isYou?: boolean;
  address?: string;
};

type Props = {
  seats: SeatView[];
  turn: Seat;
};

export function ScorePanel({ seats, turn }: Props) {
  return (
    <div className="panel">
      <h2>双账本</h2>
      {seats.map((s) => (
        <div
          key={s.seat}
          className={`score-card ${turn === s.seat ? "active" : ""} ${s.eliminated ? "eliminated" : ""}`}
        >
          <div className="name">
            <span>
              <span className="dot" style={{ background: SEAT_COLOR[s.seat] }} />
              {SEAT_LABEL_ZH[s.seat]}
              {s.isYou ? " · 你" : ""}
              {s.eliminated ? " · 出局" : turn === s.seat ? " · 行棋中" : ""}
            </span>
            <span style={{ fontSize: "0.75rem", color: "var(--muted)" }}>
              {s.address ? `${s.address.slice(0, 6)}…${s.address.slice(-4)}` : "未入座"}
            </span>
          </div>
          <div className="metrics">
            <div className="k">作战余额</div>
            <div className="v">{formatMon(s.playBalance)} MON</div>
            <div className="k">Points</div>
            <div className="v">{s.points}</div>
            <div className="k">座位质押</div>
            <div className="v">{formatMon(s.seatStake)} MON</div>
            <div className="k">状态</div>
            <div className="v">{s.eliminated ? "已出局" : "在局"}</div>
          </div>
        </div>
      ))}
    </div>
  );
}
