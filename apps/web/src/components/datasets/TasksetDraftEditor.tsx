import { useEffect, useMemo, useRef, useState } from "react";
import type {
  ChatModelRef,
  GraderSpec,
  TaskDataDraft,
  TasksetDraft,
} from "@openpond/contracts";

import type { useTraining } from "../../hooks/useTraining";
import {
  EditorSection,
  EmptyState,
  Field,
  JsonArrayField,
  JsonObjectFileImport,
  JsonObjectField,
} from "./TasksetDraftEditorPrimitives";
import { TasksetDraftValidationStatus } from "./TasksetDraftValidationStatus";
import { TasksetSplitBuilder } from "./TasksetSplitBuilder";
import {
  TASKSET_DRAFT_SECTIONS,
  draftValidationIssues,
  newGrader,
  newOutputContractGrader,
  newTask,
  parseStringArray,
  starterFixtures,
  type TasksetDraftSection,
} from "./taskset-draft-editor-helpers";

export function TasksetDraftEditor({
  draftId,
  defaultModel,
  training,
  onBack,
  onOpenChat,
  onPublished,
  onUseExistingTaskset,
}: {
  draftId?: string | null;
  defaultModel: ChatModelRef;
  training: ReturnType<typeof useTraining>;
  onBack: () => void;
  onOpenChat?: (draft: TasksetDraft) => void;
  onPublished: (tasksetId: string) => void;
  onUseExistingTaskset?: () => void;
}) {
  const [localDraftId, setLocalDraftId] = useState(draftId ?? null);
  const [draft, setDraft] = useState<TasksetDraft | null>(() =>
    training.payload?.tasksetDrafts.find((candidate) => candidate.id === draftId) ?? null
  );
  const [section, setSection] = useState<TasksetDraftSection>("overview");
  const [notice, setNotice] = useState<string | null>(null);
  const [validationOpen, setValidationOpen] = useState(false);
  const [workspace, setWorkspace] = useState<{
    draftId: string;
    workspacePath: string;
    packageHash: string;
  } | null>(null);
  const creatingRef = useRef(false);

  useEffect(() => {
    if (draft || localDraftId || creatingRef.current) return;
    creatingRef.current = true;
    void training.actions.createTasksetDraft().then((created) => {
      creatingRef.current = false;
      if (!created) return;
      setDraft(created);
      setLocalDraftId(created.id);
    });
  }, [draft, localDraftId, training.actions]);

  useEffect(() => {
    if (draft || !localDraftId) return;
    const persisted = training.payload?.tasksetDrafts.find(
      (candidate) => candidate.id === localDraftId,
    );
    if (persisted) setDraft(persisted);
  }, [draft, localDraftId, training.payload?.tasksetDrafts]);

  useEffect(() => {
    if (!localDraftId) return;
    let active = true;
    void training.actions.tasksetDraftWorkspace(localDraftId).then((next) => {
      if (active && next) setWorkspace(next);
    });
    return () => { active = false; };
  }, [localDraftId, training.actions]);

  const issues = useMemo(() => draft ? draftValidationIssues(draft) : [], [draft]);
  const busy = training.busyAction?.includes("taskset-draft") ?? false;

  async function save(): Promise<TasksetDraft | null> {
    if (!draft || draft.status === "published") return draft;
    const saved = await training.actions.saveTasksetDraft(draft);
    if (!saved) return null;
    setDraft(saved);
    setNotice("Draft saved.");
    const nextWorkspace = await training.actions.tasksetDraftWorkspace(saved.id);
    if (nextWorkspace) setWorkspace(nextWorkspace);
    return saved;
  }

  async function publish() {
    if (!draft || issues.length) return;
    const saved = await save();
    if (!saved) return;
    const result = await training.actions.publishTasksetDraft(saved.id);
    if (!result) return;
    setDraft(result.draft);
    onPublished(result.taskset.id);
  }

  if (!draft) {
    return (
      <section className="taskset-draft-loading" aria-live="polite">
        <strong>Creating an empty Taskset draft…</strong>
        <span>The draft is saved locally before any tasks or assets are required.</span>
      </section>
    );
  }

  const readOnly = draft.status === "published";
  const update = (next: TasksetDraft) => {
    setNotice(null);
    setDraft({ ...next, updatedAt: new Date().toISOString() });
  };

  return (
    <main className="taskset-draft-editor" aria-label="Taskset draft editor">
      <header className="taskset-draft-header">
        <div>
          <button className="training-text-button" type="button" onClick={onBack}>
            Back
          </button>
          <input
            aria-label="Taskset name"
            className="taskset-draft-name"
            disabled={readOnly}
            placeholder="Untitled Taskset"
            value={draft.name}
            onChange={(event) => update({ ...draft, name: event.target.value })}
          />
          <small>
            Draft revision {draft.revision}
            {notice ? ` · ${notice}` : ""}
          </small>
          {workspace ? (
            <small className="taskset-draft-workspace" title={workspace.workspacePath}>
              Workspace: {workspace.workspacePath}
            </small>
          ) : null}
        </div>
        <div className="model-build-actions">
          {onOpenChat ? (
            <button
              className="training-button secondary"
              disabled={busy}
              type="button"
              onClick={() => onOpenChat(draft)}
            >
              Continue in Chat
            </button>
          ) : null}
          {onUseExistingTaskset ? (
            <button
              className="training-button secondary"
              type="button"
              onClick={onUseExistingTaskset}
            >
              Use existing
            </button>
          ) : null}
          <button
            className="training-text-button taskset-draft-validation-toggle"
            type="button"
            onClick={() => setValidationOpen((open) => !open)}
          >
            {issues.length ? `${issues.length} issue${issues.length === 1 ? "" : "s"}` : "Ready to publish"}
          </button>
          <button
            className="training-button secondary"
            disabled={busy || readOnly}
            type="button"
            onClick={() => void save()}
          >
            Save draft
          </button>
          <button
            className="training-button"
            disabled={busy || readOnly || issues.length > 0}
            title={issues[0]}
            type="button"
            onClick={() => void publish()}
          >
            Publish Taskset
          </button>
        </div>
      </header>

      <nav className="taskset-draft-tabs" aria-label="Taskset draft sections">
        {TASKSET_DRAFT_SECTIONS.map((candidate) => (
          <button
            className={section === candidate.id ? "active" : undefined}
            key={candidate.id}
            type="button"
            onClick={() => setSection(candidate.id)}
          >
            {candidate.label}
            {candidate.id === "scenarios" ? ` (${draft.tasks.length})` : ""}
            {candidate.id === "rewards" ? ` (${draft.graders.length})` : ""}
          </button>
        ))}
      </nav>

      <div className="taskset-draft-body">
        {validationOpen ? <TasksetDraftValidationStatus draft={draft} issues={issues} /> : null}
        {section === "overview" ? (
          <OverviewSection draft={draft} disabled={readOnly} onChange={update} />
        ) : null}
        {section === "scenarios" ? (
          <ScenariosSection draft={draft} disabled={readOnly} onChange={update} />
        ) : null}
        {section === "environment" ? (
          <EnvironmentSection draft={draft} disabled={readOnly} onChange={update} />
        ) : null}
        {section === "output" ? (
          <OutputSection draft={draft} disabled={readOnly} onChange={update} />
        ) : null}
        {section === "rewards" ? (
          <>
            <GradingSection
              draft={draft}
              defaultModel={defaultModel}
              disabled={readOnly}
              onChange={update}
            />
            <details className="taskset-draft-advanced">
              <summary>Advanced metrics</summary>
              <MetricsSection draft={draft} disabled={readOnly} onChange={update} />
            </details>
          </>
        ) : null}
        {section === "review" ? (
          <ReviewSection draft={draft} disabled={readOnly} onChange={update} />
        ) : null}
      </div>
    </main>
  );
}

