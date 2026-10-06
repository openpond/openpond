import type { RuntimeEvent } from "@openpond/contracts";
import type { AttemptReceipt, GraderEvidence } from "@openpond/evals";
import { apiFetch, type ClientConnection } from "./api-client";
import type { ProfileEvaluationDiscovery } from "../api";

export type ProfileEvaluationHistory = Pick<ProfileEvaluationDiscovery, "profileRef" | "runs" | "comparisons" | "suiteRuns" | "reports">;

export function loadProfileEvaluationHistory(connection: ClientConnection) {
  return apiFetch<ProfileEvaluationHistory>(connection, "/v1/profile/evaluations/discover", {
    method: "POST", body: JSON.stringify({ view: "history" }),
  });
}

export type ProfileEvaluationCaseInspection = {
  taskId: string;
  seed: string;
  receiptId: string;
  score: number | null;
  passed: boolean;
  gradingStatus: string;
  failureClass: string | null;
  latencyMs: number;
  costUsd: number | null;
  feedback: Array<Pick<GraderEvidence, "graderId" | "graderVersion" | "score" | "passed" | "feedback">>;
  receipt?: AttemptReceipt;
  evidence?: {
    prompt: string;
    output: { text: string } | null;
    partialOutput: { text: string } | null;
    error: string | null;
    events: RuntimeEvent[];
    eventCount: number;
    nextEventCursor: string | null;
  } | null;
};

export function inspectProfileEvaluation(connection: ClientConnection, request: {
  runId: string;
  receiptId?: string;
  eventAfterId?: string;
}, signal?: AbortSignal) {
  return apiFetch<{ runId: string; sourceRevision: string | null; cases: ProfileEvaluationCaseInspection[] }>(
    connection, "/v1/profile/evaluations/discover", {
      method: "POST", body: JSON.stringify(request), signal,
    },
  );
}
