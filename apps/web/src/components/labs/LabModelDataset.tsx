import { useMemo, useState } from "react";
import type { Taskset, TrainingSourceRef } from "@openpond/contracts";

import { DetailSection } from "../training/DetailSection";
import { LabStatusBadge } from "./LabStatusBadge";

type DatasetSplit = "train" | "validation" | "frozen_eval";
type Task = Taskset["tasks"][number];

const SPLITS: Array<{ id: DatasetSplit; label: string }> = [
  { id: "train", label: "Training" },
  { id: "validation", label: "Validation" },
  { id: "frozen_eval", label: "Frozen Eval" },
];
const INITIAL_EXAMPLE_COUNT = 10;

export function LabModelDataset({
  taskset,
  onOpenFiles,
}: {
  taskset: Taskset;
  onOpenFiles: () => void;
}) {
  const counts = useMemo(() => countBy(taskset.tasks.map((task) => task.split)), [taskset.tasks]);
  const initialSplit = counts.get("train") ? "train" : taskset.tasks[0]?.split ?? "train";
  const [split, setSplit] = useState<DatasetSplit>(
    initialSplit === "test" ? "frozen_eval" : initialSplit,
  );
  const [showAllExamples, setShowAllExamples] = useState(false);
  const sourceById = useMemo(
    () => new Map(taskset.sourceRefs.map((source) => [source.id, source])),
    [taskset.sourceRefs],
  );
  const visibleTasks = taskset.tasks.filter((task) => task.split === split);
  const displayedTasks = showAllExamples
    ? visibleTasks
    : visibleTasks.slice(0, INITIAL_EXAMPLE_COUNT);
  const syntheticSources = taskset.sourceRefs.filter(isSyntheticSource).length;
  const chatSources = taskset.sourceRefs.filter((source) => source.turnIds.length > 0).length;
  const customerSources = taskset.sourceRefs.filter(
    (source) => source.metadata.containsCustomerData === true,
  ).length;
  const approvedDemonstrations = taskset.learningSignals.demonstrations.filter(
    (signal) => signal.approved,
  ).length;

  return (
    <>
      <DetailSection
        title="Dataset"
        actions={(
          <button className="training-button secondary" type="button" onClick={onOpenFiles}>
            Open files
          </button>
        )}
      >
        <p className="labs-detail-copy labs-dataset-summary">
          {datasetDescription({
            syntheticSources,
            chatSources,
            customerSources,
            sourceCount: taskset.sourceRefs.length,
          })}
        </p>
        <dl className="labs-inline-facts">
          <Fact label="Training" value={String(counts.get("train") ?? 0)} />
          <Fact label="Validation" value={String(counts.get("validation") ?? 0)} />
          <Fact label="Frozen Eval" value={String(counts.get("frozen_eval") ?? 0)} />
          <Fact label="Approved demonstrations" value={String(approvedDemonstrations)} />
        </dl>
      </DetailSection>

      <DetailSection title="Examples">
        <div className="labs-method-tabs labs-dataset-tabs" role="tablist" aria-label="Dataset splits">
          {SPLITS.map((item) => (
            <button
              aria-selected={split === item.id}
              className={split === item.id ? "active" : ""}
              key={item.id}
              role="tab"
              type="button"
              onClick={() => {
                setSplit(item.id);
                setShowAllExamples(false);
              }}
            >
              {item.label}
              <span>{counts.get(item.id) ?? 0}</span>
            </button>
          ))}
        </div>
        <div className="labs-dataset-examples">
          {displayedTasks.map((task, index) => (
            <DatasetExample
              index={index}
              key={task.id}
              source={task.sourceRefs.map((sourceId) => sourceById.get(sourceId)).find(Boolean) ?? null}
              task={task}
            />
          ))}
          {visibleTasks.length > INITIAL_EXAMPLE_COUNT ? (
            <button
              className="training-button secondary labs-dataset-show-all"
              type="button"
              onClick={() => setShowAllExamples((current) => !current)}
            >
              {showAllExamples ? `Show first ${INITIAL_EXAMPLE_COUNT}` : `Show all ${visibleTasks.length}`}
            </button>
          ) : null}
        </div>
      </DetailSection>
    </>
  );
}

function DatasetExample({
  index,
  source,
  task,
}: {
  index: number;
  source: TrainingSourceRef | null;
  task: Task;
}) {
  const prompt = taskPrompt(task);
  const toolNames = expectedToolNames(task);
  const finalAnswer = expectedFinalAnswer(task);
  const sourceLabel = source ? sourceKind(source) : "Source unavailable";
  const family = taskFamily(task, source);
  const difficulty = taskDifficulty(task, source);

  return (
    <details className="labs-dataset-example">
      <summary>
        <span className="labs-dataset-example-index">{String(index + 1).padStart(2, "0")}</span>
        <span className="labs-dataset-example-title">
          <strong>{prompt}</strong>
          <small>{[family, difficulty, sourceLabel].filter(Boolean).join(" · ")}</small>
        </span>
        <LabStatusBadge label={splitLabel(task.split)} value={task.split} />
      </summary>
      <div className="labs-dataset-example-body">
        <section>
          <h3>Prompt</h3>
          <p>{prompt}</p>
        </section>
        <section>
          <h3>{task.split === "frozen_eval" ? "Expected result" : "Approved answer"}</h3>
          {task.split === "frozen_eval" ? (
            <p>The answer stays held out and is only opened by the Eval runner.</p>
          ) : (
            <pre>{finalAnswer ?? "No approved answer is attached."}</pre>
          )}
        </section>
        {toolNames.length ? (
          <section>
            <h3>Tool trajectory</h3>
            <div className="training-pills">
              {toolNames.map((name, toolIndex) => (
                <span key={`${name}:${toolIndex}`}>{name}</span>
              ))}
            </div>
          </section>
        ) : null}
        <section>
          <h3>Source</h3>
          <p>
            <strong>{source?.title ?? "Source unavailable"}</strong>
            {" — "}
            {sourceDescription(source)}
          </p>
        </section>
        <details className="labs-dataset-example-advanced">
          <summary>Technical details</summary>
          <dl className="training-configuration-list">
            <Fact label="Task" value={task.id} />
            <Fact label="Source" value={source?.id ?? "Unavailable"} />
            <Fact label="Cluster" value={task.clusterKey} />
          </dl>
        </details>
      </div>
    </details>
  );
}

