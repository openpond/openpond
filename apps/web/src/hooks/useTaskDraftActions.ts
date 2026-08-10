import { useCallback, useEffect, type Dispatch, type SetStateAction } from "react";
import {
  DEFAULT_OPENPOND_CHAT_MODEL,
  type ChatProvider,
  type CloudProject,
  type CreateSessionRequest,
  type Experience,
  type LocalProject,
  type OpenPondCommandAccessMode,
  type Session,
} from "@openpond/contracts";
import { api, type ClientConnection } from "../api";
import type { ShowAppToast } from "../app/app-state";
import type { AppView } from "../lib/app-models";
import type { ComposerDraftStore } from "../lib/composer-draft-store";
import {
  buildHybridWorkspaceSessionRequest,
  resolveHybridWorkspaceTarget,
} from "../lib/hybrid-workspace-session";
import {
  isTaskDraftSession,
  taskDraftPrompt,
  taskDraftTitle,
  withTaskDraftMetadata,
} from "../lib/task-drafts";
import type { WorkspaceTargetValue } from "../lib/workspace-location";

export function useTaskDraftActions(input: {
  activeExperience: Experience;
  activeModel: string;
  activeOpenPondCommandAccessMode: OpenPondCommandAccessMode;
  activeProvider: ChatProvider;
  cloudProjects: CloudProject[];
  composerDraftStore: ComposerDraftStore;
  connection: ClientConnection | null;
  requestComposerFocus: () => void;
  selectedCloudProject: CloudProject | null;
  selectedProject: LocalProject | null;
  selectedSession: Session | null;
  setMentionedAppId: Dispatch<SetStateAction<string | null>>;
  setSelectedSessionId: Dispatch<SetStateAction<string | null>>;
  setSessions: Dispatch<SetStateAction<Session[]>>;
  setView: Dispatch<SetStateAction<AppView>>;
  showToast: ShowAppToast;
  workspaceTarget: WorkspaceTargetValue;
}) {
  useEffect(() => {
    const savedPrompt = taskDraftPrompt(input.selectedSession);
    if (!savedPrompt || input.composerDraftStore.getSnapshot()) return;
    input.composerDraftStore.set(savedPrompt);
  }, [
    input.composerDraftStore,
    input.selectedSession?.id,
  ]);

  return useCallback(
    async (prompt: string): Promise<boolean> => {
      const value = prompt.trim();
      if (
        !input.connection ||
        !value ||
        input.activeExperience === "chat"
      ) {
        return false;
      }
      const title = taskDraftTitle(value);

      try {
        let draftSession: Session;
        const currentSession = input.selectedSession;
        if (currentSession && isTaskDraftSession(currentSession)) {
          draftSession = await api.patchSession(
            input.connection,
            currentSession.id,
            {
              title,
              metadata: withTaskDraftMetadata(currentSession.metadata, value),
            }
          );
          input.setSessions((current) =>
            current.map((session) =>
              session.id === draftSession.id ? draftSession : session
            )
          );
        } else {
          const sourceWorkspaceTarget =
            currentSession?.metadata?.workspaceTarget === "hybrid"
              ? "hybrid"
              : currentSession?.metadata?.workspaceTarget === "local"
              ? "local"
              : null;
          const provider =
            currentSession?.provider ??
            (input.selectedCloudProject ? "openpond" : input.activeProvider);
          const modelRef =
            currentSession?.modelRef ??
            (provider === "openpond"
              ? {
                  providerId: "openpond" as const,
                  modelId: DEFAULT_OPENPOND_CHAT_MODEL,
                }
              : { providerId: provider, modelId: input.activeModel });
          const baseMetadata = sourceWorkspaceTarget
            ? { workspaceTarget: sourceWorkspaceTarget }
            : !currentSession && input.workspaceTarget === "local"
            ? { workspaceTarget: "local" }
            : {};
          let request: CreateSessionRequest;

          if (!currentSession && input.workspaceTarget === "hybrid") {
            const target = resolveHybridWorkspaceTarget({
              cloudProjects: input.cloudProjects,
              selectedCloudProject: input.selectedCloudProject,
              selectedProject: input.selectedProject,
            });
            if (target.kind !== "ready") throw new Error(target.message);
            const hybridRequest = buildHybridWorkspaceSessionRequest({
              modelRef,
              provider,
              target,
              title,
            });
            request = {
              ...hybridRequest,
              experience: "work",
              metadata: withTaskDraftMetadata(hybridRequest.metadata, value),
            };
          } else {
            request = {
              experience: "work",
              provider,
              modelRef,
              openPondCommandAccessMode:
                currentSession?.openPondCommandAccessMode ??
                input.activeOpenPondCommandAccessMode,
              appId: currentSession?.appId ?? null,
              appName: currentSession?.appName ?? null,
              workspaceKind:
                currentSession?.workspaceKind ??
                (input.selectedCloudProject
                  ? "sandbox"
                  : input.selectedProject
                  ? "local_project"
                  : undefined),
              workspaceId:
                currentSession?.workspaceId ??
                input.selectedCloudProject?.id ??
                input.selectedProject?.id ??
                null,
              workspaceName:
                currentSession?.workspaceName ??
                input.selectedCloudProject?.name ??
                input.selectedProject?.name ??
                null,
              localProjectId:
                currentSession?.localProjectId ??
                input.selectedProject?.id ??
                null,
              cloudProjectId:
                currentSession?.cloudProjectId ??
                input.selectedCloudProject?.id ??
                null,
              cloudTeamId:
                currentSession?.cloudTeamId ??
                input.selectedCloudProject?.teamId ??
                null,
              cwd:
                currentSession?.cwd ??
                input.selectedProject?.workspacePath ??
                null,
              metadata: withTaskDraftMetadata(baseMetadata, value),
              title,
            };
          }

          draftSession = await api.createSession(input.connection, request);
          input.setSessions((current) => [draftSession, ...current]);
        }

        input.composerDraftStore.set("");
        input.setMentionedAppId(null);
        input.setSelectedSessionId(null);
        input.setView("chat");
        input.requestComposerFocus();
        input.showToast("Task draft saved.", "success");
        return true;
      } catch (error) {
        input.showToast(
          error instanceof Error ? error.message : "Could not save task draft.",
          "error"
        );
        return false;
      }
    },
    [
      input.activeExperience,
      input.activeModel,
      input.activeOpenPondCommandAccessMode,
      input.activeProvider,
      input.cloudProjects,
      input.composerDraftStore,
      input.connection,
      input.requestComposerFocus,
      input.selectedCloudProject,
      input.selectedProject,
      input.selectedSession,
      input.setMentionedAppId,
      input.setSelectedSessionId,
      input.setSessions,
      input.setView,
      input.showToast,
      input.workspaceTarget,
    ]
  );
}
