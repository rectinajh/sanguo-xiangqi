import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { parseEther, formatEther, type Account, type Hex } from "viem";
import { getPublicClient, getWalletClient, accountFromKey, ANVIL_KEYS, IS_LOCAL_DEMO, activeChain } from "./chain";

const STORAGE_KEY = "sanguo_ephemeral_v1";

export type SessionWallet = {
  privateKey: Hex;
  address: `0x${string}`;
  label: string;
};

export function loadOrCreateWallet(label: string): SessionWallet {
  const raw = localStorage.getItem(STORAGE_KEY);
  let map: Record<string, Hex> = {};
  if (raw) {
    try {
      map = JSON.parse(raw);
    } catch {
      map = {};
    }
  }
  if (!map[label]) {
    map[label] = generatePrivateKey();
    localStorage.setItem(STORAGE_KEY, JSON.stringify(map));
  }
  const account = privateKeyToAccount(map[label]);
  return { privateKey: map[label], address: account.address, label };
}

export function toAccount(w: SessionWallet): Account {
  return privateKeyToAccount(w.privateKey);
}

/**
 * 本地演示专用：从 Anvil 0 号账户"灌测币"。
 *
 * ⚠️ 这条路径用的是**公开已知的 Anvil 私钥**，只能对本地 Anvil 用。
 * 以前它没有任何链 ID 检查，一旦把 addresses.json 指向测试网，
 * UI 就会拿着公开私钥去真网络签名 —— 任何人打进去的钱都会被立刻转走。
 * 现在这里强制要求本地演示模式，否则直接抛错。
 */
export async function fundFromAnvil(to: `0x${string}`, amountMon = "5") {
  if (!IS_LOCAL_DEMO) {
    throw new Error(
      `拒绝从 Anvil 灌测币：当前链是 ${activeChain.name}(chainId ${activeChain.id})。` +
        `该功能只允许本地 Anvil(31337)。测试网请自行去水龙头领 MON。`
    );
  }
  const pub = getPublicClient();
  const actual = await pub.getChainId();
  if (actual !== 31337) {
    throw new Error(`拒绝从 Anvil 灌测币：RPC 实际返回 chainId ${actual}，不是 31337。`);
  }
  const faucet = accountFromKey(ANVIL_KEYS.faucet);
  const wallet = getWalletClient(faucet);
  const hash = await wallet.sendTransaction({
    to,
    value: parseEther(amountMon),
    account: faucet,
    chain: wallet.chain,
  });
  await pub.waitForTransactionReceipt({ hash });
  return hash;
}

export async function getBalance(addr: `0x${string}`) {
  const pub = getPublicClient();
  return pub.getBalance({ address: addr });
}

export { formatEther, parseEther };