function datasetDescription(input: {
  syntheticSources: number;
  chatSources: number;
  customerSources: number;
  sourceCount: number;
}): string {
  if (
    input.sourceCount > 0
    && input.syntheticSources === input.sourceCount
    && input.chatSources === 0
    && input.customerSources === 0
  ) {
    return `This dataset contains ${input.sourceCount} generated scenarios. It uses no raw chats or customer data.`;
  }
  const parts = [
    `${input.sourceCount} source${input.sourceCount === 1 ? "" : "s"}`,
    `${input.chatSources} chat${input.chatSources === 1 ? "" : "s"}`,
    `${input.syntheticSources} generated scenario${input.syntheticSources === 1 ? "" : "s"}`,
  ];
  if (input.customerSources === 0) parts.push("no sources marked as customer data");
  else parts.push(`${input.customerSources} source${input.customerSources === 1 ? "" : "s"} marked as customer data`);
  return `This dataset contains ${parts.join(", ")}.`;
}

function taskPrompt(task: Task): string {
  return typeof task.input.prompt === "string"
    ? task.input.prompt
    : "Untitled dataset example";
}

function expectedFinalAnswer(task: Task): string | null {
  if (!task.expectedOutput) return null;
  if (typeof task.expectedOutput.text === "string") return task.expectedOutput.text;
  const messages = Array.isArray(task.expectedOutput.messages)
    ? task.expectedOutput.messages
    : [];
  for (const message of [...messages].reverse()) {
    if (
      message
      && typeof message === "object"
      && "content" in message
      && typeof message.content === "string"
    ) return message.content;
  }
  return null;
}

function expectedToolNames(task: Task): string[] {
  if (!task.expectedOutput || !Array.isArray(task.expectedOutput.messages)) return [];
  const names: string[] = [];
  for (const message of task.expectedOutput.messages) {
    if (!message || typeof message !== "object" || !("tool_calls" in message)) continue;
    const calls = Array.isArray(message.tool_calls) ? message.tool_calls : [];
    for (const call of calls) {
      if (!call || typeof call !== "object" || !("function" in call)) continue;
      const fn = call.function;
      if (fn && typeof fn === "object" && "name" in fn && typeof fn.name === "string") {
        names.push(fn.name);
      }
    }
  }
  return names;
}

function taskFamily(task: Task, source: TrainingSourceRef | null): string | null {
  const crossSystem = source?.metadata.crossSystemOperations;
  if (crossSystem && typeof crossSystem === "object" && "taskFamily" in crossSystem) {
    const family = crossSystem.taskFamily;
    if (typeof family === "string") return titleCase(family);
  }
  const familyTag = task.tags.find((tag) => !["synthetic", "structured-tool-trajectory"].includes(tag));
  return familyTag ? titleCase(familyTag) : null;
}

function taskDifficulty(task: Task, source: TrainingSourceRef | null): string | null {
  const crossSystem = source?.metadata.crossSystemOperations;
  if (crossSystem && typeof crossSystem === "object" && "worldDifficulty" in crossSystem) {
    const difficulty = crossSystem.worldDifficulty;
    if (typeof difficulty === "string") return titleCase(difficulty);
  }
  return task.clusterKey.match(/_(easy|medium|hard)$/)?.[1] ?? null;
}

function isSyntheticSource(source: TrainingSourceRef): boolean {
  return source.metadata.syntheticSpecification === true;
}

function sourceKind(source: TrainingSourceRef): string {
  if (isSyntheticSource(source)) return "Generated scenario";
  if (source.turnIds.length > 0) return "Chat";
  return "Imported source";
}

function sourceDescription(source: TrainingSourceRef | null): string {
  if (!source) return "The referenced source could not be loaded.";
  if (isSyntheticSource(source) && source.metadata.containsCustomerData === false) {
    return "generated locally from a deterministic specification; no customer content is attached.";
  }
  if (source.turnIds.length > 0) {
    return `${source.turnIds.length} approved chat turn${source.turnIds.length === 1 ? "" : "s"} are attached.`;
  }
  return "an approved imported source is attached.";
}

function splitLabel(split: string): string {
  if (split === "frozen_eval") return "Frozen Eval";
  return titleCase(split);
}

function titleCase(value: string): string {
  return value
    .replaceAll("-", " ")
    .replaceAll("_", " ")
    .replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function countBy(values: string[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1);
  return counts;
}

function Fact({ label, value }: { label: string; value: string }) {
  return <div><dt>{label}</dt><dd>{value}</dd></div>;
}
