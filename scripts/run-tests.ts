import { spawn } from "node:child_process";
import { once } from "node:events";
import { access, mkdir, mkdtemp, readdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  ALL_TEST_SUITES,
  type TestSuite,
} from "./test-suite-config";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
let serverWorkspaceBuildReady = false;
const nodeBinary = process.env.NODE_BINARY || "node";
const pnpmBinary = process.env.PNPM_BINARY || (process.platform === "win32" ? "pnpm.cmd" : "pnpm");
const tscBinary = path.join(root, "node_modules", ".bin", process.platform === "win32" ? "tsc.cmd" : "tsc");
const vitestBinary = path.join(root, "node_modules", ".bin", process.platform === "win32" ? "vitest.cmd" : "vitest");
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
  "OPENPOND_CONFIG_DIR",
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
  const suites = suite === "all" ? ALL_TEST_SUITES : [suite];
  const isolated = suite !== "live";
  const testEnv = isolated ? await createIsolatedTestEnv() : process.env;
  const tempHome = isolated ? testEnv.HOME : null;

  try {
    for (const current of suites) {
      if (current === "unit") await runUnitTests(testEnv);
      if (current === "integration") await runIntegrationTests(testEnv);
      if (current === "contract") await runContractTests(testEnv);
      if (current === "release") await runReleaseTests(testEnv);
      if (current === "cli") await runCliCompatibilitySuite(testEnv);
      if (current === "agent-sdk") await runAgentSdkTests(testEnv);
      if (current === "live") await runLiveTests(process.env);
    }
  } finally {
    if (tempHome) await rm(tempHome, { recursive: true, force: true });
  }
}

function parseSuite(raw: string | undefined): TestSuite {
  const suite = raw ?? "all";
  if (
    suite === "unit"
    || suite === "integration"
    || suite === "contract"
    || suite === "release"
    || suite === "cli"
    || suite === "agent-sdk"
    || suite === "all"
    || suite === "live"
  ) {
    return suite;
  }
  throw new Error(
    `unknown test suite "${suite}". Expected unit, integration, contract, release, all, cli, agent-sdk, or live.`,
  );
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
  await ensureServerWorkspaceBuild(env);
  await runVitestProjects(["root-unit", "cli-unit"], env);
}

async function runIntegrationTests(env: NodeJS.ProcessEnv): Promise<void> {
  await ensureServerWorkspaceBuild(env);
  await runVitestProjects(["root-integration", "cli-integration"], env);
}

async function runContractTests(env: NodeJS.ProcessEnv): Promise<void> {
  await ensureServerWorkspaceBuild(env);
  const nodeFiles = await discoverNodeContractTests();
  if (nodeFiles.length > 0) await runCommand(nodeBinary, ["--test", ...nodeFiles], { env });
  await runAgentSdkTests(env);
}

async function runReleaseTests(env: NodeJS.ProcessEnv): Promise<void> {
  if (env.OPENPOND_TEST_REUSE_BUILD !== "1") {
    await runCommand(pnpmBinary, ["run", "build:web"], { env });
    await runCommand(pnpmBinary, ["run", "cli:build"], { env });
  }
  await assertFilesExist([
    "apps/cli/dist/cli.js",
    "apps/cli/dist/web/index.html",
    "apps/cli/dist/skills/openpond-taskset-authoring/SKILL.md",
  ]);
  await runVitestProjects(["cli-release"], env);
}

async function ensureServerWorkspaceBuild(env: NodeJS.ProcessEnv): Promise<void> {
  if (env.OPENPOND_TEST_REUSE_BUILD === "1" || serverWorkspaceBuildReady) return;
  await runCommand(tscBinary, ["-b", "apps/server"], { env });
  serverWorkspaceBuildReady = true;
}

async function runCliCompatibilitySuite(env: NodeJS.ProcessEnv): Promise<void> {
  await ensureServerWorkspaceBuild(env);
  await runVitestProjects(["cli-unit", "cli-integration"], env);
  await runReleaseTests(env);
}

async function runAgentSdkTests(env: NodeJS.ProcessEnv): Promise<void> {
  await runCommand(pnpmBinary, ["--dir", "packages/agent-sdk", "run", "build"], { env });
  await runCommand(vitestBinary, ["run", "--project", "agent-sdk"], { env });
}

async function runLiveTests(env: NodeJS.ProcessEnv): Promise<void> {
  await runCommand(tscBinary, ["-b", "apps/server"], { env });
  const liveFiles = await discoverLiveTests();
  if (liveFiles.length === 0) {
    console.log("No live tests found.");
    return;
  }
  await runCommand(nodeBinary, ["--test", ...liveFiles], { env });
}

async function discoverNodeContractTests(): Promise<string[]> {
  const entries = await readdir(path.join(root, "tests"));
  return entries
    .filter((entry) => entry.endsWith(".test.mjs"))
    .filter((entry) => !entry.startsWith("live-"))
    .sort()
    .map((entry) => path.join("tests", entry));
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

async function runVitestProjects(projects: string[], env: NodeJS.ProcessEnv): Promise<void> {
  await runCommand(
    vitestBinary,
    ["run", ...projects.flatMap((project) => ["--project", project])],
    { env },
  );
}

async function assertFilesExist(files: readonly string[]): Promise<void> {
  for (const file of files) {
    await access(path.join(root, file));
  }
}

void main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
