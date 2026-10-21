import type { RunStageEvidence } from "@openpond/contracts";
import { RunEvidencePanel, RunInspectionContext } from "./RunEvidencePanel";
import { useRunEvidenceTooltip } from "./useRunEvidenceTooltip";
import { useContext, useId, useState } from "react";
import { SidebarRunFlowDiagram } from "./SidebarRunFlowDiagram";
import "./run-flow-diagram.css";

export type RunFlowNode = {
  label: string;
  compute?: "gpu" | "cpu";
  state: "done" | "active" | "pending" | "missing" | "failed";
  error?: string;
  status: string;
  detail?: string;
  diagnostics?: RunStageEvidence["nodes"][number]["diagnostics"];
  feedback?: RunStageEvidence["nodes"][number]["feedback"];
  progress?: number;
  inLoop?: boolean;
};

/** Reflow the console journey into readable stage clusters at sidebar widths. */
export function RunFlowDiagram(props: {
  nodes: RunFlowNode[];
  live: boolean;
  loopLabel?: string;
  inference?: RunFlowNode | null;
  groupLabel?: string;
  policyLabel?: string;
  continuation?: RunStageEvidence["continuation"];
}) {
  return <SidebarRunFlowDiagram {...props} />;
}

const plannedStages: RunFlowNode[] = [
  { label: "Prepare", state: "pending", status: "Not started" },
  { label: "Rollouts", compute: "gpu", state: "pending", status: "Not started", inLoop: true },
  { label: "Grade", compute: "cpu", state: "pending", status: "Not started", inLoop: true },
  {
    label: "Update adapter",
    compute: "gpu",
    state: "pending",
    status: "Not started",
    inLoop: true,
  },
  {
    label: "Save checkpoint",
    compute: "cpu",
    state: "pending",
    status: "Not started",
    inLoop: true,
  },
  {
    label: "Activate policy",
    compute: "gpu",
    state: "pending",
    status: "Not started",
    inLoop: true,
  },
  { label: "Evaluate", compute: "gpu", state: "pending", status: "Not started" },
  { label: "Finish", state: "pending", status: "Not started" },
];

export function PlannedTrainingFlow() {
  return (
    <RunFlowDiagram
      nodes={plannedStages}
      live={false}
      loopLabel="Training groups"
      inference={{ label: "GPU worker", compute: "gpu", state: "pending", status: "Not allocated" }}
    />
  );
}

function FlowPackets({ path }: { path: string }) {
  return (
    <>
      <path d={path} className="run-flow-stream" />
      {[0, 0.6].map((begin) => (
        <circle key={begin} r={2.5} className="run-flow-packet">
          <animateMotion dur="1.2s" begin={`-${begin}s`} repeatCount="indefinite" path={path} />
        </circle>
      ))}
    </>
  );
}

