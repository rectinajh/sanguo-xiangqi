/**
 * /api/* —— 索引器的只读 HTTP 接口，跑在 Vercel serverless 上。
 *
 * 为什么索引器有两个运行位置：
 *   - 长驻进程（server/src/indexer.ts）：本地/服务器上持续扫描链、写库
 *   - 这个函数：**只读**，给浏览器用。不扫描、不写库。
 *
 * 为什么不在这里扫描：Vercel 函数实例随时销毁，没有稳定的定时执行；
 * 而且公网 RPC 限制 eth_getLogs 区间（Monad 公共 RPC 只允许 100 个块），
 * 全量扫描要几百次请求，放在请求路径里必然超时。
 * 所以"写"留在服务器，"读"在这里 —— 两者共用 server/src/store.ts 的存储抽象。
 */

import { openStore, type Store } from "../server/src/store.js";

const PHASE_LABEL = ["lobby", "playing", "finished", "abandoned"];
const PHASE = { Lobby: 0, Playing: 1, Finished: 2, Abandoned: 3 };

let cached: Store | null = null;

async function store(): Promise<Store> {
  if (cached) return cached;
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("缺少 DATABASE_URL：Vercel 上必须指向外部 Postgres");
  cached = await openStore({ databaseUrl: url });
  return cached;
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body, (_k, v) => (typeof v === "bigint" ? Number(v) : v)), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "access-control-allow-origin": "*",
      // 数据由服务器上的索引器持续写入，边缘缓存 10 秒足够挡住突发流量
      "cache-control": "public, s-maxage=10, stale-while-revalidate=30",
    },
  });

const num = (v: unknown) => Number(v ?? 0);
const str = (v: unknown) => String(v ?? "0");

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export default async function handler(req: any): Promise<Response> {
  try {
    const db = await store();
    const url = new URL(req.url ?? "/", "http://x");
    // Vercel 的 Node 函数会把原始 path 放在 x-forwarded-uri / x-vercel-original-path
    // 头里；req.url 在 catch-all 函数下可能只是 "/"。
    const raw =
      (req.headers?.["x-vercel-original-path"] as string | undefined) ??
      (req.headers?.["x-forwarded-uri"] as string | undefined) ??
      url.pathname;
    const p = raw.replace(/^\/api/, "") || "/";

    if (p === "/health") {
      const games = await db.get(`SELECT COUNT(*) AS n FROM games`);
      const finished = await db.get(`SELECT COUNT(*) AS n FROM games WHERE phase = ?`, [PHASE.Finished]);
      const players = await db.get(`SELECT COUNT(DISTINCT player) AS n FROM seats WHERE occupied = ?`, [true]);
      const lastScan = await db.get(`SELECT value FROM meta WHERE key = 'last_scan'`);
      return json({
        ok: true,
        games: num(games?.n),
        finished: num(finished?.n),
        players: num(players?.n),
        lastScan: lastScan ? Number(lastScan.value) : null,
      });
    }

    if (p === "/games") {
      const limit = Math.min(Number(url.searchParams.get("limit") ?? 20), 100);
      const offset = Math.max(Number(url.searchParams.get("offset") ?? 0), 0);
      const player = url.searchParams.get("player");
      const where: string[] = [];
      const args: unknown[] = [];
      if (player) {
        where.push("EXISTS (SELECT 1 FROM seats s WHERE s.game_id = g.game_id AND s.player = ?)");
        args.push(player.toLowerCase());
      }
      const clause = where.length ? `WHERE ${where.join(" AND ")}` : "";
      const rows = await db.all(
        `SELECT g.* FROM games g ${clause} ORDER BY g.game_id DESC LIMIT ? OFFSET ?`,
        [...args, limit, offset]
      );
      const games = await Promise.all(rows.map((r) => gameOut(db, r, true)));
      return json({ games, limit, offset });
    }

    const gm = p.match(/^\/games\/(\d+)$/);
    if (gm) {
      const row = await db.get(`SELECT * FROM games WHERE game_id = ?`, [Number(gm[1])]);
      if (!row) return json({ error: "not found" }, 404);
      return json(await gameOut(db, row, true));
    }

    const pm = p.match(/^\/players\/(0x[0-9a-fA-F]{40})$/);
    if (pm) {
      const who = pm[1].toLowerCase();
      const played = await db.get(`SELECT COUNT(*) AS n FROM seats WHERE player = ? AND occupied = ?`, [who, true]);
      const won = await db.get(
        `SELECT COUNT(*) AS n FROM games g JOIN seats s ON s.game_id = g.game_id AND s.seat = g.winner_seat
         WHERE s.player = ? AND g.phase = ?`,
        [who, PHASE.Finished]
      );
      const staked = await db.get(
        `SELECT COALESCE(SUM(CAST(seat_stake AS INTEGER)),0) AS v FROM seats WHERE player = ?`,
        [who]
      );
      const fees = await db.get(
        `SELECT COALESCE(SUM(CAST(fees_paid AS INTEGER)),0) AS v FROM seats WHERE player = ?`,
        [who]
      );
      const points = await db.get(
        `SELECT COALESCE(SUM(sp.points_earned),0) AS v FROM seat_points sp
         JOIN seats s ON s.game_id = sp.game_id AND s.seat = sp.seat WHERE s.player = ?`,
        [who]
      );
      const slashed = await db.get(
        `SELECT COUNT(*) AS n FROM seats WHERE player = ? AND slashed = ?`,
        [who, true]
      );
      const rep = await db.get(`SELECT * FROM reputation WHERE agent = ?`, [who]);
      const recent = await db.all(
        `SELECT g.* FROM games g JOIN seats s ON s.game_id = g.game_id
         WHERE s.player = ? ORDER BY g.game_id DESC LIMIT 10`,
        [who]
      );
      const games = num(played?.n);
      const wins = num(won?.n);
      return json({
        address: who,
        gamesPlayed: games,
        gamesWon: wins,
        winRate: games > 0 ? wins / games : 0,
        totalStakedMon: weiToMon(str(staked?.v)),
        totalFeesBurnedMon: weiToMon(str(fees?.v)),
        totalPoints: num(points?.v),
        timesSlashed: num(slashed?.n),
        reputation: rep
          ? {
              games: num(rep.games),
              wins: num(rep.wins),
              slashed: num(rep.slashed),
              betrayalIndex: num(rep.betrayal_index),
              trustScore: num(rep.trust_score),
              forcedBurnMonTotal: weiToMon(str(rep.forced_burn)),
              metadataURI: String(rep.metadata_uri ?? ""),
            }
          : null,
        recentGames: await Promise.all(recent.map((r) => gameOut(db, r, false))),
      });
    }

    if (p === "/leaderboard") {
      const limit = Math.min(Number(url.searchParams.get("limit") ?? 10), 100);
      const rows = await db.all(
        `SELECT s.player,
                COUNT(*) AS games,
                SUM(CASE WHEN g.winner_seat = s.seat AND g.phase = ? THEN 1 ELSE 0 END) AS wins,
                COALESCE(SUM(sp.points_earned), 0) AS points,
                SUM(CAST(s.fees_paid AS INTEGER)) AS fees,
                SUM(CASE WHEN s.slashed = ? THEN 1 ELSE 0 END) AS slashed
         FROM seats s
         JOIN games g ON g.game_id = s.game_id
         LEFT JOIN seat_points sp ON sp.game_id = s.game_id AND sp.seat = s.seat
         WHERE s.occupied = ?
         GROUP BY s.player
         ORDER BY wins DESC, points DESC
         LIMIT ?`,
        [PHASE.Finished, true, true, limit]
      );
      return json({
        leaderboard: rows.map((r) => ({
          player: r.player,
          games: num(r.games),
          wins: num(r.wins),
          winRate: num(r.games) > 0 ? num(r.wins) / num(r.games) : 0,
          points: num(r.points),
          feesBurnedMon: weiToMon(str(r.fees)),
          timesSlashed: num(r.slashed),
        })),
      });
    }

    if (p === "/agents") {
      const rows = await db.all(`SELECT * FROM reputation ORDER BY updated_at DESC LIMIT 50`);
      return json({
        agents: rows.map((r) => ({
          agent: r.agent,
          games: num(r.games),
          wins: num(r.wins),
          slashed: num(r.slashed),
          betrayalIndex: num(r.betrayal_index),
          trustScore: num(r.trust_score),
          forcedBurnMonTotal: weiToMon(str(r.forced_burn)),
        })),
      });
    }

    return json({ error: "not found", path: p }, 404);
  } catch (e) {
    return json({ error: (e as Error).message.split("\n")[0] }, 500);
  }
}

