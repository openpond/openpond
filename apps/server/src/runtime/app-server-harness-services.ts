import { createLocalHarnessEvaluationReviewModelStream } from "../harness/local-harness-evaluation-review-model.js";
import { reviewSelectedLocalHarnessEvaluation } from "../harness/local-harness-evaluation-review.js";
import {
  createLocalHarnessSettingsRoutePayloads,
  localHarnessHistoryPayload,
} from "../harness/local-harness-history.js";
import {
  resolveSelectedLocalHarnessRelease
} from "../harness/local-harness-selection.js";
import { createLocalHarnessTasksetReviewControl } from "../harness/local-harness-taskset-review.js";
import {
  activateRefinerRelease,
  inspectRefinerProfile,
  rollbackRefinerRelease,
  updateRefinerProfile,
} from "../refiner/refiner-profile-service.js";
import { createAgentRuntimePorts } from "../runtime/agent-runtime-host.js";
import { SqliteStore } from "../store/store.js";
export function createAppServerHarnessServices(input: {
  store: SqliteStore; storeDir: string; backgroundReview: boolean; harnessEvaluationEnabled: boolean;
  harnessEvaluationReviewStream: ReturnType<typeof createLocalHarnessEvaluationReviewModelStream>;
  harnessTasksetReview: Awaited<ReturnType<typeof createLocalHarnessTasksetReviewControl>> | undefined;
}) {
  const { store, storeDir, backgroundReview, harnessEvaluationEnabled, harnessTasksetReview } = input;
  const shutdown = new AbortController();
  const harnessEvaluationReviewStream: typeof input.harnessEvaluationReviewStream = request => {
    const signal = request.signal ? AbortSignal.any([request.signal, shutdown.signal]) : shutdown.signal;
    return input.harnessEvaluationReviewStream({ ...request, signal });
  };
  const harnessSettings = createLocalHarnessSettingsRoutePayloads({
    store,
    storeDir,
    evaluationReviewStream: harnessEvaluationReviewStream,
  });
  return {
    inspectHarness: () => localHarnessHistoryPayload(store),
    reviewHarnessProposal: guardService(backgroundReview, "Harness review", harnessSettings.reviewHarnessProposalPayload),
    reviewHarness: guardService(harnessEvaluationEnabled, "Harness evaluation", (request) => reviewSelectedLocalHarnessEvaluation({
      store,
      request,
      stream: harnessEvaluationReviewStream,
      continuation: { storeDir, stream: harnessEvaluationReviewStream },
    })),
    acceptHarnessEvaluationReview: guardService(harnessEvaluationEnabled, "Tasksets", request => harnessTasksetReview!.acceptEvaluationReview(request)),
    materializeHarnessEvaluationTaskset:
      guardService(harnessEvaluationEnabled, "Tasksets", request => harnessTasksetReview!.materializeEvaluationTaskset(request)),
    runHarnessEvaluationBaseline:
      guardService(harnessEvaluationEnabled, "Tasksets", request => harnessTasksetReview!.runEvaluationBaseline(request)),
    validateHarness: async () => {
      const release = await resolveSelectedLocalHarnessRelease(store);
      return release
        ? {
          valid: true,
          workspaceId: release.workspaceId,
          harnessRelease: release.harnessRelease,
          agentSnapshot: release.agentSnapshot,
        }
        : {
          valid: false,
          reason: "No app-server Harness release is selected.",
        };
    },
    updateHarnessBackgroundReview:
      guardService(backgroundReview, "Background review", harnessSettings.updateHarnessBackgroundReviewPayload),
    diffHarness: harnessSettings.harnessDiffPayload,
    rollbackHarness: harnessSettings.rollbackHarnessPayload,
    inspectRefiner: guardService(backgroundReview, "Refiner", () => inspectRefinerProfile(storeDir)),
    updateRefiner: guardService(backgroundReview, "Refiner", (payload) => updateRefinerProfile(storeDir, payload)),
    activateRefiner: guardService(backgroundReview, "Refiner", (payload) => activateRefinerRelease(storeDir, payload)),
    rollbackRefiner: guardService(backgroundReview, "Refiner", (payload) => rollbackRefinerRelease(storeDir, payload)),
    async close() { shutdown.abort(new Error("Harness runtime closed")); },
  } satisfies Pick<Parameters<typeof createAgentRuntimePorts>[0], "inspectHarness" | "reviewHarnessProposal" | "reviewHarness" | "acceptHarnessEvaluationReview" | "materializeHarnessEvaluationTaskset" | "runHarnessEvaluationBaseline" | "validateHarness" | "updateHarnessBackgroundReview" | "diffHarness" | "rollbackHarness" | "inspectRefiner" | "updateRefiner" | "activateRefiner" | "rollbackRefiner"> & { close(): Promise<void>; };
}

function guardService<A extends unknown[], R>(enabled: boolean, name: string, handler: (...args: A) => Promise<R>) {
  return async (...args: A): Promise<R> => {
    if (!enabled) throw new Error(`${name} is disabled in this app-server deployment.`);
    return handler(...args);
  };
}
