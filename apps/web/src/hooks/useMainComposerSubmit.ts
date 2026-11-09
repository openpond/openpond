import { useCallback, type Dispatch, type SetStateAction } from "react";
import type { ChatAttachment, Session, UsageRequestAttribution } from "@openpond/contracts";
import type { ShowAppToast } from "../app/app-state";
import type { ComposerSubmitOptions } from "../components/chat/Composer";
import { captureSubmittedDraftClear, type ComposerDraftStore } from "../lib/composer-draft-store";
import type { SandboxActionCatalogEntry } from "../lib/sandbox-types";

type SendPrompt = (
  attachments?: ChatAttachment[],
  action?: SandboxActionCatalogEntry | null,
  promptOverride?: string,
  options?: {
    clearPrompt?: () => void;
    displayPrompt?: string;
    usageAttribution?: UsageRequestAttribution;
    onSessionCreated?: (session: Session) => void;
    turnMetadata?: Record<string, unknown>;
    sessionMetadata?: Record<string, unknown>;
  },
) => Promise<boolean>;

export function useMainComposerSubmit({
  advanceTrainingTurn,
  bindTrainingSession,
  composerDraftStore,
  onSessionCreated,
  onSubmitted,
  prepareTrainingTurn,
  sendPrompt,
  setMentionedAppId,
  showToast,
}: {
  advanceTrainingTurn: () => void;
  bindTrainingSession: (sessionId: string) => void;
  composerDraftStore: ComposerDraftStore;
  onSessionCreated: (session: Session) => void;
  onSubmitted?: () => Promise<void> | void;
  prepareTrainingTurn: (prompt: string) => {
    active: boolean;
    error: string | null;
    metadata: Record<string, unknown> | null;
  };
  sendPrompt: SendPrompt;
  setMentionedAppId: Dispatch<SetStateAction<string | null>>;
  showToast: ShowAppToast;
}) {
  return useCallback(async (
    attachments: ChatAttachment[] = [],
    action: SandboxActionCatalogEntry | null = null,
    promptOverride?: string,
    options: ComposerSubmitOptions & NonNullable<Parameters<SendPrompt>[3]> = {},
  ) => {
    const promptForSubmission = promptOverride ?? composerDraftStore.getSnapshot();
    const clearSubmittedDraft = captureSubmittedDraftClear(composerDraftStore);
    const trainingTurn = prepareTrainingTurn(promptForSubmission);
    if (trainingTurn.active && promptForSubmission.trim() && !trainingTurn.metadata) {
      showToast(
        trainingTurn.error ?? "Load the selected generated Taskset question before sending, or close the generated-question handoff to write a normal prompt.",
        "error",
      );
      return false;
    }

    const sent = await sendPrompt(attachments, action, promptOverride, {
      clearPrompt: options.preservePrompt ? () => undefined : options.clearPrompt ?? (() => {
        if (clearSubmittedDraft()) setMentionedAppId(null);
      }),
      displayPrompt: options.displayPrompt,
      usageAttribution: options.usageAttribution,
      onSessionCreated: (session) => {
        onSessionCreated(session);
        options.onSessionCreated?.(session);
        if (trainingTurn.metadata) bindTrainingSession(session.id);
      },
      turnMetadata:
        trainingTurn.metadata || options.turnMetadata
          ? { ...trainingTurn.metadata, ...options.turnMetadata }
          : undefined,
      sessionMetadata: trainingTurn.metadata || options.sessionMetadata
        ? {
            ...options.sessionMetadata,
            trainingTasksetId: trainingTurn.metadata?.trainingTasksetId,
            trainingTasksetName: trainingTurn.metadata?.trainingTasksetName,
          }
        : undefined,
    });
    if (sent) await onSubmitted?.();
    if (sent && trainingTurn.metadata) advanceTrainingTurn();
    return sent;
  }, [
    advanceTrainingTurn,
    bindTrainingSession,
    composerDraftStore,
    onSessionCreated,
    onSubmitted,
    prepareTrainingTurn,
    sendPrompt,
    setMentionedAppId,
    showToast,
  ]);
}
