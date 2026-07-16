import { Buffer } from "node:buffer";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";

import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { runTestProcess } from "../../../tests/helpers/run-process";

const packageRoot = path.resolve(import.meta.dirname, "..");
const fixtureRoot = path.join(packageRoot, ".openpond-test-fixtures", "source-loader-contract");

describe("source loader contract", () => {
  beforeAll(async () => {
    await rm(fixtureRoot, { force: true, recursive: true });
    await createTypescriptFixture("typescript-only", { mode: "typescript" });
    await createOpenPondYamlFixture("openpond-yaml-only");
    await createTypescriptFixture("extends-yaml", {
      mode: "extends-openpond-yaml",
      withOpenPondYaml: true,
    });
    await createTypescriptFixture("typescript-with-yaml", {
      mode: "typescript",
      withOpenPondYaml: true,
    });
    await mkdir(path.join(fixtureRoot, "missing-source"), { recursive: true });
  });

  afterAll(async () => {
    await rm(fixtureRoot, { force: true, recursive: true });
  });

  test("loads TypeScript-only source with generated instruction and skill modules", async () => {
    const cwd = fixture("typescript-only");
    const inspect = await runSdkJson(["inspect", "--json", "--cwd", cwd]);
    expect(inspect.sourceLayout).toMatchObject({
      agentConfig: "agent/agent.ts",
      manifestMode: "typescript",
      openpondYaml: null,
    });

    await runSdkJson(["build", "--json", "--cwd", cwd]);
    const manifest = JSON.parse(
      await readFile(path.join(cwd, ".openpond", "agent-manifest.json"), "utf8"),
    ) as Record<string, any>;
    expect(manifest.sourceOfTruth).toBe("typescript");
    expect(manifest.instructions).toMatchObject({
      source: "generated",
      artifactRef: ".openpond/prompts/instructions.md",
    });
    expect(manifest.skills[0]).toMatchObject({
      name: "research",
      source: "generated",
      artifactRef: ".openpond/skills/research/SKILL.md",
    });
    expect(await readFile(path.join(cwd, ".openpond", "prompts", "instructions.md"), "utf8"))
      .toContain("Generated TypeScript instructions");
    expect(await readFile(path.join(cwd, ".openpond", "skills", "research", "SKILL.md"), "utf8"))
      .toContain("Research relevant project context");
  });

  test("loads openpond.yaml-only source as the language-neutral manifest mode", async () => {
    const cwd = fixture("openpond-yaml-only");
    const inspect = await runSdkJson(["inspect", "--json", "--cwd", cwd]);
    expect(inspect.sourceLayout).toMatchObject({
      agentConfig: "openpond.yaml",
      manifestMode: "openpond-yaml",
      openpondYaml: "openpond.yaml",
    });
    expect(inspect.capabilities.actions).toEqual(["chat", "export"]);
    expect(inspect.setup.volumes[0]).toMatchObject({
      name: "agent-state",
      mountPath: "/workspace/volumes/agent-state",
    });
    expect(inspect.setup.schedules[0]).toMatchObject({
      name: "daily",
      targetAction: "chat",
      setupStatus: "disabled",
    });

    await runSdkJson(["build", "--json", "--cwd", cwd]);
    const manifest = JSON.parse(
      await readFile(path.join(cwd, ".openpond", "agent-manifest.json"), "utf8"),
    ) as Record<string, any>;
    expect(manifest.sourceOfTruth).toBe("openpond-yaml");
    expect(manifest.actions.map((action: Record<string, any>) => action.name)).toEqual([
      "chat",
      "export",
    ]);

    const run = await runSdkJson([
      "run",
      "chat",
      "--json",
      "--cwd",
      cwd,
      "--input",
      JSON.stringify({ prompt: "hello", channel: "api" }),
    ]);
    expect(run.result).toMatchObject({
      intent: "chat",
      text: "Command-backed action chat is inspectable locally.",
    });
  });

  test("uses OpenPond action input environment for run commands", async () => {
    const cwd = fixture("typescript-only");
    const run = await runSdkJson(
      ["run", "chat", "--json", "--cwd", cwd],
      {
        OPENPOND_ACTION_INPUT_BASE64: Buffer.from(
          JSON.stringify({
            prompt: "from action env",
            channel: "openpond_chat",
          }),
          "utf8",
        ).toString("base64"),
      },
    );
    expect(run.result).toMatchObject({
      intent: "chat",
      text: "from action env",
    });
  });

  test("loads TypeScript projects that explicitly extend openpond.yaml", async () => {
    const cwd = fixture("extends-yaml");
    const inspect = await runSdkJson(["inspect", "--json", "--cwd", cwd]);
    expect(inspect.sourceLayout).toMatchObject({
      agentConfig: "agent/agent.ts",
      manifestMode: "extends-openpond-yaml",
      extendsManifest: "./openpond.yaml",
      openpondYaml: "openpond.yaml",
    });

    const validation = await runSdkJson(["validate", "--json", "--cwd", cwd]);
    expect(validation.status).toBe("passed");
  });

  test("rejects TypeScript projects with a root openpond.yaml unless they extend it", async () => {
    const validation = await runSdkJsonAllowFailure([
      "validate",
      "--json",
      "--cwd",
      fixture("typescript-with-yaml"),
    ]);
    expect(validation.exitCode).toBe(1);
    expect(validation.payload.issues.map((issue: Record<string, any>) => issue.code))
      .toContain("typescript_manifest_openpond_yaml_drift");
  });

  test("reports a useful error when neither source contract exists", async () => {
    const result = await runSdkAllowFailure([
      "inspect",
      "--json",
      "--cwd",
      fixture("missing-source"),
    ]);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("agent/agent.ts or openpond.yaml is required");
  });
});

