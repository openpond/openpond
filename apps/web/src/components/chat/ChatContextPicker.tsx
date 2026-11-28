import { useState } from "react";
import { ChatContextTargetSchema, type ChatContextSelection } from "@openpond/contracts";
import type { useChatContextSelection } from "../../hooks/useChatContextSelection";
import { ErrorToast } from "../common/ErrorToast";
import { DropdownSelect } from "../DropdownSelect";
import { ChevronRight } from "../icons";

export type ResourceContextType = "model" | "experiment";
const labels = { model: "Model", experiment: "Benchmark" } as const;

export function selectedResourceContextType(selection: Pick<ChatContextSelection, "target"> | null | undefined): ResourceContextType | null {
  if (!selection) return null;
  return selection.target.kind === "model" || selection.target.kind === "training" ? "model" : "experiment";
}

export function ChatContextPicker({ context, type, disabled, onClose }: {
  context: ReturnType<typeof useChatContextSelection>;
  type: ResourceContextType;
  disabled: boolean;
  onClose(): void;
}) {
  const [error, setError] = useState<string | null>(null);
  const selected = context.selection;
  const choices = (context.catalog.data?.options ?? []).filter(option =>
    option.target.kind !== "dataset" && selectedResourceContextType(option) === type);
  const trainingModelId = selected?.training?.location === "cloud"
    ? selected.training.job.modelProjectId : selected?.training?.modelId;
  const current = selected?.training && type === "model"
    ? choices.find(choice => choice.target.id === trainingModelId && choice.target.location === selected.training?.location) ?? selected
    : selectedResourceContextType(selected) === type ? selected : null;
  const value = current ? JSON.stringify(current.target) : "";
  if (current && !choices.some(choice => JSON.stringify(choice.target) === value)) choices.unshift(current);
  const issue = error ?? context.selectionError?.message ?? context.catalog.error?.message ?? context.catalog.data?.warning;

  async function select(raw: string) {
    setError(null);
    try {
      const fromModel = raw === "saved-model-benchmark";
      const target = fromModel ? current?.target : raw ? ChatContextTargetSchema.parse(JSON.parse(raw)) : null;
      if (fromModel && (target?.kind !== "model" || target.location !== "cloud"))
        throw new Error("Select a hosted saved Model to prepare a Benchmark.");
      if (await context.select(target ?? null, fromModel ? { newExperiment: true } : undefined)) onClose();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not select the resource context.");
    }
  }

  return <div className="composer-context-resources">
    <DropdownSelect searchable compact floating label={`${labels[type]} name`} value={value} floatingMenuWidth={340}
      floatingMenuMaxHeight={360} disabled={disabled || context.selecting}
      triggerContent={<><span>{labels[type]}</span><span className="chat-training-menu-value">
        {current?.label ?? (context.catalog.isPending ? "Loading…" : "None selected")}
      </span><ChevronRight size={14} /></>}
      options={[
        { value: "", label: "Clear resource" },
        ...(type === "model" && current?.target.kind === "model" && current.target.location === "cloud"
          ? [{ value: "saved-model-benchmark", label: "New benchmark from saved Model…", separatorBefore: true }] : []),
        ...choices.map(choice => ({
          value: JSON.stringify(choice.target), label: choice.label,
          description: `${choice.target.location === "cloud" ? "OpenPond Managed" : "Local"}, ${choice.detail}${choices.filter(item => item.label === choice.label && item.target.location === choice.target.location).length > 1 ? `, ${choice.target.id.slice(-8)}` : ""}`,
        })),
      ]} onChange={raw => void select(raw)} />
    {type === "experiment" && context.catalog.hasNextPage ? <button type="button" className="training-text-button"
      disabled={context.catalog.isFetchingNextPage} onClick={() => void context.catalog.fetchNextPage()}>More Benchmarks</button> : null}
    {issue ? <ErrorToast error={issue}>
      {context.catalog.error || context.catalog.data?.warning ? <button type="button" onClick={() => void context.catalog.refetch()}>Retry</button> : null}
    </ErrorToast> : null}
  </div>;
}
