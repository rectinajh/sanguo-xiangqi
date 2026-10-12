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
import { NODE_COUNT, Piece, type BoardState, type Seat } from "@sanguo/shared";
import { addresses, getPublicClient, getWalletClient, getSignerWalletClient, type Signer } from "./chain";
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
  // 三个地址缺一不可：finalizeGame 会调用 AgentRegistry.recordGameResult，
  // 少了它会让整笔结算 revert，所有质押都会被锁死。
  return Boolean(addresses.GameTable && addresses.Covenant && addresses.AgentRegistry);
}

// ── 盟约 preimage ────────────────────────────────────────────────
// 链上 Covenant.hashPreimage(p) = keccak256(abi.encode(p))，字段顺序必须一致。
// 链下先用 nonce=0 算出哈希（用于锁诚意金与让双方签名），再把该哈希写回
// nonce 字段 —— 链上按同样的规则重建即可得到同一个 covenantHash。
export type CovenantPreimage = {
  gameId: bigint;
  seatI: number;
  seatJ: number;
  clauses: number[];
  bondAmount: bigint;
  earnestBond: bigint;
  nonce: Hex;
  validFromPly: number;
  validToPly: number;
};

// 必须与链上 Covenant.hashPreimage(p) = keccak256(abi.encode(p)) 完全一致。
// ⚠️ abi.encode(单个结构体) 等价于 encodeAbiParameters([tuple], [p])，
//    也就是【外面还要再套一层 tuple】。直接扁平展开参数会得到另一串字节
//    （实测 770 vs 正确 834 hex 字符），从而算出不同的 covenantHash，
//    表现为 activateCovenant revert("pending")。这条由
//    contracts/test/Preimage.t.sol 的跨语言哈希对照测试钉死。
const PREIMAGE_TUPLE_ABI = [
  {
    type: "tuple",
    components: [
      { name: "gameId", type: "uint256" },
      { name: "seatI", type: "uint8" },
      { name: "seatJ", type: "uint8" },
      { name: "clauses", type: "uint8[]" },
      { name: "bondAmount", type: "uint256" },
      { name: "earnestBond", type: "uint256" },
      { name: "nonce", type: "bytes32" },
      { name: "validFromPly", type: "uint32" },
      { name: "validToPly", type: "uint32" },
    ],
  },
] as const;

export function encodePreimage(p: CovenantPreimage): Hex {
  return encodeAbiParameters(PREIMAGE_TUPLE_ABI, [
    {
      gameId: p.gameId,
      seatI: p.seatI,
      seatJ: p.seatJ,
      clauses: p.clauses,
      bondAmount: p.bondAmount,
      earnestBond: p.earnestBond,
      nonce: p.nonce,
      validFromPly: p.validFromPly,
      validToPly: p.validToPly,
    },
  ]);
}

function preimageFromTuple(t: readonly [
  bigint,
  number,
  number,
  readonly number[],
  bigint,
  bigint,
  Hex,
  number,
  number,
]): CovenantPreimage {
  return {
    gameId: t[0],
    seatI: Number(t[1]),
    seatJ: Number(t[2]),
    clauses: [...t[3]],
    bondAmount: t[4],
    earnestBond: t[5],
    nonce: t[6],
    validFromPly: Number(t[7]),
    validToPly: Number(t[8]),
  };
}

/** 构造 preimage 并算出 covenantHash（nonce 已写回）。 */
export function buildPreimage(args: {
  gameId: bigint;
  seatI: number;
  seatJ: number;
  clauses: number[];
  bondAmount: bigint;
  earnestBond?: bigint;
  validFromPly?: number;
  validToPly?: number;
}): { preimage: CovenantPreimage; hash: Hex } {
  const zero = `0x${"00".repeat(32)}` as Hex;
  const base: CovenantPreimage = {
    gameId: args.gameId,
    seatI: args.seatI,
    seatJ: args.seatJ,
    clauses: args.clauses,
    bondAmount: args.bondAmount,
    earnestBond: args.earnestBond ?? parseEther("0.1"),
    nonce: zero,
    validFromPly: args.validFromPly ?? 0,
    validToPly: args.validToPly ?? 80,
  };
  const h0 = keccak256(encodePreimage(base));
  const preimage = { ...base, nonce: h0 };
  return { preimage, hash: keccak256(encodePreimage(preimage)) };
}