function FlowBox({
  node,
  x,
  y,
  width,
  animated,
}: {
  node: RunFlowNode;
  x: number;
  y: number;
  width: number;
  animated: boolean;
}) {
  const [inspecting, setInspecting] = useState(false);
  const inspect = useContext(RunInspectionContext);
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
  const open = () => {
    hideTooltip();
    if (inspect) inspect(selection);
    else setInspecting(true);
  };
  const snapshot = node.diagnostics
    ?.filter((item) => item.severity !== "info")
    .slice(0, 2)
    .map((item) => `${item.label}: ${item.value.slice(0, 180)}`)
    .join(". ");
  const { triggerProps, tooltip, hideTooltip } = useRunEvidenceTooltip(
    <>
      <strong>{node.label}</strong>
      <span>
        {node.status}
        {node.detail ? ` · ${node.detail}` : ""}
      </span>
      {snapshot || node.error ? <span>{snapshot || node.error?.slice(0, 240)}</span> : null}
      <small>Select to inspect retained evidence.</small>
    </>,
  );
  const warnings = node.diagnostics?.filter((item) => item.severity !== "info") ?? [];
  const clip = useId().replace(/[^\w-]/g, "");
  const barWidth = width - 28,
    active = node.state === "active";
  const truncate = (value: string) =>
    value.length > Math.floor((width - 24) / 6)
      ? `${value.slice(0, Math.floor((width - 24) / 6) - 1)}…`
      : value;
  const compute =
    node.compute ??
    (["Grade", "Save checkpoint"].includes(node.label)
      ? "cpu"
      : [
            "Baseline evaluation",
            "Rollouts",
            "Update adapter",
            "Activate policy",
            "Evaluate",
          ].includes(node.label)
        ? "gpu"
        : undefined);
  return (
    <>
      <g
        {...triggerProps}
        role="button"
        tabIndex={0}
        onClick={open}
        onKeyDown={(event) => {
          if (event.key === "Enter" || event.key === " ") {
            event.preventDefault();
            open();
          }
        }}
        aria-label={`Inspect ${node.label} execution evidence`}
        className={`run-flow-node ${node.state} ${compute ? `compute-${compute}` : ""}`}
        aria-current={active ? "step" : undefined}
      >
        <rect className="run-flow-box" x={x} y={y} width={width} height={72} rx={10} />
        {warnings.length ? (
          <text className="run-flow-label" x={x + width - 31} y={y + 13}>
            !
          </text>
        ) : null}
        <text className="run-flow-label" x={x + 12} y={y + 20}>
          {truncate(node.label)}
        </text>
        <text className="run-flow-status" x={x + 12} y={y + 37}>
          {truncate(node.status)}
        </text>
        {node.detail ? (
          <text className="run-flow-detail" x={x + 12} y={y + 53}>
            {truncate(node.detail)}
          </text>
        ) : null}
        {active || node.progress !== undefined ? (
          <g clipPath={`url(#${clip})`}>
            <clipPath id={clip}>
              <rect x={x + 14} y={y + 64} width={barWidth} height={2} rx={1} />
            </clipPath>
            <rect className="run-flow-track" x={x + 14} y={y + 64} width={barWidth} height={2} />
            {node.progress !== undefined ? (
              <rect
                className="run-flow-fill"
                x={x + 14}
                y={y + 64}
                width={barWidth * Math.min(1, Math.max(0, node.progress))}
                height={2}
              />
            ) : null}
            {active && animated ? (
              <rect
                className="run-flow-shimmer"
                x={x + 14}
                y={y + 64}
                width={barWidth / 3}
                height={2}
              >
                <animate
                  attributeName="x"
                  from={x + 14 - barWidth / 3}
                  to={x + 14 + barWidth}
                  dur="1.4s"
                  repeatCount="indefinite"
                />
              </rect>
            ) : null}
          </g>
        ) : null}
      </g>
      {tooltip}
      {inspecting && !inspect ? <RunEvidencePanel {...selection} /> : null}
    </>
  );
}

