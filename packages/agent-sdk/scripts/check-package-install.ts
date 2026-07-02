#!/usr/bin/env bun
import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

const root = path.resolve(import.meta.dir, "..");
const workRoot = path.join(root, ".openpond-test-fixtures", "package-install");
const packDir = path.join(workRoot, "pack");
const fixtureDir = path.join(workRoot, "fixture");
const initRoot = path.join(workRoot, "init");
const templateNames = ["blank-agent", "customer-reply-agent", "integration-heavy-agent"] as const;
const pilotNames = ["blank-agent", "customer-reply-agent", "water-estimator-agent", "integration-heavy-agent"] as const;

await rm(workRoot, { force: true, recursive: true });
await mkdir(packDir, { recursive: true });
await mkdir(path.join(fixtureDir, "agent"), { recursive: true });

const tarball = await packSdk();
await writeFixture(tarball);
await run(["bun", "install"], fixtureDir);
await writeExportSmoke();
await run(["bun", "exports-smoke.ts"], fixtureDir);

const cli = path.join(fixtureDir, "node_modules/.bin/openpond-agent");
const inspect = await runJson([cli, "inspect", "--json"], fixtureDir);
if (inspect.project?.name !== "package-installed-agent") {
  throw new Error(`Unexpected inspect project name: ${JSON.stringify(inspect.project)}`);
}

const validation = await runJson([cli, "validate", "--json"], fixtureDir);
if (Array.isArray(validation.errors) && validation.errors.length > 0) {
  throw new Error(`Package-installed validation failed: ${JSON.stringify(validation.errors)}`);
}

await runJson([cli, "build", "--json"], fixtureDir);
await assertFile(path.join(fixtureDir, ".openpond", "agent-manifest.json"));
await assertFile(path.join(fixtureDir, ".openpond", "action-registry.json"));
await assertFile(path.join(fixtureDir, ".openpond", "runtime-bridge.mjs"));
await assertFile(path.join(fixtureDir, ".openpond", "prompts", "instructions.md"));
await assertFile(path.join(fixtureDir, ".openpond", "skills", "installed-skill", "SKILL.md"));
await runJson([cli, "build", "--json", "--out-dir", ".openpond-alt"], fixtureDir);
await assertFile(path.join(fixtureDir, ".openpond-alt", "agent-manifest.json"));
await assertFile(path.join(fixtureDir, ".openpond-alt", "action-registry.json"));
await assertFile(path.join(fixtureDir, ".openpond-alt", "runtime-bridge.mjs"));

const evalResult = await runJson([cli, "eval", "--json"], fixtureDir);
if (evalResult.summary?.failed !== 0) {
  throw new Error(`Package-installed eval failed: ${JSON.stringify(evalResult.summary)}`);
}

const runResult = await runJson([
  cli,
  "run",
  "chat",
  "--input",
  JSON.stringify({ prompt: "hello", channel: "openpond_chat" }),
], fixtureDir);
if (runResult.result?.intent !== "answer") {
  throw new Error(`Package-installed run returned unexpected intent: ${JSON.stringify(runResult)}`);
}

for (const templateName of templateNames) {
  const target = path.join(initRoot, templateName);
  await runJson([cli, "init", templateName, "--cwd", target, "--json"], fixtureDir);
  await run(["bun", "install"], target);
  const initializedCli = path.join(target, "node_modules/.bin/openpond-agent");
  const initializedInspect = await runJson([initializedCli, "inspect", "--json"], target);
  if (initializedInspect.project?.name !== templateName) {
    throw new Error(`Initialized ${templateName} inspect returned unexpected project: ${JSON.stringify(initializedInspect.project)}`);
  }
  const initializedValidation = await runJson([initializedCli, "validate", "--json"], target);
  if (initializedValidation.status !== "passed") {
    throw new Error(`Initialized ${templateName} validation failed: ${JSON.stringify(initializedValidation.issues)}`);
  }
  const initializedEval = await runJson([initializedCli, "eval", "--json"], target);
  if (initializedEval.summary?.failed !== 0) {
    throw new Error(`Initialized ${templateName} eval failed: ${JSON.stringify(initializedEval.summary)}`);
  }
  const initializedRun = await runJson([
    initializedCli,
    "run",
    "chat",
    "--input",
    JSON.stringify({ prompt: "hello", channel: "openpond_chat" }),
  ], target);
  if (!initializedRun.result?.intent) {
    throw new Error(`Initialized ${templateName} run did not return an intent: ${JSON.stringify(initializedRun)}`);
  }
  const initializedTraces = await runJson([initializedCli, "traces", "--json"], target);
  if (!Array.isArray(initializedTraces.traces) || initializedTraces.traces.length === 0) {
    throw new Error(`Initialized ${templateName} did not produce trace artifacts.`);
  }
  await runJson([initializedCli, "build", "--json"], target);
}

