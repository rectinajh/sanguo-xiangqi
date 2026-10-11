import { defineChain, createPublicClient, createWalletClient, http, type Account } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import addresses from "./addresses.json";

const chainId = addresses.chainId || 31337;

export const activeChain = defineChain({
  id: chainId,
  name: chainId === 10143 ? "Monad Testnet" : "Anvil Local",
  nativeCurrency: { name: "MON", symbol: "MON", decimals: 18 },
  rpcUrls: { default: { http: [addresses.rpcUrl || "http://127.0.0.1:8545"] } },
});

export const rpcUrl = addresses.rpcUrl || "http://127.0.0.1:8545";

export function getPublicClient() {
  return createPublicClient({ chain: activeChain, transport: http(rpcUrl) });
}

export function getWalletClient(account: Account) {
  return createWalletClient({ account, chain: activeChain, transport: http(rpcUrl) });
}

/** Anvil default keys. Local demo only — never fund these on a public testnet. */
export const ANVIL_KEYS = {
  deployer: "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80" as const,
  ai: "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d" as const,
  faucet: "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80" as const,
};

export function accountFromKey(pk: `0x${string}`) {
  return privateKeyToAccount(pk);
}

export { addresses };
