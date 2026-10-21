import { useContext, useState } from "react";
import type { RunStageEvidence } from "@openpond/contracts";
import {
  RunEvidencePanel,
  RunInspectionContext,
  type RunEvidenceInspection,
} from "./RunEvidencePanel";
import { useRunEvidenceTooltip } from "./useRunEvidenceTooltip";
import { TrainingAdapterStack, OptimizerResetIndicator } from "./TrainingRunLineage";
import type { RunFlowNode } from "./RunFlowDiagram";
import { ArrowDown, ArrowUp } from "../icons";

const cpuParents = new Map([
  ["Grade", "Rollouts"],
  ["Save checkpoint", "Update adapter"],
]);

/** CPU branches retain their console position above the GPU stage they support. */
export function SidebarRunFlowDiagram({
  nodes,
  live,
  loopLabel = "Training groups",
  inference,
  groupLabel,
  policyLabel,
  continuation,
}: {
  nodes: RunFlowNode[];
  live: boolean;
  loopLabel?: string;
  inference?: RunFlowNode | null;
  groupLabel?: string;
  policyLabel?: string;
  continuation?: RunStageEvidence["continuation"];
}) {
  const outerInspect = useContext(RunInspectionContext);
  const [selection, setSelection] = useState<RunEvidenceInspection | null>(null);
  const main = nodes.filter(
    (node) =>
      !cpuParents.has(node.label) ||
      !nodes.some((item) => item.label === cpuParents.get(node.label)),
  );
  const before = main.filter(
    (node) => !node.inLoop && main.indexOf(node) < main.findIndex((item) => item.inLoop),
  );
  const loop = main.filter((node) => node.inLoop);
  const after = main.filter((node) => !node.inLoop && !before.includes(node));
  const looping = live && nodes.some((node) => node.inLoop && node.state === "active");
  const cluster = (node: RunFlowNode) => {
    const branch = nodes.find((item) => cpuParents.get(item.label) === node.label);
    return (
      <li className={`sidebar-run-cluster ${branch ? "has-branch" : ""}`} key={node.label}>
        {branch ? (
          <div className="sidebar-run-branch">
            <StageCard node={{ ...branch, compute: "cpu" }} live={live} />
            <ArrowUp className="sidebar-run-branch-arrow" size={14} aria-hidden />
          </div>
        ) : null}
        {node.label === "Finish" && continuation ? (
          <TrainingAdapterStack continuation={continuation} />
        ) : null}
        <StageCard node={node} live={live} />
        {node.label === "Prepare" && inference ? (
          <div className="sidebar-run-worker">
            <ArrowUp size={14} aria-hidden />
            <StageCard node={{ ...inference, compute: "gpu" }} live={live} />
          </div>
        ) : null}
      </li>
    );
  };
  return (
    <RunInspectionContext.Provider value={outerInspect ?? setSelection}>
      <div className={`run-flow sidebar-run-flow ${live ? "live" : ""}`} aria-label="Run stages">
        <div className="run-flow-compute-legend" aria-label="Compute colors">
          <span className="compute-gpu">GPU</span>
          <span className="compute-cpu">CPU</span>
        </div>
        {before.length ? <ol className="sidebar-run-path">{before.map(cluster)}</ol> : null}
        {loop.length ? (
          <>
            {before.length ? (
              <ArrowDown className="sidebar-run-next" size={16} aria-hidden />
            ) : null}
            <section
              className={`sidebar-run-loop ${looping ? "active" : ""}`}
              aria-label={loopLabel}
            >
              <header>
                <span>{loopLabel}</span>
                {policyLabel ? (
                  <span className="training-policy-label">
                    {policyLabel}
                    <OptimizerResetIndicator continuation={continuation} />
                  </span>
                ) : null}
              </header>
              <ol className="sidebar-run-path">{loop.map(cluster)}</ol>
              <div className="sidebar-run-return">
                <span>{groupLabel ?? "Repeat for each group"}</span>
              </div>
            </section>
          </>
        ) : null}
        {after.length ? (
          <>
            {before.length || loop.length ? (
              <ArrowDown className="sidebar-run-next" size={16} aria-hidden />
            ) : null}
            <ol className="sidebar-run-path sidebar-run-final">{after.map(cluster)}</ol>
          </>
        ) : null}
      </div>
      {selection && !outerInspect ? <RunEvidencePanel {...selection} /> : null}
    </RunInspectionContext.Provider>
  );
}

function StageCard({ node, live }: { node: RunFlowNode; live: boolean }) {
  const [inspecting, setInspecting] = useState(false);
  const inspect = useContext(RunInspectionContext);
  const warnings = node.diagnostics?.filter((item) => item.severity !== "info") ?? [];
  const distinctError =
    node.error && !warnings.some((item) => item.value.includes(node.error!)) ? node.error : null;
  const warningCount = warnings.length + (distinctError ? 1 : 0);
  const hoverEvidence = [
    node.detail,
    ...warnings.slice(0, 2).map((item) => `${item.label}: ${item.value.slice(0, 180)}`),
    distinctError?.slice(0, 200),
  ]
    .filter(Boolean)
    .join(". ");
  const { triggerProps, tooltip, hideTooltip } = useRunEvidenceTooltip(
    <>
      <strong>{node.label}</strong>
      <span>{node.status}</span>
      {hoverEvidence ? <span>{hoverEvidence}</span> : null}
      <small>Select to inspect retained evidence.</small>
    </>,
  );
  const selection = {
    title: node.label,
    status: node.status,
    feedback: node.feedback,
    facts: [
      ...(node.diagnostics ?? []),
      ...(node.error
        ? [{ label: "Recorded stage failure", value: node.error, severity: "error" as const }]
        : []),
    ],
  };

  const compute =
    node.compute ??
    (["Baseline evaluation", "Rollouts", "Update adapter", "Activate policy", "Evaluate"].includes(
      node.label,
    )
      ? "gpu"
      : undefined);
  const active = live && node.state === "active";
  const progress =
    node.progress === undefined
      ? undefined
      : Math.round(Math.min(1, Math.max(0, node.progress)) * 100);
  return (
    <>
      <div
        className={`sidebar-run-card ${node.state} ${compute ? `compute-${compute}` : ""}`}
        aria-current={active ? "step" : undefined}
      >
        <button
          {...triggerProps}
          type="button"
          className="sidebar-run-inspect"
          onClick={() => {
            hideTooltip();
            if (inspect) inspect(selection);
            else setInspecting(true);
          }}
          aria-label={`Inspect ${node.label} evidence`}
        />
        <div className="sidebar-run-card-heading">
          <strong>{node.label}</strong>
          {compute ? <span>{compute.toUpperCase()}</span> : null}
        </div>
        <span className="sidebar-run-status">{node.status}</span>
        {node.detail ? <span className="sidebar-run-detail">{node.detail}</span> : null}
        {warningCount ? (
          <span className="sidebar-run-detail">{warningCount} retained warnings or failures</span>
        ) : null}
        {active || progress !== undefined ? (
          <div
            className={`sidebar-run-progress ${active && progress === undefined ? "indeterminate" : ""}`}
            role={progress === undefined ? undefined : "progressbar"}
            aria-label={`${node.label} progress`}
            aria-valuemin={progress === undefined ? undefined : 0}
            aria-valuemax={progress === undefined ? undefined : 100}
            aria-valuenow={progress}
          >
            <span style={progress === undefined ? undefined : { width: `${progress}%` }} />
          </div>
        ) : null}
      </div>
      {tooltip}
      {inspecting && !inspect ? <RunEvidencePanel {...selection} /> : null}
    </>
  );
}
