import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import type {
  ModelArtifactLineage,
  TrainingArtifact,
  TrainingJob,
  TrainingPlan,
} from "@openpond/contracts";
import { selectPortableModelArtifacts } from "../apps/server/src/training/training-artifact-package.js";

const QWEN3_8B_BASE_PROFILE = {
  id: "qwen3-8b-b968826d",
  repository: "Qwen/Qwen3-8B",
  revision: "b968826d9c46dd6066d109eabc6255188de91218",
} as const;
const PORTABLE_ADAPTER_PATTERN =
  /^adapter_model(?:-\d{5}-of-\d{5})?\.safetensors$/;
const OPTIMIZER_PATTERN = /^optimizer_[0-9]+\.pt$/;

const args = parseArgs(process.argv.slice(2));
const database = new DatabaseSync(path.join(args.storeDir, "state.sqlite"), {
  readOnly: true,
});
try {
  const jobs = payloadRows<TrainingJob>(
    database,
    "SELECT payload FROM training_jobs",
  );
  const job = jobs.find(
    (candidate) =>
      candidate.metadata.providerRunId === args.providerRunId,
  );
  if (!job) throw new Error("The requested OpenPond provider run was not found.");
  if (
    job.status !== "succeeded" ||
    job.metadata.provider !== "fireworks" ||
    job.metadata.trainingMethod !== "grpo" ||
    !positiveInteger(job.metadata.optimizerUpdatesObserved)
  ) {
    throw new Error(
      "The requested run is not a completed optimizer-backed Fireworks GRPO job.",
    );
  }
  const plan = payloadRows<TrainingPlan>(
    database,
    "SELECT payload FROM training_plans WHERE id = ?",
    [job.planId],
  )[0];
  if (!plan || plan.recipe.method !== "grpo") {
    throw new Error("The GRPO job lost its authoritative training plan.");
  }
  const lineages = payloadRows<ModelArtifactLineage>(
    database,
    "SELECT payload FROM model_artifact_lineage",
  ).filter((candidate) => candidate.jobId === job.id);
  if (lineages.length !== 1 || lineages[0]!.status !== "imported") {
    throw new Error(
      "The GRPO job must have exactly one imported Model lineage.",
    );
  }
  const lineage = lineages[0]!;
  const artifacts = payloadRows<TrainingArtifact>(
    database,
    "SELECT payload FROM training_artifacts WHERE job_id = ?",
    [job.id],
  );
  const lineageArtifact = artifacts.find(
    (artifact) => artifact.id === lineage.artifactId,
  );
  if (!lineageArtifact || lineageArtifact.kind !== "adapter") {
    throw new Error("The Model lineage lost its source adapter artifact.");
  }

  const portable = selectPortableModelArtifacts(artifacts)
    .filter(
      ({ name }) =>
        name === "adapter_config.json" ||
        name === "adapter_model.safetensors.index.json" ||
        PORTABLE_ADAPTER_PATTERN.test(name),
    )
    .sort((left, right) => left.name.localeCompare(right.name));
  if (
    portable.length < 2 ||
    !portable.some(({ name }) => name === "adapter_config.json") ||
    !portable.some(({ name }) => PORTABLE_ADAPTER_PATTERN.test(name))
  ) {
    throw new Error("The GRPO job has no complete portable PEFT package.");
  }
  const sourceArtifact =
    portable.find(({ name }) => name === "adapter_model.safetensors")
      ?.artifact ??
    portable.find(
      ({ name }) => name === "adapter_model.safetensors.index.json",
    )?.artifact ??
    portable.find(({ name }) => PORTABLE_ADAPTER_PATTERN.test(name))
      ?.artifact;
  if (!sourceArtifact) {
    throw new Error("The portable package lost its source weights artifact.");
  }
  const sourceBaseModel = sourceBaseIdentity(portable[0]!.artifact, job);
  for (const { artifact } of portable) {
    if (
      JSON.stringify(sourceBaseIdentity(artifact, job)) !==
      JSON.stringify(sourceBaseModel)
    ) {
      throw new Error("Portable adapter files disagree on source base identity.");
    }
  }

  const optimizerByName = new Map<string, TrainingArtifact>();
  for (const artifact of artifacts) {
    const providerFilename = artifact.metadata.providerFilename;
    if (typeof providerFilename !== "string") continue;
    const name = path.posix.basename(providerFilename.replaceAll("\\", "/"));
    if (!OPTIMIZER_PATTERN.test(name)) continue;
    const current = optimizerByName.get(name);
    if (!current || providerFilename.length < String(
      current.metadata.providerFilename,
    ).length) {
      optimizerByName.set(name, artifact);
    }
  }
  const optimizerArtifacts = [...optimizerByName.entries()].sort(
    ([left], [right]) => left.localeCompare(right),
  );
  if (!optimizerArtifacts.length) {
    throw new Error("The GRPO job has no retained optimizer artifact proof.");
  }

  await Promise.all([
    ...portable.map(({ artifact }) => verifyArtifact(artifact)),
    ...optimizerArtifacts.map(([, artifact]) => verifyArtifact(artifact)),
  ]);
  const evaluationArtifact = lineage.frozenEvaluationArtifactId
    ? artifacts.find(
        (artifact) => artifact.id === lineage.frozenEvaluationArtifactId,
      ) ?? null
    : null;
  if (lineage.frozenEvaluationArtifactId && !evaluationArtifact) {
    throw new Error("The Model lineage lost its frozen evaluation artifact.");
  }
  if (evaluationArtifact) await verifyArtifact(evaluationArtifact);

  const providerRunId = requiredString(
    job.metadata.providerRunId,
    "providerRunId",
  );
  const outputModelName = requiredString(
    job.metadata.outputModelName,
    "outputModelName",
  );
  const metadata = {
    schemaVersion: "openpond.internalGrpoQaImport.v1",
    label:
      args.label ??
      `OpenPond GRPO QA ${providerRunId.slice(-12)}`,
    sourceManifest: {
      schemaVersion: "openpond.internalGrpoSourceManifest.v1",
      lineageId: lineage.id,
      trainingJobId: job.id,
      trainingPlanId: plan.id,
      trainingMethod: "grpo",
      providerRunId,
      sourcePolicyOrCheckpoint: outputModelName,
      sourceArtifact: {
        id: sourceArtifact.id,
        sha256: sourceArtifact.sha256,
      },
      sourceBaseModel,
      candidateBaseProfile: QWEN3_8B_BASE_PROFILE,
      taskset: {
        id: lineage.tasksetId,
        sha256: lineage.tasksetHash,
      },
      evaluationArtifact: evaluationArtifact
        ? {
            id: evaluationArtifact.id,
            sha256: evaluationArtifact.sha256,
          }
        : null,
      portableFiles: portable.map(({ artifact, name }) => ({
        path: name,
        sizeBytes: artifact.sizeBytes,
        sha256: artifact.sha256,
        mediaType: name.endsWith(".json")
          ? "application/json"
          : "application/vnd.safetensors",
      })),
      optimizerProof: {
        schemaVersion: "openpond.grpoOptimizerProof.v1",
        optimizerUpdatesObserved: job.metadata.optimizerUpdatesObserved,
        artifacts: optimizerArtifacts.map(([name, artifact]) => ({
          id: artifact.id,
          name,
          sha256: artifact.sha256,
          sizeBytes: artifact.sizeBytes,
        })),
      },
      qualification: {
        structuralValidationRequired: true,
        runtimeGpuValidationRequired: true,
        customerBindingAllowed: false,
      },
    },
  };
  process.stdout.write(`${JSON.stringify(metadata, null, 2)}\n`);
} finally {
  database.close();
}