/** The model-overview console diagram, with CPU work above the main training flow. */
export function ConsoleRunFlowDiagram({
  nodes,
  inference,
  live,
  loopLabel,
  groupLabel,
  policyLabel,
  continuation,
}: {
  nodes: RunFlowNode[];
  inference: RunFlowNode | null;
  live: boolean;
  loopLabel: string;
  groupLabel: string;
  policyLabel?: string;
  continuation?: RunStageEvidence["continuation"];
}) {
  const marker = useId().replace(/[^\w-]/g, "");
  const boxWidth = 140,
    boxHeight = 72,
    gap = 36,
    y = 140,
    cpuY = 40,
    gpuY = 236;
  let cursor = 8;
  const positions = nodes.map((node, index) => {
    const above = ["Grade", "Save checkpoint"].includes(node.label);
    if (!above && index) cursor += boxWidth + gap;
    return { x: cursor, y: above ? cpuY : y };
  });
  const width = cursor + boxWidth + 8;
  const finishPosition = positions[nodes.findIndex((node) => node.label === "Finish")];
  const loopIndexes = nodes.flatMap((node, index) => (node.inLoop ? [index] : []));
  const first = loopIndexes[0],
    last = loopIndexes.at(-1);
  const loopLive = live && loopIndexes.some((index) => nodes[index]?.state === "active");
  const wires = nodes.slice(1).map((node, index) => {
    const from = positions[index]!,
      to = positions[index + 1]!;
    return {
      id: `stage-${index}`,
      path:
        from.x === to.x
          ? `M${from.x + boxWidth / 2} ${from.y} V${to.y + boxHeight}`
          : `M${from.x + boxWidth} ${from.y + boxHeight / 2} H${from.x + boxWidth + gap / 2} V${to.y + boxHeight / 2} H${to.x}`,
      active: live && node.state === "active",
    };
  });
  if (inference && positions[0])
    wires.push({
      id: "gpu-prepare",
      path: `M${positions[0].x + boxWidth / 2} ${gpuY} V${y + boxHeight}`,
      active: live && inference.state === "active" && nodes[0]?.state === "active",
    });
  if (first !== undefined && last !== undefined && loopLive)
    wires.push({
      id: "loop",
      path: `M${positions[last]!.x + boxWidth / 2} ${y + boxHeight} V${gpuY - 8} H${positions[first]!.x + boxWidth / 2} V${y + boxHeight}`,
      active: true,
    });
  return (
    <div className="console-run-flow" aria-label="Training rollout flow">
      <div className="run-flow-compute-legend" aria-label="Compute colors">
        <span className="compute-gpu">GPU</span>
        <span className="compute-cpu">CPU</span>
      </div>
      <svg
        className="run-flow-diagram"
        viewBox={`0 0 ${width} 320`}
        style={{ minWidth: width * 0.75, maxWidth: width * 1.35 }}
        role="group"
        aria-label={nodes.map((node) => `${node.label}: ${node.status}`).join(". ")}
      >
        <defs>
          <marker
            id={marker}
            viewBox="0 0 8 8"
            refX="6"
            refY="4"
            markerWidth="6"
            markerHeight="6"
            orient="auto-start-reverse"
          >
            <path d="M1 1 L7 4 L1 7" className="run-flow-arrow" />
          </marker>
        </defs>
        {first !== undefined && last !== undefined ? (
          <g>
            <rect
              className={`run-flow-loop ${loopLive ? "live" : ""}`}
              x={positions[first]!.x - 20}
              y={4}
              width={positions[last]!.x - positions[first]!.x + boxWidth + 40}
              height={228}
              rx={14}
            />
            <text className="run-flow-caption" x={positions[first]!.x - 6} y={22}>
              {loopLabel}
            </text>
            <text
              className="run-flow-caption"
              x={positions[last]!.x + boxWidth + 6}
              y={22}
              textAnchor="end"
            >
              {policyLabel}
              {continuation?.optimizerMode === "reset" ? (
                <tspan aria-label="Optimizer reset for this run">{" · optimizer reset"}</tspan>
              ) : null}
            </text>
          </g>
        ) : null}
        {wires.map((wire) => (
          <g key={wire.id}>
            <path className="run-flow-wire" d={wire.path} markerEnd={`url(#${marker})`} />
            {wire.active ? <FlowPackets path={wire.path} /> : null}
          </g>
        ))}
        {continuation && finishPosition ? (
          <g className="run-flow-adapter-stack" aria-label="Continual adapter lineage">
            <rect
              className="run-flow-box"
              x={finishPosition.x - 12}
              y={4}
              width={boxWidth - 8}
              height={64}
              rx={10}
            />
            <text className="run-flow-status" x={finishPosition.x} y={24}>
              Frozen parent
            </text>
            <text className="run-flow-detail" x={finishPosition.x} y={42}>
              {continuation.parentRank ? `Rank ${continuation.parentRank}` : "Rank unavailable"}
            </text>
            <rect
              className="run-flow-box"
              x={finishPosition.x}
              y={54}
              width={boxWidth - 8}
              height={66}
              rx={10}
            />
            <text className="run-flow-label" x={finishPosition.x + 12} y={76}>
              Continual learning
            </text>
            <text className="run-flow-status" x={finishPosition.x + 12} y={93}>
              This update
            </text>
            <text className="run-flow-detail" x={finishPosition.x + 12} y={109}>
              {continuation.trainableRank
                ? `Rank ${continuation.trainableRank}`
                : "Rank unavailable"}
            </text>
            <path
              className="run-flow-wire"
              d={`M${finishPosition.x + boxWidth / 2} 128 V${y}`}
              markerEnd={`url(#${marker})`}
            />
          </g>
        ) : null}
        {nodes.map((node, index) => (
          <FlowBox
            key={node.label}
            node={node}
            {...positions[index]!}
            width={boxWidth}
            animated={live}
          />
        ))}
        {inference ? (
          <FlowBox
            node={{ ...inference, compute: "gpu" }}
            x={positions[0]?.x ?? 8}
            y={gpuY}
            width={boxWidth}
            animated={live}
          />
        ) : null}
      </svg>
      {nodes.some((node) => node.error) ? (
        <details className="sidebar-run-error">
          <summary>Recorded stage failures</summary>
          {nodes
            .filter((node) => node.error)
            .map((node) => (
              <p key={node.label}>
                <strong>{node.label}</strong>: {node.error}
              </p>
            ))}
        </details>
      ) : null}
      <span className="training-muted">{groupLabel}</span>
    </div>
  );
}
