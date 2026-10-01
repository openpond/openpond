import { z } from "zod";
import { contentHash } from "@openpond/harness";
import { createProfileExternalDatasetBinding } from "@openpond/evals";
import { OpenPondTasksetPackageClient } from "openpond-sdk/taskset-packages";
import {
  AdvancedRefinerEvaluationCommandSchema,
  AdvancedRefinerEvaluationPrepareSchema,
  type AdvancedRefinerEvaluationOptions,
  sealAdvancedRefinerEvaluationPin,
  verifyAdvancedRefinerEvaluationPin,
} from "openpond-sdk/advanced-refiner-evaluations";
import { createExperimentImprovementOptions } from "../harness/experiment-improvement-options.js";
import { inspectRefinerProfile } from "../refiner/refiner-profile-service.js";
import type { createAdvancedRefinerEvaluationSource } from "./advanced-refiner-evaluation-source.js";
import type { createHarnessRefinerBenchmarkService } from "./harness-refiner-benchmark-service.js";
import type { createBenchmarkTasksetService } from "./benchmark-tasksets.js";

/** Preparation/list/read contain no model or environment launch. All Start
 * fields are derived from the exact current-owner catalog and rechecked at
 * admission, including the independent cohort and private closure. */
export function createAdvancedRefinerEvaluationPayload(
  deps: Parameters<typeof createExperimentImprovementOptions>[0] & {
    authorizeProject(id: string): Promise<void>;
    source: ReturnType<typeof createAdvancedRefinerEvaluationSource>;
    benchmarks: ReturnType<typeof createHarnessRefinerBenchmarkService>;
    benchmarkTasksets: ReturnType<typeof createBenchmarkTasksetService>;
  },
) {
  const options = createExperimentImprovementOptions(deps);
  const custom = z.discriminatedUnion("operation", [
    z
      .object({
        operation: z.literal("options"),
        evidence: z
          .object({ id: z.string(), contentHash: z.string() })
          .strict(),
      })
      .strict(),
    AdvancedRefinerEvaluationPrepareSchema,
  ]);
  async function identity(teamId: string) {
    const actor = {
      actorId: await deps.actorId(),
      teamId: await deps.teamId(),
    };
    if (!actor.actorId || actor.teamId !== teamId)
      throw new Error("Choose the current advanced evaluation workspace.");
    return actor;
  }
  async function fence(actor: { actorId: string; teamId: string }) {
    if (contentHash(await identity(actor.teamId)) !== contentHash(actor))
      throw new Error("The advanced evaluation owner changed during I/O.");
  }
  async function details(
    actor: { actorId: string; teamId: string },
    reference: { id: string; contentHash: string },
  ) {
    const base = await options(actor, reference),
      access = await deps.resolveAccess(),
      client = new OpenPondTasksetPackageClient({
        ...access,
        apiKey: access.token,
        baseUrl: access.apiBaseUrl,
        teamId: actor.teamId,
      });
    const profiles: AdvancedRefinerEvaluationOptions["profiles"] = [];
    for (const row of base.profiles) {
      const components = [];
      for (const component of row.components) {
        if (!component.label) continue;
        const label = component.label;
        const value = await client.getByRelease(component.binding.dataset, {
            expectedPackageHash: component.binding.packageHash,
          }),
          splits = [...new Set(value.taskset.tasks.map((task) => task.split))]
            .filter((split) => split !== component.binding.split)
            .map((split) => ({
              split,
              taskIds: value.taskset.tasks
                .filter((task) => task.split === split)
                .map((task) => task.id),
            }));
        components.push({
          ...component,
          label,
          adaptationSplits: splits,
          environmentHash: value.environment.contentHash,
          resettable: value.environment.contract.networkPolicy === "none",
          reviewQuality:
            value.taskset.metadata.advancedRefinerReview !== undefined,
        });
      }
      profiles.push({ ...row, components });
    }
    const refinerHistory = await inspectRefinerProfile(deps.storeDir);
    const localModels = (await deps.store.listModelProjects())
      .filter((model) =>
        profiles.some(
          (profile) => profile.profileRef.profileId === model.profileId,
        ),
      )
      .map((model) => ({
        id: model.id,
        profileId: model.profileId,
        name: model.name,
        location:"local" as const,
      }));
    await fence(actor);
    return {
      ...base,
      profiles,
      refinerReleases: refinerHistory.releases.map((release) => ({
        id: release.id,
        contentHash: release.contentHash,
      })),
      activeRefiner: refinerHistory.binding.release,
      models:localModels,
    };
  }
  return async (raw: unknown) => {
    const envelope = z
        .object({
          teamId: z.string(),
          projectId: z.string().nullable(),
          request: z.unknown(),
        })
        .strict()
        .parse(raw),
      actor = await identity(envelope.teamId),
      special = custom.safeParse(envelope.request);
    const stopping =
      typeof envelope.request === "object" &&
      envelope.request !== null &&
      "operation" in envelope.request &&
      envelope.request.operation === "cancel";
    if (envelope.projectId && !stopping)
      await deps.authorizeProject(envelope.projectId);
    await fence(actor);
    if (special.success) {
      const request = special.data,
        available = await details(actor, request.evidence);
      if (request.operation === "options") return available;
      const selected = available.profiles.find(
          (row) => row.id === request.profileOptionId,
        ),
        component = selected?.components.find(
          (row) => row.label === request.componentLabel,
        );
      if (!selected || !component)
        throw new Error(
          "The exact selected Profile/component is no longer available.",
        );
      const adaptation = component.adaptationSplits.find(
        (row) => row.split === request.adaptationSplit,
      );
      if (!adaptation?.taskIds.length)
        throw new Error("Choose a separately declared adaptation split.");
      if (component.binding.recordedOrigin)
        throw new Error(
          "Recorded-only cutoffs do not declare an independent adaptation cohort; publish and review an explicitly disjoint Dataset first.",
        );
      const seed = component.binding.population[0]!.seed;
      if (
        new Set(component.binding.population.map((row) => row.seed)).size !== 1
      )
        throw new Error(
          "Advanced evaluation requires one exact admitted trajectory seed.",
        );
      const adaptationBinding = createProfileExternalDatasetBinding({
        ...component.binding,
        split: request.adaptationSplit,
        population: adaptation.taskIds.map((taskId) => ({
          taskId,
          seed,
          fixtureId: null,
        })),
      });
      const pin = sealAdvancedRefinerEvaluationPin({
        schemaVersion: "openpond.advancedRefinerEvaluation.v1",
        operationId: request.operationId,
        ...actor,
        projectId: envelope.projectId,
        mode: request.mode,
        profileRef: selected.profileRef,
        sourceRevision: selected.profileSourceRevision,
        baselineRelease: selected.baseRelease,
        refinerRelease: request.refinerRelease,
        evidence: request.evidence,
        externalDatasetBinding: component.binding,
        adaptationDatasetBinding: adaptationBinding,
        privateClosureHash: component.binding.protectedProfileClosureHash,
        adaptationTaskIds: adaptation.taskIds,
        holdoutTaskIds: [
          ...new Set(component.binding.population.map((row) => row.taskId)),
        ],
        adaptationSplit: request.adaptationSplit,
        holdoutSplit: component.binding.split,
        environmentPolicy: {
          kind: "resettable",
          environmentHash: component.environmentHash,
        },
        maximumCostUsd: request.maximumCostUsd,
        maximumDurationMs: request.maximumDurationMs,
        maximumModelSteps: request.maximumModelSteps,
      });
      await deps.source.read(pin);
      await fence(actor);
      return { pin };
    }
    const request = AdvancedRefinerEvaluationCommandSchema.parse(
      envelope.request,
    );
    if (request.operation === "start") {
      const pin = verifyAdvancedRefinerEvaluationPin(request.request.pin);
      if (
        pin.actorId !== actor.actorId ||
        pin.teamId !== actor.teamId ||
        pin.projectId !== envelope.projectId
      )
        throw new Error(
          "Advanced Start changed its exact reviewed owner or Project.",
        );
      const selected = await deps.source.read(pin);
      if (pin.mode === "review_quality")
        for (const taskId of pin.holdoutTaskIds)
          await deps.source.reviewContext(pin, taskId);
      const taskset = await deps.benchmarkTasksets.projectSelected({
        profileId: request.request.profileId,
        package: selected.packageValue,
        adaptationSplit: pin.adaptationSplit,
        holdoutSplit: pin.holdoutSplit,
      });
      await selected.authorize();
      await fence(actor);
      return deps.benchmarks.start({
        advancedEvaluation: pin,
        selectedTaskset: {
          id: taskset.id,
          revision: taskset.revision,
          contentHash: taskset.contentHash,
        },
        modelId: request.request.modelId,
        profileId: request.request.profileId,
        model: request.request.model,
        reasoningEffort: request.request.reasoningEffort,
        seeds: [request.request.seed],
        repetitions: 1,
        maximumSpendUsd: pin.maximumCostUsd,
      });
    }
    const rows = (await deps.store.listModelRuns()).filter(
      (run) =>
        run.evaluation?.benchmarkId === "harness-refiner" &&
        run.evaluation.advancedEvaluation?.actorId === actor.actorId &&
        run.evaluation.advancedEvaluation.teamId === actor.teamId &&
        run.evaluation.advancedEvaluation.projectId === envelope.projectId,
    );
    if (request.operation === "list") {
      await fence(actor);
      return {
        items: rows.map((run) => ({
          id: run.id,
          status: run.status,
          mode:
            run.evaluation!.benchmarkId === "harness-refiner"
              ? run.evaluation!.advancedEvaluation!.mode
              : null,
          startedAt: run.startedAt,
          completedAt: run.completedAt,
          failure: run.failure,
        })),
      };
    }
    const run = rows.find((run) => run.id === request.id);
    if (
      !run ||
      run.evaluation?.benchmarkId !== "harness-refiner" ||
      !run.evaluation.advancedEvaluation
    )
      throw new Error("The advanced run is unavailable to the current owner.");
    if (request.operation === "cancel") {
      const stopped = await deps.benchmarks.cancel(run.id);
      await fence(actor);
      return { id: stopped.id, status: stopped.status };
    }
    await deps.source.authorize(run.evaluation.advancedEvaluation);
    await fence(actor);
    if (request.operation === "resume") return deps.benchmarks.resume(run.id);
    return run;
  };
}
