import {preflightProfilePrivateGrading} from "./harness/profile-private-grading.js";
import { readFile, realpath, lstat } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { verifyExternalDatasetPackage, type ExternalDatasetGraderPin } from "openpond-sdk/experiments";
import {validateTasksetPackage} from "openpond-sdk/taskset-packages";
import {contentHash} from "@openpond/harness";
import {ProfileSourceCandidateSchema} from "@openpond/evals";
import {compiledCandidateExecutableIdentity} from "./harness/experiment-candidate-equivalence.js";
import {compileLocalHarnessSource} from "./harness/local-harness-workspace-service.js";
import { AgentSnapshotSchema, HarnessReleaseSchema, loadReleasedProfileWorkflowCatalogAssets } from "@openpond/harness";
import { compileHostedProfileRelease } from "./hosted-profile-compiler.js";
import { LocalHarnessReleaseRecordSchema } from "./store/store-harness-release-record.js";
import { profileEvaluationsForRuntime } from "./harness/local-profile-evaluation-runtime.js";
import { loadReleasedProfileEvaluationTaskset } from "./harness/local-profile-evaluation-taskset.js";
import { createProfileEvaluationRunPreparationService } from "./harness/profile-evaluation-run-preparation.js";

const requestSchema = z.object({
  compile: z.object({ repoPath: z.string(), profileId: z.string(), repositoryId: z.string(),
    sourceRevision: z.string(), workspaceId: z.string(), outputDir: z.string() }).strict(),
  externalDatasetPackage: z.string().regex(/^external-dataset-[a-f0-9-]+\.json$/).optional(),
  sourceCandidate:ProfileSourceCandidateSchema.optional(),
  action: z.enum(["catalog", "prepare"]), request: z.unknown().optional(),
}).strict();

/** Read-only preparation uses a temporary immutable source cache, never an owner database. */
export async function prepareHostedProfileEvaluation(input: z.infer<typeof requestSchema>) {
  const compiled = await compileHostedProfileRelease(input.compile);
  if(input.sourceCandidate){const candidate=await compileLocalHarnessSource({workspaceId:typeof compiled.agentSnapshot.metadata.workspaceId==="string"?compiled.agentSnapshot.metadata.workspaceId:compiled.workspaceId,sourceDir:path.join(compiled.bundlePath,"source")});if(contentHash(input.sourceCandidate.harnessRelease)!==contentHash({id:compiled.harnessRelease.id,contentHash:compiled.harnessRelease.contentHash})||compiledCandidateExecutableIdentity(candidate).protectedClosureHash!==input.sourceCandidate.protectedClosureHash)throw new Error("Private candidate source differs from its actual frozen compiled release.");}
  const runtime = { release: LocalHarnessReleaseRecordSchema.parse({
    schemaVersion: "openpond.localHarnessReleaseRecord.v1", workspaceId: compiled.workspaceId,
    sourceRevision: compiled.sourceRevision, agentSnapshot: AgentSnapshotSchema.parse(compiled.agentSnapshot),
    harnessRelease: HarnessReleaseSchema.parse(compiled.harnessRelease), bundlePath: compiled.bundlePath,
    createdAt: new Date().toISOString(),
  }) };
  const ref = { source: "openpond_git" as const, profileId: input.compile.profileId, repositoryId: input.compile.repositoryId };
  const sourceRevision = input.compile.sourceRevision;
  const harnessRelease = { id: compiled.harnessRelease.id, contentHash: compiled.harnessRelease.contentHash };
  const loadCatalog: Parameters<typeof createProfileEvaluationRunPreparationService>[0]["loadCatalog"] = async request =>
    profileEvaluationsForRuntime({ ...request, runtime });
  const catalog = await loadCatalog({ ref, sourceRevision, harnessRelease });
  const sourceRoot = path.join(compiled.bundlePath, "source");
  const workflows = compiled.harnessRelease.files.some(file => file.path === "workflows/catalog.json")
    ? await (async () => {
      const assets = loadReleasedProfileWorkflowCatalogAssets({ agentSnapshot: compiled.agentSnapshot,
        harnessRelease: compiled.harnessRelease,
        catalogBytes: await readFile(path.join(sourceRoot, "workflows/catalog.json")),
        actionBytes: await readFile(path.join(sourceRoot, "workflows/actions.json")),
      });
      return assets.catalog.workflows.map(workflow => ({ workflow, binding: {
        schemaVersion: "openpond.profileWorkflowBinding.v1" as const, profileId: ref.profileId,
        sourceRevision, harnessRelease, catalogHash: assets.catalogHash, workflowId: workflow.id,
      } }));
    })() : [];
  const selected = { profileRef: ref, sourceRevision, harnessRelease, workflows };
  if (input.action === "catalog") return { ...catalog, workflows };
  const external = input.externalDatasetPackage ? await (async()=> {
    const root=await realpath(input.compile.outputDir),file=path.join(root,input.externalDatasetPackage!);
    const stat=await lstat(file);if(!stat.isFile()||stat.isSymbolicLink()||stat.size>32*1024*1024||await realpath(file)!==file)throw new Error("External Dataset cache is outside its bounded verifier storage.");
    const value=z.object({packageValue:z.unknown(),graders:z.array(z.object({id:z.string(),version:z.string(),contentHash:z.string(),feedbackKey:z.string(),release:z.object({id:z.string(),revision:z.union([z.string(),z.number()]),contentHash:z.string()}).strict().nullable()}).strict()).max(100)}).strict().parse(JSON.parse(await readFile(file,"utf8")));
    return{packageValue:validateTasksetPackage(value.packageValue),graders:value.graders satisfies ExternalDatasetGraderPin[]};
  })():null;
  return createProfileEvaluationRunPreparationService({
    privateGradingPreflight: value => preflightProfilePrivateGrading(value, false),
    sourceCandidate:input.sourceCandidate,
    resolveExternalDataset:external?async(binding)=>{
      const packageValue=verifyExternalDatasetPackage({binding,...external});
      const protectedHash=contentHash(compiled.harnessRelease.files.filter(file=>file.visibility!=="policy").map(asset=>({path:asset.path,asset})));
      if(binding.protectedProfileClosureHash!==protectedHash)throw new Error("The selected Profile's protected evaluator closure changed.");
      return{binding,packageValue,authorize:async()=>{verifyExternalDatasetPackage({binding,...external});}};
    }:undefined,
    loadCatalog, selectedWorkflows: async () => selected, placement: "remote",
    loadTasksetPackage: async definition => {
      const packageValue = await loadReleasedProfileEvaluationTaskset({ runtime, definition, harnessRelease });
      if (!packageValue) throw new Error("Hosted evaluation Taskset is absent from its published Profile release.");
      return packageValue;
    },
    modelConfigurationHash: async (modelRef, request) => {
      if (modelRef.providerId !== "openpond" || !request.hostModelConfigurationHash) {
        throw new Error("Hosted evaluation preparation requires a trusted model configuration receipt.");
      }
      return request.hostModelConfigurationHash;
    },
  })(input.request);
}

export async function runHostedProfileEvaluationCli(args: string[]): Promise<void> {
  if (args.length !== 1 || args[0]!.length > 48_000 || !/^[A-Za-z0-9_-]+$/.test(args[0]!)) {
    throw new Error("Hosted Profile evaluation preparation argument is invalid.");
  }
  const request = requestSchema.parse(JSON.parse(Buffer.from(args[0]!, "base64url").toString("utf8")));
  process.stdout.write(`${JSON.stringify(await prepareHostedProfileEvaluation(request))}\n`);
}
