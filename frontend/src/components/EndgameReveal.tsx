import { useEffect, useState } from "react";
import { Seat, SEAT_LABEL_ZH, SEAT_COLOR, formatMon } from "@sanguo/shared";
import { fetchGame, fetchPlayer, shortAddr, weiToMon, type IndexedGame } from "../lib/indexer";

type Props = {
  open: boolean;
  aiSeat: Seat;
  winnerSeat: Seat | null;
  motiveLog: string;
  trustScore?: number;
  slashed?: number;
  forcedBurn?: bigint;
  /** 结算前读到的奖池（MON wei） */
  prizePool?: bigint | null;
  /** 当前局号：用来从索引器取"这一局在历史里的位置" */
  gameId?: bigint | null;
  /** 点玩家地址时打开玩家主页 */
  onOpenPlayer?: (address: string) => void;
  onClose: () => void;
};

/**
 * 终局揭示 + 本局在历史里的位置。
 *
 * 历史部分的数据来自链下索引器：合约终局会把 points 清零进奖池，
 * 所以"本局吃子/得分"这类信息只能由索引器从事件累计得到。
 * 索引器不可用时这部分静默省略，不影响揭示主体。
 */
export function EndgameReveal({
  open,
  aiSeat,
  winnerSeat,
  motiveLog,
  trustScore,
  slashed,
  forcedBurn,
  prizePool,
  gameId,
  onOpenPlayer,
  onClose,
}: Props) {
  const [rows, setRows] = useState<IndexedGame | null>(null);
  const [winnerLine, setWinnerLine] = useState<string | null>(null);

  useEffect(() => {
    if (!open || gameId === undefined || gameId === null) {
      setRows(null);
      setWinnerLine(null);
      return;
    }
    let cancelled = false;
    (async () => {
      const g = await fetchGame(gameId);
      if (cancelled) return;
      setRows(g); // 取不到就保持 null，面板会静默省略这一段
    })();
    return () => {
      cancelled = true;
    };
  }, [open, gameId]);

  // 胜者目前的累计战绩
  useEffect(() => {
    if (!open || !rows) {
      setWinnerLine(null);
      return;
    }
    const w = rows.seats?.find((s) => s.seat === rows.winnerSeat && s.occupied);
    if (!w) {
      setWinnerLine(null);
      return;
    }
    let cancelled = false;
    (async () => {
      const p = await fetchPlayer(w.player);
      if (cancelled || !p) return;
      setWinnerLine(
        `胜者 ${shortAddr(w.player)} 目前 ${p.gamesWon} 胜 / ${p.gamesPlayed} 局（胜率 ${(p.winRate * 100).toFixed(0)}%）`
      );
    })();
    return () => {
      cancelled = true;
    };
  }, [open, rows]);

  if (!open) return null;

  const topScorer = (rows?.seats ?? [])
    .filter((s) => s.occupied)
    .map((s) => ({ seat: s.seat, points: s.pointsEarned ?? s.points }))
    .sort((a, b) => b.points - a.points)[0];

  return (
    <div className="modal-backdrop">
      <div className="modal reveal-screen">
        <h3>终局揭示 · AI 卧底</h3>
        <div className="ai-mark">AI</div>
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
        {prizePool !== undefined && prizePool !== null && (
          <p>
            奖池：
            <strong style={{ color: "var(--gold)" }}> {formatMon(prizePool)} MON</strong>
            <span style={{ color: "var(--muted)", fontSize: "0.8rem" }}>（胜 70% / 亚 20% / 协议 10%）</span>
          </p>
        )}
        {trustScore !== undefined && (
          <p style={{ color: "var(--muted)" }}>
            trustScore {trustScore}
            {slashed !== undefined ? ` · slashed ${slashed}` : ""}
            {forcedBurn !== undefined ? ` · forcedBurn ${formatMon(forcedBurn)} MON` : ""}
          </p>
        )}

        {rows && (
          <div
            style={{
              border: "1px solid var(--border)",
              borderRadius: 10,
              padding: "8px 10px",
              margin: "10px 0",
              fontSize: "0.8rem",
              textAlign: "left",
            }}
          >
            <strong style={{ color: "var(--gold)" }}>本局在历史里的位置</strong>
            <div style={{ color: "var(--muted)", marginTop: 4, lineHeight: 1.6 }}>
              已完成第 <strong style={{ color: "var(--text)" }}>{rows.gameId}</strong> 局 · 本局吃子{" "}
              {rows.captureCount} 次
              {topScorer && topScorer.points > 0
                ? ` · 本局最高分 ${SEAT_LABEL_ZH[topScorer.seat as Seat]} ${topScorer.points} 分`
                : ""}
            </div>
            {winnerLine && <div style={{ color: "var(--muted)", marginTop: 2 }}>{winnerLine}</div>}
            <div style={{ marginTop: 6, display: "flex", flexDirection: "column", gap: 2 }}>
              {(rows.seats ?? [])
                .filter((s) => s.occupied)
                .map((s) => (
                  <div
                    key={s.seat}
                    style={{ display: "flex", justifyContent: "space-between", gap: 8 }}
                  >
                    <span style={{ color: SEAT_COLOR[s.seat as Seat] }}>
                      {SEAT_LABEL_ZH[s.seat as Seat]}
                    </span>
                    <span>
                      {onOpenPlayer ? (
                        <button
                          className="ghost"
                          title={s.player}
                          style={{
                            padding: 0,
                            font: "inherit",
                            fontSize: "0.78rem",
                            color: "var(--muted)",
                            textDecoration: "underline dotted",
                          }}
                          onClick={() => onOpenPlayer(s.player)}
                        >
                          {shortAddr(s.player)}
                        </button>
                      ) : (
                        <span style={{ color: "var(--muted)" }}>{shortAddr(s.player)}</span>
                      )}
                    </span>
                    <span style={{ color: "var(--muted)" }}>
                      {s.pointsEarned ?? s.points} 分 · 烧油 {weiToMon(s.feesPaid)} MON
                      {s.eliminated ? " · 出局" : ""}
                      {s.slashed ? " · 被 slash" : ""}
                    </span>
                  </div>
                ))}
            </div>
          </div>
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
