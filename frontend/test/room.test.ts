import { describe, it, expect } from "vitest";
import { inviteLinkFor, parseRoomFromUrl, ROOM_HASH_PREFIX } from "../src/lib/room";

/**
 * 这些测试是有来历的：inviteLinkFor 曾经拼出缺少 "#" 的链接
 * （`https://x/r/42`），看起来像个正常 URL，但 parseRoomFromUrl 读不回来，
 * 表现就是"朋友点开邀请链接进不去房间"。往返一致性必须钉死。
 */
describe("邀请链接", () => {
  const bases = [
    "https://game.example.com",
    "https://game.example.com/",
    "http://localhost:5173",
    "http://localhost:5173/",
    "https://example.com/sub/path",
  ];

  it("生成的链接必须能被自己解析回来（往返一致）", () => {
    for (const base of bases) {
      const link = inviteLinkFor(42n, base);
      expect(link).toContain(ROOM_HASH_PREFIX);
      expect(parseRoomFromUrl(link)).toBe(42n);
    }
  });

  it("大 gameId 也不丢精度", () => {
    // uint64 上界附近仍应正常往返
    const big = (1n << 64n) - 1n;
    expect(parseRoomFromUrl(inviteLinkFor(big, "https://x.com"))).toBe(big);
  });

  it("超出 uint64 的编号（一定是手编的）被拒绝", () => {
    expect(parseRoomFromUrl(`http://x/#/r/${(1n << 64n).toString()}`)).toBeNull();
  });

  it("接受 hash 与 query 两种形态", () => {
    expect(parseRoomFromUrl("http://x/#/r/12")).toBe(12n);
    expect(parseRoomFromUrl("https://x/?room=7")).toBe(7n);
    expect(parseRoomFromUrl("https://x/?a=1&room=9")).toBe(9n);
  });

  it("没有房间号时返回 null", () => {
    expect(parseRoomFromUrl("https://x/")).toBeNull();
    expect(parseRoomFromUrl("")).toBeNull();
  });

  it("手工改地址栏的垃圾输入被拒绝", () => {
    expect(parseRoomFromUrl("http://x/#/r/abc")).toBeNull();
    expect(parseRoomFromUrl("http://x/#/r/0")).toBeNull();
    expect(parseRoomFromUrl("http://x/#/r/99999999999999999999999999")).toBeNull();
  });
});
