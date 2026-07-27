import type {
  DatasetBuildIntent,
  DatasetBuildSpecification,
} from "@openpond/contracts";
import type { ReactNode } from "react";
import { Plus, Trash2 } from "../icons";

export function emptyBuildSpecification(
  intent: Exclude<DatasetBuildIntent, "discovery">,
): DatasetBuildSpecification {
  if (intent === "demonstrations") {
    return { kind: intent, behavior: "", examples: [] };
  }
  if (intent === "preferences") {
    return { kind: intent, preference: "", pairs: [] };
  }
  if (intent === "verifiable_reward") {
    return { kind: intent, task: "", rules: [], otherwisePoints: 0 };
  }
  return {
    kind: "rubric",
    task: "",
    criteria: [],
    positiveExample: "",
    negativeExample: "",
    boundaryExample: "",
  };
}

export function buildSpecificationReady(
  specification: DatasetBuildSpecification | null,
): boolean {
  if (!specification) return false;
  if (specification.kind === "demonstrations") {
    return Boolean(specification.behavior.trim())
      && specification.examples.every((example) =>
        Boolean(example.prompt.trim() && example.response.trim()));
  }
  if (specification.kind === "preferences") {
    return Boolean(specification.preference.trim())
      && specification.pairs.every((pair) =>
        Boolean(pair.prompt.trim() && pair.chosen.trim() && pair.rejected.trim()));
  }
  if (specification.kind === "verifiable_reward") {
    return Boolean(specification.task.trim())
      && specification.rules.length > 0
      && specification.rules.every((rule) => Boolean(rule.condition.trim()));
  }
  if (specification.kind === "agent_benchmark") {
    const familyIds = new Set(
      specification.promptFamilies.map((family) => family.id),
    );
    return Boolean(specification.task.trim())
      && familyIds.size === specification.promptFamilies.length
      && specification.promptFamilies.every((family) =>
        Boolean(family.id.trim() && family.prompt.trim()))
      && ["train", "validation", "frozen_eval"].every((split) =>
        specification.promptFamilies.some((family) => family.split === split));
  }
  return Boolean(
    specification.task.trim()
    && specification.criteria.length > 0
    && specification.criteria.every((criterion) =>
      Boolean(criterion.label.trim() && criterion.description.trim()))
    && specification.positiveExample.trim()
    && specification.negativeExample.trim()
    && specification.boundaryExample.trim(),
  );
}

