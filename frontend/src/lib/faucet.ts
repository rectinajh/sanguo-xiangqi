/**
 * faucet.ts —— 前端访问水龙头服务。
 *
 * 私钥在服务端，这里只发一个 HTTP 请求。
 * 水龙头地址通过 VITE_FAUCET_URL 配置；本地默认指向 127.0.0.1:8787。
 */

const FAUCET_URL = (import.meta.env.VITE_FAUCET_URL ?? "http://127.0.0.1:8787").replace(/\/$/, "");

export type DripResult =
  | { ok: true; hash: string; amountMon: string }
  | { ok: false; error: string };

async function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return await Promise.race([
    p,
    new Promise<T>((_, rej) => setTimeout(() => rej(new Error("水龙头请求超时")), ms)),
  ]);
}

export async function faucetHealth(): Promise<{
  ok: boolean;
  chainId: number;
  balanceMon: string;
  dripMon: string;
  dripsLeft: number;
} | null> {
  try {
    const r = await withTimeout(fetch(`${FAUCET_URL}/health`), 4000);
    if (!r.ok) return null;
    return (await r.json()) as {
      ok: boolean;
      chainId: number;
      balanceMon: string;
      dripMon: string;
      dripsLeft: number;
    };
  } catch {
    return null;
  }
}

export async function requestDrip(address: `0x${string}`): Promise<DripResult> {
  try {
    const r = await withTimeout(
      fetch(`${FAUCET_URL}/drip`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ address }),
      }),
      20000
    );
    const body = (await r.json()) as {
      ok?: boolean;
      hash?: string;
      amountMon?: string;
      error?: string;
    };
    if (r.ok && body.ok) {
      return { ok: true, hash: body.hash ?? "", amountMon: body.amountMon ?? "" };
    }
    return { ok: false, error: body.error ?? `HTTP ${r.status}` };
  } catch (e) {
    const msg = (e as Error).message;
    return {
      ok: false,
      error:
        msg.includes("超时") || msg.includes("fetch")
          ? `连不上水龙头（${FAUCET_URL}）。本地开发请先跑 pnpm faucet。`
          : msg,
    };
  }
}

export function faucetUrl() {
  return FAUCET_URL;
}
