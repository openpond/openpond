import type { ModelProjectTrainingSetup, Taskset } from "@openpond/contracts";
import { DropdownSelect } from "../DropdownSelect";

export function ModelRunEvaluationSource({ tasksets, trainingTaskset, value, onChange }: {
  tasksets: Taskset[];
  trainingTaskset: Taskset | null;
  value: ModelProjectTrainingSetup["evaluationTasksetRef"];
  onChange: (value: ModelProjectTrainingSetup["evaluationTasksetRef"]) => void;
}) {
  const identity = (reference: { id: string; revision: number; contentHash: string }) => `${reference.id}:${reference.revision}:${reference.contentHash}`;
  const candidates = tasksets.filter(taskset => taskset.profileId === trainingTaskset?.profileId
    && taskset.tasks.some(task => task.split === "validation" || task.split === "frozen_eval"));
  const label = (taskset: Taskset) => `${taskset.name} · r${taskset.revision}`;
  const labelCounts = new Map<string, number>();
  for (const taskset of candidates) labelCounts.set(label(taskset), (labelCounts.get(label(taskset)) ?? 0) + 1);
  const selected = value ? identity(value) : "";
  const missing = value && !candidates.some(taskset => identity(taskset) === selected);
  const embedded = trainingTaskset?.tasks.some(task => task.split === "validation" || task.split === "frozen_eval");
  return <div className="model-build-field">
    <span>Held-out evaluation Taskset</span>
    <DropdownSelect label="Held-out evaluation Taskset" value={selected} options={[
      { value: "", label: embedded ? "Use this Taskset's held-out tasks" : "Select a held-out Taskset" },
      ...(missing ? [{ value: selected, label: `${value.id} · r${value.revision} · unavailable`, disabled: true }] : []),
      ...candidates.map(taskset => ({ value: identity(taskset), label: labelCounts.get(label(taskset))! > 1
        ? `${label(taskset)} · ${taskset.contentHash.slice(0, 8)}` : label(taskset) })),
    ]} onChange={key => {
      const taskset = candidates.find(candidate => identity(candidate) === key);
      onChange(taskset ? { id: taskset.id, revision: taskset.revision, contentHash: taskset.contentHash } : null);
    }} />
    <small className="training-muted">OpenPond Managed uses this exact revision and checks that its evaluation families and Reward configuration are compatible.</small>
  </div>;
}
