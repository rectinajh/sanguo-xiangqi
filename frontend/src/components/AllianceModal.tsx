import { Seat, SEAT_LABEL_ZH } from "@sanguo/shared";

type Props = {
  open: boolean;
  fromSeat: Seat;
  targets: Seat[];
  onClose: () => void;
  onPropose: (to: Seat, kind: "ally" | "peace") => void;
  /** 粘贴对方发来的要约 JSON 后接受 */
  onAcceptOffer?: (raw: string) => void;
  /** 退回自己发出的过期/未完成诚意金 */
  onRefundEarnest?: () => void;
  /** 当前待确认要约的分享文本（发起方复制给对方） */
  pendingOfferText?: string | null;
  busy?: boolean;
  isWhale?: boolean;
  /** 真多人：不能在本机替对方签名 */
  multiWallet?: boolean;
};

export function AllianceModal({
  open,
  fromSeat,
  targets,
  onClose,
  onPropose,
  onAcceptOffer,
  onRefundEarnest,
  pendingOfferText,
  busy,
  isWhale,
  multiWallet,
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
          {multiWallet && (
            <div style={{ marginTop: 6 }}>
              真多人：你锁诚意金并签名后，把要约文本发给对方；对方在本面板粘贴并确认，各自钱包各签一次。
            </div>
          )}
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

        {pendingOfferText && (
          <div style={{ marginTop: 12 }}>
            <p style={{ fontSize: "0.78rem", color: "var(--muted)", marginBottom: 6 }}>
              待对方确认的要约（复制发给对方）：
            </p>
            <textarea
              readOnly
              value={pendingOfferText}
              rows={4}
              style={{ width: "100%", fontSize: "0.7rem", fontFamily: "monospace" }}
            />
            <button
              className="secondary"
              style={{ marginTop: 6 }}
              disabled={busy}
              onClick={() => void navigator.clipboard.writeText(pendingOfferText)}
            >
              复制要约
            </button>
          </div>
        )}

        {multiWallet && onAcceptOffer && (
          <div style={{ marginTop: 12 }}>
            <p style={{ fontSize: "0.78rem", color: "var(--muted)" }}>收到对方要约？粘贴后确认：</p>
            <textarea
              id="alliance-offer-input"
              rows={3}
              placeholder='{"hash":"0x…","preimage":{…},"sigI":"0x…"}'
              style={{ width: "100%", fontSize: "0.7rem", fontFamily: "monospace" }}
            />
            <button
              className="primary"
              style={{ marginTop: 6 }}
              disabled={busy}
              onClick={() => {
                const el = document.getElementById("alliance-offer-input") as HTMLTextAreaElement | null;
                if (el?.value) onAcceptOffer(el.value);
              }}
            >
              确认并激活盟约
            </button>
          </div>
        )}

        <div className="row" style={{ marginTop: 10 }}>
          {onRefundEarnest && (
            <button className="ghost" onClick={onRefundEarnest} disabled={busy}>
              退回诚意金
            </button>
          )}
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
