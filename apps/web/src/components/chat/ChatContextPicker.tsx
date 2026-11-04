import { ErrorToast } from "../common/ErrorToast";
import { useEffect, useRef, useState } from "react";
import { ChatContextTargetSchema } from "@openpond/contracts";
import type { useChatContextSelection } from "../../hooks/useChatContextSelection";
import { DropdownSelect } from "../DropdownSelect";
import { ChevronDown, ChevronRight } from "../icons";

type ContextType = "experiment" | "model";
const typeLabels = { experiment: "Experiment", model: "Model" } as const;

export function ChatContextPicker({
  context,
  disabled = false,
  placement = "bottom",
}: {
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
  const selectedType =
    selected?.target.kind === "training"
      ? "model"
      : selected?.target.kind === "dataset" ||
          selected?.target.kind === "training_result" ||
          selected?.target.kind === "managed_modification_result" ||
          selected?.target.kind === "engram_result" ||
          selected?.target.kind === "decision_result" ||
          selected?.target.kind === "alphaedit_result" ||
          selected?.target.kind === "neuron_training_result"
        ? "experiment"
        : selected?.target.kind;
  const type = draftType ?? selectedType ?? "experiment";
  const choices = (context.catalog.data?.options ?? []).filter(
    (option) =>
      option.target.kind === type ||
      (type === "experiment" &&
        (Boolean(option.target.result) || option.target.kind === "decision_result" ||
          option.target.kind === "alphaedit_result" ||
          option.target.kind === "neuron_training_result")),
  );
  const modelId = selected?.training
    ? selected.training.location === "cloud"
      ? selected.training.job.modelProjectId
      : selected.training.modelId
    : null;
  const current =
    selected?.target.kind === type ||
    (type === "experiment" &&
      (selected?.target.kind === "dataset" || Boolean(selected?.target.result) ||
        selected?.target.kind === "decision_result" ||
        selected?.target.kind === "alphaedit_result" ||
        selected?.target.kind === "neuron_training_result"))
      ? selected
      : type === "model" && modelId
        ? choices.find(
            (choice) =>
              choice.target.id === modelId &&
              choice.target.location === selected?.training?.location,
          )
        : null;
  const value = current ? JSON.stringify(current.target) : "";
  if (current && !choices.some((choice) => JSON.stringify(choice.target) === value))
    choices.unshift(current);
  const unavailable = disabled || context.selecting;
  const issue =
    error ??
    context.selectionError?.message ??
    context.catalog.error?.message ??
    context.catalog.data?.warning;
  useEffect(() => {
    if (!open) return;
    function pointer(event: PointerEvent) {
      if (!menuRef.current?.contains(event.target as Node)) setOpen(false);
    }
    function key(event: KeyboardEvent) {
      if (event.key === "Escape") {
        setOpen(false);
        triggerRef.current?.focus();
      }
    }
    document.addEventListener("pointerdown", pointer);
    document.addEventListener("keydown", key);
    return () => {
      document.removeEventListener("pointerdown", pointer);
      document.removeEventListener("keydown", key);
    };
  }, [open]);
  async function select(raw: string) {
    setError(null);
    try {
      if (raw === "saved-model-experiment") {
        if (!current || current.target.kind !== "model" || current.target.location !== "cloud")
          throw new Error("Select the hosted saved Model first.");
        if (await context.select(current.target, { newExperiment: true })) setOpen(false);
        return;
      }
      if (raw === "new-experiment") {
        const id = `draft-${crypto.randomUUID()}`;
        if (
          await context.select(
            {
              kind: "experiment",
              id,
              location: "local",
              draft: {
                schemaVersion: "openpond.experimentDraft.v1",
                id,
                operationType: "evaluate",
                name: "Evaluation",
              },
            },
            { newExperiment: true },
          )
        )
          setOpen(false);
        return;
      }
      if (!(await context.select(raw ? ChatContextTargetSchema.parse(JSON.parse(raw)) : null)))
        return;
      setOpen(false);
      triggerRef.current?.focus();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Training selection failed.");
    }
  }
  return (
    <div
      ref={menuRef}
      className={`chat-context-picker codex-model-reasoning${placement === "top" ? " open-up" : ""}`}
    >
      <button
        ref={triggerRef}
        type="button"
        className={`composer-project-trigger chat-training-trigger${open ? " active" : ""}`}
        aria-label="Ponder"
        aria-haspopup="dialog"
        aria-expanded={open}
        disabled={unavailable}
        title={selected ? `${selected.label}: ${selected.detail}` : "Ponder"}
        onClick={() => {
          setDraftType(null);
          setOpen((value) => !value);
        }}
      >
        <span>
          {selected?.target.kind === "dataset"
            ? `Experiment draft · ${selected.label}`
            : (selected?.model?.name ?? selected?.label ?? "Ponder")}
        </span>
        <ChevronDown size={14} />
      </button>
      {open ? (
        <div
          className="codex-model-menu chat-training-menu"
          role="dialog"
          aria-label="Training context"
        >
          <DropdownSelect
            compact
            floating
            label="Training type"
            value={type}
            floatingMenuWidth={180}
            options={Object.entries(typeLabels).map(([value, label]) => ({ value, label }))}
            triggerContent={
              <>
                <span>Type</span>
                <span className="chat-training-menu-value">{typeLabels[type]}</span>
                <ChevronRight size={14} />
              </>
            }
            disabled={unavailable}
            onChange={(value) => setDraftType(value as ContextType)}
          />
          <DropdownSelect
            compact
            floating
            label={`${typeLabels[type]} name`}
            value={value}
            floatingMenuWidth={340}
            floatingMenuMaxHeight={360}
            triggerContent={
              <>
                <span>{typeLabels[type]}</span>
                <span className="chat-training-menu-value">
                  {(current?.target.kind === "dataset"
                    ? `Draft · ${current.label}`
                    : current?.label) ?? (context.catalog.isPending ? "Loading…" : "None")}
                </span>
                <ChevronRight size={14} />
              </>
            }
            options={[
              { value: "", label: "None" },
              ...(type === "model" &&
              current?.target.kind === "model" &&
              current.target.location === "cloud"
                ? [
                    {
                      value: "saved-model-experiment",
                      label: "New experiment from saved Model…",
                      separatorBefore: true,
                    },
                  ]
                : []),
              ...(type === "experiment"
                ? [{ value: "new-experiment", label: "New experiment…", separatorBefore: true }]
                : []),
              ...choices.map((choice) => ({
                value: JSON.stringify(choice.target),
                label: choice.label,
                description: `${choice.target.location === "cloud" ? "OpenPond Managed" : "Local"} · ${choice.detail}${choices.filter((item) => item.label === choice.label && item.target.location === choice.target.location).length > 1 ? ` · ${choice.target.id.slice(-8)}` : ""}`,
              })),
            ]}
            disabled={unavailable}
            onChange={(raw) => void select(raw)}
          />
          {type === "experiment" && context.catalog.hasNextPage ? (
            <button
              type="button"
              disabled={context.catalog.isFetchingNextPage}
              onClick={() => void context.catalog.fetchNextPage()}
            >
              More saved experiments
            </button>
          ) : null}
          {issue ? (
            <ErrorToast error={issue}>
              {context.catalog.error ? (
                <button type="button" onClick={() => void context.catalog.refetch()}>
                  Retry
                </button>
              ) : null}
            </ErrorToast>
          ) : null}
        </div>
      ) : issue ? (
        <ErrorToast error={issue} />
      ) : null}
    </div>
  );
}
