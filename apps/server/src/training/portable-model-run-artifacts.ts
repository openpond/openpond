import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  TrainingArtifactSchema,
  TrainingArtifactsSchema,
  type ModelRunDraft,
  type TrainingArtifact,
  type TrainingArtifacts,
  type TrainingExecutionRef,
  type TrainingJob,
} from "@openpond/contracts";
import { contentHash, sha256 } from "@openpond/taskset-sdk";

import type { SqliteStore } from "../store/store.js";

export async function importPortableModelRunArtifacts(input: {
  store: SqliteStore;
  job: TrainingJob;
  draft: ModelRunDraft & {
    baseModel: NonNullable<ModelRunDraft["baseModel"]>;
  };
  executionRef: TrainingExecutionRef;
  completedAt: string;
  portable: TrainingArtifacts;
}): Promise<{
  artifacts: TrainingArtifact[];
  weights: TrainingArtifact;
  configuration: TrainingArtifact | null;
  provider: string;
}> {
  assertArtifacts(input.portable, input.executionRef, input.job);
  const provider = portableProvider(input.job);
  const artifacts = await persistPortableArtifacts({
    ...input,
    provider,
  });
  if (provider === "sandbox") {
    const weights = artifacts.find((artifact) => artifact.metadata.managedRlCandidate === true);
    if (!weights || artifacts.length !== 1) {
      throw new Error(
        "Sandbox managed training completed without one canonical candidate receipt.",
      );
    }
    return {
      artifacts,
      weights,
      configuration: null,
      provider,
    };
  }
  const portableFiles = artifacts
    .map((artifact) => ({
      artifact,
      name: portableFilename(artifact.metadata.providerFilename),
    }))
    .filter(
      (
        entry,
      ): entry is {
        artifact: TrainingArtifact;
        name: string;
      } => entry.name !== null,
    );
  const weights =
    portableFiles.find(({ name }) => name === "adapter_model.safetensors") ??
    portableFiles.find(({ name }) => /^adapter_model-\d{5}-of-\d{5}\.safetensors$/.test(name));
  const configuration = portableFiles.find(({ name }) => name === "adapter_config.json");
  if (!weights || !configuration) {
    throw new Error(
      "Portable training completed without complete LoRA weights and adapter configuration.",
    );
  }
  return {
    artifacts,
    weights: weights.artifact,
    configuration: configuration.artifact,
    provider,
  };
}

export async function readRecoveredPortableArtifacts(input: {
  storeDir: string;
  runId: string;
}): Promise<TrainingArtifacts | null> {
  const receipt = path.join(
    input.storeDir,
    "training",
    "connected-artifacts",
    sha256(input.runId),
    "portable-artifacts.json",
  );
  const serialized = await readFile(receipt, "utf8").catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
  if (serialized === null) return null;
  const artifacts = TrainingArtifactsSchema.parse(JSON.parse(serialized));
  const { contentHash: supplied, ...base } = artifacts;
  if (supplied !== contentHash(base)) {
    throw new Error("Recovered portable artifact receipt failed content verification.");
  }
  return artifacts;
}

function assertArtifacts(
  artifacts: TrainingArtifacts,
  ref: TrainingExecutionRef,
  job: TrainingJob,
): void {
  const parsed = TrainingArtifactsSchema.parse(artifacts);
  const { contentHash: supplied, ...base } = parsed;
  const expectedManifestHash =
    ref.manifestHash ??
    (typeof job.metadata.harnessRunManifestHash === "string"
      ? job.metadata.harnessRunManifestHash
      : null);
  if (
    parsed.runId !== ref.runId ||
    !expectedManifestHash ||
    parsed.manifestHash !== expectedManifestHash ||
    supplied !== contentHash(base)
  ) {
    throw new Error(
      "Portable training artifacts changed execution, manifest, or content identity.",
    );
  }
}

