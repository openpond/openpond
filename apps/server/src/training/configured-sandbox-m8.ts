import { lstatSync, readFileSync } from "node:fs";
import path from "node:path";

import {
  ComputeTargetBindingSchema,
  HarnessRuntimeTargetBindingSchema,
  TrainingEngineCapabilitiesSchema,
  type HarnessRelease,
  type ResolvedTrainingPlan,
} from "@openpond/contracts";
import { contentHash } from "@openpond/taskset-sdk";
import {
  SandboxManagedTrainingHttpClient,
  SandboxTrainingEngineAdapter,
} from "@openpond/trainer-sandbox";
import { ContentAddressedReleaseStore } from "@openpond/training-sdk";
import { z } from "zod";

import type { PortableTrainingAdapterComposition } from "./portable-training-server-dependencies.js";

const HashSchema = z.string().regex(/^[a-f0-9]{64}$/);
const ImageDigestSchema = z.string().regex(/^sha256:[a-f0-9]{64}$/);
const JsonObjectSchema = z.record(z.string(), z.unknown());
const NonEmptySchema = z.string().trim().min(1).max(1_000);
const UsdSchema = z
  .string()
  .regex(/^(?:0|[1-9]\d{0,5})(?:\.\d{1,6})?$/);

const SandboxM8InputTemplateSchema = z
  .object({
    profileSnapshot: z
      .object({
        projectId: NonEmptySchema,
        profileId: NonEmptySchema,
        sourceRef: NonEmptySchema,
        sourceCommitSha: z.string().regex(/^[a-f0-9]{40}$/),
        manifestHash: HashSchema,
        manifestPath: NonEmptySchema,
        publishedSnapshotId: NonEmptySchema,
        validationAttestationSha256: HashSchema,
        published: z.literal(true),
        mutable: z.literal(false),
      })
      .passthrough(),
    taskset: z
      .object({
        id: NonEmptySchema,
        revision: z.number().int().positive(),
        contentHash: HashSchema,
        trainSplitHash: HashSchema,
        validationSplitHash: HashSchema,
        frozenEvalHash: HashSchema,
        taskCount: z.number().int().positive(),
      })
      .passthrough(),
    materialization: z
      .object({
        environmentArchive: z
          .object({
            schemaVersion: z.literal(
              "openpond.harnessEnvironmentArchive.v1",
            ),
            sha256: HashSchema,
            sizeBytes: z.number().int().positive(),
            dependencyLockSha256: HashSchema,
            worldSha256: HashSchema,
            toolSchemaSha256: HashSchema,
            rewardSha256: HashSchema,
            rendererSha256: HashSchema,
          })
          .passthrough(),
      })
      .passthrough(),
    baseModel: z
      .object({
        source: z.literal("huggingface"),
        repoId: NonEmptySchema,
        revision: z.string().regex(/^[a-f0-9]{40}$/),
        configHash: HashSchema,
        tokenizerHash: HashSchema,
        licenseId: NonEmptySchema,
        gated: z.boolean(),
      })
      .passthrough(),
    connectedGpu: z
      .object({
        shape: z.literal("H100_80GB"),
        maxHourlyUsd: UsdSchema,
      })
      .passthrough(),
    limits: z
      .object({
        maxTotalUsd: UsdSchema,
        maxGpuUsd: UsdSchema,
        maxSandboxUsd: UsdSchema,
        maxStorageUsd: UsdSchema,
        cleanupReserveUsd: UsdSchema,
        maxGpuSeconds: z.number().int().positive(),
        maxSandboxSeconds: z.number().int().positive(),
        maxWallSeconds: z.number().int().positive(),
        maxRolloutWorkers: z.number().int().positive(),
        maxActiveRollouts: z.number().int().positive(),
        maxRollouts: z.number().int().positive(),
        maxRetries: z.number().int().positive(),
        maxTasks: z.number().int().positive(),
        maxTurns: z.number().int().positive(),
        maxToolCalls: z.number().int().positive(),
        maxModelCalls: z.number().int().positive(),
        maxPromptTokens: z.number().int().positive(),
        maxOutputTokens: z.number().int().positive(),
        maxTrajectoryBytes: z.number().int().positive(),
        maxCheckpoints: z.number().int().positive(),
        maxCheckpointBytes: z.number().int().positive(),
        maxArtifactBytes: z.number().int().positive(),
        warmupDeadlineSeconds: z.number().int().positive(),
        rolloutDeadlineSeconds: z.number().int().positive(),
        trainerStepDeadlineSeconds: z.number().int().positive(),
        uploadDeadlineSeconds: z.number().int().positive(),
        cancellationDeadlineSeconds: z.number().int().positive(),
      })
      .passthrough(),
  })
  .passthrough();

