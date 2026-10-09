import {EvaluationOperationRecoveryPageSchema} from "@openpond/contracts";
import {validateReviewedEvaluationIntent,validateReviewedEvaluationCommand} from "./reviewed-evaluation-operation.js";
import {OpenPondProfileEvaluationDiscoveryClient} from "openpond-sdk/experiments";
import { connectedWorkspaceOperations, connectedWorkspaceRequest } from "./connected-workspace.js";
import { ConnectedEvidenceClient } from "openpond-sdk/connected-evidence";
import { listOpChatModels } from "@openpond/cloud/hosted-chat";
import { contentHash } from "@openpond/harness";
import type { SqliteStore } from "../store/store.js";
import { experimentFeedbackSummary,createFeedbackSummaryReader } from "../evaluations/experiment-feedback-summary.js";
import { projectHostedCaseUsage } from "./hosted-case-usage.js";
import { OpenPondModelTasksetRunsClient } from "openpond-sdk/model-taskset-runs";
import { attachHostedDatasetGrader } from "./hosted-grader-attachment.js";
import { hostedDatasetAuthoring } from "./hosted-dataset-authoring.js";
import { OpenPondExperimentInspectionClient } from "openpond-sdk/experiments";
import { OpenPondGraderInspectionClient, GraderCatalogQuerySchema, GraderUsageQuerySchema } from "openpond-sdk/learning";
import { OpenPondModelStarterAttemptsClient, ModelStarterAttemptChoicesQuerySchema } from "openpond-sdk/model-starter-attempts";
import { OpenPondLearningClient, LearningReadRequestSchema, LearningCommandRequestSchema } from "openpond-sdk/learning";
import { z } from "zod";
import { OpenPondExperimentsClient, ExperimentListQuerySchema, RunExperimentSchema, PrepareHarnessExperimentSchema, ExperimentScoringRequestSchema } from "openpond-sdk/experiments";
import { OpenPondTrainingProjectClient } from "openpond-sdk/training-projects";
import { OpenPondDatasetPopulationClient, DatasetPopulationQuerySchema, OpenPondDatasetWorkspaceClient, DatasetWorkspaceWriteSchema, DatasetWorkspacePublishSchema } from "openpond-sdk/dataset-workspaces";
import { OpenPondDatasetMarketplaceClient, CatalogBrowse, CatalogCategoriesQuerySchema, AdoptCatalogDataset, PublishCatalogDataset, CatalogVisibilityChange } from "openpond-sdk/dataset-marketplace";
import { OpenPondTasksetCatalogClient } from "openpond-sdk/taskset-catalog";

const Id = z.string().trim().min(1).max(240);
const Envelope = z.object({ teamId: Id, projectId: Id.nullable().default(null), operation: z.enum([
  ...connectedWorkspaceOperations, "connectedSummary", "recordedExecution",
  "prepareOperation", "acknowledgeOperation", "retainOperation", "pendingOperations", "feedbackSummary", "harnessSources", "profileEvaluationDiscovery", "diagnostics",
  "datasetExperiments", "experiments", "projects", "marketplaceCategories", "marketplaceVisibility", "marketplacePublish", "marketplaceChangeVisibility", "marketplaceBrowse", "marketplaceDetail", "marketplacePreview", "marketplaceAdopt", "marketplaceRetained", "marketplaceChecks", "resolveDataset", "datasetPopulation", "catalogDatasets", "catalogDataset", "attachDatasetGrader", "createDraft", "saveDraft", "saveDraftFile", "draftFiles", "draftFile", "publishDraft", "uploadFolder", "caseUsage", "case", "graderModels", "graderCatalog", "graderVersions", "graderUsage", "modelChoices", "learningRelay", "inventory", "dataset", "datasetVersions", "datasetVersion", "beginDatasetVersion", "saveDataset", "validateDataset", "publishDataset", "run", "prepareHarness", "experiment", "duplicate", "result", "cancel", "score", "passes", "pass", "passResult", "cancelPass", "compare",
]), value: z.unknown().optional() }).strict();
const Identity = z.object({ id: Id }).passthrough();

/** The Desktop process owns credentials; the hosted service owns all dispatch,
 * accounting, immutable evidence and authorization. A transport retry carries
 * its original operation ID and never becomes another execution locally. */
