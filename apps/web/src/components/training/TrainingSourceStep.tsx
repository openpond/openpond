import { useMemo } from "react";
import {
  TASK_AUTHORING_MAX_DISCLOSED_EVIDENCE_TOKENS,
  type ChatProvider,
  type CodexReasoningEffort,
  type DatasetBuildIntent,
  type DatasetBuildSpecification,
  type ProviderSettings,
  type TrainingChatSearchEntry,
} from "@openpond/contracts";
import { DropdownSelect } from "../DropdownSelect";
import { CodexModelReasoningMenu } from "../chat/ComposerControls";
import { Loader2 } from "../icons";
import {
  modelOptionsForProvider,
  providerModelSupportsReasoning,
  providerOptionsFromSettings,
} from "../../lib/app-models";
import {
  formatTrainingTokens,
  TrainingChatPicker,
  type TrainingSourceEstimate,
} from "./TrainingChatPicker";
import type { AgentSourceMode, NewModelMode } from "./TrainingStartModeStep";
import {
  buildSpecificationReady,
  TrainingEvidenceEditor,
} from "./TrainingEvidenceEditor";

type AuthoringSourceMode = NewModelMode | AgentSourceMode;

export function TrainingSourceStep({
  authoringModel,
  authoringProvider,
  authoringReasoningEffort,
  busy,
  disclosurePending,
  buildIntent,
  buildSpecification,
  estimatesBySessionId,
  matchingSessionCount,
  mode,
  objective,
  onObjectiveChange,
  onBuildSpecificationChange,
  onAnalyze,
  onApproveDisclosure,
  onAuthoringModelChange,
  onAuthoringProviderChange,
  onAuthoringReasoningEffortChange,
  onDeclineDisclosure,
  onDiscoverFromConversations,
  onSearchChange,
  onLoadMore,
  onReturnToRecommendation,
  onToggleSession,
  onToggleVisible,
  providerSettings,
  recommendationAvailable,
  search,
  searchError,
  searchHasMore,
  searchIndexedChats,
  searchIndexing,
  searchLoading,
  searchTotalChats,
  selectedEntries,
  selectedEstimate,
  selectedSessionIds,
  targetLabel = "model",
  targetOperation = "create",
  visibleSessions,
}: {
  authoringModel: string;
  authoringProvider: ChatProvider;
  authoringReasoningEffort: CodexReasoningEffort;
  busy: boolean;
  disclosurePending: boolean;
  buildIntent: DatasetBuildIntent | null;
  buildSpecification: DatasetBuildSpecification | null;
  estimatesBySessionId: Record<string, TrainingSourceEstimate>;
  matchingSessionCount: number;
  mode: AuthoringSourceMode;
  objective: string;
  onObjectiveChange: (value: string) => void;
  onBuildSpecificationChange: (value: DatasetBuildSpecification) => void;
  onAnalyze: () => void;
  onApproveDisclosure: () => void;
  onAuthoringModelChange: (value: string) => void;
  onAuthoringProviderChange: (value: ChatProvider) => void;
  onAuthoringReasoningEffortChange: (value: CodexReasoningEffort) => void;
  onDeclineDisclosure: () => void;
  onDiscoverFromConversations?: () => void;
  onSearchChange: (value: string) => void;
  onLoadMore: () => void;
  onReturnToRecommendation: () => void;
  onToggleSession: (sessionId: string, selected: boolean) => void;
  onToggleVisible: () => void;
  providerSettings: ProviderSettings | null;
  recommendationAvailable: boolean;
  search: string;
  searchError: string | null;
  searchHasMore: boolean;
  searchIndexedChats: number;
  searchIndexing: boolean;
  searchLoading: boolean;
  searchTotalChats: number;
  selectedEntries: TrainingChatSearchEntry[];
  selectedEstimate: TrainingSourceEstimate & { measuredChats: number };
  selectedSessionIds: Set<string>;
  targetLabel?: string;
  targetOperation?: "create" | "improve";
  visibleSessions: TrainingChatSearchEntry[];
}) {
  const providerOptions = useMemo(() => providerOptionsFromSettings(providerSettings, { enabledOnly: true }), [providerSettings]);
  const modelOptions = useMemo(() => modelOptionsForProvider(authoringProvider, providerSettings), [authoringProvider, providerSettings]);
  const showReasoning = providerModelSupportsReasoning(authoringProvider, authoringModel, providerSettings);
  const selectedCount = selectedSessionIds.size;
  const fromPrompt = mode === "from_prompt";
  const fromChats = mode === "from_chats";
  const showsObjective = mode === "manual" || fromPrompt || fromChats;
  const showsChats = !fromPrompt;
  const sourceReady = fromChats
    ? Boolean(objective.trim()) && selectedCount > 0
    : mode === "manual" || fromPrompt
      ? Boolean(objective.trim())
      : selectedCount > 0;
  const selectedEstimateComplete = selectedEstimate.measuredChats === selectedCount;
  const evidenceOverBudget = selectedCount > 0
    && selectedEstimateComplete
    && selectedEstimate.estimatedTokens > TASK_AUTHORING_MAX_DISCLOSED_EVIDENCE_TOKENS;
  const isDataset = targetLabel === "dataset";
  const isModel = targetLabel === "model";
  const isAgent = targetLabel === "agent";
  const displayedModelOptions = isAgent
    ? modelOptions.map((option) => option.value.startsWith("openpond-scripted-")
      ? { ...option, label: "OpenPond Chat", shortLabel: "OpenPond Chat", description: undefined }
      : option)
    : modelOptions;
  const authoringModelLabel = displayedModelOptions.find((option) => option.value === authoringModel)?.label ?? authoringModel;
  const authoringProviderLabel = providerOptions.find((option) => option.value === authoringProvider)?.label ?? authoringProvider;
  const authorsDataset = isModel || isDataset;
  const usesDeterministicManualBuild = authorsDataset
    && mode === "manual"
    && selectedCount === 0
    && buildIntent !== "discovery"
    && buildSpecificationReady(buildSpecification);
  const structuredEvidenceReady = !authorsDataset
    || buildIntent === "discovery"
    || (
      buildSpecificationReady(buildSpecification)
      && (
        buildSpecification?.kind !== "demonstrations"
        || buildSpecification.examples.length > 0
        || selectedCount > 0
      )
      && (
        buildSpecification?.kind !== "preferences"
        || buildSpecification.pairs.length > 0
        || selectedCount > 0
      )
    );
  const canAnalyze = sourceReady && structuredEvidenceReady;
  const sourceHeading = disclosurePending && isAgent
    ? "Review chats for the Agent plan"
    : isDataset
      ? "Build the Dataset"
      : isModel
        ? "Build the Dataset"
        : fromPrompt
          ? "Describe the Agent"
          : "Add purpose and supporting chats";
  const sourceDescription = disclosurePending && isAgent
    ? "Approve the selected chat excerpts so OpenPond can turn their goals, decisions, and answer patterns into the first Agent plan."
    : mode === "automated"
    ? authorsDataset
      ? "Confirm the chats that demonstrate this repeated workflow. Only selected chats seed the Dataset."
      : "Confirm the chats that support this repeated workflow."
    : isDataset
      ? "Define what this Dataset should contain and be useful for. Supporting chats are optional."
      : targetLabel === "agent"
        ? fromChats
          ? "Define the Agent's purpose and choose at least one chat that demonstrates the work or desired outcome."
          : "Define the Agent's purpose. This path does not attach or search your chats."
        : "Define the capability the Model should learn. Supporting chats are optional.";
  const objectiveLabel = isDataset
    ? "Dataset purpose"
    : targetLabel === "agent"
      ? targetOperation === "improve" ? "Improvement goal" : "Agent purpose"
      : "Capability";
  const objectivePlaceholder = isDataset
    ? "Describe what this Dataset should contain and be useful for"
    : targetLabel === "agent"
      ? "Describe the work this Agent should handle reliably"
      : `Describe what this ${targetLabel} should do reliably`;

  return (
    <>
      <div className="training-dialog-scroll-body">
        <div className="training-run-step-heading">
          <h3>{sourceHeading}</h3>
          <p>{sourceDescription}</p>
        </div>

        {showsObjective ? (
          <label className="training-objective-field training-dataset-capability">
            <span>{objectiveLabel}</span>
            <textarea
              data-autofocus
              required
              value={objective}
              disabled={busy || disclosurePending}
              placeholder={objectivePlaceholder}
              onChange={(event) => onObjectiveChange(event.target.value)}
            />
          </label>
        ) : objective ? (
          <div className="training-evidence-objective"><span>{objectiveLabel}</span><strong>{objective}</strong></div>
        ) : null}

        {authorsDataset && buildSpecification ? (
          <TrainingEvidenceEditor
            disabled={busy || disclosurePending}
            specification={buildSpecification}
            onChange={onBuildSpecificationChange}
          />
        ) : null}

        <fieldset className="training-evidence-fields" disabled={busy || disclosurePending}>
          {!showsChats ? null : mode === "manual" ? (
            <details className="training-manual-chat-seeds">
              <summary>
                <span>Add supporting chats</span>
                <small>{selectedCount ? `${selectedCount} selected` : "Optional"}</small>
              </summary>
              <div className="training-manual-chat-seeds-body">
                <p>Choose successful examples, corrections, or outcome-bearing chats that clarify the purpose above.</p>
                <TrainingChatPicker
                  estimatesBySessionId={estimatesBySessionId}
                  matchingSessionCount={matchingSessionCount}
                  onLoadMore={onLoadMore}
                  onSearchChange={onSearchChange}
                  onToggleSession={onToggleSession}
                  onToggleVisible={onToggleVisible}
                  reviewOnly={disclosurePending}
                  search={search}
                  searchError={searchError}
                  searchHasMore={searchHasMore}
                  searchIndexedChats={searchIndexedChats}
                  searchIndexing={searchIndexing}
                  searchLoading={searchLoading}
                  searchTotalChats={searchTotalChats}
                  selectedEntries={selectedEntries}
                  selectedSessionIds={selectedSessionIds}
                  visibleSessions={visibleSessions}
                />
              </div>
            </details>
          ) : (
            <>
              <div className="training-dataset-source-heading">
                <span>{authorsDataset ? "Chat seeds" : "Supporting chats"}</span>
              </div>
              <TrainingChatPicker
                estimatesBySessionId={estimatesBySessionId}
                matchingSessionCount={matchingSessionCount}
                onLoadMore={onLoadMore}
                onSearchChange={onSearchChange}
                onToggleSession={onToggleSession}
                onToggleVisible={onToggleVisible}
                reviewOnly={disclosurePending}
                search={search}
                searchError={searchError}
                searchHasMore={searchHasMore}
                searchIndexedChats={searchIndexedChats}
                searchIndexing={searchIndexing}
                searchLoading={searchLoading}
                searchTotalChats={searchTotalChats}
                selectedEntries={selectedEntries}
                selectedSessionIds={selectedSessionIds}
                visibleSessions={visibleSessions}
              />
            </>
          )}

          {usesDeterministicManualBuild ? null : (
            <div className="training-authoring-row">
              <span>{isAgent ? "Build with" : "Analyzed with"}</span>
              <div className="training-authoring-controls" aria-label="Analysis model">
                <DropdownSelect compact placement="bottom" label="Provider" value={authoringProvider} options={providerOptions} disabled={busy} onChange={(value) => onAuthoringProviderChange(value as ChatProvider)} />
                {showReasoning ? (
                  <CodexModelReasoningMenu disabled={busy} model={authoringModel} modelOptions={displayedModelOptions} placement="bottom" reasoningEffort={authoringReasoningEffort} onModelChange={onAuthoringModelChange} onReasoningEffortChange={onAuthoringReasoningEffortChange} />
                ) : (
                  <DropdownSelect compact placement="bottom" label="Model" value={authoringModel} options={displayedModelOptions} disabled={busy} onChange={onAuthoringModelChange} />
                )}
              </div>
            </div>
          )}
        </fieldset>

        {disclosurePending ? (
          <div className="training-disclosure-review" role="status">
            <strong>{isAgent ? "How the chats build the plan" : "Approve evidence disclosure"}</strong>
            <p><b>{authoringProviderLabel} / {authoringModelLabel}</b> will analyze excerpts from {selectedCount} selected chat{selectedCount === 1 ? "" : "s"}, {selectedEstimate.messageCount} messages, and approximately {formatTrainingTokens(selectedEstimate.estimatedTokens)} tokens. {isAgent ? "OpenPond uses the recurring goals, decisions, corrections, and answer patterns to draft the Agent's purpose, behavior, actions, outputs, and Evals." : ""}</p>
          </div>
        ) : null}
        {evidenceOverBudget ? (
          <div className="training-banner error" role="alert">
            Selected evidence is about {formatTrainingTokens(selectedEstimate.estimatedTokens)} tokens. Hosted Taskset authoring accepts up to {formatTrainingTokens(TASK_AUTHORING_MAX_DISCLOSED_EVIDENCE_TOKENS)} raw-evidence tokens; choose fewer chats or selected turns.
          </div>
        ) : null}
      </div>

      <div className="training-dialog-actions">
        <span className="training-selection-count">
          {fromPrompt
            ? "No chats will be attached"
            : selectedCount === 0
              ? usesDeterministicManualBuild
                ? "Manual evidence builds locally"
                : mode === "manual" ? "Supporting chats are optional" : "Select at least one supporting chat"
              : selectedEstimate.measuredChats === selectedCount ? <><span>{selectedCount} chat{selectedCount === 1 ? "" : "s"}</span><span>{selectedEstimate.messageCount} messages</span><span>About {formatTrainingTokens(selectedEstimate.estimatedTokens)} tokens</span></> : <><span>{selectedCount} chat{selectedCount === 1 ? "" : "s"}</span><span>Estimating…</span></>}
        </span>
        {disclosurePending ? <>
          <button className="training-button secondary" type="button" disabled={busy} onClick={onDeclineDisclosure}>{isAgent ? "Change chats" : "Change evidence"}</button>
          <button className="training-button" type="button" disabled={busy || !selectedEstimateComplete || evidenceOverBudget} onClick={onApproveDisclosure}>{busy ? <Loader2 className="spin" size={14} /> : null}{isAgent ? "Approve chats and build plan" : "Approve and analyze"}</button>
        </> : recommendationAvailable ? <>
          <button className="training-button secondary" type="button" disabled={busy} onClick={onAnalyze}>Reanalyze changes</button>
          <button className="training-button" type="button" onClick={onReturnToRecommendation}>Return to recommendation</button>
        </> : (
          <>
            {isDataset && mode === "manual" && onDiscoverFromConversations ? (
              <button
                className="training-button secondary"
                type="button"
                disabled={busy}
                onClick={onDiscoverFromConversations}
              >
                Discover from conversations
              </button>
            ) : null}
            <button className="training-button" type="button" disabled={!canAnalyze || busy || evidenceOverBudget || (selectedCount > 0 && !selectedEstimateComplete)} onClick={onAnalyze}>
              {busy ? <Loader2 className="spin" size={14} /> : null}
              {selectedCount > 0
                ? isAgent ? "Review chats for plan" : "Review data access"
                : isAgent && fromPrompt ? "Continue" : authorsDataset ? "Build Dataset" : "Review setup"}
            </button>
          </>
        )}
      </div>
    </>
  );
}
