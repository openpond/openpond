import { z } from "zod";
import { readJson, sendJson } from "../http.js";
import type { HttpRouteContext } from "../http-route-types.js";
import { isDesktopLocalRequest } from "../local-human-authority.js";
import { LocalTrainingModelError } from "../../training/local-training-model-assets.js";

const importRequest = z.object({ directory: z.string().trim().min(1).max(4096) }).strict();

export async function handleLocalTrainingModelRoutes({ deps, request, requestUrl, response }: HttpRouteContext) {
  const collection = requestUrl.pathname === "/v1/training/local-models";
  const assetId = /^\/v1\/training\/local-models\/([a-f0-9]{64})$/.exec(requestUrl.pathname)?.[1];
  if ((!collection || !["GET", "POST"].includes(request.method ?? "")) && !(assetId && request.method === "GET")) return false;
  if (!isDesktopLocalRequest(request)) {
    sendJson(response, 403, { code: "local_training_model_requires_desktop", error: "Open the local desktop to manage training checkpoints." });
    return true;
  }
  const abort = new AbortController();
  const cancel = () => abort.abort();
  response.once("close", cancel);
  response.setHeader("Cache-Control", "no-store");
  try {
    const importing = request.method === "POST";
    const payload = importing ? importRequest.parse(await readJson(request, { maxBytes: 16_384 })) : assetId ? { assetId } : {};
    const result = await deps.trainingPayload(
      importing ? "import_local_training_model" : assetId ? "verify_local_training_model" : "list_local_training_models",
      payload, requestUrl, abort.signal,
    );
    if (!abort.signal.aborted) sendJson(response, 200, result);
  } catch (error) {
    if (abort.signal.aborted) return true;
    if (error instanceof z.ZodError) sendJson(response, 400, { code: "local_training_model_invalid", error: "Choose a checkpoint folder." });
    else if (error instanceof LocalTrainingModelError) sendJson(response, error.status, { code: "local_training_model_unavailable", error: error.message });
    else throw error;
  } finally { response.off("close", cancel); }
  return true;
}
