import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, test } from "vitest";
import {
  RuntimeEventSchema,
  TasksetSchema,
  type RuntimeEvent,
  type Session,
  type WorkspaceToolRequest,
  type WorkspaceToolResult,
} from "@openpond/contracts";
import { computeTasksetHash } from "@openpond/taskset-sdk";
import { createWorkOutputService } from "../apps/server/src/work/work-output-service";
import { createTaskEvaluationService } from "../apps/server/src/training/evaluation-service";
import {
  tasksetFixture,
  withTrainingStore,
} from "./helpers/training-fixtures";

describe("Taskset Work attempt runner", () => {
  test("runs the normal Work tools, persists declared outputs, and cleans up", () =>
    withTrainingStore(async ({ store, directory }) => {
      const { taskset, task, bytes } = await createWorkTaskset(directory, {
        includeParsedJsonInAttempt: true,
      });
      await store.upsertTaskset(taskset);
      let session = workSession();
      const runtimeEvents: RuntimeEvent[] = [];
      const sandboxFiles = new Map<string, Buffer>();
      const workOutputService = createWorkOutputService({
        deviceId: "device_test",
        storeDir: directory,
        runtimeEventsForSession: async () => runtimeEvents,
        sandboxRequest: async (request) => {
          if (request.type !== "download_file") {
            throw new Error(`Unexpected sandbox request ${request.type}.`);
          }
          const payload = request.payload as Record<string, unknown>;
          const file = sandboxFiles.get(String(payload.path));
          if (!file) throw new Error(`Sandbox file ${payload.path} was not found.`);
          return {
            file: {
              contentsBase64: file.toString("base64"),
              sizeBytes: file.byteLength,
              totalSizeBytes: file.byteLength,
              truncated: false,
            },
          };
        },
      });
      const workspaceActions: string[] = [];
      const runtime = {
        createSession: async () => session,
        getSession: async () => session,
        runtimeEventsForSession: async () => runtimeEvents,
        executeWorkspaceTool: async (
          _sessionId: string,
          payload: unknown,
          options?: { turnId?: string },
        ): Promise<WorkspaceToolResult> => {
          const request = payload as WorkspaceToolRequest;
          workspaceActions.push(request.action);
          runtimeEvents.push(RuntimeEventSchema.parse({
            id: `event_${runtimeEvents.length + 1}`,
            sessionId: session.id,
            turnId: options?.turnId ?? null,
            name: "workspace_action",
            timestamp: "2026-07-30T00:00:00.000Z",
            source: "server",
            status: "completed",
          }));
          if (request.action === "sandbox_create") {
            session = {
              ...session,
              workspaceKind: "sandbox",
              workspaceId: "sandbox_1",
            };
          }
          if (request.action === "sandbox_upload_file") {
            const args = request.args as Record<string, unknown>;
            sandboxFiles.set(
              String(args.path),
              Buffer.from(String(args.contentsBase64), "base64"),
            );
          }
          if (request.action === "sandbox_write_file") {
            const args = request.args as Record<string, unknown>;
            sandboxFiles.set(
              String(args.path),
              Buffer.from(String(args.content), "utf8"),
            );
          }
          if (request.action === "sandbox_save_output") {
            const args = request.args as Record<string, unknown>;
            const saved = await workOutputService.saveWorkOutput({
              session,
              sourceTurnId: options?.turnId ?? "turn_test",
              sandboxPath: String(args.path),
              suggestedName:
                typeof args.suggestedName === "string"
                  ? args.suggestedName
                  : null,
              validation: [],
            });
            return result(request, saved);
          }
          return result(
            request,
            request.action === "sandbox_status"
              ? { sandbox: { id: "sandbox_1", state: "running" } }
              : {},
          );
        },
      };
      let modelRound = 0;
      let firstModelSystemMessage = "";
      const evaluation = createTaskEvaluationService({
        store,
        storeDir: directory,
        modelText: async () => "",
        modelStream: async function* (input) {
          if (!firstModelSystemMessage) {
            firstModelSystemMessage = input.messages[0]?.content ?? "";
          }
          if (modelRound++ === 0) {
            yield {
              toolCalls: [{
                id: "call_write",
                type: "function",
                function: {
                  name: "work_write_file",
                  arguments: JSON.stringify({
                    area: "outputs",
                    path: "normalized.json",
                    content: JSON.stringify({
                      rows: [{ sku: "A", count: 2 }],
                    }),
                  }),
                },
              }],
              usage: { promptTokens: 100, completionTokens: 20 },
              costUsd: 0.01,
            };
            return;
          }
          yield {
            text: "Completed the normalized inventory.",
            usage: { promptTokens: 120, completionTokens: 10 },
            costUsd: 0.01,
          };
        },
        workRuntime: runtime,
      });
      const execution = await evaluation.execute({
        tasksetId: taskset.id,
        taskId: task.id,
        model: {
          providerId: "openpond",
          modelId: "openpond-chat",
        },
        seed: 17,
        attempt: 0,
        resultId: "attempt_taskset_work_success",
      });
      const { attempt, artifacts } = execution;
      expect(
        attempt.infrastructureError,
        JSON.stringify({ attempt, workspaceActions }, null, 2),
      ).toBeNull();
      expect(sandboxFiles.get("inputs/inventory.csv")).toEqual(bytes);
      expect(firstModelSystemMessage).toContain(
        createHash("sha256").update(bytes).digest("hex"),
      );
      expect(firstModelSystemMessage).not.toContain("\"bytes\"");
      expect(firstModelSystemMessage).not.toContain("\"type\":\"Buffer\"");
      expect(workspaceActions).toContain("sandbox_create");
      expect(workspaceActions.at(-1)).toBe("sandbox_stop");
      expect(attempt).toMatchObject({
        infrastructureError: null,
        costUsd: 0.02,
        output: {
          text: "Completed the normalized inventory.",
          outputsPassed: true,
          requiredOutputs: [
            {
              path: "normalized.json",
              mediaType: "application/json",
              passed: true,
              parsedJson: {
                rows: [{ sku: "A", count: 2 }],
              },
            },
          ],
        },
        metadata: {
          execution: "taskset_work",
          status: "completed",
          runtimeProfileId: "openpond-work-v1",
        },
      });
      expect(attempt.runtimeEventRefs.length).toBeGreaterThan(0);
      expect(await store.runtimeEventsForSession(session.id)).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            name: "turn.started",
            status: "started",
          }),
          expect.objectContaining({
            name: "tool.started",
            action: "work_write_file",
            status: "started",
          }),
          expect.objectContaining({
            name: "tool.completed",
            action: "work_write_file",
            status: "completed",
          }),
          expect.objectContaining({
            name: "assistant.delta",
            output: "Completed the normalized inventory.",
          }),
          expect.objectContaining({
            name: "turn.completed",
            status: "completed",
          }),
        ]),
      );
      expect(await store.getTurn(attempt.metadata.turnId as string)).toMatchObject({
        prompt: expect.stringContaining("Normalize the staged inventory"),
        status: "completed",
        completedAt: expect.any(String),
      });
      expect(artifacts.map((artifact) => artifact.kind).sort()).toEqual([
        "grader_evidence",
        "grader_evidence",
        "grader_evidence",
        "output_artifact",
        "runtime_trace",
      ]);
      expect(
        artifacts
          .filter((artifact) => artifact.kind === "grader_evidence")
          .map((artifact) => artifact.path),
      ).toEqual(expect.arrayContaining([
        expect.stringMatching(/artifact-manifest\.json$/),
        expect.stringMatching(/canonical-rollout\.json$/),
        expect.stringMatching(/reward-receipt\.json$/),
      ]));
      expect(attempt.artifactRefs).toEqual(
        expect.arrayContaining(artifacts.map((artifact) => artifact.id)),
      );
      expect(execution.grade).toMatchObject({
        passed: true,
        score: 1,
        rewardEligible: true,
        failureClass: null,
      });
      expect(await store.listTaskAttempts(taskset.id)).toContainEqual(attempt);
      expect(await store.listGradeResultsForTaskset(taskset.id)).toContainEqual(
        execution.grade,
      );
    }));

  test("reconciles and persists a sole compatible output with a friendly filename", () =>
    withTrainingStore(async ({ store, directory }) => {
      const { taskset, task } = await createWorkTaskset(directory);
      await store.upsertTaskset(taskset);
      let session = workSession();
      const sandboxFiles = new Map<string, Buffer>();
      const workOutputService = createWorkOutputService({
        deviceId: "device_test",
        storeDir: directory,
        runtimeEventsForSession: async () => [],
        sandboxRequest: async (request) => {
          if (request.type !== "download_file") {
            throw new Error(`Unexpected sandbox request ${request.type}.`);
          }
          const payload = request.payload as Record<string, unknown>;
          const file = sandboxFiles.get(String(payload.path));
          if (!file) {
            throw new Error(`Sandbox file ${payload.path} was not found.`);
          }
          return {
            file: {
              contentsBase64: file.toString("base64"),
              sizeBytes: file.byteLength,
              totalSizeBytes: file.byteLength,
              truncated: false,
            },
          };
        },
      });
      const workspaceActions: string[] = [];
      const runtime = {
        createSession: async () => session,
        getSession: async () => session,
        runtimeEventsForSession: async () => [],
        executeWorkspaceTool: async (
          _sessionId: string,
          payload: unknown,
          options?: { turnId?: string },
        ): Promise<WorkspaceToolResult> => {
          const request = payload as WorkspaceToolRequest;
          workspaceActions.push(request.action);
          if (request.action === "sandbox_create") {
            session = {
              ...session,
              workspaceKind: "sandbox",
              workspaceId: "sandbox_saved_output",
            };
          }
          if (request.action === "sandbox_upload_file") {
            const args = request.args as Record<string, unknown>;
            sandboxFiles.set(
              String(args.path),
              Buffer.from(String(args.contentsBase64), "base64"),
            );
          }
          if (request.action === "sandbox_write_file") {
            const args = request.args as Record<string, unknown>;
            sandboxFiles.set(
              String(args.path),
              Buffer.from(String(args.content), "utf8"),
            );
          }
          if (request.action === "sandbox_list_files") {
            return result(request, {
              files: [...sandboxFiles.keys()].filter((filePath) =>
                filePath.startsWith("outputs/")
              ),
            });
          }
          if (request.action === "sandbox_save_output") {
            const args = request.args as Record<string, unknown>;
            const saved = await workOutputService.saveWorkOutput({
              session,
              sourceTurnId: options?.turnId ?? "turn_test",
              sandboxPath: String(args.path),
              suggestedName:
                typeof args.suggestedName === "string"
                  ? args.suggestedName
                  : null,
              validation: [],
            });
            return result(request, saved);
          }
          return result(
            request,
            request.action === "sandbox_status"
              ? { sandbox: { id: "sandbox_saved_output", state: "running" } }
              : {},
          );
        },
      };
      let modelRounds = 0;
      const evaluation = createTaskEvaluationService({
        store,
        storeDir: directory,
        modelText: async () => "",
        modelStream: async function* () {
          modelRounds += 1;
          if (modelRounds === 1) {
            yield {
              toolCalls: [{
                id: "call_write",
                type: "function",
                function: {
                  name: "work_write_file",
                  arguments: JSON.stringify({
                    area: "outputs",
                    path: "friendly-inventory.json",
                    content: JSON.stringify({
                      rows: [{ sku: "A", count: 2 }],
                    }),
                  }),
                },
              }],
            };
            return;
          }
          throw new Error("The model received a turn after saving all outputs.");
        },
        workRuntime: runtime,
      });

      const execution = await evaluation.execute({
        tasksetId: taskset.id,
        taskId: task.id,
        model: {
          providerId: "openpond",
          modelId: "openpond-chat",
        },
        seed: 17,
        attempt: 0,
        resultId: "attempt_taskset_work_saved_output_completion",
      });

      expect(modelRounds).toBe(1);
      expect(workspaceActions.at(-1)).toBe("sandbox_stop");
      expect(execution.attempt).toMatchObject({
        infrastructureError: null,
        output: {
          outputsPassed: true,
          requiredOutputs: [{
            path: "normalized.json",
            passed: true,
          }],
        },
        metadata: {
          status: "completed",
          failureClass: null,
        },
      });
      expect(execution.grade).toMatchObject({
        passed: true,
        score: 1,
        rewardEligible: true,
      });
    }));

  test("classifies environment startup failure as reward-ineligible and cleans up", () =>
    withTrainingStore(async ({ store, directory }) => {
      const { taskset, task } = await createWorkTaskset(directory);
      await store.upsertTaskset(taskset);
      let session = workSession();
      const workspaceActions: string[] = [];
      let modelCalled = false;
      const evaluation = createTaskEvaluationService({
        store,
        storeDir: directory,
        modelText: async () => "",
        modelStream: async function* () {
          modelCalled = true;
          yield { text: "should not run" };
        },
        workRuntime: {
          createSession: async () => session,
          getSession: async () => session,
          runtimeEventsForSession: async () => [],
          executeWorkspaceTool: async (
            _sessionId: string,
            payload: unknown,
          ): Promise<WorkspaceToolResult> => {
            const request = payload as WorkspaceToolRequest;
            workspaceActions.push(request.action);
            if (request.action === "sandbox_create") {
              session = {
                ...session,
                workspaceKind: "sandbox",
                workspaceId: "sandbox_startup_failure",
              };
              return result(request, {});
            }
            if (request.action === "sandbox_status") {
              return {
                ok: false,
                action: request.action,
                output: "Sandbox capacity is temporarily unavailable.",
              };
            }
            return result(request, {});
          },
        },
      });

      const execution = await evaluation.execute({
        tasksetId: taskset.id,
        taskId: task.id,
        model: {
          providerId: "openpond",
          modelId: "openpond-chat",
        },
        seed: 17,
        attempt: 0,
        resultId: "attempt_taskset_work_environment_failure",
        hostedTokenPricing: {
          version: "test-v1",
          source: "test",
          effectiveAt: "2026-08-11T00:00:00.000Z",
          inputUsdPerMillionTokens: 2,
          cachedInputUsdPerMillionTokens: 0.5,
          outputUsdPerMillionTokens: 4,
        },
      });

      expect(modelCalled).toBe(false);
      expect(workspaceActions).toContain("sandbox_stop");
      expect(execution.attempt).toMatchObject({
        metadata: {
          execution: "taskset_work",
          status: "environment_failure",
          failureClass: "environment_failure",
        },
      });
      expect(execution.attempt.infrastructureError).toContain(
        "Sandbox capacity is temporarily unavailable.",
      );
      expect(execution.attempt.costUsd).toBe(0);
      expect(execution.attempt.metadata.costEvidence).toMatchObject({
        providerInferenceUsd: 0,
        combinedUsd: 0,
      });
      expect(execution.grade).toMatchObject({
        passed: false,
        score: null,
        rewardEligible: false,
        failureClass: "environment_failure",
      });
    }));

  test("keeps sandbox compute lazy for direct-answer tasks without files", () =>
    withTrainingStore(async ({ store, directory }) => {
      const { taskset, task } = await createWorkTaskset(directory, {
        directAnswer: true,
      });
      await store.upsertTaskset(taskset);
      const workspaceActions: string[] = [];
      const { runtime } = successfulRuntime(workspaceActions);
      const evaluation = createTaskEvaluationService({
        store,
        storeDir: directory,
        modelText: async () => "",
        modelStream: async function* () {
          yield { text: "A complete direct answer that requires no files." };
        },
        workRuntime: runtime,
      });

      const execution = await evaluation.execute({
        tasksetId: taskset.id,
        taskId: task.id,
        model: { providerId: "openpond", modelId: "openpond-chat" },
        seed: 17,
        attempt: 0,
        resultId: "attempt_taskset_work_lazy_direct_answer",
      });

      expect(workspaceActions).not.toContain("sandbox_create");
      expect(workspaceActions).not.toContain("sandbox_status");
      expect(workspaceActions).not.toContain("sandbox_exec");
      expect(execution.attempt).toMatchObject({
        infrastructureError: null,
        output: { text: "A complete direct answer that requires no files." },
        metadata: { status: "completed", failureClass: null },
      });
    }));

  test("classifies timeout separately, produces no reward, and stops compute", () =>
    withTrainingStore(async ({ store, directory }) => {
      const { taskset, task } = await createWorkTaskset(directory, {
        timeoutMs: 10,
      });
      await store.upsertTaskset(taskset);
      const workspaceActions: string[] = [];
      const { runtime } = successfulRuntime(workspaceActions);
      const evaluation = createTaskEvaluationService({
        store,
        storeDir: directory,
        modelText: async () => "",
        modelStream: async function* (request) {
          await new Promise<void>((_resolve, reject) => {
            request.signal.addEventListener(
              "abort",
              () => reject(request.signal.reason),
              { once: true },
            );
          });
          if (false) yield {};
        },
        workRuntime: runtime,
      });

      const execution = await evaluation.execute({
        tasksetId: taskset.id,
        taskId: task.id,
        model: {
          providerId: "openpond",
          modelId: "openpond-chat",
        },
        seed: 17,
        attempt: 0,
        resultId: "attempt_taskset_work_timeout",
      });

      expect(workspaceActions).toContain("sandbox_stop");
      expect(execution.attempt).toMatchObject({
        metadata: {
          status: "timeout",
          failureClass: "timeout",
        },
      });
      expect(execution.grade).toMatchObject({
        score: null,
        passed: false,
        rewardEligible: false,
        failureClass: "timeout",
      });
    }));

  test("enforces the model-request deadline when a provider ignores its abort signal", () =>
    withTrainingStore(async ({ store, directory }) => {
      const { taskset, task } = await createWorkTaskset(directory, {
        modelRequestTimeoutMs: 10,
      });
      await store.upsertTaskset(taskset);
      const workspaceActions: string[] = [];
      const { runtime } = successfulRuntime(workspaceActions);
      const evaluation = createTaskEvaluationService({
        store,
        storeDir: directory,
        modelText: async () => "",
        modelStream: async function* () {
          await new Promise<void>(() => {});
          if (false) yield {};
        },
        workRuntime: runtime,
      });

      const execution = await evaluation.execute({
        tasksetId: taskset.id,
        taskId: task.id,
        model: {
          providerId: "openpond",
          modelId: "openpond-chat",
        },
        seed: 17,
        attempt: 0,
        resultId: "attempt_taskset_work_model_request_timeout",
      });

      expect(workspaceActions).toContain("sandbox_stop");
      expect(execution.attempt).toMatchObject({
        infrastructureError: "Work model request exceeded 10 ms.",
        metadata: {
          status: "timeout",
          failureClass: "timeout",
        },
      });
    }));

  test.each([
    {
      label: "total tool calls",
      options: { maxToolCalls: 1 },
      secondArgs: { area: "outputs", recursive: true },
      exhaustion: "at 1 total calls",
    },
    {
      label: "per-tool calls",
      options: {
        maxToolCalls: 10,
        maxToolCallsPerName: { work_list_files: 1 },
      },
      secondArgs: { area: "outputs", recursive: true },
      exhaustion: "work_list_files budget exhausted at 1 calls",
    },
    {
      label: "identical calls",
      options: { maxToolCalls: 10, maxIdenticalToolCalls: 1 },
      secondArgs: { recursive: false, area: "outputs" },
      exhaustion: "Identical model-requested tool-call budget exhausted at 1 calls",
    },
  ])("makes $label visible and classifies exhaustion as an agent outcome", ({
    options,
    secondArgs,
    exhaustion,
  }) => withTrainingStore(async ({ store, directory }) => {
    const { taskset, task } = await createWorkTaskset(directory, options);
    await store.upsertTaskset(taskset);
    const workspaceActions: string[] = [];
    const { runtime } = successfulRuntime(workspaceActions);
    let systemMessage = "";
    const evaluation = createTaskEvaluationService({
      store,
      storeDir: directory,
      modelText: async () => "",
      modelStream: async function* (request) {
        systemMessage = request.messages[0]?.content ?? "";
        yield {
          toolCalls: [
            {
              id: "call_list_1",
              type: "function",
              function: {
                name: "work_list_files",
                arguments: JSON.stringify({ area: "outputs", recursive: false }),
              },
            },
            {
              id: "call_list_2",
              type: "function",
              function: {
                name: "work_list_files",
                arguments: JSON.stringify(secondArgs),
              },
            },
          ],
        };
      },
      workRuntime: runtime,
    });

    const execution = await evaluation.execute({
      tasksetId: taskset.id,
      taskId: task.id,
      model: { providerId: "openpond", modelId: "openpond-chat" },
      seed: 17,
      attempt: 0,
      resultId: `attempt_taskset_work_budget_${options.maxToolCalls}`,
    });

    expect(systemMessage).toContain("Resource budget:");
    expect(workspaceActions.filter((action) => action === "sandbox_list_files")).toHaveLength(1);
    expect(execution.attempt).toMatchObject({
      infrastructureError: null,
      metadata: {
        status: "budget_exhausted",
        failureClass: null,
        toolCallBudget: {
          consumedTotal: 1,
          consumedPerName: { work_list_files: 1 },
          exhaustion: expect.stringContaining(exhaustion),
        },
      },
    });
    expect(execution.grade).toMatchObject({
      passed: false,
      rewardEligible: true,
      failureClass: "policy_failure",
    });
  }));

  test("classifies cancellation separately and stops the active sandbox", () =>
    withTrainingStore(async ({ store, directory }) => {
      const { taskset, task } = await createWorkTaskset(directory);
      await store.upsertTaskset(taskset);
      const workspaceActions: string[] = [];
      const { runtime } = successfulRuntime(workspaceActions);
      const controller = new AbortController();
      const evaluation = createTaskEvaluationService({
        store,
        storeDir: directory,
        modelText: async () => "",
        modelStream: async function* (request) {
          controller.abort(new Error("Cancelled by deterministic fixture."));
          throw request.signal.reason;
          if (false) yield {};
        },
        workRuntime: runtime,
      });

      const execution = await evaluation.execute({
        tasksetId: taskset.id,
        taskId: task.id,
        model: {
          providerId: "openpond",
          modelId: "openpond-chat",
        },
        seed: 17,
        attempt: 0,
        signal: controller.signal,
        resultId: "attempt_taskset_work_cancelled",
      });

      expect(workspaceActions).toContain("sandbox_stop");
      expect(execution.attempt).toMatchObject({
        metadata: {
          status: "cancelled",
          failureClass: "cancelled",
        },
      });
      expect(execution.grade).toMatchObject({
        score: null,
        passed: false,
        rewardEligible: false,
        failureClass: "cancelled",
      });
    }));

  test("makes cleanup failure reward-ineligible even after model completion", () =>
    withTrainingStore(async ({ store, directory }) => {
      const { taskset, task } = await createWorkTaskset(directory);
      await store.upsertTaskset(taskset);
      const workspaceActions: string[] = [];
      const { runtime } = successfulRuntime(workspaceActions, {
        stopOk: false,
      });
      const evaluation = createTaskEvaluationService({
        store,
        storeDir: directory,
        modelText: async () => "",
        modelStream: async function* () {
          yield { text: "Model completed before cleanup." };
        },
        workRuntime: runtime,
      });

      const execution = await evaluation.execute({
        tasksetId: taskset.id,
        taskId: task.id,
        model: {
          providerId: "openpond",
          modelId: "openpond-chat",
        },
        seed: 17,
        attempt: 0,
        resultId: "attempt_taskset_work_cleanup_failure",
      });

      expect(workspaceActions.at(-1)).toBe("sandbox_stop");
      expect(execution.attempt.infrastructureError).toContain(
        "Work cleanup failed",
      );
      expect(execution.grade).toMatchObject({
        score: null,
        passed: false,
        rewardEligible: false,
        failureClass: "infrastructure_failure",
      });
    }));

  test("reconciles provider inference and Work receipt cost without losing latency", () =>
    withTrainingStore(async ({ store, directory }) => {
      const { taskset, task } = await createWorkTaskset(directory);
      await store.upsertTaskset(taskset);
      const workspaceActions: string[] = [];
      const { runtime } = successfulRuntime(workspaceActions, {
        stopData: {
          sandbox: {
            receipts: [{
              id: "receipt_taskset_work_cost",
              status: "captured",
              totalUsd: "0.001750",
              durationSeconds: 7,
              mpp: {
                mode: "mpp_service_hook",
              },
            }, {
              id: "receipt_taskset_work_simulated",
              status: "captured",
              totalUsd: "0.026552",
              durationSeconds: 600,
              mpp: {
                mode: "simulated_poc",
              },
            }],
          },
        },
      });
      const evaluation = createTaskEvaluationService({
        store,
        storeDir: directory,
        modelText: async () => "",
        modelStream: async function* () {
          yield {
            text: "Completed without a valid output.",
            costUsd: 0.0125,
            usage: {
              promptTokens: 100,
              completionTokens: 12,
            },
          };
        },
        workRuntime: runtime,
      });

      const execution = await evaluation.execute({
        tasksetId: taskset.id,
        taskId: task.id,
        model: {
          providerId: "openpond",
          modelId: "openpond-chat",
        },
        seed: 17,
        attempt: 0,
        resultId: "attempt_taskset_work_cost",
      });

      expect(execution.attempt.costUsd).toBeCloseTo(0.01425, 8);
      expect(execution.attempt.metadata.costEvidence).toEqual({
        providerInferenceUsd: 0.0125,
        workRuntimeUsd: 0.028302,
        workRuntimeBillableUsd: 0.00175,
        workRuntimeSimulatedUsd: 0.026552,
        combinedUsd: 0.01425,
        workReceiptIds: [
          "receipt_taskset_work_cost",
          "receipt_taskset_work_simulated",
        ],
        workDurationSeconds: 607,
        settlementModes: ["mpp_service_hook", "simulated_poc"],
      });
      expect(execution.attempt.latencyMs).toBe(
        Date.parse(execution.attempt.completedAt)
          - Date.parse(execution.attempt.startedAt),
      );
      expect(workspaceActions.at(-1)).toBe("sandbox_stop");
    }));

  test("derives provider cost from admitted pricing when the stream omits cost", () =>
    withTrainingStore(async ({ store, directory }) => {
      const { taskset, task } = await createWorkTaskset(directory);
      await store.upsertTaskset(taskset);
      const workspaceActions: string[] = [];
      const { runtime } = successfulRuntime(workspaceActions);
      const evaluation = createTaskEvaluationService({
        store,
        storeDir: directory,
        modelText: async () => "",
        modelStream: async function* () {
          yield {
            text: "Completed without a valid output.",
            usage: {
              promptTokens: 1_000,
              completionTokens: 200,
              promptTokensDetails: { cachedTokens: 400 },
            },
          };
        },
        workRuntime: runtime,
      });

      const execution = await evaluation.execute({
        tasksetId: taskset.id,
        taskId: task.id,
        model: {
          providerId: "openpond",
          modelId: "openpond-chat",
        },
        seed: 17,
        attempt: 0,
        resultId: "attempt_taskset_work_pricing_fallback",
        hostedTokenPricing: {
          version: "test-v1",
          source: "test",
          effectiveAt: "2026-08-11T00:00:00.000Z",
          inputUsdPerMillionTokens: 2,
          cachedInputUsdPerMillionTokens: 0.5,
          outputUsdPerMillionTokens: 4,
        },
      });

      expect(execution.attempt.costUsd).toBeCloseTo(0.0022, 8);
      expect(execution.attempt.metadata.costEvidence).toMatchObject({
        providerInferenceUsd: 0.0022,
        combinedUsd: 0.0022,
      });
      expect(workspaceActions.at(-1)).toBe("sandbox_stop");
    }));

  test("records cost from the settled receipt read when stop omits receipts", () =>
    withTrainingStore(async ({ store, directory }) => {
      const { taskset, task } = await createWorkTaskset(directory);
      await store.upsertTaskset(taskset);
      const workspaceActions: string[] = [];
      const { runtime } = successfulRuntime(workspaceActions, {
        settledCostData: {
          receipts: [{
            id: "receipt_taskset_work_delayed",
            status: "captured",
            totalUsd: "0.004125",
            durationSeconds: 11,
            mpp: {
              mode: "simulated_poc",
            },
          }],
        },
      });
      const evaluation = createTaskEvaluationService({
        store,
        storeDir: directory,
        modelText: async () => "",
        modelStream: async function* () {
          yield {
            text: "Completed without a valid output.",
            costUsd: 0,
          };
        },
        workRuntime: runtime,
      });

      const execution = await evaluation.execute({
        tasksetId: taskset.id,
        taskId: task.id,
        model: {
          providerId: "openpond",
          modelId: "openpond-chat",
        },
        seed: 17,
        attempt: 0,
        resultId: "attempt_taskset_work_delayed_cost",
      });

      expect(execution.attempt.costUsd).toBe(0);
      expect(execution.attempt.metadata.costEvidence).toEqual({
        providerInferenceUsd: 0,
        workRuntimeUsd: 0.004125,
        workRuntimeBillableUsd: 0,
        workRuntimeSimulatedUsd: 0.004125,
        combinedUsd: 0,
        workReceiptIds: ["receipt_taskset_work_delayed"],
        workDurationSeconds: 11,
        settlementModes: ["simulated_poc"],
      });
    }));

  test("persists an explicit reward-ineligible grade when a grader throws", () =>
    withTrainingStore(async ({ store, directory }) => {
      const materialized = await createWorkTaskset(directory);
      const judge = {
        id: "judge_failure_fixture",
        version: "1",
        label: "Failing judge fixture",
        kind: "model_judge" as const,
        weight: 1,
        hardGate: true,
        rewardEligible: true,
        privileged: true,
        rubric: "Validate the completed Work output.",
        judge: {
          providerId: "openpond",
          modelId: "openpond-chat",
        },
        calibrationFixtureRefs: ["fixture_positive"],
        calibrationStatus: "passed" as const,
        temperature: 0,
        metadata: {},
      };
      const unhashed = TasksetSchema.parse({
        ...materialized.taskset,
        graders: [judge],
        contentHash: "00000000",
      });
      const taskset = TasksetSchema.parse({
        ...unhashed,
        contentHash: computeTasksetHash(unhashed),
      });
      await store.upsertTaskset(taskset);
      const workspaceActions: string[] = [];
      const { runtime } = successfulRuntime(workspaceActions);
      const evaluation = createTaskEvaluationService({
        store,
        storeDir: directory,
        modelText: async () => "",
        modelStream: async function* () {
          yield { text: "Completed before grading." };
        },
        workRuntime: runtime,
        modelJudge: async () => {
          throw new Error("Deterministic grader outage.");
        },
      });

      const execution = await evaluation.execute({
        tasksetId: taskset.id,
        taskId: taskset.tasks[0]!.id,
        model: {
          providerId: "openpond",
          modelId: "openpond-chat",
        },
        seed: 17,
        attempt: 0,
        resultId: "attempt_taskset_work_grader_failure",
      });

      expect(workspaceActions.at(-1)).toBe("sandbox_stop");
      expect(execution.attempt.infrastructureError).toBeNull();
      expect(execution.grade).toMatchObject({
        score: null,
        passed: false,
        rewardEligible: false,
        failureClass: "grader_failure",
        feedback: ["Taskset grader failed: Deterministic grader outage."],
      });
      expect(await store.listTaskAttempts(taskset.id)).toContainEqual(
        execution.attempt,
      );
      expect(await store.listGradeResultsForTaskset(taskset.id)).toContainEqual(
        execution.grade,
      );
    }));
});

