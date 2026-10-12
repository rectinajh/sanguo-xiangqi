/**
 * Local Anvil replay of the 3-minute spine.
 * Prints transaction hashes. Refuses chainId 10143 so the public Anvil key is never used there.
 *
 *   pnpm anvil
 *   pnpm deploy:local
 *   pnpm demo
 */
import { readFileSync } from "node:fs";
import { createPublicClient, createWalletClient, defineChain, http, parseEther, keccak256, encodePacked, encodeAbiParameters } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { JOIN_VALUE, demoSpine, formatMon } from "@sanguo/shared";
const root = new URL("..", import.meta.url);
const addresses = JSON.parse(readFileSync(new URL("../frontend/src/lib/addresses.json", import.meta.url), "utf8"));
const gameAbi = JSON.parse(readFileSync(new URL("../frontend/src/abi/GameTable.json", import.meta.url), "utf8"));
const covAbi = JSON.parse(readFileSync(new URL("../frontend/src/abi/Covenant.json", import.meta.url), "utf8"));

const ANVIL = {
  deployer: "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80",
  humanB: "0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a",
  ai: "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d",
  humanA: "0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6",
} as const;

function chain() {
  return defineChain({
    id: addresses.chainId,
    name: addresses.chainId === 31337 ? "anvil" : "monad",
    nativeCurrency: { name: "MON", symbol: "MON", decimals: 18 },
    rpcUrls: { default: { http: [addresses.rpcUrl] } },
  });
}