type SectionProps = {
  draft: TasksetDraft;
  disabled: boolean;
  onChange: (draft: TasksetDraft) => void;
};

function OverviewSection({ draft, disabled, onChange }: SectionProps) {
  const methods = ["none", "sft", "dpo", "grpo", "ppo"] as const;
  return (
    <EditorSection
      title="What should this Taskset measure?"
      description="Start empty, then add only the task, environment, and scoring details this workload needs."
    >
      <Field label="Objective">
        <textarea
          disabled={disabled}
          placeholder="Describe the behavior, capability, or outcome being evaluated."
          rows={5}
          value={draft.objective}
          onChange={(event) => onChange({ ...draft, objective: event.target.value })}
        />
      </Field>
      <div className="taskset-draft-field-grid">
        <Field label="Purpose">
          <select
            disabled={disabled}
            value={draft.purpose}
            onChange={(event) => onChange({
              ...draft,
              purpose: event.target.value as TasksetDraft["purpose"],
            })}
          >
            <option value="general">General</option>
            <option value="benchmark">Benchmark</option>
            <option value="capability_regression">Capability regression</option>
          </select>
        </Field>
        <Field label="Task kind">
          <select
            disabled={disabled}
            value={draft.capabilities.taskKind}
            onChange={(event) => onChange({
              ...draft,
              capabilities: {
                ...draft.capabilities,
                taskKind: event.target.value as TasksetDraft["capabilities"]["taskKind"],
              },
            })}
          >
            <option value="chat">Chat</option>
            <option value="single_agent">Single agent</option>
            <option value="multi_agent">Multi-agent</option>
            <option value="custom_program">Custom program</option>
          </select>
        </Field>
      </div>
      <fieldset className="taskset-draft-checks">
        <legend>Compatible training methods</legend>
        {methods.map((method) => (
          <label key={method}>
            <input
              checked={draft.capabilities.compatibleMethods.includes(method)}
              disabled={disabled}
              type="checkbox"
              onChange={(event) => {
                const compatibleMethods = event.target.checked
                  ? [...draft.capabilities.compatibleMethods, method]
                  : draft.capabilities.compatibleMethods.filter((value) => value !== method);
                onChange({
                  ...draft,
                  capabilities: { ...draft.capabilities, compatibleMethods },
                });
              }}
            />
            {method.toUpperCase()}
          </label>
        ))}
      </fieldset>
    </EditorSection>
  );
}

