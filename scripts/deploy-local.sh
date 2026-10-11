#!/usr/bin/env bash
# 部署到本地 Anvil，并把地址写回 frontend/src/lib/addresses.json。
#
# 注意：本脚本【会改写受版本控制的】frontend/src/lib/addresses.json —— 这是
#      有意为之（前端靠它找到本地合约），跑完 git status 会变脏。
#
# 幂等性：在【已经部署过】的 anvil 上重跑会撞 CreateCollision，并留下半截
#        广播。所以这里默认先检查链上是否已有可用部署，有就直接复用。
#        想强制重来：FORCE_REDEPLOY=1 pnpm deploy:local
set -euo pipefail
export PATH="$HOME/.foundry/bin:$PATH"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT/contracts"
RPC="${RPC_URL:-http://127.0.0.1:8545}"
PK="${PRIVATE_KEY:-0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80}"

write_addresses() {
  python3 - "$1" << 'PY'
import json, os, sys
root = os.environ["SANGUO_ROOT"]
out = json.loads(sys.argv[1])
path = os.path.join(root, "frontend/src/lib/addresses.json")
os.makedirs(os.path.dirname(path), exist_ok=True)
json.dump(out, open(path, "w"), indent=2)
print("Wrote", path)
print(json.dumps(out, indent=2))
PY
}
export SANGUO_ROOT="$ROOT"

if ! ACTUAL_CHAIN_ID="$(cast chain-id --rpc-url "$RPC" 2>/dev/null)"; then
  echo "无法连接 RPC $RPC —— 请先启动 pnpm anvil。"
  exit 1
fi
echo "==> RPC $RPC 链 ID $ACTUAL_CHAIN_ID"

# ── 幂等检查：已有部署且代码仍在链上 → 直接复用 ────────────────
if [[ "${FORCE_REDEPLOY:-0}" != "1" ]]; then
  LATEST="$(ls -t "$ROOT"/contracts/broadcast/Deploy.s.sol/"$ACTUAL_CHAIN_ID"/run-latest.json 2>/dev/null | head -1 || true)"
  if [[ -n "$LATEST" ]]; then
    REUSE="$(python3 - "$LATEST" << 'PY'
import json, sys
d = json.load(open(sys.argv[1]))
addrs, ok = {}, True
for tx in d.get("transactions", []):
    n, ca, h = tx.get("contractName") or "", tx.get("contractAddress"), tx.get("hash")
    if n and ca:
        addrs[n] = ca
    if not h:
        ok = False
# 半截广播（有交易没 hash）或没有 GameTable 都不复用
print(json.dumps(addrs) if (ok and addrs.get("GameTable")) else "")
PY
)"
    if [[ -n "$REUSE" ]]; then
      GT="$(python3 -c "import json,sys; print(json.loads(sys.argv[1]).get('GameTable',''))" "$REUSE")"
      CODE="$(cast code "$GT" --rpc-url "$RPC" 2>/dev/null || echo "0x")"
      if [[ -n "$CODE" && "$CODE" != "0x" ]]; then
        OUT="$(SANGUO_REUSE="$REUSE" SANGUO_CHAIN="$ACTUAL_CHAIN_ID" SANGUO_RPC="$RPC" python3 << 'PY'
import json, os
a = json.loads(os.environ["SANGUO_REUSE"])
print(json.dumps({
  "chainId": int(os.environ["SANGUO_CHAIN"]),
  "rpcUrl": os.environ["SANGUO_RPC"],
  "StubVerifier": a.get("StubVerifier", ""),
  "AgentRegistry": a.get("AgentRegistry", ""),
  "GameTable": a.get("GameTable", ""),
  "Covenant": a.get("Covenant", ""),
}))
PY
)"
        echo "==> 本链已有部署且代码仍在链上，直接复用（不重复广播）。"
        echo "    强制重新部署：FORCE_REDEPLOY=1 pnpm deploy:local"
        write_addresses "$OUT"
        echo "==> Deploy skipped (reused)."
        exit 0
      fi
      echo "==> 有旧产物但链上没有代码（anvil 大概重启过），重新部署。"
    fi
  fi
fi

echo "==> Deploying to $RPC"
forge script script/Deploy.s.sol:Deploy --rpc-url "$RPC" --broadcast --private-key "$PK" -vv

SANGUO_CHAIN="$ACTUAL_CHAIN_ID" SANGUO_RPC="$RPC" python3 << 'PY'
import json, glob, os, sys
root = os.environ["SANGUO_ROOT"]
chain = os.environ["SANGUO_CHAIN"]
paths = sorted(glob.glob(os.path.join(root, "contracts/broadcast/Deploy.s.sol", chain, "run-latest.json")), reverse=True)
if not paths:
    raise SystemExit("no broadcast file for chain " + chain)
data = json.load(open(paths[0]))

addrs, empties = {}, []
for tx in data.get("transactions", []):
    name, ca, h = tx.get("contractName") or "", tx.get("contractAddress"), tx.get("hash")
    if name and ca:
        addrs[name] = ca
    if not h:
        empties.append(name or "?")
if empties:
    raise SystemExit("这些交易没有 hash，广播未真正完成：" + ",".join(empties))

out = {
  "chainId": int(chain),
  "rpcUrl": os.environ["SANGUO_RPC"],
  "StubVerifier": addrs.get("StubVerifier", ""),
  "AgentRegistry": addrs.get("AgentRegistry", ""),
  "GameTable": addrs.get("GameTable", ""),
  "Covenant": addrs.get("Covenant", ""),
}
missing = [k for k, v in out.items() if k[0].isupper() and not v]
if missing:
    raise SystemExit("missing " + ",".join(missing))

path = os.path.join(root, "frontend/src/lib/addresses.json")
os.makedirs(os.path.dirname(path), exist_ok=True)
json.dump(out, open(path, "w"), indent=2)
print("Wrote", path)
print(json.dumps(out, indent=2))
PY
echo "==> Deploy done"
