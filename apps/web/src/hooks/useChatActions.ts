import { useRef, type Dispatch, type SetStateAction } from "react";
import type {
  BootstrapPayload,
  ChatAttachment,
  ChatProvider,
  CloudProject,
  CodexPermissionMode,
  CodexReasoningEffort,
  CreatePipelineRequest,
  CreatePipelineSnapshot,
  LocalProject,
  LocalProjectOpenPondLink,
  OpenPondApp,
  RuntimeEvent,
  Session,
  WorkspaceState,
} from "@openpond/contracts";
import { api, type ClientConnection } from "../api";
import {
  codexPermissionTurnInput,
  modelForTurn,
  modelRefForTurn,
  normalizeChatModel,
  projectSelectionKey,
  type ChatMessage,
  type AppView,
} from "../lib/app-models";
import {
  promptContainsChatAppMention,
  resolveMentionedChatApp as resolveMentionedSandboxChatApp,
  sandboxMentionApps,
} from "../lib/chat-app-mentions";
import { resolveMentionedAction } from "../lib/action-mentions";
import {
  answerCreatePipelineQuestionSnapshot,
  approveCreatePipelineSnapshot,
  buildComposerCreatePipelineRequest,
  cancelCreatePipelineSnapshot,
  reviseCreatePipelineSnapshot,
} from "../lib/create-pipeline-request";
import { parseComposerSlashCommandPrompt } from "../lib/composer-slash-commands";
import { isCodexHistorySessionId } from "../lib/sidebar-session-projects";
import {
  buildOpenPondAgentRunInput,
  buildOpenPondAppActionRunInput,
  buildOpenPondProfileActionRunInput,
  openPondAgentSlashCommandInfo,
  openPondProfileActionInfo,
} from "../lib/openpond-action-run";
import { openPondActionProjectTarget } from "../lib/openpond-action-project";
import type {
  SandboxActionCatalogEntry,
  SandboxAgent,
  SandboxAgentRunResponse,
} from "../lib/sandbox-types";
import {
  preloadSandboxAgents,
  readSandboxAgentsFromMemory,
} from "../lib/sandbox-agent-memory";
import { isCloudWorkspaceKind } from "../lib/workspace-location";

type UseChatActionsInput = {
  applyBootstrapPayload: (payload: BootstrapPayload) => void;
  connection: ClientConnection | null;
  codexPermissionMode: CodexPermissionMode;
  codexReasoningEffort: CodexReasoningEffort;
  draftModel: string;
  draftProvider: ChatProvider;
  expandProject: (projectId: string) => void;
  ensureCloudSessionReady?: (session: Session) => Promise<Session>;
  prompt: string;
  bootstrap: BootstrapPayload | null;
  chatMessages: ChatMessage[];
  apps: OpenPondApp[];
  mentionedAppId: string | null;
  refreshWorkspace: (appId: string | null | undefined, ensure?: boolean) => Promise<WorkspaceState | null>;
  refreshWorkspaceDiff: (appId?: string | null | undefined) => Promise<unknown>;
  selectedApp: OpenPondApp | null;
  selectedActionCatalog: SandboxActionCatalogEntry[];
  openPondActionCatalog: SandboxActionCatalogEntry[];
  selectedCloudProject: CloudProject | null;
  selectedProject: LocalProject | null;
  selectedProjectLinkedOpenPondApp: LocalProjectOpenPondLink | null;
  selectedSession: Session | null;
  sessions: Session[];
  setBusy: Dispatch<SetStateAction<boolean>>;
  setDraftModel: Dispatch<SetStateAction<string>>;
  setDraftProvider: Dispatch<SetStateAction<ChatProvider>>;
  setError: Dispatch<SetStateAction<string | null>>;
  setPrompt: Dispatch<SetStateAction<string>>;
  setMentionedAppId: Dispatch<SetStateAction<string | null>>;
  setCodexHistoryEvents: Dispatch<SetStateAction<RuntimeEvent[]>>;
  setCodexHistorySessions: Dispatch<SetStateAction<Session[]>>;
  setEvents: Dispatch<SetStateAction<RuntimeEvent[]>>;
  setSelectedAppId: Dispatch<SetStateAction<string | null>>;
  setSelectedProjectId: Dispatch<SetStateAction<string | null>>;
  setSelectedSessionId: Dispatch<SetStateAction<string | null>>;
  setSessions: Dispatch<SetStateAction<Session[]>>;
  setView: Dispatch<SetStateAction<AppView>>;
  setWorkspaceBusy: Dispatch<SetStateAction<boolean>>;
};

