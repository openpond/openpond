import { ZodError } from "zod";
import { MODIFICATION_RECORDING_MAX_BYTES, ModificationRecordingReadQuerySchema, OpenPondProtocolError, OPENPOND_TRAINING_MEDIA_TYPE } from "openpond-sdk/training";
import { ModificationRecordingError } from "../../evaluations/modification-recordings.js";
import { readJson, sendJson } from "../http.js";
import type { HttpRouteContext } from "../http-route-types.js";

/** Same authenticated loopback API boundary as local experiments. Recordings
 * never acquire execution custody or claim authenticated worker measurements. */
export async function handleModificationRecordingRoutes({ deps, request, requestUrl, response }: HttpRouteContext) {
  const match = /^\/v1\/modification-recordings(?:\/([^/]+))?$/.exec(requestUrl.pathname);
  if (!match) return false;
  response.setHeader("Cache-Control", "no-store");
  response.setHeader("Content-Type", OPENPOND_TRAINING_MEDIA_TYPE);
  const failure = (status: number, code: string, message: string) => sendJson(response, status, {
    schemaVersion: "openpond.trainingApiError.v2", code, message, retryable: status >= 500, requestId: null, details: {} });
  try {
    const service = deps.modificationRecordings;
    if (!service) { failure(503, "modification_recordings_unavailable", "Observation storage is unavailable."); return true; }
    if (new Set(requestUrl.searchParams.keys()).size !== requestUrl.searchParams.size) {
      failure(400, "modification_recording_query_invalid", "Use each query field once."); return true;
    }
    if (request.method === "POST" && !match[1] && !requestUrl.search) {
      sendJson(response, 201, await service.record(await readJson(request, { maxBytes: MODIFICATION_RECORDING_MAX_BYTES })));
    } else if (request.method === "GET") {
      const query = Object.fromEntries(requestUrl.searchParams);
      if (match[1]) {
        const { teamId } = ModificationRecordingReadQuerySchema.parse(query);
        sendJson(response, 200, await service.read(decodeURIComponent(match[1]), teamId));
      } else {
        sendJson(response, 200, await service.list({ ...query, ...(query.limit === undefined ? {} : { limit: Number(query.limit) }) }));
      }
    } else failure(405, "method_not_allowed", "Use record, list or read for an observation.");
  } catch (error) {
    if (error instanceof ZodError || error instanceof URIError) failure(400, "modification_recording_invalid", "Check the observation document and query.");
    else if (error instanceof OpenPondProtocolError) failure(400, error.code, error.message);
    else if (error instanceof ModificationRecordingError) failure(error.status, error.code, error.message);
    else throw error;
  }
  return true;
}
