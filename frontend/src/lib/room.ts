/**
 * room.ts —— 邀请链接 / 房间。
 *
 * 设计取舍（为什么不做服务端）：
 *   这个游戏本来就要求"每步一笔链上交易"，所以对局的**唯一真源是链上**。
 *   房间号 = gameId（合约里自增），邀请链接只是把一个 gameId 传给朋友。
 *   于是不需要任何房间服务器、不需要数据库、也不会出现"服务端状态和链上不一致"。
 *
 * 链接形态用 hash 而不是 query，避免静态托管下刷新 404：
 *   https://host/#/r/12
 */

export const ROOM_HASH_PREFIX = "#/r/";

/**
 * 观战标记：`#/r/12/watch`。
 *
 * 观战**不需要任何新机制** —— 这个游戏的数据全在链上，未入座的钱包本来
 * 就能只读渲染整个盘面（前端已有这条路径）。所以"观战"只需要一个能让人
 * 明确知道自己是来看而不是来打座的链接形态，以及一句提示。
 */
export const WATCH_SUFFIX = "/watch";

/** 去掉结尾的斜杠，避免拼出 "//#/r/1" 这种自己都解析不回来的链接。 */
function normalizeBase(url: string): string {
  return url.replace(/\/+$/, "");
}

/** 由链上 gameId 生成可分享的房间链接。 */
export function inviteLinkFor(gameId: bigint, origin?: string): string {
  return roomLinkFor(gameId, false, origin);
}

/** 观战链接（同一间房，只是带上 /watch 标记）。 */
export function spectateLinkFor(gameId: bigint, origin?: string): string {
  return roomLinkFor(gameId, true, origin);
}

function roomLinkFor(gameId: bigint, watch: boolean, origin?: string): string {
  const raw =
    origin ??
    (typeof window !== "undefined"
      ? `${window.location.origin}${window.location.pathname}`
      : "http://localhost:5173/");
  // 注意拼的是 "/#/r/<id>"：少了 "#" 生成出来的链接自己解析不回来，
  // 表现就是"朋友点开链接进不去房间"。
  return `${normalizeBase(raw)}/${ROOM_HASH_PREFIX}${gameId.toString()}${watch ? WATCH_SUFFIX : ""}`;
}

/** 当前 URL 是否是观战链接。 */
export function isWatchUrl(href?: string): boolean {
  const url = href ?? (typeof window !== "undefined" ? window.location.href : "");
  return new RegExp(`#/r/\\d+${WATCH_SUFFIX}`).test(url);
}

/** 从当前 URL 解析出邀请的房间号；没有则返回 null。 */
export function parseRoomFromUrl(href?: string): bigint | null {
  const url = href ?? (typeof window !== "undefined" ? window.location.href : "");
  if (!url) return null;
  // 同时兼容 #/r/12 与 ?room=12，方便手工分享
  const m = url.match(/#\/r\/(\d+)(?:\/watch)?/) ?? url.match(/[?&]room=(\d+)/);
  if (!m) return null;
  try {
    const id = BigInt(m[1]);
    // 只做最基本的健全性检查，别拿去打 RPC：
    // gameId 在合约里是 uint256，所以上界用 uint64（远超任何真实对局数），
    // 再大的值一定是手工编造的。
    if (id <= 0n || id > 2n ** 64n - 1n) return null;
    return id;
  } catch {
    return null;
  }
}

/** 把房间号写进地址栏（不触发页面刷新）。 */
export function setRoomInUrl(gameId: bigint | null, watch = false) {
  if (typeof window === "undefined") return;
  const base = normalizeBase(`${window.location.origin}${window.location.pathname}`);
  const next =
    gameId === null
      ? base
      : `${base}/${ROOM_HASH_PREFIX}${gameId}${watch ? WATCH_SUFFIX : ""}`;
  window.history.replaceState(null, "", next);
}

/** 复制到剪贴板；返回是否成功（不支持时降级为提示用户手动复制）。 */
export async function copyText(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    /* 继续尝试降级方案 */
  }
  try {
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.style.position = "fixed";
    ta.style.opacity = "0";
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand("copy");
    document.body.removeChild(ta);
    return ok;
  } catch {
    return false;
  }
}

export const SEAT_LABEL = ["红营", "蓝营", "绿营"] as const;

/** 房间状态的人类可读描述。 */
export function describeRoom(
  seats: { address?: string }[],
  phase: number
): { filled: number; summary: string } {
  const occupied = seats.filter((s) => s.address && s.address !== "0x0000000000000000000000000000000000000000");
  const filled = occupied.length;
  if (phase === 1) return { filled, summary: "对局进行中" };
  if (phase === 2) return { filled, summary: "该局已结束" };
  if (filled === 0) return { filled, summary: "空桌 · 等 3 人入座" };
  if (filled < 3) {
    const who = seats
      .map((s, i) => (s.address && s.address !== "0x0000000000000000000000000000000000000000" ? SEAT_LABEL[i] : null))
      .filter(Boolean)
      .join("、");
    return { filled, summary: `已有 ${filled}/3 人（${who}）· 还差 ${3 - filled} 人` };
  }
  return { filled, summary: "三座已满" };
}
