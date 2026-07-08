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
  OpenPondCommandAccessMode,
  OpenPondApp,
  RuntimeEvent,
  Session,
  UsageRequestAttribution,
  WorkspaceState,
} from "@openpond/contracts";
import { DEFAULT_OPENPOND_CHAT_MODEL } from "@openpond/contracts";
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
import {
  resolveMentionedConnectedApps,
  type ConnectedAppMentionOption,
} from "../lib/connected-app-mentions";
import { resolveMentionedAction } from "../lib/action-mentions";
import {
  answerCreatePipelineQuestionSnapshot,
  approveCreatePipelineSnapshot,
  buildComposerCreatePipelineRequest,
  cancelCreatePipelineSnapshot,
  reviseCreatePipelineSnapshot,
} from "../lib/create-pipeline-request";
import {
  parseComposerDirectCommandPrompt,
  parseComposerSlashCommandPrompt,
} from "../lib/composer-slash-commands";
import { isCodexHistorySessionId } from "../lib/sidebar-session-projects";
import {
  buildOpenPondAgentRunInput,
  buildOpenPondAppActionRunInput,
  buildOpenPondProfileActionRunInput,
  openPondAgentSlashCommandInfo,
  openPondProfileActionInfo,
} from "../lib/openpond-action-run";
import {
  buildHybridWorkspaceSessionRequest,
  resolveHybridWorkspaceTarget,
} from "../lib/hybrid-workspace-session";
import { openPondActionProjectTarget } from "../lib/openpond-action-project";
import { normalizeOpenPondOrganization } from "../lib/cloud-project-utils";
import { canManageOpenPondOrganization, type OpenPondOrganization } from "../lib/organization-types";
import { implicitOrganization } from "../lib/project-agent-setup";
import { mergeRuntimeEventLists } from "../lib/runtime-event-lists";
import type {
  SandboxActionCatalogEntry,
  SandboxAgent,
  SandboxAgentRunResponse,
} from "../lib/sandbox-types";
import {
  preloadSandboxAgents,
  readSandboxAgentsFromMemory,
} from "../lib/sandbox-agent-memory";
import {
  createPendingUserChatMessage,
  type PendingChatUserMessage,
} from "../lib/pending-chat-messages";
import { upsertSessionPreservingLocalSidebarState } from "../lib/session-state";
import {
  isCloudWorkspaceKind,
  isHybridWorkspaceSession,
  type WorkspaceTargetValue,
} from "../lib/workspace-location";
import { confirmedLinkedCloudProject } from "../lib/cloud-link-trust";

type UseChatActionsInput = {
  applyBootstrapPayload: (payload: BootstrapPayload) => void;
  connection: ClientConnection | null;
  codexPermissionMode: CodexPermissionMode;
  codexReasoningEffort: CodexReasoningEffort;
  openPondCommandAccessMode: OpenPondCommandAccessMode;
  draftModel: string;
  draftProvider: ChatProvider;
  expandProject: (projectId: string) => void;
  ensureCloudSessionReady?: (session: Session) => Promise<Session>;
  prompt: string;
  bootstrap: BootstrapPayload | null;
  chatMessages: ChatMessage[];
  apps: OpenPondApp[];
  connectedAppMentions: ConnectedAppMentionOption[];
  mentionedAppId: string | null;
  refreshWorkspace: (appId: string | null | undefined, ensure?: boolean) => Promise<WorkspaceState | null>;
  refreshWorkspaceDiff: (appId?: string | null | undefined) => Promise<unknown>;
  selectedApp: OpenPondApp | null;
  selectedActionCatalog: SandboxActionCatalogEntry[];
  openPondActionCatalog: SandboxActionCatalogEntry[];
  cloudProjects: CloudProject[];
  accountScopeKey?: string | null;
  selectedCloudProject: CloudProject | null;
  selectedProject: LocalProject | null;
  selectedProjectLinkedOpenPondApp: LocalProjectOpenPondLink | null;
  selectedSession: Session | null;
  sessions: Session[];
  workspaceTarget: WorkspaceTargetValue;
  setDraftModel: Dispatch<SetStateAction<string>>;
  setDraftProvider: Dispatch<SetStateAction<ChatProvider>>;
  setError: Dispatch<SetStateAction<string | null>>;
  setPrompt: Dispatch<SetStateAction<string>>;
  setMentionedAppId: Dispatch<SetStateAction<string | null>>;
  setCodexHistoryEvents: Dispatch<SetStateAction<RuntimeEvent[]>>;
  setCodexHistorySessions: Dispatch<SetStateAction<Session[]>>;
  onCodexHistoryTurnPayload?: (payload: CodexHistoryTurnPayload) => void;
  onPendingUserMessage?: (message: PendingChatUserMessage) => void;
  onClearPendingUserMessage?: (sessionId: string, messageId: string) => void;
  setEvents: Dispatch<SetStateAction<RuntimeEvent[]>>;
  setSelectedAppId: Dispatch<SetStateAction<string | null>>;
  setSelectedProjectId: Dispatch<SetStateAction<string | null>>;
  setSelectedSessionId: Dispatch<SetStateAction<string | null>>;
  setSessions: Dispatch<SetStateAction<Session[]>>;
  setView: Dispatch<SetStateAction<AppView>>;
  setWorkspaceBusy: Dispatch<SetStateAction<boolean>>;
};

