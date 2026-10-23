import { z } from "zod";
import { CorrectionVerificationPlanContentSchema, CorrectionVerificationPlanSchema, CorrectionOpportunitySchema, CorrectionMetricSummarySchema, CorrectionMetricObservationSchema, assertLearningRequestJson } from "@openpond/evals/learning";
import { OpenPondLearningError, readBoundedLearningResponse, type LearningRequestOptions } from "./learning-client.js";
export { CorrectionVerificationPlanSchema, CorrectionMetricSummarySchema, CorrectionMetricObservationSchema } from "@openpond/evals/learning";
export type { CorrectionVerificationPlan, CorrectionMetricSummary, CorrectionMetricObservation } from "@openpond/evals/learning";
const id = z.string().trim().min(1).max(500);
const ref = z.object({ id, contentHash: z.string().regex(/^[a-f0-9]{64}$/) }).strict();
export const CorrectionMetricsReadSchema = z.object({ teamId: id, modelId: id, runId: id.optional(), from: z.string().datetime().optional(), to: z.string().datetime().optional() }).strict();
export const CorrectionMetricsCommandSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("declare_verification"), teamId: id, operationId: id,
    plan: z.object({
      modelId: CorrectionVerificationPlanContentSchema.shape.modelId,
      classification: CorrectionVerificationPlanContentSchema.shape.classification,
      feedback: CorrectionVerificationPlanContentSchema.shape.feedback,
      evidence: CorrectionVerificationPlanContentSchema.shape.evidence,
      trainingJobId: CorrectionVerificationPlanContentSchema.shape.trainingJobId,
      checkpoint: CorrectionVerificationPlanContentSchema.shape.checkpoint,
      artifact: CorrectionVerificationPlanContentSchema.shape.artifact,
      taskset: CorrectionVerificationPlanContentSchema.shape.taskset,
      checks: CorrectionVerificationPlanContentSchema.shape.checks,
      baselineOperationId: CorrectionVerificationPlanContentSchema.shape.baselineOperationId,
      candidateOperationId: CorrectionVerificationPlanContentSchema.shape.candidateOperationId,
      criterion: CorrectionVerificationPlanContentSchema.shape.criterion,
    }).strict() }).strict(),
  z.object({ action: z.literal("link_live_opportunity"), teamId: id, operationId: id, correction: ref, inferenceRequestId: id,
    grade: z.object({ id, revision: z.number().int().positive() }).strict(), checkIds: z.array(id).min(1).max(1000) }).strict(),
]);
export const CorrectionMetricsDetailSchema = z.object({ summary: CorrectionMetricSummarySchema.nullable(), observations: z.array(CorrectionMetricObservationSchema).max(1000) }).strict();
export type CorrectionMetricsRead = z.infer<typeof CorrectionMetricsReadSchema>;
export type CorrectionMetricsCommand = z.infer<typeof CorrectionMetricsCommandSchema>;
export class OpenPondCorrectionMetricsClient {
  private readonly options: { baseUrl: string; apiKey: string; fetch?: typeof globalThis.fetch };
  constructor(options: { baseUrl: string; apiKey: string; fetch?: typeof globalThis.fetch }) {
    if (!options.apiKey.trim()) throw new Error("Learning API key is required.");
    const url = new URL(options.baseUrl);
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash)
      throw new Error("Learning base URL must be an HTTP(S) endpoint without credentials, query, or fragment.");
    this.options = { ...options, baseUrl: url.toString().replace(/\/+$/, "") };
  }
  private async request(path: string, teamId: string, init: RequestInit) {
    const response = await (this.options.fetch ?? globalThis.fetch)(`${this.options.baseUrl}${path}`, {
      ...init, redirect: "error", headers: { Authorization: `Bearer ${this.options.apiKey}`, "Content-Type": "application/json", Accept: "application/json", "X-OpenPond-Team-Id": teamId },
    });
    let payload: unknown;
    try { payload = await readBoundedLearningResponse(response); }
    catch (error) {
      if (error instanceof OpenPondLearningError) throw error;
      throw new OpenPondLearningError(response.ok ? 502 : response.status, "invalid_response", "Correction metrics returned an invalid response.", null);
    }
    if (!response.ok) {
      const error = z.object({ code: z.string().optional(), error: z.string().optional() }).passthrough().safeParse(payload);
      throw new OpenPondLearningError(response.status, error.success ? error.data.code ?? "correction_request_failed" : "correction_request_failed",
        error.success ? error.data.error ?? `Correction metrics request failed (${response.status}).` : `Correction metrics request failed (${response.status}).`, payload);
    }
    return payload;
  }
  async read(input: CorrectionMetricsRead, options: LearningRequestOptions = {}) {
    const query = CorrectionMetricsReadSchema.parse(input);
    const result = CorrectionMetricsDetailSchema.parse(await this.request(`/v1/learning/corrections?query=${encodeURIComponent(JSON.stringify(query))}`, query.teamId, { method: "GET", signal: options.signal }));
    if (result.summary && (result.summary.scope.teamId !== query.teamId || result.summary.scope.modelId !== query.modelId || query.runId && result.summary.scope.runId !== query.runId)
      || result.observations.some(observation => observation.modelId !== query.modelId || query.runId && observation.trainingJobId !== query.runId))
      throw new OpenPondLearningError(502, "correction_scope_mismatch", "Correction metrics did not match the requested workspace, Model or run.", null);
    return result;
  }
  async command(input: CorrectionMetricsCommand, options: LearningRequestOptions = {}) {
    const command = CorrectionMetricsCommandSchema.parse(input);
    assertLearningRequestJson(command);
    const payload = await this.request("/v1/learning/corrections", command.teamId, { method: "POST", body: JSON.stringify(command), signal: options.signal });
    if (command.action === "declare_verification") {
      const result = CorrectionVerificationPlanSchema.parse(payload);
      if (result.teamId !== command.teamId || result.modelId !== command.plan.modelId || result.trainingJobId !== command.plan.trainingJobId)
        throw new OpenPondLearningError(502, "correction_scope_mismatch", "Correction declaration did not match the requested workspace, Model or run.", null);
      return result;
    }
    const result = CorrectionOpportunitySchema.parse(payload);
    if (result.correction.id !== command.correction.id || result.correction.contentHash !== command.correction.contentHash || result.attempt.id !== command.inferenceRequestId)
      throw new OpenPondLearningError(502, "correction_scope_mismatch", "Correction opportunity did not match the declared correction and serving request.", null);
    return result;
  }
}