type SendPromptOptions = {
  session?: Session | null;
  selectSession?: boolean;
  onSessionCreated?: (session: Session) => void;
  clearPrompt?: () => void;
  provider?: ChatProvider;
  model?: string;
  chatMessages?: ChatMessage[];
  displayPrompt?: string;
};

function directActionRunEvents({
  action,
  prompt,
  runPayload,
  sessionId,
}: {
  action: SandboxActionCatalogEntry;
  prompt: string;
  runPayload: SandboxAgentRunResponse;
  sessionId: string;
}): RuntimeEvent[] {
  const timestamp = new Date().toISOString();
  const turnId = `openpond_action_${runPayload.run.id}`;
  const status =
    runPayload.run.status === "failed"
      ? "failed"
      : runPayload.run.status === "succeeded"
        ? "completed"
        : "started";
  return [
    {
      id: `${turnId}_user`,
      sessionId,
      turnId,
      name: "turn.started",
      timestamp,
      source: "chat_action",
      args: { prompt },
    },
    {
      id: `${turnId}_result`,
      sessionId,
      turnId,
      name: "workspace_action_result",
      timestamp: runPayload.run.updatedAt ?? timestamp,
      source: "chat_action",
      action: "sandbox_run_action",
      appId: null,
      status,
      output:
        status === "completed"
          ? `Ran ${action.label ?? action.name ?? action.id}`
          : `Started ${action.label ?? action.name ?? action.id}`,
      data: {
        openPondActionRun: true,
        action: {
          name: action.id,
          label: action.label ?? action.name ?? action.id,
          implementation: action.implementation,
        },
        agent: runPayload.agent,
        run: runPayload.run,
        sandbox: runPayload.sandbox ?? null,
        actionSummary: runPayload.run.actionSummary ?? null,
        responseSummary: runPayload.run.responseSummary ?? null,
        traceSummary: runPayload.run.traceSummary ?? null,
        evalSummary: runPayload.run.evalSummary ?? null,
        sourceSummary: runPayload.run.sourceSummary ?? null,
      },
    },
  ];
}

