import { useEffect, useMemo, useRef, useState } from "react";
import type { CodexReasoningEffort } from "@openpond/contracts";
import { Check, ChevronDown, Cloud, Folder, Plus } from "../icons";
import { CODEX_MODEL_OPTIONS, CODEX_REASONING_EFFORT_OPTIONS } from "../../lib/app-models";
import type { WorkspaceLocation, WorkspaceTargetState } from "../../lib/workspace-location";
import { CloudMoveIcon } from "../common/CloudMoveIcon";

export type ComposerProjectTargetOptionKind =
  | "local"
  | "cloud"
  | "none"
  | "action";

export type ComposerProjectTargetOption = {
  value: string;
  label: string;
  detail: string;
  kind: ComposerProjectTargetOptionKind;
  disabled?: boolean;
  disabledReason?: string | null;
};

export type ComposerProjectTargetState = {
  value: string;
  label: string;
  detail: string;
  options: ComposerProjectTargetOption[];
  busy: boolean;
};

export function ComposerProjectTargetControl({
  busy,
  placement,
  state,
  onChange,
}: {
  busy: boolean;
  placement: "bottom" | "top";
  state: ComposerProjectTargetState;
  onChange: (value: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const menuRef = useRef<HTMLDivElement | null>(null);
  const selectedIconKind =
    state.options.find((option) => option.value === state.value)?.kind ?? "local";
  const visibleOptions = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return state.options;
    return state.options.filter((option) =>
      [option.label, option.detail]
        .filter(Boolean)
        .some((value) => value.toLowerCase().includes(needle)),
    );
  }, [query, state.options]);

  useEffect(() => {
    if (!open) {
      setQuery("");
      return;
    }
    function handlePointerDown(event: PointerEvent) {
      if (!menuRef.current?.contains(event.target as Node)) setOpen(false);
    }
    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") setOpen(false);
    }
    document.addEventListener("pointerdown", handlePointerDown);
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("pointerdown", handlePointerDown);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [open]);

  return (
    <div
      className={`composer-project-target ${placement === "top" ? "open-up" : ""}`}
      data-tooltip={`${state.label}: ${state.detail}`}
      ref={menuRef}
    >
      <button
        type="button"
        className={`composer-project-trigger ${open ? "active" : ""} ${selectedIconKind}`}
        disabled={busy}
        aria-label="Project"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((current) => !current)}
      >
        <ProjectTargetIcon kind={selectedIconKind} size={14} />
        <span>{state.label}</span>
        <ChevronDown size={14} />
      </button>
      {open && (
        <div className="composer-project-menu" role="menu" aria-label="Project">
          <div className="composer-menu-search">
            <input
              autoFocus
              value={query}
              placeholder="Search projects"
              onChange={(event) => setQuery(event.target.value)}
            />
          </div>
          <div className="composer-menu-items">
            {visibleOptions.length === 0 ? (
              <div className="composer-menu-empty">No projects found</div>
            ) : (
              visibleOptions.map((option) => {
                const selected = option.value === state.value;
                const disabled = busy || option.disabled;
                const title = option.disabled && option.disabledReason
                  ? option.disabledReason
                  : `${option.label}: ${option.detail}`;
                return (
                  <button
                    key={option.value}
                    type="button"
                    role="menuitemradio"
                    aria-checked={selected}
                    className={`composer-project-option ${selected ? "selected" : ""} ${option.kind}`}
                    disabled={disabled}
                    data-tooltip={title}
                    onClick={() => {
                      onChange(option.value);
                      setOpen(false);
                    }}
                  >
                    <ProjectTargetIcon kind={option.kind} size={14} />
                    <span>
                      <strong>{option.label}</strong>
                      <small>{option.detail}</small>
                    </span>
                    {selected && <Check size={14} />}
                  </button>
                );
              })
            )}
          </div>
        </div>
      )}
    </div>
  );
}

function ProjectTargetIcon({
  kind,
  size,
}: {
  kind: ComposerProjectTargetOptionKind;
  size: number;
}) {
  if (kind === "cloud") return <Cloud size={size} />;
  if (kind === "action") return <Plus size={size} />;
  return <Folder size={size} />;
}

