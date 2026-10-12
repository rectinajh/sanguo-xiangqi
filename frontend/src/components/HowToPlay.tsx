import { useEffect, useState } from "react";
import { JOIN_VALUE, formatMon } from "@sanguo/shared";

type Props = {
  open: boolean;
  onClose: () => void;
  /** 首次进入且还没入座时给一个更明确的主行动 */
  ctaLabel?: string;
  onCta?: () => void;
};

const STEPS: Array<{ title: string; body: string }> = [
  {
    title: "三个人，同一个棋盘",
    body: "红、蓝、绿三方轮流走子。没有队友，只有暂时的利益一致。",
  },
  {
    title: "其中一个座位是 AI 卧底",
    body: "三座里必有一席由 AI 扮演，它的身份在终局才揭示。它会跟你结盟、也会在合适的时候背刺你。",
  },
  {
    title: "每一步都烧真钱",
    body: "走子按距离收费：短步便宜、长途车炮很贵。费用从你的「作战余额」里扣，余额见底就破产出局。",
  },
  {
    title: "可以结盟，但要押诚意金",
    body: "跟某一方签盟约要押诚意金上链。违约会被对方罚没——这是本作最核心的博弈。",
  },
  {
    title: "赢的方式",
    body: "吃掉对方的帅、让对手油费耗尽破产、或将死对方。80 手内无人出局则按积分判定。",
  },
];

/**
 * 新手指引。
 *
 * 为什么必须有：陌生人打开链接看到的是棋盘 + 一堆术语（双账本、诚意金、盟约、
 * 背刺 slash）。没有一屏说明，30 秒内不知道要干什么就会关掉 —— 对黑客松演示
 * 来说这是最致命的一处流失。首次访问自动弹出，之后可随时从顶栏重新打开。
 */
export function HowToPlay({ open, onClose, ctaLabel, onCta }: Props) {
  const [step, setStep] = useState(0);

  useEffect(() => {
    if (open) setStep(0);
  }, [open]);

  if (!open) return null;

  const last = step === STEPS.length - 1;

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" style={{ maxWidth: 560 }} onClick={(e) => e.stopPropagation()}>
        <h3 style={{ marginTop: 0 }}>怎么玩</h3>

        <div style={{ display: "flex", gap: 6, marginBottom: 12 }}>
          {STEPS.map((_, i) => (
            <span
              key={i}
              style={{
                height: 3,
                flex: 1,
                borderRadius: 2,
                background: i <= step ? "var(--gold)" : "var(--border)",
              }}
            />
          ))}
        </div>

        <h4 style={{ margin: "0 0 6px", fontSize: "1rem" }}>{STEPS[step].title}</h4>
        <p style={{ margin: 0, color: "var(--muted)", fontSize: "0.88rem", lineHeight: 1.7 }}>
          {STEPS[step].body}
        </p>

        <p
          style={{
            marginTop: 14,
            padding: "8px 10px",
            borderRadius: 8,
            background: "var(--panel2)",
            fontSize: "0.8rem",
            color: "var(--muted)",
          }}
        >
          入座需要 <strong style={{ color: "var(--text)" }}>{formatMon(JOIN_VALUE)} MON</strong>
          （质押 + 作战余额），在 Monad 测试网。没币就到{" "}
          <a href="https://faucet.monad.xyz" target="_blank" rel="noopener noreferrer">
            官方水龙头
          </a>{" "}
          领。
        </p>

        <div className="row" style={{ justifyContent: "space-between", marginTop: 16 }}>
          <button className="ghost" onClick={() => setStep((v) => Math.max(0, v - 1))} disabled={step === 0}>
            上一步
          </button>
          <div style={{ display: "flex", gap: 8 }}>
            {!last && (
              <button className="secondary" onClick={onClose}>
                跳过
              </button>
            )}
            {last
              ? ctaLabel && (
                  <button
                    className="primary"
                    onClick={() => {
                      onClose();
                      onCta?.();
                    }}
                  >
                    {ctaLabel}
                  </button>
                )
              : null}
            {last ? (
              !ctaLabel && (
                <button className="primary" onClick={onClose}>
                  开始
                </button>
              )
            ) : (
              <button className="primary" onClick={() => setStep((v) => v + 1)}>
                下一步
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

const SEEN_KEY = "sanguo.howto.seen";

/** 是否已经看过引导（首次访问自动弹一次，之后不再打扰）。 */
export function hasSeenHowTo(): boolean {
  try {
    return localStorage.getItem(SEEN_KEY) === "1";
  } catch {
    return true; // localStorage 不可用时不要反复弹窗
  }
}

export function markHowToSeen() {
  try {
    localStorage.setItem(SEEN_KEY, "1");
  } catch {
    /* 忽略 */
  }
}