function ScenariosSection({ draft, disabled, onChange }: SectionProps) {
  const updateTask = (index: number, task: TaskDataDraft) => onChange({
    ...draft,
    tasks: draft.tasks.map((candidate, candidateIndex) =>
      candidateIndex === index ? task : candidate
    ),
  });
  return (
    <EditorSection
      title="Scenarios"
      description="A scenario is one executable instruction and split assignment. It may reference shared Environment resources without defining or duplicating them."
      action={
        <button
          className="training-button secondary"
          disabled={disabled}
          type="button"
          onClick={() => onChange({ ...draft, tasks: [...draft.tasks, newTask()] })}
        >
          Add scenario
        </button>
      }
    >
      <TasksetSplitBuilder
        disabled={disabled}
        objective={draft.objective}
        onCreate={(tasks) => onChange({ ...draft, tasks: [...draft.tasks, ...tasks] })}
      />
      {draft.tasks.length === 0 ? (
        <EmptyState>Add a first scenario when you are ready. The empty Taskset can be saved first.</EmptyState>
      ) : null}
      <div className="taskset-draft-card-list">
        {draft.tasks.map((task, index) => (
          <article className="taskset-draft-card" key={task.id}>
            <header>
              <strong>Scenario {index + 1}</strong>
              <button
                className="training-text-button danger"
                disabled={disabled}
                type="button"
                onClick={() => onChange({
                  ...draft,
                  tasks: draft.tasks.filter((_, candidateIndex) => candidateIndex !== index),
                  graderFixtures: draft.graderFixtures.filter((fixture) => fixture.taskId !== task.id),
                })}
              >
                Remove
              </button>
            </header>
            <div className="taskset-draft-field-grid three">
              <Field label="ID">
                <input
                  disabled={disabled}
                  value={task.id}
                  onChange={(event) => updateTask(index, { ...task, id: event.target.value })}
                />
              </Field>
              <Field label="Split">
                <select
                  disabled={disabled}
                  value={task.split}
                  onChange={(event) => updateTask(index, {
                    ...task,
                    split: event.target.value as TaskDataDraft["split"],
                  })}
                >
                  <option value="train">Train</option>
                  <option value="validation">Validation</option>
                  <option value="test">Test</option>
                  <option value="frozen_eval">Frozen eval</option>
                </select>
              </Field>
              <Field label="Cluster key">
                <input
                  disabled={disabled}
                  value={task.clusterKey}
                  onChange={(event) => updateTask(index, { ...task, clusterKey: event.target.value })}
                />
              </Field>
            </div>
            <div className="taskset-draft-field-grid">
              <JsonObjectField
                disabled={disabled}
                label="Input JSON"
                value={task.input}
                onChange={(input) => updateTask(index, { ...task, input: input ?? {} })}
              />
              <JsonObjectField
                disabled={disabled}
                label="Expected output JSON"
                nullable
                value={task.expectedOutput}
                onChange={(expectedOutput) => updateTask(index, { ...task, expectedOutput })}
              />
            </div>
            <JsonArrayField
              disabled={disabled}
              label="Asset references JSON"
              value={task.assets ?? []}
              onChange={(assets) => updateTask(index, {
                ...task,
                assets: assets as TaskDataDraft["assets"],
              })}
            />
            <Field label="Environment resource IDs (comma-separated)">
              <input
                disabled={disabled}
                value={(task.resourceRefs ?? []).join(", ")}
                onChange={(event) => updateTask(index, {
                  ...task,
                  resourceRefs: parseStringArray(event.target.value),
                })}
              />
            </Field>
          </article>
        ))}
      </div>
    </EditorSection>
  );
}