export function TrainingEvidenceEditor({
  disabled,
  specification,
  onChange,
}: {
  disabled: boolean;
  specification: DatasetBuildSpecification;
  onChange: (specification: DatasetBuildSpecification) => void;
}) {
  if (specification.kind === "demonstrations") {
    return (
      <section className="training-signal-editor" aria-label="Demonstration evidence">
        <EditorHeading
          title="Describe the behavior"
          description="Add prompt and approved-response examples now, or use supporting chats below."
        />
        <TextField label="Behavior to teach" value={specification.behavior} disabled={disabled} onChange={(behavior) => onChange({ ...specification, behavior })} />
        {specification.examples.map((example, index) => (
          <EditorCard key={example.id} label={`Example ${index + 1}`} disabled={disabled} onRemove={() => onChange({ ...specification, examples: specification.examples.filter((item) => item.id !== example.id) })}>
            <TextField label="Prompt" value={example.prompt} disabled={disabled} onChange={(prompt) => onChange({ ...specification, examples: specification.examples.map((item) => item.id === example.id ? { ...item, prompt } : item) })} />
            <TextField label="Approved response" value={example.response} disabled={disabled} onChange={(response) => onChange({ ...specification, examples: specification.examples.map((item) => item.id === example.id ? { ...item, response } : item) })} />
          </EditorCard>
        ))}
        <AddButton disabled={disabled} label="Add example" onClick={() => onChange({ ...specification, examples: [...specification.examples, { id: nextId("example", specification.examples.map((item) => item.id)), prompt: "", response: "" }] })} />
      </section>
    );
  }

  if (specification.kind === "preferences") {
    return (
      <section className="training-signal-editor" aria-label="Preference evidence">
        <EditorHeading title="Define the preference" description="Each pair compares two responses to the same prompt. The rejected response must be genuinely worse, not merely different." />
        <TextField label="What makes one response better?" value={specification.preference} disabled={disabled} onChange={(preference) => onChange({ ...specification, preference })} />
        {specification.pairs.map((pair, index) => (
          <EditorCard key={pair.id} label={`Comparison ${index + 1}`} disabled={disabled} onRemove={() => onChange({ ...specification, pairs: specification.pairs.filter((item) => item.id !== pair.id) })}>
            <TextField label="Prompt" value={pair.prompt} disabled={disabled} onChange={(prompt) => updatePair(specification, pair.id, { prompt }, onChange)} />
            <TextField label="Chosen response" value={pair.chosen} disabled={disabled} onChange={(chosen) => updatePair(specification, pair.id, { chosen }, onChange)} />
            <TextField label="Rejected response" value={pair.rejected} disabled={disabled} onChange={(rejected) => updatePair(specification, pair.id, { rejected }, onChange)} />
            <TextField label="Why chosen is better (optional)" value={pair.rationale} disabled={disabled} onChange={(rationale) => updatePair(specification, pair.id, { rationale }, onChange)} />
          </EditorCard>
        ))}
        <AddButton disabled={disabled} label="Add comparison" onClick={() => onChange({ ...specification, pairs: [...specification.pairs, { id: nextId("pair", specification.pairs.map((item) => item.id)), prompt: "", chosen: "", rejected: "", rationale: "" }] })} />
      </section>
    );
  }

  if (specification.kind === "verifiable_reward") {
    return (
      <section className="training-signal-editor" aria-label="Verifiable reward evidence">
        <EditorHeading title="Define an executable reward" description="State what the model produces and how each independently verifiable outcome contributes to the scalar score." />
        <TextField label="Task" value={specification.task} disabled={disabled} onChange={(task) => onChange({ ...specification, task })} />
        {specification.rules.map((rule, index) => (
          <EditorCard key={rule.id} label={`Reward rule ${index + 1}`} disabled={disabled} onRemove={() => onChange({ ...specification, rules: specification.rules.filter((item) => item.id !== rule.id) })}>
            <label><span>Points</span><input type="number" step="0.1" value={rule.points} disabled={disabled} onChange={(event) => onChange({ ...specification, rules: specification.rules.map((item) => item.id === rule.id ? { ...item, points: Number(event.target.value) } : item) })} /></label>
            <TextField label="Condition" value={rule.condition} disabled={disabled} onChange={(condition) => onChange({ ...specification, rules: specification.rules.map((item) => item.id === rule.id ? { ...item, condition } : item) })} />
          </EditorCard>
        ))}
        <AddButton disabled={disabled} label="Add reward rule" onClick={() => onChange({ ...specification, rules: [...specification.rules, { id: nextId("reward", specification.rules.map((item) => item.id)), points: 1, condition: "" }] })} />
        <label className="training-signal-editor-number"><span>Otherwise</span><input type="number" step="0.1" value={specification.otherwisePoints} disabled={disabled} onChange={(event) => onChange({ ...specification, otherwisePoints: Number(event.target.value) })} /></label>
      </section>
    );
  }

  if (specification.kind === "agent_benchmark") {
    return (
      <section className="training-signal-editor" aria-label="Agent benchmark evidence">
        <EditorHeading
          title="Define the Agent benchmark"
          description="The authoring model writes split-isolated prompt families. Private cases, tool bindings, and scorer state are added by the Harness materializer."
        />
        <TextField
          label="Task"
          value={specification.task}
          disabled={disabled}
          onChange={(task) => onChange({ ...specification, task })}
        />
        {specification.promptFamilies.map((family, index) => (
          <EditorCard
            key={`${family.split}:${family.id}`}
            label={`Prompt family ${index + 1}`}
            disabled={disabled}
            onRemove={() => onChange({
              ...specification,
              promptFamilies: specification.promptFamilies.filter(
                (item) => item !== family,
              ),
            })}
          >
            <label>
              <span>Split</span>
              <select
                value={family.split}
                disabled={disabled}
                onChange={(event) => onChange({
                  ...specification,
                  promptFamilies: specification.promptFamilies.map((item) =>
                    item === family
                      ? {
                          ...item,
                          split: event.target.value as typeof family.split,
                        }
                      : item),
                })}
              >
                <option value="train">Training</option>
                <option value="validation">Validation</option>
                <option value="frozen_eval">Frozen Eval</option>
              </select>
            </label>
            <TextField
              label="Family ID"
              value={family.id}
              disabled={disabled}
              onChange={(id) => onChange({
                ...specification,
                promptFamilies: specification.promptFamilies.map((item) =>
                  item === family ? { ...item, id } : item),
              })}
            />
            <TextField
              label="Student-visible prompt"
              value={family.prompt}
              disabled={disabled}
              onChange={(prompt) => onChange({
                ...specification,
                promptFamilies: specification.promptFamilies.map((item) =>
                  item === family ? { ...item, prompt } : item),
              })}
            />
          </EditorCard>
        ))}
        <AddButton
          disabled={disabled}
          label="Add prompt family"
          onClick={() => onChange({
            ...specification,
            promptFamilies: [
              ...specification.promptFamilies,
              {
                id: nextId(
                  "family",
                  specification.promptFamilies.map((family) => family.id),
                ),
                split: "train",
                prompt: "",
              },
            ],
          })}
        />
        <dl className="training-configuration-list">
          <dt>Agent</dt>
          <dd>{specification.agentId}</dd>
          <dt>Episodes</dt>
          <dd>
            {specification.splitCounts.train} train ·{" "}
            {specification.splitCounts.validation} validation ·{" "}
            {specification.splitCounts.frozenEval} frozen eval
          </dd>
        </dl>
      </section>
    );
  }

  return (
    <section className="training-signal-editor" aria-label="Rubric evidence">
      <EditorHeading title="Define and calibrate the rubric" description="A rubric becomes evaluation evidence first. Positive, negative, and boundary examples are required before a model judge can be treated as calibrated." />
      <TextField label="Task being scored" value={specification.task} disabled={disabled} onChange={(task) => onChange({ ...specification, task })} />
      {specification.criteria.map((criterion, index) => (
        <EditorCard key={criterion.id} label={`Criterion ${index + 1}`} disabled={disabled} onRemove={() => onChange({ ...specification, criteria: specification.criteria.filter((item) => item.id !== criterion.id) })}>
          <TextField label="Name" value={criterion.label} disabled={disabled} onChange={(label) => onChange({ ...specification, criteria: specification.criteria.map((item) => item.id === criterion.id ? { ...item, label } : item) })} />
          <TextField label="What passes" value={criterion.description} disabled={disabled} onChange={(description) => onChange({ ...specification, criteria: specification.criteria.map((item) => item.id === criterion.id ? { ...item, description } : item) })} />
        </EditorCard>
      ))}
      <AddButton disabled={disabled} label="Add criterion" onClick={() => onChange({ ...specification, criteria: [...specification.criteria, { id: nextId("criterion", specification.criteria.map((item) => item.id)), label: "", description: "" }] })} />
      <div className="training-signal-editor-calibration">
        <TextField label="Positive example" value={specification.positiveExample} disabled={disabled} onChange={(positiveExample) => onChange({ ...specification, positiveExample })} />
        <TextField label="Negative example" value={specification.negativeExample} disabled={disabled} onChange={(negativeExample) => onChange({ ...specification, negativeExample })} />
        <TextField label="Boundary example" value={specification.boundaryExample} disabled={disabled} onChange={(boundaryExample) => onChange({ ...specification, boundaryExample })} />
      </div>
    </section>
  );
}

