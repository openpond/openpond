import { copyFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const workspaceRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const source = path.join(
  workspaceRoot,
  "apps",
  "server",
  "src",
  "training",
  "tau3-retail-bridge.py",
);
const destination = path.join(
  workspaceRoot,
  "apps",
  "server",
  "dist",
  "training",
  "tau3-retail-bridge.py",
);

await mkdir(path.dirname(destination), { recursive: true });
await copyFile(source, destination);
