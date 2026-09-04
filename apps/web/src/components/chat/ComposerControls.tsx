import { useEffect, useMemo, useRef, useState } from "react";
import type { ChatProvider, CodexReasoningEffort } from "@openpond/contracts";
import {
  ArrowLeft,
  Check,
  ChevronDown,
  ChevronRight,
  Cloud,
  Folder,
  Plus,
  UploadCloud,
} from "../icons";
import { CODEX_REASONING_EFFORT_OPTIONS } from "../../lib/app-models";
import type { DropdownOption } from "../../lib/app-models";
import type {
  WorkspaceTargetOptionState,
  WorkspaceTargetState,
  WorkspaceTargetValue,
} from "../../lib/workspace-location";

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

export type ComposerProfileTargetState = {
  value: string;
  label: string;
  options: Array<{ value: string; label: string; detail: string }>;
};

export function ComposerProfileTargetControl({
  busy,
  placement,
  state,
  onChange,
}: {
  busy: boolean;
  placement: "bottom" | "top";
  state: ComposerProfileTargetState;
  onChange: (value: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const menuRef = useRef<HTMLDivElement | null>(null);
  const visibleOptions = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return state.options;
    return state.options.filter((option) =>
      `${option.label} ${option.detail}`.toLowerCase().includes(needle),
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

  if (state.options.length <= 1) return null;
  return (
    <div className={`composer-profile-target ${placement === "top" ? "open-up" : ""}`} ref={menuRef}>
      <button
        type="button"
        className={`composer-profile-trigger ${open ? "active" : ""}`}
        disabled={busy}
        aria-label="Profile"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((current) => !current)}
      >
        <span>{state.label}</span>
        <ChevronDown size={14} />
      </button>
      {open ? (
        <div className="composer-project-menu" role="menu" aria-label="Profile">
          <div className="composer-menu-search">
            <input
              autoFocus
              value={query}
              placeholder="Search profiles"
              onChange={(event) => setQuery(event.currentTarget.value)}
            />
          </div>
          <div className="composer-menu-items">
            {visibleOptions.map((option) => {
              const selected = option.value === state.value;
              return (
                <button
                  key={option.value}
                  type="button"
                  role="menuitemradio"
                  aria-checked={selected}
                  className={`composer-project-option ${selected ? "selected" : ""}`}
                  onClick={() => {
                    onChange(option.value);
                    setOpen(false);
                  }}
                >
                  <span>
                    <strong>{option.label}</strong>
                    <small>{option.detail}</small>
                  </span>
                  {selected ? <Check size={14} /> : null}
                </button>
              );
            })}
          </div>
        </div>
      ) : null}
    </div>
  );
}

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
  const [newMenuOpen, setNewMenuOpen] = useState(false);
  const [query, setQuery] = useState("");
  const menuRef = useRef<HTMLDivElement | null>(null);
  const noProjectSelected = state.value === "none";
  const triggerLabel = noProjectSelected ? "Select Project" : state.label;
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
  const visibleProjectOptions = visibleOptions.filter(
    (option) => option.kind === "local" || option.kind === "cloud"
  );
  const visibleCreationOptions = visibleOptions.filter(
    (option) => option.kind === "action"
  );
  const visibleNoProjectOptions = visibleOptions.filter(
    (option) => option.kind === "none"
  );

  useEffect(() => {
    if (!open) {
      setQuery("");
      setNewMenuOpen(false);
      return;
    }
    function handlePointerDown(event: PointerEvent) {
      if (!menuRef.current?.contains(event.target as Node)) setOpen(false);
    }
    function handleKeyDown(event: KeyboardEvent) {
      if (event.key !== "Escape") return;
      if (newMenuOpen) setNewMenuOpen(false);
      else setOpen(false);
    }
    document.addEventListener("pointerdown", handlePointerDown);
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("pointerdown", handlePointerDown);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [newMenuOpen, open]);

  function renderOption(option: ComposerProjectTargetOption) {
    const selected = option.value === state.value;
    const disabled = busy || option.disabled;
    const action = option.kind === "action";
    return (
      <button
        key={option.value}
        type="button"
        role={action ? "menuitem" : "menuitemradio"}
        aria-checked={action ? undefined : selected}
        className={`composer-project-option ${
          selected ? "selected" : ""
        } ${option.kind}`}
        disabled={disabled}
        onClick={() => {
          onChange(option.value);
          setNewMenuOpen(false);
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
  }

  return (
    <div
      className={`composer-project-target ${placement === "top" ? "open-up" : ""}`}
      ref={menuRef}
    >
      <button
        type="button"
        className={`composer-project-trigger ${open ? "active" : ""} ${selectedIconKind}`}
        disabled={busy}
        aria-label="Project"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => {
          setOpen((current) => !current);
          setNewMenuOpen(false);
        }}
      >
        <ProjectTargetIcon kind={selectedIconKind} size={14} />
        <span>{triggerLabel}</span>
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
              visibleProjectOptions.map(renderOption)
            )}
          </div>
          {visibleCreationOptions.length > 0 ||
          visibleNoProjectOptions.length > 0 ? (
            <div className="composer-project-actions">
              {visibleCreationOptions.length > 0 ? (
                <button
                  type="button"
                  role="menuitem"
                  className={`composer-project-option action composer-project-new-trigger ${
                    newMenuOpen ? "selected" : ""
                  }`}
                  aria-haspopup="menu"
                  aria-expanded={newMenuOpen}
                  onClick={() => setNewMenuOpen((current) => !current)}
                >
                  <Plus size={14} />
                  <span>
                    <strong>New</strong>
                    <small>Create or add a project</small>
                  </span>
                  <ChevronRight size={14} />
                </button>
              ) : null}
              {visibleNoProjectOptions.map(renderOption)}
            </div>
          ) : null}
        </div>
      )}
      {open && newMenuOpen ? (
        <div
          className="composer-project-new-menu"
          role="menu"
          aria-label="New project"
        >
          <button
            type="button"
            role="menuitem"
            className="composer-project-new-menu-back"
            onClick={() => setNewMenuOpen(false)}
          >
            <ArrowLeft size={14} />
            <span>New project</span>
          </button>
          {visibleCreationOptions.map(renderOption)}
        </div>
      ) : null}
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
  placement,
  state,
  onChange,
}: {
  busy: boolean;
  placement: "bottom" | "top";
  state: WorkspaceTargetState;
  onChange: (value: WorkspaceTargetValue) => void;
}) {
  const [open, setOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const selectedIconKind =
    state.value === "cloud"
      ? "cloud"
      : state.value === "hybrid"
        ? "hybrid"
        : "local";
  const tooltip = `${state.label}: ${state.detail}`;
  const uploadAction = state.uploadAction ?? null;
  const uploadStatusText = uploadAction ? workspaceTargetOptionStatusText(uploadAction) : null;
  const uploadTooltip = uploadAction
    ? uploadAction.disabled && uploadAction.disabledReason
      ? uploadAction.disabledReason
      : `${uploadAction.label}: ${uploadStatusText ?? uploadAction.detail}`
    : null;
  const uploadDisabled = Boolean(uploadAction && (busy || state.busy || uploadAction.disabled));

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
      className={`workspace-action-control ${placement === "top" ? "open-up" : ""}`}
      ref={menuRef}
    >
      <button
        type="button"
        className={`workspace-action-trigger ${selectedIconKind} ${open ? "active" : ""}`}
        disabled={busy}
        data-tooltip={tooltip}
        aria-label="Working in"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((current) => !current)}
      >
        <WorkspaceTargetIcon value={state.value} size={14} />
        <span className="workspace-target-trigger-label">{state.label}</span>
        <ChevronDown size={14} />
      </button>
      {uploadAction ? (
        <button
          type="button"
          className={`workspace-upload-trigger ${uploadAction.value}`}
          disabled={uploadDisabled}
          data-tooltip={uploadTooltip ?? undefined}
          aria-label={uploadAction.label}
          onClick={() => {
            onChange(uploadAction.value);
            setOpen(false);
          }}
        >
          <WorkspaceTargetIcon value={uploadAction.value} size={14} />
        </button>
      ) : null}
      {open && (
        <div className="workspace-target-menu" role="menu" aria-label="Working in">
          {state.options.map((option) => {
            const selected = option.value === state.value;
            const disabled = busy || state.busy || option.disabled;
            const statusText = workspaceTargetOptionStatusText(option);
            const secondaryText = statusText ?? option.detail;
            const title = option.disabled && option.disabledReason
              ? option.disabledReason
              : `${option.label}: ${secondaryText}`;
            return (
              <button
                key={option.value}
                type="button"
                role="menuitemradio"
                aria-checked={selected}
                className={`workspace-target-option ${selected ? "selected" : ""} ${option.value}`}
                disabled={disabled}
                data-tooltip={title}
                onClick={() => {
                  onChange(option.value);
                  setOpen(false);
                }}
              >
                <WorkspaceTargetIcon value={option.value} size={14} />
                <span>
                  <strong>{option.label}</strong>
                  <small>{secondaryText}</small>
                </span>
                {selected && <Check size={14} />}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

export function ComposerPinnedWorkspaceContext({
  project,
  workspace,
}: {
  project: ComposerProjectTargetState;
  workspace: WorkspaceTargetState;
}) {
  const projectOption = project.options.find(
    (option) => option.value === project.value,
  );
  const projectKind = projectOption?.kind ?? "none";
  const projectLabel = project.value === "none" ? "No Project" : project.label;

  return (
    <div className="composer-footer composer-pinned-context" role="group" aria-label="Task context">
      <span className="composer-context-chip" aria-label={`Project: ${projectLabel}`}>
        <ProjectTargetIcon kind={projectKind} size={14} />
        <span>{projectLabel}</span>
      </span>
      <span className="composer-context-chip" aria-label={`Execution: ${workspace.label}`}>
        <WorkspaceTargetIcon value={workspace.value} size={14} />
        <span>{workspace.label}</span>
      </span>
    </div>
  );
}

export function workspaceTargetOptionStatusText(
  option: Pick<WorkspaceTargetOptionState, "disabled" | "disabledReason" | "stateNote">,
): string | null {
  if (option.disabled && option.disabledReason) return option.disabledReason;
  return option.stateNote ?? null;
}

function WorkspaceTargetIcon({
  value,
  size,
}: {
  value: WorkspaceTargetValue;
  size: number;
}) {
  if (value === "cloud") return <Cloud size={size} />;
  if (value === "hybrid") {
    return (
      <span className="workspace-target-hybrid-icon" aria-hidden="true">
        <Folder className="hybrid-folder" size={size} />
        <Cloud className="hybrid-cloud" size={Math.max(7, Math.round(size * 0.62))} />
      </span>
    );
  }
  if (value === "upload_cloud") return <UploadCloud size={size} />;
  return <Folder size={size} />;
}

export function ComposerModelMenu({
  disabled,
  model,
  modelGroups,
  placement,
  provider,
  reasoningEffort,
  showReasoning,
  onModelSelectionChange,
  onProviderSetupOpen,
  onReasoningEffortChange,
}: {
  disabled: boolean;
  model: string;
  modelGroups: ComposerModelGroup[];
  placement: "bottom" | "top";
  provider: ChatProvider;
  reasoningEffort: CodexReasoningEffort;
  showReasoning: boolean;
  onModelSelectionChange: (provider: ChatProvider, model: string) => void;
  onProviderSetupOpen?: () => void;
  onReasoningEffortChange: (value: CodexReasoningEffort) => void;
}) {
  const [open, setOpen] = useState(false);
  const [panel, setPanel] = useState<"root" | "provider" | "model" | "effort">("root");
  const menuRef = useRef<HTMLDivElement | null>(null);
  const selectedGroup = modelGroups.find((group) => group.provider === provider);
  const selectedModel = selectedGroup?.options.find((option) => option.value === model);
  const selectedReasoning =
    CODEX_REASONING_EFFORT_OPTIONS.find((option) => option.value === reasoningEffort) ??
    CODEX_REASONING_EFFORT_OPTIONS[1]!;
  const modelLabel = compactModelLabel(selectedModel?.label ?? model);
  const triggerLabel = showReasoning
    ? `${modelLabel} ${selectedReasoning.shortLabel ?? selectedReasoning.label}`
    : modelLabel;
  const controlLabel = showReasoning ? "Model and reasoning" : "Model";

  useEffect(() => {
    if (!open) {
      setPanel("root");
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

  useEffect(() => {
    if (!showReasoning && panel === "effort") setPanel("root");
  }, [panel, showReasoning]);

  return (
    <div
      className={`codex-model-reasoning ${placement === "top" ? "open-up" : ""}`}
      data-tooltip={controlLabel}
      ref={menuRef}
    >
      <button
        type="button"
        className={`codex-model-trigger ${open ? "active" : ""}`}
        disabled={disabled}
        aria-label={controlLabel}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((current) => !current)}
      >
        <span>{triggerLabel}</span>
        <ChevronDown size={14} />
      </button>
      {open && (
        <div className="codex-model-menu" role="menu" aria-label={controlLabel}>
          {panel === "root" ? (
            <div className="codex-model-menu-root">
              <button
                type="button"
                className="codex-model-menu-row"
                role="menuitem"
                onClick={() => setPanel("provider")}
              >
                <span>Provider</span>
                <span className="codex-model-menu-value">
                  {selectedGroup?.label ?? provider}
                </span>
                <ChevronRight size={14} />
              </button>
              <button
                type="button"
                className="codex-model-menu-row"
                role="menuitem"
                onClick={() => setPanel("model")}
              >
                <span>Model</span>
                <span className="codex-model-menu-value">{selectedModel?.label ?? model}</span>
                <ChevronRight size={14} />
              </button>
              {showReasoning ? (
                <button
                  type="button"
                  className="codex-model-menu-row"
                  role="menuitem"
                  onClick={() => setPanel("effort")}
                >
                  <span>Effort</span>
                  <span className="codex-model-menu-value">
                    {selectedReasoning.shortLabel ?? selectedReasoning.label}
                  </span>
                  <ChevronRight size={14} />
                </button>
              ) : null}
            </div>
          ) : panel === "provider" ? (
            <>
              <button
                type="button"
                className="codex-model-submenu-heading"
                aria-label="Back to model settings — Provider"
                onClick={() => setPanel("root")}
              >
                <ArrowLeft size={14} />
                <span>Provider</span>
              </button>
              <div className="codex-model-menu-divider" />
              <div className="codex-model-menu-options">
                {modelGroups.map((group) => {
                  const selected = group.provider === provider;
                  return (
                    <button
                      key={group.provider}
                      type="button"
                      role="menuitemradio"
                      aria-checked={selected}
                      className={selected ? "selected" : ""}
                      onClick={() => {
                        const nextModel =
                          group.options.find((option) => option.value === group.defaultModel) ??
                          group.options[0];
                        if (!nextModel) return;
                        onModelSelectionChange(group.provider, nextModel.value);
                        setPanel("root");
                      }}
                    >
                      <span>{group.label}</span>
                      {selected ? <Check size={14} /> : null}
                    </button>
                  );
                })}
              </div>
              <button
                type="button"
                className="codex-model-setup-action"
                role="menuitem"
                onClick={() => {
                  setOpen(false);
                  onProviderSetupOpen?.();
                }}
              >
                <span className="codex-model-menu-option-label">
                  <Plus size={13} />
                  <span>New Model/Provider</span>
                </span>
              </button>
            </>
          ) : panel === "model" ? (
            <>
              <button
                type="button"
                className="codex-model-submenu-heading"
                aria-label="Back to model settings — Model"
                onClick={() => setPanel("root")}
              >
                <ArrowLeft size={14} />
                <span>Model</span>
              </button>
              <div className="codex-model-menu-divider" />
              <div className="codex-model-menu-options">
                {(selectedGroup?.options ?? []).map((option) => {
                  const selected = option.value === model;
                  return (
                    <button
                      key={option.value}
                      type="button"
                      role="menuitemradio"
                      aria-checked={selected}
                      className={selected ? "selected" : ""}
                      onClick={() => {
                        onModelSelectionChange(provider, option.value);
                        setPanel("root");
                      }}
                    >
                      <span>{option.label}</span>
                      {selected ? <Check size={14} /> : null}
                    </button>
                  );
                })}
                {!selectedGroup?.options.length ? (
                  <div className="codex-model-menu-empty">No models from this provider</div>
                ) : null}
              </div>
              <button
                type="button"
                className="codex-model-setup-action"
                role="menuitem"
                onClick={() => {
                  setOpen(false);
                  onProviderSetupOpen?.();
                }}
              >
                <span className="codex-model-menu-option-label">
                  <Plus size={13} />
                  <span>New Model/Provider</span>
                </span>
              </button>
            </>
          ) : (
            <div className="codex-model-menu-effort">
              <button
                type="button"
                className="codex-model-submenu-heading"
                aria-label="Back to model settings — Effort"
                onClick={() => setPanel("root")}
              >
                <ArrowLeft size={14} />
                <span>Effort</span>
              </button>
              <div className="codex-model-menu-divider" />
              {CODEX_REASONING_EFFORT_OPTIONS.map((option) => (
                <button
                  key={option.value}
                  type="button"
                  role="menuitemradio"
                  aria-checked={option.value === reasoningEffort}
                  className={option.value === reasoningEffort ? "selected" : ""}
                  onClick={() => {
                    onReasoningEffortChange(option.value);
                    setPanel("root");
                  }}
                >
                  <span>{option.label}</span>
                  {option.value === reasoningEffort ? <Check size={14} /> : null}
                </button>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

export type ComposerModelGroup = {
  provider: ChatProvider;
  label: string;
  defaultModel: string;
  options: DropdownOption[];
};

function compactModelLabel(label: string): string {
  return label.replace(/^GPT-/, "").replace(/\s+Codex Spark$/, " Spark").replace(/\s+Codex$/, " Codex");
}
