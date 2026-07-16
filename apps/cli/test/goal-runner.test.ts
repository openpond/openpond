import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runTestProcess } from "../../../tests/helpers/run-process";

import { afterEach, describe, expect, test } from "vitest";

import { createGoalState, normalizeGoalState } from "../src/goal/config";
import { runGoalCommand } from "../src/goal/cli";
import { buildGoalLlmMessages } from "../src/goal/llm";
import {
  MAX_GOAL_COMMAND_LOG_ARTIFACT_BYTES,
  MAX_GOAL_FILE_READ_BYTES,
} from "../src/goal/limits";
import { runGoalIteration } from "../src/goal/runner";
import {
  goalEventRecordSchema,
  goalQuestionSnapshotSchema,
  goalRunResultRecordSchema,
} from "../src/goal/schemas";
import { LocalGoalStateAdapter } from "../src/goal/state/local";
import { HostedGoalClient } from "../src/goal/state/hosted";
import {
  finalizeCheckedSourceUpdate,
  unsafeSourceFinalizationPathFromStatus,
} from "../src/goal/tools/source";
import { runGoalVerificationChecks } from "../src/goal/tools/checks";
import { runGoalLlmToolCall } from "../src/goal/tools/dispatch";
import { readGoalPath } from "../src/goal/tools/files";
import { runGoalShellCommand } from "../src/goal/tools/shell";
import type {
  GoalArtifact,
  GoalArtifactRef,
  GoalApprovalRequest,
  GoalEvent,
  GoalLlmRequest,
  GoalLlmResponse,
  GoalQuestion,
  GoalRunConfig,
  GoalState,
} from "../src/goal/types";

const originalFetch = globalThis.fetch;
const originalEnv = {
  OPENPOND_API_KEY: process.env.OPENPOND_API_KEY,
  OPENPOND_GOAL_OUTPUT: process.env.OPENPOND_GOAL_OUTPUT,
  OPENPOND_OPCHAT_API_URL: process.env.OPENPOND_OPCHAT_API_URL,
  OPENPOND_OPCHAT_MODEL: process.env.OPENPOND_OPCHAT_MODEL,
};

afterEach(() => {
  globalThis.fetch = originalFetch;
  restoreEnv("OPENPOND_API_KEY", originalEnv.OPENPOND_API_KEY);
  restoreEnv("OPENPOND_GOAL_OUTPUT", originalEnv.OPENPOND_GOAL_OUTPUT);
  restoreEnv("OPENPOND_OPCHAT_API_URL", originalEnv.OPENPOND_OPCHAT_API_URL);
  restoreEnv("OPENPOND_OPCHAT_MODEL", originalEnv.OPENPOND_OPCHAT_MODEL);
});

class FakeHostedGoalClient {
  readonly events: GoalEvent[] = [];
  readonly questions: GoalQuestion[] = [];
  readonly approvals: GoalApprovalRequest[] = [];
  readonly statuses: GoalState["status"][] = [];
  readonly llmRequests: GoalLlmRequest[] = [];

  private readonly responses: GoalLlmResponse[];

  constructor(response: GoalLlmResponse | GoalLlmResponse[]) {
    this.responses = Array.isArray(response) ? [...response] : [response];
  }

  async getRunConfig(): Promise<GoalRunConfig> {
    throw new Error("not implemented");
  }

  async appendEvent(_goalId: string, event: GoalEvent): Promise<void> {
    this.events.push(event);
  }

  async answerQuestion(): Promise<void> {
    throw new Error("not implemented");
  }

  async createQuestion(_goalId: string, question: GoalQuestion): Promise<void> {
    this.questions.push(question);
  }

  async requestApproval(request: GoalApprovalRequest): Promise<void> {
    this.approvals.push(request);
  }

  async updateStatus(
    _goalId: string,
    status: GoalState["status"]
  ): Promise<void> {
    this.statuses.push(status);
  }

  async callLlm(request: GoalLlmRequest): Promise<GoalLlmResponse> {
    this.llmRequests.push(request);
    return this.responses.shift() ?? {
      status: "ok",
      summary: "No further tool calls",
      message: { role: "assistant", content: "No further tool calls." },
    };
  }

  async uploadArtifact(artifact: GoalArtifact): Promise<GoalArtifactRef> {
    return {
      id: artifact.id,
      ref: `hosted://${artifact.id}`,
      kind: artifact.kind,
      name: artifact.name,
      mimeType: artifact.mimeType,
      bytes: artifact.bytes,
    };
  }

  asHostedClient(): HostedGoalClient {
    return this as unknown as HostedGoalClient;
  }
}