async function createWorkTaskset(
  storeDir: string,
  options: {
    timeoutMs?: number;
    includeParsedJsonInAttempt?: boolean;
    modelRequestTimeoutMs?: number;
    maxToolCalls?: number;
    maxIdenticalToolCalls?: number;
    maxToolCallsPerName?: Record<string, number>;
    directAnswer?: boolean;
  } = {},
) {
  const base = tasksetFixture();
  const bytes = Buffer.from("sku,count\nA,2\n", "utf8");
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  const source = {
    schemaVersion: "openpond.uploadedFileDatasetSource.v1" as const,
    id: "source_inventory",
    kind: "uploaded_file" as const,
    profileId: base.profileId,
    title: "Inventory",
    sourceHash: sha256,
    occurredAt: "2026-07-30T00:00:00.000Z",
    licensingStatus: "approved" as const,
    secretScanStatus: "passed" as const,
    piiScanStatus: "passed" as const,
    metadata: {},
    originalFileNames: ["inventory.csv"],
    mediaTypes: ["text/csv"],
    sourceFileHashes: [sha256],
    totalBytes: bytes.byteLength,
    parserVersion: "fixture-v1",
  };
  const task = {
    ...base.tasks[0]!,
    sourceRefs: [source.id],
    input: {
      prompt: "Normalize the staged inventory into the required JSON output.",
    },
    expectedOutput: {
      outputsPassed: true,
    },
    assets: options.directAnswer ? [] : [{
      id: "asset_inventory",
      sourceRefId: source.id,
      artifactRef: "assets/inventory.csv",
      fileName: "inventory.csv",
      mediaType: "text/csv",
      sha256,
      sizeBytes: bytes.byteLength,
      split: base.tasks[0]!.split,
      metadata: {},
    }],
    requiredOutputs: options.directAnswer ? [] : [{
      path: "normalized.json",
      mediaType: "application/json",
      schemaRef: "normalized-inventory-v1",
      maxBytes: 100_000,
      metadata: options.includeParsedJsonInAttempt
        ? { includeParsedJsonInAttempt: true }
        : {},
    }],
  };
  const draft = TasksetSchema.parse({
    ...base,
    sourceRefs: [source, base.sourceRefs[1]!],
    environment: {
      ...base.environment,
      kind: "work",
      entrypoint: "openpond-work-v1",
      toolNames: [
        "work_environment",
        "work_read_file",
        "work_write_file",
        "work_exec",
        "work_list_files",
        "work_save_output",
      ],
      metadata: {
        maxToolTurns: 8,
        maxInputBytes: 1_000_000,
        ...(options.maxToolCalls !== undefined
          ? { maxToolCalls: options.maxToolCalls }
          : {}),
        ...(options.maxIdenticalToolCalls !== undefined
          ? { maxIdenticalToolCalls: options.maxIdenticalToolCalls }
          : {}),
        ...(options.maxToolCallsPerName !== undefined
          ? { maxToolCallsPerName: options.maxToolCallsPerName }
          : {}),
        ...(options.modelRequestTimeoutMs !== undefined
          ? { modelRequestTimeoutMs: options.modelRequestTimeoutMs }
          : {}),
      },
      defaultTimeoutMs: options.timeoutMs ?? base.environment.defaultTimeoutMs,
    },
    tasks: [
      task,
      {
        ...base.tasks[1]!,
        requiredOutputs: [{
          path: "normalized.json",
          mediaType: "application/json",
          metadata: {},
        }],
      },
    ],
    graders: [{
      id: "required_work_output",
      version: "1",
      label: "Required Work output",
      kind: "state",
      config: {
        fields: ["outputsPassed"],
      },
      weight: 1,
      hardGate: true,
      rewardEligible: true,
      privileged: false,
      metadata: {},
    }],
    contentHash: "00000000",
  });
  const taskset = TasksetSchema.parse({
    ...draft,
    contentHash: computeTasksetHash(draft),
  });
  const assetDirectory = path.join(
    storeDir,
    "training",
    "tasksets",
    taskset.id,
    "assets",
  );
  await mkdir(assetDirectory, { recursive: true });
  await writeFile(path.join(assetDirectory, "inventory.csv"), bytes);
  return {
    taskset,
    task: taskset.tasks[0]!,
    bytes,
  };
}

