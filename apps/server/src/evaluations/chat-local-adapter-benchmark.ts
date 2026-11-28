import { z } from "zod";
import { contentHash } from "@openpond/harness";
import { SessionResourceDraftSchema } from "@openpond/contracts/requests";
import { LocalAdapterBenchmarkSetupSchema } from "openpond-sdk/training";
import type { SqliteStore } from "../store/store.js";
import { chatExperimentContext, type createChatExperimentScopes } from "../training/chat-experiment-scope.js";
import { localDatasetSummary } from "../training/local-dataset-service.js";
import type { createChatExperiments } from "./chat-experiments.js";
import { createLocalSftBenchmarkInference } from "./local-sft-benchmark-inference.js";

const session = z.object({ sessionId: z.string().min(1).max(240) });
const operation = session.extend({ operationId: z.uuid(), revision: z.number().int().positive() });
const requestSchema = z.discriminatedUnion("operation", [
  session.extend({ operation: z.literal("inspect") }).strict(),
  operation.extend({ operation: z.literal("review"), name: z.string().trim().min(1).max(500), setup: LocalAdapterBenchmarkSetupSchema }).strict(),
  operation.extend({ operation: z.literal("start") }).strict(),
]);

export async function handleLocalAdapterBenchmark(deps: {
  store: SqliteStore;
  home: string;
  scopes: ReturnType<typeof createChatExperimentScopes>;
  experiments: Awaited<ReturnType<typeof createChatExperiments>>;
}, raw: unknown) {
  const request = requestSchema.parse(raw);
  const { store, home, scopes, experiments } = deps;
  const current = await store.getSession(request.sessionId);
  const { data: resource } = SessionResourceDraftSchema.safeParse(current?.metadata?.resourceDraft);
  const candidate = resource?.benchmarkVersion;
  if (!current || current.systemKind || ["sandbox", "sandbox_template"].includes(current.workspaceKind ?? "") ||
    resource?.kind !== "benchmark" || candidate?.location !== "local")
    throw new Error("Open the original Benchmark for this saved local Model Version.");
  const currentScope = chatExperimentContext(current.metadata).scopes.find(scope => scope.draft?.id === resource.id);
  if (!currentScope?.draft || currentScope.storedDraft) throw new Error("The local Benchmark definition is unavailable.");
  const draft = currentScope.draft;
  const revision = currentScope.draftRevision ?? 1;
  const runtime = createLocalSftBenchmarkInference(store, home);

  if (request.operation === "inspect") {
    const selected = await runtime.resolve(candidate, "cpu", resource.profileId);
    const [projects, versions, lineages, datasets, results] = await Promise.all([
      store.listModelProjects(), store.listModelVersions(), store.listModelArtifactLineage(),
      store.listLocalDatasetListings(),
      Promise.all(currentScope.runs.slice(-12).reverse().map(async run => {
        const record = await experiments.service.read({ teamId: experiments.scope, id: run.id });
        return experiments.summary(record);
      })),
    ]);
    const byProject = new Map(projects.filter(project => project.profileId === resource.profileId).map(project => [project.id, project]));
    const byLineage = new Map(lineages.filter(lineage => lineage.status === "imported").map(lineage => [lineage.id, lineage]));
    const baselines = versions.flatMap(version => {
      const project = byProject.get(version.modelId);
      const lineage = version.artifactLineageId && byLineage.get(version.artifactLineageId);
      if (!version.localSft || version.status !== "available" || !project || !lineage || lineage.id === candidate.versionId) return [];
      return [{ label: `${project.name} Version ${version.version}`, source: { location: "local", projectId: project.id,
        versionId: lineage.id, artifactId: lineage.artifactId, bundleHash: lineage.bundleHash } }];
    });
    return { draftId: draft.id, revision, name: draft.name, candidate, candidateLabel: `${selected.project.name} Version ${selected.version.version}`,
      setup: draft.localAdapterBenchmark ?? null, datasets: datasets.map(localDatasetSummary), baselines, results };
  }
  if (request.operation === "review") {
    const { setup } = request;
    if (contentHash(setup.candidate) !== contentHash(candidate)) throw new Error("Keep the Model Version that opened this Benchmark.");
    const dataset = await store.readLocalDataset(setup.dataset.id, setup.dataset.revision);
    if (!dataset || dataset.workspace.contentHash !== setup.dataset.contentHash)
      throw new Error("Select the exact local Dataset revision before saving this Benchmark.");
    await Promise.all([candidate, ...(setup.baseline ? [setup.baseline] : [])].map(source => runtime.resolve(source, setup.device, resource.profileId)));
    const saved = await scopes.saveLocalDraft(current.id, currentScope.id, {
      operationId: request.operationId, expectedRevision: request.revision,
      draft: { ...draft, name: request.name, localAdapterBenchmark: setup },
    });
    const updated = saved.scopes.find(scope => scope.id === currentScope.id)!;
    return { draftId: draft.id, revision: updated.draftRevision ?? 1 };
  }
  const setup = draft.localAdapterBenchmark;
  if (request.revision !== revision || !setup || contentHash(setup.candidate) !== contentHash(candidate))
    throw new Error("Review and save this exact Benchmark revision before starting.");
  const result = await experiments.runSavedAdapterBenchmark({
    operationId: request.operationId, name: draft.name, setup, profileId: resource.profileId,
    benchmark: { id: draft.id, revision, draftHash: contentHash(draft), setupHash: contentHash(setup) },
  });
  await scopes.recordLocalAdapterBenchmarkRuns(current.id, currentScope.id, result.summaries);
  return result;
}
