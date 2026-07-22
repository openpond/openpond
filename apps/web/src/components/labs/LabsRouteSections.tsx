import type {
  CreateImproveRun,
  CrossSystemFrontierBaselineRun,
  TaskCreationSnapshot,
  TrainingStateResponse,
} from "@openpond/contracts";

import type { InsightsViewProps } from "../insights/InsightsView";
import { InsightsView } from "../insights/InsightsView";
import type { TrainingViewProps } from "../training/TrainingView";
import { TrainingSuggestions } from "../training/TrainingSuggestions";
import {
  ChartColumnStacked,
  CheckCircle2,
  ChevronRight,
  CircleDashed,
  Loader2,
  XCircle,
} from "../icons";
import {
  trainingMethodLabel,
} from "../training/training-model-data";
import {
  workproductKey,
  type LabWorkproductSummary,
} from "./lab-workproducts";
import { LabStatusBadge } from "./LabStatusBadge";
import { LabModelBaselineProgress } from "./LabModelBaseline";
import { labModelVersions } from "./lab-models";
import {
  type LabWorkproductProgression,
} from "./lab-workproduct-progression";
import type { LabsRouteProps } from "./LabsRoute";

const PAGE_SIZE = 10;
const EMPTY_TIMESTAMP = new Date(0).toISOString();
type SuggestionsView = "observations" | "suggestions";

export function SuggestionsTab({
  insights,
  suggestionsView,
  training,
  onSuggestionsViewChange,
  onPlanStarted,
}: {
  insights: InsightsViewProps;
  suggestionsView: SuggestionsView;
  training: LabsRouteProps["training"];
  onSuggestionsViewChange: (view: SuggestionsView) => void;
  onPlanStarted: () => void;
}) {
  return (
    <section className="labs-suggestions-page" aria-label="Suggestions">
      <div
        className="labs-subtabs"
        role="tablist"
        aria-label="Suggestion types"
      >
        <button
          aria-selected={suggestionsView === "observations"}
          className={suggestionsView === "observations" ? "active" : undefined}
          role="tab"
          type="button"
          onClick={() => onSuggestionsViewChange("observations")}
        >
          Observations{" "}
          <span>
            {insights.items.filter((item) => item.status === "active").length}
          </span>
        </button>
        <button
          aria-selected={suggestionsView === "suggestions"}
          className={suggestionsView === "suggestions" ? "active" : undefined}
          role="tab"
          type="button"
          onClick={() => onSuggestionsViewChange("suggestions")}
        >
          AI suggestions{" "}
          <span>{training.training.payload?.candidates.length ?? 0}</span>
        </button>
      </div>
      <div className="labs-suggestions-body">
        {suggestionsView === "observations" ? (
          <InsightsView {...insights} />
        ) : (
          <TrainingSuggestions
            training={training.training}
            defaultModel={training.defaultModel}
            preferences={training.preferences}
            reasoningEffort={training.reasoningEffort}
            onPlanStarted={onPlanStarted}
          />
        )}
      </div>
    </section>
  );
}

