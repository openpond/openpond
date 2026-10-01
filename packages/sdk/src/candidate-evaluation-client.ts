import { contentHash } from "@openpond/harness";
import {
  CandidateEvaluationOptionsSchema,
  CandidateEvaluationRequestSchema,
  CandidateEvaluationPreparationSchema,
  CandidateEvaluationControlSchema,
  type CandidateEvaluationRequest,
} from "./candidate-evaluations.js";
export function createCandidateEvaluationClient(
  request: (path: string, init?: RequestInit) => Promise<unknown>,
) {
  const path = (id: string) => `/v1/training/candidate-evaluations/${encodeURIComponent(id)}`;
  function read(raw: unknown, teamId: string, id?: string) {
    const value = CandidateEvaluationPreparationSchema.parse(raw);
    if (value.teamId !== teamId || (id && value.id !== id))
      throw new Error("The preparation belongs to another workspace or candidate operation.");
    return value;
  }
  return {
    async options(teamId: string, query: { afterId?: string; projectId?: string } = {}) {
      const params = new URLSearchParams({ teamId, ...query }),
        value = CandidateEvaluationOptionsSchema.parse(
          await request(`/v1/training/candidates?${params}`),
        );
      if (value.teamId !== teamId)
        throw new Error("The candidate catalog belongs to another workspace.");
      return value;
    },
    async save(raw: CandidateEvaluationRequest) {
      const body = CandidateEvaluationRequestSchema.parse(raw),
        value = read(
          await request(
            `/v1/training/candidate-evaluations?teamId=${encodeURIComponent(body.teamId)}`,
            { method: "POST", body: JSON.stringify(body) },
          ),
          body.teamId,
        );
      if (value.requestHash !== contentHash(body))
        throw new Error(
          "The saved preparation differs from the selected candidate or frozen evaluation.",
        );
      return value;
    },
    async get(teamId: string, id: string) {
      return read(await request(`${path(id)}?teamId=${encodeURIComponent(teamId)}`), teamId, id);
    },
    async control(teamId: string, id: string, action: "prepare" | "run" | "cancel", raw: unknown) {
      const body = CandidateEvaluationControlSchema.parse(raw),
        value = read(
          await request(`${path(id)}/${action}?teamId=${encodeURIComponent(teamId)}`, {
            method: "POST",
            body: JSON.stringify(body),
          }),
          teamId,
          id,
        );
      if (value.requestHash !== body.requestHash)
        throw new Error("The command returned a different frozen evaluation.");
      return value;
    },
  };
}
