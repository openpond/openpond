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
    const objective = request.objective.trim();
    if (!objective) {
      throw new Error(
        request.operation === "create"
          ? "Describe what the Agent should do."
          : "Describe what the Agent could do better.",
      );
    }
    if (modelRef.providerId === "codex") {
      throw new Error("Agent authoring uses OpenPond's bundled authoring skill. Choose a hosted model.");
    }
    const prompt = request.operation === "create"
      ? `/agent create ${objective}`
      : `/agent improve ${request.agentId ?? ""} ${objective}`;
    const turn = await api.sendTurn(connection, session.id, {
      prompt,
      model: modelRef.modelId,
      modelRef,
      approvalPolicy: "never",
      sandbox: "workspace-write",
      codexPermissionMode: "default",
      codexReasoningEffort,
    });
    if (turn.status === "failed") {
      throw new Error(turn.error ?? "OpenPond could not complete the Agent authoring turn.");
    }
    onPayload(await api.bootstrap(connection));
    onOpenRightChatForSession(session.id, session);
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