function EditorHeading({ title, description }: { title: string; description: string }) {
  return <header><strong>{title}</strong><p>{description}</p></header>;
}

function TextField({ label, value, disabled, onChange }: { label: string; value: string; disabled: boolean; onChange: (value: string) => void }) {
  return <label><span>{label}</span><textarea value={value} disabled={disabled} onChange={(event) => onChange(event.target.value)} /></label>;
}

function EditorCard({ label, disabled, onRemove, children }: { label: string; disabled: boolean; onRemove: () => void; children: ReactNode }) {
  return <div className="training-signal-editor-card"><div><strong>{label}</strong><button type="button" aria-label={`Remove ${label}`} disabled={disabled} onClick={onRemove}><Trash2 size={14} /></button></div>{children}</div>;
}

function AddButton({ disabled, label, onClick }: { disabled: boolean; label: string; onClick: () => void }) {
  return <button className="training-button secondary training-signal-editor-add" type="button" disabled={disabled} onClick={onClick}><Plus size={14} />{label}</button>;
}

function nextId(prefix: string, ids: string[]): string {
  let index = ids.length + 1;
  while (ids.includes(`${prefix}_${index}`)) index += 1;
  return `${prefix}_${index}`;
}

function updatePair(
  specification: Extract<DatasetBuildSpecification, { kind: "preferences" }>,
  id: string,
  patch: Partial<Extract<DatasetBuildSpecification, { kind: "preferences" }>["pairs"][number]>,
  onChange: (specification: DatasetBuildSpecification) => void,
) {
  onChange({ ...specification, pairs: specification.pairs.map((item) => item.id === id ? { ...item, ...patch } : item) });
}
