import { z, ZodError } from "zod";
import { OpenPondTrainingApiError } from "openpond-sdk/training";
import { HostedNeuronTrainingExecutionError } from "../../training/hosted-neuron-training-executions.js";
import { readJson, sendJson } from "../http.js";
import type { HttpRouteContext } from "../http-route-types.js";

export async function handleNeuronTrainingPublicationRoutes({
  deps,
  request,
  requestUrl,
  response,
}: HttpRouteContext): Promise<boolean> {
  const match = /^\/v1\/training\/neuron-training-executions\/([^/]+)\/model$/.exec(
    requestUrl.pathname,
  );
  if (!match) return false;
  if (request.method !== "GET" && request.method !== "POST") {
    sendJson(response, 405, {
      code: "method_not_allowed",
      error: "Use the canonical Model save operation.",
    });
    return true;
  }
  response.setHeader("Cache-Control", "no-store");
  try {
    if (new Set(requestUrl.searchParams.keys()).size !== requestUrl.searchParams.size)
      throw new ZodError([
        {
          code: "custom",
          path: [],
          message: "Duplicate Model save query fields are not permitted.",
        },
      ]);
    const payload =
      request.method === "POST"
        ? z.record(z.string(), z.unknown()).parse(await readJson(request, { maxBytes: 65_536 }))
        : Object.fromEntries(requestUrl.searchParams);
    sendJson(
      response,
      200,
      await deps.trainingPayload(
        "hosted_neuron_training_publication",
        {
          ...payload,
          projectId: payload.projectId ?? null,
          executionId: decodeURIComponent(match[1]!),
          action: request.method === "POST" ? "save" : "options",
        },
        requestUrl,
      ),
    );
  } catch (error) {
    if (error instanceof OpenPondTrainingApiError)
      sendJson(response, error.status, {
        code: error.code,
        error: error.message,
        retryable: error.retryable,
      });
    else if (error instanceof HostedNeuronTrainingExecutionError)
      sendJson(response, error.status, {
        code: error.code,
        error: error.message,
        retryable: false,
      });
    else if (error instanceof ZodError || error instanceof URIError)
      sendJson(response, 400, {
        code: "neuron_training_save_request_invalid",
        error: "The Model save does not match its reviewed contract.",
        retryable: false,
      });
    else throw error;
  }
  return true;
}
