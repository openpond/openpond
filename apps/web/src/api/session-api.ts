import type {
  BootstrapPayload,
  CompactSessionRequest,
  EnsureCloudWorkspaceReadyRequest,
  EnsureCloudWorkspaceReadyResponse,
  RecordPreflightTurnFailureRequest,
  RunSessionCommandRequest,
  RuntimeEvent,
  SendTurnRequest,
  Session,
  Turn,
  UpdateTurnCreatePipelineRequest,
  WorkspaceToolRequest,
  WorkspaceToolResult,
} from "@openpond/contracts";
import { apiFetch, type ClientConnection } from "./api-client";

export const sessionApi = {
  sendTurn: (connection: ClientConnection, sessionId: string, input: SendTurnRequest) =>
    apiFetch<Turn>(connection, `/v1/sessions/${sessionId}/turns`, {
      method: "POST",
      body: JSON.stringify(input),
    }),
  runSessionCommand: (
    connection: ClientConnection,
    sessionId: string,
    input: RunSessionCommandRequest,
  ) =>
    apiFetch<{ session: Session; events: RuntimeEvent[]; result: unknown }>(
      connection,
      `/v1/sessions/${encodeURIComponent(sessionId)}/commands`,
      { method: "POST", body: JSON.stringify(input) },
    ),
  recordPreflightTurnFailure: (
    connection: ClientConnection,
    sessionId: string,
    input: RecordPreflightTurnFailureRequest,
  ) =>
    apiFetch<BootstrapPayload>(connection, `/v1/sessions/${sessionId}/preflight-turns/failure`, {
      method: "POST",
      body: JSON.stringify(input),
    }),
  updateTurnCreatePipeline: (
    connection: ClientConnection,
    sessionId: string,
    turnId: string,
    input: UpdateTurnCreatePipelineRequest,
  ) =>
    apiFetch<Turn>(
      connection,
      `/v1/sessions/${encodeURIComponent(sessionId)}/turns/${encodeURIComponent(turnId)}/create-pipeline`,
      { method: "POST", body: JSON.stringify(input) },
    ),
  interruptTurn: (connection: ClientConnection, sessionId: string) =>
    apiFetch<Turn>(connection, `/v1/sessions/${sessionId}/turns/interrupt`, { method: "POST" }),
  pauseGoal: (connection: ClientConnection, sessionId: string) =>
    apiFetch<unknown>(connection, `/v1/sessions/${encodeURIComponent(sessionId)}/goals/pause`, { method: "POST" }),
  compactSession: (
    connection: ClientConnection,
    sessionId: string,
    input: CompactSessionRequest = { reason: "manual" },
  ) =>
    apiFetch<unknown>(connection, `/v1/sessions/${sessionId}/compact`, {
      method: "POST",
      body: JSON.stringify(input),
    }),
  workspaceTool: (connection: ClientConnection, sessionId: string, input: WorkspaceToolRequest) =>
    apiFetch<WorkspaceToolResult>(connection, `/v1/sessions/${sessionId}/workspace-tools`, {
      method: "POST",
      body: JSON.stringify(input),
    }),
  ensureCloudWorkspaceReady: (
    connection: ClientConnection,
    sessionId: string,
    input: EnsureCloudWorkspaceReadyRequest,
  ) =>
    apiFetch<EnsureCloudWorkspaceReadyResponse>(
      connection,
      `/v1/sessions/${encodeURIComponent(sessionId)}/workspace/ensure-ready`,
      { method: "POST", body: JSON.stringify(input) },
    ),
};
