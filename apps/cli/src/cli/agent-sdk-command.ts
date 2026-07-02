import { existsSync, readFileSync } from "node:fs";
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
  const packageDependencyCli = resolveAgentSdkDependencyCli(cwd);
  if (packageDependencyCli) return packageDependencyCli;
  return { command: "openpond-agent", args: [] };
}

function resolveAgentSdkDependencyCli(cwd: string): {
  command: string;
  args: string[];
} | null {
  const packageJsonPath = path.join(cwd, "package.json");
  if (!existsSync(packageJsonPath)) return null;
  try {
    const packageJson = JSON.parse(readFileSync(packageJsonPath, "utf8")) as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
      peerDependencies?: Record<string, string>;
    };
    const versionSpec =
      packageJson.dependencies?.["openpond-agent-sdk"] ??
      packageJson.devDependencies?.["openpond-agent-sdk"] ??
      packageJson.peerDependencies?.["openpond-agent-sdk"];
    if (!versionSpec?.startsWith("file:")) return null;
    const packageRoot = path.resolve(cwd, versionSpec.slice("file:".length));
    const sourceCli = path.join(packageRoot, "src", "cli.ts");
    if (existsSync(sourceCli)) return { command: "bun", args: [sourceCli] };
    const distCli = path.join(packageRoot, "dist", "cli.js");
    if (existsSync(distCli)) return { command: "bun", args: [distCli] };
  } catch {
    return null;
  }
  return null;
}
