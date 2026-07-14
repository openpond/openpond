import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  inspectChannelSetup,
  normalizeChannelEvent,
  renderChannelResponse,
} from "openpond-agent-sdk/channels";
import type { AgentProjectDefinition } from "openpond-agent-sdk/primitives";

const packageRoot = path.resolve(import.meta.dir, "..");
const fixtureRoot = path.join(packageRoot, ".openpond-test-fixtures", "pilot-examples-contract");

describe("pilot example contract", () => {
  beforeAll(async () => {
    await rm(fixtureRoot, { force: true, recursive: true });
    await mkdir(fixtureRoot, { recursive: true });
  });

  afterAll(async () => {
    await rm(fixtureRoot, { force: true, recursive: true });
  });

  test("covers TypeScript-generated prompts while preserving markdown-only prompts", async () => {
    const blankBuild = await runSdkJson(["build", "--json", "--cwd", example("blank-agent")]);
    expect(blankBuild.manifest.instructions.source).toBe("./agent/instructions.md");
    expect(blankBuild.manifest.skills[0]).toMatchObject({
      name: "basic",
      source: "./agent/skills/basic.md",
    });

    const customerBuild = await runSdkJson(["build", "--json", "--cwd", example("customer-reply-agent")]);
    expect(customerBuild.manifest.instructions).toMatchObject({
      source: "generated",
      artifactRef: ".openpond/prompts/instructions.md",
    });
    expect(customerBuild.manifest.skills[0]).toMatchObject({
      name: "reply-style",
      source: "generated",
      artifactRef: ".openpond/skills/reply-style/SKILL.md",
    });
    expect(customerBuild.manifest.skills[0].files[0]).toMatchObject({
      path: "references/tone.md",
      artifactRef: ".openpond/skills/reply-style/references/tone.md",
    });
    expect(await readFile(
      path.join(example("customer-reply-agent"), ".openpond", "prompts", "instructions.md"),
      "utf8",
    )).toContain("Do not invent commitments");
  });

  test("verifies blank and customer pilots keep their intended product shape", async () => {
    const blank = await runSdkJson(["inspect", "--json", "--cwd", example("blank-agent")]);
    expect(blank.agent.defaultAction).toBe("chat");
    expect(blank.capabilities.actions).toEqual(["chat", "answer"]);
    expect(blank.capabilities.channels).toEqual(["openpond_chat"]);
    expect(blank.capabilities.evals).toEqual(["vague-request-asks-clarifying-question"]);
    expect(blank.capabilities.integrations).toEqual([]);
    expect(blank.capabilities.volumes).toEqual([]);
    expect(blank.editable).toMatchObject({
      enabled: true,
      defaultResultMode: "patch_only",
    });

    const customer = await runSdkJson(["inspect", "--json", "--cwd", example("customer-reply-agent")]);
    expect(customer.agent.defaultAction).toBe("chat");
    expect(customer.capabilities.channels).toEqual(["openpond_chat", "slack"]);
    expect(customer.capabilities.evals).toEqual(["drafts-customer-reply"]);
    expect(customer.setup.channels.find((channel: Record<string, unknown>) => channel.id === "slack"))
      .toMatchObject({
        enabledByDefault: false,
        setupStatus: "ready",
        requiredConnections: ["slack"],
      });
    const run = await runSdkJson([
      "run",
      "chat",
      "--cwd",
      example("customer-reply-agent"),
      "--input",
      JSON.stringify({ prompt: "Draft a customer reply about the scheduling update.", channel: "openpond_chat" }),
    ]);
    expect(run.result).toMatchObject({
      intent: "draft_customer_reply",
      text: expect.stringContaining("scheduling update"),
    });
  });

  test("covers channel normalization/rendering and missing setup states", async () => {
    const water = await importProject("water-estimator-agent");
    const teamsInput = normalizeChannelEvent(water, "microsoft_teams", {
      text: "review this drawing",
      conversationId: "conversation-1",
      attachments: [{ contentUrl: "https://example.test/file.pdf", name: "plan.pdf", contentType: "application/pdf" }],
    });
    expect(teamsInput).toMatchObject({
      prompt: "review this drawing",
      channel: "microsoft_teams",
      conversationId: "conversation-1",
      files: [{ ref: "https://example.test/file.pdf", name: "plan.pdf", mimeType: "application/pdf" }],
    });
    expect(renderChannelResponse(water, "microsoft_teams", {
      text: "done",
      artifactRefs: ["artifacts/task-plan.xlsx"],
      metadata: { sharePointRefs: ["sharepoint-file"] },
    })).toEqual({
      text: "done",
      status: "completed",
      artifactRefs: ["artifacts/task-plan.xlsx"],
      sharePointRefs: ["sharepoint-file"],
    });

    const integrationHeavy = await importProject("integration-heavy-agent");
    expect(inspectChannelSetup(integrationHeavy, "slack")).toMatchObject({
      setupStatus: "ready",
      requiredConnections: ["slack"],
      setupRequirements: [{ kind: "integration", name: "slack", required: true, satisfied: true }],
    });
    expect(inspectChannelSetup({ ...integrationHeavy, integrations: [] }, "slack")).toMatchObject({
      setupStatus: "missing_setup",
      setupRequirements: [{ kind: "integration", name: "slack", required: true, satisfied: false }],
    });
  });

  test("covers integration-heavy setup slots, disabled schedule, volume, evals, traces, and artifacts", async () => {
    const inspect = await runSdkJson(["inspect", "--json", "--cwd", example("integration-heavy-agent")]);
    expect(inspect.setup.integrations).toEqual(expect.arrayContaining([
      expect.objectContaining({ provider: "slack", required: true }),
      expect.objectContaining({ provider: "opchat", required: true }),
      expect.objectContaining({ provider: "github", required: false }),
    ]));
    expect(inspect.setup.envRefs).toEqual([
      expect.objectContaining({ name: "OPENAI_API_KEY", required: true, secret: true }),
    ]);
    expect(inspect.setup.volumes).toEqual([
      expect.objectContaining({
        name: "project-state",
        mountPath: "/workspace/volumes/project-state",
        provisioning: expect.objectContaining({ mode: "select-or-create", scope: "project" }),
      }),
    ]);
    expect(inspect.setup.schedules).toEqual([
      expect.objectContaining({
        name: "weekday-summary",
        targetAction: "chat",
        setupStatus: "disabled",
        enabledByDefault: false,
      }),
    ]);

    const evalResult = await runSdkJson(["eval", "--json", "--cwd", example("integration-heavy-agent")]);
    expect(evalResult.summary).toMatchObject({ total: 1, failed: 0 });
    expect(evalResult.results[0].traceArtifactRef).toMatch(/^\.openpond\/traces\/summarizes-update-/);

    const runResult = await runSdkJson([
      "run",
      "chat",
      "--cwd",
      example("integration-heavy-agent"),
      "--input",
      JSON.stringify({ prompt: "Blocked on review.", channel: "openpond_chat" }),
    ]);
    expect(runResult.result).toMatchObject({
      intent: "summarize",
      artifactRefs: ["artifacts/summary.json"],
    });

    const artifactIndex = JSON.parse(
      await readFile(path.join(example("integration-heavy-agent"), ".openpond", "artifact-index.json"), "utf8"),
    ) as { entries: Array<{ kind: string; path: string }> };
    expect(artifactIndex.entries).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: "eval-results", path: ".openpond/eval-results.json" }),
      expect.objectContaining({ kind: "trace-jsonl", path: evalResult.results[0].traceArtifactRef }),
      expect.objectContaining({ kind: "trace-jsonl", path: runResult.traceArtifactRef }),
    ]));
  });

  test("keeps water estimator as the complex workflow pilot", async () => {
    const inspect = await runSdkJson(["inspect", "--json", "--cwd", example("water-estimator-agent")]);
    expect(inspect.capabilities.actions).toEqual(expect.arrayContaining([
      "chat",
      "generate-task-plan",
      "render-drawings",
      "extract-sheet-index",
      "extract-page-tasks",
      "consolidate-task-plan",
      "export-task-plan",
      "generate-estimate",
      "task-plan-history",
      "revise-task-plan",
    ]));
    expect(inspect.capabilities.channels).toEqual(expect.arrayContaining([
      "openpond_chat",
      "microsoft_teams",
      "slack",
      "mcp",
    ]));
    expect(inspect.capabilities.volumes).toEqual(["drawing-plans", "water-history"]);
    expect(inspect.capabilities.schedules).toEqual(["daily-estimate-digest"]);
    expect(inspect.editable.requiredChecks.join("\n")).toContain("validate");
    expect(inspect.editable.requiredChecks.join("\n")).toContain("eval");
    expect(Object.keys(inspect.inputSchema.properties)).toEqual(expect.arrayContaining([
      "drawingFiles",
      "historyFiles",
      "proposalFile",
      "taskPageSelection",
      "visionDetail",
    ]));
    expect(inspect.inputSchemas).toHaveProperty("DrawingTaskPlanInput");

    await runSdkJson(["build", "--json", "--cwd", example("water-estimator-agent")]);
    const manifest = JSON.parse(
      await readFile(path.join(example("water-estimator-agent"), ".openpond", "agent-manifest.json"), "utf8"),
    ) as {
      actions: Array<{ name: string; timeoutSeconds: number | null; outputArtifacts: string[] }>;
      inputSchema: { properties: Record<string, unknown> };
    };
    const chatAction = manifest.actions.find((entry) => entry.name === "chat");
    expect(chatAction?.timeoutSeconds).toBe(10800);
    expect(chatAction?.outputArtifacts).toEqual(expect.arrayContaining([
      "artifacts/chat-result.json",
      "artifacts/task-plan.xlsx",
      "artifacts/proposal-review.json",
    ]));
    expect(manifest.inputSchema.properties).toHaveProperty("drawingFiles");

    const runtimeManifest = await readFile(
      path.join(example("water-estimator-agent"), ".openpond", "openpond-manifest.preview.yaml"),
      "utf8",
    );
    expect(runtimeManifest).toContain("Construction drawing PDFs");
    expect(runtimeManifest).toContain("targetPath: volumes/drawing-plans/drawings");
  });

  test("binds Cross-System Operations actions and tools to shared named input schemas", async () => {
    const project = await importProject("cross-system-operations");
    const expectedSchemaNames = [
      "query_billing.input",
      "run_python.input",
      "search_crm.input",
      "search_support.input",
    ];

    expect(Object.keys(project.inputSchemas ?? {}).sort()).toEqual(expectedSchemaNames);
    expect(
      project.actions
        .filter((entry) => entry.name !== "chat")
        .map((entry) => entry.inputSchema)
        .sort(),
    ).toEqual(expectedSchemaNames);
    expect(project.tools?.map((entry) => entry.inputSchema).sort()).toEqual(expectedSchemaNames);
  });

  test("detects manifest drift on a real pilot copy", async () => {
    const driftCwd = path.join(fixtureRoot, "blank-agent-drift");
    await cp(example("blank-agent"), driftCwd, { recursive: true });
    await rm(path.join(driftCwd, ".openpond"), { force: true, recursive: true });
    await writeFile(path.join(driftCwd, "openpond.yaml"), "name: drift\n", "utf8");

    const validation = await runSdkJsonAllowFailure(["validate", "--json", "--cwd", driftCwd]);
    expect(validation.exitCode).toBe(1);
    expect(validation.payload.issues.map((issue: Record<string, unknown>) => issue.code))
      .toContain("typescript_manifest_openpond_yaml_drift");
  });
});