describe("goal runner hosted tool loop", () => {
  test("CLI goal help exits successfully for hosted rootfs smoke", async () => {
    const { stdout, stderr, exitCode } = await runTestProcess(
      process.execPath,
      ["--import", "tsx", "src/cli/main.ts", "goal", "--help"],
      { cwd: join(import.meta.dirname, "..") },
    );

    expect(exitCode).toBe(0);
    expect(stderr).toBe("");
    expect(stdout).toContain("Usage:");
    expect(stdout).toContain("openpond goal <command> [args]");
    expect(stdout).toContain("--goal-storage <string>");
  });

  test("builds LLM messages from the selected prompt pack and answered questions", () => {
    const goal = normalizeGoalState(
      createGoalState({
        objective: "Make the SharePoint report longer.",
        kind: "update_agent",
      })
    );
    goal.questions.push({
      id: "question_test",
      goalId: goal.id,
      title: "Which workbook?",
      reason: "Need source data.",
      required: true,
      options: [],
      freeformAllowed: true,
      answeredAt: "2026-06-24T12:02:00.000Z",
    });
    goal.answers.push({
      id: "answer_test",
      goalId: goal.id,
      questionId: "question_test",
      optionId: null,
      freeformText: "Use the quarterly workbook.",
      value: {},
      createdAt: "2026-06-24T12:02:00.000Z",
    });

    const messages = buildGoalLlmMessages(goal);

    expect(messages[0]?.content).toContain("# Update OpenPond Agent Goal");
    expect(messages[1]?.content).toContain("Make the SharePoint report longer.");
    expect(messages[1]?.content).toContain("Use the quarterly workbook.");
    expect(messages[1]?.content).toContain("openpond_agent_update_v1");
  });

  test("create-agent prompt instructs the model to choose action shape without keyword heuristics", () => {
    const goal = normalizeGoalState(
      createGoalState({
        objective: "Create an agent that can prepare a weekly report.",
        kind: "create_agent",
      })
    );

    const messages = buildGoalLlmMessages(goal);

    expect(messages[0]?.content).toContain("# Create OpenPond Agent Goal");
    expect(messages[0]?.content).toContain("metadata.actionShape");
    expect(messages[0]?.content).toContain("chat | direct_action | chat_and_direct_actions");
    expect(messages[0]?.content).toContain("Do not use hardcoded business examples or hidden keyword lists.");
    expect(messages[0]?.content).toContain("questions_ask");
    expect(messages[0]?.content).toContain("default_chat_fallback");
  });

  test("includes create plan action-shape metadata in LLM context", () => {
    const goal = normalizeGoalState(
      createGoalState({
        objective: "Create an agent that can answer questions and produce a weekly report.",
        kind: "create_agent",
      })
    );
    goal.createPipeline = {
      schemaVersion: "openpond.createPipeline.snapshot.v1",
      id: "create_pipeline_test",
      goalId: goal.id,
      state: "awaiting_plan_approval",
      request: {
        schemaVersion: "openpond.createPipeline.request.v1",
        id: "create_request_test",
        operation: "create",
        surface: "direct_prompt_create",
        command: "/create",
        objective: goal.objective,
        adapter: {
          kind: "local",
          sourceAuthority: "local_profile",
          activeProfile: "default",
          repoPath: "/repo",
          sourcePath: "/repo/profiles/default",
          localHead: null,
          confirmationPolicy: "always_require_plan_approval",
        },
        actor: { id: null, kind: "user", label: null },
        scope: {
          conversationId: null,
          workItemId: null,
          projectId: null,
          targetProject: null,
        },
        context: {
          messageIds: [],
          conversationExcerpts: [],
          attachments: [],
          apps: [],
          tools: [],
          targetRepoAssumptions: [],
        },
        targetAgent: {
          agentId: null,
          displayName: null,
          defaultActionKey: "chat",
        },
        metadata: {},
        createdAt: "2026-07-01T00:00:00.000Z",
      },
      plan: {
        schemaVersion: "openpond.createPipeline.plan.v1",
        id: "create_plan_test",
        goalId: goal.id,
        requestId: "create_request_test",
        status: "pending_approval",
        objective: goal.objective,
        summary: "Create a source-backed profile agent.",
        capturedContextSummary: "Direct prompt request.",
        defaultChatAction: { key: "chat", label: "Chat", required: true },
        sourcePlan: [],
        requirements: [],
        checks: [],
        approvalId: "approval_test",
        approvedAt: null,
        editedFromPlanId: null,
        metadata: {
          actionShape: {
            mode: "chat_and_direct_actions",
            label: "Chat plus direct action",
            detail: "Use chat for follow-ups and a direct action for the weekly report.",
            defaultActionKey: "chat",
            directActionHint: "Produce the weekly report.",
            artifactPolicy: "Persist trace, run summary, and report artifact.",
          },
          actionShapeDecisionSource: "request_metadata",
        },
        createdAt: "2026-07-01T00:00:00.000Z",
        updatedAt: "2026-07-01T00:00:00.000Z",
      },
      workflowCapture: null,
      approvalIds: ["approval_test"],
      questionIds: [],
      checkRefs: [],
      sourceRefs: [],
      localGoalId: goal.id,
      localProfileCommit: null,
      hostedGoalId: null,
      hostedSourceCommit: null,
      hostedSourceRef: null,
      blockedReason: null,
      metadata: {},
      createdAt: "2026-07-01T00:00:00.000Z",
      updatedAt: "2026-07-01T00:00:00.000Z",
    };

    const messages = buildGoalLlmMessages(goal);

    expect(messages[1]?.content).toContain('"actionShape"');
    expect(messages[1]?.content).toContain('"mode": "chat_and_direct_actions"');
    expect(messages[1]?.content).toContain('"actionShapeDecisionSource": "request_metadata"');
  });

  test("skips hosted shell openpond-agent probes for agent goals", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "openpond-goal-agent-shell-"));
    try {
      const goal = normalizeGoalState(
        createGoalState({
          objective: "Create an agent",
          kind: "create_agent",
        })
      );
      const hosted = new FakeHostedGoalClient({
        status: "ok",
        summary: "unused",
      });

      const result = await runGoalLlmToolCall(
        {
          goal,
          iterationId: "iteration_shell_policy",
          workspace,
          hostedClient: hosted.asHostedClient(),
        },
        {
          id: "call_shell_policy",
          name: "shell_run",
          arguments: {
            command:
              "which openpond-agent 2>/dev/null || npx openpond-agent --help",
          },
        }
      );

      expect(result.status).toBe("ok");
      expect(result.summary).toContain("openpond_agent_* tools");
      expect(hosted.events).toEqual([
        expect.objectContaining({
          kind: "command.completed",
          summary: expect.stringContaining("openpond_agent_* tools"),
          payload: expect.objectContaining({
            skipped: true,
          }),
        }),
      ]);
      expect(
        hosted.events.some((event) => event.kind === "command.started")
      ).toBe(false);
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test("skips hosted OpenPond agent manifest writes", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "openpond-goal-agent-manifest-"));
    try {
      await writeFile(join(workspace, "openpond.yaml"), "name: original\n");
      const goal = normalizeGoalState(
        createGoalState({
          objective: "Create an agent",
          kind: "create_agent",
        })
      );
      const hosted = new FakeHostedGoalClient({
        status: "ok",
        summary: "unused",
      });

      const result = await runGoalLlmToolCall(
        {
          goal,
          iterationId: "iteration_manifest_policy",
          workspace,
          hostedClient: hosted.asHostedClient(),
        },
        {
          id: "call_manifest_policy",
          name: "files_write",
          arguments: {
            path: "./openpond.yaml",
            content: "integrations:\n  sharepoint: true\n",
          },
        }
      );

      expect(result.status).toBe("ok");
      expect(result.output).toEqual(
        expect.objectContaining({
          skipped: true,
          reason: "hosted_openpond_agent_manifest_write_disallowed",
        })
      );
      expect(await readFile(join(workspace, "openpond.yaml"), "utf8")).toBe(
        "name: original\n"
      );
      expect(hosted.events).toContainEqual(
        expect.objectContaining({
          kind: "command.completed",
          payload: expect.objectContaining({
            path: "openpond.yaml",
            skipped: true,
          }),
        })
      );
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test("allows hosted OpenPond agent source writes", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "openpond-goal-agent-source-"));
    try {
      const goal = normalizeGoalState(
        createGoalState({
          objective: "Create an agent",
          kind: "create_agent",
        })
      );
      const hosted = new FakeHostedGoalClient({
        status: "ok",
        summary: "unused",
      });

      const result = await runGoalLlmToolCall(
        {
          goal,
          iterationId: "iteration_source_policy",
          workspace,
          hostedClient: hosted.asHostedClient(),
        },
        {
          id: "call_source_policy",
          name: "files_write",
          arguments: {
            path: "agent/instructions.md",
            content: "Use the provided SharePoint details honestly.\n",
          },
        }
      );

      expect(result.status).toBe("ok");
      expect(await readFile(join(workspace, "agent/instructions.md"), "utf8")).toBe(
        "Use the provided SharePoint details honestly.\n"
      );
      expect(hosted.events).toContainEqual(
        expect.objectContaining({
          kind: "source.updated",
          payload: expect.objectContaining({
            path: "agent/instructions.md",
          }),
        })
      );
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test("executes hosted file tool calls before verification checks", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "openpond-goal-runner-"));
    try {
      const goal = normalizeGoalState(
        createGoalState({
          objective: "Write a report",
          verification: { commands: ["test -f report.txt"] },
        })
      );
      const hosted = new FakeHostedGoalClient([
        {
          status: "ok",
          summary: "Write the report file",
          toolCalls: [
            {
              id: "call_write",
              name: "files_write",
              arguments: {
                path: "report.txt",
                content: "hello from goal\n",
              },
            },
          ],
        },
        {
          status: "ok",
          summary: "Report written",
          message: { role: "assistant", content: "Report written." },
        },
      ]);
      const result = await runGoalIteration({
        config: {
          goal,
          mode: "hosted",
          workspace,
          iterationId: "iteration_test",
        },
        hostedClient: hosted.asHostedClient(),
      });

      await expect(readFile(join(workspace, "report.txt"), "utf-8")).resolves.toBe(
        "hello from goal\n"
      );
      expect(result.status).toBe("completed");
      expect(hosted.statuses).toEqual(["running", "completed"]);
      expect(hosted.llmRequests[0]?.tools?.some((entry) => {
        const fn = (entry as { function?: { name?: unknown } }).function;
        return fn?.name === "files_write";
      })).toBe(true);
      expect(hosted.llmRequests).toHaveLength(2);
      expect(hosted.llmRequests[1]?.messages).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            role: "tool",
            tool_call_id: "call_write",
          }),
        ])
      );
      expect(hosted.events.some((event) => event.kind === "source.updated")).toBe(
        true
      );
      expect(hosted.events.some((event) => event.kind === "check.completed")).toBe(
        true
      );
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test("lets hosted planner recover when files.read targets a directory", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "openpond-goal-directory-"));
    try {
      await writeFile(join(workspace, "README.md"), "# Existing project\n", "utf-8");
      const goal = normalizeGoalState(
        createGoalState({
          objective: "Create a report after inspecting the workspace",
        })
      );
      const hosted = new FakeHostedGoalClient([
        {
          status: "ok",
          summary: "Inspect the workspace",
          toolCalls: [
            {
              id: "call_read_directory",
              name: "files_read",
              arguments: {
                path: ".",
              },
            },
          ],
        },
        {
          status: "ok",
          summary: "Write the report after seeing directory entries",
          toolCalls: [
            {
              id: "call_write_after_directory",
              name: "files_write",
              arguments: {
                path: "report.txt",
                content: "directory read recovered\n",
              },
            },
          ],
        },
        {
          status: "ok",
          summary: "Report written",
          message: { role: "assistant", content: "Report written." },
        },
      ]);
      const result = await runGoalIteration({
        config: {
          goal,
          mode: "hosted",
          workspace,
          iterationId: "iteration_directory",
        },
        hostedClient: hosted.asHostedClient(),
      });

      expect(result.status).toBe("completed");
      await expect(readFile(join(workspace, "report.txt"), "utf-8")).resolves.toBe(
        "directory read recovered\n"
      );
      expect(hosted.statuses).toEqual(["running", "completed"]);
      expect(hosted.llmRequests).toHaveLength(3);
      expect(hosted.llmRequests[1]?.messages).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            role: "tool",
            tool_call_id: "call_read_directory",
            content: expect.stringContaining('"type":"directory"'),
          }),
        ])
      );
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test("allows a final completion turn after four successful tool rounds", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "openpond-goal-rounds-"));
    try {
      await writeFile(join(workspace, "README.md"), "# Existing project\n", "utf-8");
      const goal = normalizeGoalState(
        createGoalState({
          objective: "Update README after inspecting the project",
        })
      );
      const hosted = new FakeHostedGoalClient([
        {
          status: "ok",
          summary: "List files",
          toolCalls: [
            {
              id: "call_list",
              name: "files_list",
              arguments: { path: "." },
            },
          ],
        },
        {
          status: "ok",
          summary: "Read README",
          toolCalls: [
            {
              id: "call_read",
              name: "files_read",
              arguments: { path: "README.md" },
            },
          ],
        },
        {
          status: "ok",
          summary: "Inspect git",
          toolCalls: [
            {
              id: "call_shell",
              name: "shell_run",
              arguments: { command: "printf ok" },
            },
          ],
        },
        {
          status: "ok",
          summary: "Write README",
          toolCalls: [
            {
              id: "call_write",
              name: "files_write",
              arguments: {
                path: "README.md",
                content: "# Existing project\n\nUpdated by goal.\n",
              },
            },
          ],
        },
        {
          status: "ok",
          summary: "README updated",
          message: { role: "assistant", content: "README updated." },
        },
      ]);

      const result = await runGoalIteration({
        config: {
          goal,
          mode: "hosted",
          workspace,
          iterationId: "iteration_rounds",
        },
        hostedClient: hosted.asHostedClient(),
      });

      expect(result.status).toBe("completed");
      await expect(readFile(join(workspace, "README.md"), "utf-8")).resolves.toBe(
        "# Existing project\n\nUpdated by goal.\n"
      );
      expect(hosted.llmRequests).toHaveLength(5);
      expect(hosted.statuses).toEqual(["running", "completed"]);
      expect(hosted.events.some((event) => event.kind === "source.updated")).toBe(
        true
      );
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test("pauses on required structured questions from the hosted planner", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "openpond-goal-question-"));
    try {
      const goal = normalizeGoalState(
        createGoalState({
          objective: "Create an agent",
          kind: "create_agent",
        })
      );
      const hosted = new FakeHostedGoalClient({
        status: "needs_user_input",
        summary: "Need a channel decision",
        toolCalls: [
          {
            id: "call_question",
            name: "questions_ask",
            arguments: {
              title: "Which channel should this agent use?",
              reason: "The agent needs a starting channel before source generation.",
              required: true,
              options: [
                {
                  id: "teams",
                  label: "Microsoft Teams",
                  description: "Use Teams as the first channel.",
                },
              ],
            },
          },
        ],
      });

      const result = await runGoalIteration({
        config: {
          goal,
          mode: "hosted",
          workspace,
          iterationId: "iteration_question",
        },
        hostedClient: hosted.asHostedClient(),
      });

      expect(result.status).toBe("awaiting_user_input");
      expect(hosted.statuses).toEqual(["running", "awaiting_user_input"]);
      expect(hosted.questions).toHaveLength(1);
      expect(hosted.questions[0]?.title).toBe(
        "Which channel should this agent use?"
      );
      expect(hosted.events.some((event) => event.kind === "question.created")).toBe(
        true
      );
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test("pauses on hosted approval requests from the planner", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "openpond-goal-approval-"));
    try {
      const goal = normalizeGoalState(
        createGoalState({
          objective: "Publish the generated agent",
          kind: "update_agent",
        })
      );
      const hosted = new FakeHostedGoalClient({
        status: "ok",
        summary: "Need publish approval",
        toolCalls: [
          {
            id: "call_approval",
            name: "approvals_request",
            arguments: {
              kind: "deploy_publish",
              title: "Approve agent publish",
              reason: "Publishing changes the live agent runtime.",
              payload: { publishTarget: "agent" },
            },
          },
        ],
      });

      const result = await runGoalIteration({
        config: {
          goal,
          mode: "hosted",
          workspace,
          iterationId: "iteration_approval",
        },
        hostedClient: hosted.asHostedClient(),
      });

      expect(result.status).toBe("awaiting_approval");
      expect(hosted.statuses).toEqual(["running", "awaiting_approval"]);
      expect(hosted.approvals).toEqual([
        expect.objectContaining({
          goalId: goal.id,
          kind: "deploy_publish",
          title: "Approve agent publish",
          reason: "Publishing changes the live agent runtime.",
          payload: { publishTarget: "agent" },
        }),
      ]);
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test("answers local structured questions and resumes the same goal", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "openpond-goal-local-question-"));
    const originalConsoleLog = console.log;
    try {
      console.log = () => {};
      process.env.OPENPOND_API_KEY = "opk_local_goal_test";
      process.env.OPENPOND_OPCHAT_API_URL = "https://api.example.test/opchat/v1";
      globalThis.fetch = async () =>
        jsonResponse({
          choices: [
            {
              message: {
                role: "assistant",
                content: "Need a decision.",
                tool_calls: [
                  {
                    id: "call_local_question",
                    type: "function",
                    function: {
                      name: "questions_ask",
                      arguments:
                        '{"title":"Which channel?","reason":"Need a default channel.","required":true,"options":[{"id":"chat","label":"Chat"}]}',
                    },
                  },
                ],
              },
            },
          ],
        });

      const localState = new LocalGoalStateAdapter(workspace);
      const goal = normalizeGoalState(
        createGoalState({
          objective: "Ask a local setup question",
          kind: "create_agent",
        })
      );
      await localState.create(goal);

      const result = await runGoalIteration({
        config: {
          goal,
          mode: "local",
          workspace,
          iterationId: "iteration_local_question",
        },
        localState,
      });
      const awaiting = await localState.get(goal.id);
      const question = awaiting?.questions[0];

      expect(result.status).toBe("awaiting_user_input");
      expect(awaiting?.status).toBe("awaiting_user_input");
      expect(question?.title).toBe("Which channel?");

      await runGoalCommand(
        { cwd: workspace, choice: "chat", goalStorage: "workspace" },
        ["answer", question?.id ?? ""]
      );

      const resumed = await localState.get(goal.id);
      expect(resumed?.id).toBe(goal.id);
      expect(resumed?.status).toBe("queued");
      expect(resumed?.answers).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            goalId: goal.id,
            questionId: question?.id,
            optionId: "chat",
          }),
        ])
      );
    } finally {
      console.log = originalConsoleLog;
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test("lets create-agent inspect continue when no project has been initialized", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "openpond-goal-sdk-missing-"));
    try {
      const goal = normalizeGoalState(
        createGoalState({
          objective: "Validate an agent project",
          kind: "create_agent",
        })
      );
      const hosted = new FakeHostedGoalClient({
        status: "ok",
        summary: "Inspect the agent source",
        toolCalls: [
          {
            id: "call_inspect",
            name: "openpond_agent_inspect",
            arguments: { json: true },
          },
        ],
      });

      const result = await runGoalIteration({
        config: {
          goal,
          mode: "hosted",
          workspace,
          iterationId: "iteration_sdk_missing",
        },
        hostedClient: hosted.asHostedClient(),
      });

      expect(result.status).toBe("completed");
      expect(hosted.statuses).toEqual(["running", "completed"]);
      expect(hosted.llmRequests).toHaveLength(2);
      expect(JSON.stringify(hosted.llmRequests[1]?.messages)).toContain(
        "not_initialized"
      );
      expect(hosted.events).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            kind: "iteration.completed",
            payload: expect.objectContaining({
              toolResults: expect.arrayContaining([
                expect.objectContaining({
                  name: "openpond_agent.inspect",
                  status: "ok",
                }),
              ]),
            }),
          }),
        ])
      );
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test("installs agent dependencies and runs project-local SDK checks", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "openpond-goal-sdk-install-"));
    const originalPath = process.env.PATH;
    try {
      await mkdir(join(workspace, ".fake-bin"), { recursive: true });
      await mkdir(join(workspace, "fixtures"), { recursive: true });
      await writeFile(
        join(workspace, "package.json"),
        JSON.stringify({
          scripts: {
            "agent:inspect": "openpond-agent inspect --json",
            "agent:build": "openpond-agent build",
            "agent:validate": "openpond-agent validate",
            "agent:check": "openpond-agent eval --json",
          },
          dependencies: {
            "openpond-agent-sdk": "file:./vendor/openpond-agent-sdk",
          },
        })
      );
      await writeFile(
        join(workspace, "fixtures", "openpond-agent"),
        [
          "#!/bin/sh",
          "set -eu",
          "command=\"$1\"",
          "mkdir -p .openpond/traces",
          "case \"$command\" in",
          "  inspect) echo '{\"agent\":{\"id\":\"agent_test\",\"manifestHash\":\"hash_test\"}}' ;;",
          "  build) echo built > .openpond/build.txt ;;",
          "  validate) echo valid ;;",
          "  eval) echo '{\"status\":\"passed\",\"traceRefs\":[\".openpond/traces/eval.jsonl\"]}' ;;",
          "  traces) echo '{\"traces\":[\".openpond/traces/eval.jsonl\"]}' ;;",
          "  run) echo '{\"ok\":true}' ;;",
          "  *) echo \"unknown openpond-agent command: $command\" >&2; exit 2 ;;",
          "esac",
          "",
        ].join("\n")
      );
      await chmod(join(workspace, "fixtures", "openpond-agent"), 0o755);
      await writeFile(
        join(workspace, ".fake-bin", "npm"),
        [
          "#!/bin/sh",
          "set -eu",
          "if [ \"${1:-}\" != \"install\" ]; then",
          "  echo \"unexpected fake npm command: $*\" >&2",
          "  exit 2",
          "fi",
          "mkdir -p \"$PWD/node_modules/.bin\"",
          "cp \"$PWD/fixtures/openpond-agent\" \"$PWD/node_modules/.bin/openpond-agent\"",
          "chmod +x \"$PWD/node_modules/.bin/openpond-agent\"",
          "echo installed",
          "",
        ].join("\n")
      );
      await chmod(join(workspace, ".fake-bin", "npm"), 0o755);
      process.env.PATH = `${join(workspace, ".fake-bin")}:${originalPath ?? ""}`;

      const goal = normalizeGoalState(
        createGoalState({
          objective: "Validate the generated agent project",
          kind: "create_agent",
        })
      );
      const hosted = new FakeHostedGoalClient([
        {
          status: "ok",
          summary: "Run the default SDK checks",
          toolCalls: [
            {
              id: "call_default_checks",
              name: "openpond_agent_default_checks",
              arguments: {},
            },
          ],
        },
        {
          status: "ok",
          summary: "Agent checks passed",
          message: { role: "assistant", content: "Agent checks passed." },
        },
      ]);

      const result = await runGoalIteration({
        config: {
          goal,
          mode: "hosted",
          workspace,
          iterationId: "iteration_sdk_install",
        },
        hostedClient: hosted.asHostedClient(),
      });

      expect(result.status).toBe("completed");
      expect(hosted.statuses).toEqual(["running", "completed"]);
      await expect(
        readFile(join(workspace, "node_modules", ".bin", "openpond-agent"), "utf-8")
      ).resolves.toContain("agent_test");
      expect(hosted.events).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            kind: "command.completed",
            payload: expect.objectContaining({
              command: "npm install",
              code: 0,
            }),
          }),
          expect.objectContaining({
            kind: "command.completed",
            payload: expect.objectContaining({
              command: expect.stringContaining("openpond-agent inspect"),
              code: 0,
            }),
          }),
          expect.objectContaining({
            kind: "command.completed",
            payload: expect.objectContaining({
              command: expect.stringContaining("openpond-agent build"),
              code: 0,
            }),
          }),
          expect.objectContaining({
            kind: "command.completed",
            payload: expect.objectContaining({
              command: expect.stringContaining("openpond-agent validate"),
              code: 0,
            }),
          }),
          expect.objectContaining({
            kind: "command.completed",
            payload: expect.objectContaining({
              command: expect.stringContaining("openpond-agent eval"),
              code: 0,
            }),
          }),
          expect.objectContaining({
            kind: "command.completed",
            payload: expect.objectContaining({
              command: expect.stringContaining("openpond-agent traces"),
              code: 0,
            }),
          }),
        ])
      );
    } finally {
      process.env.PATH = originalPath;
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test("feeds failed agent checks back into the planner for repair", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "openpond-goal-sdk-repair-"));
    try {
      await mkdir(join(workspace, "agent"), { recursive: true });
      await mkdir(join(workspace, "node_modules", ".bin"), { recursive: true });
      await writeFile(
        join(workspace, "package.json"),
        JSON.stringify({
          dependencies: {
            "openpond-agent-sdk": "file:./vendor/openpond-agent-sdk",
          },
        })
      );
      await writeFile(
        join(workspace, "node_modules", ".bin", "openpond-agent"),
        [
          "#!/bin/sh",
          "set -eu",
          "command=\"$1\"",
          "mkdir -p .openpond/traces",
          "case \"$command\" in",
          "  inspect) echo '{\"agent\":{\"id\":\"agent_test\",\"manifestHash\":\"hash_test\"}}' ;;",
          "  build) echo built > .openpond/build.txt ;;",
          "  validate) echo valid ;;",
          "  eval)",
          "    if [ ! -f agent/fixed.txt ]; then",
          "      echo '{\"summary\":{\"failed\":1},\"results\":[{\"name\":\"repair-check\",\"status\":\"failed\"}]}'",
          "      exit 1",
          "    fi",
          "    echo '{\"status\":\"passed\",\"traceRefs\":[\".openpond/traces/eval.jsonl\"]}'",
          "    ;;",
          "  traces) echo '{\"traces\":[\".openpond/traces/eval.jsonl\"]}' ;;",
          "  *) echo \"unknown openpond-agent command: $command\" >&2; exit 2 ;;",
          "esac",
          "",
        ].join("\n")
      );
      await chmod(join(workspace, "node_modules", ".bin", "openpond-agent"), 0o755);

      const goal = normalizeGoalState(
        createGoalState({
          objective: "Repair the generated agent checks",
          kind: "create_agent",
        })
      );
      const hosted = new FakeHostedGoalClient([
        {
          status: "ok",
          summary: "Run checks",
          toolCalls: [
            {
              id: "call_checks_1",
              name: "openpond_agent_default_checks",
              arguments: {},
            },
          ],
        },
        {
          status: "ok",
          summary: "Patch the failing agent source",
          toolCalls: [
            {
              id: "call_fix",
              name: "files_write",
              arguments: {
                path: "agent/fixed.txt",
                content: "fixed\n",
              },
            },
          ],
        },
        {
          status: "ok",
          summary: "Run checks again",
          toolCalls: [
            {
              id: "call_checks_2",
              name: "openpond_agent_default_checks",
              arguments: {},
            },
          ],
        },
        {
          status: "ok",
          summary: "Agent checks passed",
          message: { role: "assistant", content: "Agent checks passed." },
        },
      ]);

      const result = await runGoalIteration({
        config: {
          goal,
          mode: "hosted",
          workspace,
          iterationId: "iteration_sdk_repair",
        },
        hostedClient: hosted.asHostedClient(),
      });

      expect(result.status).toBe("completed");
      expect(hosted.statuses).toEqual(["running", "completed"]);
      expect(hosted.llmRequests).toHaveLength(4);
      await expect(readFile(join(workspace, "agent", "fixed.txt"), "utf8")).resolves.toBe(
        "fixed\n"
      );
      expect(hosted.events).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            kind: "command.completed",
            payload: expect.objectContaining({
              command: expect.stringContaining("openpond-agent eval"),
              code: 1,
            }),
          }),
          expect.objectContaining({
            kind: "source.updated",
            payload: expect.objectContaining({
              path: "agent/fixed.txt",
            }),
          }),
          expect.objectContaining({
            kind: "command.completed",
            payload: expect.objectContaining({
              command: expect.stringContaining("openpond-agent eval"),
              code: 0,
            }),
          }),
        ])
      );
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test("persists budget-limited results before starting a new iteration", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "openpond-goal-budget-"));
    try {
      const localState = new LocalGoalStateAdapter(workspace);
      const goal = normalizeGoalState(
        createGoalState({
          objective: "Do not start when the iteration budget is exhausted",
        })
      );
      goal.budget = { ...goal.budget, maxIterations: 0 };
      await localState.create(goal);

      const result = await runGoalIteration({
        config: {
          goal,
          mode: "local",
          workspace,
          iterationId: "iteration_budget",
        },
        localState,
      });

      const updated = await localState.get(goal.id);
      const persistedResult = JSON.parse(
        await readFile(
          join(workspace, ".openpond", "goals", goal.id, "result.json"),
          "utf-8"
        )
      ) as { status: string; events: GoalEvent[] };

      expect(result.status).toBe("budget_limited");
      expect(updated?.status).toBe("budget_limited");
      expect(updated?.events).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            kind: "goal.blocked",
            payload: expect.objectContaining({
              reason: "iteration_budget_exhausted",
            }),
          }),
        ])
      );
      expect(persistedResult.status).toBe("budget_limited");
      expect(persistedResult.events.some((event) => event.kind === "goal.blocked")).toBe(
        true
      );
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test("blocks source finalization for disallowed git status paths", () => {
    expect(
      unsafeSourceFinalizationPathFromStatus(" M src/index.ts\n?? node_modules/pkg/index.js\n")
    ).toBe("node_modules/pkg/index.js");
    expect(
      unsafeSourceFinalizationPathFromStatus(" M src/index.ts\n?? .env.local\n")
    ).toBe(".env.local");
    expect(
      unsafeSourceFinalizationPathFromStatus(
        " M src/index.ts\n[truncated 120 chars]\n"
      )
    ).toBe("git status output was truncated");
    expect(unsafeSourceFinalizationPathFromStatus(" M src/index.ts\n")).toBeNull();
  });

  test("commits and pushes checked source updates to the default branch", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "openpond-goal-source-"));
    try {
      const remote = join(workspace, "remote.git");
      const repo = join(workspace, "repo");
      await mkdir(repo, { recursive: true });
      await runGit(workspace, ["init", "--bare", remote]);
      await runGit(repo, ["init", "--initial-branch=main"]);
      await writeFile(join(repo, "README.md"), "initial\n");
      await runGit(repo, ["add", "README.md"]);
      await runGit(repo, [
        "-c",
        "user.name=Test User",
        "-c",
        "user.email=test@example.com",
        "commit",
        "-m",
        "initial",
      ]);
      await runGit(repo, ["remote", "add", "origin", remote]);
      await runGit(repo, ["push", "-u", "origin", "main"]);
      await writeFile(join(repo, "README.md"), "updated\n");

      const localState = new LocalGoalStateAdapter(repo);
      const goal = normalizeGoalState(
        createGoalState({
          objective: "Preserve the checked source update",
        })
      );
      await localState.create(goal);

      const result = await finalizeCheckedSourceUpdate({
        goal,
        iterationId: "iteration_source",
        cwd: repo,
        checksPassed: true,
        defaultBranch: "main",
        workspace: repo,
        localState,
      });

      const localHead = await runGit(repo, ["rev-parse", "HEAD"]);
      const remoteHead = await runGit(workspace, [
        "--git-dir",
        remote,
        "rev-parse",
        "refs/heads/main",
      ]);
      const updated = await localState.get(goal.id);

      expect(result).toEqual(
        expect.objectContaining({
          status: "committed",
          branch: "main",
        })
      );
      expect(remoteHead.trim()).toBe(localHead.trim());
      expect(updated?.events).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            kind: "source.updated",
            payload: expect.objectContaining({
              branch: "main",
              policy: "auto_commit_push_default_branch",
            }),
          }),
        ])
      );
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test("delegates hosted source finalization to the control plane", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "openpond-goal-hosted-source-"));
    try {
      const repo = join(workspace, "repo");
      await mkdir(repo, { recursive: true });
      await runGit(repo, ["init", "--initial-branch=main"]);
      await writeFile(join(repo, "README.md"), "initial\n");
      await runGit(repo, ["add", "README.md"]);
      await runGit(repo, [
        "-c",
        "user.name=Test User",
        "-c",
        "user.email=test@example.com",
        "commit",
        "-m",
        "initial",
      ]);
      await writeFile(join(repo, "README.md"), "updated\n");

      const goal = normalizeGoalState(
        createGoalState({
          objective: "Preserve hosted source update",
        })
      );
      const hosted = new FakeHostedGoalClient({
        status: "ok",
        summary: "Unused hosted response",
      });

      const result = await finalizeCheckedSourceUpdate({
        goal,
        iterationId: "iteration_hosted_source",
        cwd: repo,
        checksPassed: true,
        defaultBranch: "main",
        workspace: repo,
        hostedClient: hosted.asHostedClient(),
      });

      const status = await runGit(repo, ["status", "--porcelain", "-uall"]);

      expect(result).toEqual({
        status: "skipped",
        branch: null,
        commitMessage: null,
        summary: "Source finalization delegated to OpenPond control plane",
      });
      expect(status).toContain(" M README.md");
      expect(hosted.events.some((event) => event.kind === "command.completed")).toBe(
        false
      );
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test("uses local OpChat config to plan and execute local goal tool calls", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "openpond-goal-local-"));
    try {
      process.env.OPENPOND_API_KEY = "opk_local_goal_test";
      process.env.OPENPOND_OPCHAT_API_URL = "https://api.example.test/opchat/v1";
      const requests: Array<{ url: string; body: Record<string, unknown> }> = [];
      globalThis.fetch = async (input, init) => {
        requests.push({
          url: String(input),
          body: JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>,
        });
        const response =
          requests.length === 1
            ? {
                choices: [
                  {
                    message: {
                      role: "assistant",
                      content: "Writing the local report.",
                      tool_calls: [
                        {
                          id: "call_local_write",
                          type: "function",
                          function: {
                            name: "files_write",
                            arguments:
                              '{"path":"local-report.txt","content":"local goal\\n"}',
                          },
                        },
                      ],
                    },
                  },
                ],
                usage: {
                  prompt_tokens: 20,
                  completion_tokens: 10,
                  total_tokens: 30,
                },
              }
            : {
                choices: [
                  {
                    message: {
                      role: "assistant",
                      content: "Local report is ready.",
                    },
                  },
                ],
              };
        return jsonResponse(response);
      };

      const localState = new LocalGoalStateAdapter(workspace);
      const goal = normalizeGoalState(
        createGoalState({
          objective: "Write a local report",
          verification: { commands: ["test -f local-report.txt"] },
        })
      );
      await localState.create(goal);

      const result = await runGoalIteration({
        config: {
          goal,
          mode: "local",
          workspace,
          iterationId: "iteration_local",
        },
        localState,
      });

      expect(result.status).toBe("completed");
      await expect(
        readFile(join(workspace, "local-report.txt"), "utf-8")
      ).resolves.toBe("local goal\n");
      expect(requests).toHaveLength(2);
      expect(requests[0]?.url).toBe(
        "https://api.example.test/opchat/v1/chat/completions"
      );
      expect(requests[0]?.body).toMatchObject({
        model: "openpond-chat",
        stream: false,
        tool_choice: "auto",
      });
      expect(
        (requests[0]?.body.tools as Array<{ function?: { name?: string } }>).some(
          (tool) => tool.function?.name === "files_write"
        )
      ).toBe(true);
      expect(requests[1]?.body.messages).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            role: "tool",
            tool_call_id: "call_local_write",
          }),
        ])
      );

      const goalDir = join(workspace, ".openpond", "goals", goal.id);
      const eventsJsonl = await readFile(join(goalDir, "events.jsonl"), "utf-8");
      const eventRecords = eventsJsonl
        .trim()
        .split("\n")
        .filter(Boolean)
        .map((line) => goalEventRecordSchema.parse(JSON.parse(line)));
      const questionsSnapshot = goalQuestionSnapshotSchema.parse(
        JSON.parse(await readFile(join(goalDir, "questions.json"), "utf-8"))
      );
      const persistedResult = goalRunResultRecordSchema.parse(
        JSON.parse(await readFile(join(goalDir, "result.json"), "utf-8"))
      );

      expect(eventRecords.some((event) => event.kind === "source.updated")).toBe(
        true
      );
      expect(eventRecords.some((event) => event.kind === "check.completed")).toBe(
        true
      );
      expect(questionsSnapshot).toEqual({ questions: [], answers: [] });
      expect(persistedResult.status).toBe("completed");
      expect(persistedResult.events.map((event) => event.kind)).toEqual(
        eventRecords.map((event) => event.kind)
      );
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test("redacts secret-looking values from local events and artifacts", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "openpond-goal-redaction-"));
    try {
      const localState = new LocalGoalStateAdapter(workspace);
      const secret = "opk_abcdefghijklmnop";
      const providerSecret = "sk-abcdefghijklmnop";
      const goal = normalizeGoalState(
        createGoalState({
          objective: "Verify redaction",
          verification: {
            commands: [
              [
                `OPENPOND_API_KEY=${secret}`,
                "sh",
                "-c",
                `'echo OPENPOND_API_KEY=${secret}; echo ${providerSecret}'`,
              ].join(" "),
            ],
          },
        })
      );
      await localState.create(goal);

      const checks = await runGoalVerificationChecks({
        goal,
        iterationId: "iteration_redaction",
        cwd: workspace,
        workspace,
        localState,
      });

      expect(checks[0]?.status).toBe("passed");
      expect(checks[0]?.artifactRefs.length).toBe(1);
      const goalDir = join(workspace, ".openpond", "goals", goal.id);
      const eventsJsonl = await readFile(join(goalDir, "events.jsonl"), "utf-8");
      const eventRecords = eventsJsonl
        .trim()
        .split("\n")
        .filter(Boolean)
        .map((line) => goalEventRecordSchema.parse(JSON.parse(line)));
      const artifactRef = checks[0]?.artifactRefs[0] ?? "";
      const artifactContent = await readFile(join(workspace, artifactRef), "utf-8");

      expect(eventsJsonl).not.toContain(secret);
      expect(eventsJsonl).not.toContain(providerSecret);
      expect(artifactContent).not.toContain(secret);
      expect(artifactContent).not.toContain(providerSecret);
      expect(eventsJsonl).toContain("[redacted]");
      expect(artifactContent).toContain("[redacted]");
      expect(eventRecords).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            kind: "check.completed",
            payload: expect.objectContaining({
              artifactRefs: [artifactRef],
              command: expect.stringContaining("[redacted]"),
            }),
          }),
        ])
      );
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test("rejects goal file reads above the configured size limit", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "openpond-goal-large-read-"));
    try {
      await writeFile(
        join(workspace, "large.txt"),
        "x".repeat(MAX_GOAL_FILE_READ_BYTES + 1),
        "utf-8"
      );

      await expect(
        readGoalPath({ workspace, path: "large.txt" })
      ).rejects.toThrow(`max ${MAX_GOAL_FILE_READ_BYTES} bytes`);
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test("caps command log artifacts while keeping event tails compact", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "openpond-goal-large-log-"));
    try {
      const localState = new LocalGoalStateAdapter(workspace);
      const goal = normalizeGoalState(createGoalState({ objective: "Bound command logs" }));
      await localState.create(goal);
      const script = `process.stdout.write("x".repeat(${MAX_GOAL_COMMAND_LOG_ARTIFACT_BYTES + 4096}))`;

      const result = await runGoalShellCommand({
        goalId: goal.id,
        iterationId: "iteration_large_log",
        command: `${JSON.stringify(process.execPath)} -e ${JSON.stringify(script)}`,
        cwd: workspace,
        workspace,
        localState,
      });

      expect(result.code).toBe(0);
      expect(result.artifactRefs.length).toBe(1);
      expect(result.stdoutTail.length).toBeLessThan(MAX_GOAL_COMMAND_LOG_ARTIFACT_BYTES);
      const artifactContent = await readFile(
        join(workspace, result.artifactRefs[0] ?? ""),
        "utf-8"
      );
      expect(Buffer.byteLength(artifactContent, "utf-8")).toBeLessThanOrEqual(
        MAX_GOAL_COMMAND_LOG_ARTIFACT_BYTES
      );
      expect(artifactContent).toContain(
        `[truncated after ${MAX_GOAL_COMMAND_LOG_ARTIFACT_BYTES} bytes]`
      );
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test("posts hosted lifecycle actions to explicit Goal endpoints", async () => {
    const requests: Array<{ url: string; method: string; body: unknown }> = [];
    globalThis.fetch = async (input, init) => {
      requests.push({
        url: String(input),
        method: init?.method ?? "GET",
        body: init?.body ? JSON.parse(String(init.body)) : null,
      });
      return jsonResponse({ ok: true });
    };
    const client = new HostedGoalClient("https://api.example.test", "opk_test");

    await client.pause("goal_test");
    await client.resume("goal_test");
    await client.cancel("goal_test");
    await client.requestApproval({
      goalId: "goal_test",
      kind: "external_effect",
      title: "Approve external effect",
      reason: "The goal wants to write outside the source tree.",
      payload: { target: "sharepoint" },
      createdAt: "2026-06-24T12:00:00.000Z",
    });
    await client.approve("goal_test", "Ship it.");

    expect(requests).toEqual([
      {
        url: "https://api.example.test/v1/goals/goal_test/pause",
        method: "POST",
        body: {},
      },
      {
        url: "https://api.example.test/v1/goals/goal_test/resume",
        method: "POST",
        body: {},
      },
      {
        url: "https://api.example.test/v1/goals/goal_test/cancel",
        method: "POST",
        body: {},
      },
      {
        url: "https://api.example.test/v1/goals/goal_test/approvals",
        method: "POST",
        body: {
          approval: {
            goalId: "goal_test",
            kind: "external_effect",
            title: "Approve external effect",
            reason: "The goal wants to write outside the source tree.",
            payload: { target: "sharepoint" },
            createdAt: "2026-06-24T12:00:00.000Z",
          },
        },
      },
      {
        url: "https://api.example.test/v1/goals/goal_test/approve",
        method: "POST",
        body: { decisionNote: "Ship it." },
      },
    ]);
  });

  test("prints goal_event and goal_result records in CLI JSONL mode", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "openpond-goal-jsonl-"));
    const originalConsoleLog = console.log;
    const logs: string[] = [];
    try {
      console.log = (message?: unknown) => {
        logs.push(String(message ?? ""));
      };
      process.env.OPENPOND_GOAL_OUTPUT = "jsonl";
      const localState = new LocalGoalStateAdapter(workspace);
      const goal = normalizeGoalState(
        createGoalState({
          objective: "Prove JSONL output",
          verification: { commands: ["test -d ."] },
        })
      );
      await localState.create(goal);

      await runGoalCommand(
        { cwd: workspace, goalId: goal.id, goalStorage: "workspace" },
        ["run"]
      );

      const records = logs.map((line) => JSON.parse(line) as Record<string, unknown>);
      expect(records.some((record) => record.type === "goal_event")).toBe(true);
      expect(records).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            type: "goal_result",
            result: expect.objectContaining({
              goalId: goal.id,
              status: "completed",
            }),
          }),
        ])
      );
    } finally {
      console.log = originalConsoleLog;
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test("prints structured question events in CLI JSONL mode", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "openpond-goal-jsonl-question-"));
    const originalConsoleLog = console.log;
    const logs: string[] = [];
    try {
      console.log = (message?: unknown) => {
        logs.push(String(message ?? ""));
      };
      process.env.OPENPOND_API_KEY = "opk_local_goal_test";
      process.env.OPENPOND_GOAL_OUTPUT = "jsonl";
      process.env.OPENPOND_OPCHAT_API_URL = "https://api.example.test/opchat/v1";
      globalThis.fetch = async () =>
        jsonResponse({
          choices: [
            {
              message: {
                role: "assistant",
                content: "Need workbook input.",
                tool_calls: [
                  {
                    id: "call_jsonl_question",
                    type: "function",
                    function: {
                      name: "questions_ask",
                      arguments:
                        '{"title":"Which workbook?","reason":"Need the SharePoint workbook before editing.","required":true,"options":[{"id":"latest","label":"Latest report"}]}',
                    },
                  },
                ],
              },
            },
          ],
        });

      const localState = new LocalGoalStateAdapter(workspace);
      const goal = normalizeGoalState(
        createGoalState({
          objective: "Ask for the SharePoint workbook",
          kind: "create_agent",
        })
      );
      await localState.create(goal);

      await runGoalCommand({ cwd: workspace, goalId: goal.id, goalStorage: "workspace" }, ["run"]);

      const records = logs.map((line) => JSON.parse(line) as Record<string, unknown>);
      const resultRecord = records.find((record) => record.type === "goal_result") as
        | { result?: { status?: string } }
        | undefined;
      expect(records).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            type: "goal_event",
            event: expect.objectContaining({
              kind: "question.created",
              summary: "Question created: Which workbook?",
            }),
          }),
        ])
      );
      expect(resultRecord?.result?.status).toBe("awaiting_user_input");

      const awaiting = await localState.get(goal.id);
      const question = awaiting?.questions[0];
      expect(question?.title).toBe("Which workbook?");
      await runGoalCommand(
        { cwd: workspace, choice: "latest", goalStorage: "workspace" },
        ["answer", question?.id ?? ""]
      );
      const resumed = await localState.get(goal.id);
      expect(resumed?.status).toBe("queued");
      expect(resumed?.answers).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            questionId: question?.id,
            optionId: "latest",
          }),
        ])
      );
    } finally {
      console.log = originalConsoleLog;
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test("persists local lifecycle status events from the CLI", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "openpond-goal-lifecycle-"));
    const originalConsoleLog = console.log;
    try {
      console.log = () => {};
      const localState = new LocalGoalStateAdapter(workspace);
      const goal = normalizeGoalState(
        createGoalState({
          objective: "Pause this goal",
        })
      );
      await localState.create(goal);

      await runGoalCommand({ cwd: workspace, goalStorage: "workspace" }, ["pause", goal.id]);

      const updated = await localState.get(goal.id);
      expect(updated?.status).toBe("paused");
      expect(updated?.events).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            kind: "goal.status_changed",
            summary: "Goal paused",
            payload: {
              fromStatus: "queued",
              toStatus: "paused",
            },
          }),
        ])
      );
    } finally {
      console.log = originalConsoleLog;
      await rm(workspace, { recursive: true, force: true });
    }
  });
});

function jsonResponse(value: unknown): Response {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

function restoreEnv(name: keyof typeof originalEnv, value: string | undefined) {
  if (value === undefined) {
    delete process.env[name];
  } else {
    process.env[name] = value;
  }
}

async function runGit(cwd: string, args: string[]): Promise<string> {
  const { exitCode, stdout, stderr } = await runTestProcess("git", args, {
    cwd,
  });
  if (exitCode !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${stderr || stdout}`);
  }
  return stdout;
}
