import { AdvancedRefinerExperimentSetup } from "./AdvancedRefinerExperimentSetup";
import { ReviewedExperimentScheduleControl } from "./ReviewedExperimentScheduleControl";
import { ClaudeCodeChoice } from "../../human-review/ClaudeCodeChoice";
import { TrainedVersionExperimentControl } from "../TrainedVersionExperimentControl";
import { LocalInferenceChoice } from "../../human-review/LocalInferenceChoice";
import { ExperimentSetupTabs } from "./ExperimentSetupTabs";
import { useRef, useState } from "react";
import {
  LocalExperimentRecordSchema,
  LocalExperimentRunFromReleaseSchema,
} from "@openpond/contracts";
import { useQuery } from "@tanstack/react-query";
import { contentHash } from "@openpond/harness";
import {
  RunExperimentSchema,
  groupDatasetGraders,
  canonicalDatasetGraderSelection,
  type ExperimentRunDetails,
  type RunExperiment,
  type PreparedHarnessExperimentSchema,
} from "openpond-sdk/experiments";
import type { ModelTasksetRunRequest } from "openpond-sdk/model-taskset-runs";
import type { HostedTasksetSummary } from "openpond-sdk/taskset-catalog";
import type { z } from "zod";
import { modelsRouteFromLocation, type ModelsRoute } from "../models-route";
import { useDraftNavigation } from "../useDraftNavigation";
import { ExperimentAdvancedSettings } from "./ExperimentAdvancedSettings";
import { ExperimentSourceControls } from "./ExperimentSourceControls";
import { useExperimentSources } from "./useExperimentSources";
import { EvaluationCard } from "./EvaluationPresentation";
import { DatasetSetupGraders } from "./DatasetSetupGraders";
import { ReleasedDatasetPicker } from "./ReleasedDatasetPicker";
import { useDatasetPopulation } from "./useDatasetPopulation";
import { experimentPopulation } from "./experiment-population";
import { useEvaluationSetup } from "./EvaluationSetupState";
import { WorkspacePanel } from "./WorkspacePanel";
import type { Inventory, WorkspaceApi } from "./workspace-api";
type Prepared = z.infer<typeof PreparedHarnessExperimentSchema>;
type ExperimentSetupPanelProps = {
  api: WorkspaceApi;
  inventory: Inventory | null;
  route: ModelsRoute;
  navigate: (route: ModelsRoute) => void;
  onSaved: (value: { id: string }) => void;
  dispatch?: (
    configuration: RunExperiment,
    operationId: string,
  ) => Promise<{ id: string }>;
  onClose?: () => void;
  onAdvancedRun?: (id: string) => void;
};
export function ExperimentSetupPanel(props: ExperimentSetupPanelProps) {
  const setup = useEvaluationSetup();
  if (setup.advancedTarget)
    return (
      <AdvancedRefinerExperimentSetup
        api={props.api}
        target={setup.advancedTarget}
        onClose={() => {
          setup.close();
          props.onClose?.();
        }}
        onOpenRun={props.onAdvancedRun}
      />
    );
  return <OrdinaryExperimentSetupPanel {...props} />;
}
function OrdinaryExperimentSetupPanel({
  api,
  inventory,
  route,
  navigate,
  onSaved,
  dispatch,
  onClose,
}: ExperimentSetupPanelProps) {
  const setup = useEvaluationSetup();
  const draft = setup.draft!;
  const { name, release, modelId, budget, outputTokens, prompt, seed } = draft;
  const existing = setup.existing;
  const localRuntime =
    api.location === "local" && draft.mode === "model"
      ? draft.localRuntime
      : undefined;
  const patch = (value: Partial<typeof draft>) =>
    setup.setDraft((previous) =>
      previous ? { ...previous, ...value } : previous,
    );
  const project = inventory?.projects.projects.find(
    (item) => item.id === api.projectId,
  );
  const sources = useExperimentSources(api, inventory, draft, existing);
  const profileMode = draft.mode === "model_harness_profile";
  const sourceUnavailable = sources.unavailable;
  const [error, setError] = useState<string | null>(null);
  const [reviewConfiguration, setReviewConfiguration] = useState<{
    key: string;
    configuration: RunExperiment;
  } | null>(null);
  const [reviewed, setReviewed] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const active = useRef(false);
  const preparedRunOperation = useRef<Awaited<
    ReturnType<typeof api.operation>
  > | null>(null);
  const localDataset = sources.local.data?.profiles.find(
    (item) =>
      item.taskset.id === release?.id &&
      item.taskset.contentHash === release.contentHash,
  );
  const sourceReady =
    api.location !== "local" ||
    draft.mode === "model" ||
    sources.local.isSuccess;
  const population = useDatasetPopulation(
    api,
    release,
    localDataset?.id,
    sourceReady,
  );
  const choices = population.data
    ? groupDatasetGraders(population.data.graders)
    : [];
  const graders = release
    ? (draft.graderChoices[release.contentHash] ??
      (existing?.request.taskset.contentHash === release.contentHash
        ? existing.graders.map((grader) => ({
            id: grader.id,
            version: grader.version,
            contentHash: grader.contentHash,
            mappings: grader.mappings ?? [],
          }))
        : choices.length <= 100
          ? choices.map(({ grader }) => ({
              id: grader.id,
              version: grader.version,
              contentHash: grader.contentHash,
              mappings: [],
            }))
          : []))
    : [];
  let graderConflict: string | null = null;
  let canonicalGraders = graders;
  if (population.data) {
    try {
      canonicalGraders = canonicalDatasetGraderSelection(
        graders.map((selection) => {
          const pin = population.data!.graders.find(
            (item) =>
              item.id === selection.id &&
              item.version === selection.version &&
              item.contentHash === selection.contentHash,
          );
          if (!pin)
            throw new Error(
              "A selected grader is no longer in this exact Dataset release. Choose its released grader again.",
            );
          return { ...pin, mappings: selection.mappings };
        }),
      ).map(({ id, version, contentHash, mappings }) => ({
        id,
        version,
        contentHash,
        mappings,
      }));
    } catch (cause) {
      graderConflict = cause instanceof Error ? cause.message : String(cause);
    }
  }
  const models = useQuery({
    queryKey: [
      "evaluation-workspace",
      api.key,
      "modelChoices",
      release?.contentHash,
    ],
    enabled: Boolean(release) && !localDataset && sourceReady,
    queryFn: ({ signal }) =>
      api.request<{
        available: boolean;
        unavailableReason: string | null;
        models: Array<{ id: string; name: string }>;
      }>("modelChoices", { taskset: release }, signal),
  });
  const sampling = useQuery({
    queryKey: ["evaluation-workspace", api.key, "samplingModels"],
    queryFn: ({ signal }) =>
      api.request<{
        models: Array<{ id: string; name: string; supportsSampling: boolean }>;
      }>("graderModels", {}, signal),
  });
  const supportsSampling =
    sampling.data?.models.find((item) => item.id === modelId)
      ?.supportsSampling === true;
  const summary = useQuery({
    queryKey: [
      "evaluation-workspace",
      api.key,
      "resolveDataset",
      release?.contentHash,
    ],
    enabled: Boolean(release) && !localDataset && sourceReady,
    queryFn: ({ signal }) =>
      api.request<HostedTasksetSummary>("resolveDataset", { release }, signal),
  });
  const guard = useDraftNavigation({
    name: "Experiment setup",
    dirty: JSON.stringify(draft) !== setup.baseline,
    busy,
    onLeave: setup.close,
    retainForDestination(destination) {
      const next = modelsRouteFromLocation(
        new URL(destination, window.location.origin),
      );
      return Boolean(
        next &&
        ["datasets", "graders", "experiments"].includes(next.page) &&
        (next.projectId ?? null) === api.projectId &&
        (next.executionLocation ?? "hosted") === api.location,
      );
    },
  });
  function reviewTasks() {
    if (!release || (!summary.data && !localDataset)) return;
    if (localDataset) {
      guard.allowNextNavigation();
      navigate({
        ...route,
        page: "datasets",
        resourceId: localDataset.id,
        datasetKind: "release",
        revision: release.revision,
        contentHash: release.contentHash,
        detailTab: "tasks",
        executionId: null,
        passId: null,
        after: null,
        query: "",
      });
      return;
    }
    const review = setup.reviewRoute;
    guard.allowNextNavigation();
    navigate(
      review
        ? { ...review, detailTab: "tasks", after: null }
        : {
            ...route,
            page: "datasets",
            resourceId: summary.data!.id,
            datasetKind: "release",
            revision: release.revision,
            contentHash: release.contentHash,
            detailTab: "tasks",
            collection: "default",
            executionId: null,
            passId: null,
            after: null,
            query: "",
          },
    );
  }
  const operationForSetup =
    api.location === "local" ? api.localOperation : api.operation;
  async function prepareConfiguration(): Promise<RunExperiment> {
    if (active.current)
      throw new Error("Experiment setup is already preparing.");
    active.current = true;
    setBusy(true);
    setError(null);
    try {
      if (!name.trim()) throw new Error("Name this Experiment.");
      if (sourceUnavailable) throw new Error(sourceUnavailable);
      if (graderConflict) throw new Error(graderConflict);
      if (draft.mode === "model_harness" && prompt.trim())
        throw new Error(
          "Released Harness instructions are immutable. Clear the additional system instructions before running this composition.",
        );
      if (
        !profileMode &&
        ((draft.temperature ?? 0) !== 0 || (draft.topP ?? 1) !== 1) &&
        !supportsSampling
      )
        throw new Error(
          "This model does not support sampling overrides. Clear them in Advanced settings or choose a supported model.",
        );
      let request: ModelTasksetRunRequest;
      const scope = project
        ? {
            id: project.id,
            revision: project.revision,
            contentHash: contentHash(project.content),
            targetId:
              draft.mode === "model" ? null : (sources.selected?.id ?? null),
          }
        : undefined;
      if (profileMode) {
        const localProfile = sources.profile,
          hostedProfile = sources.profileTarget;
        const target = api.location === "local" ? localProfile : hostedProfile;
        if (!target)
          throw new Error(
            "Choose an authorized compatible Profile evaluation.",
          );
        const operation = await operationForSetup("prepareHarness", {
          target,
          modelId,
          budget,
        });
        const input =
          api.location === "local" && localProfile
            ? {
                operationId: operation.id,
                profileRepositoryId: localProfile.profileRef.repositoryId,
                definitionId: localProfile.definitionId,
                profileRef: localProfile.profileRef,
                profileSource: {
                  sourceRevision: localProfile.sourceRevision,
                  harnessRelease: localProfile.harnessRelease,
                },
                modelId,
                maximumCostUsd: budget,
              }
            : {
                operationId: operation.id,
                profileRepositoryId: hostedProfile!.profileRepositoryId,
                definitionId: hostedProfile!.source.definitionId,
                modelId,
                maximumCostUsd: budget,
              };
        const prepared =
          api.location === "local"
            ? await api.local<Prepared>("prepareHarness", input)
            : await api.request<Prepared>("prepareHarness", input);
        if (
          !release ||
          prepared.request.taskset.id !== release.id ||
          prepared.request.taskset.contentHash !== release.contentHash
        )
          throw new Error(
            "This Profile evaluation is bound to a different Dataset release. Choose its exact compatible Dataset.",
          );
        if (
          prepared.request.population.some(
            (member) => !setup.selected(release, member.taskId),
          )
        )
          throw new Error(
            "This Profile evaluation requires all of its declared tasks and seeds. Restore its full task selection before running.",
          );
        if (
          population.data?.items.some(
            (task) =>
              setup.selected(release, task.id) &&
              !prepared.request.population.some(
                (member) => member.taskId === task.id,
              ),
          )
        )
          throw new Error(
            "This Profile evaluation supports only its declared task set. Review tasks and select exactly that set.",
          );
        request = {
          ...prepared.request,
          name: name.trim(),
          ...(scope ? { project: scope } : {}),
        };
      } else {
        if (!population.data || !release)
          throw new Error("Select a published Dataset version.");
        const tasks = population.data.items.filter((task) =>
          setup.selected(release, task.id),
        );
        if (!tasks.length)
          throw new Error(
            "Select at least one task in the Dataset Tasks table.",
          );
        const members = experimentPopulation({
          existing,
          release,
          taskIds: tasks.map((task) => task.id),
          seedText: seed,
          createReceiptId: (taskId, environmentSeed) =>
            `evaluation-${contentHash([api.key, name, release.contentHash, modelId, prompt, taskId, environmentSeed]).slice(0, 32)}`,
        });
        if (!canonicalGraders.length || canonicalGraders.length > 100)
          throw new Error("Select between one and 100 Dataset graders.");
        if (
          !localRuntime &&
          !(localDataset ? sampling.data?.models : models.data?.models)?.some(
            (model) => model.id === modelId,
          )
        )
          throw new Error(
            models.data?.unavailableReason ??
              "Choose a supported hosted model.",
          );
        request = {
          schemaVersion: "openpond.modelTasksetRunRequest.v1",
          operationId: (
            await operationForSetup("setup", {
              name,
              release,
              modelId,
              prompt,
              seed,
              taskIds: tasks.map((task) => task.id),
            })
          ).id,
          teamId: api.teamId,
          modelProjectId: null,
          name: name.trim(),
          ...(scope ? { project: scope } : {}),
          taskset: release,
          policy: {
            kind: "hosted_chat",
            ...(localRuntime ? { localRuntime } : {}),
            modelId,
            maxOutputTokens: outputTokens,
            temperature: draft.temperature ?? 0,
            topP: draft.topP ?? 1,
            ...(sources.harnessSource
              ? { harness: sources.harnessSource }
              : {}),
            ...(prompt.trim()
              ? { messages: [{ role: "system", content: prompt }] }
              : {}),
          },
          population: members,
        };
      }
      const submission = {
        request,
        maximumCostUsd: budget,
        graders: canonicalGraders,
        ...(existing ? { sourceExperimentId: existing.id } : {}),
      };
      const operation = await operationForSetup("run", submission);
      const configuration = RunExperimentSchema.parse({
        ...submission,
        operationId: operation.id,
        request: { ...request, operationId: operation.id },
      });
      preparedRunOperation.current = operation;
      return configuration;
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
      throw cause;
    } finally {
      active.current = false;
      setBusy(false);
    }
  }
  async function review() {
    try {
      const key = reviewKey,
        configuration = await prepareConfiguration();
      setReviewConfiguration({ key, configuration });
      setReviewed(key);
    } catch {
      /* The preparation exposes its exact error above. */
    }
  }
  async function run() {
    if (active.current || reviewConfiguration?.key !== reviewKey) return;
    active.current = true;
    setBusy(true);
    setError(null);
    try {
      const configuration = reviewConfiguration.configuration,
        request = configuration.request;
      const operation = preparedRunOperation.current;
      if (!operation || operation.id !== configuration.operationId)
        throw new Error(
          "The reviewed operation changed. Review this setup again.",
        );
      const id = dispatch
        ? (await dispatch(configuration, operation.id)).id
        : api.location === "local"
          ? LocalExperimentRecordSchema.parse(
              await api.local(
                "runFromRelease",
                LocalExperimentRunFromReleaseSchema.parse({
                  configuration,
                  ...(existing?.packageHash &&
                  existing.request.taskset.contentHash ===
                    request.taskset.contentHash
                    ? { expectedPackageHash: existing.packageHash }
                    : {}),
                }),
              ),
            ).id
          : (await api.request<ExperimentRunDetails>("run", configuration))
              .summary.id;
      await operation.acknowledge();
      guard.allowNextNavigation();
      setup.close();
      onSaved({ id });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      active.current = false;
      setBusy(false);
    }
  }
  const reviewKey = JSON.stringify({
    draft,
    graders: canonicalGraders,
    project: api.projectId,
    location: api.location,
    population: population.data?.items
      .filter((task) => release && setup.selected(release, task.id))
      .map((task) => task.id),
  });
  const reviewCount =
    release && population.data
      ? population.data.items.filter((task) => setup.selected(release, task.id))
          .length
      : 0;
  let reviewIssue: string | null = null;
  try {
    if (!name.trim()) throw new Error("Name this Experiment before reviewing.");
    if (
      !release ||
      !population.data ||
      population.isFetching ||
      population.error
    )
      throw new Error(
        "Choose an exact Dataset version and wait for its complete task population.",
      );
    if (!sourceReady || sourceUnavailable)
      throw new Error(
        sourceUnavailable ?? "Wait for the authorized source choices.",
      );
    if (
      !localRuntime &&
      !(localDataset ? sampling.data?.models : models.data?.models)?.some(
        (model) => model.id === modelId,
      )
    )
      throw new Error("Choose a model from the authorized current catalog.");
    if (!Number.isFinite(budget) || budget <= 0 || budget > 10_000)
      throw new Error(
        "Set a whole Experiment ceiling greater than zero and at most $10,000.",
      );
    if (
      graderConflict ||
      !canonicalGraders.length ||
      canonicalGraders.length > 100
    )
      throw new Error(
        graderConflict ?? "Select between one and 100 released graders.",
      );
    const taskIds = population.data.items
      .filter((task) => setup.selected(release, task.id))
      .map((task) => task.id);
    if (!taskIds.length) throw new Error("Select at least one Dataset task.");
    if (profileMode) {
      if (
        sources.profile &&
        (taskIds.length !== sources.profile.taskIds.length ||
          sources.profile.taskIds.some((id) => !taskIds.includes(id)))
      )
        throw new Error(
          "This released Profile check evaluates exactly its declared task and seed set. Restore that selection before reviewing.",
        );
    } else {
      if (
        !Number.isInteger(outputTokens) ||
        outputTokens < 1 ||
        outputTokens > 4096
      )
        throw new Error("Set maximum output tokens between one and 4096.");
      const temperature = draft.temperature ?? 0,
        topP = draft.topP ?? 1;
      if (
        !Number.isFinite(temperature) ||
        temperature < 0 ||
        temperature > 2 ||
        !Number.isFinite(topP) ||
        topP <= 0 ||
        topP > 1
      )
        throw new Error("Use valid sampling settings in Advanced.");
      if ((temperature !== 0 || topP !== 1) && !supportsSampling)
        throw new Error("Clear unsupported sampling overrides in Advanced.");
      if (draft.mode === "model_harness" && prompt.trim())
        throw new Error(
          "Released Harness instructions are immutable. Clear additional instructions in Advanced.",
        );
      experimentPopulation({
        existing,
        release,
        taskIds,
        seedText: seed,
        createReceiptId: (taskId, environmentSeed) =>
          `${taskId}:${environmentSeed}`,
      });
    }
  } catch (cause) {
    reviewIssue = cause instanceof Error ? cause.message : String(cause);
  }
  return (
    <WorkspacePanel
      label="Experiment setup"
      action="experiment"
      onRequestClose={() =>
        void guard.requestLeave(() => {
          setup.close();
          onClose?.();
        })
      }
    >
      <header>
        <h2>{existing ? "Run another Experiment" : "Run Experiment"}</h2>
      </header>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          if (reviewIssue) {
            setError(reviewIssue);
            return;
          }
          if (reviewed === reviewKey) void run();
          else void review();
        }}
      >
        <ExperimentSetupTabs
          dataset={
            <>
              {" "}
              <EvaluationCard title="Dataset">
                <ReleasedDatasetPicker
                  api={api}
                  value={release}
                  onChange={setup.changeRelease}
                  disabled={false}
                  localChoices={sources.local.data?.profiles.filter(
                    (choice) =>
                      !api.projectId ||
                      project?.content.resources.some(
                        (resource) =>
                          resource.kind === "dataset" &&
                          resource.release?.id === choice.taskset.id &&
                          resource.release.contentHash ===
                            choice.taskset.contentHash,
                      ),
                  )}
                  localLoading={!sourceReady}
                />
                <button
                  type="button"
                  className="training-text-button"
                  disabled={busy}
                  onClick={() => {
                    guard.allowNextNavigation();
                    navigate({
                      ...route,
                      page: "datasets",
                      resourceId: null,
                      datasetKind: undefined,
                      detailTab: "tasks",
                      revision: undefined,
                      contentHash: undefined,
                      executionId: null,
                      passId: null,
                      after: null,
                      query: "",
                    });
                  }}
                >
                  Add Dataset
                </button>
                {population.data && release ? (
                  <p>
                    {setup.count(release, population.data.taskCount)} of{" "}
                    {population.data.taskCount} tasks selected
                    {setup.selection?.mode !== "subset" &&
                    !setup.selection?.ids.length
                      ? " / All tasks in this release"
                      : ""}{" "}
                    <button
                      type="button"
                      className="training-text-button"
                      disabled={(!summary.data && !localDataset) || busy}
                      onClick={reviewTasks}
                    >
                      Review tasks
                    </button>
                  </p>
                ) : null}
              </EvaluationCard>
            </>
          }
          target={
            <>
              {" "}
              <EvaluationCard title="Model and budget">
                <label>
                  Model
                  <select
                    value={modelId}
                    disabled={Boolean(localRuntime)}
                    onChange={(event) =>
                      patch({
                        modelId: event.target.value,
                        localRuntime: undefined,
                      })
                    }
                  >
                    <option value="">Choose model</option>
                    {(localDataset
                      ? sampling.data?.models
                      : models.data?.models
                    )?.map((model) => (
                      <option key={model.id} value={model.id}>
                        {model.name}
                      </option>
                    ))}
                  </select>
                </label>
                {!localRuntime &&
                localDataset &&
                sampling.isSuccess &&
                !sampling.data.models.length ? (
                  <p role="status">
                    No models are available for this account. Choose a
                    configured local provider below.
                  </p>
                ) : !localRuntime &&
                  !localDataset &&
                  models.isSuccess &&
                  (!models.data.available || !models.data.models.length) ? (
                  <p role="status">
                    {models.data.unavailableReason ??
                      "No models are available for this Dataset and account."}
                  </p>
                ) : null}
                <label>
                  Whole execution budget ($)
                  <input
                    type="number"
                    min="0.000001"
                    max="10000"
                    step="0.000001"
                    value={budget}
                    onChange={(event) =>
                      patch({ budget: Number(event.target.value) })
                    }
                    required
                  />
                </label>
              </EvaluationCard>
              {api.location === "local" && draft.mode === "model" ? (
                <LocalInferenceChoice
                  api={api}
                  policy={{
                    kind: "hosted_chat",
                    modelId,
                    maxOutputTokens: outputTokens,
                    temperature: draft.temperature ?? 0,
                    topP: draft.topP ?? 1,
                    ...(localRuntime ? { localRuntime } : {}),
                  }}
                  onChange={(policy) => {
                    if (policy.kind === "hosted_chat")
                      patch({
                        modelId: policy.modelId,
                        outputTokens: policy.maxOutputTokens,
                        localRuntime: policy.localRuntime,
                      });
                  }}
                />
              ) : null}
              {api.location === "local" && draft.mode === "model" ? (
                <ClaudeCodeChoice
                  api={api}
                  policy={{
                    kind: "hosted_chat",
                    modelId,
                    maxOutputTokens: outputTokens,
                    temperature: draft.temperature ?? 0,
                    topP: draft.topP ?? 1,
                    ...(localRuntime ? { localRuntime } : {}),
                  }}
                  onChange={(policy) => {
                    if (policy.kind === "hosted_chat")
                      patch({
                        modelId: policy.modelId,
                        outputTokens: policy.maxOutputTokens,
                        localRuntime: policy.localRuntime,
                        temperature: policy.temperature,
                        topP: policy.topP,
                      });
                  }}
                />
              ) : null}
              {api.actorId && !dispatch && !localRuntime ? (
                <TrainedVersionExperimentControl
                  connection={api.connection}
                  teamId={api.teamId}
                  actorId={api.actorId}
                  projectId={api.projectId}
                  configuration={
                    reviewConfiguration?.key === reviewKey
                      ? reviewConfiguration.configuration
                      : null
                  }
                  retainOperation={api.operation}
                  onBusyChange={setBusy}
                  onStarted={(id) => {
                    guard.allowNextNavigation();
                    setup.close();
                    navigate({
                      ...route,
                      page: "experiments",
                      resourceId: id,
                      detailTab: "overview",
                      executionLocation: "hosted",
                      executionKind: undefined,
                      passId: null,
                      after: null,
                      query: "",
                      revision: undefined,
                      contentHash: undefined,
                      datasetKind: undefined,
                    });
                  }}
                />
              ) : null}
              <ExperimentSourceControls
                api={api}
                draft={draft}
                patch={patch}
                sources={sources}
              />
              <EvaluationCard title="Experiment">
                <label>
                  Name
                  <input
                    value={name}
                    onChange={(event) => patch({ name: event.target.value })}
                    required
                  />
                </label>
              </EvaluationCard>
              <ExperimentAdvancedSettings
                draft={draft}
                patch={patch}
                supportsSampling={supportsSampling}
                profileSeeds={sources.profile?.seeds}
              />
            </>
          }
          graders={
            <>
              {" "}
              {population.data ? (
                <EvaluationCard title="Evaluation">
                  <DatasetSetupGraders
                    graders={population.data.graders}
                    onOpenGrader={(id) => {
                      guard.allowNextNavigation();
                      navigate({
                        ...route,
                        page: "graders",
                        resourceId: id,
                        datasetKind: undefined,
                        revision: undefined,
                        contentHash: undefined,
                        detailTab: "overview",
                        executionId: null,
                        passId: null,
                        after: null,
                      });
                    }}
                    selected={graders}
                    onChange={(value) => {
                      if (release)
                        patch({
                          graderChoices: {
                            ...draft.graderChoices,
                            [release.contentHash]: value,
                          },
                        });
                    }}
                  />
                </EvaluationCard>
              ) : null}
            </>
          }
        />
        {reviewed === reviewKey && !reviewIssue ? (
          <EvaluationCard title="Reviewed configuration">
            <p>
              {reviewCount} selected tasks /{" "}
              {(localDataset
                ? sampling.data?.models
                : models.data?.models
              )?.find((model) => model.id === modelId)?.name ??
                (modelId || "Choose model")}{" "}
              / ${budget} whole-run ceiling
            </p>
            <p>
              Graders:{" "}
              {canonicalGraders
                .map(
                  (selection) =>
                    population.data?.graders.find(
                      (grader) =>
                        grader.id === selection.id &&
                        grader.version === selection.version &&
                        grader.contentHash === selection.contentHash,
                    )?.name ?? "Grader name unavailable",
                )
                .join(", ") || "No graders selected"}
            </p>
            <p>
              Start creates a new immutable Experiment after server admission.
              The original remains unchanged.
            </p>
          </EvaluationCard>
        ) : null}
        <p>
          {api.location === "local"
            ? "Local execution on this Desktop. Dataset bytes and private grading remain in its server. "
            : ""}
          Review this Dataset version, selected tasks, target, graders, and
          whole Experiment budget before starting.
        </p>
        {reviewIssue ? <p role="status">{reviewIssue}</p> : null}
        {graderConflict ? <p role="alert">{graderConflict}</p> : null}
        {error ||
        population.error ||
        models.error ||
        sampling.error ||
        summary.error ? (
          <p role="alert">
            {error ??
              population.error?.message ??
              models.error?.message ??
              sampling.error?.message ??
              summary.error?.message}
          </p>
        ) : null}
        <ReviewedExperimentScheduleControl
          api={api}
          configuration={
            reviewConfiguration?.key === reviewKey
              ? reviewConfiguration.configuration
              : null
          }
        />
        <button
          className="training-button"
          type="submit"
          disabled={busy || Boolean(reviewIssue)}
        >
          {busy
            ? reviewed === reviewKey
              ? "Starting Experiment…"
              : "Reviewing Experiment…"
            : reviewed === reviewKey
              ? "Start experiment"
              : "Review experiment"}
        </button>
      </form>
      {guard.dialog}
    </WorkspacePanel>
  );
}