function weiToMon(wei: string, digits = 3): string {
  try {
    const v = BigInt(wei);
    const whole = v / 10n ** 18n;
    const frac = (v % 10n ** 18n).toString().padStart(18, "0").slice(0, digits);
    return `${whole}.${frac}`;
  } catch {
    return "0.000";
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function gameOut(db: Store, row: any, withSeats: boolean) {
  const g = {
    gameId: num(row.game_id),
    phase: num(row.phase),
    phaseLabel: PHASE_LABEL[num(row.phase)] ?? "?",
    turn: num(row.turn),
    ply: num(row.ply),
    aiRevealed: Boolean(row.ai_revealed),
    winnerSeat: num(row.winner_seat),
    secondSeat: num(row.second_seat),
    prizePool: str(row.prize_pool),
    captureCount: num(row.capture_count),
    protocolTreasury: str(row.protocol_treasury),
    motiveLogHash: row.motive_log_hash,
    indexedAt: num(row.indexed_at),
  };
  if (!withSeats) return g;
  const seats = await db.all(
    `SELECT s.*, COALESCE(sp.points_earned, 0) AS points_earned
     FROM seats s LEFT JOIN seat_points sp ON sp.game_id = s.game_id AND sp.seat = s.seat
     WHERE s.game_id = ? ORDER BY s.seat`,
    [g.gameId]
  );
  return {
    ...g,
    seats: seats.map((r) => ({
      seat: num(r.seat),
      player: r.player,
      occupied: Boolean(r.occupied),
      seatStake: str(r.seat_stake),
      playBalance: str(r.play_balance),
      points: num(r.points),
      pointsEarned: num(r.points_earned),
      eliminated: Boolean(r.eliminated),
      feesPaid: str(r.fees_paid),
      slashed: Boolean(r.slashed),
    })),
  };
}

export const config = { runtime: "nodejs" };
