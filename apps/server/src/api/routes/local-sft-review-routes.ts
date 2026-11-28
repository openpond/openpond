import { z } from "zod";
import { LocalSftPreflightRequestSchema, LocalSftReviewRequestSchema, LocalSftRunRequestSchema } from "@openpond/contracts/resource-setup";
import { LocalSftReviewError } from "../../training/local-sft-review.js";
import { LocalTrainingModelError } from "../../training/local-training-model-assets.js";
import { readJson, sendJson } from "../http.js";
import type { HttpRouteContext } from "../http-route-types.js";
import { isDesktopLocalRequest } from "../local-human-authority.js";

const approveRequest = z.object({
  request: LocalSftReviewRequestSchema,
  expectedPlanHash: z.string().regex(/^[a-f0-9]{64}$/),
}).strict();

export async function handleLocalSftReviewRoutes({ deps, request, response, requestUrl }: HttpRouteContext) {
  const operation = /^\/v1\/training\/local-sft\/(preview|approve|check|start|status|cancel)$/.exec(requestUrl.pathname)?.[1];
  if (!operation || request.method !== "POST") return false;
  if (!isDesktopLocalRequest(request)) {
    sendJson(response, 403, { code: "local_sft_requires_desktop", error: "Open the local desktop to access local training." });
    return true;
  }
  const abort = new AbortController();
  const cancel = () => abort.abort();
  response.once("close", cancel);
  response.setHeader("Cache-Control", "no-store");
  try {
    const body = await readJson(request, { maxBytes: 256 * 1024 });
    const payload = operation === "preview" ? { request: LocalSftReviewRequestSchema.parse(body) }
      : operation === "approve" ? approveRequest.parse(body)
      : operation === "start" || operation === "cancel" ? LocalSftRunRequestSchema.parse(body)
      : operation === "status" ? LocalSftRunRequestSchema.partial({ runId: true }).parse(body)
      : LocalSftPreflightRequestSchema.parse(body);
    const action = operation === "preview" || operation === "approve" ? "review_local_sft" : `${operation}_local_sft`;
    const result = await deps.trainingPayload(action, payload, requestUrl, abort.signal);
    if (!abort.signal.aborted) sendJson(response, 200, result);
  } catch (error) {
    if (abort.signal.aborted) return true;
    if (error instanceof z.ZodError) sendJson(response, 400, { code: "local_sft_inputs_invalid", error: "Check the starting checkpoint, Dataset revision, and SFT settings." });
    else if (error instanceof LocalSftReviewError || error instanceof LocalTrainingModelError) {
      sendJson(response, error.status, { code: "local_sft_review_unavailable", error: error.message });
    } else throw error;
  } finally { response.off("close", cancel); }
  return true;
}
