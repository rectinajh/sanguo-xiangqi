import { SEAT_COLOR, SEAT_LABEL_ZH, type Seat } from "@sanguo/shared";
import type { ThreatState } from "@sanguo/shared";

type Props = {
  turn: Seat;
  phase: number;
  /** 我控制的座位；null = 观战 */
  mySeat: Seat | null;
  /** 每个座位的威胁状态（将军/将死/困毙） */
  threats: Record<Seat, ThreatState>;
  eliminated: Record<Seat, boolean>;
  /** 已入座的座位数，用于判断"人还没齐" */
  seatedCount: number;
};

/**
 * 局势条：现在轮到谁、有没有人被将军、我该做什么。
 *
 * 为什么需要它：之前侧栏的座位卡只有颜色高亮，**没有一句文字**说明当前状态。
 * 三方棋局最容易懵的就是"现在谁走、是不是在等我"。这是最便宜的一处体验修复。
 */
export function StatusBar({ turn, phase, mySeat, threats, eliminated, seatedCount }: Props) {
  const checked = ([0, 1, 2] as Seat[]).filter((s) => threats[s] === "check");
  const mated = ([0, 1, 2] as Seat[]).filter(
    (s) => threats[s] === "checkmate" || threats[s] === "stalemate"
  );

  const waiting = phase === 0 && seatedCount < 3;
  const myTurn = phase === 1 && mySeat !== null && turn === mySeat;

  // 主文案：一句话说清"现在该谁"
  let headline: string;
  let tone: "idle" | "mine" | "theirs" | "alarm" = "idle";

  if (mated.length > 0) {
    headline = `${SEAT_LABEL_ZH[mated[0]]} 已无路可走（${threats[mated[0]] === "checkmate" ? "将死" : "困毙"}）`;
    tone = "alarm";
  } else if (waiting) {
    headline = `等待入座：还差 ${3 - seatedCount} 位`;
  } else if (phase === 1) {
    if (myTurn) {
      headline = "轮到你走";
      tone = "mine";
    } else {
      headline = `轮到 ${SEAT_LABEL_ZH[turn]}`;
      tone = "theirs";
    }
  } else if (phase === 2) {
    headline = "本局已结束";
  } else if (phase === 3) {
    headline = "本局已放弃";
  } else {
    headline = "大厅";
  }

  return (
    <div
      className="status-bar"
      style={{
        display: "flex",
        alignItems: "center",
        gap: 10,
        flexWrap: "wrap",
        padding: "8px 10px",
        marginBottom: 10,
        borderRadius: 10,
        border: `1px solid ${tone === "mine" ? "var(--ok)" : tone === "alarm" ? "var(--danger, #c33)" : "var(--border)"}`,
        background:
          tone === "mine"
            ? "color-mix(in srgb, var(--ok) 12%, transparent)"
            : tone === "alarm"
              ? "color-mix(in srgb, #c33 14%, transparent)"
              : "var(--panel2)",
      }}
    >
      <span
        style={{
          width: 10,
          height: 10,
          borderRadius: 5,
          flex: "0 0 auto",
          background: phase === 1 ? SEAT_COLOR[turn] : "var(--muted)",
        }}
      />
      <strong style={{ fontSize: "0.9rem" }}>{headline}</strong>

      {phase === 1 && myTurn && (
        <span style={{ fontSize: "0.78rem", color: "var(--muted)" }}>
          点自己的子 → 点高亮目标格（会显示这一步要烧多少 MON）
        </span>
      )}

      {checked.length > 0 && (
        <span
          style={{
            fontSize: "0.8rem",
            fontWeight: 700,
            color: "var(--danger, #e55)",
            marginLeft: "auto",
          }}
        >
          ⚠ {checked.map((s) => SEAT_LABEL_ZH[s]).join("、")} 被将军！
        </span>
      )}

      {mySeat === null && phase === 1 && (
        <span style={{ fontSize: "0.75rem", color: "var(--muted)", marginLeft: "auto" }}>
          观战中（未入座，只能看）
        </span>
      )}
    </div>
  );
}