export function WorkspaceActionControl({
  busy,
  state,
  onChange,
}: {
  busy: boolean;
  state: WorkspaceTargetState;
  onChange: (value: WorkspaceLocation) => void;
}) {
  const action = state.action;
  const disabled = busy || action.disabled;
  const iconOnly = action.value === "cloud";
  const tooltip = action.disabled && action.disabledReason
    ? action.disabledReason
    : iconOnly
      ? action.label
      : `${action.label}: ${action.detail}`;

  return (
    <button
      type="button"
      className={`workspace-action-trigger ${action.value} ${iconOnly ? "icon-only" : ""}`}
      disabled={disabled}
      aria-label={action.label}
      data-tooltip={tooltip}
      onClick={() => onChange(action.value)}
    >
      {action.value === "cloud" ? <CloudMoveIcon size={14} /> : <Folder size={14} />}
      {!iconOnly && <span>{action.label}</span>}
    </button>
  );
}

export function CodexModelReasoningMenu({
  disabled,
  model,
  placement,
  reasoningEffort,
  onModelChange,
  onReasoningEffortChange,
}: {
  disabled: boolean;
  model: string;
  placement: "bottom" | "top";
  reasoningEffort: CodexReasoningEffort;
  onModelChange: (value: string) => void;
  onReasoningEffortChange: (value: CodexReasoningEffort) => void;
}) {
  const [open, setOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const selectedModel = CODEX_MODEL_OPTIONS.find((option) => option.value === model) ?? CODEX_MODEL_OPTIONS[0]!;
  const selectedReasoning =
    CODEX_REASONING_EFFORT_OPTIONS.find((option) => option.value === reasoningEffort) ??
    CODEX_REASONING_EFFORT_OPTIONS[1]!;
  const triggerLabel = `${compactCodexModelLabel(selectedModel.label)} ${selectedReasoning.shortLabel ?? selectedReasoning.label}`;

  useEffect(() => {
    if (!open) return;
    function handlePointerDown(event: PointerEvent) {
      if (!menuRef.current?.contains(event.target as Node)) setOpen(false);
    }
    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") setOpen(false);
    }
    document.addEventListener("pointerdown", handlePointerDown);
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("pointerdown", handlePointerDown);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [open]);

  return (
    <div
      className={`codex-model-reasoning ${placement === "top" ? "open-up" : ""}`}
      data-tooltip="Model and reasoning"
      ref={menuRef}
    >
      <button
        type="button"
        className={`codex-model-trigger ${open ? "active" : ""}`}
        disabled={disabled}
        aria-label="Model and reasoning"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((current) => !current)}
      >
        <span>{triggerLabel}</span>
        <ChevronDown size={14} />
      </button>
      {open && (
        <div className="codex-model-menu" role="menu" aria-label="Model and reasoning">
          <div className="codex-model-menu-title">Reasoning</div>
          {CODEX_REASONING_EFFORT_OPTIONS.map((option) => (
            <button
              key={option.value}
              type="button"
              role="menuitemradio"
              aria-checked={option.value === reasoningEffort}
              className={option.value === reasoningEffort ? "selected" : ""}
              onClick={() => onReasoningEffortChange(option.value)}
            >
              <span>{option.label}</span>
              {option.value === reasoningEffort && <Check size={14} />}
            </button>
          ))}
          <div className="codex-model-menu-title">Model</div>
          {CODEX_MODEL_OPTIONS.map((option) => (
            <button
              key={option.value}
              type="button"
              role="menuitemradio"
              aria-checked={option.value === model}
              className={option.value === model ? "selected" : ""}
              onClick={() => onModelChange(option.value)}
            >
              <span>{option.label}</span>
              {option.value === model && <Check size={14} />}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function compactCodexModelLabel(label: string): string {
  return label.replace(/^GPT-/, "").replace(/\s+Codex Spark$/, " Spark").replace(/\s+Codex$/, " Codex");
}
