/**
 * indexer.ts —— 对局索引器。
 *
 * 为什么需要它：合约本身没提供"列表"能力 ——
 *   `AgentRegistry` 的声誉只能按地址单独查，没有 `agentCount`，更没有"所有对局"。
 *   于是前端无法回答"最近有哪些对局""谁是胜率最高的人""这个地址打过几局"。
 *   这些问题必须靠链下索引。
 *
 * 设计取舍（为什么用 SQLite 而不是内存 + JSON）：
 *   node:sqlite 是 Node 22+ 内置的，**零额外依赖**，且有事务与文件持久化。
 *   重启不用全量重建，查询也不用自己写倒排。
 *   但**链仍然是唯一真源**：索引只是可重建的派生数据，随时能删库重跑。
 *
 * 用法：
 *   RPC_URL=... pnpm indexer          持续运行并对外提供 HTTP 接口
 *   RPC_URL=... pnpm indexer --once   只扫一轮然后退出（适合 CI/定时任务）
 */
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { DatabaseSync } from "node:sqlite";
import { createPublicClient, defineChain, http, formatEther, type Abi, type Hex, type PublicClient } from "viem";
import { readFileSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { readGame, readReputation, PHASE, type GameSnapshot } from "./reader.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "../..");

function loadAbi(name: string): Abi {
  return JSON.parse(readFileSync(path.join(repoRoot, "frontend/src/abi", `${name}.json`), "utf8")) as Abi;
}

type Config = {
  rpcUrl: string;
  chainId: number;
  gameTable: Hex;
  registry: Hex;
  port: number;
  dbPath: string;
  intervalMs: number;
  /** 一次扫描最多回溯多少个 gameId（防止对局数很大时拖慢） */
  maxScan: number;
  once: boolean;
};

function loadConfig(): Config {
  const env = process.env;
  const file = JSON.parse(
    readFileSync(path.join(repoRoot, "frontend/src/lib/addresses.json"), "utf8")
  ) as Record<string, string>;
  const pick = (envKey: string, fileKey: string) => {
    const v = env[envKey];
    return (v && v.length > 0 ? v : file[fileKey] ?? "") as string;
  };
  const gameTable = pick("VITE_GAMETABLE", "GameTable");
  const registry = pick("VITE_AGENTREGISTRY", "AgentRegistry");
  for (const [k, v] of [
    ["GameTable", gameTable],
    ["AgentRegistry", registry],
  ] as const) {
    if (!/^0x[0-9a-fA-F]{40}$/.test(v)) {
      throw new Error(`${k} 地址无效：${v || "(空)"}。先跑 pnpm deploy:local 或配置 VITE_* 环境变量。`);
    }
  }
  return {
    rpcUrl: env.RPC_URL ?? env.MONAD_RPC ?? file.rpcUrl ?? "http://127.0.0.1:8545",
    chainId: Number(env.CHAIN_ID ?? file.chainId ?? 31337),
    gameTable: gameTable as Hex,
    registry: registry as Hex,
    port: Number(env.INDEXER_PORT ?? 8788),
    dbPath: env.INDEXER_DB ?? path.join(repoRoot, "server/.data/index.sqlite"),
    intervalMs: Number(env.INDEXER_INTERVAL_MS ?? 4000),
    maxScan: Number(env.INDEXER_MAX_SCAN ?? 2000),
    once: process.argv.includes("--once"),
  };
}

function openDb(dbPath: string): DatabaseSync {
  mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new DatabaseSync(dbPath);
  db.exec(`
    PRAGMA journal_mode = WAL;

    CREATE TABLE IF NOT EXISTS games (
      game_id INTEGER PRIMARY KEY,
      phase INTEGER NOT NULL,
      turn INTEGER NOT NULL,
      ply INTEGER NOT NULL,
      ai_revealed INTEGER NOT NULL,
      winner_seat INTEGER NOT NULL,
      second_seat INTEGER NOT NULL,
      prize_pool TEXT NOT NULL,
      capture_count INTEGER NOT NULL,
      protocol_treasury TEXT NOT NULL,
      motive_log_hash TEXT NOT NULL,
      indexed_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS seats (
      game_id INTEGER NOT NULL,
      seat INTEGER NOT NULL,
      player TEXT NOT NULL,
      occupied INTEGER NOT NULL,
      seat_stake TEXT NOT NULL,
      play_balance TEXT NOT NULL,
      points INTEGER NOT NULL,
      eliminated INTEGER NOT NULL,
      fees_paid TEXT NOT NULL,
      slashed INTEGER NOT NULL,
      PRIMARY KEY (game_id, seat)
    );

    CREATE INDEX IF NOT EXISTS idx_seats_player ON seats(player);

    -- 对局结束时合约会把 points 清零（进奖池/孤儿池），所以 seats.points
    -- 只能反映"当前值"，不能用来做历史统计。points_earned 由吃子事件累计，
    -- 一旦写入就不会被终局清零，排行榜用它而不是 points。
    CREATE TABLE IF NOT EXISTS seat_points (
      game_id INTEGER NOT NULL,
      seat INTEGER NOT NULL,
      points_earned INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (game_id, seat)
    );

    CREATE TABLE IF NOT EXISTS reputation (
      agent TEXT PRIMARY KEY,
      games INTEGER NOT NULL,
      wins INTEGER NOT NULL,
      slashed INTEGER NOT NULL,
      betrayal_index INTEGER NOT NULL,
      trust_score INTEGER NOT NULL,
      forced_burn TEXT NOT NULL,
      registered INTEGER NOT NULL,
      metadata_uri TEXT NOT NULL,
      updated_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS meta (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
  `);
  return db;
}

/**
 * 从吃子/夺分事件累计每个座位"曾经赚到"的分数。
 *
 * 为什么不能直接用 seats.points：合约在终局结算里会把 points 用掉
 * （进奖池、孤儿池），结算后链上读到的是 0。实测：一局里吃到 2 子的一方，
 * 终局后 getSeat 返回 points=0。所以历史统计必须自己累计事件。
 *
 * 幂等：每个 (gameId, seat) 只按"事件最大值"更新，重复扫描同一局不会翻倍。
 */
async function scanPoints(
  pub: PublicClient,
  cfg: Config,
  db: DatabaseSync,
  gameAbi: Abi,
  fromBlock: bigint,
  toBlock: bigint
) {
  if (fromBlock > toBlock) return;
  const [settled, seized] = await Promise.all([
    pub.getContractEvents({
      address: cfg.gameTable,
      abi: gameAbi,
      eventName: "CaptureSettled",
      fromBlock,
      toBlock,
    }),
    pub.getContractEvents({
      address: cfg.gameTable,
      abi: gameAbi,
      eventName: "PointsSeized",
      fromBlock,
      toBlock,
    }),
  ]);

  const gained = new Map<string, number>();
  const bump = (gameId: number, seat: number, pts: number) => {
    const k = `${gameId}:${seat}`;
    gained.set(k, (gained.get(k) ?? 0) + pts);
  };
  for (const e of settled) {
    const a = e.args as { gameId?: bigint; attacker?: number; pointsDelta?: number };
    if (a.gameId === undefined || a.attacker === undefined) continue;
    bump(Number(a.gameId), Number(a.attacker), Number(a.pointsDelta ?? 0));
  }
  for (const e of seized) {
    const a = e.args as { gameId?: bigint; killer?: number; points?: number };
    if (a.gameId === undefined || a.killer === undefined) continue;
    bump(Number(a.gameId), Number(a.killer), Number(a.points ?? 0));
  }

  const up = db.prepare(
    `INSERT INTO seat_points (game_id, seat, points_earned) VALUES (?,?,?)
     ON CONFLICT(game_id, seat) DO UPDATE SET
       points_earned = MAX(points_earned, excluded.points_earned)`
  );
  for (const [k, v] of gained) {
    const [g, seat] = k.split(":");
    up.run(Number(g), Number(seat), v);
  }
}

/** 把一个对局快照写库（幂等，重复扫到同一局会覆盖更新）。 */
function upsertGame(db: DatabaseSync, g: GameSnapshot) {
  db.prepare(
    `INSERT INTO games (game_id, phase, turn, ply, ai_revealed, winner_seat, second_seat,
                        prize_pool, capture_count, protocol_treasury, motive_log_hash, indexed_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?)
     ON CONFLICT(game_id) DO UPDATE SET
       phase=excluded.phase, turn=excluded.turn, ply=excluded.ply,
       ai_revealed=excluded.ai_revealed, winner_seat=excluded.winner_seat,
       second_seat=excluded.second_seat, prize_pool=excluded.prize_pool,
       capture_count=excluded.capture_count, protocol_treasury=excluded.protocol_treasury,
       motive_log_hash=excluded.motive_log_hash, indexed_at=excluded.indexed_at`
  ).run(
    g.gameId,
    g.phase,
    g.turn,
    g.ply,
    g.aiRevealed ? 1 : 0,
    g.winnerSeat,
    g.secondSeat,
    g.prizePool.toString(),
    g.captureCount,
    g.protocolTreasury.toString(),
    g.motiveLogHash,
    Date.now()
  );

  const seatStmt = db.prepare(
    `INSERT INTO seats (game_id, seat, player, occupied, seat_stake, play_balance, points,
                        eliminated, fees_paid, slashed)
     VALUES (?,?,?,?,?,?,?,?,?,?)
     ON CONFLICT(game_id, seat) DO UPDATE SET
       player=excluded.player, occupied=excluded.occupied, seat_stake=excluded.seat_stake,
       play_balance=excluded.play_balance, points=excluded.points,
       eliminated=excluded.eliminated, fees_paid=excluded.fees_paid, slashed=excluded.slashed`
  );
  for (const s of g.seats) {
    seatStmt.run(
      g.gameId,
      s.seat,
      s.player.toLowerCase(),
      s.occupied ? 1 : 0,
      s.seatStake.toString(),
      s.playBalance.toString(),
      s.points,
      s.eliminated ? 1 : 0,
      s.feesPaid.toString(),
      s.slashed ? 1 : 0
    );
  }
}

async function scanOnce(
  pub: PublicClient,
  cfg: Config,
  db: DatabaseSync
): Promise<{ scanned: number; updated: number; nextGameId: number }> {
  const gameAbi = loadAbi("GameTable");
  const regAbi = loadAbi("AgentRegistry");

  const nextGameId = Number(
    (await pub.readContract({
      address: cfg.gameTable,
      abi: gameAbi,
      functionName: "nextGameId",
    })) as bigint
  );

  const from = Math.max(1, nextGameId - cfg.maxScan);
  let updated = 0;
  const touchedPlayers = new Set<string>();

  for (let id = from; id < nextGameId; id++) {
    const snap = await readGame(pub, cfg.gameTable, gameAbi, id);
    if (!snap) continue;
    // 跳过完全空的 id（理论上不该出现，但链上可以被人为制造）
    if (snap.seats.every((s) => !s.occupied)) continue;
    upsertGame(db, snap);
    updated++;
    for (const s of snap.seats) if (s.occupied) touchedPlayers.add(s.player.toLowerCase());
  }

  // 刷新被索引对局里出现过的地址的声誉（AI 座位也在其中）
  for (const who of touchedPlayers) {
    try {
      const rep = await readReputation(pub, cfg.registry, regAbi, who as Hex);
      if (!rep.registered) continue;
      db.prepare(
        `INSERT INTO reputation (agent, games, wins, slashed, betrayal_index, trust_score,
                                 forced_burn, registered, metadata_uri, updated_at)
         VALUES (?,?,?,?,?,?,?,?,?,?)
         ON CONFLICT(agent) DO UPDATE SET
           games=excluded.games, wins=excluded.wins, slashed=excluded.slashed,
           betrayal_index=excluded.betrayal_index, trust_score=excluded.trust_score,
           forced_burn=excluded.forced_burn, registered=excluded.registered,
           metadata_uri=excluded.metadata_uri, updated_at=excluded.updated_at`
      ).run(
        who,
        rep.games,
        rep.wins,
        rep.slashed,
        rep.betrayalIndex,
        rep.trustScore,
        rep.forcedBurnMonTotal.toString(),
        rep.registered ? 1 : 0,
        rep.metadataURI,
        Date.now()
      );
    } catch {
      /* 单条声誉失败不影响整轮 */
    }
  }

  // 事件累计：用 meta 记录已扫块高，只扫增量
  const fromRow = db.prepare(`SELECT value FROM meta WHERE key='points_scanned_block'`).get() as
    | { value: string }
    | undefined;
  const latest = await pub.getBlockNumber();
  const fromBlock = fromRow ? BigInt(fromRow.value) + 1n : 0n;
  if (fromBlock <= latest) {
    await scanPoints(pub, cfg, db, gameAbi, fromBlock, latest);
    db.prepare(
      `INSERT INTO meta (key, value) VALUES ('points_scanned_block', ?)
       ON CONFLICT(key) DO UPDATE SET value=excluded.value`
    ).run(String(latest));
  }

  db.prepare(
    `INSERT INTO meta (key, value) VALUES ('last_scan', ?)
     ON CONFLICT(key) DO UPDATE SET value=excluded.value`
  ).run(String(Date.now()));

  return { scanned: nextGameId - from, updated, nextGameId };
}

// ── HTTP 接口 ────────────────────────────────────────────────

function send(res: ServerResponse, status: number, body: unknown, origin = "*") {
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "access-control-allow-origin": origin,
    "access-control-allow-headers": "content-type",
    "access-control-allow-methods": "GET,OPTIONS",
    "cache-control": "no-store",
  });
  res.end(JSON.stringify(body));
}