function successfulRuntime(
  workspaceActions: string[],
  options: {
    stopOk?: boolean;
    stopData?: Record<string, unknown>;
    settledCostData?: Record<string, unknown>;
  } = {},
) {
  let session = workSession();
  return {
    runtime: {
      createSession: async () => session,
      getSession: async () => session,
      runtimeEventsForSession: async () => [],
      executeWorkspaceTool: async (
        _sessionId: string,
        payload: unknown,
      ): Promise<WorkspaceToolResult> => {
        const request = payload as WorkspaceToolRequest;
        workspaceActions.push(request.action);
        if (request.action === "sandbox_create") {
          session = {
            ...session,
            workspaceKind: "sandbox",
            workspaceId: "sandbox_1",
          };
        }
        if (request.action === "sandbox_stop" && options.stopOk === false) {
          return {
            ok: false,
            action: request.action,
            output: "Provider refused the cleanup request.",
          };
        }
        return result(
          request,
          request.action === "sandbox_status"
            ? { sandbox: { id: "sandbox_1", state: "running" } }
            : request.action === "sandbox_stop"
              ? options.stopData ?? {}
              : {},
        );
      },
      ...(options.settledCostData
        ? {
            settleCostEvidence: async (): Promise<WorkspaceToolResult> => ({
              ok: true,
              action: "sandbox_receipts",
              output: "ok",
              data: options.settledCostData,
            }),
          }
        : {}),
    },
  };
}

