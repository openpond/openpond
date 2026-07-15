import { useCallback, type Dispatch, type SetStateAction } from "react";
import type { ChatAttachment, Session } from "@openpond/contracts";
import type { ShowAppToast } from "../app/app-state";
import type { ComposerSubmitOptions } from "../components/chat/Composer";
import type { ComposerDraftStore } from "../lib/composer-draft-store";
import {
  queuedCloudWorkSubmission,
  type QueuedCloudWorkSubmissionInput,
  type QueuedCloudWorkSubmissionResult,
} from "../lib/queued-cloud-work";
import type { SandboxActionCatalogEntry } from "../lib/sandbox-types";

type CloudWorkRequest = Extract<QueuedCloudWorkSubmissionResult, { kind: "ready" }>["request"];

type SendPrompt = (
  attachments?: ChatAttachment[],
  action?: SandboxActionCatalogEntry | null,
  promptOverride?: string,
  options?: {
    clearPrompt?: () => void;
    displayPrompt?: string;
    onSessionCreated?: (session: Session) => void;
    turnMetadata?: Record<string, unknown>;
  },
) => Promise<boolean>;

export function useMainComposerSubmit({
  advanceTrainingTurn,
  bindTrainingSession,
  composerDraftStore,
  createCloudWork,
  onSessionCreated,
  pendingWorkspaceTarget,
  prepareTrainingTurn,
  selectedCloudProjectId,
  selectedLocalProjectId,
  selectedLocalProjectName,
  selectedLocalWorkspacePath,
  selectedProjectCloudBaseSha,
  selectedProjectCloudProjectId,
  selectedProjectCloudSourceRef,
  sendPrompt,
  setMentionedAppId,
  setPendingWorkspaceTarget,
  setPrompt,
  showToast,
}: {
  advanceTrainingTurn: () => void;
  bindTrainingSession: (sessionId: string) => void;
  composerDraftStore: ComposerDraftStore;
  createCloudWork: (request: CloudWorkRequest) => Promise<boolean>;
  onSessionCreated: (session: Session) => void;
  pendingWorkspaceTarget: QueuedCloudWorkSubmissionInput["pendingWorkspaceTarget"];
  prepareTrainingTurn: (prompt: string) => {
    active: boolean;
    error: string | null;
    metadata: Record<string, unknown> | null;
  };
  selectedCloudProjectId: string | null;
  selectedLocalProjectId: string | null;
  selectedLocalProjectName: string | null;
  selectedLocalWorkspacePath: string | null;
  selectedProjectCloudBaseSha: string | null;
  selectedProjectCloudProjectId: string | null;
  selectedProjectCloudSourceRef: string | null;
  sendPrompt: SendPrompt;
  setMentionedAppId: Dispatch<SetStateAction<string | null>>;
  setPendingWorkspaceTarget: Dispatch<SetStateAction<"queue_cloud" | "hybrid" | null>>;
  setPrompt: Dispatch<SetStateAction<string>>;
  showToast: ShowAppToast;
}) {
  return useCallback(async (
    attachments: ChatAttachment[] = [],
    action: SandboxActionCatalogEntry | null = null,
    promptOverride?: string,
    options: ComposerSubmitOptions = {},
  ) => {
    const promptForSubmission = promptOverride ?? composerDraftStore.getSnapshot();
    const trainingTurn = prepareTrainingTurn(promptForSubmission);
    if (trainingTurn.active && promptForSubmission.trim() && !trainingTurn.metadata) {
      showToast(
        trainingTurn.error ?? "Load the selected generated Taskset question before sending, or close the generated-question handoff to write a normal prompt.",
        "error",
      );
      return false;
    }

    const queuedSubmission = queuedCloudWorkSubmission({
      pendingWorkspaceTarget,
      actionSelected: Boolean(action),
      promptOverrideProvided: promptOverride !== undefined,
      attachmentCount: attachments.length,
      selectedCloudProjectId,
      selectedProjectCloudProjectId,
      selectedLocalProjectId,
      selectedLocalProjectName,
      selectedLocalWorkspacePath,
      selectedProjectCloudSourceRef,
      selectedProjectCloudBaseSha,
      prompt: promptForSubmission,
    });
    if (queuedSubmission.kind !== "not_queued") {
      if (queuedSubmission.kind === "attachments_unsupported") {
        showToast(queuedSubmission.message, "error");
        return false;
      }
      if (queuedSubmission.kind === "missing_cloud_project") {
        showToast(queuedSubmission.message, "error");
        setPendingWorkspaceTarget(null);
        return false;
      }
      if (queuedSubmission.kind === "empty_prompt") return false;
      const created = await createCloudWork(queuedSubmission.request);
      if (created) {
        if (!options.preservePrompt) {
          setPrompt("");
          setMentionedAppId(null);
        }
        setPendingWorkspaceTarget(null);
      }
      return created;
    }

    const sent = await sendPrompt(attachments, action, promptOverride, {
      clearPrompt: options.preservePrompt ? () => undefined : undefined,
      displayPrompt: options.displayPrompt,
      onSessionCreated: (session) => {
        onSessionCreated(session);
        if (trainingTurn.metadata) bindTrainingSession(session.id);
      },
      turnMetadata: trainingTurn.metadata ?? undefined,
    });
    if (sent && trainingTurn.metadata) advanceTrainingTurn();
    return sent;
  }, [
    advanceTrainingTurn,
    bindTrainingSession,
    composerDraftStore,
    createCloudWork,
    onSessionCreated,
    pendingWorkspaceTarget,
    prepareTrainingTurn,
    selectedCloudProjectId,
    selectedLocalProjectId,
    selectedLocalProjectName,
    selectedLocalWorkspacePath,
    selectedProjectCloudBaseSha,
    selectedProjectCloudProjectId,
    selectedProjectCloudSourceRef,
    sendPrompt,
    setMentionedAppId,
    setPendingWorkspaceTarget,
    setPrompt,
    showToast,
  ]);
}