const SandboxM8CompositionSchema = z
  .object({
    schemaVersion: z.literal("openpond.sandboxM8Composition.v1"),
    environmentAsset: z
      .object({
        value: JsonObjectSchema,
        expectedSha256: HashSchema,
      })
      .strict(),
    runtime: HarnessRuntimeTargetBindingSchema,
    compute: ComputeTargetBindingSchema,
    expectedEngine: z
      .object({
        workerImageDigest: ImageDigestSchema,
        upstreamRevision: z.string().regex(/^[a-f0-9]{40}$/),
        capabilityReceipt: HashSchema,
      })
      .strict(),
    inputBundleTemplate: SandboxM8InputTemplateSchema,
  })
  .strict()
  .superRefine((config, context) => {
    if (
      config.runtime.adapterId !== "sandbox-latitude" ||
      config.runtime.placement !== "remote" ||
      config.runtime.dataPlane?.provider !== "latitude"
    ) {
      context.addIssue({
        code: "custom",
        path: ["runtime"],
        message:
          "Sandbox M8 requires the exact remote sandbox-latitude/Latitude runtime binding.",
      });
    }
    if (
      config.compute.adapterId !== "prime-raw" ||
      config.compute.kind !== "managed" ||
      config.compute.provider !== "prime"
    ) {
      context.addIssue({
        code: "custom",
        path: ["compute"],
        message:
          "The first Sandbox M8 composition requires the qualified raw Prime compute binding.",
      });
    }
  });

export type SandboxM8Environment = {
  OPENPOND_SANDBOX_M8_URL?: string;
  OPENPOND_SANDBOX_M8_AUTH_TOKEN_FILE?: string;
  OPENPOND_SANDBOX_M8_COMPOSITION_FILE?: string;
};

export type ConfiguredSandboxM8 = {
  adapters: PortableTrainingAdapterComposition;
  binding: {
    runtime: z.infer<typeof HarnessRuntimeTargetBindingSchema>;
    compute: z.infer<typeof ComputeTargetBindingSchema>;
    resolvedBundleHash: string;
  };
};

/**
 * Constructs only the fixed M8 OpenPond/Sandbox composition. M0-M7 stay
 * behind Sandbox's API, and an incomplete or internally inconsistent
 * configuration fails closed before the target is advertised.
 */
