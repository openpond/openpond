import { useMemo, useState, type FormEvent } from "react";
import type {
  ChatModelRef,
  GraderSpec,
  ProviderSettings,
  Taskset,
} from "@openpond/contracts";

import { AppDialog } from "../dialogs/AppDialog";
import { X } from "../icons";
import {
  chatModelFromValue,
  chatModelValue,
  labChatModelOptions,
} from "./lab-chat-model-options";

export type LabScorerCreateInput = {
  grader: GraderSpec;
  tasksetId: string;
};

export function LabScorerCreateDialog({
  busy,
  defaultModel,
  onClose,
  onCreate,
  providerSettings,
  tasksets,
}: {
  busy: boolean;
  defaultModel: ChatModelRef;
  onClose: () => void;
  onCreate: (input: LabScorerCreateInput) => Promise<boolean>;
  providerSettings: ProviderSettings | null;
  tasksets: Taskset[];
}) {
  const [kind, setKind] = useState<"model_judge" | "human">("model_judge");
  const [name, setName] = useState("");
  const [scorerId, setScorerId] = useState("");
  const [idEdited, setIdEdited] = useState(false);
  const [version, setVersion] = useState("1");
  const [tasksetId, setTasksetId] = useState(tasksets.length === 1 ? tasksets[0]!.id : "");
  const [rubric, setRubric] = useState("");
  const [reviewerRole, setReviewerRole] = useState("Subject-matter reviewer");
  const [modelValue, setModelValue] = useState(chatModelValue(defaultModel));
  const [weight, setWeight] = useState("1");
  const [hardGate, setHardGate] = useState(false);
  const [rewardEligible, setRewardEligible] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const modelOptions = useMemo(
    () => labChatModelOptions(providerSettings, defaultModel),
    [defaultModel, providerSettings],
  );
  const selectedTaskset = tasksets.find((taskset) => taskset.id === tasksetId) ?? null;
  const normalizedName = name.trim().replace(/\s+/g, " ");
  const normalizedId = scorerId.trim();
  const normalizedVersion = version.trim();
  const parsedWeight = Number(weight);
  const judgeModel = chatModelFromValue(modelValue);
  const judgeFixturesReady = kind !== "model_judge" || Boolean(selectedTaskset?.graderFixtures.length);
  const valid = Boolean(
    normalizedName
    && normalizedId
    && normalizedVersion
    && selectedTaskset
    && rubric.trim()
    && Number.isFinite(parsedWeight)
    && parsedWeight >= 0
    && judgeFixturesReady
    && (kind !== "model_judge" || judgeModel)
    && (kind !== "human" || reviewerRole.trim()),
  );

  function changeName(value: string) {
    setName(value);
    if (!idEdited) setScorerId(scorerIdFromName(value));
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!valid || busy || !selectedTaskset) return;
    setError(null);
    const base = {
      id: normalizedId,
      version: normalizedVersion,
      label: normalizedName,
      weight: parsedWeight,
      hardGate,
      privileged: false,
      metadata: rewardEligible && kind === "model_judge"
        ? { requestedRewardEligible: true }
        : {},
    };
    const grader: GraderSpec = kind === "model_judge"
      ? {
          ...base,
          kind,
          rewardEligible: false,
          rubric: rubric.trim(),
          judge: judgeModel!,
          calibrationFixtureRefs: selectedTaskset.graderFixtures.map((fixture) => fixture.id),
          calibrationStatus: "pending",
          temperature: 0,
        }
      : {
          ...base,
          kind,
          rewardEligible,
          rubric: rubric.trim(),
          reviewerRole: reviewerRole.trim(),
        };
    if (!await onCreate({ grader, tasksetId: selectedTaskset.id })) {
      setError("OpenPond could not publish this scorer release. Review the latest error and try again.");
    }
  }

  return (
    <AppDialog
      ariaLabel="New scorer"
      backdropClassName="labs-rename-backdrop"
      className="labs-rename-dialog labs-model-create-dialog labs-scorer-create-dialog"
      dismissDisabled={busy}
      onClose={onClose}
    >
      <header>
        <div>
          <h2>New scorer</h2>
          <p>Create a versioned scorer and publish a new release of the selected Taskset.</p>
        </div>
        <button aria-label="Close new scorer" disabled={busy} type="button" onClick={onClose}>
          <X size={16} />
        </button>
      </header>
      <form onSubmit={(event) => void submit(event)}>
        <fieldset className="labs-model-create-purpose">
          <legend>Scorer type</legend>
          <button className={kind === "model_judge" ? "selected" : undefined} type="button" onClick={() => setKind("model_judge")}>
            <strong>LLM judge</strong>
            <small>Apply a rubric with a pinned model, then calibrate it against Taskset fixtures.</small>
          </button>
          <button className={kind === "human" ? "selected" : undefined} type="button" onClick={() => setKind("human")}>
            <strong>Human rubric</strong>
            <small>Collect reviewer evidence against an explicit rubric and role.</small>
          </button>
        </fieldset>

        <label>
          <span>Name</span>
          <input data-autofocus maxLength={500} required value={name} onChange={(event) => changeName(event.currentTarget.value)} />
        </label>
        <div className="labs-scorer-identity-grid">
          <label><span>Scorer ID</span><input maxLength={240} required value={scorerId} onChange={(event) => {
            setIdEdited(true);
            setScorerId(event.currentTarget.value);
          }} /></label>
          <label><span>Version</span><input maxLength={100} required value={version} onChange={(event) => setVersion(event.currentTarget.value)} /></label>
        </div>
        <label className="labs-model-create-field">
          <span>Attach to Taskset</span>
          <select required value={tasksetId} onChange={(event) => setTasksetId(event.currentTarget.value)}>
            <option disabled value="">Select a Taskset</option>
            {tasksets.map((taskset) => (
              <option
                disabled={kind === "model_judge" && !taskset.graderFixtures.length}
                key={taskset.id}
                value={taskset.id}
              >
                {taskset.name} · revision {taskset.revision}
                {kind === "model_judge" && !taskset.graderFixtures.length ? " · needs calibration fixtures" : ""}
              </option>
            ))}
          </select>
          <small>The existing release stays immutable; this publishes the next Taskset revision.</small>
        </label>
        {kind === "model_judge" ? (
          <label className="labs-model-create-field">
            <span>Judge model</span>
            <select value={modelValue} onChange={(event) => setModelValue(event.currentTarget.value)}>
              {modelOptions.map((group) => (
                <optgroup key={group.providerId} label={group.providerLabel}>
                  {group.models.map((model) => <option key={model.value} value={model.value}>{model.label}</option>)}
                </optgroup>
              ))}
            </select>
            <small>The model is pinned in the scorer release. Reward eligibility stays off until calibration passes.</small>
          </label>
        ) : (
          <label><span>Reviewer role</span><input maxLength={500} required value={reviewerRole} onChange={(event) => setReviewerRole(event.currentTarget.value)} /></label>
        )}
        <label><span>Rubric</span><textarea maxLength={50_000} required rows={6} value={rubric} onChange={(event) => setRubric(event.currentTarget.value)} /></label>
        <div className="labs-scorer-settings-row">
          <label><span>Weight</span><input min={0} max={1000} step="0.1" type="number" value={weight} onChange={(event) => setWeight(event.currentTarget.value)} /></label>
          <label className="labs-scorer-checkbox"><input checked={hardGate} type="checkbox" onChange={(event) => setHardGate(event.currentTarget.checked)} /><span>Required gate</span></label>
          <label className="labs-scorer-checkbox"><input checked={rewardEligible} type="checkbox" onChange={(event) => setRewardEligible(event.currentTarget.checked)} /><span>Request reward eligibility</span></label>
        </div>
        {!tasksets.length ? <div className="labs-rename-error" role="alert">Create or attach a Taskset before adding a scorer.</div> : null}
        {error ? <div className="labs-rename-error" role="alert">{error}</div> : null}
        <footer>
          <button disabled={busy} type="button" onClick={onClose}>Cancel</button>
          <button disabled={!valid || busy} type="submit">{busy ? "Publishing…" : "Create scorer"}</button>
        </footer>
      </form>
    </AppDialog>
  );
}

function scorerIdFromName(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 220);
}
