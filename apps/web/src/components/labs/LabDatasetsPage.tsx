import { Fragment, useEffect, useMemo, useState } from "react";
import type { ChangeEvent } from "react";
import type {
  ChatModelRef,
  CreateImproveRun,
  Taskset,
  TasksetDraft,
  TrainingStateResponse,
  TasksetOperationalState,
  LearnedPreferenceRewardBinding,
} from "@openpond/contracts";

import type { ShowAppToast } from "../../app/app-state";
import type { useTraining } from "../../hooks/useTraining";
import { ArrowLeft, Search } from "../icons";
import {
  statusLabel,
  trainingMethodLabel,
} from "../training/training-model-data";
import { LabExpertBootstrap } from "./LabExpertBootstrap";
import { LabModelDataset } from "./LabModelDataset";
import { LabStatusBadge } from "./LabStatusBadge";
import { labModelDatasets } from "./lab-models";
import { labWorkproductProjection } from "./lab-workproducts";
import { ModelProjectPageHeader } from "./ModelProjectPageHeader";

const PAGE_SIZE = 10;
type TasksetListItem =
  | { kind: "draft"; value: TasksetDraft }
  | { kind: "taskset"; value: Taskset };
type DatasetDetailTab =
  | "overview"
  | "scenarios"
  | "runs"
  | "attempts"
  | "review"
  | "metrics"
  | "versions";
const DATASET_DETAIL_TABS: Array<{ id: DatasetDetailTab; label: string }> = [
  { id: "overview", label: "Overview" },
  { id: "scenarios", label: "Scenarios" },
  { id: "review", label: "Review" },
  { id: "metrics", label: "Metrics" },
];