export function createHostedEvaluationWorkspace(input: { store:Pick<SqliteStore,"prepareEvaluationOperation"|"acknowledgeEvaluationOperation"|"retainEvaluationOperation"|"pendingEvaluationOperations"|"readPendingEvaluationOperation">;
  resolveAccess: () => Promise<{ apiBaseUrl: string; token: string; teamId: string }>;resolveActorId?:()=>Promise<string>; fetch?: typeof fetch }) {
  const readFeedback=createFeedbackSummaryReader();
  return { async request(value: unknown) {
    const request = Envelope.parse(value);
    const access = await input.resolveAccess();
    if (request.teamId !== access.teamId) throw new Error("The active workspace changed. Refresh before continuing.");
    const options = { baseUrl: access.apiBaseUrl, apiKey: access.token, teamId: access.teamId, fetch: input.fetch };
    const experiments = new OpenPondExperimentsClient(options);
    const connected = new ConnectedEvidenceClient(options);
    const projects = new OpenPondTrainingProjectClient(options);
    const datasets = new OpenPondDatasetWorkspaceClient(options);
    const catalog = new OpenPondTasksetCatalogClient(options);
    if(["prepareOperation","acknowledgeOperation","retainOperation","pendingOperations"].includes(request.operation)) {
      const actorId=await input.resolveActorId?.();
      if(!actorId?.trim())throw new Error("An authenticated account identity is required to retain operation recovery.");
      const scopeHash=contentHash({actorId,apiOrigin:new URL(access.apiBaseUrl).origin,teamId:access.teamId,projectId:request.projectId});
      const fence=async()=> {if(await input.resolveActorId?.()!==actorId||contentHash(await input.resolveAccess())!==contentHash(access))throw new Error("Reviewed operation authority changed.");};
      const Action=z.enum(["advanced-refiner-start","experiment-evaluation-schedule"]);
      if(request.operation==="pendingOperations") {
        const data=z.object({action:Action,cursor:z.string().optional(),limit:z.number().int().min(1).max(100).default(100)}).strict().parse(request.value);
        const result=EvaluationOperationRecoveryPageSchema.parse(await input.store.pendingEvaluationOperations({...data,scopeHash}));await fence();return result;
      }
      const data=z.object({action:z.string().trim().min(1).max(100),intentHash:z.string().regex(/^[a-f0-9]{64}$/),
        ...(request.operation!=="prepareOperation"?{id:z.uuid()}:{}),
        ...(request.operation==="acknowledgeOperation"?{expectedPhase:z.literal("reviewed").optional()}:{}),
        ...(request.operation==="prepareOperation"?{reviewedIntent:z.unknown().optional()}:{}),
        ...(request.operation==="retainOperation"?{command:z.unknown(),phase:z.enum(["reviewed","dispatching"]).default("reviewed")}:{}),}).strict().parse(request.value);
      const scope={scopeHash,action:data.action,intentHash:data.intentHash};
      await fence();
      if(request.operation==="retainOperation") {
        Action.parse(data.action);const id=z.uuid().parse("id" in data?data.id:undefined),command="command" in data?data.command:undefined;
        const original=await input.store.readPendingEvaluationOperation({...scope,id});await fence();
        const validated=validateReviewedEvaluationCommand({...scope,id,actorId,teamId:access.teamId,projectId:request.projectId,intent:original.reviewedIntent,command});
        const result=await input.store.retainEvaluationOperation({...scope,id,command:validated,phase:z.enum(["reviewed","dispatching"]).parse("phase" in data?data.phase:"reviewed")});await fence();return result;
      }
      const result=request.operation==="prepareOperation"?await input.store.prepareEvaluationOperation({...scope,...("reviewedIntent" in data&&data.reviewedIntent!==undefined?{reviewedIntent:validateReviewedEvaluationIntent(data.action,data.reviewedIntent)}:{})})
        :await input.store.acknowledgeEvaluationOperation({...scope,id:z.uuid().parse("id" in data?data.id:undefined),...("expectedPhase" in data&&data.expectedPhase!==undefined?{expectedPhase:z.literal("reviewed").parse(data.expectedPhase)}:{})});
      await fence();return result;
    }
    const selectedProject = request.projectId ? await projects.get(request.projectId) : null;
    if (selectedProject) {
      const project = selectedProject;
      if (project.archived) throw new Error("This Project is archived. Select an available Project or All projects.");
    }
    const assertProject = (project: { id: string } | undefined) => {
      if (request.projectId && project?.id !== request.projectId) throw new Error("This resource belongs to another Project.");
    };
    const requireDataset = async (id: string) => {
      const result = await datasets.get(id);
      if (request.projectId && result.originProjectId !== request.projectId && !selectedProject?.content.resources.some(resource => resource.kind === "dataset" && (resource.resourceId === result.datasetId || resource.resourceId === result.publication?.tasksetId || resource.release && result.publication && resource.release.id === result.publication.release.id && resource.release.contentHash === result.publication.release.contentHash))) throw new Error("This Dataset is not associated with the selected Project.");
      return result;
    };
    const ownedExecution = async (id: string) => { const result = await experiments.get(id); assertProject(result.request.project); return result; };
    const ownedRecorded = async (id: string) => { const result = await connected.recordedExecution(id); assertProject({id:result.request.projectId}); return result; };
    const ownedPass = async (id: string) => { const result = await experiments.scoringPass(id);
      if(result.request.executionKind === "recorded_evidence") await ownedRecorded(result.request.execution.id);
      else await ownedExecution(result.request.execution.id); return result; };
    const connectedResult = await connectedWorkspaceRequest(connected,request.operation,request.value,request.projectId,requireDataset);
    if (connectedResult) return connectedResult.value;
    if (request.operation === "connectedSummary") {
      const value = z.object({from:z.iso.datetime(),to:z.iso.datetime(),projectId:Id.optional()}).strict().parse(request.value);
      if (request.projectId && value.projectId !== request.projectId) throw new Error("This summary belongs to another Project.");
      return connected.homeSummary(value);
    }
    if(request.operation === "recordedExecution") return ownedRecorded(Identity.parse(request.value).id);
    if (request.operation === "profileEvaluationDiscovery") {
      const data=z.object({profileRepositoryId:Id}).strict().parse(request.value);
      if(selectedProject&&!selectedProject.content.targets.some(item =>
        (item.target.kind==="harness"||item.target.kind==="suite")&&item.target.profileRepositoryId===data.profileRepositoryId))
        throw new Error("This Profile evaluation source is not selected in the current Project.");
      return new OpenPondProfileEvaluationDiscoveryClient(options).read({...data,...(request.projectId?{trainingProjectId:request.projectId}:{})});
    }
    if (request.operation === "harnessSources") return experiments.harnessSources(
      z.object({cursor:z.string().min(1).max(8192).optional()}).strict().parse(request.value??{}),
    );
    if (["createDraft", "saveDraft", "saveDraftFile", "draftFiles", "draftFile", "publishDraft", "uploadFolder"].includes(request.operation)) return hostedDatasetAuthoring({ client: datasets, teamId: access.teamId, projectId: request.projectId, ownerScope: selectedProject?.ownerScope, operation: request.operation, value: request.value, requireDataset });
    if (request.operation === "attachDatasetGrader") return attachHostedDatasetGrader({ value: request.value, learning: new OpenPondLearningClient({ ...options, scope: access.teamId }), datasets, requireDataset });
    const inspection = new OpenPondGraderInspectionClient(options);
    if (request.operation === "datasetExperiments") {
      const query = ExperimentListQuerySchema.pick({ datasetHash: true, afterId: true, search: true, limit: true }).extend({ datasetHash: ExperimentListQuerySchema.shape.datasetHash.unwrap() }).strict().parse(request.value);
      return experiments.list({ ...query, ...(request.projectId ? { projectId: request.projectId } : {}) });
    }
    if (request.operation === "experiments") return experiments.list({ ...ExperimentListQuerySchema.parse(request.value ?? {}), ...(request.projectId ? { projectId: request.projectId } : {}) });
    if (request.operation === "projects") return projects.list(z.object({ cursor: Id.optional() }).strict().parse(request.value ?? {}));
    if (request.operation === "graderModels") {
      const models = z.object({ data: z.array(z.object({ id: z.string().min(1).max(500), display_name: z.string().max(500).optional(), endpoints: z.array(z.string()).optional(), capabilities: z.object({ samplingParameters: z.boolean().optional() }).passthrough().optional() }).passthrough()).max(200) }).passthrough().parse(await listOpChatModels({ apiBaseUrl: `${access.apiBaseUrl}/v1`, token: access.token }));
      return { models: models.data.filter(model => model.endpoints?.includes("chat.completions")).map(model => ({ id: model.id, name: model.display_name ?? model.id, supportsSampling: model.capabilities?.samplingParameters === true })) };
    }
    if (request.operation === "graderCatalog") { const { allProjects, ...query } = z.object({ allProjects: z.boolean().optional() }).passthrough().parse(request.value ?? {}); return inspection.catalog(GraderCatalogQuerySchema.parse({ ...query, ...(request.projectId && !allProjects ? { projectId: request.projectId } : {}) })); }
    if (request.operation === "graderVersions") { const data = z.object({ id: Id, beforeRevision: z.number().int().positive().optional() }).parse(request.value); return inspection.versions(data.id, { beforeRevision: data.beforeRevision }); }
    if (request.operation === "graderUsage") { const data = Identity.parse(request.value); return inspection.usage(data.id, GraderUsageQuerySchema.parse(data.query)); }
    if (request.operation === "feedbackSummary") {
      const data=z.object({id:Id}).strict().parse(request.value),run=await ownedExecution(data.id);
      if(!run.summary.resultAvailable)throw new Error("This Experiment has no retained result yet.");
      return readFeedback(contentHash({origin:access.apiBaseUrl,teamId:access.teamId,projectId:request.projectId,credentialHash:contentHash(access.token),id:data.id,manifestHash:run.summary.manifestHash}),async()=> {
        const evidence=await experiments.result(data.id);
        return experimentFeedbackSummary({experimentId:data.id,executionManifestHash:run.summary.manifestHash,total:run.summary.totalCount,graders:run.configuration.graders,evidence});
      });
    }
    if (request.operation === "diagnostics") {
      const data=z.object({id:Id,afterSequence:z.number().int().nonnegative().optional(),afterCallId:z.string().min(1).max(500).optional()}).strict().parse(request.value);
      const execution=await ownedExecution(data.id);
      return experiments.diagnostics(data.id,{...data,manifestHash:execution.summary.manifestHash});
    }
    if (request.operation === "caseUsage") { const data = z.object({ id: Id, receiptId: z.string().min(1).max(500) }).strict().parse(request.value); const run = await ownedExecution(data.id); const result = await new OpenPondModelTasksetRunsClient(options).result(data.id); return projectHostedCaseUsage(run, result, data.receiptId); }
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
    const marketplace = new OpenPondDatasetMarketplaceClient(options);
    if (request.operation === "marketplaceCategories") return marketplace.categories(CatalogCategoriesQuerySchema.parse(request.value ?? {}));
    if (request.operation === "marketplaceVisibility") return marketplace.visibility(Identity.parse(request.value).id);
    if (request.operation === "marketplacePublish") return marketplace.publish(PublishCatalogDataset.parse(request.value));
    if (request.operation === "marketplaceChangeVisibility") return marketplace.changeVisibility(CatalogVisibilityChange.parse(request.value));
    if (request.operation === "marketplaceBrowse") return marketplace.browse(CatalogBrowse.parse(request.value ?? {}));
    if (request.operation === "marketplaceDetail") return marketplace.get(Identity.parse(request.value).id);
    if (request.operation === "marketplacePreview") return marketplace.preview(Identity.parse(request.value).id);
    if (request.operation === "marketplaceRetained") return marketplace.retained(Identity.parse(request.value).id);
    if (request.operation === "marketplaceChecks") { const data = z.object({ id: Id, operationId: Id }).strict().parse(request.value); return marketplace.checks(data.operationId, data.id); }
    if (request.operation === "marketplaceAdopt") { const data = AdoptCatalogDataset.parse(request.value); if ((data.projectId ?? null) !== request.projectId) throw new Error("Dataset import Project differs from the selected Project."); return marketplace.adopt(data); }
    if (request.operation === "catalogDatasets") return catalog.list({ ...z.object({ afterId: Id.optional(), limit: z.number().int().min(1).max(100).optional() }).strict().parse(request.value ?? {}), ...(request.projectId ? {projectId:request.projectId} : {}) });
    if (request.operation === "catalogDataset") return catalog.get(Identity.parse(request.value).id);
    if (request.operation === "resolveDataset") return catalog.resolve(z.object({ release: DatasetPopulationQuerySchema.shape.release }).strict().parse(request.value).release);
    if (request.operation === "datasetPopulation") return new OpenPondDatasetPopulationClient(options).read(DatasetPopulationQuerySchema.parse(request.value));
    if (request.operation === "inventory") {
      const query = z.object({ cursor: z.string().max(2_000).optional(), catalogCursor: z.string().max(2_000).optional(), afterId: Id.optional(), search: z.string().max(100).optional(), sort: z.enum(["id", "name", "updated"]).optional() }).parse(request.value ?? {});
      const [projectPage, datasetPage, experimentPage, releasedDatasets] = await Promise.all([projects.list(), datasets.list({ cursor: query.cursor, projectId: request.projectId ?? undefined, search: query.search, sort: query.sort }), experiments.list({ ...(request.projectId ? { projectId: request.projectId } : {}), ...(query.afterId ? { afterId: query.afterId } : {}), ...(query.search !== undefined ? { search: query.search } : {}) }), catalog.list({ limit: 100, afterId: query.catalogCursor, ...(request.projectId ? { projectId: request.projectId } : {}), search: query.search, sort: query.sort })]);
      return { teamId: access.teamId, apiOrigin: new URL(access.apiBaseUrl).origin, projects: { ...projectPage, projects: selectedProject && !projectPage.projects.some(project => project.id === selectedProject.id) ? [...projectPage.projects, selectedProject] : projectPage.projects }, releasedDatasets, datasets: datasetPage, experiments: experimentPage };
    }
    if (request.operation === "saveDataset") { const write = DatasetWorkspaceWriteSchema.parse(request.value); if (request.projectId !== (write.originProjectId ?? null)) throw new Error("Dataset origin differs from the selected Project."); return datasets.save(write); }
    if (["dataset", "datasetVersions", "datasetVersion", "beginDatasetVersion", "validateDataset", "publishDataset"].includes(request.operation)) {
      const data = Identity.parse(request.value); const result = await requireDataset(data.id);
      if (request.operation === "dataset") return result;
      if (request.operation === "datasetVersions") return datasets.versions(data.id, { beforeRevision: data.beforeRevision === undefined ? undefined : z.number().int().positive().parse(data.beforeRevision) });
      if (request.operation === "datasetVersion") return datasets.version(data.id, z.number().int().positive().parse(data.revision));
      if (request.operation === "beginDatasetVersion") return datasets.beginVersion(data.id, z.object({ operationId: Id, expectedRevision: z.number().int().positive() }).strict().parse(data.request));
      if (request.operation === "validateDataset") return datasets.validate(data.id, z.number().int().positive().parse(data.expectedRevision));
      return datasets.publish(data.id, DatasetWorkspacePublishSchema.parse(data.request));
    }
    if (request.operation === "prepareHarness") return experiments.prepareHarness(PrepareHarnessExperimentSchema.parse(request.value));
    if (request.operation === "run") { const data = RunExperimentSchema.parse(request.value); assertProject(data.request.project); if (data.sourceExperimentId) await ownedExecution(data.sourceExperimentId); return experiments.run(data); }
    if (request.operation === "score") { const data = ExperimentScoringRequestSchema.parse(request.value); if(data.executionKind === "recorded_evidence") await ownedRecorded(data.execution.id); else await ownedExecution(data.execution.id); return experiments.score(data); }
    if (request.operation === "compare") {
      const data = z.object({ baselineId: Id, candidateId: Id }).parse(request.value);
      await Promise.all([data.baselineId, data.candidateId].map(id => id.startsWith("score_") ? ownedPass(id) : ownedExecution(id)));
      return experiments.compare(data.baselineId, data.candidateId);
    }
    const data = Identity.parse(request.value);
    if (["pass", "passResult", "cancelPass"].includes(request.operation)) { const result = await ownedPass(data.id); return request.operation === "pass" ? result : request.operation === "passResult" ? experiments.scoringResult(data.id) : experiments.cancelScoringPass(data.id); }
    if(request.operation === "passes" && data.executionKind === "recorded_evidence") {
      await ownedRecorded(data.id); return experiments.scoringPasses(data.id,{executionKind:"recorded_evidence",afterId:typeof data.afterId==="string"?data.afterId:undefined});
    }
    const result = await ownedExecution(data.id);
    if (request.operation === "experiment") return result;
    if (request.operation === "result") return experiments.result(data.id);
    if (request.operation === "cancel") return experiments.cancel(data.id);
    if (request.operation === "duplicate") return experiments.duplicate(data.id, Id.parse(data.operationId));
    if (request.operation === "passes") return experiments.scoringPasses(data.id, { afterId: typeof data.afterId === "string" ? data.afterId : undefined });
    throw new Error("Unsupported evaluation operation.");
  } };
}