export function createConfiguredSandboxM8(input: {
  storeDir: string;
  environment: SandboxM8Environment;
  request?: typeof fetch;
}): ConfiguredSandboxM8 | null {
  const baseUrl = input.environment.OPENPOND_SANDBOX_M8_URL?.trim();
  const authTokenFile =
    input.environment.OPENPOND_SANDBOX_M8_AUTH_TOKEN_FILE?.trim();
  const compositionFile =
    input.environment.OPENPOND_SANDBOX_M8_COMPOSITION_FILE?.trim();
  const supplied = [baseUrl, authTokenFile, compositionFile].filter(Boolean);
  if (supplied.length === 0) return null;
  if (!baseUrl || !authTokenFile || !compositionFile) {
    throw new Error(
      "Sandbox M8 configuration requires URL, auth-token file, and composition file.",
    );
  }
  const endpoint = new URL(baseUrl);
  if (
    endpoint.protocol !== "https:" &&
    endpoint.hostname !== "127.0.0.1" &&
    endpoint.hostname !== "localhost" &&
    endpoint.hostname !== "::1"
  ) {
    throw new Error("Sandbox M8 requires HTTPS outside loopback.");
  }
  const config = SandboxM8CompositionSchema.parse(
    JSON.parse(readRegularFile(compositionFile, "composition")),
  );
  assertTemplateConfiguration(config);
  const releaseStore = new ContentAddressedReleaseStore(
    path.join(input.storeDir, "training", "portable-releases"),
  );
  const client = new SandboxManagedTrainingHttpClient(
    endpoint.toString(),
    () => ({
      authorization: `Bearer ${readSecretToken(authTokenFile)}`,
    }),
    input.request,
  );
  const adapter = new SandboxTrainingEngineAdapter(
    client,
    {
      resolve: async ({ harnessRelease }) => {
        const release = await releaseStore.resolveHarnessRelease(
          harnessRelease,
        );
        assertReleaseMatchesTemplate(
          release,
          config.inputBundleTemplate,
        );
        const asset = await client.uploadEnvironmentAsset({
          value: config.environmentAsset.value,
          expectedSha256: config.environmentAsset.expectedSha256,
          idempotencyKey: contentHash({
            harnessRelease,
            environmentAsset: config.environmentAsset.expectedSha256,
          }),
        });
        if (
          asset.sha256 !== config.environmentAsset.expectedSha256 ||
          asset.sideEffectsStarted !== false
        ) {
          throw new Error(
            "Sandbox changed the configured M8 environment asset.",
          );
        }
        return {
          release,
          assetBundle: {
            objectRef: asset.objectRef,
            sha256: asset.sha256,
            sizeBytes: asset.sizeBytes,
          },
        };
      },
    },
    {
      create: async ({ plan, materialization, quote }) =>
        createSandboxM8InputBundle({
          plan,
          materialization,
          quote,
          template: config.inputBundleTemplate,
          expectedEngine: config.expectedEngine,
          environmentAssetHash:
            config.environmentAsset.expectedSha256,
        }),
    },
    async () =>
      TrainingEngineCapabilitiesSchema.parse({
        schemaVersion:
          "openpond.trainingEngineCapabilities.v1",
        adapterId: "connected-prime-rl",
        available: true,
        methods: ["grpo"],
        signalKinds: [
          "trajectory",
          "reward",
          "grader_evidence",
          "infrastructure_failure",
        ],
        modelFamilies: ["transformers"],
        precisions: ["fp16", "bf16", "tf32"],
        topologies: ["single_gpu_phased"],
        workerProtocolVersion: "openpond.connectedWorker.v1",
        upstreamRevision: config.expectedEngine.upstreamRevision,
        capabilityReceipt:
          config.expectedEngine.capabilityReceipt,
        checkedAt: new Date().toISOString(),
        unavailableReason: null,
      }),
  );
  return {
    adapters: {
      sandboxManagedConfigured: true,
      workerImageDigest: config.expectedEngine.workerImageDigest,
      engineRoutes: [
        {
          canonicalEngineId: "connected-prime-rl",
          route: {
            id: "sandbox-m8",
            matches: (plan) =>
              plan.runtime.adapterId === "sandbox-latitude" &&
              plan.compute.adapterId === "prime-raw",
            adapter,
          },
        },
      ],
    },
    binding: {
      runtime: config.runtime,
      compute: config.compute,
      resolvedBundleHash:
        config.environmentAsset.expectedSha256,
    },
  };
}

