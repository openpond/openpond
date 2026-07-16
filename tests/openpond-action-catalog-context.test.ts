import { describe, expect, test } from "vitest";
import type { RuntimeEvent, Session } from "@openpond/contracts";

import { createHostedTurnHelpers } from "../apps/server/src/openpond/hosted-turn-helpers";

const session: Session = {
  id: "session_1",
  provider: "openpond",
  title: "OpenPond Project Chat",
  appId: null,
  appName: null,
  workspaceKind: "sandbox",
  workspaceId: "project_1",
  workspaceName: "Water Project",
  cwd: null,
  codexThreadId: null,
  createdAt: "2026-06-20T00:00:00.000Z",
  updatedAt: "2026-06-20T00:00:00.000Z",
  status: "idle",
  pinned: false,
  archived: false,
  order: 0,
};

describe("OpenPond action catalog context", () => {
  test("adds schema-backed project actions to ordinary hosted chat turns", async () => {
    const helpers = createHostedTurnHelpers({
      appendRuntimeEvent: async (_event: RuntimeEvent) => {},
    });

    const prompt = await helpers.hostedSystemPrompt(
      "Base hosted prompt.",
      "",
      session,
      {
        openPondActionCatalog: [
          {
            id: "water.estimate",
            label: "Run Water Estimate",
            description: "Run the workflow directly.",
            inputSchema: {
              type: "object",
              properties: {
                parcelId: { type: "string" },
              },
              required: ["parcelId"],
            },
            outputSchema: {
              type: "object",
              properties: {
                status: { type: "string" },
              },
            },
            implementation: { type: "workflow", workflowId: "water-estimate" },
          },
        ],
      },
    );

    expect(prompt).toContain("OpenPond project action catalog:");
    expect(prompt).toContain("- Use sandbox_run_action only when an action is needed");
    expect(prompt).toContain("- Do not infer hidden action names from user text.");
    expect(prompt).toContain("water.estimate: Run Water Estimate - Run the workflow directly.");
    expect(prompt).toContain('inputSchema: {"type":"object","properties":{"parcelId":{"type":"string"}},"required":["parcelId"]}');
    expect(prompt).toContain('outputSchema: {"type":"object","properties":{"status":{"type":"string"}}}');
  });

  test("uses native action and narrow resource instructions in native-resource mode", async () => {
    const helpers = createHostedTurnHelpers({
      appendRuntimeEvent: async (_event: RuntimeEvent) => {},
    });

    const prompt = await helpers.hostedSystemPrompt(
      "Base hosted prompt.",
      "",
      session,
      {
        toolInstructionMode: "resource_text_fallback",
        actionCatalogInstructionMode: "native_tool",
        openPondActionCatalog: [
          {
            id: "water.estimate",
            label: "Run Water Estimate",
            description: "Run the workflow directly.",
            implementation: { type: "workflow", workflowId: "water-estimate" },
          },
        ],
      },
    );

    expect(prompt).toContain("Available fallback actions: resource_search, resource_read.");
    expect(prompt).toContain("- Use openpond_action_run only with an actionId from this catalog");
    expect(prompt).toContain("- Use available native resource tools for inspection");
    expect(prompt).not.toContain("Available actions: create_sandbox_template_scaffold");
    expect(prompt).not.toContain("- Use sandbox_run_action only when an action is needed");
    expect(prompt).not.toContain("- Use sandbox_status, sandbox_list_files");
  });

  test("adds bounded profile skill metadata without injecting bodies", async () => {
    const helpers = createHostedTurnHelpers({
      appendRuntimeEvent: async (_event: RuntimeEvent) => {},
    });

    const prompt = await helpers.hostedSystemPrompt(
      "Base hosted prompt.",
      "",
      session,
      {
        profileSkillInstructionMode: "native_tool",
        openPondProfileSkills: [
          {
            name: "release-notes",
            description: "Draft concise release notes from merged user-facing changes.",
            path: "skills/release-notes/SKILL.md",
            scope: "profile",
            enabled: true,
            sourcePath: "/tmp/profile/profiles/default",
            charCount: 200,
            sourceHash: "a".repeat(64),
            validationStatus: "valid",
            validationMessages: [],
          },
        ],
      },
    );

    expect(prompt).toContain("OpenPond profile skills:");
    expect(prompt).toContain("- Load a profile skill before following it by calling profile_skill_read");
    expect(prompt).toContain("do so only with tools that are actually available in this turn");
    expect(prompt).toContain("If the loaded skill requires a tool that is unavailable");
    expect(prompt).toContain("use copyable fenced Markdown with a newline after the opening fence");
    expect(prompt).toContain("- release-notes: Draft concise release notes from merged user-facing changes.");
    expect(prompt).not.toContain("Identify user-facing changes first");
  });

  test("adds compact OpenPond capability index before profile skills", async () => {
    const helpers = createHostedTurnHelpers({
      appendRuntimeEvent: async (_event: RuntimeEvent) => {},
    });

    const prompt = await helpers.hostedSystemPrompt(
      "Base hosted prompt.",
      "",
      session,
      {
        toolInstructionMode: "none",
        profileSkillInstructionMode: "native_tool",
        openPondProfileSkills: [
          {
            name: "release-notes",
            description: "Draft concise release notes from merged user-facing changes.",
            path: "skills/release-notes/SKILL.md",
            scope: "profile",
            enabled: true,
            sourcePath: "/tmp/profile/profiles/default",
            charCount: 200,
            sourceHash: "a".repeat(64),
            validationStatus: "valid",
            validationMessages: [],
          },
        ],
      },
    );

    expect(prompt).toContain("OpenPond capabilities:");
    expect(prompt).toContain("- workspace_context: use resource_search and resource_read");
    expect(prompt).toContain("- create_pipeline: create or edit source-backed agents and workflows");
    expect(prompt).toContain("- profile_skill_goal: create or edit profile-backed single-file skills");
    expect(prompt).toContain("- goal_control: start, restart, pause, resume, or stop OpenPond goals");
    expect(prompt).toContain("- Capability names are not slash commands.");
    expect(prompt.indexOf("OpenPond capabilities:")).toBeLessThan(prompt.indexOf("OpenPond profile skills:"));
    expect(prompt).not.toContain("/create");
    expect(prompt).not.toContain("/skill create");
    expect(prompt).not.toContain("Identify user-facing changes first");
  });

  test("scopes Hybrid project edits to the hosted sandbox without removing Create Pipeline", async () => {
    const helpers = createHostedTurnHelpers({
      appendRuntimeEvent: async (_event: RuntimeEvent) => {},
    });

    const prompt = await helpers.hostedSystemPrompt(
      "Base hosted prompt.",
      "",
      {
        ...session,
        id: "hybrid_session_1",
        title: "Hybrid Project Chat",
        workspaceId: "sandbox_1",
        workspaceName: "Hybrid Repo",
        localProjectId: "local_project_1",
        cloudProjectId: "cloud_project_1",
        cloudTeamId: "team_1",
        metadata: { workspaceTarget: "hybrid" },
      },
      {
        toolInstructionMode: "full_text_fallback",
        actionCatalogInstructionMode: "native_tool",
      },
    );

    expect(prompt).toContain("Hybrid workspace context:");
    expect(prompt).toContain(
      "Treat normal requests to inspect, edit, test, or diff project files as sandbox workspace work.",
    );
    expect(prompt).toContain(
      "For file edits like README, source, config, or docs updates, inspect and change the active sandbox",
    );
    expect(prompt).toContain(
      "Keep the user's local checkout unchanged unless the user explicitly asks to preserve, promote, apply, or export sandbox changes.",
    );
    expect(prompt).toContain(
      "Create Pipeline remains appropriate only when the user explicitly asks to create or edit an OpenPond agent, workflow, app behavior, or Create Pipeline plan.",
    );
    expect(prompt).toContain("- create_pipeline: create or edit source-backed agents and workflows");
    expect(prompt).toContain(
      "Use create_pipeline only when the user explicitly asks to create or edit an OpenPond agent, workflow, app behavior, or Create Pipeline plan.",
    );
    expect(prompt).toContain("sandbox_read_file");
    expect(prompt).toContain("sandbox_edit_file");
  });

  test("uses text fallback instructions and truncates large profile skill indexes", async () => {
    const helpers = createHostedTurnHelpers({
      appendRuntimeEvent: async (_event: RuntimeEvent) => {},
    });

    const prompt = await helpers.hostedSystemPrompt(
      "Base hosted prompt.",
      "",
      session,
      {
        profileSkillInstructionMode: "text_fallback",
        openPondProfileSkills: Array.from({ length: 80 }, (_item, index) => ({
          name: `skill-${index}`,
          description: `Use skill ${index} for a long profile workflow. ${"details ".repeat(40)}`,
          path: `skills/skill-${index}/SKILL.md`,
          scope: "profile" as const,
          enabled: true,
          sourcePath: "/tmp/profile/profiles/default",
          charCount: 200,
          sourceHash: "b".repeat(64),
          validationStatus: "valid" as const,
          validationMessages: [],
        })),
      },
    );

    expect(prompt).toContain("fenced block labelled openpond_skill");
    expect(prompt).toContain('{"name":"release-notes"}');
    expect(prompt).toContain("additional profile skill(s) omitted from this context budget");
  });
});
