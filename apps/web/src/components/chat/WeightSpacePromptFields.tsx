import { useContext, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  canonicalComputeSpendCap,
  TRAINING_JOB_SUBMISSION_MAX_BYTES,
  WEIGHT_SPACE_CHECKPOINT,
  WeightSpaceLimitsSchema,
  WeightSpaceRequestSchema,
  type WeightSpaceLimits,
} from "openpond-sdk/training";
import type { ClientConnection } from "../../api/api-client";
import { weightSpaceGeneration, type ResourceSetupDraft } from "../../lib/resource-setup-prompt";
import { DropdownSelect } from "../DropdownSelect";
import { ErrorToast } from "../common/ErrorToast";
import { managedWeightSpaceApi } from "../labs/workspace/managed-weight-space-api";
import { ReleasedDatasetPicker } from "../labs/workspace/ReleasedDatasetPicker";
import { useTrainingExperimentInputs } from "../labs/workspace/useTrainingExperimentInputs";
import { createWorkspaceApi, type WorkspaceApi } from "../labs/workspace/workspace-api";
import { ChatExperimentWorkspaceContext } from "./ChatExperimentWorkspaceContext";

type Draft = NonNullable<ResourceSetupDraft["weightSpace"]>;
type Managed = NonNullable<Draft["managed"]>;
type Checkpoint = NonNullable<Managed["checkpoint"]>;
type Panel = NonNullable<Draft["panels"]>[number];
type Field = "baseModel" | "weightSpacePanels" | "weightSpaceFrozen" | "weightSpaceSettings";

const limitLabels: Record<keyof WeightSpaceLimits, string> = {
  maximumDurationSeconds: "Session duration (seconds)",
  maximumIdleSeconds: "Idle time (seconds)",
  maximumCommands: "Editing commands",
  maximumCandidates: "Candidate versions",
  maximumPatchColumns: "Editable columns",
  maximumTensorElements: "Tensor elements",
  maximumReturnedValues: "Returned values",
  maximumArithmeticWork: "Arithmetic work",
  maximumForwardTokenWork: "Forward token work",
  maximumCheckpointBytes: "Checkpoint bytes",
};

export function WeightSpacePromptFields({ field, draft, visible, connection, disabled, onChange }: {
  field: Field;
  draft: ResourceSetupDraft;
  visible: ResourceSetupDraft;
  connection: ClientConnection | null;
  disabled: boolean;
  onChange(current: ResourceSetupDraft, next: ResourceSetupDraft): void;
}) {
  const scope = useContext(ChatExperimentWorkspaceContext);
  const setup = draft.weightSpace ?? {};
  const managed = visible.weightSpace?.managed;
  const api = connection && scope?.actorId && scope.teamId && scope.apiOrigin && draft.values.destination === "OpenPond Managed"
    ? createWorkspaceApi(connection, { ...scope, teamId: scope.teamId, projectId: null }) : null;

  function update(patch: Partial<Draft>) {
    onChange(draft, { ...draft, revision: draft.revision + 1, weightSpace: { ...setup, ...patch } });
  }

  function updateManaged(patch: Pick<Managed, "checkpoint" | "frozenEvaluation">) {
    if (!api || !scope?.actorId || !scope.apiOrigin) return;
    update({ managed: { ...managed, ...patch, teamId: api.teamId, owner: { actorId: scope.actorId, apiOrigin: scope.apiOrigin } } });
  }

  if (field === "weightSpacePanels") return <EditingPanels panels={setup.panels ?? []} disabled={disabled} onChange={panels => update({ panels })} />;
  if (field === "weightSpaceSettings") return <EditingSettings setup={setup} disabled={disabled} onChange={update} />;
  if (field === "baseModel") return <div className="resource-setup-fields">
    <p>{managed?.checkpoint?.modelId ?? WEIGHT_SPACE_CHECKPOINT.modelId}, revision <code>{managed?.checkpoint?.revision ?? WEIGHT_SPACE_CHECKPOINT.revision}</code></p>
    {api && scope?.apiOrigin ? <EditingCheckpoint key={JSON.stringify([api.key, scope.apiOrigin])} api={api} apiOrigin={scope.apiOrigin}
      value={managed?.checkpoint} disabled={disabled} onChange={checkpoint => updateManaged({ checkpoint })} />
      : <p>Choose OpenPond Managed to check the exact tokenizer and runtime in your workspace.</p>}
  </div>;
  return <div className="resource-setup-fields">
    <p>The frozen Dataset is held out until finalization. Choose separate development and preservation prompts for editing.</p>
    {api ? <ReleasedDatasetPicker api={api} value={managed?.frozenEvaluation ?? null} disabled={disabled}
      label="Frozen Dataset version" placeholder="No frozen Dataset selected"
      onChange={frozenEvaluation => updateManaged({ frozenEvaluation: frozenEvaluation ?? undefined })} />
      : <p>Choose OpenPond Managed to select a released Dataset from your workspace.</p>}
  </div>;
}

