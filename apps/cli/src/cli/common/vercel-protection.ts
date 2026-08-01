import { spawnSync } from "node:child_process";
import path from "node:path";

type ProtectionCommandResult = {
  status: number | null;
  stdout: string;
};

type ProtectionCommandRunner = (input: {
  command: string;
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
}) => ProtectionCommandResult;

export type StagingProtectionBootstrapOptions = {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  run?: ProtectionCommandRunner;
};

export function ensureStagingVercelProtectionBypass(
  requestUrl: string,
  options: StagingProtectionBootstrapOptions = {}
): boolean {
  const env = options.env ?? process.env;
  if (env.VERCEL_AUTOMATION_BYPASS_SECRET?.trim()) return true;
  if (!isOpenPondStagingUrl(requestUrl)) return false;

  const cwd = path.resolve(options.cwd ?? process.cwd());
  const projectDirectories = candidateProjectDirectories(cwd, env);
  const run = options.run ?? runProtectionCommand;
  const command = process.platform === "win32" ? "vercel.cmd" : "vercel";

  for (const projectDirectory of projectDirectories) {
    const result = run({
      command,
      args: ["project", "protection", "--format", "json"],
      cwd: projectDirectory,
      env,
    });
    if (result.status !== 0 || !result.stdout.trim()) continue;
    const secret = vercelProtectionBypassSecret(result.stdout);
    if (!secret) continue;
    env.VERCEL_AUTOMATION_BYPASS_SECRET = secret;
    return true;
  }

  return false;
}

export function vercelProtectionBypassSecret(
  rawProtectionJson: string
): string | null {
  try {
    const payload = JSON.parse(rawProtectionJson) as {
      protectionBypass?: Record<string, { isEnvVar?: boolean } | null>;
    };
    const entries = Object.entries(payload.protectionBypass ?? {});
    const selected =
      entries.find(([, metadata]) => metadata?.isEnvVar === true) ?? entries[0];
    return selected?.[0]?.trim() || null;
  } catch {
    return null;
  }
}

function isOpenPondStagingUrl(requestUrl: string): boolean {
  try {
    const hostname = new URL(requestUrl).hostname.toLowerCase();
    return (
      hostname === "staging.openpond.ai" ||
      hostname === "staging-api.openpond.ai" ||
      hostname.endsWith(".staging-api.openpond.ai")
    );
  } catch {
    return false;
  }
}

function candidateProjectDirectories(
  cwd: string,
  env: NodeJS.ProcessEnv
): string[] {
  const configured = env.OPENPOND_VERCEL_PROJECT_DIR?.trim();
  return [...new Set([
    ...(configured ? [path.resolve(cwd, configured)] : []),
    path.resolve(cwd, "../sandbox"),
    cwd,
  ])];
}

function runProtectionCommand(input: {
  command: string;
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
}): ProtectionCommandResult {
  const result = spawnSync(input.command, input.args, {
    cwd: input.cwd,
    env: input.env,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  });
  return {
    status: result.status,
    stdout: typeof result.stdout === "string" ? result.stdout : "",
  };
}
