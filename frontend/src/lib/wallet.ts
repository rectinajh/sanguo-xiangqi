import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { parseEther, formatEther, type Account, type Hex } from "viem";
import { getPublicClient, getWalletClient, accountFromKey, ANVIL_KEYS } from "./chain";

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

export async function fundFromAnvil(to: `0x${string}`, amountMon = "5") {
  const faucet = accountFromKey(ANVIL_KEYS.faucet);
  const wallet = getWalletClient(faucet);
  const hash = await wallet.sendTransaction({
    to,
    value: parseEther(amountMon),
    account: faucet,
    chain: wallet.chain,
  });
  const pub = getPublicClient();
  await pub.waitForTransactionReceipt({ hash });
  return hash;
}

export async function getBalance(addr: `0x${string}`) {
  const pub = getPublicClient();
  return pub.getBalance({ address: addr });
}

export { formatEther, parseEther };
