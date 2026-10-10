#!/usr/bin/env bash
set -euo pipefail
export PATH="$HOME/.foundry/bin:$PATH"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT/contracts"
RPC="${RPC_URL:-http://127.0.0.1:8545}"
PK="${PRIVATE_KEY:-0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80}"

echo "==> Deploying to $RPC"
forge script script/Deploy.s.sol:Deploy --rpc-url "$RPC" --broadcast --private-key "$PK" -vv

python3 << PY
import json, glob, os
root = "$ROOT"
paths = sorted(glob.glob(root + "/contracts/broadcast/Deploy.s.sol/*/run-latest.json"), reverse=True)
addrs = {}
if not paths:
    raise SystemExit("no broadcast file")
data = json.load(open(paths[0]))
for tx in data.get("transactions", []):
    name = tx.get("contractName") or ""
    ca = tx.get("contractAddress")
    if name and ca:
        addrs[name] = ca
out = {
  "chainId": 31337,
  "rpcUrl": "$RPC",
  "StubVerifier": addrs.get("StubVerifier", ""),
  "AgentRegistry": addrs.get("AgentRegistry", ""),
  "GameTable": addrs.get("GameTable", ""),
  "Covenant": addrs.get("Covenant", ""),
}
path = root + "/frontend/src/lib/addresses.json"
os.makedirs(os.path.dirname(path), exist_ok=True)
json.dump(out, open(path, "w"), indent=2)
print("Wrote", path)
print(json.dumps(out, indent=2))
missing = [k for k,v in out.items() if k[0].isupper() and not v]
if missing:
    raise SystemExit("missing " + ",".join(missing))
PY
echo "==> Deploy done"