function OutputSection({ draft, disabled, onChange }: SectionProps) {
  return (
    <EditorSection
      title="Output"
      description="Define the portable response contract and optional artifact renderer. The policy model is selected later when a run is created."
    >
      <div className="taskset-draft-field-grid">
        <Field label="Model output">
          <select
            disabled={disabled}
            value={draft.output.mode}
            onChange={(event) => {
              const mode = event.target.value as TasksetDraft["output"]["mode"];
              onChange({
                ...draft,
                output: {
                  mode,
                  jsonSchema: mode === "structured_json"
                    ? draft.output.jsonSchema ?? { type: "object", additionalProperties: true }
                    : null,
                  renderer: mode === "text" ? null : draft.output.renderer,
                },
              });
            }}
          >
            <option value="text">Text</option>
            <option value="structured_json">Structured JSON</option>
            <option value="artifacts">Files / artifacts</option>
          </select>
        </Field>
        {draft.output.mode !== "text" ? (
          <label className="taskset-draft-toggle compact">
            <input
              checked={Boolean(draft.output.renderer)}
              disabled={disabled}
              type="checkbox"
              onChange={(event) => onChange({
                ...draft,
                output: {
                  ...draft.output,
                  renderer: event.target.checked
                    ? {
                        module: "environment/renderer.ts",
                        exportName: "render",
                        configRef: null,
                      }
                    : null,
                },
              })}
            />
            <span>
              <strong>Render output into artifacts</strong>
              <small>A starter code file is created in the Taskset workspace and never overwritten.</small>
            </span>
          </label>
        ) : null}
      </div>
      {draft.output.mode === "structured_json" ? (
        <>
          <p className="labs-detail-copy">
            A model provider may enforce JSON syntax, but the Taskset validator still checks required fields and allowed values so reward does not depend on a provider setting.
          </p>
          <JsonObjectField
            disabled={disabled}
            label="Output JSON Schema"
            value={draft.output.jsonSchema}
            onChange={(jsonSchema) => onChange({
              ...draft,
              output: { ...draft.output, jsonSchema },
            })}
          />
          <JsonObjectFileImport
            disabled={disabled}
            label="Import output schema JSON"
            onImport={(jsonSchema) => onChange({
              ...draft,
              output: { ...draft.output, jsonSchema },
            })}
          />
        </>
      ) : null}
      {draft.output.renderer ? (
        <div className="taskset-draft-field-grid three">
          <Field label="Renderer module">
            <input
              disabled={disabled}
              value={draft.output.renderer.module}
              onChange={(event) => onChange({
                ...draft,
                output: {
                  ...draft.output,
                  renderer: { ...draft.output.renderer!, module: event.target.value },
                },
              })}
            />
          </Field>
          <Field label="Renderer export">
            <input
              disabled={disabled}
              value={draft.output.renderer.exportName}
              onChange={(event) => onChange({
                ...draft,
                output: {
                  ...draft.output,
                  renderer: { ...draft.output.renderer!, exportName: event.target.value },
                },
              })}
            />
          </Field>
          <Field label="Renderer config file (optional)">
            <input
              disabled={disabled}
              placeholder="assets/catalog.json"
              value={draft.output.renderer.configRef ?? ""}
              onChange={(event) => onChange({
                ...draft,
                output: {
                  ...draft.output,
                  renderer: {
                    ...draft.output.renderer!,
                    configRef: event.target.value.trim() || null,
                  },
                },
              })}
            />
          </Field>
        </div>
      ) : null}
    </EditorSection>
  );
}

