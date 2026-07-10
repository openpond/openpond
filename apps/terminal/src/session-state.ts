import type {
  BootstrapPayload,
  ChatProvider,
  CreateSessionRequest,
  EnsureCloudWorkspaceReadyResponse,
  Session,
} from "@openpond/contracts";
import type { TerminalApprovalPolicy, TerminalSandboxMode } from "./args.js";
import { realpath } from "node:fs/promises";
import path from "node:path";
import { apiFetch } from "./connection.js";
import { activeModelRef, type TerminalModelSelection } from "./formatting.js";
import { resolveTerminalProjectTarget } from "./projects.js";

export type TerminalSessionConnection = {
  server: string;
  token: string;
  signal?: AbortSignal;
};

export type TerminalSessionOptions = TerminalModelSelection & {
  cwd: string;
  cwdExplicit?: boolean;
  project: string | null;
  headless?: boolean;
  yes?: boolean;
  approvalPolicy?: TerminalApprovalPolicy;
  sandbox?: TerminalSandboxMode;
};

export type TerminalSessionState = TerminalModelSelection & {
  sessionId: string;
  session: Session | null;
};

export function profileLabel(payload: BootstrapPayload): string {
  if (payload.profile.mode !== "local") return "none";
  const name = payload.profile.activeProfile ?? "local";
  const state = payload.profile.summary.state === "ready" ? "" : `:${payload.profile.summary.state}`;
  return `${name}${state}`;
}

export function findTerminalSession(
  payload: BootstrapPayload,
  sessionId: string | null
): Session | null {
  if (!sessionId) return null;
  return (
    [...payload.sessions, ...(payload.codexHistorySessions ?? [])].find(
      (session) => session.id === sessionId
    ) ?? null
  );
}

export function resolveResumedTerminalSelection(
  payload: BootstrapPayload,
  sessionId: string | null,
  selection: TerminalModelSelection
): TerminalModelSelection {
  const resumed = findTerminalSession(payload, sessionId);
  if (resumed?.modelRef) {
    return {
      provider: resumed.modelRef.providerId as ChatProvider,
      model: resumed.modelRef.modelId,
    };
  }
  if (resumed?.provider) {
    return {
      ...selection,
      provider: resumed.provider,
    };
  }
  return selection;
}

export async function createTerminalChatSession(
  connection: TerminalSessionConnection,
  payload: BootstrapPayload,
  options: TerminalSessionOptions
): Promise<Session> {
  const target = resolveTerminalProjectTarget(payload, options.project);
  if (target && options.cwdExplicit) {
    if (target.kind !== "local_project" || !target.session.cwd) {
      throw new Error("--cwd can only be combined with a local --project target.");
    }
    await assertLocalProjectCwd(target.session.cwd, options.cwd);
  }
  const provider = target?.provider ?? options.provider;
  const sessionOptions = { ...options, provider };
  const targetSession: Partial<CreateSessionRequest> = target
    ? {
        ...target.session,
        ...(options.cwdExplicit ? { cwd: options.cwd } : {}),
      }
    : {
        appId: options.project,
        appName: null,
        cwd: options.cwd,
      };
  const metadata = {
    ...(targetSession.metadata ?? {}),
    ...(options.headless
      ? {
          openpondTerminalMode: "one-shot",
          openpondTerminal: {
            mode: "one-shot",
            sandbox: options.sandbox ?? null,
          },
        }
      : {}),
  };
  const body = {
    provider,
    modelRef: activeModelRef(sessionOptions, payload.providers),
    title: target?.label ? `${target.label} terminal` : "Terminal chat",
    ...targetSession,
    ...(Object.keys(metadata).length > 0 ? { metadata } : {}),
    ...(options.headless && (options.yes || options.approvalPolicy === "never")
      ? { openPondCommandAccessMode: "full-access" as const }
      : {}),
  };
  if (typeof targetSession.cwd === "string" && targetSession.cwd) {
    options.cwd = targetSession.cwd;
  }
  return apiFetch<Session>(connection.server, connection.token, "/v1/sessions", {
    method: "POST",
    body: JSON.stringify(body),
    signal: connection.signal,
  });
}

export async function ensureTerminalChatSession(
  connection: TerminalSessionConnection,
  payload: BootstrapPayload,
  options: TerminalSessionOptions,
  requestedSessionId: string | null
): Promise<TerminalSessionState> {
  const selection = resolveResumedTerminalSelection(payload, requestedSessionId, {
    provider: options.provider,
    model: options.model,
  });
  if (requestedSessionId) {
    if (options.cwdExplicit) {
      throw new Error("--cwd cannot be combined with --resume; the resumed session workspace is authoritative.");
    }
    const resumed = findTerminalSession(payload, requestedSessionId);
    if (resumed?.cwd) options.cwd = resumed.cwd;
    return {
      sessionId: requestedSessionId,
      session: resumed,
      ...selection,
    };
  }
  const session = await createTerminalChatSession(connection, payload, {
    ...options,
    ...selection,
  });
  return {
    sessionId: session.id,
    session,
    ...selection,
  };
}

export async function ensureTerminalSessionWorkspaceReady(
  connection: TerminalSessionConnection,
  session: Session | null,
): Promise<Session | null> {
  if (!session || (session.workspaceKind !== "sandbox" && session.workspaceKind !== "sandbox_template")) {
    return session;
  }
  const result = await apiFetch<EnsureCloudWorkspaceReadyResponse>(
    connection.server,
    connection.token,
    `/v1/sessions/${encodeURIComponent(session.id)}/workspace/ensure-ready`,
    {
      method: "POST",
      body: JSON.stringify({ surface: "terminal" }),
      signal: connection.signal,
    },
  );
  return result.session;
}

async function assertLocalProjectCwd(projectCwd: string, requestedCwd: string): Promise<void> {
  const [projectRoot, requested] = await Promise.all([realpath(projectCwd), realpath(requestedCwd)]);
  const relation = path.relative(projectRoot, requested);
  if (relation.startsWith("..") || path.isAbsolute(relation)) {
    throw new Error(`--cwd must be the selected local project or one of its subdirectories: ${projectRoot}`);
  }
}
