import { readFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { AgentSnapshotSchema, HarnessReleaseSchema, loadReleasedProfileWorkflowCatalogAssets } from "@openpond/harness";
import { compileHostedProfileRelease } from "./hosted-profile-compiler.js";
import { LocalHarnessReleaseRecordSchema } from "./store/store-harness-release-record.js";
import { profileEvaluationsForRuntime } from "./harness/local-profile-evaluation-runtime.js";
import { loadReleasedProfileEvaluationTaskset } from "./harness/local-profile-evaluation-taskset.js";
import { createProfileEvaluationRunPreparationService } from "./harness/profile-evaluation-run-preparation.js";

const requestSchema = z.object({
  compile: z.object({ repoPath: z.string(), profileId: z.string(), repositoryId: z.string(),
    sourceRevision: z.string(), workspaceId: z.string(), outputDir: z.string() }).strict(),
  action: z.enum(["catalog", "prepare"]), request: z.unknown().optional(),
}).strict();

/** Read-only preparation uses a temporary immutable source cache, never an owner database. */
export async function prepareHostedProfileEvaluation(input: z.infer<typeof requestSchema>) {
  const compiled = await compileHostedProfileRelease(input.compile);
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
  return createProfileEvaluationRunPreparationService({
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
