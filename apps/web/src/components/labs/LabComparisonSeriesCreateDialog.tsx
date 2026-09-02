import { useMemo, useState, type FormEvent } from "react";
import type {
  ModelComparisonScheduleEntry,
  ModelComparisonSeries,
  ModelProject,
  Taskset,
  TrainingStateResponse,
} from "@openpond/contracts";
import { contentHash } from "@openpond/harness";

import { AppDialog } from "../dialogs/AppDialog";
import { X } from "../icons";

type SeriesTemplate = {
  seedRank: number;
  dailyRanks: number[];
  weeklyRank: number;
  fullRefreshRank: number;
};

const DEFAULT_TEMPLATE: SeriesTemplate = {
  seedRank: 16,
  dailyRanks: [1, 2, 3, 2, 1, 2],
  weeklyRank: 11,
  fullRefreshRank: 27,
};

export function LabComparisonSeriesCreateDialog({
  busy,
  onClose,
  onCreate,
  profileId,
  state,
}: {
  busy: boolean;
  onClose: () => void;
  onCreate: (series: ModelComparisonSeries) => Promise<boolean>;
  profileId: string;
  state: TrainingStateResponse;
}) {
  const projects = useMemo(() => state.modelProjects.filter(seriesReadyProject), [state.modelProjects]);
  const tasksets = useMemo(() => uniqueTasksets(state), [state]);
  const [projectId, setProjectId] = useState(projects[0]?.id ?? "");
  const project = projects.find((candidate) => candidate.id === projectId) ?? null;
  const [name, setName] = useState("Continual Support");
  const [objective, setObjective] = useState("Improve the selected Model through bounded, inspectable continual-learning releases.");
  const [seedId, setSeedId] = useState("");
  const [eligibleId, setEligibleId] = useState("");
  const [developmentId, setDevelopmentId] = useState("");
  const [retainedId, setRetainedId] = useState("");
  const [frozenId, setFrozenId] = useState("");
  const [dailyRanksText, setDailyRanksText] = useState(DEFAULT_TEMPLATE.dailyRanks.join(", "));
  const [seedRank, setSeedRank] = useState(DEFAULT_TEMPLATE.seedRank);
  const [weeklyRank, setWeeklyRank] = useState(DEFAULT_TEMPLATE.weeklyRank);
  const [fullRefreshRank, setFullRefreshRank] = useState(DEFAULT_TEMPLATE.fullRefreshRank);
  const [envelopeRank, setEnvelopeRank] = useState(32);
  const [acquisitionTolerance, setAcquisitionTolerance] = useState(0.05);
  const [retentionTolerance, setRetentionTolerance] = useState(0.02);
  const [error, setError] = useState<string | null>(null);
  const dailyRanks = parseRanks(dailyRanksText);
  const maximumEnabledRank = Math.max(
    seedRank + dailyRanks.reduce((sum, rank) => sum + rank, 0),
    seedRank + weeklyRank,
    fullRefreshRank,
  );

  async function submit(event: FormEvent) {
    event.preventDefault();
    setError(null);
    if (!project || !dailyRanks.length) {
      setError("Select a configured Model Project and provide at least one daily rank.");
      return;
    }
    const selected = [seedId, eligibleId, developmentId, retainedId, frozenId]
      .map((id) => tasksets.find((taskset) => tasksetKey(taskset) === id) ?? null);
    if (selected.some((taskset) => !taskset)) {
      setError("Select exact seed, eligible, development, retained, and frozen Tasksets.");
      return;
    }
    if (!hasSplit(selected[0]!, "train") || !hasSplit(selected[1]!, "train")) {
      setError("The seed and eligible-pool releases must contain training tasks.");
      return;
    }
    if (!hasSplit(selected[2]!, "validation") || !hasSplit(selected[3]!, "validation")) {
      setError("The development and retained releases must contain validation tasks.");
      return;
    }
    if (!hasSplit(selected[4]!, "frozen_eval")) {
      setError("The frozen-final release must contain frozen-evaluation tasks.");
      return;
    }
    if (maximumEnabledRank > envelopeRank) {
      setError(`The largest branch needs rank ${maximumEnabledRank}, above the rank-${envelopeRank} envelope.`);
      return;
    }
    const recipe = project.trainingSetup.recipe;
    const baseModel = project.trainingSetup.baseModel;
    const reward = recipeReward(recipe);
    if (!recipe || !baseModel?.revision || !reward) return;
    const grader = selected[0]!.graders.find((candidate) => candidate.id === reward.graderId);
    if (!grader) {
      setError("The seed Taskset does not contain the Model Project's configured reward grader.");
      return;
    }
    const seriesId = `comparison_series_${crypto.randomUUID()}`;
    const schedule = comparisonSchedule(seriesId, {
      seedRank,
      dailyRanks,
      weeklyRank,
      fullRefreshRank,
    });
    const now = new Date().toISOString();
    const series: ModelComparisonSeries = {
      schemaVersion: "openpond.modelComparisonSeries.v1",
      id: seriesId,
      profileId,
      modelProjectId: project.id,
      name: name.trim(),
      objective: objective.trim(),
      status: "draft",
      revision: 1,
      productionBinding: { role: "chat_manual", roleTargetId: project.id },
      baseModel: { id: baseModel.modelId, revision: baseModel.revision },
      seedTaskset: exactRef(selected[0]!),
      eligibleTaskPool: exactRef(selected[1]!),
      evaluationTasksets: {
        development: exactRef(selected[2]!),
        retained: exactRef(selected[3]!),
        frozenFinal: exactRef(selected[4]!),
      },
      grader: { id: reward.graderId, contentHash: contentHash(grader) },
      benchmarkProtocol: null,
      automaticEvaluation: { enabled: false },
      residualProfile: {
        profileId: `${project.id}-uniform-residual-v1`,
        serializedEnvelopeRank: envelopeRank,
        maximumEnabledRank,
        topology: "uniform_block_masked",
      },
      schedule,
      scheduleSealedAt: null,
      advancementPolicy: {
        id: `${seriesId}-advancement-v1`,
        version: 1,
        requireCheckpoint: true,
        requireAppliedOptimizerUpdate: true,
        minimumCurrentCohortMeanImprovement: acquisitionTolerance,
        maximumRetainedMeanRegression: retentionTolerance,
        blockCriticalInvariantRegression: true,
        automaticDailyAdvancement: true,
      },
      executionPolicy: { startWhenReady: false },
      acceptedSeedEntryId: null,
      acceptedDailyHeadEntryId: null,
      promotedBindingId: null,
      createdBy: profileId,
      createdAt: now,
      updatedAt: now,
    };
    if (await onCreate(series)) onClose();
    else setError("OpenPond could not save the Comparison Series draft.");
  }

  return (
    <AppDialog ariaLabel="New comparison series" backdropClassName="labs-rename-backdrop" className="labs-rename-dialog labs-comparison-create-dialog" dismissDisabled={busy} onClose={onClose}>
      <header>
        <div><h2>New comparison series</h2><p>Define the immutable schedule and evidence panel. Creating this draft does not launch training.</p></div>
        <button aria-label="Close new comparison series" disabled={busy} type="button" onClick={onClose}><X size={16} /></button>
      </header>
      <form onSubmit={(event) => void submit(event)}>
        <div className="labs-comparison-form-grid">
          <label><span>Name</span><input required value={name} onChange={(event) => setName(event.currentTarget.value)} /></label>
          <label><span>Model Project</span><select required value={projectId} onChange={(event) => setProjectId(event.currentTarget.value)}><option value="">Select a project</option>{projects.map((candidate) => <option key={candidate.id} value={candidate.id}>{candidate.name}</option>)}</select></label>
          <label className="labs-comparison-form-wide"><span>Objective</span><textarea required rows={2} value={objective} onChange={(event) => setObjective(event.currentTarget.value)} /></label>
          <TasksetField label="P0 seed" tasksets={tasksets} value={seedId} onChange={setSeedId} />
          <TasksetField label="Eligible learning pool" tasksets={tasksets} value={eligibleId} onChange={setEligibleId} />
          <TasksetField label="Development panel" tasksets={tasksets} value={developmentId} onChange={setDevelopmentId} />
          <TasksetField label="Retained panel" tasksets={tasksets} value={retainedId} onChange={setRetainedId} />
          <TasksetField label="Frozen-final panel" tasksets={tasksets} value={frozenId} onChange={setFrozenId} />
        </div>
        <fieldset className="labs-comparison-schedule-fields">
          <legend>Bounded residual schedule</legend>
          <label><span>Seed rank</span><input min={1} max={1024} type="number" value={seedRank} onChange={(event) => setSeedRank(Number(event.currentTarget.value))} /></label>
          <label className="labs-comparison-daily-ranks"><span>Daily ranks</span><input aria-label="Comma-separated daily ranks" value={dailyRanksText} onChange={(event) => setDailyRanksText(event.currentTarget.value)} /><small>One positive rank per pass.</small></label>
          <label><span>Weekly roll-up</span><input min={1} max={1024} type="number" value={weeklyRank} onChange={(event) => setWeeklyRank(Number(event.currentTarget.value))} /></label>
          <label><span>Full-task refresh</span><input min={1} max={1024} type="number" value={fullRefreshRank} onChange={(event) => setFullRefreshRank(Number(event.currentTarget.value))} /></label>
          <label><span>Envelope</span><input min={maximumEnabledRank} max={1024} type="number" value={envelopeRank} onChange={(event) => setEnvelopeRank(Number(event.currentTarget.value))} /></label>
        </fieldset>
        <fieldset className="labs-comparison-schedule-fields">
          <legend>Branch advancement</legend>
          <label><span>Minimum current-cohort gain</span><input step="0.01" type="number" value={acquisitionTolerance} onChange={(event) => setAcquisitionTolerance(Number(event.currentTarget.value))} /></label>
          <label><span>Maximum retained regression</span><input min={0} step="0.01" type="number" value={retentionTolerance} onChange={(event) => setRetentionTolerance(Number(event.currentTarget.value))} /></label>
          <div className="labs-comparison-policy-summary"><strong>{dailyRanks.length + 3} releases · rank {maximumEnabledRank} maximum</strong><small>This rule only chooses the next daily parent. P7 consolidates the queued daily cohorts; P8 retrains on the full eligible pool. Master promotion stays separate.</small></div>
        </fieldset>
        {error ? <div className="labs-rename-error" role="alert">{error}</div> : null}
        <footer><button disabled={busy} type="button" onClick={onClose}>Cancel</button><button disabled={busy || !name.trim() || !objective.trim()} type="submit">{busy ? "Saving…" : "Create draft"}</button></footer>
      </form>
    </AppDialog>
  );
}

