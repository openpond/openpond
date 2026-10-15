import { useEffect, useId, useRef, useState } from "react";
import "./run-flow-diagram.css";

export type RunFlowNode = {
  label: string;
  compute?: "gpu" | "cpu";
  state: "done" | "active" | "pending" | "missing";
  status: string;
  detail?: string;
  progress?: number;
  inLoop?: boolean;
};

/** Console run-stage presentation, reflowed to keep labels readable in a sidebar. */
export function RunFlowDiagram({
  nodes,
  live,
  loopLabel,
  inference,
}: {
  nodes: RunFlowNode[];
  live: boolean;
  loopLabel?: string;
  inference?: RunFlowNode;
}) {
  const container = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(480);
  const marker = useId().replace(/[^\w-]/g, "");
  useEffect(() => {
    const element = container.current;
    if (!element) return;
    const observer = new ResizeObserver((entries) =>
      setWidth(Math.max(220, entries[0]!.contentRect.width)),
    );
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  const columns = Math.max(1, Math.min(nodes.length, 4, Math.floor((width - 32) / 174)));
  const gap = 36,
    boxHeight = 72,
    rowHeight = 104;
  const top = loopLabel ? 40 : 12;
  const boxWidth = (width - 40 - gap * (columns - 1)) / columns;
  const positions = nodes.map((_, index) => {
    const row = Math.floor(index / columns),
      column = index % columns;
    const rowColumns = Math.min(columns, nodes.length - row * columns);
    const rowWidth = rowColumns * boxWidth + (rowColumns - 1) * gap;
    return {
      x: (width - rowWidth) / 2 + (row % 2 ? rowColumns - column - 1 : column) * (boxWidth + gap),
      y: top + row * rowHeight,
    };
  });
  const rows = Math.ceil(nodes.length / columns);
  const height = top + (rows - 1) * rowHeight + boxHeight + 16 + (inference ? rowHeight : 0);
  const loop = positions.filter((_, index) => nodes[index]?.inLoop);
  const loopActive = live && nodes.some((node) => node.inLoop && node.state === "active");
  const links = positions.slice(1).map((position, index) => {
    const previous = positions[index]!;
    const sameRow = previous.y === position.y;
    const right = position.x > previous.x;
    const path = sameRow
      ? `M${previous.x + (right ? boxWidth : 0)} ${previous.y + boxHeight / 2} H${position.x + (right ? 0 : boxWidth)}`
      : `M${previous.x + boxWidth / 2} ${previous.y + boxHeight} V${previous.y + boxHeight + (rowHeight - boxHeight) / 2} H${position.x + boxWidth / 2} V${position.y}`;
    return {
      path,
      active: live && (nodes[index]?.state === "active" || nodes[index + 1]?.state === "active"),
      done: nodes[index]?.state === "done",
    };
  });
  return (
    <div ref={container} className="run-flow" aria-label="Run stages">
      <svg
        className="run-flow-diagram"
        viewBox={`0 0 ${width} ${height}`}
        role="img"
        aria-label={nodes
          .map((node) => `${node.label}: ${node.status}${node.detail ? `, ${node.detail}` : ""}`)
          .join(". ")}
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
        {loop.length && loopLabel ? (
          <g>
            <rect
              className={`run-flow-loop ${loopActive ? "live" : ""}`}
              x={8}
              y={Math.min(...loop.map((p) => p.y)) - 28}
              width={width - 16}
              height={
                Math.max(...loop.map((p) => p.y)) -
                Math.min(...loop.map((p) => p.y)) +
                boxHeight +
                48
              }
              rx={12}
            />
            <text className="run-flow-caption" x={20} y={Math.min(...loop.map((p) => p.y)) - 12}>
              {loopLabel}
            </text>
          </g>
        ) : null}
        {links.map((link, index) => (
          <g key={index}>
            <path
              d={link.path}
              className={`run-flow-wire ${link.done ? "done" : ""}`}
              markerEnd={`url(#${marker})`}
            />
            {link.active ? <FlowPackets path={link.path} /> : null}
          </g>
        ))}
        {loopActive && loop.length > 1 ? (
          <path
            className="run-flow-stream"
            d={`M${width - 8} ${Math.max(...loop.map((p) => p.y)) + 16} V${Math.min(...loop.map((p) => p.y)) - 12}`}
            markerEnd={`url(#${marker})`}
          />
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
          <g>
            <FlowBox
              node={inference}
              x={20}
              y={40 + rows * rowHeight}
              width={boxWidth}
              animated={live}
            />
            <path
              className="run-flow-wire"
              d={`M${20 + boxWidth / 2} ${40 + rows * rowHeight} V${40 + rows * rowHeight - 26} H${width - 4} V${positions.find((_, index) => nodes[index]?.label.includes("Roll"))?.y ?? 40}`}
            />
            {live && inference.state === "active" ? (
              <FlowPackets
                path={`M${20 + boxWidth / 2} ${40 + rows * rowHeight} V${40 + rows * rowHeight - 26} H${width - 4}`}
              />
            ) : null}
          </g>
        ) : null}
      </svg>
    </div>
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
      : ["Rollouts", "Update adapter", "Activate policy", "Evaluate"].includes(node.label)
        ? "gpu"
        : undefined);
  return (
    <g
      className={`run-flow-node ${node.state} ${compute ? `compute-${compute}` : ""}`}
      aria-current={active ? "step" : undefined}
    >
      <title>
        {node.label}: {node.status}
        {compute ? ` (${compute.toUpperCase()})` : ""}
        {node.detail ? ` — ${node.detail}` : ""}
      </title>
      {active && animated ? (
        <rect className="run-flow-halo" x={x - 4} y={y - 4} width={width + 8} height={80} rx={14} />
      ) : null}
      <rect className="run-flow-box" x={x} y={y} width={width} height={72} rx={10} />
      {node.state === "done" ? (
        <path className="run-flow-check" d={`M${x + width - 17} ${y + 11} l2.5 2.5 l5 -5`} />
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
}: {
  nodes: RunFlowNode[];
  inference: RunFlowNode | null;
  live: boolean;
  loopLabel: string;
  groupLabel: string;
  policyLabel?: string;
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
        role="img"
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
            </text>
          </g>
        ) : null}
        {wires.map((wire) => (
          <g key={wire.id}>
            <path className="run-flow-wire" d={wire.path} markerEnd={`url(#${marker})`} />
            {wire.active ? <FlowPackets path={wire.path} /> : null}
          </g>
        ))}
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
      <span className="training-muted">{groupLabel}</span>
    </div>
  );
}
