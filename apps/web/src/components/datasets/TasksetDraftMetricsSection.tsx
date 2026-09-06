import type { TasksetDraft } from "@openpond/contracts";
import { EditorSection, Field } from "./TasksetDraftEditorPrimitives";

export function TasksetDraftMetricsSection({ draft, disabled, onChange }: { draft: TasksetDraft; disabled: boolean; onChange: (draft: TasksetDraft) => void }) {
  const metrics = draft.metrics;
  return (
    <EditorSection
      title="Metrics and reward aggregation"
      description="Built-in aggregation stays declarative. A custom module is created in the workspace and content-hashed automatically when you save."
    >
      <div className="taskset-draft-field-grid three">
        <Field label="Primary metric">
          <input disabled={disabled} value={metrics.primaryMetric} onChange={(event) => onChange({ ...draft, metrics: { ...metrics, primaryMetric: event.target.value } })} />
        </Field>
        <Field label="Aggregation">
          <select
            disabled={disabled}
            value={metrics.aggregation}
            onChange={(event) => {
              const aggregation = event.target.value as TasksetDraft["metrics"]["aggregation"];
              onChange({
                ...draft,
                metrics: {
                  ...metrics,
                  aggregation,
                  customAggregator: aggregation === "custom"
                    ? metrics.customAggregator ?? {
                        module: "metrics/aggregate.ts",
                        exportName: "aggregate",
                        contentHash: "0".repeat(64),
                        timeoutMs: 30_000,
                        networkPolicy: "none",
                      }
                    : null,
                },
              });
            }}
          >
            <option value="mean_score">Mean score</option>
            <option value="pass_rate">Pass rate</option>
            <option value="weighted_mean">Weighted mean</option>
            <option value="custom">Custom module</option>
          </select>
        </Field>
        <Field label="Missing reward">
          <select disabled={disabled} value={metrics.missingReward} onChange={(event) => onChange({ ...draft, metrics: { ...metrics, missingReward: event.target.value as TasksetDraft["metrics"]["missingReward"] } })}>
            <option value="zero">Count as zero</option>
            <option value="exclude">Exclude</option>
          </select>
        </Field>
      </div>
      {metrics.customAggregator ? (
        <div className="taskset-draft-field-grid">
          <Field label="Module">
            <input disabled={disabled} value={metrics.customAggregator.module} onChange={(event) => onChange({ ...draft, metrics: { ...metrics, customAggregator: { ...metrics.customAggregator!, module: event.target.value } } })} />
          </Field>
          <Field label="SHA-256 (managed on save)">
            <input disabled value={metrics.customAggregator.contentHash} readOnly />
          </Field>
        </div>
      ) : null}
    </EditorSection>
  );
}
