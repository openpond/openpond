import { createTaskCoordinationMcp } from "./task-inbox/codex-mcp.js";
import type { CodexTurnInput } from "./turns/ports.js";
import type {
  CodexPermissionMode,
  CodexReasoningEffort,
  CodexStatus,
  Session,
} from "@openpond/contracts";
import {
  CodexAppServerClient,
  type CodexNotification,
  type CodexServerRequest,
  type CodexServerRequestResult,
} from "@openpond/codex-provider";
import { VERSION } from "../constants.js";
import { loadPersonalizationSettings } from "../openpond/personalization.js";
import type { SqliteStore } from "../store/store.js";
import type { RuntimeCodexSession } from "../types.js";
import type { BackgroundWorkReceipt } from "./background-worker-queue.js";
import { event } from "../utils.js";

type CodexRuntimeInput = {
  appendRuntimeEvent: (runtimeEvent: ReturnType<typeof event>) => Promise<void>;
  codexSessions: Map<string, RuntimeCodexSession>;
  getCodexStatus: () => CodexStatus;
  handleCodexServerRequest: (sessionId: string, request: CodexServerRequest) => Promise<CodexServerRequestResult>;
  mapCodexNotification: (sessionId: string, notification: CodexNotification) => BackgroundWorkReceipt;
  optionsVersion?: string;
  setCodexStatus: (status: CodexStatus) => void;
  store: SqliteStore;
  storeDir: string;
  updateSession: (sessionId: string, patch: Partial<Session>) => Promise<Session>;
};

const CODEX_BASE_SESSION_CONFIG = {
  "tools.web_search": true,
  "tools.view_image": true,
  "features.web_search_request": true,
};

function codexSessionConfig(
  permissionMode: CodexPermissionMode,
  reasoningEffort?: CodexReasoningEffort | null,
): Record<string, unknown> {
  return {
    ...CODEX_BASE_SESSION_CONFIG,
    approvals_reviewer: permissionMode === "auto-review" ? "auto_review" : "user",
    ...(reasoningEffort ? { model_reasoning_effort: reasoningEffort } : {}),
  };
}

export function createCodexRuntimeManager({
  appendRuntimeEvent,
  codexSessions,
  getCodexStatus,
  handleCodexServerRequest,
  mapCodexNotification,
  optionsVersion,
  setCodexStatus,
  store,
  storeDir,
  updateSession,
}: CodexRuntimeInput) {
  const coordinationServers = new Map<string, Awaited<ReturnType<typeof createTaskCoordinationMcp>>>();
  async function ensureCodexRuntime(
    session: Session,
    turnInput: CodexTurnInput
  ): Promise<RuntimeCodexSession> {
    const existing = codexSessions.get(session.id);
    if (
      existing?.permissionMode === turnInput.codexPermissionMode &&
      existing.reasoningEffort === (turnInput.codexReasoningEffort ?? null) &&
      existing.cwd === session.cwd &&
      coordinationServers.has(session.id) === Boolean(turnInput.coordination)
    ) return existing;
    if (existing) {
      codexSessions.delete(session.id);
      await existing.client.stop().catch(() => undefined);
      await coordinationServers.get(session.id)?.close();
      coordinationServers.delete(session.id);
    }

    setCodexStatus({ ...getCodexStatus(), appServer: { status: "starting", lastError: null } });
    const client = new CodexAppServerClient({
      binaryPath: process.env.CODEX_BINARY || "codex",
      clientName: "openpond-app",
      clientTitle: "OpenPond App",
      clientVersion: optionsVersion ?? VERSION,
      onNotification: (notification) => {
        mapCodexNotification(session.id, notification);
      },
      onServerRequest: (request) => handleCodexServerRequest(session.id, request),
      stderr: (chunk) => {
        void appendRuntimeEvent(
          event({
            sessionId: session.id,
            name: "diagnostic",
            source: "provider",
            output: chunk.trim(),
          })
        );
      },
    });

    try {
      const coordination = turnInput.coordination ? await createTaskCoordinationMcp(turnInput.coordination) : null;
      if (coordination) coordinationServers.set(session.id, coordination);
      const config = { ...codexSessionConfig(turnInput.codexPermissionMode, turnInput.codexReasoningEffort),
        ...(coordination ? { "mcp_servers.openpond_task": coordination.config } : {}) };
      const personalization = await loadPersonalizationSettings(store, storeDir);
      const instructions = [
        personalization.soul,
        "You are running inside OpenPond App v1 app plumbing.",
        session.workspaceKind === "sandbox" || session.workspaceKind === "sandbox_template"
          ? "The selected workspace is a remote OpenPond sandbox. Use OpenPond App sandbox APIs for sandbox operations, snapshots, and replay artifacts; do not assume the local working directory is the sandbox filesystem."
          : "The selected local project uses the working directory as its source root.",
        "Conversations are stored by OpenPond App outside the repository.",
        "Do not use emojis in responses, generated prompts, templates, profile text, comments, or sample output unless the user explicitly asks for them.",
        (session.workspaceKind === "sandbox" || session.workspaceKind === "sandbox_template") && session.workspaceId
          ? `Selected sandbox id: ${session.workspaceId}.`
          : "",
        session.appId ? `Selected app id: ${session.appId}.` : "No OpenPond app is selected.",
        session.appName ? `Selected app name: ${session.appName}.` : "",
        "Do not print OpenPond or Codex secrets.",
      ]
        .filter(Boolean)
        .join("\n");

      const thread = session.codexThreadId
        ? await client.resumeThread({
            threadId: session.codexThreadId,
            cwd: session.cwd,
            approvalPolicy: turnInput.approvalPolicy,
            sandbox: turnInput.sandbox,
            config,
          })
        : await client.startThread({
            cwd: session.cwd,
            model: turnInput.model,
            approvalPolicy: turnInput.approvalPolicy,
            sandbox: turnInput.sandbox,
            config,
            developerInstructions: instructions,
          });
      await updateSession(session.id, { codexThreadId: thread.threadId });
      const runtime = {
        client,
        threadId: thread.threadId,
        cwd: session.cwd,
        permissionMode: turnInput.codexPermissionMode,
        reasoningEffort: turnInput.codexReasoningEffort ?? null,
      };
      codexSessions.set(session.id, runtime);
      setCodexStatus({ ...getCodexStatus(), appServer: { status: "ready", lastError: null } });
      return runtime;
    } catch (error) {
      await client.stop().catch(() => undefined);
      await coordinationServers.get(session.id)?.close();
      coordinationServers.delete(session.id);
      setCodexStatus({
        ...getCodexStatus(),
        appServer: {
          status: "error",
          lastError: error instanceof Error ? error.message : String(error),
        },
      });
      throw error;
    }
  }

  return { ensureCodexRuntime, closeCoordination: async () => {
    await Promise.all([...coordinationServers.values()].map((server) => server.close()));
    coordinationServers.clear();
  } };
}
