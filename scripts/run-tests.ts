import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdir, mkdtemp, readdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

type Suite = "unit" | "cli" | "agent-sdk" | "all" | "live";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const bunBinary =
  process.env.BUN_BINARY ||
  (((process.versions as Record<string, string | undefined>).bun ? process.execPath : null) ?? "bun");
const nodeBinary = process.env.NODE_BINARY || "node";
const nonDeterministicEnvKeys = [
  "OPENPOND_ACCOUNT",
  "OPENPOND_API_KEY",
  "OPENPOND_API_URL",
  "OPENPOND_BASE_URL",
  "OPENPOND_CHAT_API_URL",
  "OPENPOND_GOAL_API_KEY",
  "OPENPOND_GOAL_API_URL",
  "OPENPOND_GOAL_ID",
  "OPENPOND_GOAL_OUTPUT",
  "OPENPOND_GOAL_RUN_CONFIG_PATH",
  "OPENPOND_GOAL_STORAGE",
  "OPENPOND_GOAL_STORAGE_LOCATION",
  "OPENPOND_OPCHAT_API_KEY",
  "OPENPOND_OPCHAT_API_URL",
  "OPENPOND_OPCHAT_MODEL",
  "OPENPOND_SANDBOX_API_KEY",
  "OPENPOND_SANDBOX_API_URL",
  "OPENPOND_SANDBOX_BASE_URL",
  "OPENPOND_TOOL_URL",
];

async function main(): Promise<void> {
  const suite = parseSuite(process.argv[2]);
  const suites = expandSuite(suite);
  const isolated = suite !== "live";
  const testEnv = isolated ? await createIsolatedTestEnv() : process.env;
  const tempHome = isolated ? testEnv.HOME : null;

  try {
    for (const current of suites) {
      if (current === "unit") await runUnitTests(testEnv);
      if (current === "cli") await runCommand(bunBinary, ["test", "--cwd", "apps/cli"], { env: testEnv });
      if (current === "agent-sdk") {
        await runCommand(bunBinary, ["run", "--cwd", "packages/agent-sdk", "build"], { env: testEnv });
        await runCommand(bunBinary, ["test", "--cwd", "packages/agent-sdk"], { env: testEnv });
      }
      if (current === "live") await runLiveTests(process.env);
    }
  } finally {
    if (tempHome) await rm(tempHome, { recursive: true, force: true });
  }
}

function parseSuite(raw: string | undefined): Suite {
  const suite = raw ?? "all";
  if (suite === "unit" || suite === "cli" || suite === "agent-sdk" || suite === "all" || suite === "live") {
    return suite;
  }
  throw new Error(`unknown test suite "${suite}". Expected unit, cli, agent-sdk, all, or live.`);
}

function expandSuite(suite: Suite): Suite[] {
  return suite === "all" ? ["unit", "cli", "agent-sdk"] : [suite];
}

async function createIsolatedTestEnv(): Promise<NodeJS.ProcessEnv> {
  const home = await mkdtemp(path.join(os.tmpdir(), "openpond-test-home-"));
  const codexHome = path.join(home, ".codex");
  const appHome = path.join(home, ".openpond", "openpond-app");
  await mkdir(codexHome, { recursive: true });
  await mkdir(appHome, { recursive: true });

  const env: NodeJS.ProcessEnv = {
    ...process.env,
    CI: process.env.CI ?? "1",
    CODEX_HOME: codexHome,
    FORCE_COLOR: "0",
    HOME: home,
    LANG: "C",
    LC_ALL: "C",
    NO_COLOR: "1",
    OPENPOND_APP_HOME: appHome,
    TZ: "UTC",
    USERPROFILE: home,
  };
  for (const key of nonDeterministicEnvKeys) delete env[key];
  return env;
}

async function runUnitTests(env: NodeJS.ProcessEnv): Promise<void> {
  await runCommand(bunBinary, ["x", "tsc", "-b", "apps/server"], { env });
  const files = await discoverRootTests();
  if (files.node.length > 0) {
    await runCommand(nodeBinary, ["--test", ...files.node], { env });
  }
  if (files.bun.length > 0) {
    await runCommand(bunBinary, ["test", ...files.bun], { env });
  }
}

async function runLiveTests(env: NodeJS.ProcessEnv): Promise<void> {
  await runCommand(bunBinary, ["x", "tsc", "-b", "apps/server"], { env });
  const liveFiles = await discoverLiveTests();
  if (liveFiles.length === 0) {
    console.log("No live tests found.");
    return;
  }
  await runCommand(nodeBinary, ["--test", ...liveFiles], { env });
}

async function discoverRootTests(): Promise<{ node: string[]; bun: string[] }> {
  const entries = await readdir(path.join(root, "tests"));
  const node = entries
    .filter((entry) => entry.endsWith(".test.mjs"))
    .filter((entry) => !entry.startsWith("live-"))
    .sort()
    .map((entry) => path.join("tests", entry));
  const bun = entries
    .filter((entry) => entry.endsWith(".test.ts") || entry.endsWith(".test.tsx"))
    .sort()
    .map((entry) => path.join("tests", entry));
  return { node, bun };
}

async function discoverLiveTests(): Promise<string[]> {
  const entries = await readdir(path.join(root, "tests"));
  return entries
    .filter((entry) => entry.startsWith("live-") && entry.endsWith(".test.mjs"))
    .sort()
    .map((entry) => path.join("tests", entry));
}

async function runCommand(
  command: string,
  args: string[],
  options: { env: NodeJS.ProcessEnv; cwd?: string },
): Promise<void> {
  console.log(`\n$ ${[command, ...args].join(" ")}`);
  const child = spawn(command, args, {
    cwd: options.cwd ?? root,
    env: options.env,
    stdio: "inherit",
    shell: false,
  });
  const [code, signal] = (await once(child, "exit")) as [number | null, NodeJS.Signals | null];
  if (code === 0) return;
  throw new Error(`${command} ${args.join(" ")} failed with ${signal ?? `exit code ${code}`}`);
}

void main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
