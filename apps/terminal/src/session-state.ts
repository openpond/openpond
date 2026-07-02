import type {
  BootstrapPayload,
  ChatProvider,
  Session,
} from "@openpond/contracts";
import { apiFetch } from "./connection.js";
import { activeModelRef, type TerminalModelSelection } from "./formatting.js";
import { resolveTerminalProjectTarget } from "./projects.js";

export type TerminalSessionConnection = {
  server: string;
  token: string;
};

export type TerminalSessionOptions = TerminalModelSelection & {
  cwd: string;
  project: string | null;
};

export type TerminalSessionState = TerminalModelSelection & {
  sessionId: string;
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
  const provider = target?.provider ?? options.provider;
  const sessionOptions = { ...options, provider };
  const body = {
    provider,
    modelRef: activeModelRef(sessionOptions, payload.providers),
    title: target?.label ? `${target.label} terminal` : "Terminal chat",
    ...(target
      ? target.session
      : {
          appId: options.project,
          appName: null,
          cwd: options.cwd,
        }),
  };
  return apiFetch<Session>(connection.server, connection.token, "/v1/sessions", {
    method: "POST",
    body: JSON.stringify(body),
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
    return {
      sessionId: requestedSessionId,
      ...selection,
    };
  }
  const session = await createTerminalChatSession(connection, payload, {
    ...options,
    ...selection,
  });
  return {
    sessionId: session.id,
    ...selection,
  };
}
