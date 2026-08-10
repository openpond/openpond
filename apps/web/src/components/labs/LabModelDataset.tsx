import { useEffect, useMemo, useState } from "react";
import {
  isTrainingSourceRef,
  TaskDataRecordSchema,
  type ChatModelRef,
  type DatasetArtifactSummary,
  type TaskDataRecord,
  type Taskset,
  type TasksetSourceRef,
} from "@openpond/contracts";

import type { ShowAppToast } from "../../app/app-state";
import { DetailSection } from "../training/DetailSection";
import type { useTraining } from "../../hooks/useTraining";
import { LabStatusBadge } from "./LabStatusBadge";

type DatasetSplit = "train" | "validation" | "frozen_eval";
type DatasetDetailTab = "overview" | "cases" | "scoring";
type Task = Taskset["tasks"][number];

const SPLITS: Array<{ id: DatasetSplit; label: string }> = [
  { id: "train", label: "Training" },
  { id: "validation", label: "Validation" },
  { id: "frozen_eval", label: "Frozen Eval" },
];
const EXAMPLE_PAGE_SIZE = 10;
export function LabModelDataset({
  artifact,
  defaultModel,
  tab = "overview",
  taskset,
  onOpenFiles,
  onToast,
  training,
}: {
  artifact: DatasetArtifactSummary | null;
  defaultModel: ChatModelRef;
  tab?: DatasetDetailTab;
  taskset: Taskset;
  onOpenFiles: () => void;
  onToast: ShowAppToast;
  training: ReturnType<typeof useTraining>;
}) {
  const counts = useMemo(
    () => artifact
      ? new Map(Object.entries(artifact.splitCounts))
      : countBy(taskset.tasks.map((task) => task.split)),
    [artifact, taskset.tasks],
  );
  const initialSplit = counts.get("train")
    ? "train"
    : counts.get("validation")
      ? "validation"
      : counts.get("frozen_eval")
        ? "frozen_eval"
        : taskset.tasks[0]?.split ?? "train";
  const [split, setSplit] = useState<DatasetSplit>(
    initialSplit === "test" ? "frozen_eval" : initialSplit,
  );
  const [inlinePage, setInlinePage] = useState(1);
  const [artifactRows, setArtifactRows] = useState<TaskDataRecord[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [cursorHistory, setCursorHistory] = useState<string[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [rowsLoading, setRowsLoading] = useState(false);
  const [rowsError, setRowsError] = useState<string | null>(null);
  const [checkMessage, setCheckMessage] = useState<string | null>(null);
  const sourceById = useMemo(
    () => new Map(taskset.sourceRefs.map((source) => [source.id, source])),
    [taskset.sourceRefs],
  );
  useEffect(() => {
    if (tab !== "cases" || !artifact) return undefined;
    let cancelled = false;
    setRowsLoading(true);
    setRowsError(null);
    void training.actions.datasetRows(taskset.id, {
      split,
      cursor,
      limit: EXAMPLE_PAGE_SIZE,
    }).then((page) => {
      if (cancelled || !page) return;
      setArtifactRows(page.rows.map((row) => TaskDataRecordSchema.parse(row)));
      setNextCursor(page.nextCursor);
    }).catch((error) => {
      if (!cancelled) {
        setArtifactRows([]);
        setNextCursor(null);
        setRowsError(error instanceof Error ? error.message : String(error));
      }
    }).finally(() => {
      if (!cancelled) setRowsLoading(false);
    });
    return () => {
      cancelled = true;
    };
  }, [artifact, cursor, split, tab, taskset.id, training.actions]);

  const visibleTasks = artifact
    ? artifactRows
    : taskset.tasks.filter((task) => task.split === split);
  const inlinePages = Math.max(
    1,
    Math.ceil(visibleTasks.length / EXAMPLE_PAGE_SIZE),
  );
  const displayedTasks = artifact
    ? visibleTasks
    : visibleTasks.slice(
        (inlinePage - 1) * EXAMPLE_PAGE_SIZE,
        inlinePage * EXAMPLE_PAGE_SIZE,
      );
  const exampleIndexOffset = artifact
    ? cursorHistory.length * EXAMPLE_PAGE_SIZE
    : (inlinePage - 1) * EXAMPLE_PAGE_SIZE;
  const syntheticSources = taskset.sourceRefs.filter(isSyntheticSource).length;
  const chatSources = taskset.sourceRefs.filter(
    (source) => isTrainingSourceRef(source) && source.turnIds.length > 0,
  ).length;
  const customerSources = taskset.sourceRefs.filter(
    (source) => source.metadata.containsCustomerData === true,
  ).length;
  const approvedDemonstrations = taskset.learningSignals.demonstrations.filter(
    (signal) => signal.approved,
  ).length;
  const approvedPreferences = taskset.learningSignals.preferences.filter(
    (signal) => signal.approved,
  ).length;
  const approvedRewards = taskset.learningSignals.rewards.filter(
    (signal) => signal.approved,
  ).length;
  const rubricLabels = taskset.learningSignals.labels.filter(
    (signal) => signal.approved && signal.labelKind === "rubric",
  ).length;
  const hasModelJudge = taskset.graders.some((grader) => grader.kind === "model_judge");
  const workTask = taskset.environment.kind === "work"
    ? taskset.tasks.find((task) => task.split !== "frozen_eval") ?? null
    : null;

  async function runCheck(
    label: string,
    action: () => Promise<unknown>,
  ): Promise<void> {
    setCheckMessage(null);
    const result = await action();
    if (!result) {
      setCheckMessage(`${label} did not complete. Check the latest error and try again.`);
      return;
    }
    setCheckMessage(`${label} started or completed successfully.`);
    onToast(`${label} started or completed successfully.`, "success");
  }

  if (tab === "overview") {
    return (
      <DetailSection
        title="Taskset"
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
          <Fact label="Demonstrations" value={String(approvedDemonstrations)} />
          <Fact label="Preference pairs" value={String(approvedPreferences)} />
          <Fact label="Reward specs" value={String(approvedRewards)} />
          <Fact label="Rubrics" value={String(rubricLabels)} />
        </dl>
        {taskset.purpose === "benchmark" && taskset.benchmark ? (
          <div className="labs-dataset-method-readiness">
            <strong>Benchmark protocol</strong>
            <div className="training-pills">
              <span>{titleCase(taskset.benchmark.primaryMetric.replaceAll("_", " "))}</span>
              <span>{titleCase(taskset.benchmark.qualityGate.replaceAll("_", " "))}</span>
              <span>Immutable release</span>
            </div>
            <p className="labs-detail-copy">
              Adapt on {titleCase(taskset.benchmark.adaptationSplit)} cases and compare
              paired {titleCase(taskset.benchmark.evaluationSplit.replaceAll("_", " "))} runs.
            </p>
          </div>
        ) : (
          <div className="labs-dataset-method-readiness">
            <strong>Training compatibility</strong>
            <div className="training-pills">
              {taskset.readiness?.methodReadiness.length
                ? taskset.readiness.methodReadiness.map((entry) => (
                  <span key={entry.method} title={entry.reasons.join(" ")}>
                    {entry.method.toUpperCase()} · {titleCase(entry.status)}
                  </span>
                ))
                : taskset.capabilities.compatibleMethods
                    .filter((method) => !["none", "retrieval"].includes(method))
                    .map((method) => <span key={method}>{method.toUpperCase()}</span>)}
            </div>
            {taskset.readiness?.methodReadiness.some((entry) => entry.reasons.length) ? (
              <ul>
                {taskset.readiness.methodReadiness.flatMap((entry) =>
                  entry.reasons.map((reason) => (
                    <li key={`${entry.method}:${reason}`}><strong>{entry.method.toUpperCase()}:</strong> {reason}</li>
                  )))}
              </ul>
            ) : null}
          </div>
        )}
        <details className="labs-dataset-advanced-details">
          <summary>Technical details</summary>
          <dl className="training-configuration-list">
            <Fact label="Taskset ID" value={taskset.id} />
            <Fact label="Revision" value={String(taskset.revision)} />
            <Fact
              label="Format"
              value={artifact?.format.toUpperCase() ?? "Inline Taskset"}
            />
            <Fact
              label="Rows"
              value={String(artifact?.rowCount ?? taskset.tasks.length)}
            />
            <Fact
              label="Storage"
              value={artifact ? formatBytes(artifact.sizeBytes) : "Managed inline"}
            />
            <Fact
              label="Availability"
              value={
                artifact?.available === false
                  ? artifact.unavailableReason ?? "Unavailable"
                  : "Available"
              }
            />
            <Fact
              label="Content hash"
              value={artifact?.contentHash ?? taskset.contentHash}
            />
          </dl>
          <button
            className="training-button secondary"
            type="button"
            onClick={onOpenFiles}
          >
            Open files
          </button>
        </details>
      </DetailSection>
    );
  }

  if (tab === "scoring") {
    return (
      <>
        {taskset.purpose === "benchmark" ? (
          <DetailSection title="Benchmark runs">
            <p className="labs-detail-copy">
              Harness Refiner runs start from a Model so the selected Model,
              effort, full protocol, result charts, and Git-backed receipt stay
              together in one evaluation run. Open a Model and choose
              <strong> Run Refiner Benchmark</strong>.
            </p>
          </DetailSection>
        ) : null}
        <DetailSection title="Taskset checks">
          <p className="labs-detail-copy">
            Audit the reward and graders before creating a Model run.
          </p>
          <div className="labs-dataset-detail-actions">
            {workTask ? (
              <button
                className="training-button secondary"
                disabled={training.busyAction !== null}
                type="button"
                onClick={() => void runCheck(
                  "Work attempt",
                  () => training.actions.executeTasksetAttempt(
                    taskset.id,
                    workTask.id,
                    defaultModel,
                  ),
                )}
              >
                Run Work attempt
              </button>
            ) : null}
            <button
              className="training-button secondary"
              disabled={training.busyAction !== null}
              type="button"
              onClick={() => void runCheck(
                "Grader audit",
                () => training.actions.auditGraders(taskset.id),
              )}
            >
              Audit graders
            </button>
            {hasModelJudge ? (
              <button
                className="training-button secondary"
                disabled={training.busyAction !== null}
                type="button"
                onClick={() => void runCheck(
                  "Judge calibration",
                  () => training.actions.calibrateJudges(taskset.id),
                )}
              >
                Calibrate judges
              </button>
            ) : null}
            <button
              className="training-button secondary"
              disabled={training.busyAction !== null}
              type="button"
              onClick={() => void runCheck(
                "Readiness check",
                () => training.actions.readiness(taskset.id),
              )}
            >
              Refresh readiness
            </button>
          </div>
          {checkMessage ? <p className="labs-detail-copy" role="status">{checkMessage}</p> : null}
          {taskset.readiness?.blockers.length ? (
            <div className="training-banner warning">
              <strong>Readiness blockers</strong>
              <ul>
                {taskset.readiness.blockers.map((blocker) => (
                  <li key={`${blocker.code}:${blocker.path ?? ""}`}>{blocker.message}</li>
                ))}
              </ul>
            </div>
          ) : null}
        </DetailSection>
        <DetailSection title="Graders">
          <div className="labs-dataset-grader-list">
            {taskset.graders.map((grader) => (
              <div key={grader.id}>
                <strong>{grader.label}</strong>
                <small>{titleCase(grader.kind)}</small>
              </div>
            ))}
          </div>
        </DetailSection>
      </>
    );
  }

  return (
      <DetailSection title="Cases">
        <div className="labs-method-tabs labs-dataset-tabs" role="tablist" aria-label="Taskset splits">
          {SPLITS.map((item) => (
            <button
              aria-selected={split === item.id}
              className={split === item.id ? "active" : ""}
              key={item.id}
              role="tab"
              type="button"
              onClick={() => {
                setSplit(item.id);
                setInlinePage(1);
                setCursor(null);
                setCursorHistory([]);
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
              index={exampleIndexOffset + index}
              key={task.id}
              source={task.sourceRefs.map((sourceId) => sourceById.get(sourceId)).find(Boolean) ?? null}
              task={task}
            />
          ))}
          {artifact ? (
            <nav className="labs-pagination" aria-label="Task data pages">
              <button
                type="button"
                disabled={!cursorHistory.length || rowsLoading}
                onClick={() => {
                  const previous = cursorHistory.at(-1) ?? null;
                  setCursorHistory((history) => history.slice(0, -1));
                  setCursor(previous || null);
                }}
              >
                Previous
              </button>
              <span>
                {rowsLoading
                  ? "Loading…"
                  : `Page ${cursorHistory.length + 1} · ${artifactRows.length.toLocaleString()} rows`}
              </span>
              <button
                type="button"
                disabled={!nextCursor || rowsLoading}
                onClick={() => {
                  setCursorHistory((history) => [...history, cursor ?? ""]);
                  setCursor(nextCursor);
                }}
              >
                Next
              </button>
            </nav>
          ) : inlinePages > 1 ? (
            <nav className="labs-pagination" aria-label="Task data pages">
              <button
                type="button"
                disabled={inlinePage <= 1}
                onClick={() => setInlinePage((page) => Math.max(1, page - 1))}
              >
                Previous
              </button>
              <span>{inlinePage} of {inlinePages}</span>
              <button
                type="button"
                disabled={inlinePage >= inlinePages}
                onClick={() =>
                  setInlinePage((page) => Math.min(inlinePages, page + 1))
                }
              >
                Next
              </button>
            </nav>
          ) : null}
          {rowsError ? (
            <div className="training-banner error" role="alert">{rowsError}</div>
          ) : null}
        </div>
      </DetailSection>
  );
}


function DatasetExample({
  index,
  source,
  task,
}: {
  index: number;
  source: TasksetSourceRef | null;
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

function taskFamily(task: Task, source: TasksetSourceRef | null): string | null {
  const crossSystem = source?.metadata.crossSystemOperations;
  if (crossSystem && typeof crossSystem === "object" && "taskFamily" in crossSystem) {
    const family = crossSystem.taskFamily;
    if (typeof family === "string") return titleCase(family);
  }
  const familyTag = task.tags.find((tag) => !["synthetic", "structured-tool-trajectory"].includes(tag));
  return familyTag ? titleCase(familyTag) : null;
}

function taskDifficulty(task: Task, source: TasksetSourceRef | null): string | null {
  const crossSystem = source?.metadata.crossSystemOperations;
  if (crossSystem && typeof crossSystem === "object" && "worldDifficulty" in crossSystem) {
    const difficulty = crossSystem.worldDifficulty;
    if (typeof difficulty === "string") return titleCase(difficulty);
  }
  return task.clusterKey.match(/_(easy|medium|hard)$/)?.[1] ?? null;
}

function isSyntheticSource(source: TasksetSourceRef): boolean {
  return (
    source.schemaVersion === "openpond.generatedDatasetSource.v1"
    || source.metadata.syntheticSpecification === true
  );
}

function sourceKind(source: TasksetSourceRef): string {
  if (isSyntheticSource(source)) return "Generated scenario";
  if (isTrainingSourceRef(source) && source.turnIds.length > 0) return "Chat";
  if (source.schemaVersion === "openpond.huggingFaceDatasetSource.v1") {
    return "Hugging Face";
  }
  if (source.schemaVersion === "openpond.uploadedFileDatasetSource.v1") {
    return "Uploaded file";
  }
  return "Imported source";
}

function sourceDescription(source: TasksetSourceRef | null): string {
  if (!source) return "The referenced source could not be loaded.";
  if (isSyntheticSource(source) && source.metadata.containsCustomerData === false) {
    return "generated locally from a deterministic specification; no customer content is attached.";
  }
  if (isTrainingSourceRef(source) && source.turnIds.length > 0) {
    return `${source.turnIds.length} approved chat turn${source.turnIds.length === 1 ? "" : "s"} are attached.`;
  }
  if (source.schemaVersion === "openpond.huggingFaceDatasetSource.v1") {
    return `${source.repositoryId}@${source.revision.slice(0, 12)} is attached.`;
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

function formatBytes(value: number): string {
  if (value < 1_024) return `${value} B`;
  if (value < 1_048_576) return `${(value / 1_024).toFixed(1)} KB`;
  if (value < 1_073_741_824) return `${(value / 1_048_576).toFixed(1)} MB`;
  return `${(value / 1_073_741_824).toFixed(1)} GB`;
}

function Fact({ label, value }: { label: string; value: string }) {
  return <div><dt>{label}</dt><dd>{value}</dd></div>;
}