function EnvironmentSection({ draft, disabled, onChange }: SectionProps) {
  const environment = draft.environment;
  return (
    <EditorSection
      title="Environment"
      description="Define the small, deterministic runtime and shared resources used by scenarios. The runtime adapter is infrastructure, not a model name."
    >
      <JsonArrayField
        disabled={disabled}
        label="Shared resources JSON"
        value={environment.resources ?? []}
        onChange={(resources) => onChange({
          ...draft,
          environment: {
            ...environment,
            resources: resources as TasksetDraft["environment"]["resources"],
          },
        })}
      />
      <div className="taskset-draft-field-grid three">
        <Field label="Environment kind">
          <select
            disabled={disabled}
            value={environment.kind}
            onChange={(event) => onChange({
              ...draft,
              environment: {
                ...environment,
                kind: event.target.value as TasksetDraft["environment"]["kind"],
              },
            })}
          >
            <option value="chat">Chat</option>
            <option value="agent">Agent</option>
            <option value="program">Program</option>
            <option value="stateful_harness">Stateful harness</option>
            <option value="work">Work</option>
          </select>
        </Field>
        <Field label="Runtime adapter">
          <input
            disabled={disabled}
            value={environment.entrypoint}
            onChange={(event) => onChange({
              ...draft,
              environment: { ...environment, entrypoint: event.target.value },
            })}
          />
          <small>For an ordinary model response, keep openpond-chat-v1. Choose the model on the run.</small>
        </Field>
        <Field label="Timeout (ms)">
          <input
            disabled={disabled}
            min={1}
            type="number"
            value={environment.defaultTimeoutMs}
            onChange={(event) => onChange({
              ...draft,
              environment: { ...environment, defaultTimeoutMs: Number(event.target.value) },
            })}
          />
        </Field>
      </div>
      <div className="taskset-draft-field-grid">
        <Field label="Tools (comma-separated)">
          <input
            disabled={disabled}
            value={environment.toolNames.join(", ")}
            onChange={(event) => {
              const toolNames = parseStringArray(event.target.value);
              onChange({
                ...draft,
                environment: { ...environment, toolNames },
                capabilities: {
                  ...draft.capabilities,
                  requiresTools: toolNames.length > 0,
                },
              });
            }}
          />
        </Field>
        <Field label="Network policy">
          <select
            disabled={disabled}
            value={environment.networkPolicy}
            onChange={(event) => onChange({
              ...draft,
              environment: {
                ...environment,
                networkPolicy: event.target.value as TasksetDraft["environment"]["networkPolicy"],
              },
            })}
          >
            <option value="none">None</option>
            <option value="declared_read_only">Declared read-only</option>
            <option value="declared_scoped">Declared scoped</option>
          </select>
        </Field>
      </div>
      <fieldset className="taskset-draft-checks">
        <legend>Runtime behavior</legend>
        <label>
          <input
            checked={environment.stateful}
            disabled={disabled}
            type="checkbox"
            onChange={(event) => onChange({
              ...draft,
              environment: { ...environment, stateful: event.target.checked },
              capabilities: { ...draft.capabilities, requiresState: event.target.checked },
            })}
          />
          Stateful
        </label>
        <label>
          <input
            checked={environment.deterministicSeeds}
            disabled={disabled}
            type="checkbox"
            onChange={(event) => onChange({
              ...draft,
              environment: { ...environment, deterministicSeeds: event.target.checked },
            })}
          />
          Deterministic seeds
        </label>
      </fieldset>
    </EditorSection>
  );
}