function hasSplit(taskset: Taskset, split: Taskset["tasks"][number]["split"]): boolean {
  return taskset.tasks.some((task) => task.split === split);
}

function TasksetField({ label, onChange, tasksets, value }: { label: string; onChange: (value: string) => void; tasksets: Taskset[]; value: string }) {
  return <label><span>{label}</span><select required value={value} onChange={(event) => onChange(event.currentTarget.value)}><option value="">Select an immutable release</option>{tasksets.map((taskset) => <option key={tasksetKey(taskset)} value={tasksetKey(taskset)}>{taskset.name} · r{taskset.revision} · {taskset.contentHash.slice(0, 8)}</option>)}</select></label>;
}

function seriesReadyProject(project: ModelProject): boolean {
  return Boolean(project.trainingSetup.baseModel?.revision && recipeReward(project.trainingSetup.recipe));
}

function recipeReward(recipe: unknown): { graderId: string } | null {
  if (!recipe || typeof recipe !== "object" || Array.isArray(recipe)) return null;
  const reward = (recipe as Record<string, unknown>).reward;
  if (!reward || typeof reward !== "object" || Array.isArray(reward)) return null;
  const graderId = (reward as Record<string, unknown>).graderId;
  return typeof graderId === "string"
    ? { graderId }
    : null;
}

