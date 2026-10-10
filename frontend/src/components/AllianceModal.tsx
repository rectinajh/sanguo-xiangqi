import { Seat, SEAT_LABEL_ZH } from "@sanguo/shared";

type Props = {
  open: boolean;
  fromSeat: Seat;
  targets: Seat[];
  onClose: () => void;
  onPropose: (to: Seat, kind: "ally" | "peace") => void;
  busy?: boolean;
  isWhale?: boolean;
};

export function AllianceModal({
  open,
  fromSeat,
  targets,
  onClose,
  onPropose,
  busy,
  isWhale,
}: Props) {
  if (!open) return null;
  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h3>秘密求援 · 诚意金 / 疏火</h3>
        <p>
          以 {SEAT_LABEL_ZH[fromSeat]} 发起隐匿要约。链上只见
          <code> covenantHash </code>与金额，<strong>事件不写座位</strong>（G1 · ZK-ready）。
        </p>
        <div className="secret-note">
          <div>普通结盟：不吃对方士 + 占位条款 · 诚意金 0.10 MON</div>
          <div style={{ marginTop: 6 }}>
            <strong>疏火 BUY_PEACE：</strong>另付贿金给对方；接受后 N 手内不得吃其棋（违约可 Slash）。第三方仍看不见当事人。
          </div>
          <div style={{ marginTop: 6 }}>
            {isWhale
              ? "🐋 氪金席：可同时挂最多 3 条待接受诚意金（第 2+ 条各加 0.05 MON 溢价）"
              : "性价比席：同时仅 1 条待接受要约 — 补给油费到 ≥3 MON 解锁多开"}
          </div>
        </div>
        {targets.map((t) => (
          <div key={t} className="row" style={{ marginTop: 8 }}>
            <button className="primary" disabled={busy} onClick={() => onPropose(t, "ally")}>
              向{SEAT_LABEL_ZH[t]}结盟
            </button>
            <button className="secondary" disabled={busy} onClick={() => onPropose(t, "peace")}>
              疏火贿赂 {SEAT_LABEL_ZH[t]}
            </button>
          </div>
        ))}
        <div className="row">
          <button className="ghost" onClick={onClose} disabled={busy}>
            取消
          </button>
        </div>
        <p style={{ fontSize: "0.75rem", color: "var(--muted)", marginBottom: 0 }}>
          性价比反制：拒收贿金 / 收钱后背刺吃 Slash / 用廉价着法耗干鲸鱼油费。非法着法永远不可用。
        </p>
      </div>
    </div>
  );
}