function GradingSection({
  draft,
  defaultModel,
  disabled,
  onChange,
}: SectionProps & { defaultModel: ChatModelRef }) {
  const addGrader = (kind: Parameters<typeof newGrader>[0]) => onChange({
    ...draft,
    graders: [...draft.graders, newGrader(kind, defaultModel)],
  });
  const updateGrader = (index: number, grader: GraderSpec) => onChange({
    ...draft,
    graders: draft.graders.map((candidate, candidateIndex) =>
      candidateIndex === index ? grader : candidate
    ),
  });
  return (
    <EditorSection
      title="Rewards"
      description="Add the deterministic and subjective signals that define success. Reward aggregation, fixtures, and custom grader settings remain available under Advanced."
    >
      <div className="taskset-draft-inline-actions">
        <button
          className="training-button secondary"
          disabled={disabled || draft.output.mode !== "structured_json" || !draft.output.jsonSchema}
          type="button"
          onClick={() => onChange({
            ...draft,
            graders: [...draft.graders, newOutputContractGrader(draft)],
          })}
        >
          Output validator
        </button>
        <button className="training-button secondary" disabled={disabled} type="button" onClick={() => addGrader("expected_text")}>Expected text</button>
        <button className="training-button secondary" disabled={disabled} type="button" onClick={() => addGrader("model_judge")}>Model judge</button>
        <button className="training-button secondary" disabled={disabled} type="button" onClick={() => addGrader("human")}>Human</button>
        <button className="training-button secondary" disabled={disabled} type="button" onClick={() => addGrader("custom_verifier")}>Custom verifier</button>
      </div>
      <details className="taskset-draft-advanced">
        <summary>Advanced grader configuration</summary>
      <div className="taskset-draft-card-list">
        {draft.graders.map((grader, index) => (
          <article className="taskset-draft-card" key={grader.id}>
            <header>
              <strong>{grader.kind.replaceAll("_", " ")}</strong>
              <button
                className="training-text-button danger"
                disabled={disabled}
                type="button"
                onClick={() => onChange({
                  ...draft,
                  graders: draft.graders.filter((_, candidateIndex) => candidateIndex !== index),
                })}
              >
                Remove
              </button>
            </header>
            <div className="taskset-draft-field-grid">
              <Field label="Label">
                <input disabled={disabled} value={grader.label} onChange={(event) => updateGrader(index, { ...grader, label: event.target.value })} />
              </Field>
              <Field label="Weight">
                <input disabled={disabled} min={0} step="0.1" type="number" value={grader.weight} onChange={(event) => updateGrader(index, { ...grader, weight: Number(event.target.value) })} />
              </Field>
            </div>
            {grader.kind === "model_judge" || grader.kind === "human" ? (
              <Field label="Rubric">
                <textarea disabled={disabled} rows={5} value={grader.rubric} onChange={(event) => updateGrader(index, { ...grader, rubric: event.target.value })} />
              </Field>
            ) : null}
            {grader.kind === "content" || grader.kind === "schema" || grader.kind === "file" || grader.kind === "diff" || grader.kind === "test" || grader.kind === "runtime_event" || grader.kind === "state" ? (
              <JsonObjectField disabled={disabled} label="Grader config JSON" value={grader.config} onChange={(config) => updateGrader(index, { ...grader, config: config ?? {} })} />
            ) : null}
            {grader.kind === "custom_verifier" ? (
              <div className="taskset-draft-field-grid">
                <Field label="Module">
                  <input disabled={disabled} value={grader.module} onChange={(event) => updateGrader(index, { ...grader, module: event.target.value })} />
                </Field>
                <Field label="Export">
                  <input disabled={disabled} value={grader.exportName} onChange={(event) => updateGrader(index, { ...grader, exportName: event.target.value })} />
                </Field>
              </div>
            ) : null}
          </article>
        ))}
      </div>
      <div className="taskset-draft-fixture-summary">
        <div>
          <strong>{draft.graderFixtures.length} fixtures</strong>
          <span>Positive, negative, boundary, adversarial, prompt-injection, and infrastructure cases are required.</span>
        </div>
        <button
          className="training-button secondary"
          disabled={disabled || draft.tasks.length === 0}
          type="button"
          onClick={() => onChange({
            ...draft,
            graderFixtures: starterFixtures(
              draft.tasks[0]!,
              draft.output.mode === "structured_json" ? draft.output.jsonSchema : null,
            ),
          })}
        >
          Generate starter fixtures
        </button>
      </div>
      <JsonArrayField
        disabled={disabled}
        label="Fixture definitions JSON"
        value={draft.graderFixtures}
        onChange={(graderFixtures) => onChange({
          ...draft,
          graderFixtures: graderFixtures as TasksetDraft["graderFixtures"],
        })}
      />
      </details>
    </EditorSection>
  );
}