function parseArgs(argv: string[]): {
  storeDir: string;
  providerRunId: string;
  label: string | null;
} {
  let storeDir =
    process.env.OPENPOND_STORE_DIR?.trim() ||
    path.join(homedir(), ".openpond", "openpond-app");
  let providerRunId = "";
  let label: string | null = null;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]!;
    const value = argv[index + 1]?.trim();
    if (!value) throw new Error(`${argument} requires a value.`);
    if (argument === "--store-dir") storeDir = path.resolve(value);
    else if (argument === "--provider-run-id") providerRunId = value;
    else if (argument === "--label") label = value;
    else throw new Error(`Unknown option: ${argument}`);
    index += 1;
  }
  if (!providerRunId) throw new Error("--provider-run-id is required.");
  return { storeDir, providerRunId, label };
}

function payloadRows<T>(
  database: DatabaseSync,
  sql: string,
  parameters: string[] = [],
): T[] {
  const rows = database.prepare(sql).all(...parameters) as Array<{
    payload: string;
  }>;
  return rows.map((row) => JSON.parse(row.payload) as T);
}

function sourceBaseIdentity(
  artifact: TrainingArtifact,
  job: TrainingJob,
): {
  id: string;
  revision: string;
  tokenizerRevision: string;
  chatTemplateHash: string;
  providerMetadataSha256: string;
} {
  return {
    id: requiredString(artifact.baseModelId, "baseModelId"),
    revision: requiredString(
      artifact.baseModelRevision,
      "baseModelRevision",
    ),
    tokenizerRevision: requiredString(
      artifact.tokenizerRevision,
      "tokenizerRevision",
    ),
    chatTemplateHash: requiredString(
      artifact.chatTemplateHash,
      "chatTemplateHash",
    ),
    providerMetadataSha256: requiredHash(
      job.metadata.baseModelProviderMetadataHash,
      "baseModelProviderMetadataHash",
    ),
  };
}

async function verifyArtifact(artifact: TrainingArtifact): Promise<void> {
  const hash = createHash("sha256");
  let sizeBytes = 0;
  for await (const chunk of createReadStream(artifact.path)) {
    const bytes = Buffer.from(chunk);
    sizeBytes += bytes.byteLength;
    hash.update(bytes);
  }
  if (
    sizeBytes !== artifact.sizeBytes ||
    hash.digest("hex") !== artifact.sha256
  ) {
    throw new Error(`Training artifact ${artifact.id} failed integrity verification.`);
  }
}

function requiredString(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`The GRPO job is missing ${field}.`);
  }
  return value.trim();
}

function requiredHash(value: unknown, field: string): string {
  const normalized = requiredString(value, field);
  if (!/^[a-f0-9]{64}$/.test(normalized)) {
    throw new Error(`The GRPO job has an invalid ${field}.`);
  }
  return normalized;
}

function positiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value > 0;
}