function uniqueTasksets(state: TrainingStateResponse): Taskset[] {
  return [...new Map([...state.tasksets, ...state.modelTasksets].map((taskset) => [`${taskset.id}:${taskset.revision}:${taskset.contentHash}`, taskset])).values()]
    .filter((taskset) => taskset.profileId === state.profileId && taskset.status === "ready")
    .sort((left, right) => left.name.localeCompare(right.name));
}

function exactRef(taskset: Taskset) {
  return { id: taskset.id, revision: taskset.revision, contentHash: taskset.contentHash };
}
function tasksetKey(taskset: Taskset) { return `${taskset.id}:${taskset.revision}:${taskset.contentHash}`; }

function parseRanks(value: string): number[] {
  return value.split(",").map((part) => Number(part.trim())).filter((rank) => Number.isInteger(rank) && rank > 0 && rank <= 1024);
}

function comparisonSchedule(seriesId: string, template: SeriesTemplate): ModelComparisonScheduleEntry[] {
  const daily = template.dailyRanks.map((rank, index): ModelComparisonScheduleEntry => ({
    id: `${seriesId}-p${index + 1}`,
    ordinal: index + 1,
    label: `P${index + 1}`,
    role: "daily_residual",
    parentRule: "accepted_daily_head",
    taskSource: "nightly_selection",
    trainableRank: rank,
    minimumTasks: 1,
    maximumTasks: 100,
  }));
  const weeklyOrdinal = daily.length + 1;
  return [{
    id: `${seriesId}-p0`, ordinal: 0, label: "P0", role: "seed", parentRule: "base_model", taskSource: "seed_taskset", trainableRank: template.seedRank, minimumTasks: 1, maximumTasks: 100_000,
  }, ...daily, {
    id: `${seriesId}-p${weeklyOrdinal}`, ordinal: weeklyOrdinal, label: `P${weeklyOrdinal}`, role: "weekly_rollup", parentRule: "accepted_seed", taskSource: "daily_cohort_union", trainableRank: template.weeklyRank, minimumTasks: daily.length, maximumTasks: 100_000,
  }, {
    id: `${seriesId}-p${weeklyOrdinal + 1}`, ordinal: weeklyOrdinal + 1, label: `P${weeklyOrdinal + 1}`, role: "full_refresh", parentRule: "base_model", taskSource: "eligible_task_pool", trainableRank: template.fullRefreshRank, minimumTasks: 1, maximumTasks: 100_000,
  }];
}
