import { spawn } from "node:child_process";
import { once } from "node:events";
import { fileURLToPath } from "node:url";

type VerificationStep = {
  label: string;
  command: string;
  args: string[];
  env?: NodeJS.ProcessEnv;
};

const root = fileURLToPath(new URL("..", import.meta.url));
const pnpm = process.env.PNPM_BINARY || "pnpm";
const reuseBuildEnv = { ...process.env, OPENPOND_TEST_REUSE_BUILD: "1" };
const steps: VerificationStep[] = [
  step("Install locked dependencies", "install", "--frozen-lockfile"),
  step("Typecheck workspace", "run", "typecheck"),
  step("Typecheck CLI", "run", "cli:typecheck"),
  step("Typecheck Agent SDK", "run", "agent-sdk:typecheck"),
  step("Build application artifacts", "run", "build:artifacts"),
  step("Build CLI distribution", "run", "cli:build"),
  step("Check CLI distribution", "run", "budgets:cli:check"),
  step("Check performance budgets", "run", "budgets:check"),
  step("Check source structure", "run", "structure:check"),
  step("Check production entrypoints", "run", "reachability:check"),
  step("Check workspace dependencies", "run", "dependencies:check"),
  step("Check repository hygiene", "run", "hygiene:check"),
  step("Check GitHub workflows", "run", "workflows:check"),
  suite("Run unit tests", "unit"),
  suite("Run integration tests", "integration"),
  step("Run Python tests", "run", "test:python"),
  suite("Run contract tests", "contract"),
  suite("Run release smoke tests", "release"),
];

const before = await workspaceStatus();
let verificationError: unknown = null;

try {
  for (const verificationStep of steps) {
    await runStep(verificationStep);
  }
} catch (error) {
  verificationError = error;
}

const after = await workspaceStatus();
if (after !== before) {
  const workspaceError = new Error(
    [
      "Verification changed tracked or untracked source files.",
      "Tests and builds must write only to ignored build or temporary directories.",
      "",
      "Before:",
      before || "<clean>",
      "",
      "After:",
      after || "<clean>",
    ].join("\n"),
  );
  if (verificationError) {
    throw new AggregateError([verificationError, workspaceError], "Push verification failed");
  }
  throw workspaceError;
}

if (verificationError) throw verificationError;
console.log("\nPush verification passed without changing the workspace.");

function step(label: string, ...args: string[]): VerificationStep {
  return { label, command: pnpm, args };
}

function suite(label: string, suiteName: string): VerificationStep {
  return {
    label,
    command: pnpm,
    args: ["exec", "tsx", "scripts/run-tests.ts", suiteName],
    env: reuseBuildEnv,
  };
}

async function workspaceStatus(): Promise<string> {
  return capture("git", ["status", "--porcelain=v1", "--untracked-files=all"]);
}

async function runStep(verificationStep: VerificationStep): Promise<void> {
  const startedAt = performance.now();
  console.log(`\n==> ${verificationStep.label}`);
  await run(verificationStep.command, verificationStep.args, verificationStep.env);
  console.log(`<== ${verificationStep.label} (${formatDuration(performance.now() - startedAt)})`);
}

async function capture(command: string, args: string[]): Promise<string> {
  const child = spawn(command, args, {
    cwd: root,
    env: process.env,
    stdio: ["ignore", "pipe", "inherit"],
  });
  let stdout = "";
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk) => { stdout += chunk; });
  const [code] = (await once(child, "exit")) as [number | null];
  if (code !== 0) throw new Error(`${command} ${args.join(" ")} exited with code ${code}`);
  return stdout.trimEnd();
}

async function run(command: string, args: string[], env = process.env): Promise<void> {
  console.log(`$ ${[command, ...args].join(" ")}`);
  const child = spawn(command, args, {
    cwd: root,
    env,
    stdio: "inherit",
  });
  const [code, signal] = (await once(child, "exit")) as [number | null, NodeJS.Signals | null];
  if (code !== 0) {
    throw new Error(`${command} ${args.join(" ")} failed with ${signal ?? `exit code ${code}`}`);
  }
}

function formatDuration(durationMs: number): string {
  return `${(durationMs / 1_000).toFixed(1)}s`;
}