export function LabDatasetsPage({
  state,
  runs,
  selectedId,
  onSelectedIdChange,
  onOpenDraft,
  defaultModel,
  onImproveInChat: _onImproveInChat,
  onTrainModel,
  onOpenFiles,
  training,
  onToast,
  modelProjectId,
}: {
  state: TrainingStateResponse | null;
  runs: CreateImproveRun[];
  selectedId: string | null;
  onSelectedIdChange: (tasksetId: string | null) => void;
  onOpenDraft: (draftId: string) => void;
  defaultModel: ChatModelRef;
  onImproveInChat: (taskset: Taskset) => void;
  onTrainModel: (
    tasksetId: string,
    learnedPreferenceReward?: LearnedPreferenceRewardBinding | null,
  ) => void;
  onOpenFiles: (tasksetId: string) => void;
  training: ReturnType<typeof useTraining>;
  onToast: ShowAppToast;
  modelProjectId?: string | null;
}) {
  const [query, setQuery] = useState("");
  const [page, setPage] = useState(1);
  const [detailTab, setDetailTab] = useState<DatasetDetailTab>("overview");
  const tasksets = state?.tasksets ?? [];
  const project = modelProjectId
    ? state?.modelProjects.find((candidate) => candidate.id === modelProjectId)
    : null;
  const selected =
    [...tasksets, ...(state?.modelTasksets ?? [])].find(
      (taskset) => taskset.id === selectedId,
    ) ?? null;
  const readOnly = Boolean(selected && selected.profileId !== state?.profileId);
  const selectedArtifact = selected?.datasetArtifact
    ? state?.datasetArtifacts.find(
        (artifact) =>
          artifact.tasksetId === selectedId
          && artifact.tasksetRevision === selected.revision,
      ) ?? null
    : null;
  const filtered = useMemo<TasksetListItem[]>(() => {
    const normalized = query.trim().toLowerCase();
    const attachedTasksetIds = new Set(
      project?.tasksetSyncs.map((sync) => sync.localTasksetId) ?? [],
    );
    return [
      ...(modelProjectId ? [] : (state?.tasksetDrafts ?? []))
        .filter((draft) => draft.status !== "published")
        .map((value) => ({ kind: "draft" as const, value })),
      ...tasksets
        .filter((value) => !modelProjectId || attachedTasksetIds.has(value.id))
        .map((value) => ({ kind: "taskset" as const, value })),
    ]
      .filter(({ value }) => !normalized || [value.name, value.objective, value.id]
        .some((candidate) => candidate.toLowerCase().includes(normalized)))
      .sort((left, right) => right.value.updatedAt.localeCompare(left.value.updatedAt));
  }, [modelProjectId, project?.tasksetSyncs, query, state?.tasksetDrafts, tasksets]);
  const visible = filtered.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);
  const modelCountByDataset = useMemo(() => {
    const counts = new Map<string, number>();
    if (!state || tasksets.length === 0) return counts;
    const models = labWorkproductProjection({
      profile: null,
      training: state,
      runs,
    }).filter((workproduct) => workproduct.kind === "model");
    for (const model of models) {
      for (const dataset of labModelDatasets(model, runs, state)) {
        counts.set(dataset.id, (counts.get(dataset.id) ?? 0) + 1);
      }
    }
    return counts;
  }, [runs, state, tasksets]);

  useEffect(() => {
    setDetailTab("overview");
  }, [selectedId]);

  if (selected) {
    const sync = project?.tasksetSyncs.find(
      (candidate) => candidate.localTasksetId === selected.id,
    );
    return (
      <div className="labs-flat-body labs-datasets-page">
        <div className="labs-dataset-detail-heading">
          <button
            aria-label="Back to Tasksets"
            className="labs-back-button"
            type="button"
            onClick={() => onSelectedIdChange(null)}
          >
            <ArrowLeft size={15} />
          </button>
          <div>
            <h1>{selected.name}</h1>
            <p>{selected.objective}</p>
          </div>
          <div className="labs-dataset-detail-actions">
            {modelProjectId && sync?.state !== "synced" ? (
              <button
                className="training-button secondary"
                disabled={
                  readOnly ||
                  training.busyAction === "publish-model-project-taskset"
                }
                type="button"
                onClick={async () => {
                  const published = await training.actions.publishModelProjectTaskset(
                    modelProjectId,
                    selected.id,
                  );
                  onToast(
                    published
                      ? `${selected.name} synced to the hosted Model Project.`
                      : "The Taskset release could not be published.",
                    published ? "success" : "error",
                  );
                }}
              >
                {training.busyAction === "publish-model-project-taskset"
                  ? "Syncing…"
                  : sync?.state === "sync_failed"
                    ? "Retry sync"
                    : "Sync hosted"}
              </button>
            ) : null}
            {modelProjectId ? (
              <LabStatusBadge
                label={
                  sync?.state === "synced"
                    ? "Synced"
                    : sync?.state === "syncing"
                      ? "Syncing"
                      : sync?.state === "sync_failed"
                        ? "Sync failed"
                        : "Local"
                }
                value={sync?.state === "synced" ? "available" : sync?.state ?? "local"}
              />
            ) : null}
            {readOnly ? (
              <LabStatusBadge
                label={`Profile: ${selected.profileId}`}
                value="available"
              />
            ) : null}
            <LabStatusBadge
              label={datasetStatus(selected)}
              value={selected.status}
            />
          </div>
        </div>
        <div
          className="training-detail-tabs"
          role="tablist"
          aria-label="Taskset detail"
        >
          {DATASET_DETAIL_TABS.map((tab) => (
            <button
              aria-selected={detailTab === tab.id}
              className={detailTab === tab.id ? "active" : undefined}
              key={tab.id}
              role="tab"
              type="button"
              onClick={() => setDetailTab(tab.id)}
            >
              {tab.label}
            </button>
          ))}
        </div>
        {detailTab === "runs" ? (
          <TasksetRuns
            modelProjectId={modelProjectId ?? null}
            readOnly={readOnly}
            state={state}
            taskset={selected}
            training={training}
            onCreateRun={(learnedPreferenceReward) =>
              onTrainModel(selected.id, learnedPreferenceReward)
            }
          />
        ) : detailTab === "attempts" ? (
          <TasksetAttempts taskset={selected} training={training} />
        ) : detailTab === "versions" ? (
          <TasksetVersions state={state} taskset={selected} />
        ) : (
        <>
            <LabModelDataset
              artifact={selectedArtifact}
              defaultModel={defaultModel}
              tab={detailTab}
              taskset={selected}
              onOpenFiles={() => onOpenFiles(selected.id)}
              onToast={onToast}
              training={training}
            />
            {detailTab === "metrics" &&
            selected.metadata.flagship === "cross-system-operations" ? (
              <LabExpertBootstrap
                busyAction={training.busyAction}
                taskset={selected}
                onApprove={(previewHash) =>
                  training.actions.approveExpertBootstrap(
                    selected.id,
                    previewHash,
                  )
                }
                onPreview={() =>
                  training.actions.previewExpertBootstrap(selected.id)
                }
                onToast={onToast}
              />
            ) : null}
        </>
        )}
      </div>
    );
  }

  return (
    <div className="labs-flat-body labs-datasets-page">
      {modelProjectId ? (
        <ModelProjectPageHeader
          title="Taskset"
          description="Scenarios, environment resources, graders, review protocol, and immutable releases."
          metrics={[
            { label: "Attached releases", value: project?.tasksetSyncs.length ?? 0 },
            { label: "Scenarios", value: filtered.reduce((total, item) => total + item.value.tasks.length, 0) },
            { label: "Graders", value: filtered.reduce((total, item) => total + ("graders" in item.value ? item.value.graders.length : 0), 0) },
          ]}
        />
      ) : null}
      <div className="labs-workproduct-toolbar">
        <label className="labs-search">
          <Search size={14} />
          <input
            aria-label="Search Tasksets"
            placeholder="Search Tasksets"
            value={query}
            onChange={(event) => {
              setQuery(event.target.value);
              setPage(1);
            }}
          />
        </label>
        <button
          className="training-button secondary labs-compact-button"
          disabled={training.loading}
          type="button"
          onClick={() => void training.refresh()}
        >
          {training.loading ? "Refreshing…" : "Refresh"}
        </button>
      </div>
      <div className="training-table-wrap">
        <table className="training-data-table labs-datasets-table">
          <thead>
            <tr>
              <th>Taskset</th>
              <th>Training</th>
              <th>Validation</th>
              <th>Frozen Eval</th>
              <th>Graders</th>
              {modelProjectId ? <th>Project</th> : null}
              <th>Activity</th>
              <th>Updated</th>
            </tr>
          </thead>
          <tbody>
            {visible.map((item) => {
              if (item.kind === "draft") {
                const draft = item.value;
                return (
                  <tr key={`draft:${draft.id}`}>
                    <td>
                      <button
                        className="labs-workproduct-link"
                        type="button"
                        onClick={() => onOpenDraft(draft.id)}
                      >
                        <strong>
                          {draft.name || "Untitled Taskset"}
                          <span className="labs-taskset-draft-badge">Draft</span>
                        </strong>
                        <span>{draft.objective || "Empty draft"}</span>
                      </button>
                    </td>
                    <td>{draftSplitCount(draft, "train")}</td>
                    <td>{draftSplitCount(draft, "validation")}</td>
                    <td>{draftSplitCount(draft, "frozen_eval")}</td>
                    <td>{draft.graders.length}</td>
                    {modelProjectId ? <td>Draft</td> : null}
                    <td>Resume draft</td>
                    <td>{formatCompactDate(draft.updatedAt)}</td>
                  </tr>
                );
              }
              const taskset = item.value;
              const modelCount = modelCountByDataset.get(taskset.id) ?? 0;
              const benchmarkRunCount = (state?.benchmarkRuns ?? []).filter(
                (run) => run.metadata.sourceTasksetId === taskset.id,
              ).length;
              const sync = project?.tasksetSyncs.find(
                (candidate) => candidate.localTasksetId === taskset.id,
              );
              return (
                <tr key={taskset.id}>
                  <td>
                    <button
                      className="labs-workproduct-link"
                      type="button"
                      onClick={() => onSelectedIdChange(taskset.id)}
                    >
                      <strong>{taskset.name}</strong>
                      <span>{taskset.objective}</span>
                    </button>
                  </td>
                  <td>{splitCount(taskset, state, "train")}</td>
                  <td>{splitCount(taskset, state, "validation")}</td>
                  <td>{splitCount(taskset, state, "frozen_eval")}</td>
                  <td>{taskset.graders.length}</td>
                  {modelProjectId ? (
                    <td>
                      {sync?.state === "synced"
                        ? "Attached"
                        : sync?.state === "syncing"
                          ? "Syncing"
                          : sync?.state === "sync_failed"
                            ? "Retry required"
                            : "Not attached"}
                    </td>
                  ) : null}
                  <td>
                    {taskset.purpose === "benchmark"
                      ? benchmarkRunCount
                        ? `${benchmarkRunCount} run${benchmarkRunCount === 1 ? "" : "s"}`
                        : "Not run"
                      : modelCount
                        ? `${modelCount} model${modelCount === 1 ? "" : "s"}`
                        : "—"}
                  </td>
                  <td>{formatCompactDate(taskset.updatedAt)}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      {!visible.length ? <div className="labs-table-empty">No Tasksets match this view.</div> : null}
      <DatasetPagination
        page={page}
        total={filtered.length}
        onChange={setPage}
      />
    </div>
  );
}

function TasksetRuns({
  modelProjectId,
  readOnly,
  state,
  taskset,
  training,
  onCreateRun,
}: {
  modelProjectId: string | null;
  readOnly: boolean;
  state: TrainingStateResponse | null;
  taskset: Taskset;
  training: ReturnType<typeof useTraining>;
  onCreateRun: (learnedPreferenceReward?: LearnedPreferenceRewardBinding | null) => void;
}) {
  const [bindingError, setBindingError] = useState<string | null>(null);
  const rewardModels = (state?.rewardModelVersions ?? [])
    .filter((version) => version.taskset.id === taskset.id && version.status === "available")
    .sort((left, right) => right.createdAt.localeCompare(left.createdAt));

  async function createLearnedRewardRun(rewardModelVersionId: string): Promise<void> {
    setBindingError(null);
    try {
      const binding = await training.actions.learnedPreferenceRewardBinding({
        tasksetId: taskset.id,
        rewardModelVersionId,
      });
      if (!binding) throw new Error("The qualified Reward Model binding could not be created.");
      onCreateRun(binding);
    } catch (error) {
      setBindingError(error instanceof Error ? error.message : String(error));
    }
  }

  return (
    <>
      <section className="labs-dataset-run-intro">
        <h2>Generate attempts or train from this Taskset</h2>
        <p>
          Choose a model and run type in the run builder. Collection, reward-model,
          and policy runs keep their own immutable inputs and receipts.
        </p>
        <button
          className="training-button"
          disabled={readOnly}
          type="button"
          onClick={() => onCreateRun()}
        >
          Create run
        </button>
      </section>
      <FixtureCollectionImporter
        actorKey={state?.profileId ?? taskset.profileId}
        disabled={readOnly || training.busyAction !== null}
        modelProjectId={modelProjectId}
        taskset={taskset}
        training={training}
      />
      {rewardModels.length ? (
        <section className="labs-dataset-run-intro">
          <h2>Learned reward policy run</h2>
          <p>
            Start GRPO with an immutable, qualified Reward Model binding. The
            policy updates; the Reward Model remains frozen.
          </p>
          {rewardModels.map((version) => (
            <button
              className="training-button secondary"
              disabled={readOnly || training.busyAction !== null}
              key={version.id}
              onClick={() => void createLearnedRewardRun(version.id)}
              type="button"
            >
              Create GRPO run with {version.id}
            </button>
          ))}
          {bindingError ? <p className="training-banner error" role="alert">{bindingError}</p> : null}
        </section>
      ) : null}
      <TasksetHistory
        onCreateLearnedRewardRun={createLearnedRewardRun}
        readOnly={readOnly || training.busyAction !== null}
        state={state}
        taskset={taskset}
        training={training}
      />
    </>
  );
}

function FixtureCollectionImporter({
  actorKey,
  disabled,
  modelProjectId,
  taskset,
  training,
}: {
  actorKey: string;
  disabled: boolean;
  modelProjectId: string | null;
  taskset: Taskset;
  training: ReturnType<typeof useTraining>;
}) {
  const [message, setMessage] = useState<string | null>(null);
  const [datasets, setDatasets] = useState<Array<{
    id: string;
    contentHash: string;
    authority: "human" | "synthetic_fixture";
    qualificationEligibility: "smoke_only" | "human_heldout";
    groupCount: number;
    pairCount: number;
    partitions: string[];
  }>>([]);
  const [prepared, setPrepared] = useState<{
    collection: unknown;
    fileName: string;
    runId: string;
    groupCount: number;
    attemptCount: number;
    distinctOutputCount: number;
    partitions: string[];
  } | null>(null);
  const [collectionState, setCollectionState] = useState<"idle" | "ready" | "running" | "failed" | "completed">("idle");

  useEffect(() => {
    let active = true;
    void training.actions.listPreferenceDatasets(taskset.id).then((released) => {
      if (!active || !released) return;
      setDatasets(released.map((dataset) => ({
        id: dataset.id,
        contentHash: dataset.contentHash,
        authority: dataset.authority,
        qualificationEligibility: dataset.qualificationEligibility,
        groupCount: dataset.groups.length,
        pairCount: dataset.derivedPairs.length,
        partitions: [...new Set(dataset.groups.map((group) => group.partition))],
      })));
    });
    return () => { active = false; };
  }, [taskset.id, training.actions]);

  async function prepareFixture(event: ChangeEvent<HTMLInputElement>): Promise<void> {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    try {
      const collection = JSON.parse(await file.text()) as unknown;
      const summary = inspectCollectionManifest(collection);
      setPrepared({ collection, fileName: file.name, ...summary });
      setCollectionState("ready");
      setMessage(`Preflight passed for ${summary.groupCount} groups and ${summary.attemptCount} globally unique Attempts.`);
    } catch (error) {
      setPrepared(null);
      setCollectionState("failed");
      setMessage(error instanceof Error ? error.message : String(error));
    }
  }

  async function launchCollection(): Promise<void> {
    if (!prepared) return;
    setCollectionState("running");
    setMessage("Recording immutable Attempts, grading fixture evidence, and materializing D0…");
    try {
      const result = await training.actions.materializeSyntheticPreferenceCollection({
        tasksetId: taskset.id,
        actorKey,
        preferenceDatasetId: `fixture-preference-${crypto.randomUUID()}`,
        preferenceDatasetRevision: 1,
        collection: prepared.collection,
      });
      if (result) {
        setDatasets((current) => [
          {
            id: result.dataset.id,
            contentHash: result.dataset.contentHash,
            authority: result.dataset.authority,
            qualificationEligibility: result.dataset.qualificationEligibility,
            groupCount: result.dataset.groups.length,
            pairCount: result.dataset.derivedPairs.length,
            partitions: [...new Set(result.dataset.groups.map((group) => group.partition))],
          },
          ...current.filter((dataset) => dataset.id !== result.dataset.id),
        ]);
        setCollectionState("completed");
        setMessage(`Recorded ${result.collection.attempts.length} fixture Attempts and released ${result.dataset.groups.length} preference groups. Fixture evidence is smoke-only.`);
      } else {
        setCollectionState("failed");
        setMessage("Collection Run did not return a receipt. No completion was recorded.");
      }
    } catch (error) {
      setCollectionState("failed");
      setMessage(error instanceof Error ? error.message : String(error));
    }
  }

  async function launchSmokeRewardModel(dataset: { id: string; contentHash: string }): Promise<void> {
    try {
      if (!modelProjectId) throw new Error("Select a Model Project before launching a managed Reward Model Run.");
      const run = await training.actions.launchRewardModelRun({
        tasksetId: taskset.id,
        modelProjectId,
        rewardModelId: `reward-model-${taskset.id}-smoke`,
        preferenceDatasetReleaseId: dataset.id,
      });
      setMessage(run
        ? `Reward Model Run ${run.id} is ${run.status}. It is fixture-only and capped at $2.`
        : "Reward Model launch could not be started.");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
    }
  }

  return (
    <details className="labs-dataset-advanced-details">
      <summary>Fixture collection run</summary>
      <p className="labs-detail-copy">
        Prepare and validate a bounded collection manifest before recording it.
        This fixture path is for system verification only and never counts as
        human preference data.
      </p>
      <label className="training-file-label">
        <span>Collection manifest JSON</span>
        <input
          accept="application/json,.json"
          disabled={disabled}
          onChange={(event) => void prepareFixture(event)}
          type="file"
        />
      </label>
      {prepared ? (
        <section className="labs-dataset-run-intro" aria-label="Collection run preflight">
          <h3>{prepared.fileName}</h3>
          <dl className="training-configuration-list">
            <div><dt>Run</dt><dd><code>{prepared.runId}</code></dd></div>
            <div><dt>Groups</dt><dd>{prepared.groupCount} / 16 maximum</dd></div>
            <div><dt>Attempts</dt><dd>{prepared.attemptCount}</dd></div>
            <div><dt>Unique outputs</dt><dd>{prepared.distinctOutputCount} / {prepared.attemptCount}</dd></div>
            <div><dt>Partitions</dt><dd>{prepared.partitions.join(", ")}</dd></div>
            <div><dt>Progress</dt><dd>{collectionState === "completed" ? "100%" : collectionState === "running" ? "Recording…" : "Ready"}</dd></div>
          </dl>
          <div className="labs-dataset-advanced-action">
            <button className="training-button" disabled={disabled || collectionState === "running" || collectionState === "completed"} onClick={() => void launchCollection()} type="button">
              {collectionState === "failed" ? "Retry collection" : "Run collection"}
            </button>
            <button className="training-button secondary" disabled={collectionState === "running"} onClick={() => { setPrepared(null); setCollectionState("idle"); setMessage(collectionState === "completed" ? "Collection details closed." : "Collection preparation cancelled. No Attempts were written."); }} type="button">
              {collectionState === "completed" ? "Close" : "Cancel"}
            </button>
          </div>
        </section>
      ) : null}
      {datasets.map((dataset) => (
        <section className="labs-dataset-run-intro" key={dataset.id}>
          <h3><code>{dataset.id}</code></h3>
          <dl className="training-configuration-list">
            <div><dt>Authority</dt><dd>{statusLabel(dataset.authority)}</dd></div>
            <div><dt>Eligibility</dt><dd>{statusLabel(dataset.qualificationEligibility)}</dd></div>
            <div><dt>Partitions</dt><dd>{dataset.partitions.map(statusLabel).join(", ")}</dd></div>
            <div><dt>Groups / pairs</dt><dd>{dataset.groupCount} / {dataset.pairCount}</dd></div>
            <div><dt>Content hash</dt><dd><code>{dataset.contentHash}</code></dd></div>
          </dl>
          <button
            className="training-button secondary"
            disabled={disabled}
            onClick={() => void launchSmokeRewardModel(dataset)}
            type="button"
          >
            Launch $2 reward smoke
          </button>
        </section>
      ))}
      {message ? <p className="labs-detail-copy" role="status">{message}</p> : null}
    </details>
  );
}

export function inspectCollectionManifest(value: unknown): {
  runId: string;
  groupCount: number;
  attemptCount: number;
  distinctOutputCount: number;
  partitions: string[];
} {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Collection manifest must be a JSON object.");
  const record = value as Record<string, unknown>;
  if (record.schemaVersion !== "openpond.syntheticCollectionRun.v1") throw new Error("Collection manifest must use openpond.syntheticCollectionRun.v1.");
  if (typeof record.id !== "string" || !record.id.trim()) throw new Error("Collection manifest needs a stable Run ID.");
  if (!Array.isArray(record.groups) || record.groups.length < 2 || record.groups.length > 16) throw new Error("Collection Runs require 2–16 groups.");
  const candidateIds = new Set<string>();
  const outputs = new Set<string>();
  const partitions = new Set<string>();
  for (const [groupIndex, rawGroup] of record.groups.entries()) {
    if (!rawGroup || typeof rawGroup !== "object" || Array.isArray(rawGroup)) throw new Error(`Group ${groupIndex + 1} is invalid.`);
    const group = rawGroup as Record<string, unknown>;
    if (group.partition !== "reward_train" && group.partition !== "reward_validation") throw new Error(`Group ${groupIndex + 1} needs a reward_train or reward_validation partition.`);
    partitions.add(group.partition);
    if (!Array.isArray(group.candidates) || group.candidates.length !== 4) throw new Error(`Group ${groupIndex + 1} must contain exactly four candidates.`);
    const labels = new Set<string>();
    for (const rawCandidate of group.candidates) {
      if (!rawCandidate || typeof rawCandidate !== "object" || Array.isArray(rawCandidate)) throw new Error(`Group ${groupIndex + 1} contains an invalid candidate.`);
      const candidate = rawCandidate as Record<string, unknown>;
      if (typeof candidate.id !== "string" || !candidate.id.trim()) throw new Error(`Group ${groupIndex + 1} contains a candidate without an ID.`);
      if (typeof candidate.output !== "string" || !candidate.output.trim()) throw new Error(`Candidate ${candidate.id} needs structured output text.`);
      if (candidateIds.has(candidate.id) || outputs.has(candidate.output)) throw new Error("Candidate IDs and outputs must be globally unique within a Collection Run.");
      if (candidate.label !== "love" && candidate.label !== "like" && candidate.label !== "reject") throw new Error(`Candidate ${candidate.id} needs a Love, Like, or Reject fixture label.`);
      candidateIds.add(candidate.id);
      outputs.add(candidate.output);
      labels.add(candidate.label);
    }
    if (labels.size < 2) throw new Error(`Group ${groupIndex + 1} needs at least two preference levels.`);
  }
  return { runId: record.id, groupCount: record.groups.length, attemptCount: candidateIds.size, distinctOutputCount: outputs.size, partitions: [...partitions] };
}

function TasksetAttempts({
  taskset,
  training,
}: {
  taskset: Taskset;
  training: ReturnType<typeof useTraining>;
}) {
  const [operations, setOperations] = useState<TasksetOperationalState | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selectedAttemptId, setSelectedAttemptId] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    setLoading(true);
    setError(null);
    void training.actions.tasksetOperationalState(taskset.id)
      .then((next) => {
        if (active) setOperations(next);
      })
      .catch((caught) => {
        if (active) setError(caught instanceof Error ? caught.message : String(caught));
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => { active = false; };
  }, [taskset.id, training.actions]);

  if (loading) return <div className="labs-table-empty">Loading Attempts…</div>;
  if (error) return <div className="training-banner error" role="alert">{error}</div>;
  if (!operations?.attempts.length) {
    return <div className="labs-table-empty">No Attempts have been recorded for this Taskset.</div>;
  }
  const artifactsByAttempt = new Map<string, TasksetOperationalState["artifacts"]>();
  for (const artifact of operations.artifacts) {
    const current = artifactsByAttempt.get(artifact.attemptId) ?? [];
    current.push(artifact);
    artifactsByAttempt.set(artifact.attemptId, current);
  }
  const gradeByAttempt = new Map(operations.grades.map((grade) => [grade.attemptId, grade]));
  const distinctOutputs = new Set(operations.attempts.map((attempt) => JSON.stringify(attempt.output))).size;
  return (
    <>
    <p className="labs-detail-copy">
      {operations.attempts.length} Attempts · {distinctOutputs} distinct outputs · {operations.artifacts.length} artifacts
    </p>
    <div className="training-table-wrap">
      <table className="training-data-table">
        <thead>
          <tr>
            <th>Attempt</th>
            <th>Scenario</th>
            <th>Status</th>
            <th>Evidence</th>
            <th>Reward</th>
            <th>Artifacts</th>
          </tr>
        </thead>
        <tbody>
          {operations.attempts.map((attempt) => {
            const grade = gradeByAttempt.get(attempt.id);
            const artifacts = artifactsByAttempt.get(attempt.id) ?? [];
            const expanded = selectedAttemptId === attempt.id;
            return (
              <Fragment key={attempt.id}>
                <tr>
                  <td>
                    <button
                      aria-expanded={expanded}
                      className="labs-workproduct-link"
                      type="button"
                      onClick={() => setSelectedAttemptId(expanded ? null : attempt.id)}
                    >
                      <code>{attempt.id}</code>
                    </button>
                  </td>
                  <td>{attempt.taskId}</td>
                  <td>{attempt.infrastructureError ? "Infrastructure error" : "Completed"}</td>
                  <td>{attemptEvidenceLabel(attempt)}</td>
                  <td>{grade?.score == null ? "—" : grade.score.toFixed(3)}</td>
                  <td>{artifacts.length}</td>
                </tr>
                {expanded ? (
                  <tr className="labs-attempt-detail-row">
                    <td colSpan={6}>
                      <dl className="training-configuration-list">
                        <div><dt>Split</dt><dd>{attempt.split}</dd></div>
                        <div><dt>Seed</dt><dd>{attempt.seed}</dd></div>
                        <div><dt>Latency</dt><dd>{attempt.latencyMs} ms</dd></div>
                        <div><dt>Cost</dt><dd>{attempt.costUsd == null ? "—" : `$${attempt.costUsd.toFixed(4)}`}</dd></div>
                        <div><dt>Reward eligible</dt><dd>{grade ? (grade.rewardEligible ? "Yes" : "No") : "Not graded"}</dd></div>
                        <div><dt>Grade</dt><dd>{grade ? (grade.passed ? "Passed" : "Failed") : "Not graded"}</dd></div>
                      </dl>
                      <h3>Structured output</h3>
                      <pre>{JSON.stringify(attempt.output, null, 2)}</pre>
                      {grade?.components.length ? (
                        <>
                          <h3>Grader evidence</h3>
                          <div className="training-table-wrap">
                            <table className="training-data-table">
                              <thead><tr><th>Grader</th><th>Score</th><th>Gate</th><th>Feedback</th></tr></thead>
                              <tbody>{grade.components.map((component) => (
                                <tr key={`${attempt.id}:${component.graderId}`}>
                                  <td>{component.graderId}</td>
                                  <td>{component.score.toFixed(3)}</td>
                                  <td>{component.hardGate ? (component.passed ? "Passed" : "Failed") : "Advisory"}</td>
                                  <td>{component.feedback ?? "—"}</td>
                                </tr>
                              ))}</tbody>
                            </table>
                          </div>
                        </>
                      ) : null}
                      {artifacts.length ? (
                        <>
                          <h3>Artifacts</h3>
                          <ul>
                            {artifacts.map((artifact) => (
                              <li key={artifact.id}>
                                <code>{artifact.path}</code> · {artifact.mediaType ?? artifact.kind} · {artifact.sizeBytes.toLocaleString()} bytes
                              </li>
                            ))}
                          </ul>
                        </>
                      ) : null}
                    </td>
                  </tr>
                ) : null}
              </Fragment>
            );
          })}
        </tbody>
      </table>
    </div>
    </>
  );
}

function attemptEvidenceLabel(attempt: TasksetOperationalState["attempts"][number]): string {
  const metadata = attempt.metadata;
  if (metadata.execution === "synthetic_collection_fixture") {
    const label = typeof metadata.fixtureLabel === "string"
      ? metadata.fixtureLabel.replace(/^./, (value) => value.toUpperCase())
      : "Unlabeled";
    const group = typeof metadata.collectionGroupIndex === "number"
      ? `group ${metadata.collectionGroupIndex + 1}`
      : "fixture group";
    return `Fixture · ${group} · ${label}`;
  }
  return attempt.modelRef ? "Model attempt" : "Recorded attempt";
}

function TasksetVersions({
  state,
  taskset,
}: {
  state: TrainingStateResponse | null;
  taskset: Taskset;
}) {
  const policyVersions = (state?.modelVersions ?? [])
    .filter((version) => version.taskset.id === taskset.id)
    .sort((left, right) => right.createdAt.localeCompare(left.createdAt));
  const rewardVersions = (state?.rewardModelVersions ?? [])
    .filter((version) => version.taskset.id === taskset.id)
    .sort((left, right) => right.createdAt.localeCompare(left.createdAt));
  return (
    <>
      <section className="labs-dataset-run-intro">
        <h2>Taskset revision</h2>
        <dl className="labs-inline-facts">
          <div><dt>Revision</dt><dd>{taskset.revision}</dd></div>
          <div><dt>Content hash</dt><dd><code>{taskset.contentHash}</code></dd></div>
          <div><dt>Updated</dt><dd>{formatCompactDate(taskset.updatedAt)}</dd></div>
        </dl>
        <p>Runs pin this immutable revision. Editing starts a new draft and publishes a new revision.</p>
      </section>
      <section className="labs-dataset-run-intro">
        <h2>Model outputs from runs</h2>
        <p>Policy and Reward Model versions are created by successful Runs. They are not assigned to the Taskset itself.</p>
        {policyVersions.length || rewardVersions.length ? (
          <div className="training-table-wrap">
            <table className="training-data-table">
              <thead><tr><th>Version</th><th>Role</th><th>Status</th><th>Scope</th><th>Created</th></tr></thead>
              <tbody>
                {rewardVersions.map((version) => (
                  <tr key={version.id}>
                    <td><code>{version.id}</code></td>
                    <td>Reward</td>
                    <td>{statusLabel(version.status)}</td>
                    <td>{statusLabel(version.scope)}</td>
                    <td>{formatCompactDate(version.createdAt)}</td>
                  </tr>
                ))}
                {policyVersions.map((version) => (
                  <tr key={version.id}>
                    <td><code>{version.id}</code></td>
                    <td>Policy</td>
                    <td>{statusLabel(version.status)}</td>
                    <td>{statusLabel(version.kind)}</td>
                    <td>{formatCompactDate(version.createdAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : <p className="labs-detail-copy">No Model versions have been produced from this Taskset yet.</p>}
      </section>
    </>
  );
}

function TasksetHistory({
  onCreateLearnedRewardRun,
  readOnly,
  state,
  taskset,
  training,
}: {
  onCreateLearnedRewardRun: (rewardModelVersionId: string) => Promise<void>;
  readOnly: boolean;
  state: TrainingStateResponse | null;
  taskset: Taskset;
  training: ReturnType<typeof useTraining>;
}) {
  const [showAll, setShowAll] = useState(false);
  const [selectedRewardRunId, setSelectedRewardRunId] = useState<string | null>(null);
  const [rewardActionMessage, setRewardActionMessage] = useState<string | null>(null);
  const runs = (state?.modelRuns ?? [])
    .filter((run) => run.taskset.id === taskset.id)
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
  const visibleRuns = showAll ? runs : runs.slice(0, 10);
  const rewardRuns = (state?.rewardModelRuns ?? [])
    .filter((run) => run.taskset.id === taskset.id)
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
  const modelNames = new Map(
    (state?.modelProjects ?? []).map((project) => [project.id, project.name]),
  );
  if (taskset.purpose === "benchmark") {
    const evaluationRuns = runs.filter((run) => run.kind === "evaluation");
    if (!evaluationRuns.length) {
      return (
        <div className="labs-table-empty">
          This benchmark has not been run yet.
        </div>
      );
    }
    return (
      <div className="training-table-wrap">
        <table className="training-data-table">
          <thead>
            <tr>
              <th>Model</th>
              <th>Status</th>
              <th>Quality</th>
              <th>Token delta</th>
              <th>Mode</th>
              <th>Updated</th>
            </tr>
          </thead>
          <tbody>
            {evaluationRuns.map((run) => {
              const receipt = run.receipt?.schemaVersion
                === "openpond.modelEvaluationReceipt.v1"
                ? run.receipt
                : null;
              const stopReceipt = run.receipt?.schemaVersion
                === "openpond.modelEvaluationStopReceipt.v1"
                ? run.receipt
                : null;
              const delta = receipt?.foregroundTokenDelta ?? null;
              return (
                <tr key={run.id}>
                  <td>{modelNames.get(run.modelId) ?? run.modelId}</td>
                  <td>{stopReceipt ? "inconclusive" : run.status}</td>
                  <td>
                    {receipt
                      ? `${Math.round(receipt.quality.candidatePassRate * 100)}% candidate`
                      : stopReceipt
                        ? "Candidate skipped"
                      : "Pending"}
                  </td>
                  <td>
                    {delta === null
                      ? "—"
                      : `${delta > 0 ? "+" : ""}${delta.toLocaleString()}`}
                  </td>
                  <td>
                    {run.evaluation
                      ? `${run.evaluation.attemptPlan.reduce((sum, stage) => sum + stage.attemptCount, 0)} attempts`
                      : "—"}
                  </td>
                  <td>{formatCompactDate(run.updatedAt)}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    );
  }

  if (!runs.length && !rewardRuns.length) {
    return (
      <div className="labs-table-empty">
        This Taskset has not been used in a submitted run yet.
      </div>
    );
  }

  return (
    <>
      {rewardRuns.length ? (
        <div className="training-table-wrap">
          <table className="training-data-table">
            <thead>
              <tr><th>Reward Model Run</th><th>Scope</th><th>Progress</th><th>Loss</th><th>Status</th><th>Spend</th></tr>
            </thead>
            <tbody>
              {rewardRuns.map((run) => {
                const expanded = selectedRewardRunId === run.id;
                return (
                  <Fragment key={run.id}>
                    <tr>
                      <td>
                        <button className="labs-workproduct-link" aria-expanded={expanded} onClick={() => setSelectedRewardRunId(expanded ? null : run.id)} type="button">
                          <code>{run.id}</code>
                        </button>
                      </td>
                      <td>{statusLabel(run.scope)}</td>
                      <td>{run.progress.completedSteps}/{run.progress.totalSteps}</td>
                      <td>{run.progress.latestLoss?.toFixed(4) ?? "—"}</td>
                      <td><LabStatusBadge label={statusLabel(run.status)} value={run.status} /></td>
                      <td>{run.accruedSpendUsd == null ? "—" : `$${run.accruedSpendUsd.toFixed(2)}`}</td>
                    </tr>
                    {expanded ? (
                      <tr className="labs-attempt-detail-row">
                        <td colSpan={6}>
                          <dl className="training-configuration-list">
                            <div><dt>Dataset</dt><dd><code>{run.preferenceDatasetRelease.id}</code></dd></div>
                            <div><dt>Recipe</dt><dd><code>{run.recipeRelease.id}</code></dd></div>
                            <div><dt>Managed Run</dt><dd>{run.managedRunId ? <code>{run.managedRunId}</code> : "Not launched"}</dd></div>
                            <div><dt>Maximum spend</dt><dd>${run.quote.maximumSpendUsd.toFixed(2)}</dd></div>
                            <div><dt>Failure owner</dt><dd>{run.failureOwner ? statusLabel(run.failureOwner) : "—"}</dd></div>
                            <div><dt>Cleanup</dt><dd>{run.receipt ? (run.receipt.cleanup.computeReleased && run.receipt.cleanup.providerTerminalObserved ? "Verified" : "Incomplete") : "Pending"}</dd></div>
                            <div><dt>Checkpoint</dt><dd>{run.receipt ? <code>{run.receipt.finalCheckpoint.contentHash}</code> : "Pending"}</dd></div>
                            <div><dt>Qualification</dt><dd>{run.qualificationReport ? <code>{run.qualificationReport.id}</code> : "Pending"}</dd></div>
                          </dl>
                          {run.failure ? <p className="training-banner error" role="alert">{run.failure}</p> : null}
                          <div className="labs-dataset-advanced-action">
                            {run.status === "succeeded" && run.rewardModelVersionId ? (
                              <button className="training-button" disabled={readOnly} onClick={() => void onCreateLearnedRewardRun(run.rewardModelVersionId!)} type="button">
                                Create GRPO run with this frozen reward
                              </button>
                            ) : null}
                            {run.status === "failed" && run.failureOwner === "qualification" ? (
                              <button className="training-button secondary" disabled={readOnly} onClick={() => void training.actions.retryRewardModelQualification({ runId: run.id, id: `${run.id}-qualification-${crypto.randomUUID()}` }).then((result) => setRewardActionMessage(result ? "Qualification retry recorded." : "Qualification retry did not start.")).catch((error) => setRewardActionMessage(error instanceof Error ? error.message : String(error)))} type="button">
                                Retry qualification
                              </button>
                            ) : null}
                            {run.status === "running" ? (
                              <button className="training-button secondary" disabled={readOnly} onClick={() => void training.actions.cancelRewardModelRun(run.id).then((result) => setRewardActionMessage(result ? "Cancellation requested. Cleanup remains visible until the managed Run is terminal." : "Cancellation request did not complete.")).catch((error) => setRewardActionMessage(error instanceof Error ? error.message : String(error)))} type="button">
                                Cancel run
                              </button>
                            ) : null}
                          </div>
                          {rewardActionMessage ? <p className="labs-detail-copy" role="status">{rewardActionMessage}</p> : null}
                        </td>
                      </tr>
                    ) : null}
                  </Fragment>
                );
              })}
            </tbody>
          </table>
        </div>
      ) : null}
      {runs.length ? (
      <div className="training-table-wrap">
        <table className="training-data-table">
          <thead>
            <tr>
              <th>Model</th>
              <th>Run</th>
              <th>Method</th>
              <th>Status</th>
              <th>Updated</th>
            </tr>
          </thead>
          <tbody>
            {visibleRuns.map((run) => (
              <tr key={run.id}>
                <td>{modelNames.get(run.modelId) ?? run.modelId}</td>
                <td>{statusLabel(run.kind)}</td>
                <td>{trainingMethodLabel(run.method)}</td>
                <td>
                  <LabStatusBadge
                    label={statusLabel(run.status)}
                    value={run.status}
                  />
                </td>
                <td>{formatCompactDate(run.updatedAt)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      ) : null}
      {runs.length > 10 ? (
        <div className="labs-model-run-list-actions">
          <button
            className="training-button secondary labs-compact-button"
            type="button"
            onClick={() => setShowAll((visible) => !visible)}
          >
            {showAll ? "Show latest 10" : `Show all ${runs.length} runs`}
          </button>
        </div>
      ) : null}
    </>
  );
}

function splitCount(
  taskset: Taskset,
  state: TrainingStateResponse | null,
  split: Taskset["tasks"][number]["split"],
): number {
  const artifact = taskset.datasetArtifact
    ? state?.datasetArtifacts.find(
        (candidate) =>
          candidate.tasksetId === taskset.id
          && candidate.tasksetRevision === taskset.revision,
      )
    : null;
  if (artifact) return artifact.splitCounts[split] ?? 0;
  return taskset.tasks.filter((task) => task.split === split).length;
}

function draftSplitCount(
  draft: TasksetDraft,
  split: TasksetDraft["tasks"][number]["split"],
): number {
  return draft.tasks.filter((task) => task.split === split).length;
}

function datasetStatus(taskset: Taskset): string {
  if (taskset.readiness?.ready) return "Ready";
  if (taskset.status === "ready") return "Needs Evals";
  return taskset.status.replaceAll("_", " ").replace(/^./, (value) => value.toUpperCase());
}

function formatCompactDate(value: string): string {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return "—";
  return date.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}


function DatasetPagination({
  page,
  total,
  onChange,
}: {
  page: number;
  total: number;
  onChange: (page: number) => void;
}) {
  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  if (pages === 1) return null;
  return (
    <nav className="labs-pagination" aria-label="Taskset pages">
      <button type="button" disabled={page <= 1} onClick={() => onChange(page - 1)}>Previous</button>
      <span>{page} of {pages}</span>
      <button type="button" disabled={page >= pages} onClick={() => onChange(page + 1)}>Next</button>
    </nav>
  );
}
