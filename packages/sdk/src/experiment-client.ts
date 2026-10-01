import { z } from "zod";
import { contentHash } from "@openpond/harness";
import { compareExperiments, verifyExperimentEvidence } from "@openpond/evals/experiments";
import { ExperimentListQuerySchema } from "./experiment-contracts.js";
import { RunExperimentSchema } from "./experiment-run-contracts.js";
import { experimentConfigurationRequest, verifyExperimentRunDetails } from "./experiment-run-details.js";
import { PrepareHarnessExperimentSchema, PreparedHarnessExperimentSchema } from "./experiment-contracts.js";
import { verifyHarnessExperimentManifest } from "./model-taskset-runs-contracts.js";
import { ExperimentScoringRequestSchema, verifyExperimentScoringPass, type ExperimentScoringRequest } from "./experiment-scoring-contracts.js";
import { ExperimentHarnessCatalogSchema } from "./experiment-harness-catalog.js";

const Id = z.string().trim().min(1).max(200);
export class OpenPondExperimentError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) { super(message); this.name = "OpenPondExperimentError"; }
}

/** One Experiment is one run with its immutable configuration and results. */
export class OpenPondExperimentsClient {
  private readonly baseUrl: string;
  constructor(private readonly options: { baseUrl: string; apiKey: string; teamId: string; fetch?: typeof fetch }) {
    const url = new URL(options.baseUrl);
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash || !options.apiKey.trim() || !options.teamId.trim())
      throw new Error("A clean API origin and workspace credentials are required.");
    this.baseUrl = url.toString().replace(/\/+$/, "");
  }
  /** Discover released workspace Harnesses independently of Project targets. */
  async harnessSources(options: {cursor?: string; signal?: AbortSignal} = {}) {
    const cursor = options.cursor === undefined ? undefined : z.string().min(1).max(8192).parse(options.cursor);
    const query = new URLSearchParams(cursor ? {cursor} : {});
    const page = ExperimentHarnessCatalogSchema.parse(await this.request(`/harness-sources?${query}`,"GET",undefined,options.signal));
    if (page.teamId !== this.options.teamId
      || new Set(page.items.map(item=>contentHash(item.source))).size !== page.items.length
      || page.nextCursor !== null && page.nextCursor === cursor
      || page.items.some(item=>item.ready !== (item.reason === null)))
      throw new Error("Harness catalog differs from its workspace, readiness or continuation.");
    return page;
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
  async run(value: z.input<typeof RunExperimentSchema>, signal?: AbortSignal) {
    const request = RunExperimentSchema.parse(value);
    if (request.request.teamId !== this.options.teamId) throw new Error("Experiment workspace mismatch.");
    const result = await this.details(await this.request("", "POST", request, signal));
    if (contentHash(experimentConfigurationRequest(result.request)) !== contentHash(experimentConfigurationRequest(request.request))
      || result.configuration.maximumCostUsd !== request.maximumCostUsd
      || result.configuration.sourceExperimentId !== request.sourceExperimentId
      || result.configuration.admissionRequestHash !== contentHash(request))
      throw new Error("Experiment admission differs from its submitted configuration.");
    if (request.graders && contentHash(request.graders) !== contentHash(result.configuration.graders.map(grader => ({
      id:grader.id,version:grader.version,contentHash:grader.contentHash,mappings:grader.mappings ?? [],
    })))) throw new Error("Experiment admission differs from its selected graders or mappings.");
    return result;
  }
  async get(id: string, options: {signal?: AbortSignal} = {}) {
    return this.details(await this.request(`/${encodeURIComponent(Id.parse(id))}`, "GET", undefined, options.signal), id);
  }
  async list(value: z.input<typeof ExperimentListQuerySchema> = {}, signal?: AbortSignal) {
    const query = ExperimentListQuerySchema.parse(value);
    const params = new URLSearchParams(Object.entries(query).filter(([,value])=>value!==undefined).map(([key,value])=>[key,String(value)]));
    const page = z.object({items:z.array(z.unknown()).max(100),nextCursor:Id.nullable()}).strict().parse(await this.request(`?${params}`,"GET",undefined,signal));
    const items = await Promise.all(page.items.map(value=>this.details(value)));
    if (items.length > query.limit || new Set(items.map(item=>item.summary.id)).size !== items.length
      || page.nextCursor !== null && page.nextCursor !== items.at(-1)?.summary.id
      || items.some(item => query.projectId && item.request.project?.id !== query.projectId
        || query.datasetHash && item.request.taskset.contentHash !== query.datasetHash
        || query.status && item.summary.status !== query.status))
      throw new Error("Experiment page differs from its selected scope.");
    return {items,nextCursor:page.nextCursor};
  }
  async result(executionId: string, signal?: AbortSignal) {
    const value = z.object({ executionId: Id, passId: Id.nullable(), manifest: z.unknown(), result: z.unknown() }).strict()
      .parse(await this.request(`/${encodeURIComponent(Id.parse(executionId))}/result`, "GET", undefined, signal));
    const evidence = verifyExperimentEvidence(value);
    if (value.executionId !== executionId || evidence.manifest.teamId !== this.options.teamId
      || evidence.manifest.lineage?.execution.id !== executionId
      || evidence.manifest.lineage.scoringPassId !== value.passId) throw new Error("Experiment result identity mismatch.");
    return { ...evidence, executionId, passId: value.passId };
  }
  async cancel(id: string, signal?: AbortSignal) {
    return this.details(await this.request(`/${encodeURIComponent(Id.parse(id))}/cancel`, "POST", {}, signal), id);
  }
  /** Duplicate uses the original run snapshot; edits are submitted with run(). */
  async duplicate(id: string, operationId: string, signal?: AbortSignal) {
    const result = await this.details(await this.request(`/${encodeURIComponent(Id.parse(id))}/duplicate`, "POST", {operationId:Id.parse(operationId)}, signal));
    if (result.request.operationId !== operationId || result.configuration.sourceExperimentId !== id || result.summary.id === id)
      throw new Error("Duplicate Experiment admission differs from its source or operation.");
    return result;
  }
  async score(value: ExperimentScoringRequest, signal?: AbortSignal) {
    const request = ExperimentScoringRequestSchema.parse(value);
    const pass = this.pass(await this.request(`/${encodeURIComponent(request.execution.id)}/scoring-passes`, "POST", request, signal));
    if (contentHash(pass.request) !== contentHash(request)) throw new Error("Scoring admission differs from its submitted inputs.");
    return pass;
  }
  async scoringPass(id: string, signal?: AbortSignal) {
    return this.pass(await this.request(`/scoring-passes/${encodeURIComponent(Id.parse(id))}`, "GET", undefined, signal), id);
  }
  async scoringPasses(executionId: string, options: { afterId?: string; signal?: AbortSignal } = {}) {
    const params = new URLSearchParams(options.afterId ? { afterId: Id.parse(options.afterId) } : {});
    const page = z.object({ items: z.array(z.unknown()).max(30), nextCursor: Id.nullable() }).strict().parse(
      await this.request(`/${encodeURIComponent(Id.parse(executionId))}/scoring-passes?${params}`, "GET", undefined, options.signal));
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
  private async details(value: unknown, id?: string) {
    const result = await verifyExperimentRunDetails(value);
    if (result.summary.teamId !== this.options.teamId || id && result.summary.id !== id)
      throw new Error("Experiment identity mismatch.");
    return result;
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
