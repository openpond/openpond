import { z } from "zod";
import { contentHash } from "@openpond/harness";
import { compareExperiments, verifyExperimentEvidence } from "@openpond/evals/experiments";
import { ExperimentDefinitionRefSchema, ExperimentListQuerySchema, SaveExperimentSchema, StartExperimentSchema, experimentDefinitionRef,
  verifyExperimentDefinition, type ExperimentDefinitionRef } from "./experiment-contracts.js";
import { PrepareHarnessExperimentSchema, PreparedHarnessExperimentSchema } from "./experiment-contracts.js";
import { verifyHarnessExperimentManifest, verifyModelTasksetRunDetails } from "./model-taskset-runs-contracts.js";
import { ExperimentScoringRequestSchema, verifyExperimentScoringPass, type ExperimentScoringRequest } from "./experiment-scoring-contracts.js";

const Id = z.string().trim().min(1).max(200);
export class OpenPondExperimentError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) { super(message); this.name = "OpenPondExperimentError"; }
}

/** Saved configuration and execution identities share the host's service. */
export class OpenPondExperimentsClient {
  private readonly baseUrl: string;
  constructor(private readonly options: { baseUrl: string; apiKey: string; teamId: string; fetch?: typeof fetch }) {
    const url = new URL(options.baseUrl);
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash || !options.apiKey.trim() || !options.teamId.trim())
      throw new Error("A clean API origin and workspace credentials are required.");
    this.baseUrl = url.toString().replace(/\/+$/, "");
  }
  /** Resolves a released target without saving a definition or dispatching it. */
  async prepareHarness(value: z.input<typeof PrepareHarnessExperimentSchema>, signal?: AbortSignal) {
    const request = PrepareHarnessExperimentSchema.parse(value);
    const result = PreparedHarnessExperimentSchema.parse(await this.request("/harness-setup", "POST", request, signal));
    verifyHarnessExperimentManifest(result.request, result.manifest);
    const policy = result.request.policy;
    if (result.request.teamId !== this.options.teamId || result.request.operationId !== request.operationId
      || policy.kind !== "hosted_harness" || policy.profileRepositoryId !== request.profileRepositoryId
      || policy.source.definitionId !== request.definitionId || policy.modelId !== request.modelId
      || policy.reasoningEffort !== request.reasoningEffort || result.maximumCostUsd !== request.maximumCostUsd
      || result.manifest.limits.maximumSpendUsd !== request.maximumCostUsd)
      throw new Error("Harness preparation differs from its requested scope or configuration.");
    return result;
  }
  async save(value: z.input<typeof SaveExperimentSchema>, signal?: AbortSignal) {
    const request = SaveExperimentSchema.parse(value);
    if (request.request.teamId !== this.options.teamId) throw new Error("Experiment workspace mismatch.");
    const result = this.definition(await this.request("", "POST", request, signal), request.id);
    if (result.revision !== request.expectedRevision + 1 || contentHash(result.request) !== contentHash(request.request)
      || result.maximumCostUsd !== request.maximumCostUsd) throw new Error("Experiment save receipt differs from its submitted configuration.");
    if (request.graders && contentHash(request.graders) !== contentHash(result.graders.map(grader => ({ id: grader.id, version: grader.version, contentHash: grader.contentHash, mappings: grader.mappings ?? [] }))))
      throw new Error("Experiment save receipt differs from its selected graders or mappings.");
    return result;
  }
  async get(id: string, options: { reference?: ExperimentDefinitionRef; signal?: AbortSignal } = {}) {
    const reference = options.reference ? ExperimentDefinitionRefSchema.parse(options.reference) : undefined;
    if (reference && reference.id !== id) throw new Error("Experiment reference identity mismatch.");
    const suffix = reference ? `?${new URLSearchParams({ revision: String(reference.revision), contentHash: reference.contentHash })}` : "";
    const result = this.definition(await this.request(`/${encodeURIComponent(Id.parse(id))}${suffix}`, "GET", undefined, options.signal), id);
    if (options.reference && contentHash(experimentDefinitionRef(result)) !== contentHash(options.reference)) throw new Error("Experiment revision mismatch.");
    return result;
  }
  async list(value: z.input<typeof ExperimentListQuerySchema> = {}, signal?: AbortSignal) {
    const query = ExperimentListQuerySchema.parse(value);
    const params = new URLSearchParams(Object.entries(query).map(([key, value]) => [key, String(value)]));
    const page = z.object({ items: z.array(z.unknown()).max(100), nextCursor: Id.nullable() }).strict().parse(await this.request(`?${params}`, "GET", undefined, signal));
    const items = page.items.map(value => this.definition(value));
    if (items.length > query.limit || new Set(items.map(item => item.id)).size !== items.length
      || items.some(item => query.projectId && item.request.project?.id !== query.projectId || query.datasetHash && item.request.taskset.contentHash !== query.datasetHash))
      throw new Error("Experiment page differs from its selected scope.");
    return { items, nextCursor: page.nextCursor };
  }
  async start(value: z.input<typeof StartExperimentSchema>, signal?: AbortSignal) {
    const request = StartExperimentSchema.parse(value);
    const response = z.object({ definition: z.unknown(), run: z.unknown() }).strict().parse(
      await this.request(`/${encodeURIComponent(request.definition.id)}/start`, "POST", request, signal));
    const definition = this.definition(response.definition, request.definition.id);
    if (contentHash(experimentDefinitionRef(definition)) !== contentHash(request.definition)) throw new Error("Experiment Start revision mismatch.");
    const result = await verifyModelTasksetRunDetails(response.run);
    if (result.summary.teamId !== this.options.teamId || result.request.operationId !== request.operationId
      || contentHash(savedRequestPopulation(result.request))
        !== contentHash(savedRequestPopulation({ ...definition.request, operationId: request.operationId }))
      || contentHash(result.manifest.metadata.experimentDefinition) !== contentHash(request.definition)
      || result.manifest.metadata.experimentConfigurationHash !== contentHash({ definition: request.definition, maximumCostUsd: definition.maximumCostUsd, graders: definition.graders }))
      throw new Error("Experiment execution differs from its saved configuration.");
    return result;
  }
  async result(executionId: string, signal?: AbortSignal) {
    const value = z.object({ executionId: Id, passId: Id.nullable(), manifest: z.unknown(), result: z.unknown() }).strict()
      .parse(await this.request(`/executions/${encodeURIComponent(Id.parse(executionId))}/result`, "GET", undefined, signal));
    const evidence = verifyExperimentEvidence(value);
    if (value.executionId !== executionId || evidence.manifest.teamId !== this.options.teamId
      || evidence.manifest.lineage?.execution.id !== executionId
      || evidence.manifest.lineage.scoringPassId !== value.passId) throw new Error("Experiment result identity mismatch.");
    return { ...evidence, executionId, passId: value.passId };
  }
  async executions(definitionId: string, options: { afterId?: string; signal?: AbortSignal } = {}) {
    const params = new URLSearchParams(options.afterId ? { afterId: Id.parse(options.afterId) } : {});
    const page = z.object({ items: z.array(z.unknown()).max(30), nextCursor: Id.nullable() }).strict().parse(
      await this.request(`/${encodeURIComponent(Id.parse(definitionId))}/executions?${params}`, "GET", undefined, options.signal));
    const items = await Promise.all(page.items.map(value => verifyModelTasksetRunDetails(value)));
    if (items.some(item => item.summary.teamId !== this.options.teamId
      || ExperimentDefinitionRefSchema.parse(item.manifest.metadata.experimentDefinition).id !== definitionId)
      || new Set(items.map(item => item.summary.id)).size !== items.length)
      throw new Error("Experiment execution page has invalid ownership or repeated identities.");
    return { items, nextCursor: page.nextCursor };
  }
  async execution(id: string, signal?: AbortSignal) {
    return this.executionDetails(await this.request(`/executions/${encodeURIComponent(Id.parse(id))}`, "GET", undefined, signal), id);
  }
  async cancel(id: string, signal?: AbortSignal) {
    return this.executionDetails(await this.request(`/executions/${encodeURIComponent(Id.parse(id))}/cancel`, "POST", {}, signal), id);
  }
  /** Retry intentionally creates another execution; a transport retry reuses the same operation id. */
  async retry(id: string, operationId: string, signal?: AbortSignal) {
    const result = await this.executionDetails(await this.request(`/executions/${encodeURIComponent(Id.parse(id))}/retry`, "POST", { operationId: Id.parse(operationId) }, signal));
    if (result.request.operationId !== operationId) throw new Error("Experiment retry operation mismatch.");
    return result;
  }
  async score(value: ExperimentScoringRequest, signal?: AbortSignal) {
    const request = ExperimentScoringRequestSchema.parse(value);
    const pass = this.pass(await this.request(`/executions/${encodeURIComponent(request.execution.id)}/scoring-passes`, "POST", request, signal));
    if (contentHash(pass.request) !== contentHash(request)) throw new Error("Scoring admission differs from its submitted inputs.");
    return pass;
  }
  async scoringPass(id: string, signal?: AbortSignal) {
    return this.pass(await this.request(`/scoring-passes/${encodeURIComponent(Id.parse(id))}`, "GET", undefined, signal), id);
  }
  async scoringPasses(executionId: string, options: { afterId?: string; signal?: AbortSignal } = {}) {
    const params = new URLSearchParams(options.afterId ? { afterId: Id.parse(options.afterId) } : {});
    const page = z.object({ items: z.array(z.unknown()).max(30), nextCursor: Id.nullable() }).strict().parse(
      await this.request(`/executions/${encodeURIComponent(Id.parse(executionId))}/scoring-passes?${params}`, "GET", undefined, options.signal));
    const items = page.items.map(value => this.pass(value));
    if (items.some(item => item.request.execution.id !== executionId) || new Set(items.map(item => item.id)).size !== items.length)
      throw new Error("Scoring pass page differs from its execution ownership.");
    return { items, nextCursor: page.nextCursor };
  }
  async cancelScoringPass(id: string, signal?: AbortSignal) {
    return this.pass(await this.request(`/scoring-passes/${encodeURIComponent(Id.parse(id))}/cancel`, "POST", {}, signal), id);
  }
  async scoringResult(id: string, signal?: AbortSignal) {
    const value = z.object({ executionId: Id, passId: Id, manifest: z.unknown(), result: z.unknown() }).strict().parse(
      await this.request(`/scoring-passes/${encodeURIComponent(Id.parse(id))}/result`, "GET", undefined, signal));
    const evidence = verifyExperimentEvidence(value);
    if (value.passId !== id || evidence.manifest.teamId !== this.options.teamId || evidence.manifest.id !== id
      || evidence.manifest.lineage?.execution.id !== value.executionId || evidence.manifest.lineage.scoringPassId !== id)
      throw new Error("Scoring result identity mismatch.");
    return { ...evidence, executionId: value.executionId, passId: id };
  }
  async compare(baselineId: string, candidateId: string, signal?: AbortSignal) {
    const read = (id: string) => id.startsWith("score_") ? this.scoringResult(id, signal) : this.result(id, signal);
    const [baseline, candidate] = await Promise.all([read(baselineId), read(candidateId)]);
    return { baseline, candidate, comparison: compareExperiments(baseline, candidate) };
  }
  private definition(value: unknown, id?: string) {
    const result = verifyExperimentDefinition(value);
    if (result.teamId !== this.options.teamId || id && result.id !== id) throw new Error("Experiment identity mismatch.");
    return result;
  }
  private async executionDetails(value: unknown, id?: string) {
    const details = await verifyModelTasksetRunDetails(value);
    if (details.summary.teamId !== this.options.teamId || id && details.summary.id !== id) throw new Error("Experiment execution identity mismatch.");
    return details;
  }
  private pass(value: unknown, id?: string) {
    const pass = verifyExperimentScoringPass(value);
    if (pass.teamId !== this.options.teamId || id && pass.id !== id) throw new Error("Scoring pass identity mismatch.");
    return pass;
  }
  private async request(path: string, method: string, body?: unknown, signal?: AbortSignal): Promise<unknown> {
    const response = await (this.options.fetch ?? fetch)(`${this.baseUrl}/v1/experiments${path}`, {
      method, signal, redirect: "error", headers: { Authorization: `Bearer ${this.options.apiKey}`, "X-OpenPond-Team-Id": this.options.teamId, "Content-Type": "application/json", Accept: "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const value = await response.json();
    if (!response.ok) {
      const parsed = z.object({ code: z.string(), message: z.string() }).safeParse(value);
      throw new OpenPondExperimentError(response.status, parsed.success ? parsed.data.code : "experiment_request_failed", parsed.success ? parsed.data.message : "Experiment request failed.");
    }
    return value;
  }
}

/** Native Harness assigns receipt IDs when sealing each new execution. Its
 * saved population still pins every task/seed; Model receipts stay exact. */
function savedRequestPopulation(request: z.infer<typeof SaveExperimentSchema>["request"]) {
  return request.policy.kind === "hosted_harness" ? {
    ...request, population: request.population.map(({ receiptId: _id, ...member }) => member),
  } : request;
}
