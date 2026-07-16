import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";

import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { runTestProcess } from "../../../tests/helpers/run-process";
import { parseSkillMarkdown } from "openpond-agent-sdk/skills";
import {
  connectedIntegration,
  connectedIntegrationCapabilityIds,
  isConnectedIntegrationProvider,
} from "openpond-agent-sdk/integrations";

const packageRoot = path.resolve(import.meta.dirname, "..");
const fixtureRoot = path.join(packageRoot, ".openpond-test-fixtures", "primitive-contract");
const invalidFixtureRoot = path.join(packageRoot, ".openpond-test-fixtures", "primitive-contract-invalid");

describe("public primitive contract", () => {
  beforeAll(async () => {
    await rm(fixtureRoot, { force: true, recursive: true });
    await rm(invalidFixtureRoot, { force: true, recursive: true });
    await mkdir(path.join(fixtureRoot, "agent"), { recursive: true });
    await mkdir(path.join(invalidFixtureRoot, "agent"), { recursive: true });
    await mkdir(path.join(fixtureRoot, "agent", "evals", "fixtures"), { recursive: true });
    await writeFile(
      path.join(fixtureRoot, "agent", "instructions.md"),
      "# Test Agent\n\nAnswer clearly.\n",
      "utf8",
    );
    await writeFile(
      path.join(fixtureRoot, "agent", "evals", "fixtures", "hello.json"),
      `${JSON.stringify({ prompt: "hello" }, null, 2)}\n`,
      "utf8",
    );
    await writeFile(
      path.join(fixtureRoot, "agent", "agent.ts"),
      `import {
  defineAction,
  defineAgentProject,
  defineIntent,
  defineIntentRouter,
  defineTool,
  editable,
} from "openpond-agent-sdk/primitives";
import { defineChannel } from "openpond-agent-sdk/channels";
import { defineEval } from "openpond-agent-sdk/eval";
import { defineInstructions } from "openpond-agent-sdk/instructions";
import { connectedIntegration, defineIntegration, secret } from "openpond-agent-sdk/integrations";
import { schedule } from "openpond-agent-sdk/schedules";
import { defineSkill } from "openpond-agent-sdk/skills";
import { defineVolume } from "openpond-agent-sdk/volumes";
import { defineWorkflow } from "openpond-agent-sdk/workflow";

const answerWorkflow = defineWorkflow({
  name: "answer",
  description: "Return a traceable answer.",
  async run(ctx, input) {
    await ctx.loadSkill("tone");
    ctx.trace.event("test.answer.started", { apiKey: "do-not-store" });
    ctx.trace.artifact("artifacts/test-answer.json", { token: "do-not-store" });
    const normalizedPrompt = await ctx.step("normalize-prompt", async () => String(input.prompt ?? "").trim());
    const toolResult = await ctx.tool("answer-tool", async () => ({ prompt: normalizedPrompt }));
    const text = await ctx.model("format-answer", async () => "Answer: " + toolResult.prompt);
    return { text, intent: "answer", artifactRefs: ["artifacts/test-answer.json"] };
  },
});

const answerIntent = defineIntent({
  name: "answer",
  description: "Answer a prompt.",
  async run(ctx, input) {
    return ctx.workflow("answer", input);
  },
});

const chat = defineIntentRouter({
  intents: [answerIntent],
  defaultIntent: answerIntent,
  routing: { strategy: "code", traceSelection: true },
});

export default defineAgentProject({
  name: "primitive-contract-agent",
  version: "0.1.0",
  useCase: "primitive-contract",
  manifestMode: "typescript",
  runtime: { base: "node-bun-workspace" },
  instructions: defineInstructions("./agent/instructions.md"),
  skills: [
    defineSkill({
      name: "tone",
      description: "Use when shaping answer tone.",
      source: () => "Be concise.",
      files: {
        "references/tone.md": () => "# Tone reference\\n\\nPrefer short answers.\\n",
      },
    }),
  ],
  integrations: [
    defineIntegration({ provider: "opchat", required: true, scopes: ["opchat:chat:create"] }),
    defineIntegration({ provider: "slack", required: false, capabilities: ["slack.message.ingest"] }),
    connectedIntegration.google({ required: true, capabilities: ["google.drive.file.read"] }),
  ],
  env: [
    secret.env("OPENAI_API_KEY", {
      required: true,
      description: "Model provider key stored in OpenPond secret storage.",
    }),
  ],
  volumes: [
    defineVolume("agent-state", "/workspace/volumes/agent-state", {
      provisioning: { mode: "select-or-create", scope: "project" },
      state: { engine: "filesystem" },
    }),
  ],
  defaultAction: "chat",
  actions: [
    defineAction("chat", {
      target: { kind: "intent-router", router: chat },
      outputArtifacts: ["artifacts/test-answer.json"],
    }),
    defineAction("answer-direct", {
      target: { kind: "workflow", workflow: answerWorkflow },
      visibility: "end_user",
      inputSchema: "AnswerInput",
      outputArtifacts: ["artifacts/test-answer.json"],
    }),
  ],
  workflows: [answerWorkflow],
  tools: [
    defineTool({
      name: "answer_tool",
      description: "Answer a prompt through the direct action.",
      visibility: "end_user",
      target: { kind: "action", action: "answer-direct", workflow: "answer" },
      outputArtifacts: ["artifacts/test-answer.json"],
    }),
  ],
  channels: [
    defineChannel({
      id: "openpond_chat",
      target: { action: "chat" },
      normalizeEvent: (event) => ({ prompt: String(event.prompt ?? ""), channel: "openpond_chat" }),
      renderResponse: (result) => ({ text: result.text }),
    }),
    defineChannel({
      id: "slack",
      target: { action: "chat" },
      requiredConnections: ["slack"],
      capabilities: ["slack.message.ingest"],
      normalizeEvent: (event) => ({ prompt: String(event.text ?? ""), channel: "slack" }),
      renderResponse: (result) => ({ text: result.text }),
    }),
  ],
  schedules: [
    schedule.cron("daily", {
      target: { action: "chat" },
      cron: "0 9 * * *",
      timezone: "America/New_York",
      input: { prompt: "Daily check", channel: "schedule" },
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
      name: "answers",
      description: "Chat returns the answer intent.",
      fixtures: ["./agent/evals/fixtures/hello.json"],
      publishGate: true,
      async run(t) {
        await t.send({ prompt: "hello", channel: "openpond_chat" });
        t.expectIntent("answer");
        t.expectArtifact("artifacts/test-answer.json");
        t.expectTraceEvent("test.answer.started");
        t.expectTraceEvent("skill.loaded");
        t.expectTraceEvent("step.completed");
        t.expectTraceEvent("model.completed");
        t.expectTraceEvent("tool.completed");
        await t.runAction("answer-direct", { prompt: "direct", channel: "openpond_chat" });
        t.expectTextIncludes("direct");
      },
    }),
  ],
});
`,
      "utf8",
    );
    await writeFile(
      path.join(invalidFixtureRoot, "agent", "agent.ts"),
      `import {
  action,
  defineAgentProject,
  defineSkill,
  defineWorkflow,
} from "openpond-agent-sdk/primitives";
import { defineChannel } from "openpond-agent-sdk/channels";
import { defineEnvSecret } from "openpond-agent-sdk/integrations";

const answerWorkflow = defineWorkflow({
  name: "answer",
  async run(_ctx, input) {
    return { text: String(input.prompt ?? ""), intent: "answer" };
  },
});

export default defineAgentProject({
  name: "invalid-contract-agent",
  version: "0.1.0",
  useCase: "primitive-contract-invalid",
  manifestMode: "typescript",
  runtime: { base: "node-bun-workspace" },
  instructions: "./agent/missing-instructions.md",
  defaultAction: "missing",
  actions: [
    action("chat", { target: { kind: "workflow", workflow: answerWorkflow } }),
  ],
  workflows: [answerWorkflow],
  channels: [
    defineChannel({
      id: "slack",
      target: { action: "chat" },
      requiredConnections: ["slack"],
      normalizeEvent: (event) => ({ prompt: String(event.text ?? ""), channel: "slack" }),
      renderResponse: (result) => ({ text: result.text }),
    }),
  ],
  env: [
    defineEnvSecret("BAD_SECRET", {
      required: true,
      secret: true,
      value: "literal-secret-value",
    }),
  ],
  skills: [
    defineSkill({
      name: "bad-skill",
      source: () => "Bad skill.",
      files: { "../leak.md": "not allowed" },
    }),
  ],
});
`,
      "utf8",
    );
  });

  afterAll(async () => {
    await rm(fixtureRoot, { force: true, recursive: true });
    await rm(invalidFixtureRoot, { force: true, recursive: true });
  });

  test("CLI builds deterministic public SDK artifacts from a generic fixture", async () => {
    const inspect = await runSdkJson(["inspect", "--json", "--cwd", fixtureRoot]);
    expect(inspect.schema).toBe("openpond.agent.inspect.v1");
    expect(inspect.artifactSchemas.action).toBe("openpond.agent.action.v1");
    expect(inspect.project.name).toBe("primitive-contract-agent");
    expect(inspect.capabilities.actions).toEqual(["chat", "answer-direct"]);
    expect(inspect.actionCatalog[0]).toMatchObject({
      id: "chat",
      label: "Chat",
      implementation: { type: "intent-router", routerId: "chat-router" },
      mcp: { enabled: false },
      trace: { name: "chat", namespace: "actions" },
      invokesModel: true,
    });
    expect(inspect.actionCatalog[1]).toMatchObject({
      id: "answer-direct",
      label: "Answer Direct",
      implementation: { type: "workflow", workflowId: "answer" },
      inputSchema: "AnswerInput",
      artifactPolicy: {
        outputArtifacts: ["artifacts/test-answer.json"],
        persistRunSummary: true,
        persistTrace: true,
      },
      invokesModel: false,
    });
    expect(inspect.capabilities.channels).toEqual(["openpond_chat", "slack"]);
    expect(inspect.setup.channels[1]).toMatchObject({
      id: "slack",
      setupStatus: "ready",
      setupRequirements: [
        { kind: "integration", name: "slack", required: true, satisfied: true },
      ],
    });
    expect(inspect.capabilities.tools).toEqual(["answer_tool"]);
    expect(inspect.capabilities.workflows).toEqual(["answer"]);
    expect(inspect.editable.requiredChecks).toEqual([
      "openpond-agent validate",
      "openpond-agent eval",
    ]);
    expect(inspect.generatedArtifacts.inspectJson).toBe(
      ".openpond/agent-inspect.json",
    );

    await runSdkJson(["build", "--json", "--cwd", fixtureRoot]);
    const buildArtifacts = [
      "agent-manifest.json",
      "action-registry.json",
      "agent-inspect.json",
      "openpond-manifest.preview.yaml",
      "runtime-bridge.mjs",
      "validator-report.md",
      "prompts/instructions.md",
      "skills/tone/SKILL.md",
      "skills/tone/references/tone.md",
    ];
    const firstBuild = await readArtifacts(".openpond", buildArtifacts);
    const manifest = JSON.parse(firstBuild["agent-manifest.json"]) as Record<string, any>;
    expect(manifest.schema).toBe("openpond.agent.manifest.v1");
    expect(manifest.actions[0].schema).toBe("openpond.agent.action.v1");
    expect(manifest.actionCatalog[1]).toMatchObject({
      id: "answer-direct",
      implementation: { type: "workflow", workflowId: "answer" },
      inputSchema: "AnswerInput",
    });
    expect(manifest.channels[0].schema).toBe("openpond.agent.channel.v1");
    expect(manifest.channels[1]).toMatchObject({
      schema: "openpond.agent.channel.v1",
      id: "slack",
      target: { action: "chat" },
      adapter: {
        normalizeEvent: { output: "AgentChatInput" },
        renderResponse: { input: "AgentChatResult" },
      },
      setupRequirements: [
        { kind: "integration", name: "slack", required: true, satisfied: true },
      ],
      setupStatus: "ready",
    });
    expect(manifest.chat.schema).toBe("openpond.agent.intent-router.v1");
    expect(manifest.editable.schema).toBe("openpond.agent.editable-policy.v1");
    expect(manifest.envRefs[0]).toMatchObject({
      schema: "openpond.agent.env-secret.v1",
      name: "OPENAI_API_KEY",
      required: true,
      secret: true,
    });
    expect(JSON.stringify(manifest.envRefs)).not.toContain("literal");
    expect(manifest.integrations[0].schema).toBe("openpond.agent.integration.v1");
    expect(manifest.integrations).toEqual(expect.arrayContaining([
      expect.objectContaining({
        provider: "google",
        required: true,
        setupSurface: "oauth_connector",
        capabilities: ["google.drive.file.read"],
      }),
    ]));
    expect(firstBuild["openpond-manifest.preview.yaml"]).toContain("provider: google");
    expect(firstBuild["openpond-manifest.preview.yaml"]).toContain("google.drive.file.read");
    expect(manifest.schedules[0].schema).toBe("openpond.agent.schedule.v1");
    expect(manifest.tools[0].schema).toBe("openpond.agent.tool.v1");
    expect(manifest.volumes[0].schema).toBe("openpond.agent.volume.v1");
    expect(manifest.workflows[0].schema).toBe("openpond.agent.workflow.v1");
    expect(manifest.evals[0].schema).toBe("openpond.agent.eval.v1");
    expect(manifest.instructions.artifactRef).toBe(".openpond/prompts/instructions.md");
    expect(manifest.instructions.schema).toBe("openpond.agent.instructions.v1");
    expect(manifest.instructions.sourceHash).toMatch(/^[a-f0-9]{64}$/);
    expect(manifest.skills[0]).toMatchObject({
      schema: "openpond.agent.skill.v1",
      name: "tone",
      artifactRef: ".openpond/skills/tone/SKILL.md",
      source: "generated",
    });
    expect(manifest.skills[0].sourceHash).toMatch(/^[a-f0-9]{64}$/);
    expect(manifest.skills[0].files[0]).toMatchObject({
      path: "references/tone.md",
      artifactRef: ".openpond/skills/tone/references/tone.md",
    });
    expect(parseSkillMarkdown(firstBuild["skills/tone/SKILL.md"])).toMatchObject({
      name: "tone",
      description: "Use when shaping answer tone.",
      body: "Be concise.",
      messages: [],
    });
    await runSdkJson(["build", "--json", "--cwd", fixtureRoot]);
    const secondBuild = await readArtifacts(".openpond", buildArtifacts);
    expect(secondBuild).toEqual(firstBuild);
    const actionRegistry = JSON.parse(firstBuild["action-registry.json"]) as Record<string, any>;
    expect(actionRegistry.schema).toBe("openpond.agent.action-registry.v1");

    const customInspect = await runSdkJson([
      "inspect",
      "--json",
      "--cwd",
      fixtureRoot,
      "--out-dir",
      ".openpond-custom",
    ]);
    expect(customInspect.generatedArtifacts.inspectJson).toBe(
      ".openpond-custom/agent-inspect.json",
    );

    const validation = await runSdkJson(["validate", "--json", "--cwd", fixtureRoot]);
    expect(validation.schema).toBe("openpond.agent.validation.v1");
    expect(validation.status).toBe("passed");
    expect(validation.issues).toEqual([]);
    expect(validation.errors).toEqual([]);

    const evalResult = await runSdkJson(["eval", "--json", "--cwd", fixtureRoot]);
    expect(evalResult.schema).toBe("openpond.agent.eval-results.v1");
    expect(evalResult.summary).toMatchObject({ total: 1, passed: 1, failed: 0 });
    expect(evalResult.source.configPath).toBe("agent/agent.ts");
    expect(evalResult.source.configHash).toMatch(/^[a-f0-9]{64}$/);
    expect(evalResult.publishGate).toMatchObject({
      status: "passed",
      total: 1,
      passed: 1,
      failed: 0,
      blockingFailures: [],
    });
    expect(evalResult.results[0].fixtures[0]).toMatchObject({
      path: "agent/evals/fixtures/hello.json",
    });
    expect(evalResult.results[0].fixtures[0].hash).toMatch(/^[a-f0-9]{64}$/);
    expect(evalResult.results[0].summary.assertions).toMatchObject({
      total: 8,
      passed: 8,
      failed: 0,
    });
    expect(evalResult.results[0].assertions.map((assertion: Record<string, any>) => assertion.name)).toEqual([
      "intent:answer",
      "artifact:artifacts/test-answer.json",
      "trace:test.answer.started",
      "trace:skill.loaded",
      "trace:step.completed",
      "trace:model.completed",
      "trace:tool.completed",
      "text_includes:direct",
    ]);
    const trace = await readFile(
      path.join(fixtureRoot, evalResult.results[0].traceArtifactRef),
      "utf8",
    );
    const firstTraceLine = JSON.parse(trace.split("\n")[0]!) as Record<string, any>;
    expect(firstTraceLine.schema).toBe("openpond.agent.trace.v1");
    expect(trace).toContain('"name":"skill.loaded"');
    expect(trace).toContain('"name":"step.completed"');
    expect(trace).toContain('"name":"model.completed"');
    expect(trace).toContain('"name":"tool.completed"');
    expect(trace).toContain("[redacted]");
    expect(trace).not.toContain("do-not-store");
  });

  test("exposes connected integration helpers from bundle metadata", () => {
    expect(isConnectedIntegrationProvider("google")).toBe(true);
    expect(isConnectedIntegrationProvider("slack")).toBe(false);
    expect(isConnectedIntegrationProvider("mcp")).toBe(false);
    expect(connectedIntegration.providers).toEqual(["google", "github", "x"]);
    expect(connectedIntegrationCapabilityIds("google")).toEqual(expect.arrayContaining([
      "google.drive.file.read",
      "google.docs.write",
    ]));
    expect(connectedIntegration.catalog()).toEqual(expect.arrayContaining([
      expect.objectContaining({
        provider: "google",
        defaultLeaseCapabilityIds: expect.arrayContaining(["google.drive.file.read"]),
      }),
    ]));
    expect(connectedIntegration.google({
      required: true,
      capabilities: ["google.drive.file.read"],
    })).toMatchObject({
      provider: "google",
      setupSurface: "oauth_connector",
      capabilities: ["google.drive.file.read"],
    });
    expect(() =>
      connectedIntegration.google({ capabilities: ["github.repo.read"] }),
    ).toThrow("Capability github.repo.read is not declared by google.");
  });

  test("validator emits stable machine-readable issues", async () => {
    const validation = await runSdkJsonAllowFailure(["validate", "--json", "--cwd", invalidFixtureRoot]);
    expect(validation.exitCode).toBe(1);
    expect(validation.payload).toMatchObject({
      schema: "openpond.agent.validation.v1",
      status: "failed",
      summary: { errors: 2 },
    });
    const issues = validation.payload.issues as Array<Record<string, any>>;
    expect(issues.map((issue) => issue.code)).toEqual([
      "default_action_missing",
      "channel_missing_integration_requirement",
      "env_secret_value_inline",
      "source_file_missing",
      "skill_description_missing",
      "skill_generated_file_path_invalid",
    ]);
    expect(issues[0]).toMatchObject({
      severity: "error",
      path: "defaultAction",
      summary: "Default action missing is not declared.",
    });
    expect(issues[1]).toMatchObject({
      severity: "warning",
      setupRequirement: { kind: "integration", name: "slack", required: true },
    });
    expect(issues[2]).toMatchObject({
      severity: "error",
      setupRequirement: { kind: "env", name: "BAD_SECRET", required: true },
    });
    expect(validation.payload.errors).toEqual([
      "Default action missing is not declared.",
      "Env/secret BAD_SECRET appears to contain an inline value. Store values in OpenPond secret storage.",
    ]);
    expect(validation.payload.warnings.length).toBe(4);
  });
});

