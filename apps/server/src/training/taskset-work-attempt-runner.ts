import path from "node:path";
import {
  TaskAttemptResultSchema,
  TurnSchema,
  type ChatModelRef,
  type CodexReasoningEffort,
  type RuntimeEvent,
  type Session,
  type TaskDataRecord,
  type TaskFailureClass,
  type Taskset,
  type WorkspaceDiffSummary,
  type WorkspaceToolResult,
} from "@openpond/contracts";
import type {
  HostedChatContinuation,
  HostedChatMessage,
  HostedChatTool,
  HostedChatToolCall,
  HostedChatToolChoice,
} from "@openpond/cloud";
import { contentHash } from "@openpond/taskset-sdk";
import {
  assistantMessageForNativeToolCalls,
  invalidNativeToolArgumentsResult,
  NativeToolCallAccumulator,
  parseNativeToolArguments,
  toolResultMessage,
  unknownNativeToolResult,
  type NativeModelToolResult,
} from "../openpond/native-tool-calls.js";
import {
  modelToolDefinitionToHostedTool,
  type ModelToolDefinition,
} from "../openpond/model-tool-registry.js";
import { createWorkModelToolDefinitions } from "../openpond/work-tool-registry.js";
import type { SqliteStore } from "../store/store.js";
import {
  persistJsonTaskAttemptArtifact,
  persistTaskAttemptOutputArtifact,
} from "./task-attempt-artifact-service.js";
import {
  sumUsd,
  workRuntimeCostEvidence,
  type WorkRuntimeCostEvidence,
} from "./taskset-work-cost-evidence.js";
import { resolveTasksetWorkAssets } from "./taskset-work-assets.js";
import {
  executeDefinition,
  savedWorkOutput,
  validateSavedOutput,
  workToolTurnLimit,
  type SavedOutputValidation,
  type SavedWorkOutput,
  type TasksetWorkRequiredOutputValidator,
} from "./taskset-work-attempt-support.js";
import {
  appendTasksetAssistantText,
  appendTasksetToolCompleted,
  appendTasksetToolLifecycle,
  appendTasksetToolStarted,
  appendTasksetTurnTerminal,
  appendTasksetTurnStarted,
} from "./taskset-work-lifecycle-events.js";
import {
  tasksetWorkMessages,
  tasksetWorkUserPrompt,
} from "./taskset-work-prompt.js";
import {
  hostedUsageCostUsd,
  type HostedTokenPricing,
} from "./hosted-token-pricing.js";

export type TasksetWorkModelDelta = {
  text?: string;
  continuation?: HostedChatContinuation;
  toolCalls?: HostedChatToolCall[];
  usage?: unknown;
  costUsd?: number;
};

export type TasksetWorkModelStream = (input: {
  model: ChatModelRef;
  reasoningEffort: CodexReasoningEffort | "none" | null;
  messages: HostedChatMessage[];
  tools: HostedChatTool[];
  toolChoice: HostedChatToolChoice;
  requestId: string;
  signal: AbortSignal;
  maxOutputTokens?: number;
  temperature?: number;
  topP?: number;
  seed?: number;
  hostedTokenPricing?: HostedTokenPricing;
}) => AsyncIterable<TasksetWorkModelDelta>;

export type { TasksetWorkRequiredOutputValidator } from "./taskset-work-attempt-support.js";

export type TasksetWorkToolEvidence = {
  execute(input: {
    taskId: string;
    callId: string;
    toolName: string;
    args: Record<string, unknown>;
    execute: () => Promise<NativeModelToolResult>;
  }): Promise<NativeModelToolResult>;
};

export type TasksetWorkAttemptRuntime = {
  createSession(payload: unknown): Promise<Session>;
  getSession(sessionId: string): Promise<Session>;
  executeWorkspaceTool(
    sessionId: string,
    payload: unknown,
    options?: {
      turnId?: string;
      workspaceDiffBaseline?: WorkspaceDiffSummary | null;
    },
  ): Promise<WorkspaceToolResult>;
  runtimeEventsForSession(sessionId: string): Promise<RuntimeEvent[]>;
  settleCostEvidence?(
    sessionId: string,
    options?: { turnId?: string },
  ): Promise<WorkspaceToolResult>;
};

