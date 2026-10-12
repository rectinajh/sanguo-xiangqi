/**
 * faucet.ts —— 领测试币的入口。
 *
 * 我们**不自建水龙头**。自建需要一个常驻的、有 MON 余额的热钱包，还要对公网
 * 暴露一个发钱接口，运维成本和被刷的风险都不值得 —— 尤其这只是测试网，
 * 官方水龙头本来就是干这个的。所以这里只负责把用户送到官方入口。
 *
 * 如果将来确实要自建（例如内网演示），把 FAUCET_URL 指到自己的服务即可，
 * 其余调用点不用改。
 */

/** 官方水龙头。改这里就能换成自建水龙头。 */
export const FAUCET_URL = (import.meta.env.VITE_FAUCET_URL ?? "https://faucet.monad.xyz").replace(
  /\/$/,
  ""
);

/** 水龙头的展示名（按域名推断，避免写死 "Monad" 但实际指向别处）。 */
export function faucetLabel(): string {
  try {
    const host = new URL(FAUCET_URL).hostname;
    if (host.includes("monad")) return "Monad 官方水龙头";
    return host;
  } catch {
    return "官方水龙头";
  }
}

/** 是不是官方地址（自建时返回 false，提示文案可以不一样）。 */
export function isOfficialFaucet(): boolean {
  return FAUCET_URL.includes("faucet.monad.xyz");
}