async function readArtifacts(artifactDir: string, names: string[]) {
  const entries: Record<string, string> = {};
  for (const name of names) {
    entries[name] = await readFile(path.join(fixtureRoot, artifactDir, name), "utf8");
  }
  return entries;
}

async function runSdkJson(args: string[]) {
  const { stdout, stderr, exitCode } = await runTestProcess(
    process.execPath,
    ["./dist/cli.js", ...args],
    { cwd: packageRoot },
  );
  if (exitCode !== 0) {
    throw new Error(
      [
        `openpond-agent ${args.join(" ")} failed with exit code ${exitCode}`,
        stdout.trim(),
        stderr.trim(),
      ]
        .filter(Boolean)
        .join("\n"),
    );
  }
  return JSON.parse(stdout) as Record<string, any>;
}

async function runSdkJsonAllowFailure(args: string[]) {
  const { stdout, stderr, exitCode } = await runTestProcess(
    process.execPath,
    ["./dist/cli.js", ...args],
    { cwd: packageRoot },
  );
  if (!stdout.trim()) {
    throw new Error(
      [
        `openpond-agent ${args.join(" ")} produced no JSON with exit code ${exitCode}`,
        stderr.trim(),
      ].filter(Boolean).join("\n"),
    );
  }
  return { exitCode, payload: JSON.parse(stdout) as Record<string, any> };
}
