import type { CSSProperties, RefObject } from "react";
import {
  ArrowUp,
  AtSign,
  Bot,
  Plus,
  Shield,
  Square,
  Upload,
} from "../icons";
import type {
  ChatProvider,
  CodexPermissionMode,
  CodexReasoningEffort,
  OpenPondApp,
} from "@openpond/contracts";
import { DropdownSelect } from "../DropdownSelect";
import {
  CODEX_PERMISSION_MODE_OPTIONS,
  type DropdownOption,
} from "../../lib/app-models";
import type { ContextWindowStatus } from "../../lib/context-window";
import type { ClientConnection } from "../../api";
import type { ShowAppToast } from "../../app/app-state";
import { VoiceInputButton } from "../voice/VoiceInputButton";
import { CodexModelReasoningMenu } from "./ComposerControls";

export function ComposerPrimaryControls({
  addFiles,
  addMenuOpen,
  addMenuRef,
  busy,
  codexPermissionMode,
  codexReasoningEffort,
  connection,
  contextStatusStyle,
  contextStatusTooltipId,
  contextWindowStatus,
  disabled,
  dropdownPlacement,
  fileInputRef,
  mentionApps,
  modelValue,
  modelOptions = [],
  onCodexPermissionModeChange,
  onCodexReasoningEffortChange,
  onModelChange,
  onCreateAsAgent,
  onOpenFilePicker,
  onPlanningAppSelect,
  onProviderChange,
  onProviderSetupOpen,
  onStop,
  onToggleAddMenu,
  onTranscript,
  provider,
  providerOptions,
  running,
  sendDisabled,
  sendTooltip,
  selectedMentionAppId,
  showToast,
}: {
  addFiles: (files: File[]) => void;
  addMenuOpen: boolean;
  addMenuRef: RefObject<HTMLDivElement | null>;
  busy: boolean;
  codexPermissionMode: CodexPermissionMode;
  codexReasoningEffort: CodexReasoningEffort;
  connection: ClientConnection | null;
  contextStatusStyle: CSSProperties;
  contextStatusTooltipId: string;
  contextWindowStatus: ContextWindowStatus;
  disabled: boolean;
  dropdownPlacement: "top" | "bottom";
  fileInputRef: RefObject<HTMLInputElement | null>;
  mentionApps: OpenPondApp[];
  modelValue: string;
  modelOptions?: DropdownOption[];
  onCodexPermissionModeChange: (value: CodexPermissionMode) => void;
  onCodexReasoningEffortChange: (value: CodexReasoningEffort) => void;
  onModelChange: (value: string) => void;
  onCreateAsAgent: () => void;
  onOpenFilePicker: () => void;
  onPlanningAppSelect: (app: OpenPondApp) => void;
  onProviderChange: (value: ChatProvider) => void;
  onProviderSetupOpen?: () => void;
  onStop: () => void;
  onToggleAddMenu: () => void;
  onTranscript: (text: string) => void;
  provider: ChatProvider;
  providerOptions: DropdownOption[];
  running: boolean;
  sendDisabled: boolean;
  sendTooltip: string;
  selectedMentionAppId: string | null;
  showToast: ShowAppToast;
}) {
  return (
    <div className="composer-primary-controls">
      <div className="composer-add-control open-up" ref={addMenuRef}>
        <button
          type="button"
          className={`composer-icon ${addMenuOpen ? "active" : ""}`}
          aria-label="Add photos and files"
          aria-haspopup="menu"
          aria-expanded={addMenuOpen}
          disabled={disabled}
          onClick={onToggleAddMenu}
        >
          <Plus size={18} />
        </button>
        {addMenuOpen && (
          <div className="composer-add-menu" role="menu" aria-label="Add context">
            <button type="button" role="menuitem" onClick={onOpenFilePicker}>
              <Upload size={13} />
              <span>
                <strong>Add photos & files</strong>
              </span>
            </button>
            <button type="button" role="menuitem" onClick={onCreateAsAgent}>
              <Bot size={13} />
              <span>
                <strong>Create as agent</strong>
              </span>
            </button>
            {mentionApps.length > 0 && (
              <div className="composer-add-menu-divider" role="presentation" />
            )}
            {mentionApps.map((app) => (
              <button
                type="button"
                role="menuitem"
                data-app-context-id={app.id}
                key={app.id}
                onClick={() => onPlanningAppSelect(app)}
              >
                <AtSign size={13} />
                <span>
                  <strong>{app.name}</strong>
                  <small>
                    {selectedMentionAppId === app.id
                      ? "Selected planning context"
                      : "Use as planning context"}
                  </small>
                </span>
              </button>
            ))}
          </div>
        )}
        <input
          ref={fileInputRef}
          className="composer-file-input"
          type="file"
          multiple
          tabIndex={-1}
          onChange={(event) => {
            addFiles(Array.from(event.currentTarget.files ?? []));
            event.currentTarget.value = "";
          }}
        />
      </div>
      <button
        type="button"
        className="composer-create-control"
        aria-label="Create agent"
        disabled={disabled}
        onClick={onCreateAsAgent}
      >
        <Bot size={14} />
        <span>Create</span>
      </button>
      {provider === "codex" ? (
        <DropdownSelect
          compact
          className="permission-select"
          icon={<Shield size={14} />}
          placement={dropdownPlacement}
          label="Codex permissions"
          value={codexPermissionMode}
          options={CODEX_PERMISSION_MODE_OPTIONS}
          disabled={busy}
          onChange={(value) => onCodexPermissionModeChange(value as CodexPermissionMode)}
        />
      ) : (
        <span className="permission-select-placeholder" aria-hidden="true" />
      )}
      <div className="composer-spacer" />
      <span className={`context-status-shell ${contextWindowStatus.tone}`} style={contextStatusStyle}>
        <span
          className={`composer-status ${contextWindowStatus.tone}`}
          role={contextWindowStatus.maxTokens === null ? "img" : "meter"}
          aria-label={contextWindowStatus.tooltip}
          aria-describedby={contextStatusTooltipId}
          aria-valuemin={contextWindowStatus.maxTokens === null ? undefined : 0}
          aria-valuemax={contextWindowStatus.maxTokens ?? undefined}
          aria-valuenow={contextWindowStatus.maxTokens === null ? undefined : contextWindowStatus.usedTokens}
          tabIndex={0}
        />
        <span className="context-status-tooltip" id={contextStatusTooltipId} role="tooltip">
          <span className="context-status-tooltip-title">Context window</span>
          <span className="context-status-tooltip-main">
            <span>{contextWindowStatus.summary}</span>
            <span>{contextWindowStatus.tokensLabel}</span>
          </span>
          {contextWindowStatus.maxTokens !== null && (
            <span className="context-status-tooltip-bar" aria-hidden="true">
              <span />
            </span>
          )}
          {contextWindowStatus.detail ? (
            <span className="context-status-tooltip-detail">{contextWindowStatus.detail}</span>
          ) : null}
        </span>
      </span>
      <DropdownSelect
        compact
        placement={dropdownPlacement}
        label="Provider"
        value={provider}
        options={providerOptions}
        disabled={busy}
        onChange={(value) => {
          if (value === "setup-provider") {
            onProviderSetupOpen?.();
            return;
          }
          onProviderChange(value as ChatProvider);
        }}
      />
      {provider === "codex" && (
        <CodexModelReasoningMenu
          disabled={busy}
          model={modelValue}
          placement={dropdownPlacement}
          reasoningEffort={codexReasoningEffort}
          onModelChange={onModelChange}
          onReasoningEffortChange={onCodexReasoningEffortChange}
        />
      )}
      {provider !== "codex" && modelOptions.length > 0 && (
        <DropdownSelect
          compact
          placement={dropdownPlacement}
          label="Model"
          value={modelValue}
          options={modelOptions}
          disabled={busy}
          onChange={onModelChange}
        />
      )}
      <VoiceInputButton
        buttonClassName="composer-icon"
        connection={connection}
        disabled={disabled}
        iconSize={16}
        wrapperClassName="composer-voice-input"
        showToast={showToast}
        onTranscript={onTranscript}
      />
      {running ? (
        <button
          type="button"
          className="send-button stop-button"
          data-tooltip="Stop"
          aria-label="Stop response"
          onClick={onStop}
        >
          <Square size={13} fill="currentColor" />
        </button>
      ) : (
        <button className="send-button" disabled={sendDisabled} data-tooltip={sendTooltip} aria-label={sendTooltip}>
          <ArrowUp size={18} />
        </button>
      )}
    </div>
  );
}
