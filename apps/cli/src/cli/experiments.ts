import { readFile, stat } from "node:fs/promises";
import { OpenPondExperimentsClient, ExperimentListQuerySchema, OpenPondExperimentInspectionClient, ExperimentScoringRequestSchema } from "openpond-sdk/experiments";
import { loadConfig } from "../config";
import { DEFAULT_OPENPOND_API_BASE_URL } from "../urls";
import { ensureApiKey, optionString, resolveApiBaseUrlOption, resolveBaseUrl } from "./common";
import { runLocalExperimentsCommand } from "./experiments-local";

export async function runExperimentsCommand(options: Record<string, string | boolean>, rest: string[]) {
  if(options.local===true||options.local==="true")return runLocalExperimentsCommand(options,rest);
  if(options.revision!==undefined||options.contentHash!==undefined)throw new Error("Experiments retain their immutable configuration on the run; definition revisions are not selectable.");
  const [action, id] = rest;
  const teamId = optionString(options, "team");
  if (!teamId || !action || rest.length > (action === "compare" ? 3 : 2)) throw new Error("usage: experiments <defaults|create-comparison|comparison-budget|prepare-harness|run|read|list|status|cancel|duplicate|score|passes|pass|cancel-pass|pass-result|result|compare|case> [id] [candidate-id] --team <id> [--input-file <path>] [--operation-id <id>]");
  const config = await loadConfig();
  const credentials = { teamId, apiKey: await ensureApiKey(config, resolveBaseUrl(config)),
    baseUrl: resolveApiBaseUrlOption(options) ?? config.apiBaseUrl ?? DEFAULT_OPENPOND_API_BASE_URL };
  const experiments = new OpenPondExperimentsClient(credentials);
  let result: unknown;
  if (action === "defaults") {
    if (id) throw new Error("Defaults does not accept an id.");
    result = await experiments.defaults();
  } else if (action === "create-comparison") {
    const file = optionString(options, "inputFile");
    if (!file || id || (await stat(file)).size > 1_048_576) throw new Error("Create comparison requires a bounded input file with an id, fresh operationIds and optional maximumSpendUsd.");
    result = await experiments.createComparisonBudget(JSON.parse(await readFile(file, "utf8")));
  } else if (action === "comparison-budget") {
    if (!id) throw new Error("Comparison budget requires an id.");
    result = await experiments.comparisonBudget(id);
  } else if (action === "prepare-harness") {
    const file = optionString(options, "inputFile");
    if (!file || id || (await stat(file)).size > 1_048_576) throw new Error("Harness preparation requires a bounded --input-file with its released target, model and optional ceiling.");
    result = await experiments.prepareHarness(JSON.parse(await readFile(file, "utf8")));
  } else if (action === "run") {
    const file = optionString(options, "inputFile");
    if (!file || id) throw new Error("Run requires --input-file with the reviewed configuration and stable operationId.");
    if ((await stat(file)).size > 1_048_576) throw new Error("Experiment input exceeds one MiB.");
    result = await experiments.run(JSON.parse(await readFile(file, "utf8")));
  } else if (action === "list") {
    if (id) throw new Error("List does not accept an Experiment id.");
    const limit = optionString(options, "limit");
    result = await experiments.list(ExperimentListQuerySchema.parse({ projectId: optionString(options, "project") || undefined,
      datasetHash: optionString(options, "datasetHash") || undefined, search: optionString(options, "search") || undefined,
      status: optionString(options, "status") || undefined, afterId: optionString(options, "afterId") || undefined, ...(limit ? { limit: Number(limit) } : {}) }));
  } else {
    if (!id) throw new Error(`${action} requires an id.`);
    if (action === "read") result = await experiments.get(id);
    else if (action === "status") result = await experiments.get(id);
    else if (action === "cancel") result = await experiments.cancel(id);
    else if (action === "duplicate") {
      const operationId = optionString(options, "operationId");
      if (!operationId) throw new Error("Duplicate requires a stable --operation-id for the new Experiment.");
      result = await experiments.duplicate(id, operationId);
    }
    else if (action === "score") {
      const file = optionString(options, "inputFile");
      if (!file || (await stat(file)).size > 1_048_576) throw new Error("Score requires --input-file containing an exact execution reference, grader releases and explicit ceiling, within one MiB.");
      const request = ExperimentScoringRequestSchema.parse(JSON.parse(await readFile(file, "utf8")));
      if (request.execution.id !== id) throw new Error("Scoring input belongs to a different execution.");
      result = await experiments.score(request);
    }
    else if (action === "passes") result = await experiments.scoringPasses(id, { afterId: optionString(options, "afterId") || undefined });
    else if (action === "pass") result = await experiments.scoringPass(id);
    else if (action === "cancel-pass") result = await experiments.cancelScoringPass(id);
    else if (action === "pass-result") result = await experiments.scoringResult(id);
    else if (action === "result") result = await experiments.result(id);
    else if (action === "case") {
      const receiptId = optionString(options, "receiptId");
      if (!receiptId) throw new Error("Case inspection requires --receipt-id from the retained Experiment.");
      const run = await experiments.get(id);
      result = await new OpenPondExperimentInspectionClient(credentials).case(id, receiptId, {
        manifestHash: run.manifest.contentHash, afterId: optionString(options, "afterId") || undefined,
      });
    }
    else if (action === "compare") {
      if (!rest[2]) throw new Error("Compare requires a baseline and candidate execution id.");
      result = await experiments.compare(id, rest[2]);
    }
    else throw new Error(`Unknown Experiment action: ${action}`);
  }
  console.log(JSON.stringify(result, null, 2));
}
