import { existsSync } from "node:fs";
import path from "node:path";

export type AgentSdkPackageManager =
  | "bun"
  | "npm"
  | "pnpm"
  | "yarn"
  | "unknown";

export function detectAgentSdkPackageManager(
  projectPath: string,
  packageJson: Record<string, unknown>,
): AgentSdkPackageManager {
  const packageManager = packageJson.packageManager;
  if (typeof packageManager === "string") {
    const name = packageManager.split("@")[0];
    if (name === "bun" || name === "npm" || name === "pnpm" || name === "yarn") {
      return name;
    }
  }
  if (
    existsSync(path.join(projectPath, "bun.lock")) ||
    existsSync(path.join(projectPath, "bun.lockb"))
  ) {
    return "bun";
  }
  if (existsSync(path.join(projectPath, "pnpm-lock.yaml"))) return "pnpm";
  if (existsSync(path.join(projectPath, "yarn.lock"))) return "yarn";
  if (
    existsSync(path.join(projectPath, "package-lock.json")) ||
    existsSync(path.join(projectPath, "npm-shrinkwrap.json"))
  ) {
    return "npm";
  }
  return "unknown";
}

export function agentSdkDependencyInstallCommand(
  packageManager: AgentSdkPackageManager,
): string {
  if (packageManager === "npm") return "npm install --offline";
  if (packageManager === "pnpm") return "pnpm install --offline";
  if (packageManager === "yarn") return "yarn install --offline";
  if (packageManager === "bun") return "bun install --offline";
  return "pnpm install --offline";
}

export function agentSdkRunScriptCommand(
  packageManager: AgentSdkPackageManager,
  scriptName: string,
): string {
  if (packageManager === "pnpm") return `pnpm run ${scriptName}`;
  if (packageManager === "yarn") return `yarn ${scriptName}`;
  if (packageManager === "npm") return `npm run ${scriptName}`;
  if (packageManager === "bun") return `bun run ${scriptName}`;
  return `pnpm run ${scriptName}`;
}
