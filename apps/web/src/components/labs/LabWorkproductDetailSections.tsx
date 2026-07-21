import type {
  BaseModelPreference,
  CreateImproveCandidate,
  CreateImproveRun,
  OpenPondProfileEval,
  OpenPondProfileState,
  Taskset,
  TrainingStateResponse,
} from "@openpond/contracts";
import { BaseModelPreferenceSchema } from "@openpond/contracts";

import type { ShowAppToast } from "../../app/app-state";
import type { useTraining } from "../../hooks/useTraining";
import { DetailSection } from "../training/DetailSection";
import { TrainingModelPromotion } from "../training/TrainingModelPromotion";
import {
  formatDateTime,
  trainingMethodLabel,
} from "../training/training-model-data";
import type { LabWorkproductSummary } from "./lab-workproducts";
import { LabStatusBadge, type LabStatusTone } from "./LabStatusBadge";
import { Download } from "../icons";

type TrainingController = ReturnType<typeof useTraining>;
type WorkproductDetailTab =
  | "overview"
  | "changes"
  | "evals"
  | "versions"
  | "configuration";

export function preferredBaseModelId(runs: CreateImproveRun[]): string | null {
  return preferredBaseModel(runs)?.modelId ?? null;
}

export function preferredBaseModel(runs: CreateImproveRun[]): BaseModelPreference | null {
  for (const run of runs) {
    const parsed = BaseModelPreferenceSchema.safeParse(
      run.metadata.preferredBaseModel,
    );
    if (parsed.success) return parsed.data;
    const value = run.metadata.preferredBaseModelId;
    if (typeof value === "string" && value.trim()) {
      return {
        schemaVersion: "openpond.baseModelPreference.v1",
        modelId: value.trim(),
        revision: null,
        tokenizerRevision: null,
        chatTemplateHash: null,
        modelAssetId: null,
        source: "managed",
      };
    }
  }
  return null;
}

export function latestReviewableCandidate(
  run: CreateImproveRun
): CreateImproveCandidate | null {
  return (
    [...run.candidates]
      .reverse()
      .find((candidate) => Boolean(candidate.git?.headCommit)) ?? null
  );
}

export function changeDotTone(run: CreateImproveRun | null): LabStatusTone {
  if (!run) return "neutral";
  if (run.state === "released") return "positive";
  if (
    run.state === "blocked" ||
    run.state === "failed" ||
    run.state === "rejected"
  )
    return "negative";
  if (run.state === "reconciling_release") return "info";
  return "warning";
}

export function WorkproductConfiguration({
  workproduct,
  profile,
}: {
  workproduct: LabWorkproductSummary;
  profile: OpenPondProfileState | null;
}) {
  if (workproduct.kind === "agent") {
    const agent =
      profile?.agents.find((item) => item.id === workproduct.id) ?? null;
    return (
      <DetailSection title="Agent">
        <dl className="training-configuration-list">
          <Config label="Enabled" value={agent?.enabled ? "Yes" : "No"} />
          <Config
            label="Source"
            value={agent?.path ?? workproduct.path ?? "Draft"}
          />
          <Config label="Default action" value={`${workproduct.id}.chat`} />
          <Config
            label="Profile checks"
            value={profile?.lastCheck?.status ?? "Not run"}
          />
        </dl>
      </DetailSection>
    );
  }
  if (workproduct.kind === "skill") {
    const skill =
      profile?.skills.find((item) => item.name === workproduct.id) ?? null;
    return (
      <DetailSection title="Skill">
        <dl className="training-configuration-list">
          <Config label="Enabled" value={skill?.enabled ? "Yes" : "No"} />
          <Config
            label="Validation"
            value={skill?.validationStatus ?? "Draft"}
          />
          <Config
            label="Source hash"
            value={skill?.sourceHash ?? "Not available"}
          />
          <Config
            label="Characters"
            value={skill ? String(skill.charCount) : "Not available"}
          />
        </dl>
        {skill?.validationMessages.length ? (
          <ul className="labs-validation-list">
            {skill.validationMessages.map((message) => (
              <li key={message}>{message}</li>
            ))}
          </ul>
        ) : null}
      </DetailSection>
    );
  }
  if (workproduct.kind === "extension") {
    return (
      <DetailSection title="Extension">
        <div className="training-run-placeholder">
          Runtime bindings arrive with the Extension phase.
        </div>
      </DetailSection>
    );
  }
  return null;
}

