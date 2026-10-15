import type { RunFlowNode } from "./RunFlowDiagram";
import { ArrowDown, ArrowUp, Check, RotateCcw } from "../icons";

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
}: {
  nodes: RunFlowNode[];
  live: boolean;
  loopLabel?: string;
  inference?: RunFlowNode | null;
  groupLabel?: string;
  policyLabel?: string;
}) {
  const main = nodes.filter((node) => !cpuParents.has(node.label) || !nodes.some((item) => item.label === cpuParents.get(node.label)));
  const before = main.filter((node) => !node.inLoop && main.indexOf(node) < main.findIndex((item) => item.inLoop));
  const loop = main.filter((node) => node.inLoop);
  const after = main.filter((node) => !node.inLoop && !before.includes(node));
  const looping = live && nodes.some((node) => node.inLoop && node.state === "active");
  const cluster = (node: RunFlowNode) => {
    const branch = nodes.find((item) => cpuParents.get(item.label) === node.label);
    return (
      <li className={`sidebar-run-cluster ${branch ? "has-branch" : ""}`} key={node.label}>
        {branch ? <div className="sidebar-run-branch">
          <StageCard node={{ ...branch, compute: "cpu" }} live={live} />
          <ArrowUp className="sidebar-run-branch-arrow" size={14} aria-hidden />
        </div> : null}
        <StageCard node={node} live={live} />
        {node.label === "Prepare" && inference ? <div className="sidebar-run-worker">
          <ArrowUp size={14} aria-hidden />
          <StageCard node={{ ...inference, compute: "gpu" }} live={live} />
        </div> : null}
      </li>
    );
  };
  return (
    <div className={`run-flow sidebar-run-flow ${live ? "live" : ""}`} aria-label="Run stages">
      <div className="run-flow-compute-legend" aria-label="Compute colors">
        <span className="compute-gpu">GPU</span><span className="compute-cpu">CPU</span>
      </div>
      {before.length ? <ol className="sidebar-run-path">{before.map(cluster)}</ol> : null}
      {loop.length ? <>
        {before.length ? <ArrowDown className="sidebar-run-next" size={16} aria-hidden /> : null}
        <section className={`sidebar-run-loop ${looping ? "active" : ""}`} aria-label={loopLabel}>
          <header><span>{loopLabel}</span>{policyLabel ? <span>{policyLabel}</span> : null}</header>
          <ol className="sidebar-run-path">{loop.map(cluster)}</ol>
          <div className="sidebar-run-return"><RotateCcw size={13} aria-hidden /><span>{groupLabel ?? "Repeat for each group"}</span></div>
        </section>
      </> : null}
      {after.length ? <>
        {before.length || loop.length ? <ArrowDown className="sidebar-run-next" size={16} aria-hidden /> : null}
        <ol className="sidebar-run-path sidebar-run-final">{after.map(cluster)}</ol>
      </> : null}
    </div>
  );
}

function StageCard({ node, live }: { node: RunFlowNode; live: boolean }) {
  const compute = node.compute ?? (["Rollouts", "Update adapter", "Activate policy", "Evaluate"].includes(node.label) ? "gpu" : undefined);
  const active = live && node.state === "active";
  const progress = node.progress === undefined ? undefined : Math.round(Math.min(1, Math.max(0, node.progress)) * 100);
  return (
    <div className={`sidebar-run-card ${node.state} ${compute ? `compute-${compute}` : ""}`} aria-current={active ? "step" : undefined}>
      <div className="sidebar-run-card-heading"><strong>{node.label}</strong>{node.state === "done" ? <Check size={13} aria-label="Recorded" /> : compute ? <span>{compute.toUpperCase()}</span> : null}</div>
      <span className="sidebar-run-status">{node.status}</span>
      {node.detail ? <span className="sidebar-run-detail">{node.detail}</span> : null}
      {node.error ? <details className="sidebar-run-error"><summary>Recorded failure</summary><p>{node.error}</p></details> : null}
      {active || progress !== undefined ? <div className={`sidebar-run-progress ${active && progress === undefined ? "indeterminate" : ""}`} role={progress === undefined ? undefined : "progressbar"} aria-label={`${node.label} progress`} aria-valuemin={progress === undefined ? undefined : 0} aria-valuemax={progress === undefined ? undefined : 100} aria-valuenow={progress}>
        <span style={progress === undefined ? undefined : { width: `${progress}%` }} />
      </div> : null}
    </div>
  );
}
