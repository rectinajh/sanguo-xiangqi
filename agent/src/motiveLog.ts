/**
 * motiveLog —— AI 的动机日志。
 *
 * 终局时把整份日志的 keccak256 写进 GameTable.motiveLogHash，
 * 让"AI 为什么这么下"变成可审计的链上证据，而不是客户端随便造的一句话。
 */
import { keccak256, encodePacked, type Hex } from "viem";
import { formatMon } from "@sanguo/shared";

export type MotiveEntry = {
  ply: number;
  kind: "open" | "capture" | "betray" | "peace" | "greedy" | "note" | "final";
  detail: string;
  /** 本次决策带来的对手额外开销（wei），用于累计 forcedBurnMON */
  forcedBurn?: bigint;
};

export class MotiveLog {
  readonly entries: MotiveEntry[] = [];
  strategy: string;

  constructor(strategy: string) {
    this.strategy = strategy;
  }

  push(e: MotiveEntry) {
    this.entries.push(e);
  }

  get forcedBurnMon(): bigint {
    return this.entries.reduce((a, e) => a + (e.forcedBurn ?? 0n), 0n);
  }

  /** 人可读文本；哈希上链的是它的 UTF-8 字节 */
  toText(): string {
    const lines = [
      "motiveLog v2",
      `strategy=${this.strategy}`,
      `entries=${this.entries.length}`,
      `forcedBurnMON=${formatMon(this.forcedBurnMon)}`,
      ...this.entries.map((e) => `ply=${e.ply} ${e.kind} ${e.detail}`),
    ];
    return lines.join("\n");
  }

  hash(): Hex {
    return keccak256(encodePacked(["string"], [this.toText()]));
  }
}