export function createSandboxM8InputBundle(input: {
  plan: ResolvedTrainingPlan;
  materialization: {
    materializationRef: string;
    materializationHash: string;
    environmentArchiveRef: string;
    environmentArchiveHash: string;
  };
  quote: {
    providerQuote: Record<string, unknown>;
  };
  template: Record<string, unknown>;
  expectedEngine: {
    workerImageDigest: string;
    upstreamRevision: string;
    capabilityReceipt: string;
  };
  environmentAssetHash: string;
}): Record<string, unknown> {
  const { plan } = input;
  if (
    plan.recipe.method !== "grpo" ||
    plan.manifest.recipe.method !== "grpo" ||
    plan.manifest.resolvedBundleHash !==
      input.environmentAssetHash ||
    plan.engine.workerImageDigest !==
      input.expectedEngine.workerImageDigest ||
    plan.engine.upstreamRevision !==
      input.expectedEngine.upstreamRevision ||
    plan.engine.capabilityReceipt !==
      input.expectedEngine.capabilityReceipt
  ) {
    throw new Error(
      "The resolved plan is outside the configured Sandbox M8 composition.",
    );
  }
  const template = structuredClone(input.template);
  const profileSnapshot = objectField(template, "profileSnapshot");
  const taskset = objectField(template, "taskset");
  const baseModel = objectField(template, "baseModel");
  const environmentArchive = objectField(
    objectField(template, "materialization"),
    "environmentArchive",
  );
  const connectedGpuTemplate = objectField(
    template,
    "connectedGpu",
  );
  const limits = objectField(template, "limits");
  if (
    baseModel.repoId !== plan.manifest.model.source ||
    baseModel.revision !== plan.manifest.model.revision ||
    plan.manifest.model.tokenizerRevision !== baseModel.revision ||
    baseModel.tokenizerHash === undefined ||
    environmentArchive.rendererSha256 !==
      plan.manifest.model.chatTemplateHash ||
    input.materialization.environmentArchiveHash !==
      input.environmentAssetHash ||
    Number(limits.maxTotalUsd) >
      (plan.maximumSpendUsd ?? -1)
  ) {
    throw new Error(
      "Sandbox M8 template Model, renderer, or spend lineage does not match the resolved plan.",
    );
  }
  const providerQuote = input.quote.providerQuote;
  const recipe = managedRftRecipe(plan);
  const connectedGpu = {
    ...connectedGpuTemplate,
    adapterId: plan.compute.adapterId,
    provider: plan.compute.provider,
    capabilityReceipt: plan.compute.capabilityReceipt,
    workerProtocolVersion: "openpond.connectedWorker.v1",
    workerImageDigest: plan.engine.workerImageDigest,
    upstreamRevision: plan.engine.upstreamRevision,
    availabilityId: stringField(providerQuote, "availabilityId"),
    cloudId: stringField(providerQuote, "cloudId"),
    providerType: stringField(providerQuote, "providerType"),
    dataCenterId:
      providerQuote.dataCenterId === null
        ? null
        : stringField(providerQuote, "dataCenterId"),
    region: stringField(providerQuote, "region"),
    country: stringField(providerQuote, "country"),
    security: stringField(providerQuote, "security"),
    socket: stringField(providerQuote, "socket"),
    gpuCount: numberField(providerQuote, "gpuCount"),
  };
  if (
    connectedGpu.cloudId !== plan.compute.deviceOrPool ||
    connectedGpu.workerImageDigest !==
      input.expectedEngine.workerImageDigest ||
    Number(providerQuote.hourlyUsd ?? 0) +
      Number(providerQuote.diskHourlyUsd ?? 0) >
      Number(connectedGpuTemplate.maxHourlyUsd)
  ) {
    throw new Error(
      "Sandbox quote changed the exact M8 GPU or worker binding.",
    );
  }
  const content = {
    schemaVersion: "openpond.managedRftInput.v2",
    sourceRunRef: `openpond:${plan.manifest.id}`,
    harnessRunManifest: plan.manifest,
    profileSnapshot,
    taskset,
    materialization: {
      materializationRef: input.materialization.materializationRef,
      materializationHash:
        input.materialization.materializationHash,
      environmentArchive: {
        ...environmentArchive,
        objectRef: input.materialization.environmentArchiveRef,
        sha256: input.materialization.environmentArchiveHash,
        harnessRelease: plan.manifest.harnessRelease,
      },
    },
    baseModel,
    recipe,
    connectedGpu,
    limits,
    approval: {
      approvedAt: plan.manifest.approval.approvedAt,
      approvalHash: plan.approvalHash,
      disclosureVersion: "managed-rft-disclosure-v1",
    },
    createdAt: plan.manifest.createdAt,
  };
  return {
    ...content,
    manifestSha256: contentHash(content),
  };
}