function ReviewSection({ draft, disabled, onChange }: SectionProps) {
  return (
    <EditorSection
      title="Review"
      description="Configure the review protocol here. After publishing, reviewers label recorded Attempts on the Taskset Review page; generated Attempts and artifacts never become part of this editor."
    >
      <label className="taskset-draft-toggle">
        <input
          checked={draft.review.enabled}
          disabled={disabled}
          type="checkbox"
          onChange={(event) => onChange({
            ...draft,
            review: { ...draft.review, enabled: event.target.checked },
          })}
        />
        <span>
          <strong>Collect Love / Like / Reject reviews</strong>
          <small>The default interface records ordered buckets; the stored preference representation remains general and supports ties or reject-all.</small>
        </span>
      </label>
      {draft.review.enabled ? (
        <>
          <div className="taskset-draft-field-grid three">
            <Field label="Candidates per assignment">
              <select
                disabled={disabled}
                value={draft.review.candidateCount}
                onChange={(event) => onChange({
                  ...draft,
                  review: { ...draft.review, candidateCount: Number(event.target.value) },
                })}
              >
                <option value={2}>2</option>
                <option value={3}>3</option>
                <option value={4}>4</option>
              </select>
            </Field>
            <Field label="Target review assignments">
              <input
                disabled={disabled}
                min={1}
                max={10_000}
                type="number"
                value={draft.review.minimumSamples}
                onChange={(event) => onChange({
                  ...draft,
                  review: {
                    ...draft.review,
                    minimumSamples: Math.max(1, Number(event.target.value)),
                  },
                })}
              />
            </Field>
            <label className="taskset-draft-compact-check">
              <input checked={draft.review.allowTies} disabled={disabled} type="checkbox" onChange={(event) => onChange({ ...draft, review: { ...draft.review, allowTies: event.target.checked } })} />
              Allow ties
            </label>
            <label className="taskset-draft-compact-check">
              <input checked={draft.review.allowRejectAll} disabled={disabled} type="checkbox" onChange={(event) => onChange({ ...draft, review: { ...draft.review, allowRejectAll: event.target.checked } })} />
              Allow reject all
            </label>
          </div>
          <Field label="Reviewer rubric">
            <textarea disabled={disabled} rows={7} value={draft.review.rubric} onChange={(event) => onChange({ ...draft, review: { ...draft.review, rubric: event.target.value } })} />
          </Field>
          <div className="taskset-draft-card-list">
            {draft.review.criteria.map((criterion, index) => (
              <article className="taskset-draft-card compact" key={criterion.id}>
                <div className="taskset-draft-field-grid three">
                  <Field label="Criterion">
                    <input disabled={disabled} value={criterion.label} onChange={(event) => onChange({ ...draft, review: { ...draft.review, criteria: draft.review.criteria.map((candidate, candidateIndex) => candidateIndex === index ? { ...candidate, label: event.target.value } : candidate) } })} />
                  </Field>
                  <Field label="Description">
                    <input disabled={disabled} value={criterion.description} onChange={(event) => onChange({ ...draft, review: { ...draft.review, criteria: draft.review.criteria.map((candidate, candidateIndex) => candidateIndex === index ? { ...candidate, description: event.target.value } : candidate) } })} />
                  </Field>
                  <Field label="Weight">
                    <input disabled={disabled} min={0} step="0.1" type="number" value={criterion.weight} onChange={(event) => onChange({ ...draft, review: { ...draft.review, criteria: draft.review.criteria.map((candidate, candidateIndex) => candidateIndex === index ? { ...candidate, weight: Number(event.target.value) } : candidate) } })} />
                  </Field>
                </div>
              </article>
            ))}
          </div>
          <button
            className="training-button secondary"
            disabled={disabled}
            type="button"
            onClick={() => onChange({
              ...draft,
              review: {
                ...draft.review,
                criteria: [...draft.review.criteria, {
                  id: `criterion-${crypto.randomUUID()}`,
                  label: "Visual quality",
                  description: "The output is coherent, intentional, and free of material defects.",
                  weight: 1,
                }],
              },
            })}
          >
            Add criterion
          </button>
        </>
      ) : null}
    </EditorSection>
  );
}

function MetricsSection({ draft, disabled, onChange }: SectionProps) {
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
