import type { CSSProperties, RefObject } from "react";
import {
  ArrowUp,
  ArrowUpRight,
  AtSign,
  Bot,
  Pause,
  Plus,
  Shield,
  SquareTerminal,
  Square,
  Upload,
} from "../icons";
import type {
  ChatProvider,
  CodexPermissionMode,
  CodexReasoningEffort,
  OpenPondCommandAccessMode,
  OpenPondApp,
  ProviderSettings,
  SubagentDelegationMode,
} from "@openpond/contracts";
import { DropdownSelect } from "../DropdownSelect";
import {
  CODEX_PERMISSION_MODE_OPTIONS,
  OPENPOND_COMMAND_ACCESS_MODE_OPTIONS,
  providerModelSupportsReasoning,
  type DropdownOption,
} from "../../lib/app-models";
import type { ContextWindowStatus } from "../../lib/context-window";
import type { ClientConnection } from "../../api";
import type { ShowAppToast } from "../../app/app-state";
import { VoiceInputButton } from "../voice/VoiceInputButton";
import { CodexModelReasoningMenu } from "./ComposerControls";
import { ComposerDelegationMenu } from "./ComposerDelegationMenu";

const TEAM_CHAT_LOCAL_PROVIDER_IDS = new Set([
  "codex",
  "openai",
  "xai",
  "openrouter",
  "deepseek",
  "zai",
  "moonshot",
  "together",
  "groq",
  "fireworks",
  "custom-openai-compatible",
  "setup-provider",
]);