/**
 * node:sqlite 默认把整数读成 JS number，一旦超过安全整数范围就**直接抛错**
 * （Value is too large to be represented as a JavaScript number）。
 * 我们的金额是 wei（18 位小数），必然超范围 —— 实测 leaderboard 的
 * SUM(fees_paid) 就是这么炸的。
 *
 * 解法是让 driver 用 BigInt 读取：statement.setReadBigInts(true)。
 * 下面这个 helper 统一包一层，避免每处查询都忘记设置。
 */
function withBigInts<T extends { setReadBigInts?: (v: boolean) => void }>(stmt: T): T {
  stmt.setReadBigInts?.(true);
  return stmt;
}

/** 兜底转换：值可能来自 BigInt 模式，也可能来自普通模式。 */
function toBig(v: unknown): bigint {
  if (typeof v === "bigint") return v;
  if (typeof v === "number") return BigInt(Math.trunc(v));
  if (typeof v === "string") return BigInt(v);
  return 0n;
}

/** 读一行并把指定字段转成 bigint 友好形态（避免后面再踩 number 溢出）。 */
function bigField(v: unknown): bigint {
  return toBig(v);
}

const seatOut = (r: Record<string, unknown>) => ({
  seat: Number(r.seat),
  player: r.player,
  occupied: Boolean(r.occupied),
  seatStake: String(r.seat_stake),
  playBalance: String(r.play_balance),
  // 终局后合约会把 points 清零，所以给面板的是"累计赚分"
  points: Number(r.points),
  pointsEarned: Number(r.points_earned ?? 0),
  eliminated: Boolean(r.eliminated),
  feesPaid: String(r.fees_paid),
  slashed: Boolean(r.slashed),
});