async function persistPortableArtifacts(input: {
  store: SqliteStore;
  job: TrainingJob;
  draft: ModelRunDraft & {
    baseModel: NonNullable<ModelRunDraft["baseModel"]>;
  };
  executionRef: TrainingExecutionRef;
  provider: string;
  completedAt: string;
  portable: TrainingArtifacts;
}): Promise<TrainingArtifact[]> {
  const existing = await input.store.listTrainingArtifacts(input.job.id);
  const optimizerReceiptHash =
    input.portable.artifacts.find((artifact) => artifact.kind === "receipt")?.sha256 ??
    input.portable.contentHash;
  const persisted: TrainingArtifact[] = [];
  for (const portable of input.portable.artifacts) {
    const managedCandidate = managedRlCandidateRef(portable.objectRef, input.executionRef.runId);
    if (input.provider === "sandbox" && (!managedCandidate || portable.kind !== "adapter")) {
      throw new Error("Sandbox managed training returned an invalid remote candidate receipt.");
    }
    const artifactPath = managedCandidate
      ? portable.objectRef
      : localArtifactPath(portable.objectRef);
    if (!managedCandidate) {
      const info = await stat(artifactPath);
      if (!info.isFile() || info.size !== portable.sizeBytes) {
        throw new Error(`Portable artifact ${portable.objectRef} changed before import.`);
      }
      const bytes = await readFile(artifactPath);
      if (sha256(bytes) !== portable.sha256) {
        throw new Error(`Portable artifact ${portable.objectRef} failed hash verification.`);
      }
    }
    const duplicate = existing.find(
      (artifact) => artifact.path === artifactPath && artifact.sha256 === portable.sha256,
    );
    if (duplicate) {
      persisted.push(duplicate);
      continue;
    }
    const providerFilename = managedCandidate
      ? "managed-rl-candidate"
      : portableFilenameFromRef(portable.objectRef);
    const isWeights = isAdapterWeights(providerFilename);
    const metadata: Record<string, unknown> = {
      provider: input.provider,
      providerFilename,
      portableKind: portable.kind,
      manifestHash: input.portable.manifestHash,
      verified: true,
      ...(managedCandidate
        ? {
            managedRlCandidate: true,
            managedRlJobId: managedCandidate.jobId,
            managedRlModelArtifactId: managedCandidate.modelArtifactId,
            managedRlTeamId: input.executionRef.tenantId ?? null,
          }
        : {}),
    };
    if (input.draft.method === "grpo" && isWeights) {
      metadata.groupedGrpoReceiptHash = optimizerReceiptHash;
    }
    const artifact = await input.store.saveTrainingArtifact(
      TrainingArtifactSchema.parse({
        schemaVersion: "openpond.trainingArtifact.v1",
        id: `training_artifact_${contentHash([
          input.job.id,
          providerFilename,
          portable.sha256,
        ]).slice(0, 24)}`,
        jobId: input.job.id,
        kind: trainingArtifactKind(portable.kind, providerFilename),
        path: artifactPath,
        sha256: portable.sha256,
        sizeBytes: portable.sizeBytes,
        baseModelId: input.draft.baseModel.modelId,
        baseModelRevision: input.draft.baseModel.revision,
        tokenizerRevision: input.draft.baseModel.tokenizerRevision,
        chatTemplateHash: input.draft.baseModel.chatTemplateHash,
        nonProduction: input.job.nonProduction,
        createdAt: input.completedAt,
        metadata,
      }),
    );
    persisted.push(artifact);
  }
  return persisted;
}

function localArtifactPath(objectRef: string): string {
  if (objectRef.startsWith("file:")) return fileURLToPath(objectRef);
  if (/^[a-z][a-z0-9+.-]*:/i.test(objectRef)) {
    throw new Error(`Portable artifact ${objectRef} was not materialized locally.`);
  }
  return path.resolve(objectRef);
}

function managedRlCandidateRef(
  objectRef: string,
  expectedJobId: string,
): { jobId: string; modelArtifactId: string } | null {
  const match = objectRef.match(/^sandbox-managed-rl:\/\/([^/]+)\/([^/?#]+)$/);
  if (!match) return null;
  try {
    const jobId = decodeURIComponent(match[1]!);
    const modelArtifactId = decodeURIComponent(match[2]!);
    return jobId === expectedJobId && modelArtifactId ? { jobId, modelArtifactId } : null;
  } catch {
    return null;
  }
}

function portableFilenameFromRef(objectRef: string): string {
  const local = objectRef.startsWith("file:") ? fileURLToPath(objectRef) : objectRef;
  const segments = local.replaceAll("\\", "/").split("/").filter(Boolean);
  let objectDirectory = -1;
  for (let index = segments.length - 1; index >= 0; index -= 1) {
    if (/^\d+-[a-f0-9]{12}$/.test(segments[index]!)) {
      objectDirectory = index;
      break;
    }
  }
  if (objectDirectory >= 0 && objectDirectory < segments.length - 1) {
    return segments.slice(objectDirectory + 1).join("/");
  }
  const outputDirectory = segments.lastIndexOf("output");
  if (outputDirectory >= 0 && outputDirectory < segments.length - 1) {
    return segments.slice(outputDirectory + 1).join("/");
  }
  const basename = segments.at(-1) ?? "";
  return basename.match(/^\d+-[a-f0-9]{12}-(.+)$/)?.[1] ?? basename;
}

function portableFilename(value: unknown): string | null {
  return typeof value === "string" && value.trim()
    ? path.basename(value.replaceAll("\\", "/"))
    : null;
}

function isAdapterWeights(name: string): boolean {
  const filename = path.basename(name.replaceAll("\\", "/"));
  return (
    filename === "adapter_model.safetensors" ||
    /^adapter_model-\d{5}-of-\d{5}\.safetensors$/.test(filename)
  );
}

function trainingArtifactKind(
  kind: TrainingArtifacts["artifacts"][number]["kind"],
  filename: string,
) {
  if (isAdapterWeights(filename)) return "adapter" as const;
  if (path.basename(filename) === "adapter_config.json") {
    return "manifest" as const;
  }
  if (kind === "trace") return "log" as const;
  if (kind === "receipt") return "manifest" as const;
  return kind;
}

function portableProvider(job: TrainingJob): string {
  if (job.destinationId === "openpond_managed") return "sandbox";
  const bindings = objectValue(job.metadata.portableAdapterBindings);
  const compute = objectValue(bindings.compute);
  return typeof compute.provider === "string" && compute.provider.trim()
    ? compute.provider
    : job.destinationId;
}

function objectValue(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}
