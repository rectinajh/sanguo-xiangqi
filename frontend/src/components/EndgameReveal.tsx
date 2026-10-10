import { Seat, SEAT_LABEL_ZH, SEAT_COLOR } from "@sanguo/shared";

type Props = {
  open: boolean;
  aiSeat: Seat;
  winnerSeat: Seat | null;
  motiveLog: string;
  trustScore?: number;
  onClose: () => void;
};

export function EndgameReveal({ open, aiSeat, winnerSeat, motiveLog, trustScore, onClose }: Props) {
  if (!open) return null;
  return (
    <div className="modal-backdrop">
      <div className="modal reveal-screen">
        <h3>终局揭示 · AI 卧底</h3>
        <div className="ai-mark">🤖</div>
        <p>
          卧底座位：
          <strong style={{ color: SEAT_COLOR[aiSeat] }}> {SEAT_LABEL_ZH[aiSeat]}</strong>
        </p>
        {winnerSeat !== null && (
          <p>
            胜者：
            <strong style={{ color: SEAT_COLOR[winnerSeat] }}> {SEAT_LABEL_ZH[winnerSeat]}</strong>
          </p>
        )}
        {trustScore !== undefined && (
          <p style={{ color: "var(--muted)" }}>Agent trustScore：{trustScore}</p>
        )}
        <div className="motive">{motiveLog}</div>
        <div className="row" style={{ justifyContent: "center" }}>
          <button className="primary" onClick={onClose}>
            收起
          </button>
        </div>
      </div>
    </div>
  );
}
