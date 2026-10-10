import {
  type Account,
  type Hex,
  encodeAbiParameters,
  keccak256,
  parseEther,
  encodePacked,
} from "viem";
import gameAbi from "../abi/GameTable.json";
import covAbi from "../abi/Covenant.json";
import regAbi from "../abi/AgentRegistry.json";
import { addresses, getPublicClient, getWalletClient } from "./chain";

export const gameTableAbi = gameAbi as any;
export const covenantAbi = covAbi as any;
export const registryAbi = regAbi as any;

export function gameAddress() {
  return addresses.GameTable as `0x${string}`;
}
export function covenantAddress() {
  return addresses.Covenant as `0x${string}`;
}
export function registryAddress() {
  return addresses.AgentRegistry as `0x${string}`;
}

export function hasAddresses() {
  return Boolean(addresses.GameTable && addresses.Covenant);
}

export function moveCommitHash(
  seat: number,
  fromX: number,
  fromY: number,
  toX: number,
  toY: number,
  piece: number,
  salt: Hex
) {
  return keccak256(
    encodeAbiParameters(
      [
        { type: "uint8" },
        { type: "uint8" },
        { type: "uint8" },
        { type: "uint8" },
        { type: "uint8" },
        { type: "uint8" },
        { type: "bytes32" },
      ],
      [seat, fromX, fromY, toX, toY, piece, salt]
    )
  );
}

export async function createGame(account: Account, aiSeat: number) {
  const wallet = getWalletClient(account);
  const pub = getPublicClient();
  const hash = await wallet.writeContract({
    address: gameAddress(),
    abi: gameTableAbi,
    functionName: "createGame",
    args: [aiSeat],
    account,
    chain: wallet.chain,
  });
  const receipt = await pub.waitForTransactionReceipt({ hash });
  // parse GameCreated
  let gameId = 1n;
  for (const log of receipt.logs) {
    try {
      const topics = log.topics;
      if (topics[0] && topics.length >= 2) {
        // GameCreated(uint256,uint8) — topic1 = gameId
        gameId = BigInt(topics[1]!);
      }
    } catch {
      /* ignore */
    }
  }
  // safer: read nextGameId - 1
  const next = (await pub.readContract({
    address: gameAddress(),
    abi: gameTableAbi,
    functionName: "nextGameId",
  })) as bigint;
  return next - 1n;
}

export async function joinGame(account: Account, gameId: bigint, seat: number, value = parseEther("3")) {
  const wallet = getWalletClient(account);
  const pub = getPublicClient();
  const hash = await wallet.writeContract({
    address: gameAddress(),
    abi: gameTableAbi,
    functionName: "join",
    args: [gameId, seat],
    value,
    account,
    chain: wallet.chain,
  });
  await pub.waitForTransactionReceipt({ hash });
  return hash;
}

export async function commitAndReveal(
  account: Account,
  gameId: bigint,
  seat: number,
  from: { x: number; y: number },
  to: { x: number; y: number },
  piece: number
) {
  const salt = keccak256(encodePacked(["string", "uint256"], [`salt-${Date.now()}`, BigInt(Math.floor(Math.random() * 1e9))]));
  const ch = moveCommitHash(seat, from.x, from.y, to.x, to.y, piece, salt);
  const wallet = getWalletClient(account);
  const pub = getPublicClient();
  const h1 = await wallet.writeContract({
    address: gameAddress(),
    abi: gameTableAbi,
    functionName: "commitMove",
    args: [gameId, ch],
    account,
    chain: wallet.chain,
  });
  await pub.waitForTransactionReceipt({ hash: h1 });
  const h2 = await wallet.writeContract({
    address: gameAddress(),
    abi: gameTableAbi,
    functionName: "revealMove",
    args: [gameId, from.x, from.y, to.x, to.y, piece, salt],
    account,
    chain: wallet.chain,
  });
  await pub.waitForTransactionReceipt({ hash: h2 });
  return { commit: h1, reveal: h2, salt };
}

export async function readSeat(gameId: bigint, seat: number) {
  const pub = getPublicClient();
  const r = (await pub.readContract({
    address: gameAddress(),
    abi: gameTableAbi,
    functionName: "getSeat",
    args: [gameId, seat],
  })) as readonly [string, bigint, bigint, number, boolean];
  return {
    player: r[0] as `0x${string}`,
    seatStake: r[1],
    playBalance: r[2],
    points: Number(r[3]),
    eliminated: r[4],
  };
}

