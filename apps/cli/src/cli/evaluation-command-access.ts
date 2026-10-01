import {readFile, stat} from "node:fs/promises";
import {loadConfig} from "../config";
import {DEFAULT_OPENPOND_API_BASE_URL} from "../urls";
import {ensureApiKey, optionString, resolveApiBaseUrlOption, resolveBaseUrl} from "./common";
import {createLocalAuthenticatedRequest, DEFAULT_LOCAL_TRAINING_API_URL} from "./training";

/** Mutations consume an exact reviewed JSON request. Stable operation IDs and
 * revisions belong to that request; a retry never invents replacement intent. */
export async function readEvaluationCommandInput(options: Record<string,string|boolean>): Promise<unknown> {
  const file = optionString(options,"inputFile");
  if (!file) throw new Error("Provide --input-file with the exact reviewed request.");
  const info = await stat(file);
  if (!info.isFile() || info.size > 1_048_576) throw new Error("The request must be a regular JSON file of at most 1 MiB.");
  const bytes = await readFile(file);
  if (bytes.byteLength > 1_048_576) throw new Error("The request file grew beyond 1 MiB.");
  return JSON.parse(bytes.toString("utf8"));
}
export async function evaluationCommandAccess(options: Record<string,string|boolean>) {
  const teamId = optionString(options,"team");
  if (!teamId) throw new Error("Select --team for the evaluation owner.");
  if (options.local === true || options.local === "true") {
    const origin = new URL(optionString(options,"serverUrl") || DEFAULT_LOCAL_TRAINING_API_URL);
    if (origin.protocol !== "http:" || !["localhost","127.0.0.1","[::1]"].includes(origin.hostname)
      || origin.username || origin.password || origin.search || origin.hash || origin.pathname !== "/")
      throw new Error("Local evaluation commands require an HTTP loopback server origin.");
    return {teamId, baseUrl:origin.origin, apiKey:"local-capability", fetch:await createLocalAuthenticatedRequest(origin.origin)};
  }
  const config = await loadConfig();
  return {teamId, apiKey:await ensureApiKey(config,resolveBaseUrl(config)),
    baseUrl:resolveApiBaseUrlOption(options) ?? config.apiBaseUrl ?? DEFAULT_OPENPOND_API_BASE_URL};
}