function gameOut(db: DatabaseSync, row: Record<string, unknown>, withSeats: boolean) {
  const g = {
    gameId: Number(row.game_id),
    phase: Number(row.phase),
    turn: Number(row.turn),
    ply: Number(row.ply),
    aiRevealed: Boolean(row.ai_revealed),
    winnerSeat: Number(row.winner_seat),
    secondSeat: Number(row.second_seat),
    prizePool: String(row.prize_pool),
    captureCount: Number(row.capture_count),
    protocolTreasury: String(row.protocol_treasury),
    motiveLogHash: row.motive_log_hash,
    indexedAt: Number(row.indexed_at),
  };
  if (!withSeats) return g;
  const seats = db
    .prepare(
      `SELECT s.*, COALESCE(sp.points_earned, 0) AS points_earned
       FROM seats s
       LEFT JOIN seat_points sp ON sp.game_id = s.game_id AND sp.seat = s.seat
       WHERE s.game_id = ? ORDER BY s.seat`
    )
    .all(g.gameId) as Record<string, unknown>[];
  return { ...g, seats: seats.map(seatOut) };
}

async function handleApi(db: DatabaseSync, url: URL, req: IncomingMessage, res: ServerResponse) {
  const p = url.pathname;

  if (p === "/health") {
    const total = db.prepare(`SELECT COUNT(*) AS n FROM games`).get() as { n: number };
    const finished = db
      .prepare(`SELECT COUNT(*) AS n FROM games WHERE phase = ?`)
      .get(PHASE.Finished) as { n: number };
    const players = db
      .prepare(`SELECT COUNT(DISTINCT player) AS n FROM seats WHERE occupied = 1`)
      .get() as { n: number };
    const lastScan = db.prepare(`SELECT value FROM meta WHERE key='last_scan'`).get() as
      | { value: string }
      | undefined;
    send(res, 200, {
      ok: true,
      games: total.n,
      finished: finished.n,
      players: players.n,
      lastScan: lastScan ? Number(lastScan.value) : null,
    });
    return;
  }

  // GET /games?phase=&player=&limit=&offset=
  if (p === "/games") {
    const limit = Math.min(Number(url.searchParams.get("limit") ?? 20), 200);
    const offset = Math.max(Number(url.searchParams.get("offset") ?? 0), 0);
    const phase = url.searchParams.get("phase");
    const player = url.searchParams.get("player")?.toLowerCase();

    const where: string[] = [];
    const args: unknown[] = [];
    if (phase !== null) {
      where.push("g.phase = ?");
      args.push(Number(phase));
    }
    if (player) {
      where.push("EXISTS (SELECT 1 FROM seats s WHERE s.game_id = g.game_id AND s.player = ?)");
      args.push(player);
    }
    const clause = where.length ? `WHERE ${where.join(" AND ")}` : "";
    const rows = db
      .prepare(`SELECT g.* FROM games g ${clause} ORDER BY g.game_id DESC LIMIT ? OFFSET ?`)
      .all(...(args as never[]), limit, offset) as Record<string, unknown>[];
    send(res, 200, { games: rows.map((r) => gameOut(db, r, true)), limit, offset });
    return;
  }

  // GET /games/:id
  const gm = p.match(/^\/games\/(\d+)$/);
  if (gm) {
    const row = db.prepare(`SELECT * FROM games WHERE game_id = ?`).get(Number(gm[1])) as
      | Record<string, unknown>
      | undefined;
    if (!row) {
      send(res, 404, { error: "game not indexed" });
      return;
    }
    send(res, 200, gameOut(db, row, true));
    return;
  }

  // GET /players/:address
  const pm = p.match(/^\/players\/(0x[0-9a-fA-F]{40})$/);
  if (pm) {
    const who = pm[1].toLowerCase();
    const played = db
      .prepare(`SELECT COUNT(*) AS n FROM seats WHERE player = ? AND occupied = 1`)
      .get(who) as { n: number };
    const won = db
      .prepare(
        `SELECT COUNT(*) AS n FROM games g JOIN seats s ON s.game_id = g.game_id AND s.seat = g.winner_seat
         WHERE s.player = ? AND g.phase = ?`
      )
      .get(who, PHASE.Finished) as { n: number };
    const staked = withBigInts(
      db.prepare(`SELECT COALESCE(SUM(CAST(seat_stake AS INTEGER)),0) AS v FROM seats WHERE player = ?`)
    ).get(who) as { v: unknown };
    const fees = withBigInts(
      db.prepare(`SELECT COALESCE(SUM(CAST(fees_paid AS INTEGER)),0) AS v FROM seats WHERE player = ?`)
    ).get(who) as { v: unknown };
    const points = db
      .prepare(
        `SELECT COALESCE(SUM(sp.points_earned),0) AS v FROM seat_points sp
         JOIN seats s ON s.game_id = sp.game_id AND s.seat = sp.seat
         WHERE s.player = ?`
      )
      .get(who) as { v: number };
    const slashedTimes = db
      .prepare(`SELECT COUNT(*) AS n FROM seats WHERE player = ? AND slashed = 1`)
      .get(who) as { n: number };
    const rep = db.prepare(`SELECT * FROM reputation WHERE agent = ?`).get(who) as
      | Record<string, unknown>
      | undefined;
    const recent = db
      .prepare(
        `SELECT g.* FROM games g JOIN seats s ON s.game_id = g.game_id
         WHERE s.player = ? ORDER BY g.game_id DESC LIMIT 10`
      )
      .all(who) as Record<string, unknown>[];

    send(res, 200, {
      address: who,
      gamesPlayed: played.n,
      gamesWon: won.n,
      winRate: played.n > 0 ? won.n / played.n : 0,
      totalStakedMon: formatEther(bigField(staked.v)),
      totalFeesBurnedMon: formatEther(bigField(fees.v)),
      totalPoints: points.v,
      timesSlashed: slashedTimes.n,
      reputation: rep
        ? {
            games: Number(rep.games),
            wins: Number(rep.wins),
            slashed: Number(rep.slashed),
            betrayalIndex: Number(rep.betrayal_index),
            trustScore: Number(rep.trust_score),
            forcedBurnMonTotal: formatEther(toBig(rep.forced_burn)),
            metadataURI: rep.metadata_uri,
          }
        : null,
      recentGames: recent.map((r) => gameOut(db, r, false)),
    });
    return;
  }

  // GET /leaderboard?limit=
  if (p === "/leaderboard") {
    const limit = Math.min(Number(url.searchParams.get("limit") ?? 10), 100);
    const rows = withBigInts(
      db.prepare(
        `SELECT s.player,
                COUNT(*) AS games,
                SUM(CASE WHEN g.winner_seat = s.seat AND g.phase = ? THEN 1 ELSE 0 END) AS wins,
                COALESCE(SUM(sp.points_earned), 0) AS points,
                SUM(CAST(s.fees_paid AS INTEGER)) AS fees,
                SUM(CASE WHEN s.slashed = 1 THEN 1 ELSE 0 END) AS slashed
         FROM seats s
         JOIN games g ON g.game_id = s.game_id
         LEFT JOIN seat_points sp ON sp.game_id = s.game_id AND sp.seat = s.seat
         WHERE s.occupied = 1
         GROUP BY s.player
         ORDER BY wins DESC, points DESC
         LIMIT ?`
      )
    ).all(PHASE.Finished, limit) as Record<string, unknown>[];
    send(res, 200, {
      leaderboard: rows.map((r) => ({
        player: r.player,
        games: Number(r.games),
        wins: Number(r.wins),
        winRate: Number(r.games) > 0 ? Number(r.wins) / Number(r.games) : 0,
        // 终局后合约会把 points 清零，所以给面板的是"累计赚分"
  points: Number(r.points),
  pointsEarned: Number(r.points_earned ?? 0),
        feesBurnedMon: formatEther(toBig(r.fees)),
        timesSlashed: Number(r.slashed),
      })),
    });
    return;
  }

  // GET /agents —— 已注册的 AI 身份与声誉
  if (p === "/agents") {
    const rows = db.prepare(`SELECT * FROM reputation ORDER BY updated_at DESC`).all() as Record<
      string,
      unknown
    >[];
    send(res, 200, {
      agents: rows.map((r) => ({
        agent: r.agent,
        games: Number(r.games),
        wins: Number(r.wins),
        slashed: Number(r.slashed),
        betrayalIndex: Number(r.betrayal_index),
        trustScore: Number(r.trust_score),
        forcedBurnMonTotal: formatEther(BigInt(String(r.forced_burn))),
        metadataURI: r.metadata_uri,
      })),
    });
    return;
  }

  send(res, 404, {
    error: "not found",
    routes: ["/health", "/games", "/games/:id", "/players/:address", "/leaderboard", "/agents"],
  });
  void req;
}

