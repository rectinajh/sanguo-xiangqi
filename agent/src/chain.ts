/**
 * chain.ts —— agent 侧的链访问层。
 *
 * 与前端不同：这里用**自己的私钥**（AGENT_KEY）签名，绝不接触任何玩家私钥。
 * ABI 直接复用 frontend/src/abi（deploy 脚本已保证与编译产物同步）。
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import {
  createPublicClient,
  createWalletClient,
  defineChain,
  http,
  type Abi,
  type Account,
  type Hex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "../..");

function loadAbi(name: string): Abi {
  const p = path.join(repoRoot, "frontend/src/abi", `${name}.json`);
  return JSON.parse(readFileSync(p, "utf8")) as Abi;
}

export const ABIS = {
  GameTable: loadAbi("GameTable"),
  Covenant: loadAbi("Covenant"),
  AgentRegistry: loadAbi("AgentRegistry"),
} as const;

export type AgentConfig = {
  rpcUrl: string;
  chainId: number;
  agentKey: Hex;
  addresses: {
    GameTable: Hex;
    Covenant: Hex;
    AgentRegistry: Hex;
    StubVerifier?: Hex;
  };
  /** 要坐的座位；默认 2（与前端 Demo 一致） */
  seat: number;
  /** 盟约履约多少手之后背刺 */
  betrayalAfterPlies: number;
  /** 轮询间隔（毫秒） */
  pollMs: number;
  /** 只服务这一个 gameId；不填则自动接管所有需要 AI 的局 */
  gameId?: bigint;
};

export function loadConfig(): AgentConfig {
  const env = process.env;
  const addrFile = path.join(repoRoot, "frontend/src/lib/addresses.json");
  const fileAddrs = JSON.parse(readFileSync(addrFile, "utf8")) as Record<string, string>;

  const rpcUrl = env.RPC_URL ?? env.MONAD_RPC ?? fileAddrs.rpcUrl ?? "http://127.0.0.1:8545";
  const chainId = Number(env.CHAIN_ID ?? fileAddrs.chainId ?? 31337);

  const agentKey = env.AGENT_KEY as Hex | undefined;
  if (!agentKey || !/^0x[0-9a-fA-F]{64}$/.test(agentKey)) {
    throw new Error(
      "缺少 AGENT_KEY（AI 自己的私钥）。\n" +
        "  本地演示：可使用 Anvil 1 号钥 0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d\n" +
        "  公网：必须是只有你持有的独立钥，且**不要**和玩家/部署者共用。"
    );
  }

  // 拒绝所有公开已知的 Anvil 测试钥在非本地链上使用
  const PUBLIC_KEYS = new Set([
    "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80",
    "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d",
    "0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a",
    "0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6",
  ]);
  if (chainId !== 31337 && PUBLIC_KEYS.has(agentKey.toLowerCase())) {
    throw new Error(
      `拒绝启动：chainId ${chainId} 不是本地链，但 AGENT_KEY 是公开已知的 Anvil 测试钥。\n` +
        "任何人拿到它都能转走 AI 座位质押的钱。请换成只有你持有的钥。"
    );
  }

  // 地址来源：优先 VITE_* 显式覆盖，否则用 deploy 脚本写回的 addresses.json。
  // 注意不能把整个 process.env 合并进来 —— 环境里任何同名键都会污染配置。
  const pick = (envKey: string, fileKey: string) => {
    const v = env[envKey];
    return (v && v.length > 0 ? v : fileAddrs[fileKey] ?? "") as string;
  };

  const addresses = {
    GameTable: pick("VITE_GAMETABLE", "GameTable") as Hex,
    Covenant: pick("VITE_COVENANT", "Covenant") as Hex,
    AgentRegistry: pick("VITE_AGENTREGISTRY", "AgentRegistry") as Hex,
    StubVerifier: pick("VITE_STUBVERIFIER", "StubVerifier") as Hex,
  };
  for (const [k, v] of Object.entries(addresses)) {
    if (k !== "StubVerifier" && (!v || !/^0x[0-9a-fA-F]{40}$/.test(v))) {
      throw new Error(`合约地址无效：${k} = ${v || "(空)"}。先跑 pnpm deploy:local 或配置 VITE_* 环境变量。`);
    }
  }

  return {
    rpcUrl,
    chainId,
    agentKey,
    addresses,
    seat: Number(env.AGENT_SEAT ?? 2),
    betrayalAfterPlies: Number(env.BETRAYAL_AFTER_PLIES ?? 10),
    pollMs: Number(env.AGENT_POLL_MS ?? 1500),
    gameId: env.GAME_ID ? BigInt(env.GAME_ID) : undefined,
  };
}

export function makeClients(cfg: AgentConfig) {
  const chain = defineChain({
    id: cfg.chainId,
    name: cfg.chainId === 10143 ? "Monad Testnet" : "Anvil Local",
    nativeCurrency: { name: "MON", symbol: "MON", decimals: 18 },
    rpcUrls: { default: { http: [cfg.rpcUrl] } },
  });
  const account: Account = privateKeyToAccount(cfg.agentKey);
  const pub = createPublicClient({ chain, transport: http(cfg.rpcUrl) });
  const wallet = createWalletClient({ account, chain, transport: http(cfg.rpcUrl) });
  return { chain, account, pub, wallet };
}