function EditingCheckpoint({ api, apiOrigin, value, disabled, onChange }: {
  api: WorkspaceApi; apiOrigin: string; value?: Checkpoint; disabled: boolean; onChange(value?: Checkpoint): void;
}) {
  const catalog = useTrainingExperimentInputs(api, true);
  const choices = catalog.models.flatMap(({ preference, name }) => {
    const { modelId, revision, source, modelAssetId, tokenizerRevision, chatTemplateHash } = preference;
    if (source !== "managed" || modelAssetId || modelId !== WEIGHT_SPACE_CHECKPOINT.modelId ||
      revision !== WEIGHT_SPACE_CHECKPOINT.revision || !tokenizerRevision || !chatTemplateHash) return [];
    return [{ name, checkpoint: { modelId, revision, tokenizerRevision, chatTemplateHash } }];
  });
  const keyFor = (checkpoint: Checkpoint) => JSON.stringify([checkpoint.modelId, checkpoint.revision, checkpoint.tokenizerRevision, checkpoint.chatTemplateHash]);
  const options = new Map(choices.map(choice => [keyFor(choice.checkpoint), choice]));
  const key = value ? keyFor(value) : "";
  const query = value ? { teamId: api.teamId, source: "managed" as const, ...value } : null;
  const capability = useQuery({
    queryKey: ["editing-checkpoint-capability", api.key, api.connection.serverUrl, apiOrigin, query],
    enabled: Boolean(query), staleTime: 30_000, retry: false,
    queryFn: ({ signal }) => managedWeightSpaceApi(api, apiOrigin).capability(query!, signal),
    refetchInterval: result => result.state.error ? false : 60_000,
  });
  const observed = capability.data && Date.parse(capability.data.expiresAt) > Date.now() ? capability.data : null;
  const error = catalog.error ?? capability.error;
  return <>
    <DropdownSelect label="Exact editing checkpoint" searchable disabled={disabled} value={key} options={[
      { value: "", label: "Choose the exact managed checkpoint" },
      ...(value && !options.has(key) ? [{ value: key, label: "Retained checkpoint", disabled: true }] : []),
      ...[...options].map(([value, { name, checkpoint }]) => ({ value, label: name, description: `Tokenizer ${checkpoint.tokenizerRevision.slice(0, 12)}, template ${checkpoint.chatTemplateHash.slice(0, 12)}` })),
    ]} onChange={key => onChange(options.get(key)?.checkpoint)} />
    {catalog.isPending && <p role="status">Reading managed editing checkpoints…</p>}
    {!catalog.isPending && !catalog.error && options.size === 0 && <p>The workspace has no compatible checkpoint in its catalog.</p>}
    {value && <dl className="training-context-facts">
      <dt>Tokenizer revision</dt><dd><code>{value.tokenizerRevision}</code></dd>
      <dt>Chat template hash</dt><dd><code>{value.chatTemplateHash}</code></dd>
    </dl>}
    {value && capability.isFetching && <p role="status">Checking the editing runtime…</p>}
    {observed?.execution.state === "unavailable" && <p role="status">{observed.execution.reason}</p>}
    {observed?.execution.state === "ready" && <p role="status">{observed.validationLevel === "gpu_qualified" ? "GPU runtime qualified." : "Runtime available for plan review."}</p>}
    {error && <ErrorToast error={error}><button type="button" className="training-text-button" onClick={() => void (catalog.error ? catalog.refetch() : capability.refetch())}>Retry checkpoint check</button></ErrorToast>}
  </>;
}

