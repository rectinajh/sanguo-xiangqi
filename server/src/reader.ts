/**
 * reader.ts —— 把链上对局读成结构化数据。
 *
 * 索引器与 agent 共用同一套读取逻辑（此前 agent 里有一份重复实现）。
 * 所有数据都从合约读，链是唯一真源；这里不做任何推断或缓存。
 */
import { formatEther, type Hex, type Abi } from "viem";
import type { PublicClient } from "viem";

/** 与 GameTable.sol 的 enum Phase 对应 */
export const PHASE = { Lobby: 0, Playing: 1, Finished: 2 } as const;

export type SeatSnapshot = {
  seat: number;
  player: Hex;
  occupied: boolean;
  seatStake: bigint;
  playBalance: bigint;
  points: number;
  eliminated: boolean;
  feesPaid: bigint;
  slashed: boolean;
};

export type GameSnapshot = {
  gameId: number;
  phase: number;
  turn: number;
  ply: number;
  aiRevealed: boolean;
  winnerSeat: number;
  prizePool: bigint;
  captureCount: number;
  secondSeat: number;
  seats: SeatSnapshot[];
  protocolTreasury: bigint;
  motiveLogHash: Hex;
};

export async function readGame(
  pub: PublicClient,
  address: Hex,
  abi: Abi,
  gameId: number | bigint
): Promise<GameSnapshot | null> {
  const id = BigInt(gameId);
  try {
    const meta = (await pub.readContract({
      address,
      abi,
      functionName: "getGameMeta",
      args: [id],
    })) as readonly [number, number, number, boolean, number, bigint];

    const seatResults = await Promise.all(
      [0, 1, 2].map((s) =>
        pub.readContract({
          address,
          abi,
          functionName: "getSeat",
          args: [id, s],
        }) as Promise<readonly [string, bigint, bigint, number, boolean]>
      )
    );

    const [fees, slashed, captures, treasury, secondSeat] = await Promise.all([
      Promise.all(
        [0, 1, 2].map((s) =>
          pub.readContract({ address, abi, functionName: "feesPaidOf", args: [id, s] }) as Promise<bigint>
        )
      ),
      Promise.all(
        [0, 1, 2].map((s) =>
          pub.readContract({ address, abi, functionName: "seatWasSlashed", args: [id, s] }) as Promise<boolean>
        )
      ),
      pub.readContract({ address, abi, functionName: "captureCount", args: [id] }) as Promise<bigint>,
      pub.readContract({ address, abi, functionName: "protocolTreasuryOf", args: [id] }) as Promise<bigint>,
      pub.readContract({ address, abi, functionName: "secondSeatOf", args: [id] }) as Promise<number>,
    ]);

    let motiveLogHash: Hex = `0x${"00".repeat(32)}`;
    try {
      motiveLogHash = (await pub.readContract({
        address,
        abi,
        functionName: "getMotiveLogHash",
        args: [id],
      })) as Hex;
    } catch {
      /* 老版本合约没有这个 getter */
    }

    const ZERO = "0x0000000000000000000000000000000000000000";
    return {
      gameId: Number(id),
      phase: Number(meta[0]),
      turn: Number(meta[1]),
      ply: Number(meta[2]),
      aiRevealed: Boolean(meta[3]),
      winnerSeat: Number(meta[4]),
      prizePool: meta[5],
      secondSeat: Number(secondSeat),
      captureCount: Number(captures),
      protocolTreasury: treasury,
      motiveLogHash,
      seats: seatResults.map((r, s) => ({
        seat: s,
        player: r[0] as Hex,
        occupied: r[0].toLowerCase() !== ZERO,
        seatStake: r[1],
        playBalance: r[2],
        points: Number(r[3]),
        eliminated: r[4],
        feesPaid: fees[s],
        slashed: slashed[s],
      })),
    };
  } catch {
    // gameId 不存在（或 RPC 抖动）时返回 null，让调用方决定
    return null;
  }
}

export type Reputation = {
  agent: Hex;
  games: number;
  wins: number;
  slashed: number;
  betrayalIndex: number;
  trustScore: number;
  forcedBurnMonTotal: bigint;
  registered: boolean;
  metadataURI: string;
};

/**
 * 读取 AgentRegistry 的声誉。
 *
 * ⚠️ viem 对**单个 struct 返回值**会解码成带名字的对象
 * （{games, wins, slashed, …}），而不是数组。早期这里按下标 r[0]/r[6] 读，
 * 结果每个字段都是 NaN、registered 恒为 false —— 索引器因此从不写声誉表，
 * 玩家主页永远显示不出声誉。这里同时兼容两种形态。
 */
export async function readReputation(pub: PublicClient, address: Hex, abi: Abi, who: Hex): Promise<Reputation> {
  const r = (await pub.readContract({
    address,
    abi,
    functionName: "getReputation",
    args: [who],
  })) as unknown;

  const pick = (idx: number, name: string): unknown => {
    if (Array.isArray(r)) return (r as unknown[])[idx];
    if (r && typeof r === "object") {
      const o = r as Record<string, unknown>;
      if (name in o) return o[name];
      // 有些 viem 版本会给出数字键
      if (String(idx) in o) return o[String(idx)];
    }
    return undefined;
  };

  return {
    agent: who,
    games: Number(pick(0, "games") ?? 0),
    wins: Number(pick(1, "wins") ?? 0),
    slashed: Number(pick(2, "slashed") ?? 0),
    betrayalIndex: Number(pick(3, "betrayalIndex") ?? 0),
    trustScore: Number(pick(4, "trustScore") ?? 0),
    forcedBurnMonTotal: BigInt((pick(5, "forcedBurnMonTotal") as bigint | undefined) ?? 0n),
    registered: Boolean(pick(6, "registered")),
    metadataURI: String(pick(7, "metadataURI") ?? ""),
  };
}

/** 人类可读的一行摘要，CLI 与前端都能用。 */
export function summarizeGame(g: GameSnapshot): string {
  const ai = g.aiRevealed ? `AI=seat${g.seats.length ? "" : ""}` : "AI=hidden";
  const winner = g.winnerSeat < 3 ? `winner=seat${g.winnerSeat}` : "winner=none";
  const pool = formatEther(g.prizePool);
  return `#${g.gameId} phase=${g.phase} ply=${g.ply} ${winner} ${ai} pool=${pool}`;
}
