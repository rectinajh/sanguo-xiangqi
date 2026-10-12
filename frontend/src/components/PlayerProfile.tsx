import { useCallback, useEffect, useState } from "react";
import { SEAT_LABEL_ZH, SEAT_COLOR, type Seat } from "@sanguo/shared";
import {
  PHASE_LABEL,
  fetchPlayer,
  shortAddr,
  weiToMon,
  type PlayerProfile as ProfileData,
} from "../lib/indexer";

type Props = {
  /** 要查看的地址；null 表示关闭 */
  address: string | null;
  onClose: () => void;
};

/**
 * 玩家主页：某个地址的全部战绩。
 *
 * 数据来自链下索引器（合约只能按地址单查声誉，没有列表能力）。
 * 关键区分：合约终局会把 points 清零进奖池，所以"积分"一栏用索引器累计的
 * 累计赚分，而不是 getSeat 的当前值 —— 否则每个人都会显示 0 分。
 */
export function PlayerProfile({ address, onClose }: Props) {
  const [data, setData] = useState<ProfileData | null>(null);
  const [loading, setLoading] = useState(false);
  const [missing, setMissing] = useState(false);

  const load = useCallback(async (addr: string) => {
    setLoading(true);
    setMissing(false);
    const d = await fetchPlayer(addr);
    if (d === null) setMissing(true);
    setData(d);
    setLoading(false);
  }, []);

  useEffect(() => {
    if (!address) {
      setData(null);
      return;
    }
    void load(address);
  }, [address, load]);

  if (!address) return null;

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" style={{ maxWidth: 620 }} onClick={(e) => e.stopPropagation()}>
        <h3 style={{ marginTop: 0 }}>玩家战绩</h3>

        <div
          style={{
            fontFamily: "var(--mono)",
            fontSize: "0.78rem",
            color: "var(--muted)",
            wordBreak: "break-all",
            marginBottom: 10,
          }}
        >
          {address}
        </div>

        {loading && <p style={{ color: "var(--muted)" }}>读取中…</p>}

        {!loading && missing && (
          <p style={{ fontSize: "0.85rem", color: "var(--muted)" }}>
            索引器不可用，或这个地址还没有被索引到。
            <br />
            本地开发请确认 <code>pnpm indexer</code> 正在运行。
          </p>
        )}

        {!loading && data && (
          <>
            <div
              style={{
                display: "grid",
                gridTemplateColumns: "repeat(auto-fit, minmax(110px, 1fr))",
                gap: 8,
                marginBottom: 12,
              }}
            >
              <Stat label="对局" value={String(data.gamesPlayed)} />
              <Stat label="胜场" value={String(data.gamesWon)} />
              <Stat label="胜率" value={`${(data.winRate * 100).toFixed(0)}%`} />
              <Stat label="累计赚分" value={String(data.totalPoints)} />
              <Stat label="累计烧油" value={`${weiToMon(data.totalFeesBurnedMon)} MON`} />
              <Stat label="被罚没" value={String(data.timesSlashed)} />
            </div>

            {data.reputation && (
              <div
                style={{
                  border: "1px solid var(--border)",
                  borderRadius: 10,
                  padding: "8px 10px",
                  marginBottom: 12,
                  fontSize: "0.8rem",
                }}
              >
                <strong style={{ color: "var(--gold)" }}>AgentRegistry 声誉</strong>
                <div style={{ color: "var(--muted)", marginTop: 4 }}>
                  trustScore {data.reputation.trustScore} · 胜 {data.reputation.wins}/{data.reputation.games} ·
                  被 slash {data.reputation.slashed} 次 · betrayalIndex {data.reputation.betrayalIndex}
                  <br />
                  逼人类烧油 {weiToMon(data.reputation.forcedBurnMonTotal)} MON
                  {data.reputation.metadataURI ? ` · ${data.reputation.metadataURI}` : ""}
                </div>
              </div>
            )}

            <h4 style={{ margin: "12px 0 6px", fontSize: "0.85rem" }}>最近对局</h4>
            {data.recentGames.length === 0 && (
              <p style={{ fontSize: "0.8rem", color: "var(--muted)" }}>还没有可显示的对局。</p>
            )}
            <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
              {data.recentGames.map((g) => {
                const won = g.winnerSeat < 3 && g.phase === 2;
                return (
                  <div
                    key={g.gameId}
                    style={{
                      display: "flex",
                      justifyContent: "space-between",
                      gap: 8,
                      fontSize: "0.78rem",
                      padding: "3px 0",
                      borderBottom: "1px solid var(--border)",
                    }}
                  >
                    <span>#{g.gameId}</span>
                    <span style={{ color: "var(--muted)" }}>{PHASE_LABEL[g.phase] ?? "?"}</span>
                    <span style={{ color: "var(--muted)" }}>{g.ply} 手</span>
                    <span>{won ? `胜者 ${SEAT_LABEL_ZH[g.winnerSeat as Seat]}` : "未终局"}</span>
                  </div>
                );
              })}
            </div>
          </>
        )}

        <div className="row" style={{ justifyContent: "center", marginTop: 14 }}>
          <button className="primary" onClick={onClose}>
            收起
          </button>
        </div>
      </div>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div
      style={{
        border: "1px solid var(--border)",
        borderRadius: 10,
        padding: "6px 8px",
        textAlign: "center",
      }}
    >
      <div style={{ fontSize: "0.7rem", color: "var(--muted)" }}>{label}</div>
      <div style={{ fontSize: "0.95rem", fontWeight: 600 }}>{value}</div>
    </div>
  );
}

/** 可点击的地址（打开玩家主页）。 */
export function AddressLink({
  address,
  onOpen,
  color,
}: {
  address?: string;
  onOpen: (a: string) => void;
  color?: string;
}) {
  if (!address || address === "0x0000000000000000000000000000000000000000") {
    return <span style={{ color: "var(--muted)" }}>未入座</span>;
  }
  return (
    <button
      className="ghost"
      title={address}
      onClick={() => onOpen(address)}
      style={{
        padding: 0,
        font: "inherit",
        fontSize: "0.75rem",
        color: color ?? "var(--muted)",
        textDecoration: "underline dotted",
        cursor: "pointer",
      }}
    >
      {shortAddr(address)}
    </button>
  );
}

export { SEAT_COLOR };
