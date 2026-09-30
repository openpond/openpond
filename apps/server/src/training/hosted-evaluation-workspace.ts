import { hostedDatasetAuthoring } from "./hosted-dataset-authoring.js";
import { OpenPondExperimentInspectionClient } from "openpond-sdk/experiments";
import { OpenPondGraderInspectionClient, GraderCatalogQuerySchema, GraderUsageQuerySchema } from "openpond-sdk/learning";
import { OpenPondModelStarterAttemptsClient, ModelStarterAttemptChoicesQuerySchema } from "openpond-sdk/model-starter-attempts";
import { LearningReadRequestSchema, LearningCommandRequestSchema } from "openpond-sdk/learning";
import { z } from "zod";
import { OpenPondExperimentsClient, SaveExperimentSchema, PrepareHarnessExperimentSchema, StartExperimentSchema, ExperimentScoringRequestSchema } from "openpond-sdk/experiments";
import { OpenPondTrainingProjectClient } from "openpond-sdk/training-projects";
import { OpenPondDatasetWorkspaceClient, DatasetWorkspaceWriteSchema, DatasetWorkspacePublishSchema } from "openpond-sdk/dataset-workspaces";

const Id = z.string().trim().min(1).max(240);
const Envelope = z.object({ teamId: Id, projectId: Id.nullable().default(null), operation: z.enum([
  "createDraft", "saveDraft", "saveDraftFile", "draftFiles", "draftFile", "publishDraft", "uploadFolder", "case", "graderCatalog", "graderVersions", "graderUsage", "modelChoices", "learningRelay", "inventory", "dataset", "saveDataset", "validateDataset", "publishDataset", "definition", "save", "prepareHarness", "start", "executions", "execution", "result", "cancel", "retry", "score", "passes", "pass", "passResult", "cancelPass", "compare",
]), value: z.unknown().optional() }).strict();
const Identity = z.object({ id: Id }).passthrough();

/** The Desktop process owns credentials; the hosted service owns all dispatch,
 * accounting, immutable evidence and authorization. A transport retry carries
 * its original operation ID and never becomes another execution locally. */
