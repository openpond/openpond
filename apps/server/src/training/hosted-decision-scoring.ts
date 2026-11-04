import { z } from "zod";
import { createTrainingClient, DecisionModelScoreRequestSchema, type DecisionModelScoreRequest } from "openpond-sdk/training";
import { ActivationExperimentAccountSchema } from "@openpond/contracts";
import { hostedApiAuthHeaders } from "../openpond/hosted-api-access.js";
import { HostedDecisionExecutionError } from "./hosted-decision-executions.js";

export const HostedDecisionScoringEnvelopeSchema = ActivationExperimentAccountSchema.extend({
  projectId: z.string().trim().min(1).max(240).nullable(),
  modelProjectId: z.string().trim().min(1).max(240),
  command: DecisionModelScoreRequestSchema, intentHash: z.string().regex(/^[a-f0-9]{64}$/),
}).strict();

/** Uses the same configured account and reviewed operation as training. A
 * transport retry retains requestId; the hosted owner reconciles its receipt. */
export function createHostedDecisionScoring(input: {
  teamId: string; actorId: string; access: {apiBaseUrl: string; token: string};
  currentIdentity: () => Promise<{teamId: string; actorId: string; apiOrigin: string}>;
  assertRetained: (command: {modelProjectId: string; request: DecisionModelScoreRequest}, intentHash: string, projectId: string | null) => Promise<void>;
}) {
  const origin = new URL(input.access.apiBaseUrl).origin;
  async function fence() {
    const current = await input.currentIdentity();
    if (current.teamId !== input.teamId || current.actorId !== input.actorId || new URL(current.apiOrigin).origin !== origin)
      throw new HostedDecisionExecutionError("decision_score_account_changed", "Recover this score in its original configured account.");
  }
  const headers = hostedApiAuthHeaders(input.access.token); headers.set("x-openpond-team-id", input.teamId);
  const training = createTrainingClient({baseUrl: input.access.apiBaseUrl, headers, fetch: async (url, init) => {
    await fence();
    const response = await fetch(url, {...init, signal: AbortSignal.any([AbortSignal.timeout(330_000), ...(init?.signal ? [init.signal] : [])])});
    await fence(); return response;
  }});
  return {async perform(raw: unknown) {
    const body = HostedDecisionScoringEnvelopeSchema.parse(raw);
    if (body.teamId !== input.teamId || body.actorId !== input.actorId || body.apiOrigin !== origin || body.command.teamId !== body.teamId)
      throw new HostedDecisionExecutionError("decision_score_account_changed", "Score this exact Model in its original account and workspace.");
    await fence();
    await input.assertRetained({modelProjectId: body.modelProjectId, request: body.command}, body.intentHash, body.projectId);
    await fence();
    const receipt = await training.scoreDecisionModel(body.modelProjectId, body.command, {actorId: input.actorId});
    await fence(); return receipt;
  }};
}
