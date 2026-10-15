import { useState } from "react";
import { ChatContextTargetSchema } from "@openpond/contracts";
import { CHAT_CONTEXT_SELECTED, type useChatContextSelection } from "../../hooks/useChatContextSelection";
import { DropdownSelect } from "../DropdownSelect";
import { ChevronDown } from "../icons";
import { ErrorToast } from "../common/ErrorToast";
import "./composer-resources.css";

/** Model/run focus keeps the original compact control geometry. */
export function ComposerTrainingControls({ context, sessionId, busy }: {
  context: ReturnType<typeof useChatContextSelection>; sessionId: string | null; busy: boolean;
}) {
  const [error, setError] = useState<string | null>(null);
  const selected = context.selection;
  if (!selected) return null;
  const training = selected.training, model = selected.model;
  const disabled = busy || context.selecting;
  const runValue = training ? JSON.stringify(selected.target) : "";
  const runs = (context.runs.data?.runs ?? []).map(item => ({ value: JSON.stringify(item.target), label: item.label, description: item.detail }));
  if (training && !runs.some(item => item.value === runValue)) runs.unshift({ value: runValue, label: selected.label, description: selected.detail });
  const models = (context.catalog.data?.options ?? []).filter(item => item.target.kind === "model");
  const currentModel = models.find(item => item.target.id === model?.id && item.target.location === selected.target.location);
  const modelTarget = currentModel?.target ?? (model ? { ...selected.target, kind: "model", id: model.id } : null);
  const modelValue = modelTarget ? JSON.stringify(modelTarget) : "";
  const modelOptions = models.map(item => ({ value: JSON.stringify(item.target), label: item.label, description: item.detail }));
  if (modelTarget && !modelOptions.some(item => item.value === modelValue)) modelOptions.unshift({ value: modelValue, label: model?.name ?? selected.label, description: selected.detail });
  async function choose(raw: string) {
    try { setError(null); await context.select(ChatContextTargetSchema.parse(JSON.parse(raw))); }
    catch (cause) { setError(cause instanceof Error ? cause.message : "Training selection failed."); }
  }
  return <div className="composer-resource-area">
    <div className="composer-resource-bar" aria-label="Current training">
      <DropdownSelect compact floating searchable placement="top" floatingMenuWidth={320} label="Model focus" className="composer-resource-dataset" value={modelValue}
        triggerContent={<><span className="composer-resource-dataset-name">{model?.name ?? selected.label}</span><ChevronDown size={12} /></>}
        options={modelOptions} onChange={raw => void choose(raw)} disabled={disabled} />
      <DropdownSelect compact floating placement="top" floatingMenuWidth={320} label="Training run" className="composer-resource-graders" value={runValue}
        options={runs.length ? runs : [{ value: "", label: context.runs.isPending ? "Loading runs…" : "No runs", disabled: true }]}
        onChange={raw => void choose(raw)} disabled={disabled || context.runs.isPending} />
      <button type="button" className="composer-resource-primary" onClick={() => window.dispatchEvent(new CustomEvent(CHAT_CONTEXT_SELECTED, { detail: { sessionId, scope: context.scope, targetKey: JSON.stringify(selected.target) } }))}>View progress</button>
    </div>
    <ErrorToast error={error ?? context.runs.error} />
  </div>;
}