function EditingPanels({ panels, disabled, onChange }: { panels: Panel[]; disabled: boolean; onChange(panels: Panel[]): void }) {
  const [oversize, setOversize] = useState(false);
  function update(panels: Panel[]) {
    const tooLarge = new TextEncoder().encode(JSON.stringify(panels)).byteLength >= TRAINING_JOB_SUBMISSION_MAX_BYTES;
    setOversize(tooLarge);
    if (!tooLarge) onChange(panels);
  }
  const replace = (panel: Panel) => update(panels.map(item => item.id === panel.id ? panel : item));
  function addPanel(role: Panel["role"]) {
    update([...panels, { id: crypto.randomUUID(), role, prompts: [{ id: crypto.randomUUID(), text: "" }] }]);
  }
  return <div className="resource-setup-fields">
    <p>Use development prompts to guide edits and preservation prompts to check behavior you want to keep.</p>
    {panels.map((panel, index) => {
      const title = `${panel.role === "development" ? "Development" : "Preservation"} panel ${index + 1}`;
      return <fieldset key={panel.id} className="resource-setup-fields resource-setup-training-fields" disabled={disabled}>
        <legend>{title}</legend>
        {panel.prompts.map((row, rowIndex) => {
          const change = (patch: Partial<typeof row>) => replace({ ...panel, prompts: panel.prompts.map(item => item.id === row.id ? { ...item, ...patch } : item) });
          return <div key={row.id} className="resource-setup-input">
            <label className="resource-setup-input">{title} prompt {rowIndex + 1}
              <textarea value={row.text} maxLength={32_768} rows={3} onChange={event => change({ text: event.target.value })} /></label>
            <label className="resource-setup-input">{title} system instructions {rowIndex + 1} (optional)
              <textarea value={row.system ?? ""} maxLength={32_768} rows={2} onChange={event => change({ system: event.target.value || undefined })} /></label>
            <button type="button" className="training-text-button" disabled={panel.prompts.length <= 1}
              onClick={() => replace({ ...panel, prompts: panel.prompts.filter(item => item.id !== row.id) })}>Remove prompt</button>
          </div>;
        })}
        <div className="resource-setup-presets">
          <button type="button" className="training-button secondary" disabled={panel.prompts.length >= 64}
            onClick={() => replace({ ...panel, prompts: [...panel.prompts, { id: crypto.randomUUID(), text: "" }] })}>Add prompt</button>
          <button type="button" className="training-text-button" onClick={() => update(panels.filter(item => item.id !== panel.id))}>Remove {title.toLowerCase()}</button>
        </div>
      </fieldset>;
    })}
    <div className="resource-setup-presets">
      <button type="button" className="training-button secondary" disabled={disabled || panels.length >= 4} onClick={() => addPanel("development")}>Add development panel</button>
      <button type="button" className="training-button secondary" disabled={disabled || panels.length >= 4} onClick={() => addPanel("preservation")}>Add preservation panel</button>
    </div>
    {oversize && <p role="status">Reduce the editing prompts to fit within the session input limit.</p>}
  </div>;
}

function EditingSettings({ setup, disabled, onChange }: { setup: Draft; disabled: boolean; onChange(patch: Partial<Draft>): void }) {
  const generation = setup.generation;
  const limits = setup.limits ?? {};
  let budgetError = false;
  try { canonicalComputeSpendCap(setup.maximumSpendUsd); } catch { budgetError = true; }
  return <fieldset className="resource-setup-fields resource-setup-training-fields resource-setup-protocol-fields" disabled={disabled}>
    <legend>Editing settings</legend>
    <p>Generation uses greedy decoding. Enter limits you want to keep. The plan review fills in the remaining limits from the current runtime.</p>
    <label>Maximum output tokens
      <input type="number" min={1} max={2048} value={setup.generation?.maxOutputTokens ?? ""} placeholder={String(weightSpaceGeneration.maxOutputTokens)}
        onChange={event => {
          const input = event.target;
          if (!input.value || WeightSpaceRequestSchema.shape.generation.shape.maxOutputTokens.safeParse(input.valueAsNumber).success)
            onChange({ generation: { ...generation, maxOutputTokens: input.value ? input.valueAsNumber : undefined } });
        }} />
    </label>
    <label>Generation seed
      <input type="number" min={0} max={2_147_483_647} value={setup.generation?.seed ?? ""} placeholder={String(weightSpaceGeneration.seed)}
        onChange={event => {
          const input = event.target;
          if (!input.value || WeightSpaceRequestSchema.shape.generation.shape.seed.safeParse(input.valueAsNumber).success)
            onChange({ generation: { ...generation, seed: input.value ? input.valueAsNumber : undefined } });
        }} />
    </label>
    {(Object.keys(limitLabels) as Array<keyof WeightSpaceLimits>).map(key => {
      const spec = WeightSpaceLimitsSchema.shape[key];
      return <label key={key}>{limitLabels[key]}
        <input type="number" min={spec.minValue ?? 1} max={spec.maxValue ?? undefined} value={limits[key] ?? ""} placeholder="Set in review"
          onChange={event => {
            const input = event.target;
            if (!input.value || spec.safeParse(input.valueAsNumber).success)
              onChange({ limits: { ...limits, [key]: input.value ? input.valueAsNumber : undefined } });
          }} />
      </label>;
    })}
    {limits.maximumIdleSeconds && limits.maximumDurationSeconds && limits.maximumIdleSeconds > limits.maximumDurationSeconds
      ? <p role="status">Set idle time within the session duration before preparing.</p> : null}
    <label>Maximum spend in USD
      <input inputMode="decimal" maxLength={48} value={setup.maximumSpendUsd ?? ""} aria-invalid={budgetError || undefined}
        onChange={event => onChange({ maximumSpendUsd: event.target.value })} />
    </label>
    {budgetError && <p role="status">Enter a positive USD amount with up to six decimal places.</p>}
  </fieldset>;
}
