import {
  DEFAULT_OPENPOND_CHAT_MODEL,
  createImprovementRouteDecision,
  type ModelUsageRecord,
  type RefinementTriggerDecision,
  type RuntimeEvent,
  type Session,
  type Turn,
} from "@openpond/contracts";
import {
  DEFAULT_REFINER_MAX_OUTPUT_TOKENS,
  DEFAULT_REFINER_TIMEOUT_MS,
} from "@openpond/harness";
import type {
  streamOpenPondHostedChatTurn as defaultStreamOpenPondHostedChatTurn,
} from "@openpond/runtime";

import type { BackgroundWorkerQueue } from "../runtime/background-worker-queue.js";
import { startProviderRequestUsageRecorder } from "../runtime/model-usage-recorder.js";
import type { SqliteStore } from "../store/store.js";
import { event } from "../utils.js";
import { recordLocalHarnessImprovementBoundary } from "./local-harness-improvement-observer.js";
import { localHarnessRefinerActivityDisplay } from "./local-harness-refiner-activity.js";
import { runLocalHarnessRefinerWorker } from "./local-harness-refiner-worker.js";

type LocalHarnessImprovementBoundary = {
  session: Session;
  turn: Turn;
  boundaryKind: Parameters<
    typeof recordLocalHarnessImprovementBoundary
  >[0]["boundaryKind"];
};

export type LocalHarnessImprovementRuntime = ((
  boundary: LocalHarnessImprovementBoundary,
) => Promise<void>) & {
  reconcilePending: () => Promise<number>;
};