for (const pilotName of pilotNames) {
  const target = path.join(workRoot, "pilots", pilotName);
  await cp(path.join(root, "examples", pilotName), target, { recursive: true });
  await rm(path.join(target, ".openpond"), { force: true, recursive: true });
  await rewriteSdkDependency(target, tarball);
  await run(["bun", "install"], target);
  const pilotCli = path.join(target, "node_modules/.bin/openpond-agent");
  const pilotInspect = await runJson([pilotCli, "inspect", "--json"], target);
  if (pilotInspect.project?.name !== expectedPilotProjectName(pilotName)) {
    throw new Error(`Pilot ${pilotName} inspect returned unexpected project: ${JSON.stringify(pilotInspect.project)}`);
  }
  const pilotValidation = await runJson([pilotCli, "validate", "--json"], target);
  if (pilotValidation.status !== "passed") {
    throw new Error(`Pilot ${pilotName} validation failed: ${JSON.stringify(pilotValidation.issues)}`);
  }
  const pilotEval = await runJson([pilotCli, "eval", "--json"], target);
  if (pilotEval.summary?.failed !== 0) {
    throw new Error(`Pilot ${pilotName} eval failed: ${JSON.stringify(pilotEval.summary)}`);
  }
  const pilotRun = await runJson([
    pilotCli,
    "run",
    "chat",
    "--input",
    JSON.stringify({ prompt: "hello", channel: "openpond_chat" }),
  ], target);
  if (!pilotRun.result?.intent && typeof pilotRun.result?.text !== "string") {
    throw new Error(`Pilot ${pilotName} run returned unexpected result: ${JSON.stringify(pilotRun)}`);
  }
  const pilotTraces = await runJson([pilotCli, "traces", "--json"], target);
  if (!Array.isArray(pilotTraces.traces) || pilotTraces.traces.length === 0) {
    throw new Error(`Pilot ${pilotName} did not produce trace artifacts.`);
  }
  await runJson([pilotCli, "build", "--json"], target);
}

console.log("Package-installed SDK acceptance check passed.");

