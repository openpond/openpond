import { createCandidateEvaluationClient } from "openpond-sdk/candidate-evaluations";
import { parseAndVerifyTrainingResult } from "openpond-sdk/training";
import { apiFetch, type ClientConnection } from "../../api/api-client";

export function desktopCandidateEvaluationClient(connection: ClientConnection) {
  return createCandidateEvaluationClient((path, init) => apiFetch(connection, path, init));
}

export async function readCandidateTrainingResult(connection: ClientConnection, teamId: string, jobId: string, signal?: AbortSignal) {
  const result = await apiFetch(connection,
    `/v1/training/hosted-jobs/${encodeURIComponent(jobId)}/result?teamId=${encodeURIComponent(teamId)}`, { signal });
  return parseAndVerifyTrainingResult(result, { teamId, jobId });
}
