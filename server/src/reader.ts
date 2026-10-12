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

export async function readReputation(pub: PublicClient, address: Hex, abi: Abi, who: Hex): Promise<Reputation> {
  const r = (await pub.readContract({
    address,
    abi,
    functionName: "getReputation",
    args: [who],
  })) as readonly [number, number, number, number, number, bigint, boolean, string];
  return {
    agent: who,
    games: Number(r[0]),
    wins: Number(r[1]),
    slashed: Number(r[2]),
    betrayalIndex: Number(r[3]),
    trustScore: Number(r[4]),
    forcedBurnMonTotal: r[5],
    registered: Boolean(r[6]),
    metadataURI: r[7],
  };
}

/** 人类可读的一行摘要，CLI 与前端都能用。 */
export function summarizeGame(g: GameSnapshot): string {
  const ai = g.aiRevealed ? `AI=seat${g.seats.length ? "" : ""}` : "AI=hidden";
  const winner = g.winnerSeat < 3 ? `winner=seat${g.winnerSeat}` : "winner=none";
  const pool = formatEther(g.prizePool);
  return `#${g.gameId} phase=${g.phase} ply=${g.ply} ${winner} ${ai} pool=${pool}`;
}
