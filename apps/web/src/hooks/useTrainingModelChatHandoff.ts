import { useCallback, useEffect, useState } from "react";
import type { BootstrapPayload, ChatProvider } from "@openpond/contracts";
import { api, type ClientConnection } from "../api";
import type { AppView } from "../lib/app-models";
import type { ComposerDraftStore } from "../lib/composer-draft-store";
import {
  advanceTrainingModelChatTask,
  refreshModelCatalogBeforeChat,
  selectedTrainingModelChatTask,
  selectTrainingModelChatTask,
  trainingModelChatProjectError,
  trainingModelChatTurnMetadata,
  type TrainingModelChatHandoff,
} from "../lib/training-model-chat-handoff";

export function useTrainingModelChatHandoff({
  activeModel,
  activeProvider,
  applyBootstrapPayload,
  beginNewChat,
  composerDraftStore,
  connection,
  requestComposerFocus,
  selectedLocalProjectId,
  selectedSessionId,
  selectLocalProject,
  setDraftModel,
  setDraftProvider,
  setError,
  view,
}: {
  activeModel: string;
  activeProvider: ChatProvider;
  applyBootstrapPayload: (payload: BootstrapPayload) => void;
  beginNewChat: (app?: null) => void;
  composerDraftStore: ComposerDraftStore;
  connection: ClientConnection | null;
  requestComposerFocus: () => void;
  selectedLocalProjectId: string | null;
  selectedSessionId: string | null;
  selectLocalProject: (projectId: string) => void;
  setDraftModel: (model: string) => void;
  setDraftProvider: (provider: ChatProvider) => void;
  setError: (message: string | null) => void;
  view: AppView;
}) {
  const [handoff, setHandoff] = useState<TrainingModelChatHandoff | null>(null);

  const beginIsolatedQuestionChat = useCallback((next: TrainingModelChatHandoff) => {
    if (next.sourceProjectId) selectLocalProject(next.sourceProjectId);
    else beginNewChat(null);
  }, [beginNewChat, selectLocalProject]);

  const selectTask = useCallback((index: number) => {
    if (!handoff) return;
    const next = {
      ...selectTrainingModelChatTask(handoff, index),
      sessionId: handoff.sessionId ? null : handoff.sessionId,
    };
    const task = selectedTrainingModelChatTask(next);
    setHandoff(next);
    if (task) {
      if (handoff.sessionId) beginIsolatedQuestionChat(next);
      composerDraftStore.set(task.prompt);
      requestComposerFocus();
    }
  }, [beginIsolatedQuestionChat, composerDraftStore, handoff, requestComposerFocus]);

  const dismiss = useCallback(() => {
    const task = selectedTrainingModelChatTask(handoff);
    if (task && composerDraftStore.getSnapshot().trim() === task.prompt.trim()) {
      composerDraftStore.set("");
    }
    setHandoff(null);
  }, [composerDraftStore, handoff]);

  const begin = useCallback((nextHandoff: TrainingModelChatHandoff) => {
    const model = nextHandoff.model;
    void refreshModelCatalogBeforeChat({
      model,
      connection,
      loadBootstrap: api.bootstrap,
      applyBootstrap: applyBootstrapPayload,
    }).then(() => {
      const prepared = { ...nextHandoff, selectedTaskIndex: 0, sessionId: null };
      setDraftProvider(model.providerId);
      setDraftModel(model.modelId);
      setHandoff(prepared.tasks.length ? prepared : null);
      beginIsolatedQuestionChat(prepared);
      const task = selectedTrainingModelChatTask(prepared);
      if (task) composerDraftStore.set(task.prompt);
    }).catch(setError);
  }, [
    applyBootstrapPayload,
    beginIsolatedQuestionChat,
    composerDraftStore,
    connection,
    setDraftModel,
    setDraftProvider,
    setError,
  ]);

  const prepareTurn = useCallback((prompt: string) => {
    const active = Boolean(
      handoff &&
      handoff.model.providerId === activeProvider &&
      handoff.model.modelId === activeModel,
    );
    return {
      active,
      error: active ? trainingModelChatProjectError(handoff, selectedLocalProjectId) : null,
      metadata: active ? trainingModelChatTurnMetadata(handoff, prompt, selectedLocalProjectId) : null,
    };
  }, [activeModel, activeProvider, handoff, selectedLocalProjectId]);

  const bindSession = useCallback((sessionId: string) => {
    setHandoff((current) => current ? { ...current, sessionId } : current);
  }, []);

  const advanceAfterTurn = useCallback(() => {
    if (!handoff) return;
    const next = { ...advanceTrainingModelChatTask(handoff), sessionId: null };
    const nextTask = selectedTrainingModelChatTask(next);
    setHandoff(next);
    if (nextTask) {
      beginIsolatedQuestionChat(next);
      composerDraftStore.set(nextTask.prompt);
      requestComposerFocus();
    }
  }, [beginIsolatedQuestionChat, composerDraftStore, handoff, requestComposerFocus]);

  useEffect(() => {
    const task = selectedTrainingModelChatTask(handoff);
    if (!task || view !== "chat" || selectedSessionId) return;
    composerDraftStore.set((current) => current.trim() ? current : task.prompt);
  }, [composerDraftStore, handoff, selectedLocalProjectId, selectedSessionId, view]);

  useEffect(() => {
    if (handoff && selectedSessionId && handoff.sessionId !== selectedSessionId) {
      setHandoff(null);
    }
  }, [handoff?.sessionId, selectedSessionId]);

  return { advanceAfterTurn, begin, bindSession, dismiss, handoff, prepareTurn, selectTask };
}
