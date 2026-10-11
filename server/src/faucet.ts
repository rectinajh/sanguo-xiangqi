/**
 * index.ts —— 水龙头服务。
 *
 * 为什么必须是独立服务：
 *   领币需要一把有余额的私钥来付 gas。这把钥**绝不能进前端 bundle**，
 *   否则任何人打开开发者工具就能拿走它。所以它是服务端进程，只暴露一个 HTTP 接口。
 *
 * 安全设计：
 *   - FAUCET_KEY 只从环境变量读，不接受任何客户端传入的键
 *   - 拒绝在 Monad 主网（143）上启动
 *   - 拒绝公开已知的 Anvil 测试钥（非本地链）
 *   - 每个地址只能领一次；每个 IP 每天有限额
 *   - 每次领取前检查热钱包余额，不够就直接拒绝而不是发出去失败
 *
 * 用法：
 *   FAUCET_KEY=0x... RPC_URL=https://testnet-rpc.monad.xyz CHAIN_ID=10143 pnpm faucet
 */
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { createPublicClient, createWalletClient, defineChain, http, isAddress, parseEther, formatEther, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";

const PUBLIC_ANVIL_KEYS = new Set([
  "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80",
  "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d",
  "0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a",
  "0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6",
]);

type Config = {
  rpcUrl: string;
  chainId: number;
  key: Hex;
  port: number;
  dripWei: bigint;
  /** 每个地址总共只能领几次 */
  perAddress: number;
  /** 每个 IP 每天最多几次 */
  perIpPerDay: number;
  /** 只有余额低于这个值的地址才能领（避免被当成中转站） */
  maxHoldingWei: bigint;
  /** 允许的跨域来源；* 表示不限制 */
  allowOrigin: string;
};

function loadConfig(): Config {
  const env = process.env;
  const key = env.FAUCET_KEY as Hex | undefined;
  if (!key || !/^0x[0-9a-fA-F]{64}$/.test(key)) {
    throw new Error(
      "缺少 FAUCET_KEY。\n" +
        "  这是水龙头自己的热钱包私钥，只放在服务端，**不要**写进前端或提交到仓库。\n" +
        "  建议：新建一个专用地址，只放够发几百次的 MON。"
    );
  }
  const chainId = Number(env.CHAIN_ID ?? 10143);
  if (chainId === 143) {
    throw new Error("拒绝启动：这是 Monad 主网（143）。水龙头只应在测试网运行。");
  }
  if (chainId !== 31337 && PUBLIC_ANVIL_KEYS.has(key.toLowerCase())) {
    throw new Error(
      `拒绝启动：chainId ${chainId} 不是本地链，但 FAUCET_KEY 是公开已知的 Anvil 测试钥。\n` +
        "任何人拿到它都能转走水龙头的全部余额。"
    );
  }
  return {
    rpcUrl: env.RPC_URL ?? env.MONAD_RPC ?? "http://127.0.0.1:8545",
    chainId,
    key,
    port: Number(env.FAUCET_PORT ?? 8787),
    // 默认 3.2 MON = 1 质押 + 2 作战 + 0.2 gas 缓冲（与 PRD faucetPerHuman 一致）
    dripWei: parseEther(env.FAUCET_DRIP_MON ?? "3.2"),
    perAddress: Number(env.FAUCET_PER_ADDRESS ?? 1),
    perIpPerDay: Number(env.FAUCET_PER_IP_PER_DAY ?? 5),
    maxHoldingWei: parseEther(env.FAUCET_MAX_HOLDING_MON ?? "5"),
    allowOrigin: env.FAUCET_ALLOW_ORIGIN ?? "*",
  };
}

/** 内存态限流。生产环境应换成持久化存储，否则重启即重置。 */
const addressCount = new Map<string, number>();
const ipDay = new Map<string, { day: string; count: number }>();

const today = () => new Date().toISOString().slice(0, 10);

function bumpIp(ip: string, limit: number): boolean {
  const d = today();
  const cur = ipDay.get(ip);
  if (!cur || cur.day !== d) {
    ipDay.set(ip, { day: d, count: 1 });
    return true;
  }
  if (cur.count >= limit) return false;
  cur.count += 1;
  return true;
}

function clientIp(req: IncomingMessage): string {
  const fwd = req.headers["x-forwarded-for"];
  if (typeof fwd === "string" && fwd.length > 0) return fwd.split(",")[0].trim();
  return req.socket.remoteAddress ?? "unknown";
}

function json(res: ServerResponse, status: number, body: unknown, allowOrigin: string) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "access-control-allow-origin": allowOrigin,
    "access-control-allow-headers": "content-type",
    "access-control-allow-methods": "GET,POST,OPTIONS",
    "cache-control": "no-store",
  });
  res.end(payload);
}

