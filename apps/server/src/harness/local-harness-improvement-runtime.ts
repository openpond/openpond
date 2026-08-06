import {
  DEFAULT_OPENPOND_CHAT_MODEL,
  createImprovementRouteDecision,
  type ModelUsageRecord,
  type RuntimeEvent,
  type Session,
  type Turn,
} from "@openpond/contracts";
import type {
  streamOpenPondHostedChatTurn as defaultStreamOpenPondHostedChatTurn,
} from "@openpond/runtime";

import type { BackgroundWorkerQueue } from "../runtime/background-worker-queue.js";
import { startProviderRequestUsageRecorder } from "../runtime/model-usage-recorder.js";
import type { SqliteStore } from "../store/store.js";
import { event } from "../utils.js";
import { recordLocalHarnessImprovementBoundary } from "./local-harness-improvement-observer.js";
import { runLocalHarnessRefinerWorker } from "./local-harness-refiner-worker.js";

export function createLocalHarnessImprovementRuntime(input: {
  store: SqliteStore;
  storeDir: string;
  queue: BackgroundWorkerQueue;
  streamOpenPondHostedChatTurn: typeof defaultStreamOpenPondHostedChatTurn;
  appendRuntimeEvent: (runtimeEvent: RuntimeEvent) => Promise<unknown>;
  upsertModelUsageRecord: (record: ModelUsageRecord) => Promise<void>;
}) {
  const jobs = new Set<string>();

  return async function processLocalHarnessImprovementBoundary(boundary: {
    session: Session;
    turn: Turn;
    boundaryKind: Parameters<
      typeof recordLocalHarnessImprovementBoundary
    >[0]["boundaryKind"];
  }): Promise<void> {
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
    if (trigger.decision !== "queue_refiner" || jobs.has(trigger.contentHash)) return;

    jobs.add(trigger.contentHash);
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
          data: { triggerId: trigger.id },
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
        },
      },
      async () => {
        let requestOrdinal = 0;
        try {
          await input.appendRuntimeEvent(
            event({
              sessionId: boundary.session.id,
              turnId: boundary.turn.id,
              name: "harness.refiner.started",
              source: "server",
              appId: boundary.session.appId,
              status: "started",
              data: { triggerId: trigger.id },
            }),
          );
          const result = await runLocalHarnessRefinerWorker({
            store: input.store,
            storeDir: input.storeDir,
            trigger,
            signal: new AbortController().signal,
            stream: async function* ({ messages, signal }) {
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
              } catch (error) {
                await recorder.fail(error, signal.aborted ? "interrupted" : "failed");
                throw error;
              }
            },
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
                trigger: { id: trigger.id, contentHash: trigger.contentHash },
                outcome: {
                  id: result.outcome.id,
                  contentHash: result.outcome.contentHash,
                  decision: result.outcome.decision,
                },
                proposal: result.proposal
                  ? { id: result.proposal.id, contentHash: result.proposal.contentHash }
                  : null,
                workspaceAdvance: result.advanceReceipt?.decision ?? null,
              },
            }),
          );
        } catch (error) {
          await input.appendRuntimeEvent(
            event({
              sessionId: boundary.session.id,
              turnId: boundary.turn.id,
              name: "harness.refiner.failed",
              source: "server",
              appId: boundary.session.appId,
              status: "failed",
              output: error instanceof Error ? error.message : String(error),
              data: { triggerId: trigger.id },
            }),
          ).catch(() => undefined);
          throw error;
        } finally {
          jobs.delete(trigger.contentHash);
        }
      },
    );
  };
}
