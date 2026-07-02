import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { assertArtifactSchemaCompatibility } from "openpond-agent-sdk/manifest";

const packageRoot = path.resolve(import.meta.dir, "..");
const fixtureRoot = path.join(packageRoot, ".openpond-test-fixtures", "artifact-index-contract");

describe("artifact index contract", () => {
  beforeAll(async () => {
    await rm(fixtureRoot, { force: true, recursive: true });
    await mkdir(path.join(fixtureRoot, "agent"), { recursive: true });
    await writeFile(
      path.join(fixtureRoot, "agent", "instructions.md"),
      "# Artifact index agent\n\nCreate traceable artifacts.\n",
      "utf8",
    );
    await writeFile(
      path.join(fixtureRoot, "agent", "agent.ts"),
      `import {
  action,
  defineAgentProject,
  defineEval,
  defineInstructions,
  defineSkill,
  defineWorkflow,
} from "openpond-agent-sdk/primitives";

const chatWorkflow = defineWorkflow({
  name: "chat-workflow",
  async run(ctx, input) {
    await ctx.loadSkill("artifact-policy");
    ctx.trace.event("artifact-index.answer", { prompt: input.prompt });
    ctx.trace.artifact("artifacts/chat.json");
    return { text: "Answer: " + input.prompt, intent: "answer", artifactRefs: ["artifacts/chat.json"] };
  },
});

export default defineAgentProject({
  name: "artifact-index-agent",
  version: "0.1.0",
  useCase: "artifact-index",
  manifestMode: "typescript",
  runtime: { base: "node-bun-workspace" },
  instructions: defineInstructions("./agent/instructions.md"),
  skills: [
    defineSkill({
      name: "artifact-policy",
      description: "Use when checking artifact output.",
      markdown: "Keep artifact refs stable.",
    }),
  ],
  defaultAction: "chat",
  actions: [action("chat", { target: { kind: "workflow", workflow: chatWorkflow }, outputArtifacts: ["artifacts/chat.json"] })],
  workflows: [chatWorkflow],
  evals: [
    defineEval({
      name: "artifact-index-eval",
      description: "Eval emits trace and artifact refs.",
      async run(t) {
        await t.send({ prompt: "hello", channel: "openpond_chat" });
        t.expectIntent("answer");
        t.expectArtifact("artifacts/chat.json");
        t.expectTraceEvent("artifact-index.answer");
      },
    }),
  ],
});
`,
      "utf8",
    );
  });

  afterAll(async () => {
    await rm(fixtureRoot, { force: true, recursive: true });
  });

  test("indexes and validates build, eval, and trace artifacts", async () => {
    const build = await runSdkJson(["build", "--json", "--cwd", fixtureRoot]);
    expect(build.artifactIndex.schema).toBe("openpond.agent.artifact-index.v1");

    let index = await readIndex();
    expect(index.entries.map((entry: Record<string, any>) => entry.kind)).toEqual(expect.arrayContaining([
      "artifact-index",
      "agent-manifest",
      "action-registry",
      "inspect",
      "runtime-manifest-preview",
      "runtime-bridge",
      "validator-report",
      "instructions",
      "skill",
    ]));
    await assertArtifactSchemaCompatibility(fixtureRoot, index as any);

    const evalResult = await runSdkJson(["eval", "--json", "--cwd", fixtureRoot]);
    expect(evalResult.results[0].traceArtifactRef).toMatch(/^\.openpond\/traces\/artifact-index-eval-/);
    index = await readIndex();
    expect(index.entries).toEqual(expect.arrayContaining([
      expect.objectContaining({
        path: ".openpond/eval-results.json",
        kind: "eval-results",
        schema: "openpond.agent.eval-results.v1",
      }),
      expect.objectContaining({
        path: evalResult.results[0].traceArtifactRef,
        kind: "trace-jsonl",
        schema: "openpond.agent.trace.v1",
      }),
    ]));
    await assertArtifactSchemaCompatibility(fixtureRoot, index as any);

    const run = await runSdkJson([
      "run",
      "chat",
      "--cwd",
      fixtureRoot,
      "--input",
      JSON.stringify({ prompt: "run", channel: "openpond_chat" }),
    ]);
    expect(run.traceArtifactRef).toMatch(/^\.openpond\/traces\/run-chat-/);
    index = await readIndex();
    const traceEntries = index.entries.filter((entry: Record<string, any>) => entry.kind === "trace-jsonl");
    expect(traceEntries.length).toBeGreaterThanOrEqual(2);
    await assertArtifactSchemaCompatibility(fixtureRoot, index as any);

    await rm(path.join(fixtureRoot, run.traceArtifactRef), { force: true });
    const secondEvalResult = await runSdkJson(["eval", "--json", "--cwd", fixtureRoot]);
    index = await readIndex();
    expect(index.entries).toEqual(expect.arrayContaining([
      expect.objectContaining({
        path: evalResult.results[0].traceArtifactRef,
        kind: "trace-jsonl",
      }),
      expect.objectContaining({
        path: secondEvalResult.results[0].traceArtifactRef,
        kind: "trace-jsonl",
      }),
    ]));
    expect(index.entries).not.toEqual(expect.arrayContaining([
      expect.objectContaining({
        path: run.traceArtifactRef,
        kind: "trace-jsonl",
      }),
    ]));
    await assertArtifactSchemaCompatibility(fixtureRoot, index as any);

    const rebuild = await runSdkJson(["build", "--json", "--cwd", fixtureRoot]);
    expect(rebuild.artifactIndex.entries).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: "eval-results" }),
      expect.objectContaining({ kind: "trace-jsonl" }),
    ]));
    index = await readIndex();
    expect(index.entries).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: "eval-results" }),
      expect.objectContaining({ kind: "trace-jsonl" }),
    ]));
    await assertArtifactSchemaCompatibility(fixtureRoot, index as any);
  });
});

async function readIndex() {
  return JSON.parse(
    await readFile(path.join(fixtureRoot, ".openpond", "artifact-index.json"), "utf8"),
  ) as Record<string, any>;
}

async function runSdkJson(args: string[]) {
  const proc = Bun.spawn(["bun", "./dist/cli.js", ...args], {
    cwd: packageRoot,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  if (exitCode !== 0) {
    throw new Error([
      `openpond-agent ${args.join(" ")} failed with exit code ${exitCode}`,
      stdout.trim(),
      stderr.trim(),
    ].filter(Boolean).join("\n"));
  }
  return JSON.parse(stdout) as Record<string, any>;
}
