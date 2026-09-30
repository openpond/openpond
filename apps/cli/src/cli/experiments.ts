import { readFile, stat } from "node:fs/promises";
import { OpenPondExperimentsClient, SaveExperimentSchema, StartExperimentSchema, ExperimentScoringRequestSchema, experimentDefinitionRef } from "openpond-sdk/experiments";
import { loadConfig } from "../config";
import { DEFAULT_OPENPOND_API_BASE_URL } from "../urls";
import { ensureApiKey, optionString, resolveApiBaseUrlOption, resolveBaseUrl } from "./common";

export async function runExperimentsCommand(options: Record<string, string | boolean>, rest: string[]) {
  const [action, id] = rest;
  const teamId = optionString(options, "team");
  if (!teamId || !action || rest.length > (action === "compare" ? 3 : 2)) throw new Error("usage: experiments <save|read|list|executions|start|status|cancel|retry|score|passes|pass|cancel-pass|pass-result|result|compare> [id] [candidate-id] --team <id> [--input-file <path>] [--operation-id <id>]");
  const config = await loadConfig();
  const credentials = { teamId, apiKey: await ensureApiKey(config, resolveBaseUrl(config)),
    baseUrl: resolveApiBaseUrlOption(options) ?? config.apiBaseUrl ?? DEFAULT_OPENPOND_API_BASE_URL };
  const definitions = new OpenPondExperimentsClient(credentials);
  let result: unknown;
  if (action === "save") {
    const file = optionString(options, "inputFile");
    if (!file || id) throw new Error("Saving requires --input-file with the complete configuration and stable operationId.");
    if ((await stat(file)).size > 1_048_576) throw new Error("Experiment input exceeds one MiB.");
    result = await definitions.save(SaveExperimentSchema.parse(JSON.parse(await readFile(file, "utf8"))));
  } else if (action === "list") {
    if (id) throw new Error("List does not accept an Experiment id.");
    const limit = optionString(options, "limit");
    result = await definitions.list({ projectId: optionString(options, "project") || undefined,
      datasetHash: optionString(options, "datasetHash") || undefined, search: optionString(options, "search") || undefined,
      afterId: optionString(options, "afterId") || undefined, ...(limit ? { limit: Number(limit) } : {}) });
  } else {
    if (!id) throw new Error(`${action} requires an id.`);
    if (action === "read") result = await definitions.get(id);
    else if (action === "start") {
      const operationId = optionString(options, "operationId");
      if (!operationId) throw new Error("Start requires --operation-id. Reuse it after a transport failure; use a new id for another execution.");
      const definition = await definitions.get(id);
      result = await definitions.start(StartExperimentSchema.parse({ operationId, definition: experimentDefinitionRef(definition) }));
    } else if (action === "executions") result = await definitions.executions(id, { afterId: optionString(options, "afterId") || undefined });
    else if (action === "status") result = await definitions.execution(id);
    else if (action === "cancel") result = await definitions.cancel(id);
    else if (action === "retry") {
      const operationId = optionString(options, "operationId");
      if (!operationId) throw new Error("Retry requires a stable --operation-id for the new execution.");
      result = await definitions.retry(id, operationId);
    }
    else if (action === "score") {
      const file = optionString(options, "inputFile");
      if (!file || (await stat(file)).size > 1_048_576) throw new Error("Score requires --input-file containing an exact execution reference, grader releases and explicit ceiling, within one MiB.");
      const request = ExperimentScoringRequestSchema.parse(JSON.parse(await readFile(file, "utf8")));
      if (request.execution.id !== id) throw new Error("Scoring input belongs to a different execution.");
      result = await definitions.score(request);
    }
    else if (action === "passes") result = await definitions.scoringPasses(id, { afterId: optionString(options, "afterId") || undefined });
    else if (action === "pass") result = await definitions.scoringPass(id);
    else if (action === "cancel-pass") result = await definitions.cancelScoringPass(id);
    else if (action === "pass-result") result = await definitions.scoringResult(id);
    else if (action === "result") result = await definitions.result(id);
    else if (action === "compare") {
      if (!rest[2]) throw new Error("Compare requires a baseline and candidate execution id.");
      result = await definitions.compare(id, rest[2]);
    }
    else throw new Error(`Unknown Experiment action: ${action}`);
  }
  console.log(JSON.stringify(result, null, 2));
}