async function main() {
  const cfg = loadConfig();
  const chain = defineChain({
    id: cfg.chainId,
    name: cfg.chainId === 10143 ? "Monad Testnet" : `chain-${cfg.chainId}`,
    nativeCurrency: { name: "MON", symbol: "MON", decimals: 18 },
    rpcUrls: { default: { http: [cfg.rpcUrl] } },
  });
  const account = privateKeyToAccount(cfg.key);
  const pub = createPublicClient({ chain, transport: http(cfg.rpcUrl) });
  const wallet = createWalletClient({ account, chain, transport: http(cfg.rpcUrl) });

  // 启动自检：链 ID 必须与配置一致，否则可能在错误的网络上发钱
  const actualChainId = await pub.getChainId();
  if (actualChainId !== cfg.chainId) {
    throw new Error(`RPC 实际 chainId 是 ${actualChainId}，与配置的 ${cfg.chainId} 不一致，拒绝启动。`);
  }

  const balance = await pub.getBalance({ address: account.address });
  console.log("水龙头启动");
  console.log(`  链        ${cfg.chainId} · ${cfg.rpcUrl}`);
  console.log(`  发币地址  ${account.address}`);
  console.log(`  当前余额  ${formatEther(balance)} MON`);
  console.log(`  单次发放  ${formatEther(cfg.dripWei)} MON`);
  console.log(`  可发次数  约 ${balance / cfg.dripWei} 次`);
  if (balance < cfg.dripWei) {
    console.warn("  ⚠️ 余额不足一次发放，请先给这个地址打钱");
  }

  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");

    if (req.method === "OPTIONS") {
      json(res, 204, {}, cfg.allowOrigin);
      return;
    }

    if (url.pathname === "/health") {
      const bal = await pub.getBalance({ address: account.address });
      json(
        res,
        200,
        {
          ok: true,
          chainId: cfg.chainId,
          address: account.address,
          balanceMon: formatEther(bal),
          dripMon: formatEther(cfg.dripWei),
          dripsLeft: Number(bal / cfg.dripWei),
        },
        cfg.allowOrigin
      );
      return;
    }

    if (url.pathname !== "/drip") {
      json(res, 404, { error: "not found. use GET /health or POST /drip {address}" }, cfg.allowOrigin);
      return;
    }
    if (req.method !== "POST") {
      json(res, 405, { error: "use POST" }, cfg.allowOrigin);
      return;
    }

    // 读 body
    let raw = "";
    for await (const chunk of req) {
      raw += chunk;
      if (raw.length > 4096) {
        json(res, 413, { error: "body too large" }, cfg.allowOrigin);
        return;
      }
    }
    let to: string | undefined;
    try {
      to = (JSON.parse(raw || "{}") as { address?: string }).address;
    } catch {
      json(res, 400, { error: "invalid json" }, cfg.allowOrigin);
      return;
    }
    if (!to || !isAddress(to)) {
      json(res, 400, { error: "invalid address" }, cfg.allowOrigin);
      return;
    }

    const addr = to.toLowerCase();

    if (addr === account.address.toLowerCase()) {
      json(res, 400, { error: "cannot drip to the faucet itself" }, cfg.allowOrigin);
      return;
    }

    const used = addressCount.get(addr) ?? 0;
    if (used >= cfg.perAddress) {
      json(res, 429, { error: `该地址已领取过 ${cfg.perAddress} 次`, address: to }, cfg.allowOrigin);
      return;
    }

    const ip = clientIp(req);
    if (!bumpIp(ip, cfg.perIpPerDay)) {
      json(res, 429, { error: `该 IP 今日领取次数已达上限（${cfg.perIpPerDay}）` }, cfg.allowOrigin);
      return;
    }

    // 已经有足够余额的地址不给，避免水龙头被当中转站
    const holding = await pub.getBalance({ address: to as `0x${string}` });
    if (holding >= cfg.maxHoldingWei) {
      json(
        res,
        429,
        {
          error: `该地址已有 ${formatEther(holding)} MON，超过阈值 ${formatEther(cfg.maxHoldingWei)} MON，无需领取`,
        },
        cfg.allowOrigin
      );
      return;
    }

    const bal = await pub.getBalance({ address: account.address });
    if (bal < cfg.dripWei) {
      json(res, 503, { error: "水龙头余额不足，请联系管理员补充" }, cfg.allowOrigin);
      return;
    }

    try {
      const hash = await wallet.sendTransaction({
        to: to as `0x${string}`,
        value: cfg.dripWei,
        account,
        chain,
      });
      await pub.waitForTransactionReceipt({ hash });
      addressCount.set(addr, used + 1);
      console.log(`  发放 ${formatEther(cfg.dripWei)} MON → ${to}  ${hash}`);
      json(res, 200, { ok: true, hash, amountMon: formatEther(cfg.dripWei), to }, cfg.allowOrigin);
    } catch (e) {
      console.error("发放失败", e);
      json(res, 500, { error: `发放失败：${(e as Error).message.split("\n")[0]}` }, cfg.allowOrigin);
    }
  });

  server.listen(cfg.port, () => {
    console.log(`  监听      http://0.0.0.0:${cfg.port}`);
    console.log(`  接口      GET /health · POST /drip {"address":"0x..."}`);
  });
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
