/**
 * indexer.ts —— 前端访问索引器服务。
 *
 * 为什么需要它：合约本身没有"列表"能力（AgentRegistry 的声誉只能按地址查，
 * 没有 agentCount，也没有"所有对局"）。所以对局历史、排行榜这些必须是链下索引。
 *
 * 链仍然是唯一真源，索引只是可重建的派生数据。
 * 前端面板不向玩家暴露索引器在线/离线等技术细节。
 */

/**
 * 索引器基址。
 *
 * 本地默认指向独立进程（8788）。线上部署到 Vercel 时，索引器就是同源的
 * `/api` 函数（见 frontend/api/index.ts），所以这里把结尾的 `/api` 归一化，
 * 避免出现 `/api/api/health` 这种双前缀。
 */
const RAW_INDEXER_URL = import.meta.env.VITE_INDEXER_URL ?? "http://127.0.0.1:8788";
const INDEXER_URL = RAW_INDEXER_URL.replace(/\/$/, "").replace(/\/api$/, "");

export type IndexedSeat = {
  seat: number;
  player: string;
  occupied: boolean;
  seatStake: string;
  playBalance: string;
  points: number;
  /** 累计赚分：合约终局会清零 points，历史统计用这个 */
  pointsEarned?: number;
  eliminated: boolean;
  feesPaid: string;
  slashed: boolean;
};

export type IndexedGame = {
  gameId: number;
  phase: number;
  turn: number;
  ply: number;
  aiRevealed: boolean;
  winnerSeat: number;
  secondSeat: number;
  prizePool: string;
  captureCount: number;
  protocolTreasury: string;
  motiveLogHash: string;
  indexedAt: number;
  seats?: IndexedSeat[];
};

export type LeaderboardRow = {
  player: string;
  games: number;
  wins: number;
  winRate: number;
  points: number;
  feesBurnedMon: string;
  timesSlashed: number;
};

export type PlayerProfile = {
  address: string;
  gamesPlayed: number;
  gamesWon: number;
  winRate: number;
  totalStakedMon: string;
  totalFeesBurnedMon: string;
  totalPoints: number;
  timesSlashed: number;
  reputation: {
    games: number;
    wins: number;
    slashed: number;
    betrayalIndex: number;
    trustScore: number;
    forcedBurnMonTotal: string;
    metadataURI: string;
  } | null;
  recentGames: IndexedGame[];
};

export type IndexerStats = {
  ok: boolean;
  games: number;
  finished: number;
  players: number;
  lastScan: number | null;
};

async function getJson<T>(path: string, timeoutMs = 6000): Promise<T> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const r = await fetch(`${INDEXER_URL}${path}`, { signal: ctrl.signal });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return (await r.json()) as T;
  } finally {
    clearTimeout(t);
  }
}

/** 探测索引器是否可用；不可用时前端应优雅降级而不是报错。 */
export async function indexerHealth(): Promise<IndexerStats | null> {
  try {
    return await getJson<IndexerStats>("/health", 4000);
  } catch {
    return null;
  }
}

export async function fetchGames(opts?: {
  limit?: number;
  offset?: number;
  player?: string;
  phase?: number;
}): Promise<IndexedGame[] | null> {
  const q = new URLSearchParams();
  if (opts?.limit !== undefined) q.set("limit", String(opts.limit));
  if (opts?.offset !== undefined) q.set("offset", String(opts.offset));
  if (opts?.player) q.set("player", opts.player.toLowerCase());
  if (opts?.phase !== undefined) q.set("phase", String(opts.phase));
  try {
    const d = await getJson<{ games: IndexedGame[] }>(`/games?${q.toString()}`);
    return d.games;
  } catch {
    return null;
  }
}

export async function fetchGame(gameId: number | bigint): Promise<IndexedGame | null> {
  try {
    return await getJson<IndexedGame>(`/games/${gameId.toString()}`);
  } catch {
    return null;
  }
}

export async function fetchLeaderboard(limit = 10): Promise<LeaderboardRow[] | null> {
  try {
    const d = await getJson<{ leaderboard: LeaderboardRow[] }>(`/leaderboard?limit=${limit}`);
    return d.leaderboard;
  } catch {
    return null;
  }
}

export async function fetchPlayer(address: string): Promise<PlayerProfile | null> {
  try {
    return await getJson<PlayerProfile>(`/players/${address}`);
  } catch {
    return null;
  }
}

export function indexerUrl() {
  return INDEXER_URL;
}

/** wei 字符串 → 可读 MON（不引入 viem，保持面板轻量）。 */
export function weiToMon(wei: string, digits = 3): string {
  try {
    const v = BigInt(wei);
    const whole = v / 10n ** 18n;
    const frac = (v % 10n ** 18n).toString().padStart(18, "0").slice(0, digits);
    return `${whole}.${frac}`;
  } catch {
    return "0.000";
  }
}

/** 缩短地址显示。 */
export function shortAddr(a: string): string {
  return a && a.length > 12 ? `${a.slice(0, 6)}…${a.slice(-4)}` : a;
}

export const PHASE_LABEL = ["大厅", "行棋中", "已终局", "已放弃"] as const;
