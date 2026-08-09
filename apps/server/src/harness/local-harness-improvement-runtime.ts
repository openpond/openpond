import {
  DEFAULT_OPENPOND_CHAT_MODEL,
  createImprovementRouteDecision,
  type ModelUsageRecord,
  type RefinementTriggerDecision,
  type RuntimeEvent,
  type Session,
  type Turn,
} from "@openpond/contracts";
import { DEFAULT_HOSTED_REFINER_TIMEOUT_MS } from "@openpond/harness";
import type {
  requestOpenPondHostedHarnessRefinement as defaultRequestOpenPondHostedHarnessRefinement,
} from "@openpond/runtime";

import type { BackgroundWorkerQueue } from "../runtime/background-worker-queue.js";
import { startProviderRequestUsageRecorder } from "../runtime/model-usage-recorder.js";
import type { SqliteStore } from "../store/store.js";
import { event } from "../utils.js";
import { recordLocalHarnessImprovementBoundary } from "./local-harness-improvement-observer.js";
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
  requestOpenPondHostedHarnessRefinement: typeof defaultRequestOpenPondHostedHarnessRefinement;
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
            timeoutMs: DEFAULT_HOSTED_REFINER_TIMEOUT_MS,
            execution: "hosted_endpoint",
            recoveredAfterRestart,
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
                timeoutMs: DEFAULT_HOSTED_REFINER_TIMEOUT_MS,
                execution: "hosted_endpoint",
                recoveredAfterRestart,
              },
            }),
          );
          const result = await runLocalHarnessRefinerWorker({
            store: input.store,
            storeDir: input.storeDir,
            trigger,
            signal: new AbortController().signal,
            refine: async ({ request, signal }) => {
              if (modelStartedAtMs === null) modelStartedAtMs = Date.now();
              const ordinal = requestOrdinal++;
              const requestId = request.requestId;
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
                const response = await input.requestOpenPondHostedHarnessRefinement({
                  request,
                  signal,
                });
                recorder.observeDelta({
                  usage: {
                    prompt_tokens: response.usage.promptTokens,
                    completion_tokens: response.usage.completionTokens,
                    total_tokens: response.usage.totalTokens,
                  },
                });
                await recorder.complete();
                modelCompletedAtMs = Date.now();
                return response;
              } catch (error) {
                modelCompletedAtMs = Date.now();
                await recorder.fail(error, signal.aborted ? "interrupted" : "failed");
                throw error;
              }
            },
          });
          const completedAtMs = Date.now();
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
