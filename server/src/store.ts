/**
 * store.ts —— 索引器的存储层，双后端。
 *
 * 为什么需要抽象：索引器有**两个部署形态**，而它们的存储条件完全不同。
 *
 *   1. 本地 / 长驻进程（`pnpm indexer`）：用 `node:sqlite`。
 *      Node 22+ 内置、零依赖、同步 API、单文件持久化。开发体验最好，
 *      而且它已经踩过"大整数直接抛错"的坑（见 db.ts 注释）。
 *
 *   2. Vercel serverless：**必须**用外部数据库。
 *      函数实例随时销毁、文件系统只读且不跨调用保留，SQLite 完全不可用。
 *
 * 所以这里定义一个最小的 async 接口，两个后端各自实现。上面所有查询逻辑
 * 都只依赖这个接口，不直接碰 driver。
 *
 * ⚠️ 占位符差异：SQLite 用 `?`，Postgres 用 `$1, $2…`。调用方统一写 `?`，
 *    由 PgStore 在内部转换 —— 否则每条 SQL 都要写两份。
 */

export type Row = Record<string, unknown>;

export interface Store {
  /** 建表（幂等）。 */
  init(): Promise<void>;
  /** 查询多行。 */
  all(sql: string, params?: unknown[]): Promise<Row[]>;
  /** 查询单行。 */
  get(sql: string, params?: unknown[]): Promise<Row | undefined>;
  /** 执行写入，返回受影响行数。 */
  run(sql: string, params?: unknown[]): Promise<{ changes: number }>;
  /** 后端名，用于日志。 */
  readonly kind: "sqlite" | "postgres";
  /** 关闭连接（长驻进程退出时用）。 */
  close(): Promise<void>;
}

/** 把 `?` 占位符转成 Postgres 的 `$1, $2…`。 */
function toPgPlaceholders(sql: string): string {
  let i = 0;
  return sql.replace(/\?/g, () => `$${++i}`);
}

/**
 * Postgres 后端。
 *
 * 只在真正用到时才 import("pg")：本地开发不装 pg 也能跑 SQLite 路径，
 * 不会因为缺少可选依赖而启动失败。
 */
export class PgStore implements Store {
  readonly kind = "postgres" as const;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private constructor(private readonly pool: any) {}

  static async open(connectionString: string): Promise<PgStore> {
    const { default: pg } = (await import("pg")) as unknown as {
      default: { Pool: new (cfg: Record<string, unknown>) => unknown };
    };
    const pool = new pg.Pool({
      connectionString,
      // 公网 Postgres 必须走 TLS；托管服务（Neon/Supabase）也要求 sslmode=require。
      ssl: connectionString.includes("sslmode=disable") ? false : { rejectUnauthorized: false },
      max: 4, // serverless 实例多，连接池要小，否则会打满数据库的连接数上限
      idleTimeoutMillis: 10_000,
      connectionTimeoutMillis: 10_000,
    });
    return new PgStore(pool);
  }

  async init(): Promise<void> {
    // Postgres 的方言差异：INTEGER 就是 4 字节，所以所有可能超过 2^31 的
    // 数值（wei 金额）一律用 TEXT；大整数由调用方以字符串写入。
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS games (
        game_id BIGINT PRIMARY KEY,
        phase INTEGER NOT NULL,
        turn INTEGER NOT NULL,
        ply INTEGER NOT NULL,
        ai_revealed BOOLEAN NOT NULL,
        winner_seat INTEGER NOT NULL,
        second_seat INTEGER NOT NULL,
        prize_pool TEXT NOT NULL,
        capture_count INTEGER NOT NULL,
        protocol_treasury TEXT NOT NULL,
        motive_log_hash TEXT NOT NULL,
        indexed_at BIGINT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS seats (
        game_id BIGINT NOT NULL,
        seat INTEGER NOT NULL,
        player TEXT NOT NULL,
        occupied BOOLEAN NOT NULL,
        seat_stake TEXT NOT NULL,
        play_balance TEXT NOT NULL,
        points INTEGER NOT NULL,
        eliminated BOOLEAN NOT NULL,
        fees_paid TEXT NOT NULL,
        slashed BOOLEAN NOT NULL,
        PRIMARY KEY (game_id, seat)
      );
      CREATE INDEX IF NOT EXISTS idx_seats_player ON seats(player);
      CREATE TABLE IF NOT EXISTS seat_points (
        game_id BIGINT NOT NULL,
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
        metadata_uri TEXT NOT NULL,
        updated_at BIGINT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS meta (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
    `);
  }

  async all(sql: string, params: unknown[] = []): Promise<Row[]> {
    const r = await this.pool.query(toPgPlaceholders(sql), params);
    return r.rows as Row[];
  }

  async get(sql: string, params: unknown[] = []): Promise<Row | undefined> {
    const rows = await this.all(sql, params);
    return rows[0];
  }

  async run(sql: string, params: unknown[] = []): Promise<{ changes: number }> {
    const r = await this.pool.query(toPgPlaceholders(sql), params);
    return { changes: r.rowCount ?? 0 };
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}

/**
 * SQLite 后端（本地开发 / 长驻进程）。
 *
 * ⚠️ node:sqlite 默认把整数读成 JS number，**超过安全整数范围会直接抛错**
 *    （"Value is too large to be represented as a JavaScript number"）。
 *    我们的金额是 wei，必然超范围 —— 所以所有读取都必须开 setReadBigInts。
 */
export class SqliteStore implements Store {
  readonly kind = "sqlite" as const;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private constructor(private readonly db: any) {}

  static async open(dbPath: string): Promise<SqliteStore> {
    const { DatabaseSync } = await import("node:sqlite");
    const db = new DatabaseSync(dbPath);
    return new SqliteStore(db);
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private prep(sql: string): any {
    const stmt = this.db.prepare(sql);
    // 金额列是 wei，必须用 BigInt 读，否则 driver 会抛
    stmt.setReadBigInts?.(true);
    return stmt;
  }

  async init(): Promise<void> {
    this.db.exec(`
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
        metadata_uri TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS meta (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
    `);
  }

  async all(sql: string, params: unknown[] = []): Promise<Row[]> {
    return this.prep(sql).all(...params) as Row[];
  }

  async get(sql: string, params: unknown[] = []): Promise<Row | undefined> {
    return this.prep(sql).get(...params) as Row | undefined;
  }

  async run(sql: string, params: unknown[] = []): Promise<{ changes: number }> {
    const r = this.prep(sql).run(...params);
    return { changes: Number(r.changes ?? 0) };
  }

  async close(): Promise<void> {
    this.db.close?.();
  }
}

/**
 * 按环境选择后端。
 *
 * 有 DATABASE_URL 就走 Postgres（Vercel 必须如此），否则用本地 SQLite。
 */
export async function openStore(opts: { databaseUrl?: string; dbPath?: string }): Promise<Store> {
  if (opts.databaseUrl) {
    const s = await PgStore.open(opts.databaseUrl);
    await s.init();
    return s;
  }
  if (!opts.dbPath) {
    throw new Error("既没有 DATABASE_URL 也没有 SQLite 路径：无法确定存储后端");
  }
  const { mkdirSync } = await import("node:fs");
  const path = await import("node:path");
  mkdirSync(path.dirname(opts.dbPath), { recursive: true });
  const s = await SqliteStore.open(opts.dbPath);
  await s.init();
  return s;
}
