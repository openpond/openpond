import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  action,
  defineAgentProject,
  defineEval,
  defineIntent,
  defineIntentRouter,
  defineSkill,
  defineWorkflow,
} from "openpond-agent-sdk/primitives";
import { defineChannel } from "openpond-agent-sdk/channels";
import { validateAgentProject } from "openpond-agent-sdk/validator";

const packageRoot = path.resolve(import.meta.dir, "..");
const fixtureRoot = path.join(packageRoot, ".openpond-test-fixtures", "validation-issues-contract");

const answerWorkflow = defineWorkflow({
  name: "answer-workflow",
  async run() {
    return { text: "ok", intent: "answer" };
  },
});

const answerIntent = defineIntent({
  name: "answer",
  description: "Answer.",
  async run(ctx, input) {
    return ctx.workflow("answer-workflow", input);
  },
});

describe("validation issue contract", () => {
  beforeAll(async () => {
    await rm(fixtureRoot, { force: true, recursive: true });
    await mkdir(validTsCwd(), { recursive: true });
    await mkdir(path.join(validTsCwd(), "agent"), { recursive: true });
    await writeFile(path.join(validTsCwd(), "agent", "agent.ts"), "export default {};\n", "utf8");
    await writeFile(path.join(validTsCwd(), "agent", "instructions.md"), "# Instructions\n", "utf8");
    await mkdir(path.join(fixtureRoot, "drift", "agent"), { recursive: true });
    await writeFile(path.join(fixtureRoot, "drift", "agent", "agent.ts"), "export default {};\n", "utf8");
    await writeFile(path.join(fixtureRoot, "drift", "openpond.yaml"), "name: drift\n", "utf8");
    await mkdir(path.join(fixtureRoot, "synthesized-yaml", "agent"), { recursive: true });
    await writeFile(path.join(fixtureRoot, "synthesized-yaml", "agent", "agent.ts"), "export default {};\n", "utf8");
    await writeFile(
      path.join(fixtureRoot, "synthesized-yaml", "openpond.yaml"),
      "# openpond-agent-sdk-source-upload: synthesized-openpond-yaml\nname: generated\n",
      "utf8"
    );
    await mkdir(path.join(fixtureRoot, "missing-source"), { recursive: true });
  });

  afterAll(async () => {
    await rm(fixtureRoot, { force: true, recursive: true });
  });

  test("pins required project and source-of-truth issue codes", () => {
    expect(issueCodes(validateAgentProject({
      ...baseProject(),
      name: "",
      version: "",
      actions: [],
    }, path.join(fixtureRoot, "missing-source")))).toEqual(expect.arrayContaining([
      "project_name_required",
      "project_version_required",
      "agent_config_missing",
      "action_required",
    ]));

    expect(issueCodes(validateAgentProject({
      ...baseProject(),
      manifestMode: "openpond-yaml",
    }, path.join(fixtureRoot, "missing-source")))).toContain("openpond_yaml_missing");

    expect(issueCodes(validateAgentProject({
      ...baseProject(),
      manifestMode: "typescript",
    }, path.join(fixtureRoot, "drift")))).toContain("typescript_manifest_openpond_yaml_drift");

    expect(issueCodes(validateAgentProject({
      ...baseProject(),
      manifestMode: "typescript",
    }, path.join(fixtureRoot, "synthesized-yaml")))).not.toContain("typescript_manifest_openpond_yaml_drift");

    expect(issueCodes(validateAgentProject({
      ...baseProject(),
      manifestMode: "extends-openpond-yaml",
      extendsManifest: "./missing-openpond.yaml",
    }, validTsCwd()))).toContain("extends_manifest_missing");
  });

  test("pins action, router, workflow, tool, schedule, and channel issue codes", () => {
    const duplicateIntent = defineIntent({
      name: "answer",
      description: "Duplicate.",
      async run() {
        return { text: "duplicate", intent: "answer" };
      },
    });
    const missingDefaultIntent = defineIntent({
      name: "missing-default",
      description: "Missing.",
      async run() {
        return { text: "missing", intent: "missing-default" };
      },
    });
    const invalidRouter = defineIntentRouter({
      intents: [answerIntent, duplicateIntent],
      defaultIntent: missingDefaultIntent,
    });
    const issues = validateAgentProject({
      ...baseProject(),
      defaultAction: "missing-default-action",
      actions: [
        action("chat", { target: { kind: "intent-router", router: invalidRouter } }),
        action("chat", { target: { kind: "workflow", workflow: answerWorkflow } }),
        action("missing-workflow-action", { target: { kind: "workflow", workflow: "missing-workflow" } }),
      ],
      tools: [
        {
          kind: "tool",
          name: "bad-tool",
          description: "Bad tool.",
          visibility: "end_user",
          target: { kind: "action", action: "missing-action", workflow: "missing-workflow" },
        },
      ],
      schedules: [
        {
          kind: "schedule",
          name: "bad-schedule",
          scheduleType: "rate",
          target: { action: "missing-action" },
        },
      ],
      channels: [
        defineChannel({
          id: "slack",
          target: { action: "missing-action" },
          requiredConnections: ["slack"],
          normalizeEvent: () => ({ prompt: "hello", channel: "slack" }),
          renderResponse: (result) => ({ text: result.text }),
        }),
      ],
      workflows: [answerWorkflow],
    }, validTsCwd());

    expect(issueCodes(issues)).toEqual(expect.arrayContaining([
      "action_duplicate",
      "action_target_workflow_missing",
      "default_action_missing",
      "intent_duplicate",
      "intent_default_missing",
      "tool_target_action_missing",
      "tool_target_workflow_missing",
      "schedule_target_action_missing",
      "channel_target_action_missing",
      "channel_missing_integration_requirement",
    ]));
  });

  test("pins env, volume, editable, eval, skill, source, and secret issue codes", () => {
    const manyFiles = Object.fromEntries(
      Array.from({ length: 51 }, (_, index) => [`file-${index}.md`, "content"]),
    );
    const issues = validateAgentProject({
      ...baseProject(),
      actions: [
        action("chat", {
          target: { kind: "workflow", workflow: answerWorkflow },
          outputArtifacts: ["artifacts/declared.json"],
        }),
      ],
      workflows: [answerWorkflow],
      volumes: [
        {
          name: "state",
          mountPath: "/workspace/volumes/state",
          provisioning: { mode: "select-or-create", scope: "project" },
          usedBy: ["missing-action"],
        },
      ],
      env: [
        { kind: "env", name: "", required: true },
        { kind: "env", name: "DUPLICATE", required: true },
        { kind: "env", name: "DUPLICATE", required: false },
        { kind: "env", name: "INLINE_SECRET", required: true, value: "raw-secret" },
      ],
      editable: {
        kind: "editable",
        enabled: true,
        backend: "other-backend" as never,
        runtimeEnvironmentId: "openpond-coding-core-v1",
        sourceOfTruth: "agent-source",
        policyDiscovery: { command: "openpond agent inspect --json", runAfter: "source-materialized" },
        allowedPaths: [],
        requiredChecks: [],
        defaultResultMode: "patch_only",
      },
      instructions: "./agent/missing-instructions.md",
      skills: [
        defineSkill({ name: "missing-description", source: "Skill body." }),
        defineSkill({ name: "missing-source", description: "Missing source." }),
        defineSkill({
          name: "unsafe-files",
          description: "Unsafe files.",
          source: "Body.",
          files: { "../outside.md": "not allowed", ...manyFiles },
        }),
      ],
      integrations: [{ provider: "github", required: true, token: "raw-token" }],
      evals: [
        defineEval({
          name: "missing-artifact",
          description: "Expected artifact is not declared.",
          expectedArtifacts: ["artifacts/missing.json"],
          async run() {},
        }),
      ],
    }, validTsCwd());

    expect(issueCodes(issues)).toEqual(expect.arrayContaining([
      "volume_used_by_action_missing",
      "env_name_required",
      "env_duplicate",
      "env_secret_value_inline",
      "editable_backend_invalid",
      "editable_allowed_paths_missing",
      "editable_required_checks_missing",
      "source_file_missing",
      "skill_description_missing",
      "skill_source_missing",
      "skill_generated_file_count_exceeded",
      "skill_generated_file_path_invalid",
      "secret_leakage_detected",
      "eval_expected_artifact_not_declared",
    ]));
  });
});

function baseProject() {
  return defineAgentProject({
    name: "validation-agent",
    version: "0.1.0",
    useCase: "validation",
    manifestMode: "typescript",
    runtime: { base: "node-bun-workspace" },
    defaultAction: "chat",
    actions: [action("chat", { target: { kind: "workflow", workflow: answerWorkflow } })],
    workflows: [answerWorkflow],
  });
}

function validTsCwd() {
  return path.join(fixtureRoot, "valid-ts");
}

function issueCodes(result: ReturnType<typeof validateAgentProject>) {
  return result.issues.map((issue) => issue.code);
}
