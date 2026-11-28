import { useEffect, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { ActivationExperimentAccountSchema } from "@openpond/contracts";
import { canonicalJson, parseAndVerifySavedModelVersionRead, TrainingPreparationParentSchema } from "openpond-sdk/training";
import { z } from "zod";
import { apiFetch } from "../../api/api-client";
import { chatResourceRequest } from "../../api/chat-resource-api";
import type { ResourceSetupDraft } from "../../lib/resource-setup-prompt";
import { DropdownSelect } from "../DropdownSelect";
import { ErrorToast } from "../common/ErrorToast";
import { SavedTrainingVersionPicker } from "../labs/workspace/BenchmarkVersionChoice";
import { loraContinuationOptions } from "../labs/workspace/training-continuation";
import type { WorkspaceApi } from "../labs/workspace/workspace-api";

type SavedStarts = NonNullable<NonNullable<ResourceSetupDraft["managedTrainingInputs"]>["savedStarts"]>;
type Owner = z.infer<typeof ActivationExperimentAccountSchema>;
const Locator = z.object({ modelProjectId: z.string().min(1).max(240), versionHash: z.string().regex(/^[a-f0-9]{64}$/),
  label: z.string().min(1).max(500) }).strict();
const DecisionCatalog = z.object({ owner: ActivationExperimentAccountSchema, sources: Locator.array().max(1000) }).strict();

export async function readModelSetupSavedVersion(api: WorkspaceApi, source: Pick<z.infer<typeof Locator>, "modelProjectId" | "versionHash">, signal?: AbortSignal) {
  const params = new URLSearchParams({ teamId: api.teamId, versionHash: source.versionHash });
  const result = await parseAndVerifySavedModelVersionRead(await apiFetch(api.connection,
    `/v1/training/saved-models/${encodeURIComponent(source.modelProjectId)}/version?${params}`, { signal }),
  api.teamId, source.modelProjectId, source.versionHash);
  if (!result.version) throw new Error("The saved Model version is unavailable in the current workspace.");
  return result.version;
}

export function ModelSetupGrpoParent({ api, value, disabled, onChange }: {
  api: WorkspaceApi; value?: SavedStarts["grpo"]; disabled: boolean; onChange(value?: SavedStarts["grpo"]): void;
}) {
  return <>
    <SavedTrainingVersionPicker api={api} label="Saved GRPO checkpoint" selected={value} disabled={disabled}
      validate={version => {
        const base = version.request.baseModel;
        if (version.request.recipe.method !== "grpo" || base.source !== "managed" || !base.revision || !base.tokenizerRevision || !base.chatTemplateHash)
          throw new Error("Choose a saved GRPO checkpoint with an exact managed base.");
      }} onSelect={choice => onChange(choice ? {
        method: "grpo", modelProjectId: choice.version.modelProjectId, versionHash: choice.version.contentHash, jobId: choice.version.jobId,
        label: choice.label, base: choice.version.request.baseModel, adapterMode: value?.adapterMode ?? "residual_append",
      } : undefined)} />
    {value && <label className="resource-setup-input">LoRA continuation
      <DropdownSelect label="LoRA continuation" value={value.adapterMode} disabled={disabled} options={loraContinuationOptions}
        onChange={mode => {
          const parsed = TrainingPreparationParentSchema.shape.adapterMode.safeParse(mode);
          if (parsed.success) onChange({ ...value, adapterMode: parsed.data });
        }} />
    </label>}
  </>;
}

export function ModelSetupDecisionParent({ api, owner, value, disabled, onChange }: {
  api: WorkspaceApi; owner: Owner; value?: SavedStarts["decision_model"]; disabled: boolean;
  onChange(value?: SavedStarts["decision_model"]): void;
}) {
  const catalog = useQuery({ queryKey: ["saved-decision-training-sources", api.key, api.connection.serverUrl, owner], retry: false, staleTime: 30_000,
    queryFn: async ({ signal }) => {
      const result = DecisionCatalog.parse(await chatResourceRequest(api.connection, "dataset", { action: "context_decision_sources", payload: owner }, signal));
      if (canonicalJson(result.owner) !== canonicalJson(owner)) throw new Error("The saved Decision Model catalog changed workspace.");
      return result.sources;
    } });
  const active = useRef<AbortController | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<unknown>(null);
  useEffect(() => () => active.current?.abort(), []);
  const key = (source: { modelProjectId: string; versionHash: string }) => JSON.stringify([source.modelProjectId, source.versionHash]);
  const entries = new Map(catalog.data?.map(source => [key(source), source]));
  const selected = value ? key(value) : "";
  const options = [...entries.values()].map(source => ({ value: key(source), label: source.label, description: `Version ${source.versionHash.slice(0, 12)}` }));
  if (value && !entries.has(selected)) options.unshift({ value: selected, label: value.label, description: `Retained version ${value.versionHash.slice(0, 12)}` });

  async function choose(id: string) {
    setError(null);
    if (!id) { onChange(undefined); return; }
    const source = entries.get(id);
    if (!source || active.current) return;
    const controller = new AbortController(); active.current = controller; setLoading(true);
    try {
      const version = await readModelSetupSavedVersion(api, source, controller.signal);
      if (version.schemaVersion !== "openpond.decisionModelVersion.v1" || version.ownerUserId !== owner.actorId)
        throw new Error("Choose a saved Decision adapter owned by the active account.");
      if (!controller.signal.aborted) onChange({ ...source, method: "decision_model", base: version.baseModel });
    } catch (cause) {
      if (!controller.signal.aborted) setError(cause);
    } finally {
      if (active.current === controller) { active.current = null; setLoading(false); }
    }
  }

  return <div className="resource-setup-input">
    <span>Saved Decision adapter</span>
    <DropdownSelect label="Saved Decision adapter" searchable disabled={disabled || loading} value={selected}
      options={[{ value: "", label: "Start from the Decision base" }, ...options]} onChange={id => void choose(id)} />
    {catalog.isPending && <p role="status">Reading saved Decision adapters…</p>}
    {catalog.isSuccess && options.length === 0 && <p>No saved Decision adapters in this workspace.</p>}
    <ErrorToast error={error ?? catalog.error}>
      {catalog.error && <button type="button" className="training-text-button" onClick={() => void catalog.refetch()}>Retry saved adapters</button>}
    </ErrorToast>
  </div>;
}
