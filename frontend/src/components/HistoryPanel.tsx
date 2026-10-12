import { useCallback, useEffect, useState } from "react";
import { SEAT_LABEL_ZH, type Seat } from "@sanguo/shared";
import {
  PHASE_LABEL,
  fetchGames,
  fetchLeaderboard,
  indexerHealth,
  indexerUrl,
  shortAddr,
  weiToMon,
  type IndexedGame,
  type LeaderboardRow,
} from "../lib/indexer";

type Props = {
  /** 当前对局结束或新开局时用它触发刷新 */
  refreshKey?: number;
  /** 点某一局时回调（用于查看/跳转） */
  onPickGame?: (gameId: number) => void;
  /** 点地址打开玩家战绩 */
  onOpenPlayer?: (address: string) => void;
};

type Tab = "games" | "board";

const winnerText = (g: IndexedGame) =>
  g.winnerSeat < 3 ? `胜者 ${SEAT_LABEL_ZH[g.winnerSeat as Seat]}` : "未定胜者";

/**
 * 对局历史 + 排行榜。
 *
 * 数据来自链下索引器（server/src/indexer.ts），因为合约本身没有"列表"能力。
 * 索引器不可用时面板要优雅降级（给出启动命令），而不是报错或空白。
 */
export function HistoryPanel({ refreshKey = 0, onPickGame, onOpenPlayer }: Props) {
  const [tab, setTab] = useState<Tab>("games");
  const [games, setGames] = useState<IndexedGame[] | null>(null);
  const [board, setBoard] = useState<LeaderboardRow[] | null>(null);
  const [up, setUp] = useState<boolean | null>(null);
  const [loading, setLoading] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    const health = await indexerHealth();
    setUp(health !== null);
    if (health === null) {
      setLoading(false);
      return;
    }
    const [g, b] = await Promise.all([fetchGames({ limit: 12 }), fetchLeaderboard(10)]);
    setGames(g);
    setBoard(b);
    setLoading(false);
  }, []);

  useEffect(() => {
    void load();
  }, [load, refreshKey]);

  // 索引器在后台扫描，面板每 10 秒自己刷新一次
  useEffect(() => {
    const t = setInterval(() => void load(), 10_000);
    return () => clearInterval(t);
  }, [load]);

  return (
    <div className="panel">
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8 }}>
        <h2 style={{ margin: 0 }}>链下索引</h2>
        <span style={{ fontSize: "0.7rem", color: "var(--muted)" }}>
          {up === null ? "探测中…" : up ? "索引器在线" : "索引器离线"}
        </span>
      </div>

      {up === false && (
        <p style={{ fontSize: "0.75rem", color: "var(--muted)", marginTop: 6 }}>
          连不上索引器（{indexerUrl()}）。本地开发跑 <code>pnpm indexer</code>；
          公网请配置 <code>VITE_INDEXER_URL</code>。
        </p>
      )}

      {up && (
        <>
          <div style={{ display: "flex", gap: 6, margin: "8px 0" }}>
            <button
              className={tab === "games" ? "primary" : "ghost"}
              style={{ padding: "0.3rem 0.7rem", fontSize: "0.78rem" }}
              onClick={() => setTab("games")}
            >
              对局历史
            </button>
            <button
              className={tab === "board" ? "primary" : "ghost"}
              style={{ padding: "0.3rem 0.7rem", fontSize: "0.78rem" }}
              onClick={() => setTab("board")}
            >
              排行榜
            </button>
            <button
              className="ghost"
              style={{ padding: "0.3rem 0.7rem", fontSize: "0.78rem", marginLeft: "auto" }}
              disabled={loading}
              onClick={() => void load()}
            >
              {loading ? "…" : "刷新"}
            </button>
          </div>

          {tab === "games" && (
            <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
              {games === null && <p style={{ fontSize: "0.78rem", color: "var(--muted)" }}>读取中…</p>}
              {games?.length === 0 && (
                <p style={{ fontSize: "0.78rem", color: "var(--muted)" }}>
                  还没有已索引的对局。开一局并跑完，索引器扫描后就会出现在这里。
                </p>
              )}
              {games?.map((g) => (
                <button
                  key={g.gameId}
                  className="ghost"
                  onClick={() => onPickGame?.(g.gameId)}
                  style={{
                    textAlign: "left",
                    padding: "0.45rem 0.6rem",
                    fontSize: "0.76rem",
                    lineHeight: 1.5,
                    border: "1px solid var(--border)",
                    borderRadius: 10,
                  }}
                >
                  <div style={{ display: "flex", justifyContent: "space-between", gap: 8 }}>
                    <strong>#{g.gameId}</strong>
                    <span style={{ color: "var(--muted)" }}>{PHASE_LABEL[g.phase] ?? "?"}</span>
                  </div>
                  <div style={{ color: "var(--muted)" }}>
                    {winnerText(g)} · {g.ply} 手 · 吃子 {g.captureCount}
                    {g.aiRevealed ? " · AI 已揭示" : ""}
                  </div>
                  <div style={{ color: "var(--muted)" }}>
                    奖池 {weiToMon(g.prizePool)} MON
                  </div>
                  {g.seats && g.seats.some((s) => s.occupied) && (
                    <div style={{ color: "var(--muted)", marginTop: 2 }}>
                      {g.seats
                        .filter((s) => s.occupied)
                        .map(
                          (s) =>
                            `${SEAT_LABEL_ZH[s.seat as Seat]} ${shortAddr(s.player)}${s.eliminated ? "(出局)" : ""} ${s.pointsEarned ?? s.points}分`
                        )
                        .join(" · ")}
                    </div>
                  )}
                </button>
              ))}
            </div>
          )}

          {tab === "board" && (
            <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
              {board === null && <p style={{ fontSize: "0.78rem", color: "var(--muted)" }}>读取中…</p>}
              {board?.length === 0 && (
                <p style={{ fontSize: "0.78rem", color: "var(--muted)" }}>还没有完成的对局。</p>
              )}
              {board && board.length > 0 && (
                <div
                  style={{
                    display: "grid",
                    gridTemplateColumns: "auto 1fr auto auto",
                    gap: "2px 8px",
                    fontSize: "0.76rem",
                    alignItems: "center",
                  }}
                >
                  <span style={{ color: "var(--muted)" }}>#</span>
                  <span style={{ color: "var(--muted)" }}>玩家</span>
                  <span style={{ color: "var(--muted)" }}>胜/局</span>
                  <span style={{ color: "var(--muted)" }}>烧油</span>
                  {board.map((r, i) => (
                    <Row key={r.player} rank={i + 1} row={r} onOpenPlayer={onOpenPlayer} />
                  ))}
                </div>
              )}
              <p style={{ fontSize: "0.7rem", color: "var(--muted)", marginTop: 6 }}>
                按胜场排序；"烧油"是该地址累计支付的走子费。
              </p>
            </div>
          )}
        </>
      )}
    </div>
  );
}

function Row({
  rank,
  row,
  onOpenPlayer,
}: {
  rank: number;
  row: LeaderboardRow;
  onOpenPlayer?: (a: string) => void;
}) {
  return (
    <>
      <span style={{ color: rank === 1 ? "var(--gold)" : "var(--muted)" }}>{rank}</span>
      <span>
        <button
          className="ghost"
          title={row.player}
          disabled={!onOpenPlayer}
          onClick={() => onOpenPlayer?.(row.player)}
          style={{
            padding: 0,
            font: "inherit",
            color: "inherit",
            textDecoration: onOpenPlayer ? "underline dotted" : "none",
            cursor: onOpenPlayer ? "pointer" : "default",
          }}
        >
          {shortAddr(row.player)}
        </button>
        {row.timesSlashed > 0 ? " ⚔" : ""}
      </span>
      <span>
        {row.wins}/{row.games}
      </span>
      <span style={{ color: "var(--muted)" }}>{weiToMon(row.feesBurnedMon)}</span>
    </>
  );
}
