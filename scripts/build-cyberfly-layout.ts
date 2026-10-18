/**
 * @deprecated Prefer real MaleCNS SWC skeletons:
 *   python3 scripts/build-cyberfly-skeletons.py
 *
 * This stub remains so older docs/commands do not break; it forwards to the skeleton builder.
 */
import { spawnSync } from "node:child_process";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const py = join(root, "scripts/build-cyberfly-skeletons.py");
console.log("build-cyberfly-layout → forwarding to MaleCNS SWC skeleton builder");
const r = spawnSync("python3", [py], { cwd: root, stdio: "inherit" });
process.exit(r.status ?? 1);
