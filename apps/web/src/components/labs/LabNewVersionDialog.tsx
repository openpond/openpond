import { useMemo, useState } from "react";
import type { Taskset, TrainingStateResponse } from "@openpond/contracts";

import { X } from "../icons";
import { trainingMethodLabel } from "../training/training-model-data";

export function LabNewVersionDialog({
  state,
  initialTasksetId,
  onClose,
  onContinue,
}: {
  state: TrainingStateResponse | null;
  initialTasksetId: string | null;
  onClose: () => void;
  onContinue: (selection: {
    taskset: Taskset;
    method: "sft" | "grpo";
  }) => void;
}) {
  const datasets = useMemo(
    () =>
      (state?.tasksets ?? [])
        .filter((taskset) => taskset.readiness?.ready)
        .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt)),
    [state?.tasksets],
  );
  const [tasksetId, setTasksetId] = useState(
    initialTasksetId &&
      datasets.some((taskset) => taskset.id === initialTasksetId)
      ? initialTasksetId
      : datasets[0]?.id ?? "",
  );
  const selected =
    datasets.find((taskset) => taskset.id === tasksetId) ?? null;
  const methods = selected ? selectableMethods(selected) : [];
  const [method, setMethod] = useState<"sft" | "grpo">(
    selected?.readiness?.recommendedMethod === "grpo" ? "grpo" : "sft",
  );
  const effectiveMethod = methods.includes(method)
    ? method
    : methods[0] ?? "sft";

  return (
    <div
      className="training-dialog-backdrop"
      role="presentation"
      onMouseDown={onClose}
    >
      <section
        aria-label="New version"
        aria-modal="true"
        className="training-dialog labs-new-version-dialog"
        role="dialog"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <div className="training-dialog-header">
          <div>
            <h2>New version</h2>
            <p>Choose the immutable Dataset revision and training method.</p>
          </div>
          <button aria-label="Close New version" type="button" onClick={onClose}>
            <X size={16} />
          </button>
        </div>

        <div className="labs-new-version-step">
          <span className="labs-new-version-step-number">1</span>
          <div>
            <strong>Dataset</strong>
            <p>Every run keeps the exact selected revision and Eval boundary.</p>
          </div>
        </div>
        <label className="labs-new-version-select">
          <span>Dataset revision</span>
          <select
            value={tasksetId}
            onChange={(event) => {
              const nextId = event.target.value;
              setTasksetId(nextId);
              const next = datasets.find((item) => item.id === nextId);
              const nextMethods = next ? selectableMethods(next) : [];
              setMethod(
                nextMethods.includes(effectiveMethod)
                  ? effectiveMethod
                  : nextMethods[0] ?? "sft",
              );
            }}
          >
            {datasets.map((taskset) => (
              <option key={taskset.id} value={taskset.id}>
                {taskset.name} · revision {taskset.revision}
              </option>
            ))}
          </select>
        </label>
        {selected ? (
          <dl className="labs-inline-facts labs-new-version-dataset-facts">
            <Fact
              label="Training"
              value={String(splitCount(selected, "train"))}
            />
            <Fact
              label="Validation"
              value={String(splitCount(selected, "validation"))}
            />
            <Fact
              label="Frozen Eval"
              value={String(splitCount(selected, "frozen_eval"))}
            />
            <Fact label="Graders" value={String(selected.graders.length)} />
          </dl>
        ) : (
          <div className="training-run-placeholder">
            No ready Dataset is available. Create or finish a Dataset first.
          </div>
        )}

        <div className="labs-new-version-step">
          <span className="labs-new-version-step-number">2</span>
          <div>
            <strong>Training method</strong>
            <p>SFT and RFT create Versions of the same Model.</p>
          </div>
        </div>
        <div
          aria-label="Version training method"
          className="labs-method-tabs"
          role="tablist"
        >
          {methods.map((candidate) => (
            <button
              aria-selected={candidate === effectiveMethod}
              className={candidate === effectiveMethod ? "active" : ""}
              key={candidate}
              role="tab"
              type="button"
              onClick={() => setMethod(candidate)}
            >
              <span>
                {candidate === "grpo" ? "Reinforcement" : "Supervised"}
              </span>
              <strong>{trainingMethodLabel(candidate)}</strong>
            </button>
          ))}
        </div>

        <div className="training-dialog-actions">
          <button
            className="training-button secondary"
            type="button"
            onClick={onClose}
          >
            Cancel
          </button>
          <button
            className="training-button"
            disabled={!selected || methods.length === 0}
            type="button"
            onClick={() => {
              if (selected) {
                onContinue({ taskset: selected, method: effectiveMethod });
              }
            }}
          >
            Continue
          </button>
        </div>
      </section>
    </div>
  );
}

function selectableMethods(taskset: Taskset): Array<"sft" | "grpo"> {
  const methods = new Set<"sft" | "grpo">();
  for (const method of taskset.capabilities.compatibleMethods) {
    if (method === "sft" || method === "grpo") methods.add(method);
  }
  if (taskset.readiness?.trainingPath?.bootstrap?.method === "sft") {
    methods.add("sft");
  }
  if (taskset.readiness?.trainingPath?.primaryMethod === "grpo") {
    methods.add("grpo");
  }
  return (["sft", "grpo"] as const).filter((method) => methods.has(method));
}

function splitCount(
  taskset: Taskset,
  split: Taskset["tasks"][number]["split"],
): number {
  return taskset.tasks.filter((task) => task.split === split).length;
}

function Fact({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt>{label}</dt>
      <dd>{value}</dd>
    </div>
  );
}