type CodexHistoryTurnPayload = {
  session: Session;
  events: RuntimeEvent[];
};

type SendPromptOptions = {
  session?: Session | null;
  selectSession?: boolean;
  onSessionCreated?: (session: Session) => void;
  onCodexHistoryOptimisticEvent?: (event: RuntimeEvent) => void;
  clearPrompt?: () => void;
  provider?: ChatProvider;
  model?: string;
  chatMessages?: ChatMessage[];
  displayPrompt?: string;
  usageAttribution?: UsageRequestAttribution;
  openPondCommandAccessMode?: OpenPondCommandAccessMode;
};

function appendRuntimeEventIfMissing(events: RuntimeEvent[], event: RuntimeEvent): RuntimeEvent[] {
  return events.some((candidate) => candidate.id === event.id) ? events : [...events, event];
}

function optimisticCodexHistoryTurnStartedEvent(sessionId: string, prompt: string): RuntimeEvent {
  const timestamp = new Date().toISOString();
  const localId = `codex_history_optimistic_${timestamp}_${Math.random().toString(36).slice(2, 8)}`;
  return {
    id: localId,
    sessionId,
    turnId: `${localId}_turn`,
    name: "turn.started",
    timestamp,
    source: "chat_action",
    args: { prompt },
    status: "started",
  };
}