async function importProject(name: string): Promise<AgentProjectDefinition> {
  const configPath = path.join(example(name), "agent", "agent.ts");
  const moduleUrl = `${pathToFileURL(configPath).href}?pilot=${Date.now()}-${Math.random()}`;
  const mod = await import(moduleUrl) as { default: AgentProjectDefinition };
  return mod.default;
}

function example(name: string) {
  return path.join(packageRoot, "examples", name);
}

async function runSdkJson(args: string[]) {
  const result = await runSdk(args);
  if (result.exitCode !== 0) throw new Error(formatFailure(args, result));
  return JSON.parse(result.stdout) as Record<string, any>;
}

async function runSdkJsonAllowFailure(args: string[]) {
  const result = await runSdk(args);
  if (!result.stdout.trim()) throw new Error(formatFailure(args, result));
  return {
    exitCode: result.exitCode,
    payload: JSON.parse(result.stdout) as Record<string, any>,
  };
}

async function runSdk(args: string[]) {
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
  return { stdout, stderr, exitCode };
}

function formatFailure(
  args: string[],
  result: { stdout: string; stderr: string; exitCode: number },
) {
  return [
    `openpond-agent ${args.join(" ")} failed with exit code ${result.exitCode}`,
    result.stdout.trim(),
    result.stderr.trim(),
  ].filter(Boolean).join("\n");
}
