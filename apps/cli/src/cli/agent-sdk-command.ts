import { existsSync } from "node:fs";
import path from "node:path";

export function resolveLocalAgentSdkCommand(cwd: string): {
  command: string;
  args: string[];
} {
  const packageDistCli = path.join(
    cwd,
    "node_modules",
    "openpond-agent-sdk",
    "dist",
    "cli.js"
  );
  if (existsSync(packageDistCli)) return { command: "bun", args: [packageDistCli] };
  const localBin = path.join(cwd, "node_modules", ".bin", "openpond-agent");
  if (existsSync(localBin)) return { command: localBin, args: [] };
  const packageCli = path.join(
    cwd,
    "node_modules",
    "openpond-agent-sdk",
    "src",
    "cli.ts"
  );
  if (existsSync(packageCli)) return { command: "bun", args: [packageCli] };
  return { command: "openpond-agent", args: [] };
}