async function packSdk() {
  const proc = Bun.spawn(["npm", "pack", "--pack-destination", packDir], {
    cwd: root,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  if (exitCode !== 0) {
    throw new Error(["npm pack failed", stdout.trim(), stderr.trim()].filter(Boolean).join("\n"));
  }
  const filename = stdout.trim().split(/\s+/).at(-1);
  if (!filename) throw new Error("npm pack did not report a tarball filename.");
  return path.join(packDir, filename);
}

async function writeFixture(tarball: string) {
  await mkdir(path.join(fixtureDir, "agent", "skills"), { recursive: true });
  await writeFile(
    path.join(fixtureDir, "package.json"),
    `${JSON.stringify({
      name: "package-installed-agent-fixture",
      version: "0.0.0",
      private: true,
      type: "module",
      dependencies: {
        "openpond-agent-sdk": tarball,
      },
    }, null, 2)}\n`,
    "utf8",
  );
  await writeFile(
    path.join(fixtureDir, "agent", "instructions.ts"),
    `import { defineInstructions } from "openpond-agent-sdk/instructions";

export default defineInstructions({
  markdown: "# Package installed agent\\n\\nAnswer from the installed SDK package.",
});
`,
    "utf8",
  );
  await writeFile(
    path.join(fixtureDir, "agent", "skills", "installed-skill.ts"),
    `import { defineSkill } from "openpond-agent-sdk/skills";

export default defineSkill({
  name: "installed-skill",
  description: "Used by the package install check.",
  markdown: "Stay concise.",
});
`,
    "utf8",
  );
  await writeFile(
    path.join(fixtureDir, "agent", "agent.ts"),
    `import {
  action,
  defineAgentProject,
  defineIntent,
  defineIntentRouter,
  defineWorkflow,
  editable,
} from "openpond-agent-sdk/primitives";
import { defineChannel } from "openpond-agent-sdk/channels";
import { defineEval } from "openpond-agent-sdk/eval";
import instructions from "./instructions.ts";
import installedSkill from "./skills/installed-skill.ts";

const answerWorkflow = defineWorkflow({
  name: "answer",
  async run(ctx, input) {
    ctx.trace.event("package.answer", { prompt: input.prompt });
    return { text: "Answer: " + input.prompt, intent: "answer" };
  },
});

const answerIntent = defineIntent({
  name: "answer",
  description: "Answer a package-installed prompt.",
  async run(ctx, input) {
    return ctx.workflow("answer", input);
  },
});

const chat = defineIntentRouter({
  intents: [answerIntent],
  defaultIntent: answerIntent,
});

export default defineAgentProject({
  name: "package-installed-agent",
  version: "0.1.0",
  useCase: "package-install-check",
  manifestMode: "typescript",
  runtime: { base: "node-bun-workspace" },
  instructions,
  skills: [installedSkill],
  defaultAction: "chat",
  actions: [
    action("chat", {
      target: { kind: "intent-router", router: chat },
      outputArtifacts: ["artifacts/package-answer.json"],
    }),
  ],
  workflows: [answerWorkflow],
  channels: [
    defineChannel({
      id: "openpond_chat",
      target: { action: "chat" },
      normalizeEvent: (event) => ({ prompt: String(event.prompt ?? ""), channel: "openpond_chat" }),
      renderResponse: (result) => ({ text: result.text }),
    }),
  ],
  editable: editable({
    enabled: true,
    backend: "openpond-coding-work-item",
    runtimeEnvironmentId: "openpond-coding-core-v1",
    sourceOfTruth: "agent-source",
    policyDiscovery: { command: "openpond agent inspect --json", runAfter: "source-materialized" },
    allowedPaths: ["agent/**"],
    requiredChecks: ["openpond-agent validate", "openpond-agent eval"],
    defaultResultMode: "patch_only",
  }),
  evals: [
    defineEval({
      name: "package-installed-answer",
      description: "Installed package can run an eval.",
      async run(t) {
        await t.send({ prompt: "hello", channel: "openpond_chat" });
        t.expectIntent("answer");
        t.expectTraceEvent("package.answer");
      },
    }),
  ],
});
`,
    "utf8",
  );
}

async function writeExportSmoke() {
  await writeFile(
    path.join(fixtureDir, "exports-smoke.ts"),
    `import * as root from "openpond-agent-sdk";
import * as channels from "openpond-agent-sdk/channels";
import * as editable from "openpond-agent-sdk/editable";
import * as evals from "openpond-agent-sdk/eval";
import * as instructions from "openpond-agent-sdk/instructions";
import * as integrations from "openpond-agent-sdk/integrations";
import * as inspect from "openpond-agent-sdk/inspect";
import * as manifest from "openpond-agent-sdk/manifest";
import * as primitives from "openpond-agent-sdk/primitives";
import * as runtime from "openpond-agent-sdk/runtime";
import * as schemas from "openpond-agent-sdk/schemas";
import * as schedules from "openpond-agent-sdk/schedules";
import * as skills from "openpond-agent-sdk/skills";
import * as tracing from "openpond-agent-sdk/tracing";
import * as validator from "openpond-agent-sdk/validator";
import * as volumes from "openpond-agent-sdk/volumes";
import * as workflow from "openpond-agent-sdk/workflow";

const checks = [
  ["root.defineAgentProject", root.defineAgentProject],
  ["root.action", root.action],
  ["channels.defineChannel", channels.defineChannel],
  ["channels.normalizeChannelEvent", channels.normalizeChannelEvent],
  ["editable.editable", editable.editable],
  ["eval.defineEval", evals.defineEval],
  ["instructions.defineInstructions", instructions.defineInstructions],
  ["integrations.integration", integrations.integration],
  ["inspect.createInspect", inspect.createInspect],
  ["manifest.createAgentManifest", manifest.createAgentManifest],
  ["manifest.assertArtifactSchemaCompatibility", manifest.assertArtifactSchemaCompatibility],
  ["primitives.defineWorkflow", primitives.defineWorkflow],
  ["runtime.executeAction", runtime.executeAction],
  ["schemas.SDK_SCHEMA_VERSION", schemas.SDK_SCHEMA_VERSION],
  ["schedules.schedule", schedules.schedule],
  ["skills.defineSkill", skills.defineSkill],
  ["tracing.writeTrace", tracing.writeTrace],
  ["validator.validateAgentProject", validator.validateAgentProject],
  ["volumes.volume", volumes.volume],
  ["workflow.defineWorkflow", workflow.defineWorkflow],
];

const missing = checks.filter(([, value]) => value === undefined).map(([name]) => name);
if (missing.length > 0) {
  throw new Error("Packed install export smoke failed: " + missing.join(", "));
}
`,
    "utf8",
  );
}

async function rewriteSdkDependency(projectDir: string, dependency: string) {
  const packageJsonPath = path.join(projectDir, "package.json");
  const packageJson = JSON.parse(await readFile(packageJsonPath, "utf8")) as {
    dependencies?: Record<string, string>;
  };
  packageJson.dependencies = {
    ...(packageJson.dependencies ?? {}),
    "openpond-agent-sdk": dependency,
  };
  await writeFile(packageJsonPath, `${JSON.stringify(packageJson, null, 2)}\n`, "utf8");
}

function expectedPilotProjectName(pilotName: typeof pilotNames[number]) {
  if (pilotName === "water-estimator-agent") return "cloud-water-estimator-example";
  return pilotName;
}

async function runJson(command: string[], cwd: string) {
  const stdout = await run(command, cwd);
  return JSON.parse(stdout) as Record<string, any>;
}

async function run(command: string[], cwd: string) {
  const proc = Bun.spawn(command, {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, TMPDIR: tmpdir() },
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  if (exitCode === 0) return stdout;
  throw new Error(
    [
      `Command failed: ${command.join(" ")}`,
      stdout.trim(),
      stderr.trim(),
    ].filter(Boolean).join("\n"),
  );
}

async function assertFile(filePath: string) {
  const contents = await readFile(filePath, "utf8");
  if (contents.length === 0) throw new Error(`Expected ${filePath} to be non-empty.`);
}
