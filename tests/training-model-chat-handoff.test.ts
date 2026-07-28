import { describe, expect, test } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { readFile } from "node:fs/promises";
import {
  CROSS_SYSTEM_TOOL_CONTRACT_HASH,
  TasksetSchema,
  type Taskset,
} from "@openpond/contracts";
import { TrainingModelChatHandoffBar } from "../apps/web/src/components/chat/TrainingModelChatHandoffBar";
import {
  advanceTrainingModelChatTask,
  buildTrainingModelChatHandoff,
  refreshModelCatalogBeforeChat,
  selectTrainingModelChatTask,
  trainingModelChatProjectError,
  trainingModelChatTurnMetadata,
} from "../apps/web/src/lib/training-model-chat-handoff";
import { tasksetFixture } from "./helpers/training-fixtures";

describe("training model chat handoff", () => {
  test("refreshes the local model catalog before the composer selects a newly imported adapter", async () => {
    const calls: string[] = [];
    const connection = { serverUrl: "http://127.0.0.1:1", token: "fixture" };

    await refreshModelCatalogBeforeChat({
      model: { providerId: "local-adapter", modelId: "lineage_new" },
      connection,
      loadBootstrap: async (received) => {
        expect(received).toBe(connection);
        calls.push("load");
        return { models: ["lineage_new"] };
      },
      applyBootstrap: (payload) => {
        expect(payload.models).toEqual(["lineage_new"]);
        calls.push("apply");
      },
    });

    expect(calls).toEqual(["load", "apply"]);
  });

  test("does not refresh hosted model handoffs", async () => {
    let refreshed = false;
    await refreshModelCatalogBeforeChat({
      model: { providerId: "openai", modelId: "frontier" },
      connection: { serverUrl: "http://127.0.0.1:1", token: "fixture" },
      loadBootstrap: async () => { refreshed = true; return {}; },
      applyBootstrap: () => undefined,
    });
    expect(refreshed).toBe(false);
  });

  test("carries an exact generated task identity through normal composer questions", () => {
    const base = tasksetFixture({ ready: true });
    const taskset = TasksetSchema.parse({
      ...base,
      metadata: { ...base.metadata, toolContractHash: CROSS_SYSTEM_TOOL_CONTRACT_HASH },
      sourceRefs: base.sourceRefs.map((source) => ({ ...source, workspaceId: "local_cross_system" })),
      tasks: base.tasks.map((task, index) => ({
        ...task,
        input: { ...task.input, prompt: `Generated question ${index + 1}` },
        metadata: { ...task.metadata, taskId: `cso_generated_${index + 1}` },
      })),
    });
    const handoff = buildTrainingModelChatHandoff({ modelId: "lineage_cso", taskset });

    expect(handoff.model).toEqual({ providerId: "local-adapter", modelId: "lineage_cso" });
    expect(handoff.sourceProjectId).toBe("local_cross_system");
    expect(handoff.tasks.map((task) => task.generatedTaskId)).toEqual([
      "cso_generated_1",
      "cso_generated_2",
    ]);
    expect(trainingModelChatTurnMetadata(handoff, "Generated question 1", "local_cross_system")).toEqual({
      crossSystemTaskId: "cso_generated_1",
      trainingTasksetId: taskset.id,
      source: "training_model_chat_handoff",
    });
    expect(trainingModelChatTurnMetadata(handoff, "edited ambiguous question", "local_cross_system")).toBeNull();
    expect(trainingModelChatTurnMetadata(handoff, "Generated question 1", "local_other")).toBeNull();
    expect(trainingModelChatProjectError(handoff, "local_other")).toContain("source Cross-System Operations project");

    const second = selectTrainingModelChatTask(handoff, 1);
    expect(trainingModelChatTurnMetadata(second, "Generated question 2", "local_cross_system")?.crossSystemTaskId).toBe("cso_generated_2");
    expect(advanceTrainingModelChatTask(second).selectedTaskIndex).toBe(1);
  });

  test("shows generated question navigation in the existing composer and wires turn metadata", async () => {
    const base = tasksetFixture({ ready: true });
    const taskset = TasksetSchema.parse({
      ...base,
      metadata: { ...base.metadata, toolContractHash: CROSS_SYSTEM_TOOL_CONTRACT_HASH },
      sourceRefs: base.sourceRefs.map((source) => ({ ...source, workspaceId: "local_cross_system" })),
      tasks: base.tasks.map((task, index) => ({
        ...task,
        input: { ...task.input, prompt: `Generated question ${index + 1}` },
        metadata: { ...task.metadata, taskId: `cso_generated_${index + 1}` },
      })),
    });
    const handoff = buildTrainingModelChatHandoff({ modelId: "lineage_cso", taskset });
    const html = renderToStaticMarkup(createElement(TrainingModelChatHandoffBar, {
      busy: false,
      handoff,
      onDismiss: () => undefined,
      onSelectTask: () => undefined,
    }));
    expect(html).toContain("Generated Taskset question");
    expect(html).toContain("1 of 2");
    expect(html).toContain("New chat per question");
    expect(html).toContain("Load question");
    expect(html).toContain('aria-label="Next generated question"');

    const [appModules, chatActions, handoffHook, submitHook] = await Promise.all([
      Promise.all([
        readFile("apps/web/src/app/useAppPrimaryRuntime.ts", "utf8"),
        readFile("apps/web/src/app/useAppSecondaryRuntime.ts", "utf8"),
      ]),
      readFile("apps/web/src/hooks/useChatActions.ts", "utf8"),
      readFile("apps/web/src/hooks/useTrainingModelChatHandoff.ts", "utf8"),
      readFile("apps/web/src/hooks/useMainComposerSubmit.ts", "utf8"),
    ]);
    const app = appModules.join("\n");
    expect(app).toContain("prepareTrainingTurn: prepareTrainingModelChatTurn");
    expect(app).toContain("selectLocalProjectForTrainingChat");
    expect(handoffHook).toContain("selectLocalProject(next.sourceProjectId)");
    expect(handoffHook).toContain("beginIsolatedQuestionChat(next)");
    expect(handoffHook).toContain("sessionId: null");
    expect(handoffHook).toContain("trainingModelChatTurnMetadata(handoff, prompt, selectedLocalProjectId)");
    expect(submitHook).toContain("prepareTrainingTurn(promptForSubmission)");
    expect(submitHook).toContain("trainingTurn.error ??");
    expect(submitHook).toContain("trainingTurn.metadata || options.turnMetadata");
    expect(submitHook).toContain("...(trainingTurn.metadata ?? {})");
    expect(submitHook).toContain("...(options.turnMetadata ?? {})");
    expect(chatActions).toContain("metadata: options.turnMetadata");
  });

  test("carries stateful Harness case identity without exposing episode arguments", () => {
    const base = tasksetFixture({ ready: true });
    const taskset = {
      ...base,
      environment: {
        ...base.environment,
        kind: "stateful_harness",
        stateful: true,
        toolNames: ["get_portfolio_snapshot"],
        actionBindings: [
          {
            schemaVersion: "openpond.harnessActionBinding.v1",
            actionId: "get-portfolio-snapshot",
            modelToolName: "get_portfolio_snapshot",
            description: "Read the current portfolio.",
            inputSchema: {
              type: "object",
              additionalProperties: false,
              properties: {},
              required: [],
            },
            actionSchemaHash: "a".repeat(64),
            agentRelease: {
              id: "agent_marketing_fixture",
              contentHash: "b".repeat(64),
            },
            implementationHash: "c".repeat(64),
            runtimeBindingId: "profile_action_fixture",
            capabilityReceiptHash: "d".repeat(64),
            sideEffect: "read",
            studentVisible: true,
            timeoutMs: 30_000,
            episodeArgumentBindings: [
              { argument: "scenarioId", source: "case_id" },
            ],
          },
        ],
      },
      tasks: base.tasks.map((task, index) => ({
        ...task,
        input: { ...task.input, prompt: `Portfolio question ${index + 1}` },
        metadata: { ...task.metadata, caseId: `cmo_case_${index + 1}` },
      })),
    } as Taskset;
    const handoff = buildTrainingModelChatHandoff({
      modelId: "lineage_marketing",
      taskset,
    });

    expect(handoff.taskRuntime).toBe("harness");
    expect(handoff.tasks[0]?.generatedTaskId).toBe("cmo_case_1");
    expect(
      trainingModelChatTurnMetadata(
        handoff,
        "Portfolio question 1",
        null,
      ),
    ).toEqual({
      trainingHarnessTaskId: "cmo_case_1",
      trainingTasksetId: taskset.id,
      source: "training_model_chat_handoff",
    });
  });

  test("does not invent generated question controls for an unrelated Taskset", () => {
    const taskset = tasksetFixture({ ready: true });
    expect(buildTrainingModelChatHandoff({ modelId: "lineage_plain", taskset }).tasks).toEqual([]);
  });
});