export function WorkproductsTable({
  frontierBaselineRuns,
  items,
  loading,
  progressionByKey,
  showType,
  onSelect,
  onUseAgent,
  onUseModel,
  onUseSkill,
}: {
  frontierBaselineRuns: CrossSystemFrontierBaselineRun[];
  items: LabWorkproductSummary[];
  loading: boolean;
  progressionByKey: Map<string, LabWorkproductProgression>;
  showType: boolean;
  onSelect: (key: string) => void;
  onUseAgent: (actionId: string, agentName: string) => void;
  onUseModel: (tasksetId: string) => void;
  onUseSkill: (skill: LabWorkproductSummary) => void;
}) {
  if (loading)
    return (
      <div className="labs-table-empty">
        <Loader2 className="spin" size={16} /> Loading workproducts…
      </div>
    );
  if (!items.length)
    return (
      <div className="labs-table-empty">No workproducts match this view.</div>
    );
  const frontierBaselineById = new Map(
    frontierBaselineRuns.map((run) => [run.id, run] as const)
  );
  return (
    <div className="training-table-wrap">
      <table
        className={`training-data-table labs-workproducts-table${
          showType ? "" : " models-only"
        }`}
      >
        <thead>
          <tr>
            {showType ? <th>Type</th> : null}
            <th>Name</th>
            <th>Status</th>
            <th>Training</th>
            <th>Evals</th>
            <th>Updated</th>
            <th>
              <span className="sr-only">Open</span>
            </th>
          </tr>
        </thead>
        <tbody>
          {items.map((item) => {
            const progression = progressionByKey.get(item.key);
            const frontierBaseline = item.frontierBaselineRunId
              ? frontierBaselineById.get(item.frontierBaselineRunId) ?? null
              : null;
            return (
              <tr key={item.key} onClick={() => onSelect(item.key)}>
                {showType ? (
                  <td className="labs-workproduct-type">
                    {titleCase(item.kind)}
                  </td>
                ) : null}
                <td>
                  <button
                    className={frontierBaseline
                      ? "labs-workproduct-link labs-training-run-name"
                      : "labs-workproduct-link"}
                    type="button"
                    onClick={() => onSelect(item.key)}
                  >
                    <strong>{item.name}</strong>
                    <span>{item.description}</span>
                    {frontierBaseline ? (
                      <LabModelBaselineProgress
                        run={frontierBaseline}
                        showOutcomes={false}
                      />
                    ) : null}
                  </button>
                </td>
                <td>
                  <LabStatusBadge
                    label={progression?.statusLabel ?? item.status}
                    value={progression?.statusValue ?? item.status}
                  />
                </td>
                <td className="labs-workproduct-training">
                  {workproductTraining(item)}
                </td>
                <td className="labs-workproduct-evals">
                  {workproductEvals(item)}
                </td>
                <td className="labs-workproduct-updated">
                  {item.updatedAt === EMPTY_TIMESTAMP
                    ? "—"
                    : compactUpdatedAt(item.updatedAt)}
                </td>
                <td>
                  <div className="labs-workproduct-actions">
                    {item.kind === "skill" ? (
                      <button
                        className="settings-secondary compact labs-workproduct-use"
                        type="button"
                        onClick={(event) => {
                          event.stopPropagation();
                          onUseSkill(item);
                        }}
                      >
                        Use
                      </button>
                    ) : item.kind === "agent" && item.useActionId ? (
                      <button
                        className="settings-secondary compact labs-workproduct-use"
                        type="button"
                        onClick={(event) => {
                          event.stopPropagation();
                          onUseAgent(item.useActionId!, item.name);
                        }}
                      >
                        Use
                      </button>
                    ) : item.kind === "model" && item.enabled !== null ? (
                      <button
                        className="settings-secondary compact labs-workproduct-use"
                        type="button"
                        disabled={!item.enabled}
                        title={item.enabled
                          ? "Start a bounded chat session with this model"
                          : "Chat is available after a version passes frozen evaluation"}
                        onClick={(event) => {
                          event.stopPropagation();
                          onUseModel(item.id);
                        }}
                      >
                        Chat
                      </button>
                    ) : null}
                    <ChevronRight size={15} />
                  </div>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

export function ModelsTable({
  items,
  loading,
  runs,
  state,
  onSelect,
  onUseModel,
}: {
  items: LabWorkproductSummary[];
  loading: boolean;
  runs: CreateImproveRun[];
  state: TrainingStateResponse | null;
  onSelect: (key: string) => void;
  onUseModel: (modelId: string) => void;
}) {
  if (loading) {
    return (
      <div className="labs-table-empty">
        <Loader2 className="spin" size={16} /> Loading Models…
      </div>
    );
  }
  if (!items.length) {
    return <div className="labs-table-empty">No Models yet.</div>;
  }
  return (
    <div className="training-table-wrap">
      <table className="training-data-table labs-models-table">
        <thead>
          <tr>
            <th>Model</th>
            <th>Active</th>
            <th>Eval</th>
            <th>Versions</th>
            <th>Updated</th>
            <th><span className="sr-only">Actions</span></th>
          </tr>
        </thead>
        <tbody>
          {items.map((item) => {
            const versions = labModelVersions(item, runs, state);
            const current =
              versions.find((version) => version.current) ?? null;
            const latest = versions[0] ?? null;
            return (
              <tr key={item.key} onClick={() => onSelect(item.key)}>
                <td>
                  <button
                    className="labs-workproduct-link"
                    type="button"
                    onClick={() => onSelect(item.key)}
                  >
                    <strong>{item.name}</strong>
                    <span>{item.description}</span>
                  </button>
                </td>
                <td>
                  {current
                    ? `Version ${current.number} · ${trainingMethodLabel(
                        current.plan?.recipe.method,
                      )}`
                    : "Not selected"}
                </td>
                <td>
                  <LabStatusBadge
                    label={
                      latest
                        ? latest.lineage.promotable
                          ? "Passed"
                          : latest.lineage.frozenEvaluationArtifactId
                            ? "Failed"
                            : "Not run"
                        : "Not run"
                    }
                    value={
                      latest?.lineage.promotable
                        ? "passed"
                        : latest?.lineage.frozenEvaluationArtifactId
                          ? "failed"
                          : "not_run"
                    }
                  />
                </td>
                <td>{versions.length}</td>
                <td>{compactUpdatedAt(item.updatedAt)}</td>
                <td>
                  <div className="labs-workproduct-actions">
                    <button
                      className="settings-secondary compact labs-workproduct-use"
                      disabled={!current}
                      title={
                        current
                          ? "Chat with the active Version"
                          : "Set a passing Version active before Chat"
                      }
                      type="button"
                      onClick={(event) => {
                        event.stopPropagation();
                        onUseModel(item.id);
                      }}
                    >
                      Chat
                    </button>
                    <ChevronRight size={15} />
                  </div>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function workproductTraining(item: LabWorkproductSummary) {
  if (item.kind !== "model") {
    return (
      <span className="labs-workproduct-na" title="Training not applicable">
        —
      </span>
    );
  }
  const label = `${item.trainingRunCount} training ${
    item.trainingRunCount === 1 ? "run" : "runs"
  }`;
  return (
    <span
      className={`labs-workproduct-indicator${
        item.trainingRunCount > 0 ? " active" : ""
      }`}
      title={label}
    >
      <ChartColumnStacked aria-hidden="true" size={15} />
      <strong aria-hidden="true">{item.trainingRunCount}</strong>
      <span className="sr-only">{label}</span>
    </span>
  );
}

function workproductEvals(item: LabWorkproductSummary) {
  const presentation =
    item.evaluationStatus === "passed"
      ? {
          icon: <CheckCircle2 aria-hidden="true" size={16} />,
          label: "Evals passed",
          tone: "positive",
        }
      : item.evaluationStatus === "failed"
      ? {
          icon: <XCircle aria-hidden="true" size={16} />,
          label: "Evals failed",
          tone: "negative",
        }
      : {
          icon: <CircleDashed aria-hidden="true" size={16} />,
          label: "Evals not run",
          tone: "neutral",
        };
  return (
    <span
      className={`labs-workproduct-indicator ${presentation.tone}`}
      title={presentation.label}
    >
      {presentation.icon}
      <span className="sr-only">{presentation.label}</span>
    </span>
  );
}

function compactUpdatedAt(value: string): string {
  const date = new Date(value);
  const today = new Date();
  if (date.toDateString() === today.toDateString()) {
    return new Intl.DateTimeFormat(undefined, {
      hour: "numeric",
      minute: "2-digit",
    }).format(date);
  }
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    ...(date.getFullYear() === today.getFullYear() ? {} : { year: "2-digit" }),
  }).format(date);
}

export function Pagination({
  page,
  total,
  onChange,
}: {
  page: number;
  total: number;
  onChange: (page: number) => void;
}) {
  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  if (pages <= 1) return null;
  return (
    <nav className="labs-pagination" aria-label="Pagination">
      <button
        type="button"
        disabled={page <= 1}
        onClick={() => onChange(page - 1)}
      >
        Previous
      </button>
      <span>
        {page} of {pages}
      </span>
      <button
        type="button"
        disabled={page >= pages}
        onClick={() => onChange(page + 1)}
      >
        Next
      </button>
    </nav>
  );
}

export async function finishModelCreation(
  creation: TaskCreationSnapshot,
  training: LabsRouteProps["training"],
  refreshRuns: () => Promise<CreateImproveRun[] | null>,
  setSelectedKey: (key: string | null) => void
) {
  training.onLaunchHandled(training.launchRequest?.id ?? 0);
  if (!creation.materializedTasksetId) return;
  training.onSelectedTasksetIdChange(creation.materializedTasksetId);
  training.onDetailTasksetIdChange(creation.materializedTasksetId);
  const refreshed = await refreshRuns();
  const run = refreshed?.find(
    (candidate) => candidate.id === creation.request.createImproveRunId,
  );
  setSelectedKey(
    workproductKey(
      "model",
      run?.target.kind === "model"
        ? run.target.id ?? run.id
        : creation.materializedTasksetId,
    ),
  );
}

export function creationObjective(
  creation: TaskCreationSnapshot,
  fallback: string
): string {
  return (
    creation.request.objective?.trim() ||
    creation.proposal?.objective.trim() ||
    creation.proposal?.name.trim() ||
    fallback
  );
}

function titleCase(value: string): string {
  return value
    ? `${value[0]!.toUpperCase()}${value.slice(1).replaceAll("_", " ")}`
    : value;
}

export function trainingModelRunSyncKey(
  training: TrainingViewProps["training"]["payload"]
): string {
  if (!training) return "";
  return [
    ...training.jobs.map((job) => `job:${job.id}:${job.status}`),
    ...training.models.map(
      (model) =>
        `model:${model.id}:${model.status}:${model.artifactId}:${model.jobId}`
    ),
  ]
    .sort()
    .join("|");
}