/** activateCovenant 需要 calldata 形态的 preimage（数组要可变）。 */
function toCalldata(p: CovenantPreimage) {
  return [p.gameId, p.seatI, p.seatJ, p.clauses, p.bondAmount, p.earnestBond, p.nonce, p.validFromPly, p.validToPly] as const;
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

export async function createGame(account: Signer, aiSeat: number) {
  const wallet = getSignerWalletClient();
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

export async function joinGame(account: Signer, gameId: bigint, seat: number, value = parseEther("3")) {
  const wallet = getSignerWalletClient();
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

/**
 * 放弃一个卡住的大厅局，让已入座的人把钱取回去。
 *
 * 合约侧有两种放行条件：所有已入座者都投过票，或大厅闲置超过
 * LOBBY_ABANDON_TIMEOUT。第一次调用只是投票，不一定会立即生效 ——
 * 调用方应读 abandonStatusOf 判断还差几票。
 */
export async function abandonGame(account: Signer, gameId: bigint) {
  const wallet = getSignerWalletClient();
  const pub = getPublicClient();
  const hash = await wallet.writeContract({
    address: gameAddress(),
    abi: gameTableAbi,
    functionName: "abandonGame",
    args: [gameId],
    account,
    chain: wallet.chain,
  });
  await pub.waitForTransactionReceipt({ hash });
  return hash;
}

/** 取回被放弃大厅局里的钱。 */
export async function claimAbandonRefund(account: Signer, gameId: bigint) {
  const wallet = getSignerWalletClient();
  const pub = getPublicClient();
  const hash = await wallet.writeContract({
    address: gameAddress(),
    abi: gameTableAbi,
    functionName: "claimAbandonRefund",
    args: [gameId],
    account,
    chain: wallet.chain,
  });
  const r = await pub.waitForTransactionReceipt({ hash });
  return { hash, status: r.status };
}

/** 放弃投票状态：位图、是否可超时强制放弃、我这座能领多少。 */
export async function abandonStatusOf(
  gameId: bigint,
  who: `0x${string}`
): Promise<{ votes: number; canForceByTimeout: boolean; claimable: bigint }> {
  const pub = getPublicClient();
  const [votes, canForceByTimeout, claimable] = (await pub.readContract({
    address: gameAddress(),
    abi: gameTableAbi,
    functionName: "abandonStatusOf",
    args: [gameId],
    account: who,
  })) as readonly [number, boolean, bigint];
  return { votes: Number(votes), canForceByTimeout, claimable };
}

export async function commitAndReveal(
  account: Signer,
  gameId: bigint,
  seat: number,
  from: { x: number; y: number },
  to: { x: number; y: number },
  piece: number
) {
  const salt = keccak256(encodePacked(["string", "uint256"], [`salt-${Date.now()}`, BigInt(Math.floor(Math.random() * 1e9))]));
  const ch = moveCommitHash(seat, from.x, from.y, to.x, to.y, piece, salt);
  const wallet = getSignerWalletClient();
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

export async function readBoard(gameId: bigint): Promise<BoardState> {
  const pub = getPublicClient();
  // Fresh Anvil has no Multicall3. Read each node: cell(gameId, nodeId, 0).
  const packed = await Promise.all(
    Array.from({ length: NODE_COUNT }, (_, node) =>
      pub.readContract({
        address: gameAddress(),
        abi: gameTableAbi,
        functionName: "cell",
        args: [gameId, node, 0],
      }) as Promise<readonly [number, number]>
    )
  );
  const meta = await readMeta(gameId);
  const seatViews = await Promise.all([0, 1, 2].map((s) => readSeat(gameId, s)));
  const cells: BoardState["cells"] = packed.map(([piece, seatOr255]) => ({
    piece: piece as Piece,
    seat: seatOr255 === 255 ? null : (seatOr255 as Seat),
  }));
  return {
    cells,
    turn: meta.turn,
    eliminated: seatViews.map((s) => s.eliminated),
    ply: meta.ply,
  };
}

export async function feesPaidOf(gameId: bigint, seat: number) {
  const pub = getPublicClient();
  return (await pub.readContract({
    address: gameAddress(),
    abi: gameTableAbi,
    functionName: "feesPaidOf",
    args: [gameId, seat],
  })) as bigint;
}

export async function seatWasSlashed(gameId: bigint, seat: number) {
  const pub = getPublicClient();
  return (await pub.readContract({
    address: gameAddress(),
    abi: gameTableAbi,
    functionName: "seatWasSlashed",
    args: [gameId, seat],
  })) as boolean;
}

export async function readReputation(agent: `0x${string}`) {
  const pub = getPublicClient();
  const raw = await pub.readContract({
    address: registryAddress(),
    abi: registryAbi,
    functionName: "getReputation",
    args: [agent],
  });
  const r = raw as {
    games: number;
    wins: number;
    slashed: number;
    betrayalIndex: number;
    trustScore: number;
    forcedBurnMonTotal: bigint;
    registered: boolean;
    metadataURI: string;
  } & readonly [number, number, number, number, number, bigint, boolean, string];
  if (r && typeof r === "object" && "trustScore" in r) return r;
  const tuple = raw as readonly [number, number, number, number, number, bigint, boolean, string];
  return {
    games: tuple[0],
    wins: tuple[1],
    slashed: tuple[2],
    betrayalIndex: tuple[3],
    trustScore: tuple[4],
    forcedBurnMonTotal: tuple[5],
    registered: tuple[6],
    metadataURI: tuple[7],
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

export async function directorDrain(account: Signer, gameId: bigint, seat: number, amount: bigint) {
  const wallet = getSignerWalletClient();
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

export async function finalizeGame(account: Signer, gameId: bigint, motiveHash: Hex) {
  const wallet = getSignerWalletClient();
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
  account: Signer,
  gameId: bigint,
  covenantHash: Hex,
  seat: number,
  value: bigint = parseEther("0.1")
) {
  const wallet = getSignerWalletClient();
  const pub = getPublicClient();
  const hash = await wallet.writeContract({
    address: covenantAddress(),
    abi: covenantAbi,
    functionName: "lockEarnest",
    args: [gameId, covenantHash, seat],
    value,
    account,
    chain: wallet.chain,
  });
  await pub.waitForTransactionReceipt({ hash });
  return hash;
}

export async function lockPeaceOffer(
  account: Signer,
  gameId: bigint,
  covenantHash: Hex,
  seat: number,
  bribeAmount: bigint,
  plies: number
) {
  const wallet = getSignerWalletClient();
  const pub = getPublicClient();
  const value = parseEther("0.1") + parseEther("0.05") + bribeAmount;
  const hash = await wallet.writeContract({
    address: covenantAddress(),
    abi: covenantAbi,
    functionName: "lockPeaceOffer",
    args: [gameId, covenantHash, seat, bribeAmount, plies],
    value,
    account,
    chain: wallet.chain,
  });
  await pub.waitForTransactionReceipt({ hash });
  return hash;
}

export async function activateCovenant(
  account: Signer,
  preimage: CovenantPreimage,
  sigI: Hex,
  sigJ: Hex,
  value: bigint
) {
  const wallet = getSignerWalletClient();
  const pub = getPublicClient();
  const hash = await wallet.writeContract({
    address: covenantAddress(),
    abi: covenantAbi,
    functionName: "activateCovenant",
    args: [toCalldata(preimage), sigI, sigJ, "0x"],
    value,
    account,
    chain: wallet.chain,
  });
  await pub.waitForTransactionReceipt({ hash });
  return hash;
}

/** 激活一个盟约还差多少钱（当前调用者视角）。 */
export async function outstandingBondFor(preimage: CovenantPreimage, caller: `0x${string}`) {
  const pub = getPublicClient();
  const [proposer] = (await pub.readContract({
    address: covenantAddress(),
    abi: covenantAbi,
    functionName: "partiesOfHash",
    args: [keccak256(encodePreimage(preimage))],
    account: caller,
  })) as readonly [string, string];
  const each = preimage.bondAmount / 2n;
  const proposerOwed = each > preimage.earnestBond ? each - preimage.earnestBond : 0n;
  return caller.toLowerCase() === proposer.toLowerCase() ? proposerOwed : proposerOwed + each;
}

/** 当事人自查：我这个座位有没有生效盟约（第三方读不到）。 */
export async function partiesOfHash(hash: Hex, caller: `0x${string}`) {
  const pub = getPublicClient();
  return (await pub.readContract({
    address: covenantAddress(),
    abi: covenantAbi,
    functionName: "partiesOfHash",
    args: [hash],
    account: caller,
  })) as readonly [string, string];
}

export async function hasActive(gameId: bigint, seat: number) {
  const pub = getPublicClient();
  return (await pub.readContract({
    address: covenantAddress(),
    abi: covenantAbi,
    functionName: "hasActive",
    args: [gameId, seat],
  })) as boolean;
}

export async function clausesOf(hash: Hex): Promise<number[]> {
  const pub = getPublicClient();
  const raw = (await pub.readContract({
    address: covenantAddress(),
    abi: covenantAbi,
    functionName: "clausesOf",
    args: [hash],
  })) as readonly number[];
  return raw.map(Number);
}

export async function activatedPlyOf(hash: Hex) {
  const pub = getPublicClient();
  return Number(
    (await pub.readContract({
      address: covenantAddress(),
      abi: covenantAbi,
      functionName: "activatedPlyOf",
      args: [hash],
    })) as number
  );
}

export async function withdrawTreasury(account: Signer, gameId: bigint, to: `0x${string}`, amount: bigint) {
  const wallet = getSignerWalletClient();
  const pub = getPublicClient();
  const hash = await wallet.writeContract({
    address: gameAddress(),
    abi: gameTableAbi,
    functionName: "withdrawTreasury",
    args: [gameId, to, amount],
    account,
    chain: wallet.chain,
  });
  await pub.waitForTransactionReceipt({ hash });
  return hash;
}

export async function protocolTreasuryOf(gameId: bigint) {
  const pub = getPublicClient();
  return (await pub.readContract({
    address: gameAddress(),
    abi: gameTableAbi,
    functionName: "protocolTreasuryOf",
    args: [gameId],
  })) as bigint;
}

/** AI 座位注册声誉身份；只有注册过的地址才写得进战绩。 */
export async function registerAgent(account: Signer, metadataURI: string) {
  const wallet = getSignerWalletClient();
  const pub = getPublicClient();
  const hash = await wallet.writeContract({
    address: registryAddress(),
    abi: registryAbi,
    functionName: "registerAgent",
    args: [metadataURI],
    account,
    chain: wallet.chain,
  });
  await pub.waitForTransactionReceipt({ hash });
  return hash;
}

export async function challengeBetrayal(
  account: Signer,
  covenantHash: Hex,
  betrayerSeat: number,
  clause: number
) {
  const wallet = getSignerWalletClient();
  const pub = getPublicClient();
  const hash = await wallet.writeContract({
    address: covenantAddress(),
    abi: covenantAbi,
    functionName: "challengeBetrayal",
    args: [covenantHash, betrayerSeat, clause],
    account,
    chain: wallet.chain,
  });
  await pub.waitForTransactionReceipt({ hash });
  return hash;
}

export async function signCovenantHash(account: Signer, covenantHash: Hex): Promise<Hex> {
  const wallet = getSignerWalletClient();
  // 浏览器钱包也能对 raw bytes 做 personal_sign，所以本地钥与注入式钱包通用
  return wallet.signMessage({ account, message: { raw: covenantHash } });
}

export async function depositPlayBalance(account: Signer, gameId: bigint, seat: number, amount: bigint) {
  const wallet = getSignerWalletClient();
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
