import { execFile } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";

export type CodexBinaryCandidate = {
  command: string;
  version: string | null;
  versionParts: number[];
  supportsListen: boolean;
};

function execFileText(command: string, args: string[], timeoutMs = 5000): Promise<string> {
  return new Promise((resolve, reject) => {
    const commandDir = path.dirname(command);
    const env = isExplicitCommand(command)
      ? {
          ...process.env,
          PATH: [commandDir, process.env.PATH].filter(Boolean).join(path.delimiter),
        }
      : process.env;
    const child = execFile(command, args, { timeout: timeoutMs, env }, (error, stdout, stderr) => {
      if (error) {
        reject(new Error(stderr?.trim() || error.message));
        return;
      }
      resolve(String(stdout || stderr || "").trim());
    });
    child.stdin?.end();
  });
}

function parseVersionParts(output: string): number[] {
  const match = output.match(/(\d+)\.(\d+)\.(\d+)/);
  if (!match) return [];
  return match.slice(1).map((part) => Number.parseInt(part, 10));
}

function compareVersionParts(left: number[], right: number[]): number {
  for (let index = 0; index < 3; index += 1) {
    const delta = (left[index] ?? -1) - (right[index] ?? -1);
    if (delta !== 0) return delta;
  }
  return 0;
}

function isExplicitCommand(command: string): boolean {
  return path.isAbsolute(command) || command.includes("/") || command.includes("\\");
}

function knownCodexCommands(command: string): string[] {
  if (command !== "codex" || process.platform === "win32") return [];
  const home = os.homedir();
  const candidates = [
    path.join(home, ".nvm", "versions", "node"),
    path.join(home, ".npm-global", "bin", "codex"),
    path.join(home, ".local", "bin", "codex"),
    path.join(home, ".bun", "bin", "codex"),
    "/Applications/Codex.app/Contents/Resources/codex",
    "/opt/homebrew/bin/codex",
    "/usr/local/bin/codex",
    "/usr/bin/codex",
  ];
  const nvmRoot = candidates[0]!;
  const nvmCandidates = existsSync(nvmRoot)
    ? readdirSync(nvmRoot)
        .map((entry) => path.join(nvmRoot, entry, "bin", "codex"))
        .filter((entry) => existsSync(entry))
    : [];
  return [...nvmCandidates, ...candidates.slice(1).filter((entry) => existsSync(entry))];
}

async function findBinaries(command: string): Promise<string[]> {
  if (isExplicitCommand(command)) return [command];
  const probe = process.platform === "win32" ? "where" : "which";
  const args = process.platform === "win32" ? [command] : ["-a", command];
  try {
    const output = await execFileText(probe, args, 3000);
    return Array.from(
      new Set([...output.split(/\r?\n/).map((line) => line.trim()).filter(Boolean), ...knownCodexCommands(command)])
    );
  } catch {
    return knownCodexCommands(command);
  }
}

async function inspectCodexBinary(command: string): Promise<CodexBinaryCandidate> {
  const versionOutput = await execFileText(command, ["--version"], 5000);
  let supportsListen = false;
  try {
    const helpOutput = await execFileText(command, ["app-server", "--help"], 5000);
    supportsListen = helpOutput.includes("--listen");
  } catch {
    supportsListen = false;
  }
  return {
    command,
    version: versionOutput || null,
    versionParts: parseVersionParts(versionOutput),
    supportsListen,
  };
}

export async function resolveCodexBinary(binaryPath: string): Promise<CodexBinaryCandidate> {
  const commands = await findBinaries(binaryPath);
  const candidates = (
    await Promise.all(
      (commands.length ? commands : [binaryPath]).map(async (command) => {
        try {
          return await inspectCodexBinary(command);
        } catch {
          return null;
        }
      })
    )
  ).filter((candidate): candidate is CodexBinaryCandidate => Boolean(candidate));

  candidates.sort((left, right) => {
    const versionDelta = compareVersionParts(right.versionParts, left.versionParts);
    if (versionDelta !== 0) return versionDelta;
    if (left.supportsListen !== right.supportsListen) return left.supportsListen ? -1 : 1;
    return left.command.localeCompare(right.command);
  });

  const selected = candidates[0];
  if (!selected) throw new Error(`codex binary not found: ${binaryPath}`);
  return selected;
}
