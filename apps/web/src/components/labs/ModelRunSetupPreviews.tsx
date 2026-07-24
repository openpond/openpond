import type { ModelProject, ModelRunDraft, Taskset } from "@openpond/contracts";

type SetupPreviewProps = {
  project: ModelProject;
  draft: ModelRunDraft;
  taskset: Taskset | null;
};

export function ModelSetupOverviewPreview({
  project,
  draft,
  taskset,
}: SetupPreviewProps) {
  return (
    <div className="model-setup-preview">
      <header>
        <div>
          <h2>{project.name || "Untitled Model"}</h2>
          <p>{project.objective ?? "Model overview"}</p>
        </div>
        <span className="labs-status-badge info">Pending</span>
      </header>

      <dl className="model-setup-preview-facts">
        <PreviewFact label="Active version" value="—" />
        <PreviewFact label="Latest run" value="Pending" />
        <PreviewFact label="Dataset" value={taskset?.name ?? "—"} />
        <PreviewFact label="Evaluation" value="Not run" />
      </dl>

      <section className="model-setup-preview-section">
        <h3>Performance</h3>
        <EmptyMetricChart label="Evaluation score" />
      </section>

      <section className="model-setup-preview-section">
        <h3>Recent activity</h3>
        <div className="model-setup-pending-row">
          <span className="model-setup-skeleton-dot" aria-hidden="true" />
          <div>
            <strong>{draft.title}</strong>
            <small>Waiting for the first run</small>
          </div>
          <span className="labs-status-badge info">Pending</span>
        </div>
      </section>
    </div>
  );
}

export function ModelSetupRunsPreview({ draft, taskset }: SetupPreviewProps) {
  return (
    <div className="model-setup-preview model-setup-run-preview">
      <label className="model-setup-run-picker">
        <span>Run</span>
        <select aria-label="Preview run" disabled value="pending">
          <option value="pending">{draft.title} · Pending</option>
        </select>
      </label>

      <div className="training-detail-tabs" role="tablist" aria-label="Run detail preview">
        {["Summary", "Metrics", "Evals", "Artifacts", "Logs"].map(
          (label) => (
            <button
              aria-selected={label === "Metrics"}
              className={label === "Metrics" ? "active" : undefined}
              disabled
              key={label}
              role="tab"
              type="button"
            >
              {label}
            </button>
          )
        )}
      </div>

      <section className="model-setup-preview-section">
        <div className="model-setup-preview-section-heading">
          <h3>Training metrics</h3>
          <span className="labs-status-badge info">Pending</span>
        </div>
        <div className="training-metric-summary">
          <MetricSkeleton label="Steps" />
          <MetricSkeleton label="Latest reward" />
          <MetricSkeleton label="Best reward" />
          <MetricSkeleton label="Recorded points" />
        </div>
        <EmptyMetricChart
          label={draft.method === "grpo" || draft.method === "ppo" ? "Reward" : "Loss"}
        />
      </section>

      <dl className="model-setup-preview-facts">
        <PreviewFact
          label="Training"
          value={draft.method?.toUpperCase() ?? "—"}
        />
        <PreviewFact label="Dataset" value={taskset?.name ?? "—"} />
        <PreviewFact
          label="Base model"
          value={draft.baseModel?.modelId ?? "—"}
        />
        <PreviewFact label="Output" value="No version yet" />
      </dl>
    </div>
  );
}

export function ModelSetupConfigurationPreview({
  project,
  draft,
  taskset,
}: SetupPreviewProps) {
  return (
    <div className="model-setup-preview">
      <header>
        <div>
          <h2>Configuration</h2>
          <p>{project.name || "Model"} defaults and pending run settings</p>
        </div>
      </header>

      <div className="training-start-fields model-setup-configuration-fields">
        <PreviewSelect
          label="Base model"
          value={draft.baseModel?.modelId ?? "Not selected"}
        />
        <PreviewSelect
          label="Compute"
          value={destinationLabel(draft.destinationId)}
        />
        <PreviewSelect
          label="Training method"
          value={draft.method?.toUpperCase() ?? "Not selected"}
        />
        <PreviewSelect
          label="Training budget"
          value={budgetLabel(draft.runPreset)}
        />
      </div>

      <dl className="model-setup-preview-facts">
        <PreviewFact
          label="Dataset revision"
          value={taskset ? `${taskset.name} · r${taskset.revision}` : "—"}
        />
        <PreviewFact label="Evaluation" value="Frozen evaluation after run" />
        <PreviewFact label="Provider approval" value="Reviewed when you Run" />
        <PreviewFact label="Output storage" value="App-managed" />
      </dl>
    </div>
  );
}

function EmptyMetricChart({ label }: { label: string }) {
  return (
    <figure
      className="training-line-chart model-setup-empty-chart"
      aria-label={`${label} graph preview`}
    >
      <svg viewBox="0 0 760 270" role="img">
        <title>{`${label} graph preview`}</title>
        {[20, 68, 116, 164, 212].map((y) => (
          <line
            className="training-chart-grid"
            key={y}
            x1="64"
            x2="740"
            y1={y}
            y2={y}
          />
        ))}
        <line
          className="training-chart-axis"
          x1="64"
          x2="740"
          y1="212"
          y2="212"
        />
        <text className="training-chart-label axis-title" x="402" y="261">
          Optimizer step
        </text>
        <text className="model-setup-chart-empty-label" x="402" y="124">
          Metrics will appear after the run starts
        </text>
      </svg>
    </figure>
  );
}

function MetricSkeleton({ label }: { label: string }) {
  return (
    <div>
      <span>{label}</span>
      <strong>—</strong>
    </div>
  );
}

function PreviewFact({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt>{label}</dt>
      <dd>{value}</dd>
    </div>
  );
}

function PreviewSelect({ label, value }: { label: string; value: string }) {
  return (
    <label>
      <span>{label}</span>
      <select aria-label={`${label} preview`} disabled value={value}>
        <option value={value}>{value}</option>
      </select>
    </label>
  );
}

function destinationLabel(destination: ModelRunDraft["destinationId"]): string {
  if (destination === "fireworks") return "Fireworks";
  if (destination === "local_cpu_fixture") return "Local CPU";
  if (destination === "local_cuda") return "Local NVIDIA GPU";
  if (destination === "local_mlx") return "Apple Silicon";
  if (destination === "ssh_gpu") return "SSH GPU";
  return destination ? destination.replaceAll("_", " ") : "Not selected";
}

function budgetLabel(preset: ModelRunDraft["runPreset"]): string {
  if (preset === "small" || preset === "small_experiment") return "Quick test";
  if (preset === "standard") return "Recommended";
  if (preset === "custom") return "Custom";
  return "Recommended";
}