// ── 主流程 ───────────────────────────────────────────────────

async function main() {
  const cfg = loadConfig();
  const chain = defineChain({
    id: cfg.chainId,
    name: cfg.chainId === 10143 ? "Monad Testnet" : `chain-${cfg.chainId}`,
    nativeCurrency: { name: "MON", symbol: "MON", decimals: 18 },
    rpcUrls: { default: { http: [cfg.rpcUrl] } },
  });
  const pub = createPublicClient({ chain, transport: http(cfg.rpcUrl) });

  const actual = await pub.getChainId();
  if (actual !== cfg.chainId) {
    throw new Error(`RPC 实际 chainId 是 ${actual}，与配置的 ${cfg.chainId} 不一致，拒绝启动。`);
  }

  const db = openDb(cfg.dbPath);
  console.log("索引器启动");
  console.log(`  链        ${cfg.chainId} · ${cfg.rpcUrl}`);
  console.log(`  GameTable ${cfg.gameTable}`);
  console.log(`  数据库    ${cfg.dbPath}`);
  console.log(`  间隔      ${cfg.intervalMs}ms${cfg.once ? "（--once 模式）" : ""}`);

  if (cfg.once) {
    const r = await scanOnce(pub, cfg, db);
    console.log(`  扫描完成：${r.scanned} 个 id，写入/更新 ${r.updated} 局，nextGameId=${r.nextGameId}`);
    db.close();
    return;
  }

  // 先扫一轮再开 HTTP，保证起来就有数据
  const first = await scanOnce(pub, cfg, db);
  console.log(`  首轮：${first.updated} 局，nextGameId=${first.nextGameId}`);

  const server = createServer((req, res) => {
    if (req.method === "OPTIONS") {
      send(res, 204, {});
      return;
    }
    const url = new URL(req.url ?? "/", "http://localhost");
    handleApi(db, url, req, res).catch((e) => {
      send(res, 500, { error: (e as Error).message.split("\n")[0] });
    });
  });
  server.listen(cfg.port, () => {
    console.log(`  监听      http://0.0.0.0:${cfg.port}`);
    console.log(
      `  接口      GET /health · /games · /games/:id · /players/:address · /leaderboard · /agents`
    );
  });

  // 持续扫描
  for (;;) {
    await new Promise((r) => setTimeout(r, cfg.intervalMs));
    try {
      const r = await scanOnce(pub, cfg, db);
      if (r.updated > 0) console.log(`  扫描：${r.updated} 局（nextGameId=${r.nextGameId}）`);
    } catch (e) {
      console.error(`  扫描失败（继续）：${(e as Error).message.split("\n")[0]}`);
    }
  }
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
