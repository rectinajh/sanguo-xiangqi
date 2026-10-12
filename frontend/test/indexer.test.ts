import { describe, it, expect } from "vitest";
import { weiToMon, shortAddr, PHASE_LABEL } from "../src/lib/indexer";

/**
 * 这两个 helper 直接决定面板显示对不对，而且 wei→MON 很容易写错
 * （18 位小数、整除截断），所以钉一下。
 */
describe("weiToMon", () => {
  it("整数部分与小数部分都要正确", () => {
    expect(weiToMon("0")).toBe("0.000");
    expect(weiToMon("1000000000000000000")).toBe("1.000");
    expect(weiToMon("3200000000000000000")).toBe("3.200");
    expect(weiToMon("59000000000000000")).toBe("0.059");
    expect(weiToMon("9000000000000000")).toBe("0.009");
  });

  it("大额也不丢精度（索引器传来的就是这种量级）", () => {
    expect(weiToMon("9000000000000000000")).toBe("9.000");
    expect(weiToMon("123456789000000000000")).toBe("123.456");
  });

  it("非法输入要降级而不是抛错", () => {
    expect(weiToMon("not-a-number")).toBe("0.000");
    expect(weiToMon("")).toBe("0.000");
  });

  it("按位数截断而不是四舍五入", () => {
    // 0.000999... 截到 3 位是 0.000
    expect(weiToMon("999000000000000", 3)).toBe("0.000");
    expect(weiToMon("999000000000000", 6)).toBe("0.000999");
  });
});

describe("shortAddr", () => {
  it("长地址缩成 0x1234…abcd", () => {
    expect(shortAddr("0x90F79bf6EB2c4f870365E785982E1f101E93b906")).toBe("0x90F7…b906");
  });
  it("短字符串与空值原样返回", () => {
    expect(shortAddr("")).toBe("");
    expect(shortAddr("0x1234")).toBe("0x1234");
  });
});

describe("PHASE_LABEL", () => {
  it("与 GameTable.Phase 的枚举顺序一致", () => {
    expect(PHASE_LABEL[0]).toBe("大厅");
    expect(PHASE_LABEL[1]).toBe("行棋中");
    expect(PHASE_LABEL[2]).toBe("已终局");
  });
});