function optimisticCodexHistoryTurnFailedEvent(startedEvent: RuntimeEvent, error: unknown): RuntimeEvent {
  return {
    id: `${startedEvent.id}_failed`,
    sessionId: startedEvent.sessionId,
    turnId: startedEvent.turnId,
    name: "turn.failed",
    timestamp: new Date().toISOString(),
    source: "server",
    status: "failed",
    error: error instanceof Error ? error.message : String(error),
  };
}

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
  openPondCommandAccessMode,
  draftModel,
  draftProvider,
  expandProject,
  ensureCloudSessionReady,
  prompt,
  bootstrap,
  chatMessages,
  apps,
  connectedAppMentions,
  mentionedAppId,
  refreshWorkspace,
  refreshWorkspaceDiff,
  selectedApp,
  selectedActionCatalog,
  openPondActionCatalog,
  cloudProjects,
  accountScopeKey,
  selectedCloudProject,
  selectedProject,
  selectedProjectLinkedOpenPondApp,
  selectedSession,
  sessions,
  workspaceTarget,
  setDraftModel,
  setDraftProvider,
  setError,
  setPrompt,
  setMentionedAppId,
  setCodexHistoryEvents,
  setCodexHistorySessions,
  onCodexHistoryTurnPayload,
  onPendingUserMessage,
  onClearPendingUserMessage,
  setEvents,
  setSelectedAppId,
  setSelectedProjectId,
  setSelectedSessionId,
  setSessions,
  setView,
  setWorkspaceBusy,
}: UseChatActionsInput) {
  const activeTurnSessionIdsRef = useRef<Set<string>>(new Set());
  const providerSettings = bootstrap?.providers ?? null;

  function commandAccessModeForProvider(provider: ChatProvider, mode: OpenPondCommandAccessMode) {
    return provider === "codex" ? undefined : mode;
  }

  function isDirectCommandSession(session: Session | null | undefined): session is Session {
    return Boolean(
      session &&
        session.provider !== "codex" &&
        (
          (session.workspaceKind === "local_project" && session.cwd?.trim()) ||
          (
            (session.workspaceKind === "sandbox" ||
              session.workspaceKind === "sandbox_template" ||
              session.workspaceKind === "sandbox_app") &&
            session.workspaceId
          )
        ),
    );
  }

  function changeDraftProvider(provider: ChatProvider) {
    setDraftProvider(provider);
    setDraftModel((current) => normalizeChatModel(provider, current, providerSettings));
    setSelectedSessionId(null);
    setView("chat");
  }

  async function sandboxAgentForProject(projectId: string, teamId: string): Promise<SandboxAgent | null> {
    const cachedAgents = readSandboxAgentsFromMemory(teamId, accountScopeKey);
    const agents =
      cachedAgents ??
      (await preloadSandboxAgents({
        teamId,
        accountKey: accountScopeKey,
        fetchAgents: async (nextTeamId) => {
          const agentsPayload = await api.listSandboxAgents(connection!, { teamId: nextTeamId });
          return agentsPayload.agents;
        },
      }));
    return agents.find((agent) => agent.projectId === projectId) ?? null;
  }

  async function resolveSyncCloudOrganization(): Promise<OpenPondOrganization> {
    if (!connection) throw new Error("OpenPond App server is not connected.");
    if (bootstrap?.account.state !== "signed_in") {
      throw new Error("Add an OpenPond account before syncing a Project to Cloud.");
    }
    const organizationPayload = await api.organizations(connection);
    const organization = implicitOrganization(
      organizationPayload.organizations
        .map(normalizeOpenPondOrganization)
        .filter((candidate): candidate is OpenPondOrganization => Boolean(candidate))
        .filter((candidate) => candidate.status === "active"),
      bootstrap?.preferences.defaultTeamId ?? null,
    );
    if (!organization) throw new Error("Add an OpenPond account before syncing a Project to Cloud.");
    if (!canManageOpenPondOrganization(organization)) {
      throw new Error(`You need owner or admin access to create projects in ${organization.displayName}.`);
    }
    return organization;
  }

  async function runSyncCloudCommand(input: {
    clearPromptForTurn: () => void;
    displayPrompt: string;
    onSessionCreated?: (session: Session) => void;
    selectSession: boolean;
  }): Promise<boolean> {
    if (!connection) return false;
    const project = selectedProject;
    if (!project) {
      throw new Error("Select a local Project before using /sync-cloud.");
    }
    const organization = await resolveSyncCloudOrganization();
    const branch = project.linkedSandboxProject?.defaultBranch?.trim() || "main";
    const projectKey = projectSelectionKey("local", project.id);
    const confirmedCloudProject = confirmedLinkedCloudProject(project, cloudProjects);
    const session = await api.createSession(connection, {
      provider: "openpond",
      modelRef: modelRefForTurn("openpond", DEFAULT_OPENPOND_CHAT_MODEL, providerSettings),
      openPondCommandAccessMode: commandAccessModeForProvider("openpond", openPondCommandAccessMode),
      appId: null,
      appName: null,
      workspaceKind: "local_project",
      workspaceId: project.id,
      workspaceName: project.name,
      localProjectId: project.id,
      cloudProjectId: confirmedCloudProject?.id ?? null,
      cloudTeamId: confirmedCloudProject?.teamId ?? null,
      cwd: project.workspacePath,
      title: `Sync ${project.name} to Cloud`,
    });
    setSessions((current) => [session, ...current]);
    input.onSessionCreated?.(session);
    if (input.selectSession) {
      setSelectedSessionId(session.id);
      setSelectedProjectId(projectKey);
      setSelectedAppId(null);
      setView("chat");
      expandProject(projectKey);
    }
    input.clearPromptForTurn();
    setWorkspaceBusy(true);
    try {
      const upload = await api.uploadLocalProjectCloudSource(connection, project.id, {
        teamId: organization.teamId,
        projectName: project.name,
        branch,
        chatSessionId: session.id,
        displayPrompt: input.displayPrompt,
      });
      applyBootstrapPayload(upload.bootstrap);
      expandProject(projectKey);
      expandProject(projectSelectionKey("cloud", upload.project.id));
      return true;
    } catch (syncError) {
      const payload = await api.bootstrap(connection).catch(() => null);
      if (payload) applyBootstrapPayload(payload);
      throw syncError;
    } finally {
      setWorkspaceBusy(false);
    }
  }

  async function runDirectCommand(input: {
    command: string;
    clearPromptForTurn: () => void;
    modelForTurnValue: string;
    onSessionCreated?: (session: Session) => void;
    openPondCommandAccessModeForTurn: OpenPondCommandAccessMode;
    providerForTurn: ChatProvider;
    selectedSessionForTurn: Session | null;
    selectSession: boolean;
  }): Promise<boolean> {
    if (!connection) return false;
    if (input.providerForTurn === "codex" || input.selectedSessionForTurn?.provider === "codex") {
      return false;
    }

    let session = isDirectCommandSession(input.selectedSessionForTurn)
      ? input.selectedSessionForTurn
      : null;
    if (!session && input.selectedSessionForTurn) {
      throw new Error("Select a project to use this.");
    }
    if (!session) {
      if (selectedCloudProject) {
        const projectKey = projectSelectionKey("cloud", selectedCloudProject.id);
        const sessionProvider = input.providerForTurn;
        session = await api.createSession(connection, {
          provider: sessionProvider,
          modelRef: modelRefForTurn(sessionProvider, input.modelForTurnValue, providerSettings),
          openPondCommandAccessMode: commandAccessModeForProvider(
            sessionProvider,
            input.openPondCommandAccessModeForTurn,
          ),
          appId: null,
          appName: null,
          workspaceKind: "sandbox",
          workspaceId: selectedCloudProject.id,
          workspaceName: selectedCloudProject.name,
          localProjectId: null,
          cloudProjectId: selectedCloudProject.id,
          cloudTeamId: selectedCloudProject.teamId,
          cwd: null,
          title: input.command.slice(0, 64),
        });
        setSessions((current) => [session!, ...current]);
        input.onSessionCreated?.(session);
        if (input.selectSession) {
          setSelectedSessionId(session.id);
          setSelectedProjectId(projectKey);
          setSelectedAppId(null);
          setView("chat");
          expandProject(projectKey);
        }
      } else {
        const project = selectedProject;
        if (!project) {
          throw new Error("Select a project to use this.");
        }
        const confirmedCloudProject = confirmedLinkedCloudProject(project, cloudProjects);
        const projectKey = projectSelectionKey("local", project.id);
        const sessionProvider = input.providerForTurn;
        session = await api.createSession(connection, {
          provider: sessionProvider,
          modelRef: modelRefForTurn(sessionProvider, input.modelForTurnValue, providerSettings),
          openPondCommandAccessMode: commandAccessModeForProvider(
            sessionProvider,
            input.openPondCommandAccessModeForTurn,
          ),
          appId: null,
          appName: null,
          workspaceKind: "local_project",
          workspaceId: project.id,
          workspaceName: project.name,
          localProjectId: project.id,
          cloudProjectId: confirmedCloudProject?.id ?? null,
          cloudTeamId: confirmedCloudProject?.teamId ?? null,
          cwd: project.workspacePath,
          title: input.command.slice(0, 64),
        });
        setSessions((current) => [session!, ...current]);
        input.onSessionCreated?.(session);
        if (input.selectSession) {
          setSelectedSessionId(session.id);
          setSelectedProjectId(projectKey);
          setSelectedAppId(null);
          setView("chat");
          expandProject(projectKey);
        }
      }
    }
    if (!session) {
      throw new Error("Select a project to use this.");
    }

    input.clearPromptForTurn();
    const payload = await api.runSessionCommand(connection, session.id, {
      command: input.command,
      cwd: session.cwd,
    });
    setSessions((current) => upsertSessionPreservingLocalSidebarState(current, payload.session));
    setEvents((current) => mergeRuntimeEventLists(current, payload.events));
    return true;
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
    const openPondCommandAccessModeForTurn = options.openPondCommandAccessMode ?? openPondCommandAccessMode;
    const explicitTurnContext = options.session !== undefined;
    const selectedSessionForTurn = explicitTurnContext ? options.session ?? null : selectedSession;
    const selectedAppForTurn = explicitTurnContext ? null : selectedApp;
    const selectedProjectForTurn = explicitTurnContext ? null : selectedProject;
    const selectedCloudProjectForTurn = explicitTurnContext ? null : selectedCloudProject;
    const selectedProjectLinkedOpenPondAppForTurn = explicitTurnContext ? null : selectedProjectLinkedOpenPondApp;
    const hybridTargetForTurn = !explicitTurnContext && workspaceTarget === "hybrid";
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
    const directCommandForTurn = selectedActionForTurn ? null : parseComposerDirectCommandPrompt(value);
    const parsedSlashCommandForTurn =
      selectedActionForTurn || directCommandForTurn ? null : parseComposerSlashCommandPrompt(value);
    const usageAttributionForTurn = options.usageAttribution ?? (
      parsedSlashCommandForTurn
        ? {
            surface: "chat" as const,
            workflowKind: "slash_command" as const,
            commandName: `/${parsedSlashCommandForTurn.command}`,
            commandSource: "prompt_parse" as const,
          }
        : undefined
    );
    setError(null);
    let turnSessionId: string | null = null;
    let pendingUserMessage: PendingChatUserMessage | null = null;
    try {
      if (directCommandForTurn && providerForTurn !== "codex" && selectedSessionForTurn?.provider !== "codex") {
        if (attachments.length > 0) {
          throw new Error("Direct commands do not accept attachments.");
        }
        return await runDirectCommand({
          command: directCommandForTurn.command,
          clearPromptForTurn,
          modelForTurnValue,
          onSessionCreated: options.onSessionCreated,
          openPondCommandAccessModeForTurn,
          providerForTurn,
          selectedSessionForTurn,
          selectSession: shouldSelectSession,
        });
      }
      if (!explicitTurnContext && parsedSlashCommandForTurn?.command === "sync-cloud") {
        return await runSyncCloudCommand({
          clearPromptForTurn,
          displayPrompt: displayPromptForTurn,
          onSessionCreated: options.onSessionCreated,
          selectSession: shouldSelectSession,
        });
      }
      if (selectedActionForTurn) {
          const selectedAgent = openPondAgentSlashCommandInfo(selectedActionForTurn);
          if (selectedAgent) {
            let session = selectedSessionForTurn;
            if (!session || session.cloudProjectId !== selectedAgent.projectId) {
              session = await api.createSession(connection, {
                provider: "openpond",
                modelRef: modelRefForTurn("openpond", modelForTurnValue, providerSettings),
                openPondCommandAccessMode: commandAccessModeForProvider("openpond", openPondCommandAccessModeForTurn),
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
          setEvents((current) =>
            mergeRuntimeEventLists(
              current,
              directActionRunEvents({
                action: selectedActionForTurn,
                prompt: displayPromptForTurn,
                runPayload,
                sessionId: session!.id,
              }),
            ),
          );
          return true;
        }

        const selectedProfileAction = openPondProfileActionInfo(selectedActionForTurn);
        if (selectedProfileAction) {
          let session = selectedSessionForTurn;
          if (!session || session.provider !== "openpond") {
            session = await api.createSession(connection, {
              provider: "openpond",
              modelRef: modelRefForTurn("openpond", modelForTurnValue, providerSettings),
              openPondCommandAccessMode: commandAccessModeForProvider("openpond", openPondCommandAccessModeForTurn),
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

        const actionProjectTarget = openPondActionProjectTarget({
          cloudProjects,
          selectedCloudProject,
          selectedProject,
        });
        if (!actionProjectTarget) {
          throw new Error("Select a Project linked to an OpenPond Cloud Project before running an action.");
        }
        let session = selectedSessionForTurn;
        if (!session || session.cloudProjectId !== actionProjectTarget.id) {
          session = await api.createSession(connection, {
            provider: "openpond",
            modelRef: modelRefForTurn("openpond", modelForTurnValue, providerSettings),
            openPondCommandAccessMode: commandAccessModeForProvider("openpond", openPondCommandAccessModeForTurn),
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
        setEvents((current) =>
          mergeRuntimeEventLists(
            current,
            directActionRunEvents({
              action: selectedActionForTurn,
              prompt: displayPromptForTurn,
              runPayload,
              sessionId: session!.id,
            }),
          ),
        );
        return true;
      }
      let session = selectedSessionForTurn;
      if (session && isCodexHistorySessionId(session.id)) {
        clearPromptForTurn();
        turnSessionId = session.id;
        activeTurnSessionIdsRef.current.add(turnSessionId);
        const optimisticStartedEvent = optimisticCodexHistoryTurnStartedEvent(session.id, value);
        const applyOptimisticEvent = (event: RuntimeEvent) => {
          if (!explicitTurnContext || selectedSession?.id === session!.id) {
            setCodexHistoryEvents((current) => appendRuntimeEventIfMissing(current, event));
          }
          options.onCodexHistoryOptimisticEvent?.(event);
        };
        applyOptimisticEvent(optimisticStartedEvent);
        setCodexHistorySessions((current) =>
          current.map((candidate) =>
            candidate.id === session!.id ? { ...candidate, status: "active" } : candidate
          )
        );
        const payload = await api
          .sendCodexHistoryTurn(connection, session.id, {
            prompt: value,
            attachments: attachments.length > 0 ? attachments : undefined,
            model: modelForTurn("codex", modelForTurnValue, providerSettings),
            modelRef: modelRefForTurn("codex", modelForTurnValue, providerSettings),
            ...codexPermissionTurnInput(codexPermissionMode),
            codexPermissionMode,
            codexReasoningEffort,
          })
          .catch((codexHistoryError) => {
            applyOptimisticEvent(optimisticCodexHistoryTurnFailedEvent(optimisticStartedEvent, codexHistoryError));
            throw codexHistoryError;
          });
        if (!explicitTurnContext || selectedSession?.id === session.id) {
          setCodexHistoryEvents(payload.events);
        }
        setCodexHistorySessions((current) =>
          upsertSessionPreservingLocalSidebarState(current, payload.session),
        );
        onCodexHistoryTurnPayload?.(payload);
        return true;
      }
      const selectedMentionedSandboxApp = mentionedAppIdForTurn
        ? apps.find((app) => app.id === mentionedAppIdForTurn && promptContainsChatAppMention(promptForTurn, app) && app.sandbox) ?? null
        : null;
      const mentionedSandboxApp =
        selectedMentionedSandboxApp ?? resolveMentionedSandboxChatApp(promptForTurn, sandboxMentionApps(apps));
      const mentionedConnectedApps = resolveMentionedConnectedApps(promptForTurn, connectedAppMentions)
        .map((option) => option.ref);
      if (!session) {
        const sessionAppId = selectedProjectLinkedOpenPondAppForTurn?.appId ?? selectedAppForTurn?.id ?? null;
        const sessionAppName = selectedProjectLinkedOpenPondAppForTurn?.appName ?? selectedAppForTurn?.name ?? null;
        const cloudProject = selectedCloudProjectForTurn;
        const confirmedCloudProject = explicitTurnContext
          ? null
          : confirmedLinkedCloudProject(selectedProjectForTurn, cloudProjects);
        const hybridWorkspaceTarget = hybridTargetForTurn
          ? resolveHybridWorkspaceTarget({
              cloudProjects,
              selectedCloudProject: cloudProject,
              selectedProject: selectedProjectForTurn,
            })
          : null;
        if (hybridWorkspaceTarget?.kind === "missing_cloud_project") {
          throw new Error(hybridWorkspaceTarget.message);
        }
        const useHybridWorkspace = hybridWorkspaceTarget?.kind === "ready";
        const sessionProvider = useHybridWorkspace ? providerForTurn : cloudProject ? "openpond" : providerForTurn;
        const sessionModelRef = modelRefForTurn(sessionProvider, modelForTurnValue, providerSettings);
        const sessionCommandAccessMode = commandAccessModeForProvider(
          sessionProvider,
          openPondCommandAccessModeForTurn,
        );
        session = await api.createSession(
          connection,
          useHybridWorkspace
            ? {
                ...buildHybridWorkspaceSessionRequest({
                  modelRef: sessionModelRef,
                  provider: sessionProvider,
                  target: hybridWorkspaceTarget,
                  title: value.slice(0, 64),
                }),
                ...(sessionCommandAccessMode ? { openPondCommandAccessMode: sessionCommandAccessMode } : {}),
              }
            : {
                provider: sessionProvider,
                modelRef: sessionModelRef,
                ...(sessionCommandAccessMode ? { openPondCommandAccessMode: sessionCommandAccessMode } : {}),
                appId: sessionAppId,
                appName: sessionAppName,
                workspaceKind: cloudProject
                  ? "sandbox"
                  : selectedProjectForTurn
                    ? "local_project"
                    : selectedAppForTurn
                      ? "sandbox_app"
                      : undefined,
                workspaceId: selectedProjectForTurn?.id ?? (selectedAppForTurn ? sessionAppId : undefined),
                workspaceName: cloudProject?.name ?? selectedProjectForTurn?.name ?? sessionAppName,
                localProjectId: selectedProjectForTurn?.id ?? null,
                cloudProjectId: cloudProject?.id ?? confirmedCloudProject?.id ?? null,
                cloudTeamId: cloudProject?.teamId ?? confirmedCloudProject?.teamId ?? null,
                cwd: selectedProjectForTurn ? selectedProjectForTurn.workspacePath : null,
                title: value.slice(0, 64),
              },
        );
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
      if (isCloudWorkspaceKind(session.workspaceKind) && session.provider !== "openpond" && !isHybridWorkspaceSession(session)) {
        throw new Error("Cloud workspaces use OpenPond Chat. Switch to Local to use local providers.");
      }
      if (isCloudWorkspaceKind(session.workspaceKind) && ensureCloudSessionReady) {
        try {
          session = await ensureCloudSessionReady(session);
        } catch (preflightError) {
          const message = preflightError instanceof Error ? preflightError.message : String(preflightError);
          await api
            .recordPreflightTurnFailure(connection, session.id, {
              prompt: value,
              error: message,
              target: isHybridWorkspaceSession(session) ? "hybrid_sandbox" : "cloud_workspace",
            })
            .then(applyBootstrapPayload)
            .catch(() => undefined);
          throw preflightError;
        }
      }
      const parsedCreatePipelineCommand = parsedSlashCommandForTurn;
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
      pendingUserMessage = createPendingUserChatMessage({
        afterMessageId: turnChatMessages.at(-1)?.id ?? null,
        attachments,
        content: value,
        sessionId: session.id,
      });
      clearPromptForTurn();
      turnSessionId = session.id;
      activeTurnSessionIdsRef.current.add(turnSessionId);
      onPendingUserMessage?.(pendingUserMessage);
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
        mentionedConnectedApps: mentionedConnectedApps.length > 0 ? mentionedConnectedApps : undefined,
        openPondActionCatalog:
          openPondActionCatalog.length > 0 ? openPondActionCatalog : undefined,
        createPipelineRequest,
        usageAttribution: usageAttributionForTurn,
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
      if (pendingUserMessage) {
        onClearPendingUserMessage?.(pendingUserMessage.sessionId, pendingUserMessage.id);
      }
      setError(sendError instanceof Error ? sendError.message : String(sendError));
      return false;
    } finally {
      if (turnSessionId) activeTurnSessionIdsRef.current.delete(turnSessionId);
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
    }
  }

  async function stopTurn(sessionId?: string | null): Promise<boolean> {
    const fallbackActiveSessionId = activeTurnSessionIdsRef.current.values().next().value ?? null;
    const activeSessionId = sessionId ?? selectedSession?.id ?? fallbackActiveSessionId;
    if (!connection || !activeSessionId) return false;
    setError(null);
    if (isCodexHistorySessionId(activeSessionId)) {
      try {
        const result = await api.interruptCodexHistoryTurn(connection, activeSessionId);
        if (!result.interrupted) {
          if (result.reason === "no_active_openpond_turn") {
            const payload = await api.codexHistoryThread(connection, activeSessionId, { tail: true });
            const session = { ...payload.session, status: "idle" as const };
            if (selectedSession?.id === activeSessionId) setCodexHistoryEvents(payload.events);
            setCodexHistorySessions((current) =>
              upsertSessionPreservingLocalSidebarState(current, session),
            );
            setError(
              "OpenPond no longer has a live interrupt handle for this Codex history turn. The chat was marked idle so you can send again.",
            );
            return true;
          }
          setError("This Codex history turn is still starting. Try stopping it again in a moment.");
          return false;
        }
        const payload = await api.codexHistoryThread(connection, activeSessionId, { tail: true });
        if (selectedSession?.id === activeSessionId) setCodexHistoryEvents(payload.events);
        setCodexHistorySessions((current) =>
          upsertSessionPreservingLocalSidebarState(current, payload.session),
        );
        return true;
      } catch (stopError) {
        const message = stopError instanceof Error ? stopError.message : String(stopError);
        setError(
          message === "Not found"
            ? "OpenPond could not find this Codex history session, so it cannot interrupt it here."
            : message,
        );
        return false;
      }
    }
    try {
      await api.interruptTurn(connection, activeSessionId);
      const payload = await api.bootstrap(connection);
      applyBootstrapPayload(payload);
      return true;
    } catch (stopError) {
      setError(stopError instanceof Error ? stopError.message : String(stopError));
      return false;
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
