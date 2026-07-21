import { useCallback } from "react";
import type {
  BootstrapPayload,
  ChatModelRef,
  ChatProvider,
  CodexPermissionMode,
  CodexReasoningEffort,
  Session,
} from "@openpond/contracts";
import { api, type ClientConnection } from "../api";
import { modelRefForTurn } from "../lib/app-models";

export function useLabAgentAuthoring(input: {
  activeModel: string;
  activeProvider: ChatProvider;
  bootstrap: BootstrapPayload | null;
  codexPermissionMode: CodexPermissionMode;
  codexReasoningEffort: CodexReasoningEffort;
  connection: ClientConnection | null;
  onOpenRightChatForSession: (sessionId: string, session?: Session) => void;
  onPayload: (payload: BootstrapPayload) => void;
}) {
  const {
    activeModel,
    activeProvider,
    bootstrap,
    codexPermissionMode,
    codexReasoningEffort,
    connection,
    onOpenRightChatForSession,
    onPayload,
  } = input;

  const runAgentChangeFromLab = useCallback(async (request: {
    agentId?: string;
    agentName?: string | null;
    objective: string;
    operation: "create" | "improve";
    authoringRunId?: string | null;
    authoringModel?: ChatModelRef | null;
  }) => {
    if (!connection || !bootstrap) throw new Error("OpenPond is still connecting.");
    const profile = bootstrap.profile;
    if (profile.mode !== "local" || !profile.repoPath) {
      throw new Error("A local Git-backed Profile is required to change an Agent.");
    }
    const modelRef = request.authoringModel ?? modelRefForTurn(
      activeProvider,
      activeModel,
      bootstrap.providers,
    );
    if (!modelRef) throw new Error("Choose a model before changing an Agent.");
    const session = await api.createSession(connection, {
      provider: modelRef.providerId,
      modelRef,
      systemKind: "openpond.lab",
      hiddenFromDefaultSidebar: true,
      title: `${request.operation === "create" ? "New" : "Improve"} Agent · ${request.objective.slice(0, 80)}`,
      cwd: profile.repoPath,
      metadata: {
        source: request.operation === "create"
          ? "lab_agent_create"
          : "lab_agent_improve",
        profileId: profile.activeProfile ?? "default",
        targetAgentId: request.agentId ?? null,
      },
    });
    const authoringRun = request.authoringRunId
      ? await api.getCreateImproveRun(connection, request.authoringRunId)
      : null;
    const {
      buildLabAgentCreateImproveRun,
      buildLabAgentImproveRun,
      continueLabAgentRunFromTaskset,
    } = await import("../lib/create-pipeline-request");
    const run = authoringRun
      ? continueLabAgentRunFromTaskset({
          authoringRun,
          agentId: request.agentId,
          agentName: request.agentName,
          objective: request.objective,
          payload: bootstrap,
          session,
          operation: request.operation,
        })
      : request.operation === "create"
        ? buildLabAgentCreateImproveRun({
            objective: request.objective,
            payload: bootstrap,
            session,
          })
        : buildLabAgentImproveRun({
            agentId: request.agentId ?? "",
            agentName: request.agentName,
            objective: request.objective,
            payload: bootstrap,
            session,
          });
    if (!run) {
      throw new Error(
        request.operation === "create"
          ? "Describe what the Agent should do."
          : "Describe what the Agent could do better.",
      );
    }
    const turn = await api.sendTurn(connection, session.id, {
      prompt: request.objective,
      model: modelRef.modelId,
      modelRef,
      createImproveRun: run,
      approvalPolicy: "never",
      sandbox: "workspace-write",
      codexPermissionMode: modelRef.providerId === "codex"
        ? codexPermissionMode
        : "default",
      codexReasoningEffort,
    });
    if (turn.status === "failed") {
      throw new Error(turn.error ?? "OpenPond could not start the Agent improvement.");
    }
    const planned = turn.createImproveRun
      ?? await api.getCreateImproveRun(connection, run.id);
    if (!planned) throw new Error("The Agent plan was not created.");
    onPayload(await api.bootstrap(connection));
    onOpenRightChatForSession(session.id, session);
    return planned;
  }, [
    activeModel,
    activeProvider,
    bootstrap,
    codexPermissionMode,
    codexReasoningEffort,
    connection,
    onOpenRightChatForSession,
    onPayload,
  ]);

  const createAgentFromLab = useCallback(
    (
      objective: string,
      authoringRunId?: string | null,
      authoringModel?: ChatModelRef | null,
    ) => runAgentChangeFromLab({
      objective,
      operation: "create",
      authoringRunId,
      authoringModel,
    }),
    [runAgentChangeFromLab],
  );

  const improveAgentFromLab = useCallback(
    (
      agentId: string,
      objective: string,
      agentName?: string | null,
      authoringRunId?: string | null,
      authoringModel?: ChatModelRef | null,
    ) => runAgentChangeFromLab({
      agentId,
      agentName,
      objective,
      operation: "improve",
      authoringRunId,
      authoringModel,
    }),
    [runAgentChangeFromLab],
  );

  return { createAgentFromLab, improveAgentFromLab };
}
