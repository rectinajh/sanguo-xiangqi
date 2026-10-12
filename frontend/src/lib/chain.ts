import {
  defineChain,
  createPublicClient,
  createWalletClient,
  custom,
  http,
  type Account,
  type EIP1193Provider,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import addressesLocal from "./addresses.json";

/**
 * 部署配置。优先级：
 *   1. Vite 环境变量（构建期注入，适合把测试网地址固化进产物）
 *   2. src/lib/addresses.json（deploy:local / deploy:testnet 写回的文件）
 *
 * 以前这里把 chainId 与 rpcUrl 硬编码在 addresses.json 里，导致
 * "改了 RPC 就要改源码"。现在两者都可以用环境变量覆盖：
 *   VITE_CHAIN_ID=10143
 *   VITE_RPC_URL=https://testnet-rpc.monad.xyz
 *   VITE_GAMETABLE=0x... VITE_COVENANT=0x... VITE_AGENTREGISTRY=0x... VITE_STUBVERIFIER=0x...
 */
type Addresses = {
  chainId: number;
  rpcUrl: string;
  StubVerifier: string;
  AgentRegistry: string;
  GameTable: string;
  Covenant: string;
};

function pickString(v: string | undefined, fallback: string): string {
  return v && v.length > 0 ? v : fallback;
}

export const addresses: Addresses = {
  chainId: Number(pickString(import.meta.env.VITE_CHAIN_ID, String(addressesLocal.chainId || 31337))),
  rpcUrl: pickString(import.meta.env.VITE_RPC_URL, addressesLocal.rpcUrl || "http://127.0.0.1:8545"),
  StubVerifier: pickString(import.meta.env.VITE_STUBVERIFIER, addressesLocal.StubVerifier),
  AgentRegistry: pickString(import.meta.env.VITE_AGENTREGISTRY, addressesLocal.AgentRegistry),
  GameTable: pickString(import.meta.env.VITE_GAMETABLE, addressesLocal.GameTable),
  Covenant: pickString(import.meta.env.VITE_COVENANT, addressesLocal.Covenant),
};

const chainId = addresses.chainId;

/** 本地演示模式：只有本地 Anvil 才允许使用内置的公开测试钥。 */
export const IS_LOCAL_DEMO = chainId === 31337;

export const activeChain = defineChain({
  id: chainId,
  name: chainId === 10143 ? "Monad Testnet" : chainId === 143 ? "Monad Mainnet" : "Anvil Local",
  nativeCurrency: { name: "MON", symbol: "MON", decimals: 18 },
  rpcUrls: { default: { http: [addresses.rpcUrl || "http://127.0.0.1:8545"] } },
  blockExplorers:
    chainId === 10143
      ? { default: { name: "Monad Testnet Explorer", url: "https://testnet.monadexplorer.com" } }
      : undefined,
});

export const rpcUrl = addresses.rpcUrl || "http://127.0.0.1:8545";

export function getPublicClient() {
  return createPublicClient({ chain: activeChain, transport: http(rpcUrl) });
}

/**
 * 签名者：本地演示用 viem 的 local account；真实玩家用浏览器钱包地址
 * （JsonRpcAccount）。两者都能直接传给 writeContract 的 account 参数。
 */
export type Signer = Account | `0x${string}`;

/** 读操作也可以走注入式钱包，但默认走 RPC —— 更快也更稳定。 */
export function getWalletClient(account: Account) {
  return createWalletClient({ account, chain: activeChain, transport: http(rpcUrl) });
}

/**
 * 不在客户端上绑定账户的写客户端（仅本地 Account + HTTP）。
 * 浏览器钱包请用 `getWriteWalletClient(address)`，走 EIP-1193。
 */
export function getSignerWalletClient() {
  return createWalletClient({ chain: activeChain, transport: http(rpcUrl) });
}

/**
 * 按签名者类型选写客户端：
 * - 本地 `Account`（含临时钥 / Anvil）→ HTTP transport
 * - 地址字符串（注入式钱包）→ `window.ethereum`（EIP-1193）
 */
export function getWriteWalletClient(account: Signer) {
  if (typeof account === "string") {
    return getInjectedWalletClient();
  }
  return createWalletClient({ account, chain: activeChain, transport: http(rpcUrl) });
}

/**
 * Anvil 默认私钥。**只允许在本地演示模式（chainId 31337）下使用。**
 * 这些钥在公网被大量人共用（实测 Anvil 0 号钥在 Monad 测试网 nonce 已达 468），
 * 一旦拿去公网，任何人打进去的钱都会被立刻转走。
 */
export const ANVIL_KEYS = {
  deployer: "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80" as const,
  ai: "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d" as const,
  faucet: "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80" as const,
};

export function accountFromKey(pk: `0x${string}`) {
  return privateKeyToAccount(pk);
}

// ── 注入式钱包（MetaMask 等 EIP-1193）────────────────────────────

type InjectedWindow = { ethereum?: EIP1193Provider & { isMetaMask?: boolean } };

export function getInjectedProvider(): EIP1193Provider | null {
  if (typeof window === "undefined") return null;
  const w = window as unknown as InjectedWindow;
  return w.ethereum ?? null;
}

export function hasInjectedWallet(): boolean {
  return getInjectedProvider() !== null;
}

/**
 * 用注入式钱包签名时，所有交易都走浏览器钱包，
 * 因此**绝不会**把私钥带进前端。
 */
export function getInjectedWalletClient() {
  const provider = getInjectedProvider();
  if (!provider) throw new Error("未检测到浏览器钱包（请安装 MetaMask 等）");
  return createWalletClient({ chain: activeChain, transport: custom(provider) });
}

/** 请求用户授权并返回其地址。 */
export async function requestInjectedAccount(): Promise<`0x${string}`> {
  const provider = getInjectedProvider();
  if (!provider) throw new Error("未检测到浏览器钱包（请安装 MetaMask 等）");
  const accounts = (await provider.request({ method: "eth_requestAccounts" })) as string[];
  if (!accounts || accounts.length === 0) throw new Error("钱包没有返回任何账户");
  return accounts[0] as `0x${string}`;
}

export async function getInjectedChainId(): Promise<number> {
  const provider = getInjectedProvider();
  if (!provider) throw new Error("未检测到浏览器钱包");
  const hex = (await provider.request({ method: "eth_chainId" })) as string;
  return Number.parseInt(hex, 16);
}

/**
 * 把钱包切到本应用期望的链；链不存在时先尝试添加。
 * 返回 true 表示切换后确实在目标链上。
 */
export async function ensureInjectedChain(): Promise<boolean> {
  const provider = getInjectedProvider();
  if (!provider) throw new Error("未检测到浏览器钱包");
  const current = await getInjectedChainId();
  if (current === chainId) return true;

  const hexChainId = `0x${chainId.toString(16)}`;
  try {
    await provider.request({ method: "wallet_switchEthereumChain", params: [{ chainId: hexChainId }] });
  } catch (err) {
    const code = (err as { code?: number }).code;
    // 4902 = 该链尚未添加到钱包，先添加再切
    if (code === 4902 || code === -32603) {
      await provider.request({
        method: "wallet_addEthereumChain",
        params: [
          {
            chainId: hexChainId,
            chainName: activeChain.name,
            nativeCurrency: activeChain.nativeCurrency,
            rpcUrls: [addresses.rpcUrl],
            blockExplorerUrls: activeChain.blockExplorers ? [activeChain.blockExplorers.default.url] : undefined,
          },
        ],
      });
      await provider.request({ method: "wallet_switchEthereumChain", params: [{ chainId: hexChainId }] });
    } else {
      throw err;
    }
  }
  return (await getInjectedChainId()) === chainId;
}

/** 真实的链 ID 校验：只证明"某个 RPC 应答了"是不够的。 */
export async function assertCorrectChain(): Promise<number> {
  const pub = getPublicClient();
  const actual = await pub.getChainId();
  if (actual !== chainId) {
    throw new Error(`RPC 返回的链 ID 是 ${actual}，但应用配置期望 ${chainId}（${activeChain.name}）`);
  }
  return actual;
}