function managedRftRecipe(
  plan: ResolvedTrainingPlan,
): Record<string, unknown> {
  if (plan.recipe.method !== "grpo") {
    throw new Error("Sandbox M8 supports only GRPO.");
  }
  const recipe = plan.recipe;
  return {
    engine: "prime_rl",
    algorithm: "grpo",
    adapter: {
      kind: "lora",
      rank: recipe.lora.rank,
      alpha: recipe.lora.rank * 2,
      dropout: 0,
    },
    maxSteps: recipe.optimizer.maxSteps,
    learningRate: recipe.optimizer.learningRate,
    rolloutGroupSize: recipe.rollout.groupSize,
    rolloutWorkers: recipe.rollout.concurrency,
    maxActiveRolloutsPerWorker: 1,
    maxSequenceLength:
      recipe.dataset.maxPromptTokens +
      recipe.rollout.maxOutputTokens,
    checkpointEverySteps: 1,
    topology: "single_gpu_phased",
    sourceConfigHash: plan.manifest.recipe.configHash,
  };
}

function assertTemplateConfiguration(
  config: z.infer<typeof SandboxM8CompositionSchema>,
): void {
  if (
    contentHash(config.environmentAsset.value) !==
    config.environmentAsset.expectedSha256
  ) {
    throw new Error(
      "Sandbox M8 environment asset does not match its configured hash.",
    );
  }
  const environmentArchive = objectField(
    objectField(config.inputBundleTemplate, "materialization"),
    "environmentArchive",
  );
  if (
    environmentArchive.sha256 !==
    config.environmentAsset.expectedSha256
  ) {
    throw new Error(
      "Sandbox M8 input template does not bind the environment asset.",
    );
  }
}

function assertReleaseMatchesTemplate(
  release: HarnessRelease,
  template: Record<string, unknown>,
): void {
  const taskset = objectField(template, "taskset");
  const profile = objectField(template, "profileSnapshot");
  if (
    release.metadata.tasksetId !== taskset.id ||
    release.metadata.tasksetHash !== taskset.contentHash ||
    release.revision !== taskset.revision ||
    release.metadata.profileId !== profile.profileId
  ) {
    throw new Error(
      "Sandbox M8 template does not match the published Harness Release.",
    );
  }
}

function readSecretToken(file: string): string {
  const metadata = lstatSync(file);
  if (
    !metadata.isFile() ||
    metadata.isSymbolicLink() ||
    (metadata.mode & 0o077) !== 0
  ) {
    throw new Error(
      "Sandbox M8 auth-token file must be a private regular non-symlink file.",
    );
  }
  const token = readFileSync(file, "utf8").trim();
  if (!token.startsWith("opsvc_")) {
    throw new Error(
      "Sandbox M8 auth-token file must contain a scoped service token.",
    );
  }
  return token;
}

function readRegularFile(file: string, label: string): string {
  const metadata = lstatSync(file);
  if (!metadata.isFile() || metadata.isSymbolicLink()) {
    throw new Error(
      `Sandbox M8 ${label} file must be a regular non-symlink file.`,
    );
  }
  return readFileSync(file, "utf8");
}

function objectField(
  value: Record<string, unknown>,
  key: string,
): Record<string, unknown> {
  const child = value[key];
  if (!child || typeof child !== "object" || Array.isArray(child)) {
    throw new Error(`Sandbox M8 template ${key} is invalid.`);
  }
  return child as Record<string, unknown>;
}

function stringField(
  value: Record<string, unknown>,
  key: string,
): string {
  const result = value[key];
  if (typeof result !== "string" || !result.trim()) {
    throw new Error(`Sandbox M8 quote ${key} is invalid.`);
  }
  return result;
}

function numberField(
  value: Record<string, unknown>,
  key: string,
): number {
  const result = value[key];
  if (
    typeof result !== "number" ||
    !Number.isFinite(result) ||
    result <= 0
  ) {
    throw new Error(`Sandbox M8 quote ${key} is invalid.`);
  }
  return result;
}