async function main() {
  if (addresses.chainId !== 31337) {
    throw new Error("pnpm demo 只打本地 Anvil。10143 请用自己的私钥，不要用公开 Anvil 钥。");
  }
  if (!addresses.GameTable || !addresses.Covenant) throw new Error("缺少地址，先 pnpm deploy:local");

  const c = chain();
  const pub = createPublicClient({ chain: c, transport: http(addresses.rpcUrl) });
  await pub.getBlockNumber();
  const deployer = privateKeyToAccount(ANVIL.deployer);
  const humanA = privateKeyToAccount(ANVIL.humanA);
  const humanB = privateKeyToAccount(ANVIL.humanB);
  const ai = privateKeyToAccount(ANVIL.ai);
  const wallet = (account: typeof deployer) => createWalletClient({ account, chain: c, transport: http(addresses.rpcUrl) });

  async function send(account: typeof deployer, abi: unknown, address: `0x${string}`, functionName: string, args: unknown[], value?: bigint) {
    const hash = await wallet(account).writeContract({
      address,
      abi: abi as never,
      functionName,
      args,
      value,
      account,
      chain: c,
    });
    const receipt = await pub.waitForTransactionReceipt({ hash });
    console.log(functionName, hash, "status", receipt.status);
    return hash;
  }

  const table = addresses.GameTable as `0x${string}`;
  const covenant = addresses.Covenant as `0x${string}`;
  const gameId = (await pub.readContract({ address: table, abi: gameAbi, functionName: "nextGameId" })) as bigint;

  // AI 必须先注册：createGame() 不再写 aiSeat，join 时由 AgentRegistry 绑定卧底。
  const regAbi = JSON.parse(readFileSync(new URL("../frontend/src/abi/AgentRegistry.json", import.meta.url), "utf8"));
  try {
    await send(ai, regAbi, addresses.AgentRegistry as `0x${string}`, "registerAgent", ["sanguo://agent/mole-v1"]);
  } catch {
    console.log("registerAgent skipped (already registered)");
  }

  await send(deployer, gameAbi, table, "createGame", []);
  const id = gameId;
  for (const [account, seat] of [
    [humanA, 0],
    [humanB, 1],
    [ai, 2],
  ] as const) {
    await send(account, gameAbi, table, "join", [id, seat], JOIN_VALUE);
  }

  const spine = demoSpine();
  console.log("cheap", formatMon(spine.cheapFee), "chariot", formatMon(spine.chariotFee));
  const who = [humanA, humanB, ai] as const;
  let betrayHash: `0x${string}` | null = null;

  for (const m of spine.moves) {
    if (m.tag === "betray") {
      // 隔河图：导演把绿马挪到攻士位（与 demoSpine / Covenant harness 一致）。
      //
      // ⚠️ 必须幂等：上一次运行如果中途失败，马已经挪过去了；再无条件挪一次会
      //    撞上 "occ"（目标被占）。这里先读链上状态再决定要不要挪，
      //    也让脚本可以反复跑而不需要重建链。
      const target = m.from.x;
      const at = async (node: number) => {
        const [piece, seat] = (await pub.readContract({
          address: table,
          abi: gameAbi,
          functionName: "cell",
          args: [id, node, 0],
        })) as readonly [number, number];
        return { piece, seat: seat === 255 ? null : seat };
      };
      const dest = await at(target);
      if (dest.piece !== 0) {
        console.log(`  (攻士位 ${target} 已有子，跳过挪马)`);
      } else {
        // 找绿马当前所在节点（不写死 91：初始布局是 91，但可能已被上次运行挪走）
        let horseNode: number | null = null;
        for (let n = 0; n < 139; n++) {
          const c = await at(n);
          if (c.piece === 4 && c.seat === 2) {
            horseNode = n;
            break;
          }
        }
        if (horseNode === null) throw new Error("找不到绿马，无法把它挪到攻士位");
        await send(deployer, gameAbi, table, "directorRelocate", [id, horseNode, target]);
      }
      // 盟约条款与 bond 进入被签名的 preimage（链上会校验 hash 一致）
      const clauses = [1, 2];
      const bondAmount = parseEther("0.15") * BigInt(clauses.length);
      const earnestBond = parseEther("0.1");
      const zero = `0x${"00".repeat(32)}` as `0x${string}`;
      // ⚠️ 必须与 abi.encode(struct) 一致 => 外面再套一层 tuple。
      // 扁平展开会算出不同的 hash，导致 activateCovenant revert("pending")。
      const PREIMAGE_ABI = [
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
      const enc = (nonce: `0x${string}`) =>
        encodeAbiParameters(PREIMAGE_ABI, [
          { gameId: id, seatI: 0, seatJ: 2, clauses, bondAmount, earnestBond, nonce, validFromPly: 0, validToPly: 80 },
        ]);
      const nonce = keccak256(enc(zero));
      betrayHash = keccak256(enc(nonce));
      const preimageTuple = [id, 0, 2, clauses, bondAmount, earnestBond, nonce, 0, 80] as const;

      // 发起方红营锁诚意金
      await send(humanA, covAbi, covenant, "lockEarnest", [id, betrayHash, 0], earnestBond);

      const sig = async (account: typeof humanA) =>
        wallet(account).signMessage({ account, message: { raw: betrayHash! } });
      // 由 AI 激活：付自己那一半 + 替发起方补齐缺口
      const each = bondAmount / 2n;
      const proposerOwed = each > earnestBond ? each - earnestBond : 0n;
      await send(ai, covAbi, covenant, "activateCovenant", [
        preimageTuple,
        await sig(humanA),
        await sig(ai),
        "0x",
      ], proposerOwed + each);
    }
    const salt = keccak256(encodePacked(["string", "uint8", "uint8"], [m.tag, m.from.x, m.from.y]));
    const commit = keccak256(
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
        [m.seat, m.from.x, m.from.y, m.to.x, m.to.y, m.piece, salt]
      )
    );
    // 一步一签：commit + reveal 合并到一笔交易（合约的 commitAndRevealMove）。
    // 旧的两笔路径仍然可用，但每步要多签一次名，没有换来任何隐私 ——
    // revealMove 要求轮到本座，顺序走子下对手本来就看得到。
    await send(who[m.seat], gameAbi, table, "commitAndRevealMove", [
      id,
      m.from.x,
      m.from.y,
      m.to.x,
      m.to.y,
      m.piece,
      salt,
      commit,
    ]);
    if (m.tag === "betray" && betrayHash) {
      await send(humanA, covAbi, covenant, "challengeBetrayal", [betrayHash, 2, 1]);
    }
  }

  await send(deployer, gameAbi, table, "directorDrain", [id, 1, parseEther("5")]);
  await send(deployer, gameAbi, table, "directorDrain", [id, 2, parseEther("5")]);
  const motive = keccak256(encodePacked(["string"], ["harness motive"]));
  await send(deployer, gameAbi, table, "finalizeGame", [id, motive]);
  console.log("demo game", id.toString(), "done");
  void root;
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