function workSession(): Session {
  return {
    id: "session_taskset_work",
    experience: "work",
    provider: "openpond",
    modelRef: {
      providerId: "openpond",
      modelId: "openpond-chat",
    },
    openPondCommandAccessMode: "disabled",
    systemKind: null,
    hiddenFromDefaultSidebar: true,
    parentSessionId: null,
    parentTurnId: null,
    subagentRunId: null,
    subagentRoleId: null,
    subagentDelegationMode: null,
    title: "Automated Taskset Work attempt",
    appId: null,
    appName: null,
    workspaceKind: undefined,
    workspaceId: null,
    workspaceName: null,
    localProjectId: null,
    cloudProjectId: null,
    cloudTeamId: null,
    currentProfile: null,
    cwd: null,
    codexThreadId: null,
    createdAt: "2026-07-30T00:00:00.000Z",
    updatedAt: "2026-07-30T00:00:00.000Z",
    status: "idle",
    runtimeSeconds: 0,
    runtimeRunningSince: null,
    pinned: false,
    savedForLater: false,
    archived: false,
    order: 0,
  };
}

function result(
  request: WorkspaceToolRequest,
  data: Record<string, unknown>,
): WorkspaceToolResult {
  return {
    ok: true,
    action: request.action,
    output: "ok",
    data,
  };
}