type WorkTraceStep =
  | {
      kind: "model";
      turn: number;
      text: string;
      toolCallCount: number;
    }
  | {
      kind: "tool";
      turn: number;
      callId: string;
      name: string;
      arguments: Record<string, unknown>;
      ok: boolean;
      output: string;
    }
  | {
      kind: "required_output";
      path: string;
      ok: boolean;
      detail: string;
    }
  | {
      kind: "cleanup";
      ok: boolean;
      detail: string;
    };

export async function runTasksetWorkAttempt(input: {
  store: SqliteStore;
  storeDir: string;
  taskset: Taskset;
  task: TaskDataRecord;
  model: ChatModelRef;
  reasoningEffort?: CodexReasoningEffort | "none" | null;
  seed: number;
  attempt: number;
  sampling?: {
    maxOutputTokens: number;
    temperature: number;
    topP: number;
  };
  signal?: AbortSignal;
  stream: TasksetWorkModelStream;
  runtime: TasksetWorkAttemptRuntime;
  timestamp?: () => string;
  resultId?: string;
  parentModelRunId?: string;
  harnessInstructionContext?: string;
  validateRequiredOutput?: TasksetWorkRequiredOutputValidator;
  additionalToolDefinitions?: ModelToolDefinition[];
  toolEvidence?: TasksetWorkToolEvidence;
  harnessCapabilityReceipt?: Record<string, unknown>;
  hostedTokenPricing?: HostedTokenPricing;
}) {
  if (input.taskset.environment.kind !== "work") {
    throw new Error(`Taskset ${input.taskset.id} does not select Work.`);
  }
  const timestamp = input.timestamp ?? (() => new Date().toISOString());
  const startedAt = timestamp();
  const requestId = `taskset-work:${contentHash([
    input.taskset.id,
    input.taskset.contentHash,
    input.task.id,
    input.model,
    input.seed,
    input.attempt,
    startedAt,
  ]).slice(0, 40)}`;
  const attemptId = input.resultId
    ?? `attempt_${contentHash([requestId, "work"]).slice(0, 24)}`;
  const turnId = `taskset_work_turn_${contentHash([
    attemptId,
    input.task.id,
    startedAt,
  ]).slice(0, 24)}`;
  const controller = new AbortController();
  let timedOut = false;
  const abortFromParent = () => controller.abort(
    input.signal?.reason ?? new Error("The Work evaluation was cancelled."),
  );
  if (input.signal?.aborted) abortFromParent();
  else input.signal?.addEventListener("abort", abortFromParent, { once: true });
  const timeoutMs = Math.max(
    1,
    Math.min(input.taskset.environment.defaultTimeoutMs, 60 * 60_000),
  );
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort(new Error(`Work evaluation exceeded ${timeoutMs} ms.`));
  }, timeoutMs);
  timer.unref?.();

  const trace: WorkTraceStep[] = [];
  const usages: unknown[] = [];
  const explicitCosts: number[] = [];
  const savedOutputs = new Map<string, SavedWorkOutput>();
  const outputValidations = new Map<string, SavedOutputValidation>();
  let workRuntimeCost: WorkRuntimeCostEvidence | null = null;
  let session: Session | null = null;
  let allDefinitions: ModelToolDefinition[] = [];
  let text = "";
  let status:
    | "completed"
    | "budget_exhausted"
    | "cancelled"
    | "timeout"
    | "environment_failure"
    | "infrastructure_failure" = "completed";
  let infrastructureError: string | null = null;
  let failureClass: TaskFailureClass | null = null;
  let stage:
    | "assets"
    | "session"
    | "environment"
    | "model"
    | "outputs"
    | "cleanup" = "assets";

  try {
    throwIfAborted(controller.signal);
    const assets = await resolveTasksetWorkAssets({
      storeDir: input.storeDir,
      taskset: input.taskset,
      task: input.task,
    });
    stage = "session";
    session = await input.runtime.createSession({
      experience: "work",
      provider: input.model.providerId,
      modelRef: input.model,
      openPondCommandAccessMode: "disabled",
      hiddenFromDefaultSidebar: true,
      title: `Taskset Work attempt: ${input.task.id}`,
      cwd: null,
      metadata: {
        automatedTasksetWorkAttempt: true,
        tasksetId: input.taskset.id,
        tasksetName: input.taskset.name,
        tasksetHash: input.taskset.contentHash,
        taskId: input.task.id,
        attemptId,
        requestId,
        parentModelRunId: input.parentModelRunId ?? null,
      },
    });
    await input.store.insertTurn(TurnSchema.parse({
      id: turnId,
      sessionId: session.id,
      providerTurnId: null,
      modelRef: input.model,
      prompt: tasksetWorkUserPrompt(input.task),
      startedAt,
      completedAt: null,
      status: "in_progress",
      error: null,
      metadata: {
        automatedTasksetWorkAttempt: true,
        tasksetId: input.taskset.id,
        taskId: input.task.id,
        attemptId,
        parentModelRunId: input.parentModelRunId ?? null,
      },
      createImproveRun: null,
      profileSnapshot: null,
      harnessSnapshot: null,
    }));
    await appendTasksetTurnStarted({
      store: input.store,
      session,
      turnId,
      prompt: tasksetWorkUserPrompt(input.task),
      tasksetId: input.taskset.id,
      taskId: input.task.id,
      attemptId,
    });
    stage = "environment";
    allDefinitions = [
      ...createWorkModelToolDefinitions({
        executeWorkspaceTool: input.runtime.executeWorkspaceTool,
        inputs: assets,
      }),
      ...(input.additionalToolDefinitions ?? []),
    ];
    const definitionByName = new Map(
      allDefinitions.map((definition) => [definition.name, definition]),
    );
    const unknownTools = input.taskset.environment.toolNames.filter(
      (name) => !definitionByName.has(name),
    );
    if (unknownTools.length) {
      throw new Error(
        `Work environment declares unknown tools: ${unknownTools.join(", ")}.`,
      );
    }
    if (!input.taskset.environment.toolNames.includes("work_save_output")) {
      throw new Error("Work Tasksets must declare work_save_output.");
    }
    const selectedDefinitions = input.taskset.environment.toolNames.map(
      (name) => definitionByName.get(name)!,
    );
    const tools = selectedDefinitions.map(modelToolDefinitionToHostedTool);
    const selectedByName = new Map(
      selectedDefinitions.map((definition) => [definition.name, definition]),
    );
    const messages = tasksetWorkMessages(
      input.task,
      assets,
      input.harnessInstructionContext,
    );
    const maxTurns = workToolTurnLimit(input.taskset);
    const requiredOutputPaths = new Set(
      (input.task.requiredOutputs ?? []).map((output) => output.path),
    );
    let allRequiredOutputsSaved = false;
    const environmentDefinition = allDefinitions.find(
      (definition) => definition.name === "work_environment",
    );
    if (!environmentDefinition) {
      throw new Error("The Work environment readiness tool is unavailable.");
    }
    const environmentResult = await executeDefinition({
      definition: environmentDefinition,
      runtime: input.runtime,
      sessionId: session.id,
      turnId,
      model: input.model,
      callId: `environment_${attemptId}`,
      args: {},
      signal: controller.signal,
      userPrompt: tasksetWorkUserPrompt(input.task),
    });
    if (!environmentResult.ok) {
      throw new Error(environmentResult.contentText);
    }
    stage = "model";

    for (let turn = 0; turn < maxTurns; turn += 1) {
      throwIfAborted(controller.signal);
      const accumulator = new NativeToolCallAccumulator();
      let turnText = "";
      let continuation: HostedChatContinuation | null = null;
      for await (const delta of input.stream({
        model: input.model,
        reasoningEffort: input.reasoningEffort ?? null,
        messages,
        tools,
        toolChoice: "auto",
        requestId: `${requestId}:${turn}`,
        signal: controller.signal,
        maxOutputTokens: input.sampling?.maxOutputTokens ?? 4_096,
        temperature: input.sampling?.temperature ?? 0,
        topP: input.sampling?.topP ?? 1,
        seed: input.seed + input.attempt,
        hostedTokenPricing: input.hostedTokenPricing,
      })) {
        if (delta.text) turnText += delta.text;
        if (delta.continuation) continuation = delta.continuation;
        if (delta.toolCalls?.length) accumulator.append(delta.toolCalls);
        if (delta.usage !== undefined) usages.push(delta.usage);
        if (
          typeof delta.costUsd === "number"
          && Number.isFinite(delta.costUsd)
          && delta.costUsd >= 0
        ) {
          explicitCosts.push(delta.costUsd);
        }
      }
      throwIfAborted(controller.signal);
      const toolCalls = accumulator.completed();
      await appendTasksetAssistantText({
        store: input.store,
        session,
        turnId,
        text: turnText,
      });
      trace.push({
        kind: "model",
        turn,
        text: turnText,
        toolCallCount: toolCalls.length,
      });
      if (!toolCalls.length) {
        text = turnText;
        messages.push({
          role: "assistant",
          content: turnText,
          ...(continuation ? { continuation } : {}),
        });
        break;
      }
      messages.push(
        assistantMessageForNativeToolCalls(
          turnText,
          toolCalls,
          { continuation },
        ),
      );
      for (const call of toolCalls) {
        const definition = selectedByName.get(call.name);
        if (!definition) {
          const result = unknownNativeToolResult(call);
          await appendTasksetToolLifecycle({
            store: input.store,
            session,
            turnId,
            callId: call.id,
            name: call.name,
            args: {},
            result,
          });
          trace.push({
            kind: "tool",
            turn,
            callId: call.id,
            name: call.name,
            arguments: {},
            ok: false,
            output: result.contentText,
          });
          messages.push(toolResultMessage(result));
          continue;
        }
        let args: Record<string, unknown>;
        try {
          args = parseNativeToolArguments(call);
        } catch (error) {
          const detail = errorMessage(error);
          const result = invalidNativeToolArgumentsResult(call, detail);
          await appendTasksetToolLifecycle({
            store: input.store,
            session,
            turnId,
            callId: call.id,
            name: call.name,
            args: {},
            result,
          });
          trace.push({
            kind: "tool",
            turn,
            callId: call.id,
            name: call.name,
            arguments: {},
            ok: false,
            output: result.contentText,
          });
          messages.push(toolResultMessage(result));
          continue;
        }
        await appendTasksetToolStarted({
          store: input.store,
          session,
          turnId,
          callId: call.id,
          name: call.name,
          args,
        });
        const executeTool = () => executeDefinition({
          definition,
          runtime: input.runtime,
          sessionId: session!.id,
          turnId,
          model: input.model,
          callId: call.id,
          args,
          signal: controller.signal,
          userPrompt: tasksetWorkUserPrompt(input.task),
        });
        const result = input.toolEvidence
          ? await input.toolEvidence.execute({
              taskId: input.task.id,
              callId: call.id,
              toolName: call.name,
              args,
              execute: executeTool,
            })
          : await executeTool();
        await appendTasksetToolCompleted({
          store: input.store,
          session,
          turnId,
          callId: call.id,
          name: call.name,
          result,
        });
        trace.push({
          kind: "tool",
          turn,
          callId: call.id,
          name: call.name,
          arguments: args,
          ok: result.ok,
          output: result.contentText,
        });
        const saved = savedWorkOutput(args, result);
        if (saved) {
          savedOutputs.set(saved.relativePath, saved);
          allRequiredOutputsSaved =
            requiredOutputPaths.size > 0
            && [...requiredOutputPaths].every((outputPath) =>
              savedOutputs.has(outputPath)
            );
        }
        messages.push(toolResultMessage(result));
        if (allRequiredOutputsSaved) break;
      }
      if (allRequiredOutputsSaved) {
        clearTimeout(timer);
        break;
      }
      if (turn === maxTurns - 1) status = "budget_exhausted";
    }

    stage = "outputs";
    throwIfAborted(controller.signal);
    const saveDefinition = allDefinitions.find(
      (definition) => definition.name === "work_save_output",
    );
    if (!saveDefinition) {
      throw new Error("The Work output persistence tool is unavailable.");
    }
    for (const requiredOutput of input.task.requiredOutputs ?? []) {
      let saved = savedOutputs.get(requiredOutput.path) ?? null;
      if (!saved) {
        const result = await executeDefinition({
          definition: saveDefinition,
          runtime: input.runtime,
          sessionId: session.id,
          turnId,
          model: input.model,
          callId: `save_${contentHash([
            attemptId,
            requiredOutput.path,
          ]).slice(0, 20)}`,
          args: {
            path: requiredOutput.path,
            suggestedName: path.posix.basename(requiredOutput.path),
            validation: [],
          },
          signal: controller.signal,
          userPrompt: tasksetWorkUserPrompt(input.task),
        });
        saved = savedWorkOutput({ path: requiredOutput.path }, result);
        if (saved) savedOutputs.set(saved.relativePath, saved);
        if (!result.ok || !saved) {
          trace.push({
            kind: "required_output",
            path: requiredOutput.path,
            ok: false,
            detail: result.contentText,
          });
          continue;
        }
      }
      const validation = await validateSavedOutput({
        requiredOutput,
        saved,
        validateRequiredOutput: input.validateRequiredOutput,
      });
      outputValidations.set(requiredOutput.path, validation);
      trace.push({
        kind: "required_output",
        path: requiredOutput.path,
        ok: validation.passed,
        detail: validation.detail,
      });
    }
  } catch (error) {
    const message = errorMessage(error);
    infrastructureError = message;
    if (controller.signal.aborted) {
      status = timedOut ? "timeout" : "cancelled";
      failureClass = timedOut ? "timeout" : "cancelled";
    } else if (stage === "assets" || stage === "environment") {
      status = "environment_failure";
      failureClass = "environment_failure";
    } else {
      status = "infrastructure_failure";
      failureClass = "infrastructure_failure";
    }
  } finally {
    clearTimeout(timer);
    input.signal?.removeEventListener("abort", abortFromParent);
    if (session) {
      stage = "cleanup";
      const stopDefinition = allDefinitions.find(
        (definition) => definition.name === "work_stop",
      );
      if (stopDefinition) {
        try {
          const result = await executeDefinition({
            definition: stopDefinition,
            runtime: input.runtime,
            sessionId: session.id,
            turnId,
            model: input.model,
            callId: `cleanup_${attemptId}`,
            args: {},
            signal: new AbortController().signal,
            userPrompt: tasksetWorkUserPrompt(input.task),
          });
          trace.push({
            kind: "cleanup",
            ok: result.ok,
            detail: result.contentText,
          });
          if (result.ok) {
            workRuntimeCost = workRuntimeCostEvidence(result.data);
            if (!workRuntimeCost && input.runtime.settleCostEvidence) {
              const settled = await input.runtime.settleCostEvidence(
                session.id,
                { turnId },
              );
              if (settled.ok) {
                workRuntimeCost = workRuntimeCostEvidence(settled.data);
              }
            }
          }
          if (!result.ok) {
            infrastructureError =
              `Work cleanup failed: ${result.contentText}`;
            status = "infrastructure_failure";
            failureClass = "infrastructure_failure";
          }
        } catch (error) {
          infrastructureError = `Work cleanup failed: ${errorMessage(error)}`;
          status = "infrastructure_failure";
          failureClass = "infrastructure_failure";
          trace.push({
            kind: "cleanup",
            ok: false,
            detail: infrastructureError,
          });
        }
      }
    }
  }

  const artifactRefs: string[] = [];
  const artifactIdByOutputPath = new Map<string, string>();
  for (const saved of savedOutputs.values()) {
    if (saved.outputRef.location.kind !== "local") continue;
    const artifact = await persistTaskAttemptOutputArtifact({
      store: input.store,
      tasksetId: input.taskset.id,
      taskId: input.task.id,
      attemptId,
      requestId,
      path: saved.artifactPath,
      mediaType: saved.outputRef.contentType,
      expectedSha256: saved.outputRef.sha256,
      expectedSizeBytes: saved.outputRef.sizeBytes,
      timestamp,
      metadata: {
        requiredOutputPath: saved.relativePath,
        outputRefId: saved.outputRef.id,
        outputRefRevision: saved.outputRef.revision,
      },
    });
    artifactRefs.push(artifact.id);
    artifactIdByOutputPath.set(saved.relativePath, artifact.id);
  }
  const completedAt = timestamp();
  if (session) {
    const turnStatus = status === "cancelled" || status === "timeout"
      ? "interrupted"
      : status === "environment_failure" || status === "infrastructure_failure"
        ? "failed"
        : "completed";
    await appendTasksetTurnTerminal({
      store: input.store,
      session,
      turnId,
      status: turnStatus,
      error: turnStatus === "completed" ? null : infrastructureError,
    });
    await input.store.updateTurn(turnId, (turn) => ({
      ...turn,
      completedAt,
      status: turnStatus,
      error: turnStatus === "completed" ? null : infrastructureError,
    }));
  }
  const runtimeEvents = session
    ? await input.runtime.runtimeEventsForSession(session.id)
    : [];
  const traceArtifact = await persistJsonTaskAttemptArtifact({
    store: input.store,
    storeDir: input.storeDir,
    tasksetId: input.taskset.id,
    taskId: input.task.id,
    attemptId,
    requestId,
    kind: "runtime_trace",
    payload: {
      schemaVersion: "openpond.tasksetWorkTrace.v1",
      tasksetId: input.taskset.id,
      tasksetHash: input.taskset.contentHash,
      taskId: input.task.id,
      model: input.model,
      seed: input.seed,
      attempt: input.attempt,
      status,
      steps: trace,
      runtimeEventRefs: runtimeEvents.map((event) => event.id),
      usage: usages,
      infrastructureError,
      failureClass,
      startedAt,
      completedAt,
    },
    timestamp,
  });
  artifactRefs.push(traceArtifact.id);
  const requiredOutputStatus = (input.task.requiredOutputs ?? []).map(
    (requiredOutput) => {
      const saved = savedOutputs.get(requiredOutput.path);
      const traceResult = [...trace].reverse().find(
        (step) =>
          step.kind === "required_output"
          && step.path === requiredOutput.path,
      );
      return {
        path: requiredOutput.path,
        mediaType: requiredOutput.mediaType,
        validationKinds: Array.isArray(requiredOutput.metadata.validationKinds)
          ? requiredOutput.metadata.validationKinds.filter(
              (value): value is string => typeof value === "string",
            )
          : [],
        schemaRef: requiredOutput.schemaRef ?? null,
        artifactId: saved
          ? artifactIdByOutputPath.get(requiredOutput.path) ?? null
          : null,
        outputRefId: saved?.outputRef.id ?? null,
        sha256: saved?.outputRef.sha256 ?? null,
        sizeBytes: saved?.outputRef.sizeBytes ?? null,
        passed: traceResult?.kind === "required_output"
          ? traceResult.ok
          : false,
        detail: traceResult?.kind === "required_output"
          ? traceResult.detail
          : "Required output was not saved.",
        ...(outputValidations.get(requiredOutput.path)?.parsedJson !== undefined
          ? {
              parsedJson:
                outputValidations.get(requiredOutput.path)?.parsedJson,
            }
          : {}),
      };
    },
  );
  const estimatedUsageCosts = input.hostedTokenPricing
    ? usages.flatMap((usage) => {
        const cost = hostedUsageCostUsd(usage, input.hostedTokenPricing!);
        return cost === null ? [] : [cost];
      })
    : [];
  const providerInferenceUsd = explicitCosts.length
    ? sumUsd(explicitCosts)
    : estimatedUsageCosts.length
      ? sumUsd(estimatedUsageCosts)
      : infrastructureError && usages.length === 0
        ? 0
      : null;
  const costComponents = [
    providerInferenceUsd,
    workRuntimeCost?.billableUsd ?? null,
  ].filter((value): value is number => value !== null);
  const costUsd = costComponents.length
    ? sumUsd(costComponents)
    : null;

  return TaskAttemptResultSchema.parse({
    schemaVersion: "openpond.taskAttempt.v1",
    id: attemptId,
    tasksetId: input.taskset.id,
    taskId: input.task.id,
    split: input.task.split,
    attempt: input.attempt,
    seed: input.seed,
    modelRef: input.model,
    startedAt,
    completedAt,
    output: {
      text,
      requiredOutputs: requiredOutputStatus,
      outputsPassed:
        requiredOutputStatus.length > 0
        && requiredOutputStatus.every((output) => output.passed),
      toolFailureCount: trace.filter(
        (step) => step.kind === "tool" && !step.ok,
      ).length,
    },
    runtimeEventRefs: runtimeEvents.map((event) => event.id),
    artifactRefs,
    privilegedOutcomeRef: input.task.privilegedContextRef,
    infrastructureError,
    costUsd,
    latencyMs: elapsedMilliseconds(startedAt, completedAt),
    userInterventions: 0,
    metadata: {
      requestId,
      parentModelRunId: input.parentModelRunId ?? null,
      execution: "taskset_work",
      runtimeProfileId: input.taskset.environment.entrypoint,
      tasksetHash: input.taskset.contentHash,
      status,
      failureClass,
      sessionId: session?.id ?? null,
      turnId,
      toolNames: input.taskset.environment.toolNames,
      harnessCapabilityReceipt: input.harnessCapabilityReceipt
        ? {
            ...input.harnessCapabilityReceipt,
            executableToolNames: input.taskset.environment.toolNames,
          }
        : null,
      hostedTokenPricing: input.hostedTokenPricing ?? null,
      assetHashes: (input.task.assets ?? []).map((asset) => asset.sha256),
      requiredOutputPaths: (input.task.requiredOutputs ?? []).map(
        (output) => output.path,
      ),
      usage: usages,
      costEvidence: {
        providerInferenceUsd,
        workRuntimeUsd: workRuntimeCost?.totalUsd ?? null,
        workRuntimeBillableUsd: workRuntimeCost?.billableUsd ?? null,
        workRuntimeSimulatedUsd: workRuntimeCost?.simulatedUsd ?? null,
        combinedUsd: costUsd,
        workReceiptIds: workRuntimeCost?.receiptIds ?? [],
        workDurationSeconds: workRuntimeCost?.durationSeconds ?? null,
        settlementModes: workRuntimeCost?.settlementModes ?? [],
      },
    },
  });
}

function throwIfAborted(signal: AbortSignal): void {
  if (!signal.aborted) return;
  throw signal.reason instanceof Error
    ? signal.reason
    : new Error("The Work evaluation was cancelled.");
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function elapsedMilliseconds(startedAt: string, completedAt: string): number {
  return Math.max(0, Date.parse(completedAt) - Date.parse(startedAt));
}
