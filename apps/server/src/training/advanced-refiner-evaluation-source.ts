import { LocalExperimentResultSchema } from "@openpond/contracts";
import type { createLocalExperimentService } from "../evaluations/local-experiment-service.js";
import { contentHash } from "@openpond/harness";
import {
  verifyAdvancedRefinerEvaluationPin,
  type AdvancedRefinerEvaluationPin,
} from "openpond-sdk/advanced-refiner-evaluations";
import { createLocalExternalDatasetPreparation } from "../harness/local-external-dataset-preparation.js";
import { inspectRefinerProfile } from "../refiner/refiner-profile-service.js";
import type { createExperimentImprovementRuntime } from "../harness/experiment-improvement-runtime.js";
/** Private package acquisition uses the same actual current Dataset/Profile
 * admission as ordinary Experiments. No private files enter isolated Work. */
export function createAdvancedRefinerEvaluationSource(
  deps: Parameters<typeof createLocalExternalDatasetPreparation>[0] & {
    localExperiments?: () => ReturnType<typeof createLocalExperimentService>;
    loadEvidence: ReturnType<
      typeof createExperimentImprovementRuntime
    >["loadEvidence"];
  },
) {
  const resolve = createLocalExternalDatasetPreparation(deps);
  async function read(raw: AdvancedRefinerEvaluationPin) {
    const pin = verifyAdvancedRefinerEvaluationPin(raw),
      actor = await deps.identity();
    if (actor.actorId !== pin.actorId || actor.teamId !== pin.teamId)
      throw new Error("The advanced evaluation owner changed.");
    const evidence = await deps.loadEvidence(actor, pin.evidence);
    if (
      evidence.result.status !== "completed" ||
      evidence.manifest.dataset.id !== pin.externalDatasetBinding.dataset.id ||
      evidence.manifest.dataset.contentHash !==
        pin.externalDatasetBinding.dataset.contentHash
    )
      throw new Error(
        "Advanced Refiner evaluation requires exact completed source evidence from the selected Dataset.",
      );
    const history = await inspectRefinerProfile(deps.storeDir);
    if (
      !history.releases.some(
        (release) =>
          release.id === pin.refinerRelease.id &&
          release.contentHash === pin.refinerRelease.contentHash,
      )
    )
      throw new Error("The exact admitted Refiner release is unavailable.");
    const selected = {
      profileRef: pin.profileRef,
      sourceRevision: pin.sourceRevision,
      harnessRelease: pin.baselineRelease,
      workflows: [],
    };
    const adaptation = await resolve(pin.adaptationDatasetBinding, selected);
    await adaptation.authorize();
    const source = await resolve(pin.externalDatasetBinding, selected),
      value = source.packageValue;
    if (value.environment.contentHash !== pin.environmentPolicy.environmentHash)
      throw new Error("The advanced environment release changed.");
    if (
      pin.mode === "downstream_adaptation" &&
      value.environment.contract.kind !== "work"
    )
      throw new Error(
        "This native Refiner adapter requires a released Work environment.",
      );
    if (
      value.taskset.tools.some(
        (tool) => tool.name === "web_search" || tool.name === "web_fetch",
      )
    )
      throw new Error(
        "Advanced live web tools require a separately admitted budget and frozen-observation owner.",
      );
    if (value.environment.contract.networkPolicy !== "none")
      throw new Error(
        "This advanced adapter cannot bound live external tool charges. Select a resettable environment with network disabled; live-tool evaluation needs its own qualified admission owner.",
      );
    if (adaptation.packageValue.contentHash !== value.contentHash)
      throw new Error(
        "This native adapter requires the same exact released package for adaptation and independent holdout.",
      );
    const adaptationTasks = pin.adaptationTaskIds.map((id) =>
        adaptation.packageValue.taskset.tasks.find((task) => task.id === id),
      ),
      holdout = pin.holdoutTaskIds.map((id) =>
        value.taskset.tasks.find((task) => task.id === id),
      );
    if (
      adaptationTasks.some(
        (task) => !task || task.split !== pin.adaptationSplit,
      ) ||
      holdout.some((task) => !task || task.split !== pin.holdoutSplit)
    )
      throw new Error(
        "The advanced population changed its ordered split membership.",
      );
    const families = new Set(adaptationTasks.map((task) => task!.clusterKey));
    if (holdout.some((task) => families.has(task!.clusterKey)))
      throw new Error("Private holdout families overlap adaptation evidence.");
    if (
      value.verifierSet.graders.some(
        (grader) =>
          grader.kind === "human" ||
          (grader.kind === "model_judge" &&
            grader.calibrationStatus !== "passed"),
      )
    )
      throw new Error(
        "Advanced evaluation needs executable deterministic or separately calibrated graders; human preference labels cannot become online reward.",
      );
    await source.authorize();
    if (pin.mode === "review_quality") {
      const review = value.taskset.metadata.advancedRefinerReview as
        | { outputConvention?: unknown; contextEvidence?: unknown }
        | undefined;
      if (
        review?.outputConvention !== "openpond.refinerReviewOutput.v1" ||
        contentHash(review.contextEvidence) !== contentHash(pin.evidence)
      )
        throw new Error(
          "Review quality needs grounded independent labels bound to the exact retained context evidence.",
        );
    }
    if (contentHash(await deps.identity()) !== contentHash(actor))
      throw new Error(
        "The advanced evaluation account changed during source admission.",
      );
    return source;
  }
  async function reviewContext(
    pin: AdvancedRefinerEvaluationPin,
    taskId: string,
  ) {
    await read(pin);
    if (!deps.localExperiments || !pin.evidence.id.startsWith("local-"))
      throw new Error(
        "This native review adapter requires actual retained local execution context. Hosted trace import requires a separately qualified current-owner context transport.",
      );
    const result = LocalExperimentResultSchema.parse(
      await deps
        .localExperiments()
        .result({ teamId: pin.teamId, id: pin.evidence.id }),
    );
    if (result.execution.ownerActorId !== pin.actorId)
      throw new Error("The review context belongs to another actor.");
    const selected = result.cases.filter(
      (item) => item.taskId === taskId && item.status === "completed",
    );
    if (selected.length !== 1)
      throw new Error(
        "Choose one exact completed retained context per independent review case.",
      );
    const item = selected[0]!,
      native = item.profileNative ?? item.native;
    if (!native)
      throw new Error(
        "The selected context has no actual native session/turn provenance.",
      );
    if (native.outputHash !== contentHash(item.output))
      throw new Error(
        "The retained review output differs from its native execution.",
      );
    const session = await deps.store.getSession(native.sessionId),
      turn = await deps.store.getTurn(native.turnId);
    if (
      !session ||
      !turn ||
      turn.sessionId !== session.id ||
      turn.status === "in_progress"
    )
      throw new Error("The actual retained review context is unavailable.");
    const events = await deps.store.runtimeEventsForTurn(turn.id);
    const wanted = new Set(native.runtimeEventRefs),
      retained = events.filter((event) => wanted.has(event.id));
    if (retained.length !== wanted.size)
      throw new Error("The exact native review trace is incomplete.");
    await read(pin);
    return {
      session,
      turn,
      events: retained,
      case: item,
      traceHash: native.traceHash,
    };
  }
  return {
    read,
    reviewContext,
    evidence: async (pin: AdvancedRefinerEvaluationPin) => {
      await read(pin);
      return deps.loadEvidence(
        { actorId: pin.actorId, teamId: pin.teamId },
        pin.evidence,
      );
    },
    authorize: async (pin: AdvancedRefinerEvaluationPin) => {
      await (await read(pin)).authorize();
    },
  };
}
