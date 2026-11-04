import { readFile, stat } from "node:fs/promises";
import { createTrainingClient, MODIFICATION_RECORDING_MAX_BYTES, ModificationRecordingRequestSchema } from "openpond-sdk/training";
import { optionString } from "./common";
import type { createLocalAuthenticatedRequest } from "./training";

/** Use the ordinary local capability and public SDK, never separate auth/HTTP. */
export async function runLocalModificationRecordingCommand(options: Record<string, string | boolean>, rest: string[],
  baseUrl: string, request: Awaited<ReturnType<typeof createLocalAuthenticatedRequest>>, teamId: string | undefined) {
  const [action, id] = rest;
  if (!["record-modification", "modification", "modifications"].includes(action ?? "")) return false;
  if (!teamId) throw new Error("Local observation operations require --team <workspace-id>.");
  const client = createTrainingClient({ baseUrl, fetch: request });
  let result: unknown;
  if (action === "record-modification" && rest.length === 1) {
    const file = optionString(options, "inputFile"), info = file ? await stat(file) : null;
    if (!file || !info?.isFile() || info.size > MODIFICATION_RECORDING_MAX_BYTES)
      throw new Error("Provide --input-file <command.json> containing a recording request of at most 8 MiB.");
    const command = ModificationRecordingRequestSchema.parse(JSON.parse(await readFile(file, "utf8")));
    if (command.teamId !== teamId) throw new Error("The recording request belongs to another workspace.");
    result = await client.recordModificationObservation(command);
  } else if (action === "modification" && id && rest.length === 2) {
    result = await client.modificationRecording(id, { teamId });
  } else if (action === "modifications" && rest.length === 1) {
    const projectId = optionString(options, "project"), search = optionString(options, "search"), cursor = optionString(options, "cursor"), limit = optionString(options, "limit");
    result = await client.modificationRecordings({ teamId, ...(projectId ? { projectId } : {}), ...(search ? { search } : {}),
      ...(cursor ? { cursor } : {}), ...(limit ? { limit: Number(limit) } : {}) });
  } else throw new Error("Use experiments record-modification --input-file <command.json>, modification <id>, or modifications, with --local --team <id>.");
  // Preserve provenance and custody in human output as well as --json; no
  // evaluation summary or fabricated cost/score projection applies here.
  console.log(JSON.stringify(result, null, 2));
  return true;
}
