-- 三国棋局索引器 · Supabase 表结构
--
-- 在 Supabase 控制台 → SQL Editor → New query → 粘贴执行（只需一次）。
--
-- 设计说明：
--   * 金额列（prize_pool / seat_stake / play_balance / fees_paid / forced_burn）
--     一律用 TEXT 存 wei 字符串。Postgres 的 BIGINT 是 8 字节，1e18 量级能放下，
--     但 JS 端 JSON 解析会丢精度（Number.MAX_SAFE_INTEGER ≈ 9e15），
--     所以用文本传输最稳。
--   * seats / games 都是 upsert（索引器会反复扫同一局），所以主键必须齐全。
--   * seat_points 单独一张表：合约终局会把 points 清零进奖池/孤儿池，
--     历史统计只能靠吃子事件累计，不能读 getSeat 的当前值。

CREATE TABLE IF NOT EXISTS games (
  game_id           BIGINT PRIMARY KEY,
  phase             INTEGER NOT NULL,
  turn              INTEGER NOT NULL,
  ply               INTEGER NOT NULL,
  ai_revealed       BOOLEAN NOT NULL,
  winner_seat       INTEGER NOT NULL,
  second_seat       INTEGER NOT NULL,
  prize_pool        TEXT    NOT NULL,
  capture_count     INTEGER NOT NULL,
  protocol_treasury TEXT    NOT NULL,
  motive_log_hash   TEXT    NOT NULL,
  indexed_at        BIGINT  NOT NULL
);

CREATE TABLE IF NOT EXISTS seats (
  game_id      BIGINT  NOT NULL,
  seat         INTEGER NOT NULL,
  player       TEXT    NOT NULL,
  occupied     BOOLEAN NOT NULL,
  seat_stake   TEXT    NOT NULL,
  play_balance TEXT    NOT NULL,
  points       INTEGER NOT NULL,
  eliminated   BOOLEAN NOT NULL,
  fees_paid    TEXT    NOT NULL,
  slashed      BOOLEAN NOT NULL,
  PRIMARY KEY (game_id, seat)
);
CREATE INDEX IF NOT EXISTS idx_seats_player ON seats(player);

CREATE TABLE IF NOT EXISTS seat_points (
  game_id       BIGINT  NOT NULL,
  seat          INTEGER NOT NULL,
  points_earned INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (game_id, seat)
);

CREATE TABLE IF NOT EXISTS reputation (
  agent         TEXT PRIMARY KEY,
  games         INTEGER NOT NULL,
  wins          INTEGER NOT NULL,
  slashed       INTEGER NOT NULL,
  betrayal_index INTEGER NOT NULL,
  trust_score   INTEGER NOT NULL,
  forced_burn   TEXT    NOT NULL,
  metadata_uri  TEXT    NOT NULL,
  updated_at    BIGINT  NOT NULL
);

CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

-- 索引器用 service key 走服务端读写；前端只读，走 publishable key。
-- Supabase 默认对 public schema 开启 RLS，service key 绕过 RLS，
-- 所以这里不需要额外策略。若将来要让浏览器直连，再单独加只读策略。