async function createTypescriptFixture(
  name: string,
  options: { mode: "typescript" | "extends-openpond-yaml"; withOpenPondYaml?: boolean },
) {
  const cwd = fixture(name);
  await mkdir(path.join(cwd, "agent", "skills"), { recursive: true });
  await writeFile(
    path.join(cwd, "agent", "instructions.ts"),
    `import { defineInstructions } from "openpond-agent-sdk/instructions";

export default defineInstructions({
  markdown: "# Generated TypeScript instructions\\n\\nAnswer from the source contract.",
});
`,
    "utf8",
  );
  await writeFile(
    path.join(cwd, "agent", "skills", "research.ts"),
    `import { defineSkill } from "openpond-agent-sdk/skills";

export default defineSkill({
  name: "research",
  description: "Use when gathering source-backed context.",
  markdown: "Research relevant project context before answering.",
});
`,
    "utf8",
  );
  await writeFile(
    path.join(cwd, "agent", "agent.ts"),
    `import {
  action,
  defineAgentProject,
  defineWorkflow,
} from "openpond-agent-sdk/primitives";
import instructions from "./instructions.ts";
import researchSkill from "./skills/research.ts";

const chatWorkflow = defineWorkflow({
  name: "chat-workflow",
  async run(ctx, input) {
    await ctx.loadSkill("research");
    return { text: String(input.prompt ?? ""), intent: "chat" };
  },
});

export default defineAgentProject({
  name: "${name}",
  version: "0.1.0",
  useCase: "source-loader",
  manifestMode: "${options.mode}",
  ${options.mode === "extends-openpond-yaml" ? 'extendsManifest: "./openpond.yaml",' : ""}
  runtime: { base: "node-bun-workspace" },
  instructions,
  skills: [researchSkill],
  defaultAction: "chat",
  actions: [action("chat", { target: { kind: "workflow", workflow: chatWorkflow } })],
  workflows: [chatWorkflow],
});
`,
    "utf8",
  );
  if (options.withOpenPondYaml) await writeOpenPondYaml(cwd);
}

async function createOpenPondYamlFixture(name: string) {
  const cwd = fixture(name);
  await mkdir(cwd, { recursive: true });
  await writeOpenPondYaml(cwd);
}

async function writeOpenPondYaml(cwd: string) {
  await mkdir(cwd, { recursive: true });
  await writeFile(
    path.join(cwd, "openpond.yaml"),
    `name: yaml-agent
version: 0.1.0
useCase: yaml-source
runtime:
  base: node-bun-workspace
validation:
  commands:
    - openpond-agent validate
actions:
  - name: chat
    command: pnpm chat
    timeoutSeconds: 120
    artifactPaths:
      - artifacts/chat.json
  - name: export
    command: pnpm export
volumes:
  - name: agent-state
    mountPath: /workspace/volumes/agent-state
    storageGb: 1
schedules:
  - name: daily
    rate: 1 day
    enabled: false
    action: chat
inputs:
  env:
    - name: API_TOKEN
      required: true
      secret: true
integrations:
  requiredLeases:
    - provider: slack
      scopes:
        - chat:write
permissions:
  opchat:
    models:
      - openpond-default
`,
    "utf8",
  );
}

function fixture(name: string) {
  return path.join(fixtureRoot, name);
}

async function runSdkJson(args: string[], env?: Record<string, string>) {
  const result = await runSdk(args, env);
  if (result.exitCode !== 0) {
    throw new Error(formatFailure(args, result));
  }
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

async function runSdkAllowFailure(args: string[]) {
  return runSdk(args);
}

async function runSdk(args: string[], env?: Record<string, string>) {
  return runTestProcess(process.execPath, ["./dist/cli.js", ...args], {
    cwd: packageRoot,
    env: env ? { ...process.env, ...env } : process.env,
  });
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