export function ComposerPrimaryControls({
  surface = "chat",
  teamUseModel = false,
  teamUseModelLocked = false,
  onTeamUseModelChange,
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
  openPondCommandAccessMode,
  onCodexPermissionModeChange,
  onCodexReasoningEffortChange,
  onOpenPondCommandAccessModeChange,
  onModelChange,
  onCreateAsAgent,
  onOpenFilePicker,
  onPlanningAppSelect,
  onProviderChange,
  onProviderSetupOpen,
  onQueueDraft,
  onStop,
  onToggleAddMenu,
  onTranscript,
  provider,
  providerSettings,
  providerOptions,
  queueDraftDisabled,
  queueDraftTooltip,
  running,
  sendDisabled,
  sendTooltip,
  selectedMentionAppId,
  subagentDelegationDefaultMode,
  subagentDelegationMode,
  onSubagentDelegationModeChange,
  showToast,
  stopIcon = "stop",
  stopLabel = "Stop response",
  steering,
}: {
  surface?: "chat" | "team";
  teamUseModel?: boolean;
  teamUseModelLocked?: boolean;
  onTeamUseModelChange?: (value: boolean) => void;
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
  openPondCommandAccessMode: OpenPondCommandAccessMode;
  onCodexPermissionModeChange: (value: CodexPermissionMode) => void;
  onCodexReasoningEffortChange: (value: CodexReasoningEffort) => void;
  onOpenPondCommandAccessModeChange: (value: OpenPondCommandAccessMode) => void;
  onModelChange: (value: string) => void;
  onCreateAsAgent: () => void;
  onOpenFilePicker: () => void;
  onPlanningAppSelect: (app: OpenPondApp) => void;
  onProviderChange: (value: ChatProvider) => void;
  onProviderSetupOpen?: () => void;
  onQueueDraft: () => void;
  onStop: () => Promise<boolean | void> | boolean | void;
  onToggleAddMenu: () => void;
  onTranscript: (text: string) => void;
  provider: ChatProvider;
  providerSettings?: ProviderSettings | null;
  providerOptions: DropdownOption[];
  queueDraftDisabled: boolean;
  queueDraftTooltip: string;
  running: boolean;
  sendDisabled: boolean;
  sendTooltip: string;
  selectedMentionAppId: string | null;
  subagentDelegationDefaultMode?: SubagentDelegationMode;
  subagentDelegationMode?: SubagentDelegationMode | null;
  onSubagentDelegationModeChange?: (mode: SubagentDelegationMode | null) => void;
  showToast: ShowAppToast;
  stopIcon?: "pause" | "stop";
  stopLabel?: string;
  steering: boolean;
}) {
  const showModelReasoningMenu = providerModelSupportsReasoning(provider, modelValue, providerSettings);
  if (surface === "team") {
    return (
      <div className="composer-primary-controls team-chat-composer-controls">
        <label className="team-chat-model-toggle">
          <input
            type="checkbox"
            checked={teamUseModel}
            disabled={busy || teamUseModelLocked}
            onChange={(event) => onTeamUseModelChange?.(event.currentTarget.checked)}
          />
          <span>Use model</span>
        </label>
        <div className="composer-spacer" />
        {teamUseModel ? (
          <>
            <DropdownSelect
              compact
              placement={dropdownPlacement}
              label="Provider"
              value={provider}
              options={providerOptions.filter((option) => TEAM_CHAT_LOCAL_PROVIDER_IDS.has(option.value))}
              disabled={busy}
              onChange={(value) => {
                if (value === "setup-provider") {
                  onProviderSetupOpen?.();
                  return;
                }
                onProviderChange(value as ChatProvider);
              }}
            />
            {showModelReasoningMenu ? (
              <CodexModelReasoningMenu
                disabled={busy}
                model={modelValue}
                modelOptions={modelOptions}
                placement={dropdownPlacement}
                reasoningEffort={codexReasoningEffort}
                onModelChange={onModelChange}
                onReasoningEffortChange={onCodexReasoningEffortChange}
              />
            ) : modelOptions.length > 0 ? (
              <DropdownSelect
                compact
                placement={dropdownPlacement}
                label="Model"
                value={modelValue}
                options={modelOptions}
                disabled={busy}
                onChange={onModelChange}
              />
            ) : null}
          </>
        ) : null}
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
            data-tooltip={stopLabel}
            aria-label={stopLabel}
            onClick={onStop}
          >
            <Square size={13} fill="currentColor" />
          </button>
        ) : (
          <button
            className="send-button"
            disabled={sendDisabled}
            data-tooltip={sendTooltip}
            aria-label={sendTooltip}
          >
            <ArrowUp size={18} />
          </button>
        )}
      </div>
    );
  }
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
        aria-label="Make Agent"
        disabled={disabled}
        onClick={onCreateAsAgent}
      >
        <span>Make Agent</span>
      </button>
      {provider === "codex" ? (
        <DropdownSelect
          compact
          className="permission-select"
          icon={<Shield size={14} />}
          placement={dropdownPlacement}
          label="Codex permissions"
          tooltip={CODEX_PERMISSION_MODE_OPTIONS.find(
            (option) => option.value === codexPermissionMode,
          )?.label}
          value={codexPermissionMode}
          options={CODEX_PERMISSION_MODE_OPTIONS}
          disabled={busy}
          onChange={(value) => onCodexPermissionModeChange(value as CodexPermissionMode)}
        />
      ) : (
        <DropdownSelect
          compact
          className="permission-select"
          icon={<SquareTerminal size={14} />}
          placement={dropdownPlacement}
          label="Command access"
          tooltip={OPENPOND_COMMAND_ACCESS_MODE_OPTIONS.find(
            (option) =>
              option.value ===
              (openPondCommandAccessMode === "disabled" ? "ask" : openPondCommandAccessMode),
          )?.label}
          value={openPondCommandAccessMode === "disabled" ? "ask" : openPondCommandAccessMode}
          options={OPENPOND_COMMAND_ACCESS_MODE_OPTIONS}
          disabled={busy}
          onChange={(value) => onOpenPondCommandAccessModeChange(value as OpenPondCommandAccessMode)}
        />
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
      {showModelReasoningMenu && (
        <CodexModelReasoningMenu
          disabled={busy}
          model={modelValue}
          modelOptions={modelOptions}
          placement={dropdownPlacement}
          reasoningEffort={codexReasoningEffort}
          onModelChange={onModelChange}
          onReasoningEffortChange={onCodexReasoningEffortChange}
        />
      )}
      {!showModelReasoningMenu && modelOptions.length > 0 && (
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
      {subagentDelegationDefaultMode && onSubagentDelegationModeChange ? (
        <ComposerDelegationMenu
          defaultMode={subagentDelegationDefaultMode}
          disabled={disabled}
          overrideMode={subagentDelegationMode ?? null}
          onChange={onSubagentDelegationModeChange}
        />
      ) : null}
      {steering ? (
        <button
          type="button"
          className="composer-queue-control"
          disabled={queueDraftDisabled}
          data-tooltip={queueDraftTooltip}
          aria-label="Queue steer draft"
          onClick={onQueueDraft}
        >
          <Plus size={13} />
          <span>Queue</span>
        </button>
      ) : null}
      {running ? (
        <button
          type="button"
          className="send-button stop-button"
          data-tooltip={stopLabel}
          aria-label={stopLabel}
          onClick={onStop}
        >
          {stopIcon === "pause" ? <Pause size={15} /> : <Square size={13} fill="currentColor" />}
        </button>
      ) : steering ? (
        <button className="send-button steer-button" disabled={sendDisabled} data-tooltip="Steer" aria-label="Steer">
          <ArrowUpRight size={13} />
          <span>Steer</span>
        </button>
      ) : (
        <button className="send-button" disabled={sendDisabled} data-tooltip={sendTooltip} aria-label={sendTooltip}>
          <ArrowUp size={18} />
        </button>
      )}
    </div>
  );
}
