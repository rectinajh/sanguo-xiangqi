#!/usr/bin/env bash
# 合约尺寸门禁。
#
# 为什么需要它：foundry 的 code_size_limit 曾经被设成 500_000，于是 GameTable
# 涨到 146 KB（EIP-170 运行时代码上限 24,576 B）时 `forge test` 依然全绿，
# 直到真正部署才报 CreateContractSizeLimit。
#
# 做法说明：`forge build --sizes`（默认 profile）**自己就会**在任一合约运行时代码
# 超过 code_size_limit 时退出 1，所以这里不需要再解析表格做一次比较
# （之前那版就是因为 set -e 被 forge 的退出码打断，连自己的提示都打不出来）。
# 本脚本的职责是：跑默认 profile、把 forge 的报错翻译成"该怎么修"。
#
# 注意：`forge test` 跑的是 [profile.test]（放宽到 500_000，因为测试辅助合约
# 本身就很大）。判断"能不能部署"必须用默认 profile，也就是下面这条命令。
set -uo pipefail

cd "$(dirname "$0")/.."

OUT=$(cd contracts && forge build --sizes 2>&1)
STATUS=$?

echo "$OUT" | grep -E '^\|' | grep -vE '^\-|Contract' || true

if [ "$STATUS" -ne 0 ]; then
  echo
  if echo "$OUT" | grep -q "exceed the runtime size limit"; then
    echo "❌ 有合约超出 EIP-170 的 24,576 B 运行时代码上限，部署到真实链会报 CreateContractSizeLimit。"
    echo
    echo "怎么修（按优先级）："
    echo "  1. 把重逻辑 / 查表挪进 external library（library 里 public 函数会走 DELEGATECALL，"
    echo "     不再在每个调用点内联）—— GameTable 就是这么从 146 KB 降到 20 KB 的。"
    echo "  2. 减少内联：internal library 会在每个调用点复制一份，热路径尤其贵。"
    echo "  3. 拆合约：把一部分状态和逻辑拆到独立合约，用外部调用衔接。"
    echo
    echo "不要为了让它过而调大 foundry.toml 的 code_size_limit —— 那只是把失败推迟到部署时。"
  else
    echo "$OUT" | tail -20
  fi
  exit 1
fi

echo "✅ 所有合约都在 EIP-170 的 24,576 B 运行时代码上限内"
