#!/usr/bin/env bash
# Broadcast to Monad testnet only when MONAD_RPC is set and the deployer has balance.
# Does not invent addresses or transaction hashes.
set -euo pipefail
export PATH="$HOME/.foundry/bin:$PATH"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT/contracts"

if [[ -f "$ROOT/.env" ]]; then
  set -a
  # shellcheck disable=SC1091
  source "$ROOT/.env"
  set +a
fi

RPC="${MONAD_RPC:-}"
PK="${PRIVATE_KEY:-}"
if [[ -z "$RPC" || -z "$PK" ]]; then
  echo "未广播：需要环境变量 MONAD_RPC 和 PRIVATE_KEY（有测试网余额的部署钥）。"
  echo "命令：MONAD_RPC=... PRIVATE_KEY=... pnpm deploy:testnet"
  exit 1
fi

BAL="$(cast balance --rpc-url "$RPC" "$(cast wallet address --private-key "$PK")")"
if [[ "$BAL" == "0" ]]; then
  echo "未广播：部署地址余额为 0。先从水龙头领 MON，再重试。"
  exit 1
fi

echo "==> Deploying to Monad testnet $RPC"
forge script script/Deploy.s.sol:Deploy --rpc-url "$RPC" --broadcast --private-key "$PK" --chain 10143 -vv

python3 << PY
import json, glob, os
root = "$ROOT"
paths = sorted(glob.glob(root + "/contracts/broadcast/Deploy.s.sol/10143/run-latest.json"), reverse=True)
if not paths:
    raise SystemExit("no 10143 broadcast file")
data = json.load(open(paths[0]))
addrs = {}
txs = []
for tx in data.get("transactions", []):
    name = tx.get("contractName") or ""
    ca = tx.get("contractAddress")
    h = tx.get("hash")
    if name and ca:
        addrs[name] = ca
    if h:
        txs.append(h)
out = {
  "chainId": 10143,
  "rpcUrl": "$RPC",
  "StubVerifier": addrs.get("StubVerifier", ""),
  "AgentRegistry": addrs.get("AgentRegistry", ""),
  "GameTable": addrs.get("GameTable", ""),
  "Covenant": addrs.get("Covenant", ""),
}
path = root + "/frontend/src/lib/addresses.json"
json.dump(out, open(path, "w"), indent=2)
print("Wrote", path)
print(json.dumps(out, indent=2))
print("txs")
for h in txs[:3]:
    print(h)
missing = [k for k,v in out.items() if k[0].isupper() and not v]
if missing:
    raise SystemExit("missing " + ",".join(missing))
PY
echo "==> Testnet deploy done. Paste the addresses and the tx hashes above into README."
