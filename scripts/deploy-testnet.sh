#!/usr/bin/env bash
# 广播到 Monad 测试网 10143。只在 MONAD_RPC 可达、链 ID 正确、部署钥有余额时才会广播。
# 不编造地址，也不编造交易哈希。
#
# 安全约束（每一条都对应一次真实的坑）：
#   1. .env 只用于【补缺】，绝不覆盖调用者显式传入的变量。
#   2. 广播前必须断言 RPC 的链 ID 就是 10143。
#   3. 拒绝所有公开已知的 Anvil 测试钥作为部署钥。
#   4. 绝不覆盖本地演示用的 addresses.json（测试网地址写独立文件）。
set -euo pipefail

# forge 的 code_size_limit 也约束部署脚本合约自身（Deploy.s.sol 约 39 KB），
# 而生产合约都远小于此。这里放宽给脚本用；真实链上限制由 Monad 决定
# （实测允许 ≥50 KB runtime），生产合约尺寸由 `pnpm size` 校验。
export FOUNDRY_CODE_SIZE_LIMIT="${FOUNDRY_CODE_SIZE_LIMIT:-100000}"
export PATH="$HOME/.foundry/bin:$PATH"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT/contracts"

TARGET_CHAIN_ID=10143

# ── 1. 载入 .env，但【不覆盖】已经显式设置好的变量 ──────────────
# 老版本这里是直接 `source .env`，会把调用者传入的 MONAD_RPC 静默
# 覆盖成 .env 里的值。实测这导致过一次向真实 Monad 测试网广播。
if [[ -f "$ROOT/.env" ]]; then
  _keep_rpc="${MONAD_RPC:-}"
  _keep_pk="${PRIVATE_KEY:-}"
  set -a
  # shellcheck disable=SC1091
  source "$ROOT/.env"
  set +a
  # 显式传入的值优先级最高，还原回去
  [[ -n "$_keep_rpc" ]] && MONAD_RPC="$_keep_rpc"
  [[ -n "$_keep_pk" ]] && PRIVATE_KEY="$_keep_pk"
  unset _keep_rpc _keep_pk
fi

RPC="${MONAD_RPC:-}"
PK="${PRIVATE_KEY:-}"
if [[ -z "$RPC" || -z "$PK" ]]; then
  echo "未广播：需要环境变量 MONAD_RPC 和 PRIVATE_KEY（有测试网余额的部署钥）。"
  echo "命令：MONAD_RPC=... PRIVATE_KEY=... pnpm deploy:testnet"
  exit 1
fi

# ── 2. 拒绝公开已知的 Anvil 测试钥 ────────────────────────────
# 这些钥写在无数教程里，在公网被大量人共用（实测 Anvil 0 号钥在
# Monad 测试网的 nonce 已达 468）。往里打钱等于送给别人。
KNOWN_PUBLIC_KEYS=(
  "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80"
  "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d"
  "0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a"
  "0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6"
)
PK_LC="$(echo "$PK" | tr '[:upper:]' '[:lower:]')"
for k in "${KNOWN_PUBLIC_KEYS[@]}"; do
  if [[ "$PK_LC" == "$k" ]]; then
    echo "拒绝广播：这是一把公开已知的 Anvil 测试钥（${k:0:10}…）。"
    echo "任何人拿到它都能转走你打进去的钱。请新建一把只有你持有的钥。"
    exit 1
  fi
done

# ── 3. 断言链 ID ─────────────────────────────────────────────
if ! ACTUAL_CHAIN_ID="$(cast chain-id --rpc-url "$RPC" 2>/dev/null)"; then
  echo "未广播：无法连接 RPC $RPC（cast chain-id 失败）。"
  exit 1
fi
if [[ "$ACTUAL_CHAIN_ID" != "$TARGET_CHAIN_ID" ]]; then
  echo "未广播：RPC 链 ID 是 $ACTUAL_CHAIN_ID，不是 $TARGET_CHAIN_ID。"
  echo "拒绝在错误的链上广播。（MONAD_RPC=$RPC）"
  exit 1
fi
echo "==> 链 ID 校验通过：$ACTUAL_CHAIN_ID"

DEPLOYER="$(cast wallet address --private-key "$PK")"
BAL="$(cast balance --rpc-url "$RPC" "$DEPLOYER")"
if [[ "$BAL" == "0" ]]; then
  echo "未广播：部署地址 $DEPLOYER 余额为 0。先从水龙头领 MON，再重试。"
  exit 1
fi
echo "==> 部署者 $DEPLOYER 余额 $(cast from-wei "$BAL") MON"

# ── 4. 广播 ──────────────────────────────────────────────────
echo "==> Deploying to Monad testnet $RPC"
forge script script/Deploy.s.sol:Deploy --rpc-url "$RPC" --broadcast --private-key "$PK" --chain "$TARGET_CHAIN_ID" -vv

# ── 5. 解析产物：写独立文件，绝不覆盖本地演示地址 ──────────────
python3 << PY
import json, glob, os, shutil
root = "$ROOT"
paths = sorted(glob.glob(root + "/contracts/broadcast/Deploy.s.sol/%s/run-latest.json" % "$TARGET_CHAIN_ID"), reverse=True)
if not paths:
    raise SystemExit("no %s broadcast file — 广播可能根本没发生" % "$TARGET_CHAIN_ID")
data = json.load(open(paths[0]))

addrs, txs, empties = {}, [], []
for tx in data.get("transactions", []):
    name = tx.get("contractName") or ""
    ca = tx.get("contractAddress")
    h = tx.get("hash")
    if name and ca:
        addrs[name] = ca
    if h:
        txs.append(h)
    else:
        empties.append(name or "?")

if empties:
    raise SystemExit("产物里这些交易没有 hash，说明并未真正广播：%s" % ",".join(empties))
if not txs:
    raise SystemExit("产物里一笔交易都没有，说明并未真正广播")

out = {
  "chainId": $TARGET_CHAIN_ID,
  "rpcUrl": "$RPC",
  "deployer": "$DEPLOYER",
  "StubVerifier": addrs.get("StubVerifier", ""),
  "AgentRegistry": addrs.get("AgentRegistry", ""),
  "GameTable": addrs.get("GameTable", ""),
  "Covenant": addrs.get("Covenant", ""),
}
missing = [k for k, v in out.items() if k[0].isupper() and not v]
if missing:
    raise SystemExit("产物缺少地址：" + ",".join(missing))

# 测试网地址写到独立文件；本地演示用的 addresses.json 保持不动，
# 否则 pnpm demo 会因为 chainId != 31337 直接拒绝运行。
out_path = root + "/frontend/src/lib/addresses.%s.json" % "$TARGET_CHAIN_ID"
json.dump(out, open(out_path, "w"), indent=2)
print("Wrote", out_path)
print(json.dumps(out, indent=2))
print("tx hashes (前 3 笔):")
for h in txs[:3]:
    print(" ", h)
print()
print("本地演示地址 frontend/src/lib/addresses.json 未被改动（pnpm demo 仍可用）。")
PY

echo
echo "==> 测试网部署完成。请把上面的地址与 tx hash 回填 README。"
