import { useMemo, type CSSProperties, type RefObject } from "react";
import {
  ArrowUp,
  Pause,
  Plus,
  Shield,
  SquareTerminal,
  Square,
} from "../icons";
import type {
  ChatProvider,
  CodexPermissionMode,
  CodexReasoningEffort,
  OpenPondCommandAccessMode,
  ProviderSettings,
} from "@openpond/contracts";
import { DropdownSelect } from "../DropdownSelect";
import {
  CODEX_PERMISSION_MODE_OPTIONS,
  defaultModelForProvider,
  modelOptionsForProvider,
  OPENPOND_COMMAND_ACCESS_MODE_OPTIONS,
  providerModelSupportsReasoning,
  type DropdownOption,
} from "../../lib/app-models";
import type { ContextWindowStatus } from "../../lib/context-window";
import type { ClientConnection } from "../../api";
import type { ShowAppToast } from "../../app/app-state";
import { VoiceInputButton } from "../voice/VoiceInputButton";
import { ComposerModelMenu, type ComposerModelGroup } from "./ComposerControls";
import {
  ComposerProfileTargetControl,
  type ComposerProfileTargetState,
} from "./ComposerControls";

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
  "custom-openai-compatible",
  "setup-provider",
]);

export function ComposerPrimaryControls({
  surface = "chat",
  teamUseModel = false,
  teamUseModelLocked = false,
  onTeamUseModelChange,
  addFiles,
  addMenuId,
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
  modelValue,
  modelOptions = [],
  openPondCommandAccessMode,
  showCommandAccess = true,
  profileTarget,
  onCodexPermissionModeChange,
  onCodexReasoningEffortChange,
  onOpenPondCommandAccessModeChange,
  onProfileTargetChange,
  onModelChange,
  onOpenFilePicker,
  onProviderChange,
  onProviderSetupOpen,
  onStop,
  onToggleAddMenu,
  onTranscript,
  provider,
  providerSettings,
  providerOptions,
  running,
  sendDisabled,
  sendTooltip,
  showToast,
  stopIcon = "stop",
  stopLabel = "Stop response",
}: {
  surface?: "chat" | "team";
  teamUseModel?: boolean;
  teamUseModelLocked?: boolean;
  onTeamUseModelChange?: (value: boolean) => void;
  addFiles: (files: File[]) => void;
  addMenuId?: string;
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
  modelValue: string;
  modelOptions?: DropdownOption[];
  openPondCommandAccessMode: OpenPondCommandAccessMode;
  showCommandAccess?: boolean;
  profileTarget?: ComposerProfileTargetState | null;
  onCodexPermissionModeChange: (value: CodexPermissionMode) => void;
  onCodexReasoningEffortChange: (value: CodexReasoningEffort) => void;
  onOpenPondCommandAccessModeChange: (value: OpenPondCommandAccessMode) => void;
  onProfileTargetChange?: (value: string) => void;
  onModelChange: (value: string) => void;
  onOpenFilePicker: () => void;
  onProviderChange: (value: ChatProvider) => void;
  onProviderSetupOpen?: () => void;
  onStop: () => Promise<boolean | void> | boolean | void;
  onToggleAddMenu: () => void;
  onTranscript: (text: string) => void;
  provider: ChatProvider;
  providerSettings?: ProviderSettings | null;
  providerOptions: DropdownOption[];
  running: boolean;
  sendDisabled: boolean;
  sendTooltip: string;
  showToast: ShowAppToast;
  stopIcon?: "pause" | "stop";
  stopLabel?: string;
}) {
  const showModelReasoningMenu = providerModelSupportsReasoning(
    provider,
    modelValue,
    providerSettings
  );
  const modelGroups = useMemo(
    () =>
      composerModelGroups({
        currentModelOptions: modelOptions,
        currentProvider: provider,
        providerOptions,
        providerSettings,
      }),
    [modelOptions, provider, providerOptions, providerSettings],
  );
  const teamModelGroups = useMemo(
    () => modelGroups.filter((group) => TEAM_CHAT_LOCAL_PROVIDER_IDS.has(group.provider)),
    [modelGroups],
  );
  const changeModelSelection = (nextProvider: ChatProvider, nextModel: string) => {
    if (nextProvider === provider) {
      onModelChange(nextModel);
      return;
    }
    onModelChange(nextModel);
    onProviderChange(nextProvider);
  };
  if (surface === "team") {
    return (
      <div className="composer-primary-controls team-chat-composer-controls">
        <button
          type="button"
          className="composer-icon"
          aria-label="Add photos and files"
          disabled={disabled}
          onClick={onOpenFilePicker}
        >
          <Plus size={18} />
        </button>
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
        <label className="team-chat-model-toggle">
          <input
            type="checkbox"
            checked={teamUseModel}
            disabled={busy || teamUseModelLocked}
            onChange={(event) =>
              onTeamUseModelChange?.(event.currentTarget.checked)
            }
          />
          <span>Use model</span>
        </label>
        <div className="composer-spacer" />
        {teamUseModel ? (
          <ComposerModelMenu
            disabled={busy}
            model={modelValue}
            modelGroups={teamModelGroups}
            placement={dropdownPlacement}
            provider={provider}
            reasoningEffort={codexReasoningEffort}
            showReasoning={showModelReasoningMenu}
            onModelSelectionChange={changeModelSelection}
            onProviderSetupOpen={onProviderSetupOpen}
            onReasoningEffortChange={onCodexReasoningEffortChange}
          />
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
          aria-label="Add to message"
          aria-haspopup="menu"
          aria-expanded={addMenuOpen}
          aria-controls={addMenuOpen ? addMenuId : undefined}
          disabled={disabled}
          onMouseDown={(event) => event.preventDefault()}
          onClick={onToggleAddMenu}
        >
          <Plus size={18} />
        </button>
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
      {showCommandAccess && provider === "codex" ? (
        <DropdownSelect
          compact
          className="permission-select"
          icon={<Shield size={14} />}
          placement={dropdownPlacement}
          label="Codex permissions"
          tooltip={
            CODEX_PERMISSION_MODE_OPTIONS.find(
              (option) => option.value === codexPermissionMode
            )?.label
          }
          value={codexPermissionMode}
          options={CODEX_PERMISSION_MODE_OPTIONS}
          disabled={busy}
          onChange={(value) =>
            onCodexPermissionModeChange(value as CodexPermissionMode)
          }
        />
      ) : showCommandAccess ? (
        <DropdownSelect
          compact
          className="permission-select"
          icon={<SquareTerminal size={14} />}
          placement={dropdownPlacement}
          label="Command access"
          tooltip={
            OPENPOND_COMMAND_ACCESS_MODE_OPTIONS.find(
              (option) =>
                option.value ===
                (openPondCommandAccessMode === "disabled"
                  ? "ask"
                  : openPondCommandAccessMode)
            )?.label
          }
          value={
            openPondCommandAccessMode === "disabled"
              ? "ask"
              : openPondCommandAccessMode
          }
          options={OPENPOND_COMMAND_ACCESS_MODE_OPTIONS}
          disabled={busy}
          onChange={(value) =>
            onOpenPondCommandAccessModeChange(
              value as OpenPondCommandAccessMode
            )
          }
        />
      ) : null}
      {profileTarget && onProfileTargetChange ? (
        <ComposerProfileTargetControl
          busy={busy}
          placement={dropdownPlacement}
          state={profileTarget}
          onChange={onProfileTargetChange}
        />
      ) : null}
      <div className="composer-spacer" />
      <span
        className={`context-status-shell ${contextWindowStatus.tone}`}
        style={contextStatusStyle}
      >
        <span
          className={`composer-status ${contextWindowStatus.tone}`}
          role={contextWindowStatus.maxTokens === null ? "img" : "meter"}
          aria-label={contextWindowStatus.tooltip}
          aria-describedby={contextStatusTooltipId}
          aria-valuemin={contextWindowStatus.maxTokens === null ? undefined : 0}
          aria-valuemax={contextWindowStatus.maxTokens ?? undefined}
          aria-valuenow={
            contextWindowStatus.maxTokens === null
              ? undefined
              : contextWindowStatus.usedTokens
          }
          tabIndex={0}
        />
        <span
          className="context-status-tooltip"
          id={contextStatusTooltipId}
          role="tooltip"
        >
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
            <span className="context-status-tooltip-detail">
              {contextWindowStatus.detail}
            </span>
          ) : null}
        </span>
      </span>
      <ComposerModelMenu
        disabled={busy}
        model={modelValue}
        modelGroups={modelGroups}
        placement={dropdownPlacement}
        provider={provider}
        reasoningEffort={codexReasoningEffort}
        showReasoning={showModelReasoningMenu}
        onModelSelectionChange={changeModelSelection}
        onProviderSetupOpen={onProviderSetupOpen}
        onReasoningEffortChange={onCodexReasoningEffortChange}
      />
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
          {stopIcon === "pause" ? (
            <Pause size={15} />
          ) : (
            <Square size={13} fill="currentColor" />
          )}
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

function composerModelGroups({
  currentModelOptions,
  currentProvider,
  providerOptions,
  providerSettings,
}: {
  currentModelOptions: DropdownOption[];
  currentProvider: ChatProvider;
  providerOptions: DropdownOption[];
  providerSettings?: ProviderSettings | null;
}): ComposerModelGroup[] {
  return providerOptions.flatMap((providerOption) => {
    if (providerOption.value === "setup-provider") return [];
    const nextProvider = providerOption.value as ChatProvider;
    const options = nextProvider === currentProvider
      ? currentModelOptions
      : modelOptionsForProvider(nextProvider, providerSettings);
    return options.length > 0
      ? [{
          provider: nextProvider,
          label: providerOption.label,
          defaultModel: defaultModelForProvider(nextProvider, providerSettings),
          options,
        }]
      : [];
  });
}
