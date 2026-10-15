import { ErrorToast } from "../common/ErrorToast";
import { useEffect, useRef, useState } from "react";
import { ChatContextTargetSchema } from "@openpond/contracts";
import type { useChatContextSelection } from "../../hooks/useChatContextSelection";
import { DropdownSelect } from "../DropdownSelect";
import { ChevronDown, ChevronRight } from "../icons";

type ContextType = "dataset" | "experiment" | "model";
const typeLabels = { dataset: "Dataset", experiment: "Experiment", model: "Model" } as const;

export function ChatContextPicker({ context, disabled = false, placement = "bottom" }: {
  context: ReturnType<typeof useChatContextSelection>;
  disabled?: boolean;
  placement?: "top" | "bottom";
}) {
  const [open, setOpen] = useState(false);
  const [draftType, setDraftType] = useState<ContextType | null>(null);
  const [error, setError] = useState<string | null>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const selected = context.selection;
  const selectedType = selected?.target.kind === "training" ? "model" : selected?.target.kind;
  const type = draftType ?? selectedType ?? "dataset";
  const choices = (context.catalog.data?.options ?? []).filter(option => option.target.kind === type);
  const modelId = selected?.training
    ? selected.training.location === "cloud" ? selected.training.job.modelProjectId : selected.training.modelId
    : null;
  const current = selected?.target.kind === type ? selected : type === "model" && modelId
    ? choices.find(choice => choice.target.id === modelId && choice.target.location === selected?.training?.location)
    : null;
  const value = current ? JSON.stringify(current.target) : "";
  if (current && !choices.some(choice => JSON.stringify(choice.target) === value)) choices.unshift(current);
  const unavailable = disabled || context.selecting;
  const issue = error ?? context.selectionError?.message ?? context.catalog.error?.message ?? context.catalog.data?.warning;
  useEffect(() => {
    if (!open) return;
    function pointer(event: PointerEvent) {
      if (!menuRef.current?.contains(event.target as Node)) setOpen(false);
    }
    function key(event: KeyboardEvent) {
      if (event.key === "Escape") { setOpen(false); triggerRef.current?.focus(); }
    }
    document.addEventListener("pointerdown", pointer);
    document.addEventListener("keydown", key);
    return () => { document.removeEventListener("pointerdown", pointer); document.removeEventListener("keydown", key); };
  }, [open]);
  async function select(raw: string) {
    setError(null);
    try {
      await context.select(raw ? ChatContextTargetSchema.parse(JSON.parse(raw)) : null);
      setOpen(false); triggerRef.current?.focus();
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Training selection failed."); }
  }
  return <div ref={menuRef} className={`chat-context-picker codex-model-reasoning${placement === "top" ? " open-up" : ""}`}>
    <button ref={triggerRef} type="button" className={`composer-project-trigger chat-training-trigger${open ? " active" : ""}`}
      aria-label="Training" aria-haspopup="dialog" aria-expanded={open} disabled={unavailable}
      title={selected ? `${selected.label}: ${selected.detail}` : "Training"}
      onClick={() => { setDraftType(null); setOpen(value => !value); }}>
      <span>{selected?.label ?? "Training"}</span><ChevronDown size={14} />
    </button>
    {open ? <div className="codex-model-menu chat-training-menu" role="dialog" aria-label="Training context">
      <DropdownSelect compact floating label="Training type" value={type}
        floatingMenuWidth={180}
        options={Object.entries(typeLabels).map(([value, label]) => ({ value, label }))}
        triggerContent={<><span>Type</span><span className="chat-training-menu-value">{typeLabels[type]}</span><ChevronRight size={14} /></>}
        disabled={unavailable} onChange={value => setDraftType(value as ContextType)} />
      <DropdownSelect compact floating label={`${typeLabels[type]} name`} value={value}
        floatingMenuWidth={340} floatingMenuMaxHeight={360}
        triggerContent={<><span>{typeLabels[type]}</span><span className="chat-training-menu-value">{current?.label ?? (context.catalog.isPending ? "Loading…" : "None")}</span><ChevronRight size={14} /></>}
        options={[{ value: "", label: "None" }, ...choices.map(choice => ({ value: JSON.stringify(choice.target), label: choice.label, description: choice.detail }))]}
        disabled={unavailable || context.catalog.isPending} onChange={raw => void select(raw)} />
      {issue ? <ErrorToast error={issue}>{context.catalog.error ? <button type="button" onClick={() => void context.catalog.refetch()}>Retry</button> : null}</ErrorToast> : null}
    </div> : issue ? <ErrorToast error={issue} /> : null}
  </div>;
}
