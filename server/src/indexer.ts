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
import { openStore, type Store } from "./store.js";
import { createPublicClient, defineChain, http, formatEther, type Abi, type Hex, type PublicClient } from "viem";
import { readFileSync, mkdirSync, existsSync } from "node:fs";
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
  /**
   * 事件日志的起始块。
   *
   * 公共 RPC 会限制 eth_getLogs 的区间（Monad 公共 RPC 实测只允许 100 个块），
   * 所以不可能"从 0 全量扫"。默认只回溯最近 INDEXER_LOOKBACK_BLOCKS 个块，
   * 需要从头重建时用 INDEXER_START_BLOCK 显式指定部署块。
   */
  startBlock: bigint;
  once: boolean;
};

/**
 * 按 chainId 选择地址文件。
 *
 * deploy:testnet 写的是 addresses.10143.json，deploy:local 写的是 addresses.json。
 * 早期这里硬编码只读后者，于是 `CHAIN_ID=10143 pnpm indexer` 会拿 Anvil 的地址
 * 去问 Monad 测试网，报 "nextGameId returned no data" —— 部署完测试网却接不上索引。
 */
function addressesFileFor(chainId: number): string {
  const dir = path.join(repoRoot, "frontend/src/lib");
  const perChain = path.join(dir, `addresses.${chainId}.json`);
  return existsSync(perChain) ? perChain : path.join(dir, "addresses.json");
}

function loadConfig(): Config {
  const env = process.env;
  const chainId = Number(env.CHAIN_ID ?? 0);
  const filePath = addressesFileFor(chainId);
  const file = JSON.parse(readFileSync(filePath, "utf8")) as Record<string, string>;
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
      throw new Error(
        `${k} 地址无效：${v || "(空)"}。\n` +
          `  用的地址文件：${filePath}\n` +
          `  先跑 pnpm deploy:local / pnpm deploy:testnet，或用 VITE_* 环境变量显式指定。`
      );
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
    startBlock: 0n, // 占位，扫描时按最新块与 lookback 现算
    once: process.argv.includes("--once"),
  };
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
/**
 * 分块拉取事件日志。
 *
 * 公共 RPC 普遍限制 eth_getLogs 的区块区间（实测 Monad 测试网公共 RPC：
 * "eth_getLogs is limited to a 100 range"）。如果还按"从 0 扫到最新块"发一次请求，
 * 在测试网上会直接失败 —— 索引器刚连上测试网就崩。
 *
 * 所以这里按块分片拉，并且在被拒时**自动收缩片长**（不同 RPC 限制不同，
 * 硬编码一个值迟早会撞上别的链）。
 */
async function getEventsChunked(
  pub: PublicClient,
  opts: {
    address: Hex;
    abi: Abi;
    eventName: string;
    fromBlock: bigint;
    toBlock: bigint;
  }
): Promise<{ args?: unknown }[]> {
  const out: { args?: unknown }[] = [];
  let chunk = 100n; // 保守起点：Monad 公共 RPC 就是 100
  let cur = opts.fromBlock;

  while (cur <= opts.toBlock) {
    const end = cur + chunk - 1n > opts.toBlock ? opts.toBlock : cur + chunk - 1n;
    try {
      const logs = (await pub.getContractEvents({
        address: opts.address,
        abi: opts.abi,
        eventName: opts.eventName as never,
        fromBlock: cur,
        toBlock: end,
      })) as readonly { args?: unknown }[];
      out.push(...logs);
      cur = end + 1n;
    } catch (e) {
      // 区间被拒就收缩；收到 1 个块还失败说明不是区间问题，直接抛出
      if (chunk > 1n) {
        chunk = chunk / 2n;
        continue;
      }
      throw e;
    }
  }
  return out;
}