export function createLocalHarnessImprovementRuntime(input: {
  store: SqliteStore;
  storeDir: string;
  queue: BackgroundWorkerQueue;
  streamOpenPondHostedChatTurn: typeof defaultStreamOpenPondHostedChatTurn;
  appendRuntimeEvent: (runtimeEvent: RuntimeEvent) => Promise<unknown>;
  upsertModelUsageRecord: (record: ModelUsageRecord) => Promise<void>;
}) {
  const jobs = new Set<string>();

  const processLocalHarnessImprovementBoundary = (async function (
    boundary: LocalHarnessImprovementBoundary,
  ): Promise<void> {
    const detection = await recordLocalHarnessImprovementBoundary({
      store: input.store,
      ...boundary,
    });
    if (!detection) return;
    const trigger = detection.trigger;
    if (trigger.decision === "route_deterministically" && trigger.deterministicRoute) {
      const route = createImprovementRouteDecision({
        schemaVersion: "openpond.improvementRouteDecision.v1",
        id: `route-${trigger.contentHash.slice(0, 24)}`,
        trigger: { id: trigger.id, contentHash: trigger.contentHash },
        route: trigger.deterministicRoute,
        authority: "runtime_service",
        automatic: true,
        reason: trigger.reason,
        createdAt: trigger.createdAt,
        metadata: {},
      });
      await input.store.saveHarnessImprovementArtifact(
        boundary.turn.harnessSnapshot!.workspaceId,
        "route_decision",
        route,
      );
      return;
    }
    if (trigger.decision !== "queue_refiner") return;
    await enqueueTrigger(boundary, trigger, false);
  }) as LocalHarnessImprovementRuntime;

  async function enqueueTrigger(
    boundary: { session: Session; turn: Turn },
    trigger: RefinementTriggerDecision,
    recoveredAfterRestart: boolean,
  ): Promise<void> {
    if (trigger.decision !== "queue_refiner") {
      throw new Error("Only queued Harness Refiner triggers can be enqueued.");
    }
    if (jobs.has(trigger.contentHash)) return;
    jobs.add(trigger.contentHash);
    const queuedAtMs = Date.now();
    try {
      await input.appendRuntimeEvent(
        event({
          sessionId: boundary.session.id,
          turnId: boundary.turn.id,
          name: "harness.refiner.queued",
          source: "server",
          appId: boundary.session.appId,
          status: "pending",
          output: trigger.reason,
          data: {
            triggerId: trigger.id,
            timeoutMs: DEFAULT_REFINER_TIMEOUT_MS,
            maxOutputTokens: DEFAULT_REFINER_MAX_OUTPUT_TOKENS,
            execution: "public_package",
            recoveredAfterRestart,
            activity: {
              schemaVersion: "openpond.localHarnessRefinerActivityDisplay.v1",
              visibility: refinerActivityVisibility(boundary.session),
              state: "running",
              summary: "Reviewing this Work for a reusable improvement",
            },
          },
        }),
      );
    } catch (error) {
      jobs.delete(trigger.contentHash);
      throw error;
    }

    input.queue.enqueue(
      {
        label: "Refine the Local Harness from a recovered execution detour",
        metadata: {
          key: trigger.contentHash,
          sessionId: boundary.session.id,
          turnId: boundary.turn.id,
          triggerId: trigger.id,
          recoveredAfterRestart,
        },
      },
      async () => {
        let requestOrdinal = 0;
        const jobStartedAtMs = Date.now();
        let modelStartedAtMs: number | null = null;
        let modelCompletedAtMs: number | null = null;
        try {
          await input.appendRuntimeEvent(
            event({
              sessionId: boundary.session.id,
              turnId: boundary.turn.id,
              name: "harness.refiner.started",
              source: "server",
              appId: boundary.session.appId,
              status: "started",
              data: {
                triggerId: trigger.id,
                queueWaitMs: Math.max(0, jobStartedAtMs - queuedAtMs),
                timeoutMs: DEFAULT_REFINER_TIMEOUT_MS,
                maxOutputTokens: DEFAULT_REFINER_MAX_OUTPUT_TOKENS,
                execution: "public_package",
                recoveredAfterRestart,
                activity: {
                  schemaVersion: "openpond.localHarnessRefinerActivityDisplay.v1",
                  visibility: refinerActivityVisibility(boundary.session),
                  state: "running",
                  summary: "Reviewing this Work for a reusable improvement",
                },
              },
            }),
          );
          const result = await runLocalHarnessRefinerWorker({
            store: input.store,
            storeDir: input.storeDir,
            trigger,
            signal: new AbortController().signal,
            stream: async function* ({ messages, signal }) {
              if (modelStartedAtMs === null) modelStartedAtMs = Date.now();
              const ordinal = requestOrdinal++;
              const requestId = `harness-refiner:${trigger.id}:${ordinal}`;
              const recorder = await startProviderRequestUsageRecorder({
                session: boundary.session,
                turn: boundary.turn,
                provider: "openpond",
                model: DEFAULT_OPENPOND_CHAT_MODEL,
                requestId,
                requestOrdinal: ordinal,
                requestKind: "harness_refiner",
                upsert: input.upsertModelUsageRecord,
              });
              try {
                for await (const delta of input.streamOpenPondHostedChatTurn({
                  model: DEFAULT_OPENPOND_CHAT_MODEL,
                  messages,
                  requestId,
                  reasoningEffort: "low",
                  maxTokens: DEFAULT_REFINER_MAX_OUTPUT_TOKENS,
                  signal,
                })) {
                  if (delta.type === "text_delta" && delta.text) {
                    recorder.observeDelta({ text: delta.text });
                    yield { text: delta.text };
                  } else if (delta.type === "reasoning_delta" && delta.text) {
                    recorder.observeDelta({ reasoningText: delta.text });
                  } else if (delta.type === "usage") {
                    recorder.observeDelta({ usage: delta.usage });
                  }
                }
                await recorder.complete();
                modelCompletedAtMs = Date.now();
              } catch (error) {
                modelCompletedAtMs = Date.now();
                await recorder.fail(error, signal.aborted ? "interrupted" : "failed");
                throw error;
              }
            },
          });
          const completedAtMs = Date.now();
          const activity = localHarnessRefinerActivityDisplay({
            session: boundary.session,
            trigger,
            result,
          });
          await input.appendRuntimeEvent(
            event({
              sessionId: boundary.session.id,
              turnId: boundary.turn.id,
              name: "harness.refiner.completed",
              source: "server",
              appId: boundary.session.appId,
              status: "completed",
              output: result.outcome.reason,
              data: {
                recoveredAfterRestart,
                trigger: { id: trigger.id, contentHash: trigger.contentHash },
                outcome: {
                  id: result.outcome.id,
                  contentHash: result.outcome.contentHash,
                  decision: result.outcome.decision,
                  routed: result.outcome.metadata.routed === true,
                  route: typeof result.outcome.metadata.route === "string"
                    ? result.outcome.metadata.route
                    : null,
                },
                proposal: result.proposal
                  ? { id: result.proposal.id, contentHash: result.proposal.contentHash }
                  : null,
                workspaceAdvance: result.advanceReceipt?.decision ?? null,
                activity,
                timing: {
                  queueWaitMs: Math.max(0, jobStartedAtMs - queuedAtMs),
                  modelDurationMs:
                    modelStartedAtMs === null || modelCompletedAtMs === null
                      ? null
                      : Math.max(0, modelCompletedAtMs - modelStartedAtMs),
                  materializationDurationMs:
                    modelCompletedAtMs === null
                      ? null
                      : Math.max(0, completedAtMs - modelCompletedAtMs),
                  totalJobDurationMs: Math.max(0, completedAtMs - jobStartedAtMs),
                },
              },
            }),
          );
        } catch (error) {
          const failedAtMs = Date.now();
          await input.appendRuntimeEvent(
            event({
              sessionId: boundary.session.id,
              turnId: boundary.turn.id,
              name: "harness.refiner.failed",
              source: "server",
              appId: boundary.session.appId,
              status: "failed",
              output: error instanceof Error ? error.message : String(error),
              data: {
                triggerId: trigger.id,
                recoveredAfterRestart,
                activity: {
                  schemaVersion: "openpond.localHarnessRefinerActivityDisplay.v1",
                  visibility: refinerActivityVisibility(boundary.session),
                  state: "failed",
                  summary: "Refiner review failed",
                  reason: error instanceof Error ? error.message : String(error),
                },
                timing: {
                  queueWaitMs: Math.max(0, jobStartedAtMs - queuedAtMs),
                  modelDurationMs:
                    modelStartedAtMs === null || modelCompletedAtMs === null
                      ? null
                      : Math.max(0, modelCompletedAtMs - modelStartedAtMs),
                  totalJobDurationMs: Math.max(0, failedAtMs - jobStartedAtMs),
                },
              },
            }),
          ).catch(() => undefined);
          throw error;
        } finally {
          jobs.delete(trigger.contentHash);
        }
      },
    );
  }

  processLocalHarnessImprovementBoundary.reconcilePending = async (): Promise<number> => {
    const pending = await input.store.listPendingHarnessRefinerTriggers();
    for (const { workspaceId, trigger } of pending) {
      const [session, turn] = await Promise.all([
        input.store.getSession(trigger.runRef),
        input.store.getTurn(trigger.turnId),
      ]);
      if (!session || !turn || turn.sessionId !== session.id) {
        throw new Error(
          `Pending Harness Refiner trigger ${trigger.id} references an unavailable session or turn.`,
        );
      }
      if (turn.harnessSnapshot?.workspaceId !== workspaceId) {
        throw new Error(
          `Pending Harness Refiner trigger ${trigger.id} no longer matches its Harness workspace.`,
        );
      }
      await enqueueTrigger({ session, turn }, trigger, true);
    }
    return pending.length;
  };

  return processLocalHarnessImprovementBoundary;
}

function refinerActivityVisibility(
  session: Session,
): "always" | "material_only" {
  return session.metadata?.automatedTasksetWorkAttempt === true
    || typeof session.metadata?.tasksetId === "string"
    || typeof session.metadata?.benchmarkRuntime === "string"
    ? "always"
    : "material_only";
}