export async function readMeta(gameId: bigint) {
  const pub = getPublicClient();
  const r = (await pub.readContract({
    address: gameAddress(),
    abi: gameTableAbi,
    functionName: "getGameMeta",
    args: [gameId],
  })) as readonly [number, number, number, boolean, number, bigint];
  return {
    phase: r[0],
    turn: r[1] as 0 | 1 | 2,
    ply: Number(r[2]),
    aiRevealed: r[3],
    winnerSeat: r[4],
    prizePool: r[5],
  };
}

export async function directorDrain(account: Account, gameId: bigint, seat: number, amount: bigint) {
  const wallet = getWalletClient(account);
  const pub = getPublicClient();
  const hash = await wallet.writeContract({
    address: gameAddress(),
    abi: gameTableAbi,
    functionName: "directorDrain",
    args: [gameId, seat, amount],
    account,
    chain: wallet.chain,
  });
  await pub.waitForTransactionReceipt({ hash });
}

export async function finalizeGame(account: Account, gameId: bigint, motiveHash: Hex) {
  const wallet = getWalletClient(account);
  const pub = getPublicClient();
  const hash = await wallet.writeContract({
    address: gameAddress(),
    abi: gameTableAbi,
    functionName: "finalizeGame",
    args: [gameId, motiveHash],
    account,
    chain: wallet.chain,
  });
  await pub.waitForTransactionReceipt({ hash });
  return hash;
}

export async function lockEarnest(
  account: Account,
  gameId: bigint,
  covenantHash: Hex,
  ply: number,
  seat: number,
  playBalanceHint: bigint,
  value: bigint = parseEther("0.1")
) {
  const wallet = getWalletClient(account);
  const pub = getPublicClient();
  const hash = await wallet.writeContract({
    address: covenantAddress(),
    abi: covenantAbi,
    functionName: "lockEarnest",
    args: [gameId, covenantHash, ply, seat, playBalanceHint],
    value,
    account,
    chain: wallet.chain,
  });
  await pub.waitForTransactionReceipt({ hash });
  return hash;
}

export async function lockPeaceOffer(
  account: Account,
  gameId: bigint,
  covenantHash: Hex,
  ply: number,
  seat: number,
  playBalanceHint: bigint,
  bribeAmount: bigint,
  plies: number
) {
  const wallet = getWalletClient(account);
  const pub = getPublicClient();
  // earnest 0.1 + optional premium 0.05 + bribe
  // Include 0.05 buffer so multi-offer premium never reverts
  const value = parseEther("0.1") + parseEther("0.05") + bribeAmount;
  const hash = await wallet.writeContract({
    address: covenantAddress(),
    abi: covenantAbi,
    functionName: "lockPeaceOffer",
    args: [gameId, covenantHash, ply, seat, playBalanceHint, bribeAmount, plies],
    value,
    account,
    chain: wallet.chain,
  });
  await pub.waitForTransactionReceipt({ hash });
  return hash;
}

export async function activateCovenant(
  account: Account,
  covenantHash: Hex,
  gameId: bigint,
  seatI: number,
  seatJ: number,
  clauses: number[],
  sigI: Hex,
  sigJ: Hex,
  value: bigint
) {
  const wallet = getWalletClient(account);
  const pub = getPublicClient();
  const hash = await wallet.writeContract({
    address: covenantAddress(),
    abi: covenantAbi,
    functionName: "activateCovenant",
    args: [covenantHash, gameId, seatI, seatJ, clauses, sigI, sigJ, "0x"],
    value,
    account,
    chain: wallet.chain,
  });
  await pub.waitForTransactionReceipt({ hash });
  return hash;
}

export async function challengeBetrayal(
  account: Account,
  covenantHash: Hex,
  betrayerSeat: number,
  clause: number,
  piece: number
) {
  const wallet = getWalletClient(account);
  const pub = getPublicClient();
  const hash = await wallet.writeContract({
    address: covenantAddress(),
    abi: covenantAbi,
    functionName: "challengeBetrayal",
    args: [covenantHash, betrayerSeat, clause, piece],
    account,
    chain: wallet.chain,
  });
  await pub.waitForTransactionReceipt({ hash });
  return hash;
}

export async function signCovenantHash(account: Account, covenantHash: Hex): Promise<Hex> {
  const wallet = getWalletClient(account);
  return wallet.signMessage({ account, message: { raw: covenantHash } });
}

export async function depositPlayBalance(account: Account, gameId: bigint, seat: number, amount: bigint) {
  const wallet = getWalletClient(account);
  const pub = getPublicClient();
  const hash = await wallet.writeContract({
    address: gameAddress(),
    abi: gameTableAbi,
    functionName: "depositPlayBalance",
    args: [gameId, seat],
    value: amount,
    account,
    chain: wallet.chain,
  });
  await pub.waitForTransactionReceipt({ hash });
  return hash;
}