export function createHostedEvaluationWorkspace(input: { resolveAccess: () => Promise<{ apiBaseUrl: string; token: string; teamId: string }>; fetch?: typeof fetch }) {
  return { async request(value: unknown) {
    const request = Envelope.parse(value);
    const access = await input.resolveAccess();
    if (request.teamId !== access.teamId) throw new Error("The active workspace changed. Refresh before continuing.");
    const options = { baseUrl: access.apiBaseUrl, apiKey: access.token, teamId: access.teamId, fetch: input.fetch };
    const experiments = new OpenPondExperimentsClient(options);
    const projects = new OpenPondTrainingProjectClient(options);
    const datasets = new OpenPondDatasetWorkspaceClient(options);
    const selectedProject = request.projectId ? await projects.get(request.projectId) : null;
    if (selectedProject) {
      const project = selectedProject;
      if (project.archived) throw new Error("This Project is archived. Select an available Project or All projects.");
    }
    const assertProject = (project: { id: string } | undefined) => {
      if (request.projectId && project?.id !== request.projectId) throw new Error("This resource belongs to another Project.");
    };
    const ownedDefinition = async (id: string) => { const result = await experiments.get(id); assertProject(result.request.project); return result; };
    const ownedExecution = async (id: string) => { const result = await experiments.execution(id); assertProject(result.request.project); return result; };
    const ownedPass = async (id: string) => { const result = await experiments.scoringPass(id); await ownedExecution(result.request.execution.id); return result; };
    if (["createDraft", "saveDraft", "saveDraftFile", "draftFiles", "draftFile", "publishDraft", "uploadFolder"].includes(request.operation)) return hostedDatasetAuthoring({ client: datasets, teamId: access.teamId, projectId: request.projectId, ownerScope: selectedProject?.ownerScope, operation: request.operation, value: request.value, requireDataset: async id => { const result = await datasets.get(id); assertProject(result.originProjectId ? { id: result.originProjectId } : undefined); return result; } });
    const inspection = new OpenPondGraderInspectionClient(options);
    if (request.operation === "graderCatalog") return inspection.catalog(GraderCatalogQuerySchema.parse({ ...z.object({}).passthrough().parse(request.value ?? {}), ...(request.projectId ? { projectId: request.projectId } : {}) }));
    if (request.operation === "graderVersions") { const data = z.object({ id: Id, beforeRevision: z.number().int().positive().optional() }).parse(request.value); return inspection.versions(data.id, { beforeRevision: data.beforeRevision }); }
    if (request.operation === "graderUsage") { const data = Identity.parse(request.value); return inspection.usage(data.id, GraderUsageQuerySchema.parse(data.query)); }
    if (request.operation === "case") { const data = z.object({ id: Id, receiptId: z.string().min(1).max(500), afterId: z.string().max(500).optional() }).parse(request.value); const execution = await ownedExecution(data.id); return new OpenPondExperimentInspectionClient(options).case(data.id, data.receiptId, { afterId: data.afterId, manifestHash: execution.summary.manifestHash }); }
    if (request.operation === "modelChoices") return new OpenPondModelStarterAttemptsClient(options).choices(ModelStarterAttemptChoicesQuerySchema.parse({ modelProjectId: null, ...z.object({ taskset: z.unknown() }).parse(request.value) }));
    if (request.operation === "learningRelay") {
      const relay = z.object({ endpoint: z.enum(["read", "commands"]), request: z.unknown() }).strict().parse(request.value);
      const body = (relay.endpoint === "read" ? LearningReadRequestSchema : LearningCommandRequestSchema).parse(relay.request);
      if (body.scope !== access.teamId) throw new Error("Grader workspace differs from the active connection.");
      const response = await (input.fetch ?? fetch)(`${access.apiBaseUrl}/v1/learning/${relay.endpoint}`, { method: "POST", redirect: "error", headers: { Authorization: `Bearer ${access.token}`, "X-OpenPond-Team-Id": access.teamId, "Content-Type": "application/json" }, body: JSON.stringify(body) });
      const result = await response.json();
      if (!response.ok) throw new Error(z.object({ message: z.string().optional() }).passthrough().parse(result).message ?? `Grader request failed (${response.status}).`);
      return result;
    }
    if (request.operation === "inventory") {
      const query = z.object({ cursor: Id.optional(), afterId: Id.optional(), search: z.string().max(200).optional() }).parse(request.value ?? {});
      const [projectPage, datasetPage, experimentPage] = await Promise.all([projects.list(), datasets.list({ cursor: query.cursor }), experiments.list({ projectId: request.projectId ?? undefined, afterId: query.afterId, search: query.search })]);
      return { teamId: access.teamId, apiOrigin: new URL(access.apiBaseUrl).origin, projects: projectPage, datasets: { ...datasetPage, datasets: datasetPage.datasets.filter(dataset => !request.projectId || dataset.originProjectId === request.projectId) }, experiments: experimentPage };
    }
    if (request.operation === "saveDataset") { const write = DatasetWorkspaceWriteSchema.parse(request.value); if (request.projectId !== (write.originProjectId ?? null)) throw new Error("Dataset origin differs from the selected Project."); return datasets.save(write); }
    if (["dataset", "validateDataset", "publishDataset"].includes(request.operation)) {
      const data = Identity.parse(request.value); const result = await datasets.get(data.id);
      assertProject(result.originProjectId ? { id: result.originProjectId } : undefined);
      if (request.operation === "dataset") return result;
      if (request.operation === "validateDataset") return datasets.validate(data.id, z.number().int().positive().parse(data.expectedRevision));
      return datasets.publish(data.id, DatasetWorkspacePublishSchema.parse(data.request));
    }
    if (request.operation === "prepareHarness") return experiments.prepareHarness(PrepareHarnessExperimentSchema.parse(request.value));
    if (request.operation === "save") { const data = SaveExperimentSchema.parse(request.value); assertProject(data.request.project); if (data.id) await ownedDefinition(data.id); return experiments.save(data); }
    if (request.operation === "start") { const data = StartExperimentSchema.parse(request.value); await ownedDefinition(data.definition.id); return experiments.start(data); }
    if (request.operation === "score") { const data = ExperimentScoringRequestSchema.parse(request.value); await ownedExecution(data.execution.id); return experiments.score(data); }
    if (request.operation === "compare") {
      const data = z.object({ baselineId: Id, candidateId: Id }).parse(request.value);
      await Promise.all([data.baselineId, data.candidateId].map(id => id.startsWith("score_") ? ownedPass(id) : ownedExecution(id)));
      return experiments.compare(data.baselineId, data.candidateId);
    }
    const data = Identity.parse(request.value);
    if (request.operation === "definition") return ownedDefinition(data.id);
    if (request.operation === "executions") { await ownedDefinition(data.id); return experiments.executions(data.id, { afterId: typeof data.afterId === "string" ? data.afterId : undefined }); }
    if (["pass", "passResult", "cancelPass"].includes(request.operation)) { const result = await ownedPass(data.id); return request.operation === "pass" ? result : request.operation === "passResult" ? experiments.scoringResult(data.id) : experiments.cancelScoringPass(data.id); }
    const result = await ownedExecution(data.id);
    if (request.operation === "execution") return result;
    if (request.operation === "result") return experiments.result(data.id);
    if (request.operation === "cancel") return experiments.cancel(data.id);
    if (request.operation === "retry") return experiments.retry(data.id, Id.parse(data.operationId));
    if (request.operation === "passes") return experiments.scoringPasses(data.id, { afterId: typeof data.afterId === "string" ? data.afterId : undefined });
    throw new Error("Unsupported evaluation operation.");
  } };
}