export function ActivitySection({
  runs,
  selectedRun,
  onSelectedRunIdChange,
}: {
  runs: CreateImproveRun[];
  selectedRun: CreateImproveRun | null;
  onSelectedRunIdChange: (runId: string) => void;
}) {
  return (
    <DetailSection title="Activity">
      {runs.length ? (
        <div className="training-table-wrap">
          <table className="training-data-table labs-activity-table">
            <thead>
              <tr>
                <th>Run</th>
                <th>Operation</th>
                <th>State</th>
                <th>Revision</th>
                <th>Updated</th>
              </tr>
            </thead>
            <tbody>
              {runs.map((run) => (
                <tr
                  className={
                    run.id === selectedRun?.id ? "selected" : undefined
                  }
                  key={run.id}
                  onClick={() => onSelectedRunIdChange(run.id)}
                >
                  <td>{shortId(run.id)}</td>
                  <td>{run.operation}</td>
                  <td>
                    <LabStatusBadge
                      label={run.state.replaceAll("_", " ")}
                      value={run.state}
                    />
                  </td>
                  <td>{run.revision}</td>
                  <td>{formatDateTime(run.updatedAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <div className="training-run-placeholder">
          No Create/Improve activity yet.
        </div>
      )}
    </DetailSection>
  );
}

export function EvalSummary({
  profileEvals,
  run,
  workproduct,
}: {
  profileEvals: OpenPondProfileEval[];
  run: CreateImproveRun | null;
  workproduct: LabWorkproductSummary;
}) {
  const receipts = run?.evaluationReceipts ?? [];
  const attachedEvalRefs = [
    ...new Set([
      ...(run?.context.evalRefs ?? []),
      ...receipts.flatMap((receipt) => receipt.evalRefs),
    ]),
  ];
  const sourceEvals =
    workproduct.kind === "agent"
      ? profileEvals.filter(
          (item) => item.agentId === null || item.agentId === workproduct.id
        )
      : [];
  const isAgent = workproduct.kind === "agent";
  if (!receipts.length && !sourceEvals.length && !attachedEvalRefs.length) {
    return (
      <div className="training-run-placeholder">{isAgent ? "No checks yet." : "No Eval receipts yet."}</div>
    );
  }
  return (
    <div className="labs-eval-summary">
      {sourceEvals.length ? (
        <div className="labs-source-evals">
          <strong>{isAgent ? "Available checks" : "Available Evals"}</strong>
          <ul>
            {sourceEvals.map((item) => (
              <li key={item.id}>
                <span>{item.name}</span>
                {isAgent ? null : <code>{item.path}</code>}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      {attachedEvalRefs.length ? (
        <div className="labs-source-evals">
          <strong>{isAgent ? "Included in this update" : "Used for this change"}</strong>
          <ul>
            {isAgent ? (
              <li><span>{attachedEvalRefs.length} check set{attachedEvalRefs.length === 1 ? "" : "s"}</span></li>
            ) : attachedEvalRefs.map((ref) => (
              <li key={ref}><code>{ref}</code></li>
            ))}
          </ul>
        </div>
      ) : null}
      {receipts.length ? (
        <div className="labs-eval-receipts">
          <strong>{isAgent ? "Check results" : "Eval receipts"}</strong>
          <div className="training-table-wrap">
            <table className="training-data-table">
              <thead>
                <tr>
                  {isAgent ? null : <th>Receipt</th>}
                  <th>Status</th>
                  <th>{isAgent ? "Checks" : "Evals"}</th>
                  <th>Summary</th>
                </tr>
              </thead>
              <tbody>
                {receipts.map((receipt) => (
                  <tr key={receipt.id}>
                    {isAgent ? null : <td>{shortId(receipt.id)}</td>}
                    <td>
                      <LabStatusBadge label={receipt.status} />
                    </td>
                    <td>{receipt.evalRefs.length}</td>
                    <td>{isAgent ? agentCheckSummary(receipt) : receipt.summary ?? "No summary"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      ) : null}
    </div>
  );
}

function agentCheckSummary(receipt: CreateImproveRun["evaluationReceipts"][number]): string {
  if (receipt.summaryCounts) {
    return `${receipt.summaryCounts.passed} of ${receipt.summaryCounts.total} checks passed.`;
  }
  if (receipt.status === "passed") return "Agent behavior checks passed.";
  if (receipt.status === "failed") return "One or more Agent behavior checks failed.";
  return "Agent behavior checks are still running.";
}

export function VersionSummary({
  runs,
  selectedRun,
  taskset,
  training,
  trainingState,
  onToast,
}: {
  runs: CreateImproveRun[];
  selectedRun: CreateImproveRun | null;
  taskset: Taskset | null;
  training: TrainingController;
  trainingState: TrainingStateResponse | null;
  onToast: ShowAppToast;
}) {
  const models = (taskset
    ? trainingState?.models.filter((model) => model.tasksetId === taskset.id) ??
      []
    : []).sort((left, right) => right.importedAt.localeCompare(left.importedAt));
  const jobById = new Map(
    trainingState?.jobs.map((job) => [job.id, job] as const) ?? []
  );
  const planById = new Map(
    trainingState?.plans.map((plan) => [plan.id, plan] as const) ?? []
  );
  const artifactById = new Map(
    trainingState?.artifacts.map((artifact) => [artifact.id, artifact] as const) ?? []
  );
  return (
    <>
      <p className="labs-detail-copy labs-version-storage-copy">
        OpenPond automatically saves provider weights in app-managed local storage.
        Download LoRA creates a portable copy for moving or sharing the adapter.
      </p>
      <dl className="labs-inline-facts">
        <Fact label="Create/Improve runs" value={String(runs.length)} />
        <Fact
          label="Candidates"
          value={String(selectedRun?.candidates.length ?? 0)}
        />
        <Fact
          label="Profile commit"
          value={selectedRun?.localProfileCommit ?? "Not released"}
        />
        <Fact label="Model artifacts" value={String(models.length)} />
      </dl>
      {models.length ? (
        <div className="training-table-wrap">
          <table className="training-data-table">
            <thead>
              <tr>
                <th>Version</th>
                <th>Method</th>
                <th>Storage</th>
                <th>Frozen Eval</th>
                <th>Imported</th>
                <th><span className="sr-only">Download</span></th>
              </tr>
            </thead>
            <tbody>
              {models.map((model, index) => {
                const job = jobById.get(model.jobId);
                const plan = job ? planById.get(job.planId) : null;
                const artifact = artifactById.get(model.artifactId) ?? null;
                const storageDirectory = artifact ? localArtifactDirectory(artifact.path) : null;
                return (
                  <tr key={model.id}>
                    <td className="labs-version-name">
                      <strong>{index === 0 ? "Latest" : `Prior ${index}`}</strong>
                      <small>{shortId(model.id)}</small>
                    </td>
                    <td>{trainingMethodLabel(plan?.recipe.method)}</td>
                    <td className="labs-version-storage">
                      <strong>{storageDirectory ? "Saved locally" : "Unavailable"}</strong>
                      {storageDirectory ? <code title={artifact?.path}>{storageDirectory}</code> : null}
                    </td>
                    <td>
                      {model.promotable
                        ? "Passed"
                        : model.frozenEvaluationArtifactId
                          ? "Failed"
                          : "Not run"}
                    </td>
                    <td>{formatDateTime(model.importedAt)}</td>
                    <td>
                      <button
                        className="training-button secondary"
                        type="button"
                        onClick={() =>
                          void training.actions.downloadModelPackage(model.id)
                        }
                      >
                        <Download size={14} />
                        Download LoRA
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      ) : (
        <div className="training-run-placeholder">
          Model versions appear after the first adapter is imported.
        </div>
      )}
      {models[0] ? (
        <div className="labs-version-promotion">
          <h3>Promotion &amp; bindings</h3>
          <TrainingModelPromotion
            lineage={models[0]}
            state={trainingState}
            training={training}
            onToast={onToast}
          />
        </div>
      ) : null}
    </>
  );
}

function localArtifactDirectory(artifactPath: string): string {
  const directory = artifactPath.replace(/[/\\][^/\\]+$/, "");
  return directory.replace(/^\/home\/[^/]+/, "~");
}

export function Fact({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt>{label}</dt>
      <dd>{value}</dd>
    </div>
  );
}

export function Config({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt>{label}</dt>
      <dd>{value}</dd>
    </div>
  );
}

function shortId(value: string): string {
  return value
    .replace(
      /^(create_improve|training_job|agent_candidate|model_candidate)_/,
      ""
    )
    .slice(0, 14);
}

export function titleCase(value: string): string {
  return value
    ? `${value[0]!.toUpperCase()}${value.slice(1).replaceAll("_", " ")}`
    : value;
}

export function detailBreadcrumbs(
  activeTab: WorkproductDetailTab,
  selectedChangeRunId: string | null,
  changeCommit: string | null,
  isAgent = false,
): string[] {
  if (activeTab === "changes") {
    if (!selectedChangeRunId) return ["Changes"];
    return [
      "Changes",
      changeCommit
        ? `Change ${changeCommit.slice(0, 8)}`
        : `Change ${shortId(selectedChangeRunId)}`,
    ];
  }
  return [activeTab === "evals" && isAgent ? "Checks" : titleCase(activeTab)];
}

export function candidateFileScope(
  workproduct: LabWorkproductSummary,
  profile: OpenPondProfileState | null,
  candidate: CreateImproveCandidate
): { fileRootPath: string | null; initialPath: string | null } {
  const changedPaths = candidate.git?.changedPaths ?? [];
  const fallbackPath = changedPaths[0] ?? null;
  const sourcePath = workproduct.path?.trim().replace(/^\.\/+|\/+$/g, "") ?? "";
  if (!sourcePath) return { fileRootPath: null, initialPath: fallbackPath };

  const segments = sourcePath.split("/").filter(Boolean);
  if (segments.at(-1)?.includes(".")) segments.pop();
  const relativeRoot = segments.join("/");
  if (!relativeRoot) return { fileRootPath: null, initialPath: fallbackPath };
  const fileRootPath = relativeRoot.startsWith("profiles/")
    ? relativeRoot
    : `profiles/${profile?.activeProfile ?? "default"}/${relativeRoot}`;
  const initialPath =
    changedPaths.find(
      (path) => path === fileRootPath || path.startsWith(`${fileRootPath}/`)
    ) ?? null;
  return initialPath
    ? { fileRootPath, initialPath }
    : { fileRootPath: null, initialPath: fallbackPath };
}

export function changeStatusDescription(run: CreateImproveRun | null): string {
  if (!run) return "No change status";
  if (run.state === "planning") return "Planning update";
  if (run.state === "awaiting_questions") return "Waiting for input";
  if (run.state === "awaiting_plan_approval") return "Plan ready";
  if (run.state === "applying_source") return "Saving Agent";
  if (run.state === "running_checks" || run.state === "evaluating") return "Running checks";
  if (run.state === "awaiting_promotion") return "Update ready to apply";
  if (run.state === "opening_pull_request" || run.state === "pull_request_open") return "Update review open";
  if (run.state === "reconciling_release") return "Applying update";
  if (run.state === "released") return "Update applied";
  if (run.state === "rejected") return "Current version kept";
  if (run.state === "ready" || run.state === "ready_local") return "Agent ready";
  if (run.state === "published_hosted") return "Agent published";
  if (run.state === "paused") return "Update paused";
  if (run.state === "cancelled") return "Update cancelled";
  if (run.state === "blocked") return "Update blocked";
  if (run.state === "failed") return "Update failed";
  return `Change ${run.state.replaceAll("_", " ")}`;
}