export function useChatActions({
  applyBootstrapPayload,
  connection,
  codexPermissionMode,
  codexReasoningEffort,
  draftModel,
  draftProvider,
  expandProject,
  ensureCloudSessionReady,
  prompt,
  bootstrap,
  chatMessages,
  apps,
  mentionedAppId,
  refreshWorkspace,
  refreshWorkspaceDiff,
  selectedApp,
  selectedActionCatalog,
  openPondActionCatalog,
  selectedCloudProject,
  selectedProject,
  selectedProjectLinkedOpenPondApp,
  selectedSession,
  sessions,
  setBusy,
  setDraftModel,
  setDraftProvider,
  setError,
  setPrompt,
  setMentionedAppId,
  setCodexHistoryEvents,
  setCodexHistorySessions,
  setEvents,
  setSelectedAppId,
  setSelectedProjectId,
  setSelectedSessionId,
  setSessions,
  setView,
  setWorkspaceBusy,
}: UseChatActionsInput) {
  const activeTurnSessionIdRef = useRef<string | null>(null);
  const providerSettings = bootstrap?.providers ?? null;

  function changeDraftProvider(provider: ChatProvider) {
    setDraftProvider(provider);
    setDraftModel((current) => normalizeChatModel(provider, current, providerSettings));
    setSelectedSessionId(null);
    setView("chat");
  }

  async function sandboxAgentForProject(projectId: string, teamId: string): Promise<SandboxAgent | null> {
    const cachedAgents = readSandboxAgentsFromMemory(teamId);
    const agents =
      cachedAgents ??
      (await preloadSandboxAgents({
        teamId,
        fetchAgents: async (nextTeamId) => {
          const agentsPayload = await api.listSandboxAgents(connection!, { teamId: nextTeamId });
          return agentsPayload.agents;
        },
      }));
    return agents.find((agent) => agent.projectId === projectId) ?? null;
  }

  async function sendPrompt(
    attachments: ChatAttachment[] = [],
    selectedAction: SandboxActionCatalogEntry | null = null,
    promptOverride?: string,
    options: SendPromptOptions = {},
  ): Promise<boolean> {
    const promptForTurn = promptOverride ?? prompt;
    let value = promptForTurn.trim() || (attachments.length > 0 ? "Please review the attached files." : "");
    if (!connection || !value) return false;
    const displayPromptForTurn = options.displayPrompt?.trim() || value;
    const providerForTurn = options.provider ?? draftProvider;
    const modelForTurnValue = options.model ?? draftModel;
    const explicitTurnContext = options.session !== undefined;
    const selectedSessionForTurn = explicitTurnContext ? options.session : selectedSession;
    const selectedAppForTurn = explicitTurnContext ? null : selectedApp;
    const selectedProjectForTurn = explicitTurnContext ? null : selectedProject;
    const selectedCloudProjectForTurn = explicitTurnContext ? null : selectedCloudProject;
    const selectedProjectLinkedOpenPondAppForTurn = explicitTurnContext ? null : selectedProjectLinkedOpenPondApp;
    const shouldSelectSession = options.selectSession ?? true;
    const turnChatMessages = options.chatMessages ?? chatMessages;
    const mentionedAppIdForTurn = options.session !== undefined ? null : mentionedAppId;
    const clearPromptForTurn =
      options.clearPrompt ??
      (() => {
        setPrompt("");
        setMentionedAppId(null);
      });
    const actionMentionResolution = selectedAction
      ? null
      : resolveMentionedAction(value, selectedActionCatalog);
    const selectedActionForTurn = selectedAction ?? actionMentionResolution?.action ?? null;
    const actionPromptForRun = actionMentionResolution?.prompt || value;
    setBusy(true);
    setError(null);
    let turnSessionId: string | null = null;
    try {
	      if (selectedActionForTurn) {
	        const selectedAgent = openPondAgentSlashCommandInfo(selectedActionForTurn);
	        if (selectedAgent) {
	          let session = selectedSessionForTurn;
	          if (!session || session.cloudProjectId !== selectedAgent.projectId) {
	            session = await api.createSession(connection, {
	              provider: "openpond",
	              modelRef: modelRefForTurn("openpond", modelForTurnValue, providerSettings),
	              appId: null,
	              appName: null,
	              workspaceKind: "sandbox",
	              workspaceId: selectedAgent.projectId,
	              workspaceName: selectedAgent.projectName ?? selectedAgent.agentName,
	              localProjectId: null,
	              cloudProjectId: selectedAgent.projectId,
	              cloudTeamId: selectedAgent.teamId,
	              cwd: null,
	              title: actionPromptForRun.slice(0, 64),
	            });
	            setSessions((current) => [session!, ...current]);
	            options.onSessionCreated?.(session);
            if (shouldSelectSession) setSelectedSessionId(session.id);
            const projectKey = projectSelectionKey("cloud", selectedAgent.projectId);
            if (shouldSelectSession) setSelectedProjectId(projectKey);
            if (shouldSelectSession) expandProject(projectKey);
          }
	          const runPayload = await api.runSandboxAgent(
	            connection,
	            selectedAgent.agentId,
	            buildOpenPondAgentRunInput({
	              agent: selectedAgent,
	              attachments,
	              prompt: actionPromptForRun,
	            }),
	          );
          const payload = await api.bootstrap(connection);
          applyBootstrapPayload(payload);
          clearPromptForTurn();
          setEvents((current) => [
	            ...current,
	            ...directActionRunEvents({
	              action: selectedActionForTurn,
	              prompt: displayPromptForTurn,
	              runPayload,
	              sessionId: session!.id,
	            }),
	          ]);
          return true;
        }

        const selectedProfileAction = openPondProfileActionInfo(selectedActionForTurn);
        if (selectedProfileAction) {
          let session = selectedSessionForTurn;
          if (!session || session.provider !== "openpond") {
            session = await api.createSession(connection, {
              provider: "openpond",
              modelRef: modelRefForTurn("openpond", modelForTurnValue, providerSettings),
              appId: null,
              appName: null,
              workspaceId: null,
	              workspaceName: "OpenPond profile",
	              localProjectId: null,
	              cloudProjectId: null,
	              cloudTeamId: null,
	              cwd: null,
	              title: actionPromptForRun.slice(0, 64),
	            });
            setSessions((current) => [session!, ...current]);
            options.onSessionCreated?.(session);
            if (shouldSelectSession) setSelectedSessionId(session.id);
          }
	          await api.runProfileAction(
	            connection,
	            buildOpenPondProfileActionRunInput({
	              action: selectedProfileAction,
	              attachments,
	              displayPrompt: displayPromptForTurn,
	              prompt: actionPromptForRun,
	              sessionId: session.id,
	            }),
	          );
          const payload = await api.bootstrap(connection);
          applyBootstrapPayload(payload);
          clearPromptForTurn();
          return true;
        }

        const actionProjectTarget = openPondActionProjectTarget({ selectedCloudProject, selectedProject });
        if (!actionProjectTarget) {
          throw new Error("Select a Project linked to an OpenPond Cloud Project before running an action.");
        }
        let session = selectedSessionForTurn;
        if (!session || session.cloudProjectId !== actionProjectTarget.id) {
          session = await api.createSession(connection, {
            provider: "openpond",
            modelRef: modelRefForTurn("openpond", modelForTurnValue, providerSettings),
            appId: null,
            appName: null,
            workspaceKind: "sandbox",
            workspaceId: actionProjectTarget.id,
	            workspaceName: actionProjectTarget.name,
	            localProjectId: actionProjectTarget.localProjectId,
	            cloudProjectId: actionProjectTarget.id,
	            cloudTeamId: actionProjectTarget.teamId,
	            cwd: null,
	            title: actionPromptForRun.slice(0, 64),
	          });
          setSessions((current) => [session!, ...current]);
          options.onSessionCreated?.(session);
          if (shouldSelectSession) {
            setSelectedSessionId(session.id);
            setSelectedProjectId(actionProjectTarget.selectionKey);
            expandProject(actionProjectTarget.selectionKey);
          }
        }
        const agent = await sandboxAgentForProject(actionProjectTarget.id, actionProjectTarget.teamId);
        if (!agent) {
          throw new Error("No OpenPond Agent is available for this Project.");
        }
        clearPromptForTurn();
	        const runPayload = await api.runSandboxAgent(
	          connection,
	          agent.id,
	          buildOpenPondAppActionRunInput({
	            action: selectedActionForTurn,
	            attachments,
	            prompt: actionPromptForRun,
	            teamId: actionProjectTarget.teamId,
	          }),
	        );
        const payload = await api.bootstrap(connection);
        applyBootstrapPayload(payload);
        setEvents((current) => [
	          ...current,
	          ...directActionRunEvents({
	            action: selectedActionForTurn,
	            prompt: displayPromptForTurn,
	            runPayload,
	            sessionId: session!.id,
	          }),
	        ]);
        return true;
      }
      let session = selectedSessionForTurn;
      if (session && isCodexHistorySessionId(session.id)) {
        clearPromptForTurn();
        turnSessionId = session.id;
        activeTurnSessionIdRef.current = turnSessionId;
        setCodexHistorySessions((current) =>
          current.map((candidate) =>
            candidate.id === session!.id ? { ...candidate, status: "active" } : candidate
          )
        );
        const payload = await api.sendCodexHistoryTurn(connection, session.id, {
          prompt: value,
          attachments: attachments.length > 0 ? attachments : undefined,
          model: modelForTurn("codex", modelForTurnValue, providerSettings),
          modelRef: modelRefForTurn("codex", modelForTurnValue, providerSettings),
          ...codexPermissionTurnInput(codexPermissionMode),
          codexPermissionMode,
          codexReasoningEffort,
        });
        setCodexHistoryEvents(payload.events);
        setCodexHistorySessions((current) =>
          current.some((candidate) => candidate.id === payload.session.id)
            ? current.map((candidate) => (candidate.id === payload.session.id ? payload.session : candidate))
            : [payload.session, ...current]
        );
        return true;
      }
      const selectedMentionedSandboxApp = mentionedAppIdForTurn
        ? apps.find((app) => app.id === mentionedAppIdForTurn && promptContainsChatAppMention(promptForTurn, app) && app.sandbox) ?? null
        : null;
      const mentionedSandboxApp =
        selectedMentionedSandboxApp ?? resolveMentionedSandboxChatApp(promptForTurn, sandboxMentionApps(apps));
      if (!session) {
        const sessionAppId = selectedProjectLinkedOpenPondAppForTurn?.appId ?? selectedAppForTurn?.id ?? null;
        const sessionAppName = selectedProjectLinkedOpenPondAppForTurn?.appName ?? selectedAppForTurn?.name ?? null;
        const cloudProject = selectedCloudProjectForTurn;
        const sessionProvider = cloudProject ? "openpond" : providerForTurn;
        session = await api.createSession(connection, {
          provider: sessionProvider,
          modelRef: modelRefForTurn(sessionProvider, modelForTurnValue, providerSettings),
          appId: sessionAppId,
          appName: sessionAppName,
          workspaceKind: cloudProject ? "sandbox" : selectedProjectForTurn ? "local_project" : selectedAppForTurn ? "sandbox_app" : undefined,
          workspaceId: selectedProjectForTurn?.id ?? (selectedAppForTurn ? sessionAppId : undefined),
          workspaceName: cloudProject?.name ?? selectedProjectForTurn?.name ?? sessionAppName,
          localProjectId: selectedProjectForTurn?.id ?? null,
          cloudProjectId: cloudProject?.id ?? selectedProjectForTurn?.linkedSandboxProject?.projectId ?? null,
          cloudTeamId: cloudProject?.teamId ?? selectedProjectForTurn?.linkedSandboxProject?.teamId ?? null,
          cwd: selectedProjectForTurn ? selectedProjectForTurn.workspacePath : null,
          title: value.slice(0, 64),
        });
        setSessions((current) => [session!, ...current]);
        options.onSessionCreated?.(session);
        if (shouldSelectSession) {
          setSelectedSessionId(session.id);
          if (cloudProject) setSelectedProjectId(projectSelectionKey("cloud", cloudProject.id));
          if (session.workspaceKind === "local_project" && session.workspaceId) {
            expandProject(projectSelectionKey("local", session.workspaceId));
          }
          if (cloudProject) expandProject(projectSelectionKey("cloud", cloudProject.id));
        }
      }
      if (isCloudWorkspaceKind(session.workspaceKind) && session.provider !== "openpond") {
        throw new Error("Cloud workspaces use OpenPond Chat. Switch to Local to use local providers.");
      }
      if (isCloudWorkspaceKind(session.workspaceKind) && ensureCloudSessionReady) {
        session = await ensureCloudSessionReady(session);
      }
      const parsedCreatePipelineCommand = parseComposerSlashCommandPrompt(value);
      const createPipelineRequest = parsedCreatePipelineCommand
        ? buildComposerCreatePipelineRequest({
            parsed: parsedCreatePipelineCommand,
            prompt: value,
            payload: bootstrap,
            session,
            messages: turnChatMessages,
            attachments,
            apps: mentionedSandboxApp ? [mentionedSandboxApp] : [],
          })
        : null;
      if (parsedCreatePipelineCommand?.command === "edit" && !createPipelineRequest) {
        throw new Error("Select an agent-backed chat before using /edit.");
      }
      clearPromptForTurn();
      turnSessionId = session.id;
      activeTurnSessionIdRef.current = turnSessionId;
      setSessions((current) =>
        current.map((candidate) =>
          candidate.id === turnSessionId ? { ...candidate, status: "active" } : candidate
        )
      );
      const codexTurnPermissions =
        session.provider === "codex"
          ? codexPermissionTurnInput(codexPermissionMode)
          : {
              approvalPolicy: "on-request" as const,
              sandbox: "workspace-write" as const,
            };
      await api.sendTurn(connection, session.id, {
        prompt: value,
        attachments: attachments.length > 0 ? attachments : undefined,
        mentionedAppIds: mentionedSandboxApp ? [mentionedSandboxApp.id] : undefined,
        openPondActionCatalog:
          openPondActionCatalog.length > 0 ? openPondActionCatalog : undefined,
        createPipelineRequest,
        model: modelForTurn(session.provider, modelForTurnValue, providerSettings),
        modelRef: modelRefForTurn(session.provider, modelForTurnValue, providerSettings),
        ...codexTurnPermissions,
        codexPermissionMode: session.provider === "codex" ? codexPermissionMode : "default",
        codexReasoningEffort: session.provider === "codex" ? codexReasoningEffort : undefined,
      });
      const payload = await api.bootstrap(connection);
      applyBootstrapPayload(payload);
      const workspaceId = session.workspaceId ?? session.appId;
      if (workspaceId && session.workspaceKind !== "sandbox" && session.workspaceKind !== "sandbox_template") {
        void refreshWorkspace(workspaceId, false).then((state) => {
          if (state?.initialized) void refreshWorkspaceDiff(workspaceId);
        });
      }
      return true;
    } catch (sendError) {
      setError(sendError instanceof Error ? sendError.message : String(sendError));
      return false;
    } finally {
      if (turnSessionId && activeTurnSessionIdRef.current === turnSessionId) activeTurnSessionIdRef.current = null;
      if (turnSessionId) {
        if (isCodexHistorySessionId(turnSessionId)) {
          setCodexHistorySessions((current) =>
            current.map((candidate) =>
              candidate.id === turnSessionId && candidate.status === "active"
                ? { ...candidate, status: "idle" }
                : candidate
            )
          );
        } else {
          setSessions((current) =>
            current.map((candidate) =>
              candidate.id === turnSessionId && candidate.status === "active"
                ? { ...candidate, status: "idle" }
                : candidate
            )
          );
        }
      }
      setBusy(false);
    }
  }

  async function stopTurn(sessionId?: string | null) {
    const activeSessionId = sessionId ?? activeTurnSessionIdRef.current ?? selectedSession?.id ?? null;
    if (!connection || !activeSessionId) return;
    setError(null);
    if (isCodexHistorySessionId(activeSessionId)) {
      setError("Stopping a turn started from Codex history is not available yet.");
      return;
    }
    try {
      await api.interruptTurn(connection, activeSessionId);
      const payload = await api.bootstrap(connection);
      applyBootstrapPayload(payload);
    } catch (stopError) {
      setError(stopError instanceof Error ? stopError.message : String(stopError));
    } finally {
      setBusy(false);
    }
  }

  async function persistCreatePipelineTurn(input: {
    turnId: string;
    request: CreatePipelineRequest;
    snapshot: CreatePipelineSnapshot;
  }): Promise<void> {
    if (!connection) {
      setError("OpenPond App server is not connected.");
      return;
    }
    const sessionId = input.request.scope.conversationId;
    if (!sessionId) {
      setError("Create pipeline turn is missing its conversation scope.");
      return;
    }
    setError(null);
    await api.updateTurnCreatePipeline(connection, sessionId, input.turnId, {
      createPipelineRequest: input.request,
      createPipeline: input.snapshot,
    });
    const payload = await api.bootstrap(connection);
    applyBootstrapPayload(payload);
  }

  async function approveCreatePipelineTurn(input: {
    turnId: string;
    request: CreatePipelineRequest;
    snapshot: CreatePipelineSnapshot | null;
  }): Promise<void> {
    const base = requireCreatePipelineSnapshot(input.snapshot, "Create plan is not ready to approve yet.");
    await persistCreatePipelineTurn({
      turnId: input.turnId,
      request: input.request,
      snapshot: approveCreatePipelineSnapshot(base),
    });
  }

  async function cancelCreatePipelineTurn(input: {
    turnId: string;
    request: CreatePipelineRequest;
    snapshot: CreatePipelineSnapshot | null;
  }): Promise<void> {
    const base = requireCreatePipelineSnapshot(input.snapshot, "Create workflow is not ready to cancel yet.");
    await persistCreatePipelineTurn({
      turnId: input.turnId,
      request: input.request,
      snapshot: cancelCreatePipelineSnapshot(base),
    });
  }

  async function reviseCreatePipelineTurn(
    input: {
      turnId: string;
      request: CreatePipelineRequest;
      snapshot: CreatePipelineSnapshot | null;
    },
    revision: string,
  ): Promise<void> {
    const base = requireCreatePipelineSnapshot(input.snapshot, "Create plan is not ready to revise yet.");
    await persistCreatePipelineTurn({
      turnId: input.turnId,
      request: input.request,
      snapshot: reviseCreatePipelineSnapshot(base, revision),
    });
  }

  async function answerCreatePipelineQuestionTurn(
    input: {
      turnId: string;
      request: CreatePipelineRequest;
      snapshot: CreatePipelineSnapshot | null;
    },
    questionId: string,
    answerValue: string,
  ): Promise<void> {
    const base = requireCreatePipelineSnapshot(input.snapshot, "Create question is not ready to answer yet.");
    await persistCreatePipelineTurn({
      turnId: input.turnId,
      request: input.request,
      snapshot: answerCreatePipelineQuestionSnapshot(base, questionId, answerValue),
    });
  }

  return {
    answerCreatePipelineQuestionTurn,
    approveCreatePipelineTurn,
    cancelCreatePipelineTurn,
    changeDraftProvider,
    reviseCreatePipelineTurn,
    sendPrompt,
    stopTurn,
  };
}

function requireCreatePipelineSnapshot(
  snapshot: CreatePipelineSnapshot | null,
  message: string,
): CreatePipelineSnapshot {
  if (!snapshot) throw new Error(message);
  return snapshot;
}

export { resolveMentionedChatApp } from "../lib/chat-app-mentions";
