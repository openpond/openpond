import type { ClientConnection } from "../../../api/api-client";
import type { LearningRevisionRef } from "@openpond/evals/learning";
import { learningRequest, saveLearningPolicy } from "./client";
import {
  revisionRef,
  sourceKey,
  type ConversationPolicy,
  type LearningConfiguration,
  type LearningOptions,
  type SourceBinding,
  type ServingTarget,
} from "./contracts";

export type LearningDraft = Omit<
  LearningConfiguration,
  "definition" | "sources" | "configuration" | "learningPolicy"
> & {
  definition: LearningRevisionRef | null;
  sourceKeys: string[];
  configurationId: string;
  trainingPolicyId: string;
  graderIds: string[];
};
export function initialLearningDraft(
  projectId: string,
  existing?: ConversationPolicy,
  bindings: SourceBinding[] = [],
): LearningDraft {
  const value = existing?.configuration;
  return {
    projectId,
    name: value?.name ?? "Continual learning",
    mode: value?.mode ?? "activate",
    definition: value?.definition ?? null,
    configurationId: value?.configuration?.id ?? "",
    trainingPolicyId: value?.learningPolicy?.id ?? "",
    graderIds: [],
    sourceKeys: [
      ...new Set([
        ...(value?.sources.filter((source) => source.enabled).map(sourceKey) ?? []),
        ...bindings.map(sourceKey),
      ]),
    ],
    adapter: value?.adapter ?? { kind: "complete_text", qualitativeOnly: true },
    generator: value?.generator ?? null,
    graderSelection:
      value?.graderSelection ??
      (existing
        ? { mode: "manual" }
        : {
            mode: "auto",
            modelId: "gpt-6-luna",
            sampleSize: 8,
            maximumOutputTokens: 2048,
            maximumSpendUsd: 1,
          }),
    schedule: value?.schedule ?? {
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      hour: 2,
      minute: 0,
      endHour: 6,
      endMinute: 0,
    },
    limits: value?.limits ?? {
      perCycleUsd: 5,
      dailyUsd: 5,
      monthlyUsd: 25,
      gradeUsd: 0.2,
      maximumTasks: 10,
      minimumExamples: 5,
      maxGpuSeconds: 10800,
      maximumAttempts: 2,
      lookbackDays: 30,
    },
    exceptions: value?.exceptions ?? "block",
    minimumScore: value?.minimumScore ?? 0.8,
    selection: value?.selection ?? {
      maximumSourceShare: 1,
      maximumFailureShare: 1,
      maximumLengthShare: 1,
      replayFraction: 0.2,
      auditFraction: 0.1,
    },
    acceptance: value?.acceptance ?? {
      minimumCasesPerCheck: 20,
      minimumImprovement: 0.05,
      windowCasesPerCheck: 20,
    },
    failurePolicy: value?.failurePolicy ?? { pauseAfterConsecutiveFailures: 3 },
    ...(value?.serving
      ? { serving: value.serving }
      : { serving: { targetId: "", canarySeconds: 120, rollbackOnRuntimeFailure: true } }),
  };
}
export function reviewedTrainingPolicies(
  options: LearningOptions | undefined,
  configurationId: string,
) {
  const model = options?.configurations.find((item) => item.id === configurationId);
  return (
    options?.trainingPolicies.filter(
      (policy) =>
        policy.modelProjectId === model?.portableProjectId &&
        policy.training.recipe.id === `model-recipe-${model?.etag}` &&
        !policy.id.startsWith("conversation-training-"),
    ) ?? []
  );
}
export async function submitLearningDraft(
  connection: ClientConnection,
  teamId: string,
  draft: LearningDraft,
  options: LearningOptions,
  existing: ConversationPolicy | undefined,
  enabled: boolean,
) {
  const model = options.configurations.find((item) => item.id === draft.configurationId);
  const reviewed = reviewedTrainingPolicies(options, draft.configurationId).find(
    (item) => item.id === draft.trainingPolicyId,
  );
  if (!draft.name.trim()) throw new Error("Enter a policy name.");
  if (!options.projects.some((item) => item.id === draft.projectId))
    throw new Error("This owned Project is unavailable for continual learning.");
  if (
    draft.configurationId &&
    (!model ||
      !options.projects
        .find((item) => item.id === draft.projectId)
        ?.configurationIds.includes(model.id))
  )
    throw new Error("Choose a model configuration attached to this Project.");
  if (draft.mode !== "evaluate" && (!model || !reviewed))
    throw new Error("Choose an owned model and its reviewed training setup.");
  if (
    draft.limits.perCycleUsd > draft.limits.dailyUsd ||
    draft.limits.dailyUsd > draft.limits.monthlyUsd
  )
    throw new Error("Daily and monthly spending limits must cover the run limit.");
  if (
    draft.limits.minimumExamples >
    draft.limits.maximumTasks -
      Math.floor(draft.limits.maximumTasks * (draft.selection?.replayFraction ?? 0))
  )
    throw new Error("Leave capacity for the minimum new examples after replay.");
  const selected = options.sources.filter(
    (source) =>
      source.projectId === draft.projectId && draft.sourceKeys.includes(sourceKey(source)),
  );
  if (!selected.length) throw new Error("Select a source agent for this Project.");
  const sources: SourceBinding[] = [
    ...(existing?.configuration.sources ?? [])
      .filter((source) => !selected.some((item) => sourceKey(item) === sourceKey(source)))
      .map((source) => ({ ...source, enabled: false })),
    ...selected.map((source) => ({
      origin: source.origin,
      sourceInstanceId: source.sourceInstanceId,
      enabled: true,
    })),
  ];
  let definition = draft.definition;
  if (
    model &&
    (existing?.configuration.configuration?.id !== model.id ||
      existing.configuration.configuration.expectedEtag !== model.etag)
  ) {
    definition = await learningRequest<LearningRevisionRef>(connection, teamId, "definitions", {
      projectId: draft.projectId,
      configuration: { id: model.id, expectedRevision: model.revision, expectedEtag: model.etag },
    });
  } else if (draft.graderIds.length) {
    const graders = options.graders.flatMap((item) =>
      item && draft.graderIds.includes(item.id) ? [revisionRef(item)] : [],
    );
    definition = await learningRequest<LearningRevisionRef>(connection, teamId, "definitions", {
      projectId: draft.projectId,
      graders,
    });
  }
  if (!definition) throw new Error("Select evaluation rubrics or an existing task definition.");
  let serving = draft.serving;
  const selectedTarget = options.servingTargets.find((item) => item.id === serving?.targetId);
  if (draft.mode === "activate" && serving?.targetId && (!selectedTarget || !selectedTarget.enabled || selectedTarget.projectId !== draft.projectId))
    throw new Error("Select an available serving target in this Project.");
  if (
    draft.mode === "activate" &&
    (!serving?.targetId ||
      selectedTarget?.hostedPonder)
  ) {
    const target = await learningRequest<ServingTarget>(connection, teamId, "serving-targets", {
      action: "ensure_hosted_ponder",
      projectId: draft.projectId,
      bindingId: options.ponderBindingId,
    });
    serving = {
      targetId: target.id,
      canarySeconds: serving?.canarySeconds ?? 120,
      rollbackOnRuntimeFailure: true,
    };
  }
  if (draft.mode === "activate" && !serving?.targetId)
    throw new Error("Choose a serving target, or enable the policy to register hosted Ponder.");
  const {
    sourceKeys: _keys,
    configurationId: _configuration,
    trainingPolicyId: _policy,
    graderIds: _graders,
    ...fields
  } = draft;
  const configuration: LearningConfiguration = {
    ...fields,
    name: draft.name.trim(),
    definition,
    sources,
    configuration: model
      ? { id: model.id, expectedRevision: model.revision, expectedEtag: model.etag }
      : null,
    learningPolicy: reviewed ? revisionRef(reviewed) : null,
    ...(draft.mode === "activate" ? { serving } : {}),
  };
  if (draft.mode !== "activate") delete configuration.serving;
  if (draft.mode === "evaluate") delete configuration.acceptance;
  return saveLearningPolicy(connection, teamId, existing, configuration, enabled);
}
