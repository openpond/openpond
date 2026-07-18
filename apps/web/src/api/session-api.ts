import type {
  BootstrapPayload,
  CompactSessionRequest,
  CreateImproveRun,
  CreateImproveRunAction,
  CreateImproveRunListResponse,
  EnsureCloudWorkspaceReadyRequest,
  EnsureCloudWorkspaceReadyResponse,
  RecordPreflightTurnFailureRequest,
  RunSessionCommandRequest,
  RuntimeEvent,
  SendTurnRequest,
  Session,
  Turn,
  WorkspaceDiffSummary,
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
  listCreateImproveRuns: (
    connection: ClientConnection,
    query: {
      profileId?: string | null;
      conversationId?: string | null;
      targetKind?: CreateImproveRun["target"]["kind"] | null;
      targetId?: string | null;
      limit?: number;
    } = {},
  ) =>
    apiFetch<CreateImproveRunListResponse>(
      connection,
      `/v1/create-improve-runs?${createImproveQuery(query).toString()}`,
    ),
  getCreateImproveRun: (connection: ClientConnection, runId: string) =>
    apiFetch<CreateImproveRun>(
      connection,
      `/v1/create-improve-runs/${encodeURIComponent(runId)}`,
    ),
  getCreateImproveCandidateDiff: (
    connection: ClientConnection,
    runId: string,
    candidateId: string,
  ) =>
    apiFetch<WorkspaceDiffSummary>(
      connection,
      `/v1/create-improve-runs/${encodeURIComponent(runId)}/candidates/${encodeURIComponent(candidateId)}/diff`,
    ),
  applyCreateImproveAction: (
    connection: ClientConnection,
    runId: string,
    input: CreateImproveRunAction,
  ) =>
    apiFetch<CreateImproveRun>(
      connection,
      `/v1/create-improve-runs/${encodeURIComponent(runId)}/actions`,
      { method: "POST", body: JSON.stringify(input) },
    ),
  interruptTurn: (connection: ClientConnection, sessionId: string) =>
    apiFetch<Turn>(connection, `/v1/sessions/${sessionId}/turns/interrupt`, { method: "POST" }),
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

function createImproveQuery(query: {
  profileId?: string | null;
  conversationId?: string | null;
  targetKind?: CreateImproveRun["target"]["kind"] | null;
  targetId?: string | null;
  limit?: number;
}): URLSearchParams {
  const params = new URLSearchParams();
  if (query.profileId) params.set("profileId", query.profileId);
  if (query.conversationId) params.set("conversationId", query.conversationId);
  if (query.targetKind) params.set("targetKind", query.targetKind);
  if (query.targetId) params.set("targetId", query.targetId);
  if (query.limit) params.set("limit", String(query.limit));
  return params;
}