async function scanPoints(
  pub: PublicClient,
  cfg: Config,
  db: Store,
  gameAbi: Abi,
  fromBlock: bigint,
  toBlock: bigint
) {
  if (fromBlock > toBlock) return;
  const [settled, seized] = await Promise.all([
    getEventsChunked(pub, {
      address: cfg.gameTable,
      abi: gameAbi,
      eventName: "CaptureSettled",
      fromBlock,
      toBlock,
    }),
    getEventsChunked(pub, {
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

  for (const [k, v] of gained) {
    const [g, seat] = k.split(":");
    await db.run(
      `INSERT INTO seat_points (game_id, seat, points_earned) VALUES (?,?,?)
       ON CONFLICT(game_id, seat) DO UPDATE SET
         points_earned = MAX(points_earned, excluded.points_earned)`,
      [Number(g), Number(seat), v]
    );
  }
}

/** 把一个对局快照写库（幂等，重复扫到同一局会覆盖更新）。 */
async function upsertGame(db: Store, g: GameSnapshot) {
  await db.run(`INSERT INTO games (game_id, phase, turn, ply, ai_revealed, winner_seat, second_seat,
                        prize_pool, capture_count, protocol_treasury, motive_log_hash, indexed_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?)
     ON CONFLICT(game_id) DO UPDATE SET
       phase=excluded.phase, turn=excluded.turn, ply=excluded.ply,
       ai_revealed=excluded.ai_revealed, winner_seat=excluded.winner_seat,
       second_seat=excluded.second_seat, prize_pool=excluded.prize_pool,
       capture_count=excluded.capture_count, protocol_treasury=excluded.protocol_treasury,
       motive_log_hash=excluded.motive_log_hash, indexed_at=excluded.indexed_at`, [g.gameId, g.phase, g.turn, g.ply, g.aiRevealed ? 1 : 0, g.winnerSeat, g.secondSeat, g.prizePool.toString(), g.captureCount, g.protocolTreasury.toString(), g.motiveLogHash, Date.now()]);

  for (const s of g.seats) {
    await db.run(
      `INSERT INTO seats (game_id, seat, player, occupied, seat_stake, play_balance, points,
                        eliminated, fees_paid, slashed)
     VALUES (?,?,?,?,?,?,?,?,?,?)
     ON CONFLICT(game_id, seat) DO UPDATE SET
       player=excluded.player, occupied=excluded.occupied, seat_stake=excluded.seat_stake,
       play_balance=excluded.play_balance, points=excluded.points,
       eliminated=excluded.eliminated, fees_paid=excluded.fees_paid, slashed=excluded.slashed`,
      [
      g.gameId,
      s.seat,
      s.player.toLowerCase(),
      s.occupied ? 1 : 0,
      s.seatStake.toString(),
      s.playBalance.toString(),
      s.points,
      s.eliminated ? 1 : 0,
      s.feesPaid.toString(),
      s.slashed ? 1 : 0,
      ]
    );
  }
}

async function scanOnce(
  pub: PublicClient,
  cfg: Config,
  db: Store
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
      await db.run(`INSERT INTO reputation (agent, games, wins, slashed, betrayal_index, trust_score,
                                 forced_burn, registered, metadata_uri, updated_at)
         VALUES (?,?,?,?,?,?,?,?,?,?)
         ON CONFLICT(agent) DO UPDATE SET
           games=excluded.games, wins=excluded.wins, slashed=excluded.slashed,
           betrayal_index=excluded.betrayal_index, trust_score=excluded.trust_score,
           forced_burn=excluded.forced_burn, registered=excluded.registered,
           metadata_uri=excluded.metadata_uri, updated_at=excluded.updated_at`, [who, rep.games, rep.wins, rep.slashed, rep.betrayalIndex, rep.trustScore, rep.forcedBurnMonTotal.toString(), rep.registered ? 1 : 0, rep.metadataURI, Date.now()]);
    } catch {
      /* 单条声誉失败不影响整轮 */
    }
  }

  // 事件累计：用 meta 记录已扫块高，只扫增量
  const fromRow = await db.get(`SELECT value FROM meta WHERE key='points_scanned_block'`) as
    | { value: string }
    | undefined;
  const latest = await pub.getBlockNumber();
  // 首次扫描的起点：显式配置优先，否则只回溯最近 N 个块。
  // 为什么不能从 0 开始：公共 RPC 限制 getLogs 区间（Monad 实测 100 块），
  // 从 0 扫到 7000 万块等于 70 万次请求，永远追不上。
  const envStart = process.env.INDEXER_START_BLOCK;
  const lookback = BigInt(process.env.INDEXER_LOOKBACK_BLOCKS ?? 50_000);
  const defaultStart = latest > lookback ? latest - lookback : 0n;
  const firstStart = envStart ? BigInt(envStart) : defaultStart;
  const fromBlock = fromRow ? BigInt(fromRow.value) + 1n : firstStart;
  if (fromBlock <= latest) {
    await scanPoints(pub, cfg, db, gameAbi, fromBlock, latest);
    await db.run(`INSERT INTO meta (key, value) VALUES ('points_scanned_block', ?)
       ON CONFLICT(key) DO UPDATE SET value=excluded.value`, [String(latest)]);
  }

  await db.run(`INSERT INTO meta (key, value) VALUES ('last_scan', ?)
     ON CONFLICT(key) DO UPDATE SET value=excluded.value`, [String(Date.now())]);

  return { scanned: nextGameId - from, updated, nextGameId };
}

// ── HTTP 接口 ────────────────────────────────────────────────

function send(res: ServerResponse, status: number, body: unknown, origin = "*") {
  // 幂等：handler 内部抛错时，catch 分支会再调一次 send —— 若已经发过响应头，
  // 第二次 writeHead 会抛 ERR_HTTP_HEADERS_SENT 并**直接杀掉整个索引器进程**
  // （实测踩过：一次 /health 请求就能让服务退出）。这里直接跳过第二次。
  if (res.headersSent || res.writableEnded) return;
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "access-control-allow-origin": origin,
    "access-control-allow-headers": "content-type",
    "access-control-allow-methods": "GET,OPTIONS",
    "cache-control": "no-store",
  });
  // BigInt 序列化：
  // SQLite 后端为了安全读取 wei 金额，对所有整数列开了 setReadBigInts，
  // 于是连 COUNT(*) 也是 BigInt —— 而 JSON.stringify(BigInt) 会**直接抛错**
  // （"Do not know how to serialize a BigInt"），表现为 /health 返回空、
  // /games 里只剩 {}。这里统一转换：能放进 number 的转 number，否则转字符串。
  res.end(
    JSON.stringify(body, (_k, v) => {
      if (typeof v !== "bigint") return v;
      return v >= BigInt(Number.MIN_SAFE_INTEGER) && v <= BigInt(Number.MAX_SAFE_INTEGER)
        ? Number(v)
        : v.toString();
    })
  );
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

async function gameOut(db: Store, row: Record<string, unknown>, withSeats: boolean) {
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
  const seats = (await db.all(
    `SELECT s.*, COALESCE(sp.points_earned, 0) AS points_earned
       FROM seats s
       LEFT JOIN seat_points sp ON sp.game_id = s.game_id AND sp.seat = s.seat
       WHERE s.game_id = ? ORDER BY s.seat`,
    [g.gameId]
  )) as Record<string, unknown>[];
  return { ...g, seats: seats.map(seatOut) };
}

async function handleApi(db: Store, url: URL, req: IncomingMessage, res: ServerResponse) {
  const p = url.pathname;

  if (p === "/health") {
    const total = await db.get(`SELECT COUNT(*) AS n FROM games`) as { n: number };
    const finished = (await db.get(`SELECT COUNT(*) AS n FROM games WHERE phase = ?`, [PHASE.Finished])) as { n: number };
    const players = (await db.get(`SELECT COUNT(DISTINCT player) AS n FROM seats WHERE occupied = 1`)) as { n: number };
    const lastScan = await db.get(`SELECT value FROM meta WHERE key='last_scan'`) as
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
    const rows = (await db.all(
      `SELECT g.* FROM games g ${clause} ORDER BY g.game_id DESC LIMIT ? OFFSET ?`,
      [...(args as never[]), limit, offset]
    )) as Record<string, unknown>[];
    send(res, 200, {
      games: await Promise.all(rows.map((r) => gameOut(db, r, true))),
      limit,
      offset,
    });
    return;
  }

  // GET /games/:id
  const gm = p.match(/^\/games\/(\d+)$/);
  if (gm) {
    const row = await db.get(`SELECT * FROM games WHERE game_id = ?`, [Number(gm[1])]) as
      | Record<string, unknown>
      | undefined;
    if (!row) {
      send(res, 404, { error: "game not indexed" });
      return;
    }
    send(res, 200, await gameOut(db, row, true));
    return;
  }

  // GET /players/:address
  const pm = p.match(/^\/players\/(0x[0-9a-fA-F]{40})$/);
  if (pm) {
    const who = pm[1].toLowerCase();
    const played = (await db.get(`SELECT COUNT(*) AS n FROM seats WHERE player = ? AND occupied = 1`, [who])) as { n: number };
    const won = (await db.get(`SELECT COUNT(*) AS n FROM games g JOIN seats s ON s.game_id = g.game_id AND s.seat = g.winner_seat
         WHERE s.player = ? AND g.phase = ?`, [who, PHASE.Finished])) as { n: number };
    const staked = (await db.get(
      `SELECT COALESCE(SUM(CAST(seat_stake AS INTEGER)),0) AS v FROM seats WHERE player = ?`,
      [who]
    )) as { v: unknown };
    const fees = (await db.get(
      `SELECT COALESCE(SUM(CAST(fees_paid AS INTEGER)),0) AS v FROM seats WHERE player = ?`,
      [who]
    )) as { v: unknown };
    const points = (await db.get(`SELECT COALESCE(SUM(sp.points_earned),0) AS v FROM seat_points sp
         JOIN seats s ON s.game_id = sp.game_id AND s.seat = sp.seat
         WHERE s.player = ?`, [who])) as { v: number };
    const slashedTimes = (await db.get(`SELECT COUNT(*) AS n FROM seats WHERE player = ? AND slashed = 1`, [who])) as { n: number };
    const rep = await db.get(`SELECT * FROM reputation WHERE agent = ?`, [who]) as
      | Record<string, unknown>
      | undefined;
    const recent = (await db.all(`SELECT g.* FROM games g JOIN seats s ON s.game_id = g.game_id
         WHERE s.player = ? ORDER BY g.game_id DESC LIMIT 10`, [who])) as Record<string, unknown>[];

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
      recentGames: await Promise.all(recent.map((r) => gameOut(db, r, false))),
    });
    return;
  }

  // GET /leaderboard?limit=
  if (p === "/leaderboard") {
    const limit = Math.min(Number(url.searchParams.get("limit") ?? 10), 100);
    const rows = (await db.all(
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
         LIMIT ?`,
        [PHASE.Finished, limit]
      )) as Record<string, unknown>[];
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
    const rows = await db.all(`SELECT * FROM reputation ORDER BY updated_at DESC`) as Record<
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

  const db = await openStore({
    databaseUrl: process.env.DATABASE_URL,
    dbPath: cfg.dbPath,
  });
  console.log("索引器启动");
  console.log(`  链        ${cfg.chainId} · ${cfg.rpcUrl}`);
  console.log(`  GameTable ${cfg.gameTable}`);
  console.log(`  数据库    ${db.kind}${db.kind === "sqlite" ? ` · ${cfg.dbPath}` : ""}`);
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
  // 默认只绑回环：索引器是"给同一个部署里的前端/代理用"的服务，
  // 本身没有任何鉴权。绑 0.0.0.0 会让同机其它进程、内网任意主机都能读它
  // （实测服务器上它确实监听在 *:8790，只靠 ufw 挡着）。
  // 需要对外暴露时用 INDEXER_HOST 显式指定，让"要不要公开"成为一个自觉决定。
  server.listen(cfg.port, process.env.INDEXER_HOST ?? "127.0.0.1", () => {
    console.log(`  监听      http://${process.env.INDEXER_HOST ?? "127.0.0.1"}:${cfg.port}`);
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
