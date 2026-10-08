import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const source = process.env.REMOTE_DEVICE_CONTRACT_SOURCE ?? path.resolve(root, "../sandbox/shared/remote-device.ts");
const destination = path.resolve(root, "packages/contracts/src/remote-device.ts");
const content = await readFile(source, "utf8");
const hash = createHash("sha256").update(content).digest("hex");
const generated = `// Generated from Sandbox shared/remote-device.ts. Do not edit.\n// Source SHA256: ${hash}\n// Refresh: node scripts/sync-remote-device-contract.mjs\n${content}`;
if (process.argv.includes("--check")) {
  if (await readFile(destination, "utf8") !== generated) throw new Error("Remote device contract is stale. Run node scripts/sync-remote-device-contract.mjs.");
} else await writeFile(destination, generated);
