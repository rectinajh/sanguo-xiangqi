import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/** 把 agent/.env（及可选仓库根 .env）读进 process.env；已有键不覆盖。 */
export function loadAgentEnv() {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const agentDir = path.resolve(here, "..");
  const root = path.resolve(agentDir, "..");
  for (const p of [path.join(agentDir, ".env"), path.join(root, ".env")]) {
    if (!existsSync(p)) continue;
    for (const line of readFileSync(p, "utf8").split(/\r?\n/)) {
      const t = line.trim();
      if (!t || t.startsWith("#")) continue;
      const i = t.indexOf("=");
      if (i <= 0) continue;
      const key = t.slice(0, i).trim();
      let val = t.slice(i + 1).trim();
      if (
        (val.startsWith('"') && val.endsWith('"')) ||
        (val.startsWith("'") && val.endsWith("'"))
      ) {
        val = val.slice(1, -1);
      }
      if (process.env[key] === undefined) process.env[key] = val;
    }
  }
}
