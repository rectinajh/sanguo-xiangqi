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
import { demoSpine, formatMon } from "@sanguo/shared";

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

  await send(deployer, gameAbi, table, "createGame", [2]);
  const id = gameId;
  for (const [account, seat] of [
    [humanA, 0],
    [humanB, 1],
    [ai, 2],
  ] as const) {
    await send(account, gameAbi, table, "join", [id, seat], parseEther("3"));
  }

  const spine = demoSpine();
  console.log("cheap", formatMon(spine.cheapFee), "chariot", formatMon(spine.chariotFee));
  const who = [humanA, humanB, ai] as const;
  let betrayHash: `0x${string}` | null = null;

  for (const m of spine.moves) {
    if (m.tag === "betray") {
      betrayHash = keccak256(encodePacked(["string", "uint256"], ["demo-cov", id]));
      await send(humanA, covAbi, covenant, "lockEarnest", [id, betrayHash, 0], parseEther("0.1"));
      const sig = async (account: typeof humanA) =>
        wallet(account).signMessage({ account, message: { raw: betrayHash! } });
      await send(ai, covAbi, covenant, "activateCovenant", [
        betrayHash,
        id,
        0,
        2,
        [1, 2],
        await sig(humanA),
        await sig(ai),
        "0x",
      ], parseEther("0.2"));
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
    await send(who[m.seat], gameAbi, table, "commitMove", [id, commit]);
    await send(who[m.seat], gameAbi, table, "revealMove", [id, m.from.x, m.from.y, m.to.x, m.to.y, m.piece, salt]);
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
