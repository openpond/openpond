import { randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import {
  copyFile,
  mkdir,
  readFile,
  writeFile,
} from "node:fs/promises";
import path from "node:path";

import {
  ModelRunDraftSchema,
  PrimeRolloutAssignmentSchema,
  PrimeRolloutResultSchema,
  PrimeRolloutSmokeReportSchema,
  PrimeRolloutSmokeRequestSchema,
  type OpenPondProfileState,
  type PrimeRolloutAssignment,
  type PrimeRolloutResult,
  type Taskset,
} from "@openpond/contracts";
import {
  listPrimeSshKeys,
  PrimeRawComputeHttpClient,
} from "@openpond/compute-provider-prime";
import {
  materializeHarnessRelease,
  materializeResolvedTrainingBundle,
  publishTasksetTrainingGraph,
} from "@openpond/training-sdk";
import { canonicalJson, contentHash } from "@openpond/taskset-sdk";
import { scanSshHostFingerprint } from "@openpond/trainer-connected";

import type { SqliteStore } from "../store/store.js";
import {
  createOpenAiCompatibleMarketingPolicy,
  runMarketingPortfolioRollout,
} from "./marketing-portfolio-rollout.js";
import { createProfileAgentHarnessRuntime } from "./profile-agent-harness-runtime.js";
import {
  createPrimeRolloutSshTransport,
  resolvePrimeSshIdentity,
} from "./prime-rollout-ssh.js";
import { verifyMarketingAgentRuntime } from "./task-creator-agent-benchmark.js";
import {
  failPrimeRolloutModelRun,
  persistPrimeRolloutSmokeReport,
  preparePrimeRolloutModel,
  primeRolloutModelIdentity,
  PRIME_SMOKE_CHAT_TEMPLATE_HASH,
  PRIME_SMOKE_MODEL_ID,
  PRIME_SMOKE_MODEL_REVISION,
  reconcilePrimeRolloutSmokeModels,
  type PrimeRolloutModelContext,
} from "./prime-rollout-model-lifecycle.js";

const REMOTE_INFERENCE_PORT = 8_000;
const REMOTE_HARNESS_PORT = 17_777;
const MAX_LIVE_DURATION_MS = 30 * 60_000;
const MIN_LIVE_DURATION_MS = 5 * 60_000;

export function createPrimeRolloutSmokeService(input: {
  store: SqliteStore;
  storeDir: string;
  resolvePrimeCredential(): Promise<string>;
  resolveProfile(): Promise<OpenPondProfileState>;
  openpondRelease: string;
  request?: typeof fetch;
  now?: () => Date;
}) {
  const request = input.request ?? fetch;
  const now = input.now ?? (() => new Date());
  let activeRun: Promise<unknown> | null = null;

  async function run(raw: unknown) {
    const requested = PrimeRolloutSmokeRequestSchema.parse(raw);
    if (activeRun) {
      throw new Error("A Prime rollout smoke test is already running.");
    }
    const operation = execute(requested).finally(() => {
      activeRun = null;
    });
    activeRun = operation;
    return operation;
  }

  async function execute(
    requested: ReturnType<typeof PrimeRolloutSmokeRequestSchema.parse>,
  ) {
    const startedAt = now().toISOString();
    const runId = `prime_rollout_${randomUUID()}`;
    const artifactRoot = path.join(
      input.storeDir,
      "training",
      "prime-rollout-smoke",
      runId,
    );
    await mkdir(artifactRoot, { recursive: true, mode: 0o700 });
    const taskset = await requireTaskset(input.store, requested.tasksetId);
    const modelIdentity = primeRolloutModelIdentity(taskset);
    const profile = await input.resolveProfile();
    const verifiedAgent = await verifyMarketingAgentRuntime({
      taskset,
      profile,
    });
    assertPrimeRolloutSmokeDataset(taskset);
    const graph = await buildPrimeRolloutSmokeReleaseGraph({
      taskset,
      runId,
      modelId: modelIdentity.modelId,
      maximumSpendUsd: requested.maximumSpendUsd,
      artifactRoot,
      openpondRelease: input.openpondRelease,
      timestamp: startedAt,
    });
    const agentRelease =
      taskset.environment.actionBindings?.[0]?.agentRelease;
    if (!agentRelease) {
      throw new Error("Marketing Taskset Agent release is unavailable.");
    }
    const modelContext: PrimeRolloutModelContext =
      await preparePrimeRolloutModel({
        store: input.store,
        taskset,
        runId,
        maximumSpendUsd: requested.maximumSpendUsd,
        startedAt,
        resolvedBundleHash:
          graph.release.resolvedBundleManifest.contentHash,
        harnessRelease: {
          id: graph.release.harnessRelease.id,
          contentHash: graph.release.harnessRelease.contentHash,
        },
        agentRelease,
      });
    let providerSucceeded = false;
    try {
    const task = taskset.tasks.find((candidate) => candidate.split === "train");
    if (!task) throw new Error("Marketing Taskset has no train row.");
    const localInferencePort = await availablePort();
    const harnessCallback = await startHarnessCallback({
      expectedResolvedBundleHash: graph.release.resolvedBundleManifest.contentHash,
      taskset,
      studentManifest: graph.student.manifest,
      environmentManifest: graph.environment.manifest,
      localInferencePort,
      artifactRoot,
      agentRoot: verifiedAgent.agentRoot,
      scorerModulePath: verifiedAgent.scorerModulePath,
    });
    const apiKey = await input.resolvePrimeCredential();
    const identity = await resolvePrimeSshIdentity(
      await listPrimeSshKeys({ apiKey, request }),
    );
    const client = new PrimeRawComputeHttpClient({
      apiKey: () => input.resolvePrimeCredential(),
      sshKeyId: identity.sshKeyId,
      image: "ubuntu_22_cuda_12",
      request,
      autoRestart: false,
      readyTimeoutMs: 15 * 60_000,
      verifySshHostKey: scanSshHostFingerprint,
    });
    const inventory = await client.inventory();
    if (!inventory.devices.length) {
      await harnessCallback.close();
      throw new Error("Prime has no secure single-H100 offering for the smoke test.");
    }
    const oneHourDeadline = new Date(now().getTime() + 60 * 60_000).toISOString();
    const initialQuotes = await Promise.all(
      inventory.devices.map(async (device) => ({
        device,
        quote: await client.quote({
          deviceOrPool: device.id,
          deadline: oneHourDeadline,
        }),
      })),
    );
    initialQuotes.sort(
      (left, right) =>
        left.quote.hourlyCostUsd - right.quote.hourlyCostUsd
        || left.device.id.localeCompare(right.device.id),
    );
    const candidates = [];
    for (const initial of initialQuotes) {
      const affordableDurationMs = Math.floor(
        requested.maximumSpendUsd
        / initial.quote.hourlyCostUsd
        * 60
        * 60_000,
      );
      const liveDurationMs = Math.min(
        MAX_LIVE_DURATION_MS,
        affordableDurationMs,
      );
      if (liveDurationMs < MIN_LIVE_DURATION_MS) continue;
      const deadline = new Date(
        now().getTime() + liveDurationMs,
      ).toISOString();
      const exactQuote = await client.quote({
        deviceOrPool: initial.device.id,
        deadline,
      });
      if (
        exactQuote.estimatedCostUsd <= requested.maximumSpendUsd
        && exactQuote.hourlyCostUsd > 0
      ) {
        candidates.push({
          ...initial,
          deadline,
          exactQuote,
          liveDurationMs,
        });
      }
    }
    if (!candidates.length) {
      await harnessCallback.close();
      throw new Error(
        "The approved Prime spend cannot cover a compatible five-minute smoke test.",
      );
    }

    let node: Awaited<ReturnType<typeof client.provision>> | null = null;
    let selected: (typeof candidates)[number] | null = null;
    let tunnel: Awaited<
      ReturnType<
        Awaited<ReturnType<typeof createPrimeRolloutSshTransport>>["openTunnel"]
      >
    > | null = null;
    let transport: Awaited<
      ReturnType<typeof createPrimeRolloutSshTransport>
    > | null = null;
    let remoteDirectory: string | null = null;
    let tunnelClosed = false;
    let podTerminated = false;
    try {
      const capacityFailures: string[] = [];
      for (const candidate of candidates) {
        try {
          node = await client.provision({
            deviceOrPool: candidate.device.id,
            deadline: candidate.deadline,
            idempotencyKey: `${runId}:${candidate.device.id}`,
          });
          selected = candidate;
          break;
        } catch (error) {
          if (!isPrimeCapacityFailure(error)) throw error;
          capacityFailures.push(
            `${candidate.device.name}: ${safeMessage(error)}`,
          );
        }
      }
      if (!node || !selected) {
        throw new Error(
          `Prime compatible offers exhausted their capacity: ${capacityFailures.join(" | ")}`,
        );
      }
      transport = await createPrimeRolloutSshTransport({
        host: node.host,
        port: node.port,
        user: node.user,
        expectedFingerprint: node.sshHostFingerprint,
        privateKeyPath: identity.privateKeyPath,
        artifactRoot: path.join(artifactRoot, "ssh"),
      });
      remoteDirectory = `/tmp/openpond-${runId}`;
      await transport.runRemote(["mkdir", "-p", remoteDirectory]);
      await transport.upload(
        [
          graph.release.directory,
          graph.coordinatorPath,
          graph.launchPath,
        ],
        remoteDirectory,
      );
      tunnel = await transport.openTunnel({
        localInferencePort,
        remoteInferencePort: REMOTE_INFERENCE_PORT,
        localHarnessPort: harnessCallback.port,
        remoteHarnessPort: REMOTE_HARNESS_PORT,
      });
      const remoteResult = await transport.runRemote(
        [
          "python3",
          `${remoteDirectory}/${path.basename(graph.coordinatorPath)}`,
          "--run-dir",
          remoteDirectory,
          "--callback-port",
          String(REMOTE_HARNESS_PORT),
          "--model-timeout-seconds",
          "900",
          "--rollout-timeout-seconds",
          "600",
        ],
        { timeoutMs: selected.liveDurationMs },
      );
      const coordinatorReceipt = object(
        JSON.parse(remoteResult.stdout),
        "Prime rollout coordinator receipt",
      );
      const assignment = verifyAssignment(
        coordinatorReceipt.assignment,
        graph.release.resolvedBundleManifest.contentHash,
      );
      const result = verifyResult(coordinatorReceipt.result, assignment);
      const callbackResult = await harnessCallback.result;
      if (canonicalJson(callbackResult) !== canonicalJson(result)) {
        throw new Error("Prime coordinator result differs from the local Harness result.");
      }
      await Promise.all([
        transport.download(
          `${remoteDirectory}/assignment.json`,
          artifactRoot,
        ),
        transport.download(`${remoteDirectory}/result.json`, artifactRoot),
        transport.download(`${remoteDirectory}/vllm.log`, artifactRoot),
      ]);
      await verifyDownloadedReceipt(artifactRoot, assignment, result);
      if (result.status !== "succeeded" || !result.grade) {
        throw new Error(result.failure ?? "Prime rollout did not produce a grade.");
      }
      const providerNodeId = node.nodeId;
      await tunnel.close();
      tunnelClosed = true;
      tunnel = null;
      await terminatePrimeNode(client, node.nodeId);
      podTerminated = true;
      node = null;
      const report = PrimeRolloutSmokeReportSchema.parse({
        schemaVersion: "openpond.primeRolloutSmokeReport.v1",
        runId,
        provider: "prime",
        nodeId: providerNodeId,
        hourlyCostUsd: selected.exactQuote.hourlyCostUsd,
        maximumSpendUsd: requested.maximumSpendUsd,
        model: assignment.model,
        upload: {
          transport: "scp",
          resolvedBundleHash: graph.release.resolvedBundleManifest.contentHash,
          uploaded: true,
        },
        assignment,
        result,
        cleanup: {
          podTerminated,
          tunnelClosed,
        },
        startedAt,
        completedAt: now().toISOString(),
      });
      await writeFile(
        path.join(artifactRoot, "smoke-report.json"),
        canonicalJson(report),
        { mode: 0o600 },
      );
      providerSucceeded = true;
      await persistPrimeRolloutSmokeReport({
        store: input.store,
        storeDir: input.storeDir,
        taskset,
        report,
        reportPath: path.join(artifactRoot, "smoke-report.json"),
      });
      return report;
    } catch (error) {
      if (transport && remoteDirectory) {
        await Promise.all([
          transport
            .download(`${remoteDirectory}/vllm.log`, artifactRoot)
            .catch(() => undefined),
          transport
            .download(`${remoteDirectory}/vllm-help.txt`, artifactRoot)
            .catch(() => undefined),
          transport
            .download(`${remoteDirectory}/vllm-bootstrap.log`, artifactRoot)
            .catch(() => undefined),
          transport
            .download(`${remoteDirectory}/pip-bootstrap.log`, artifactRoot)
            .catch(() => undefined),
        ]);
      }
      throw error;
    } finally {
      await harnessCallback.close().catch(() => undefined);
      if (tunnel) {
        await tunnel.close().then(
          () => {
            tunnelClosed = true;
          },
          () => undefined,
        );
      }
      if (node) {
        await terminatePrimeNode(client, node.nodeId).then(
          () => {
            podTerminated = true;
          },
          () => undefined,
        );
      }
    }
    } catch (error) {
      await writeFile(
        path.join(artifactRoot, "failure.json"),
        canonicalJson({
          runId,
          failedAt: now().toISOString(),
          error: safeMessage(error),
        }),
        { mode: 0o600 },
      ).catch(() => undefined);
      if (!providerSucceeded) {
        await failPrimeRolloutModelRun({
          store: input.store,
          runId: modelContext.runId,
          failedAt: now().toISOString(),
          error: safeMessage(error),
        }).catch(() => undefined);
      }
      throw error;
    }
  }

  return {
    run,
    reconcile: () =>
      reconcilePrimeRolloutSmokeModels({
        store: input.store,
        storeDir: input.storeDir,
      }),
    active: () => activeRun !== null,
  };
}

export async function buildPrimeRolloutSmokeReleaseGraph(input: {
  taskset: Taskset;
  runId: string;
  modelId?: string;
  maximumSpendUsd: number;
  artifactRoot: string;
  openpondRelease: string;
  timestamp: string;
}) {
  const grader = input.taskset.graders[0]!;
  const modelRun = ModelRunDraftSchema.parse({
    schemaVersion: "openpond.modelRunDraft.v1",
    id: `model_run_${input.runId}`,
    profileId: input.taskset.profileId,
    modelId: input.modelId ?? `model_${input.runId}`,
    status: "ready_to_run",
    title: "Prime Qwen3 0.6B rollout smoke",
    datasetMode: "existing",
    tasksetRef: {
      id: input.taskset.id,
      revision: input.taskset.revision,
      contentHash: input.taskset.contentHash,
    },
    datasetCreationId: null,
    buildIntent: "verifiable_reward",
    buildSpecification: input.taskset.authoringProvenance.buildSpecification,
    baseModel: {
      schemaVersion: "openpond.baseModelPreference.v1",
      modelId: PRIME_SMOKE_MODEL_ID,
      revision: PRIME_SMOKE_MODEL_REVISION,
      tokenizerRevision: PRIME_SMOKE_MODEL_REVISION,
      chatTemplateHash: PRIME_SMOKE_CHAT_TEMPLATE_HASH,
      modelAssetId: null,
      source: "managed",
    },
    method: "grpo",
    destinationId: "prime_hosted",
    runPreset: "small",
    recipe: {
      schemaVersion: "openpond.rftRecipe.v1",
      method: "grpo",
      parameterization: "lora",
      baseModel: {
        id: PRIME_SMOKE_MODEL_ID,
        revision: PRIME_SMOKE_MODEL_REVISION,
        tokenizerRevision: PRIME_SMOKE_MODEL_REVISION,
        chatTemplateHash: PRIME_SMOKE_CHAT_TEMPLATE_HASH,
      },
      dataset: {
        trainSplit: "train",
        validationSplit: "frozen_eval",
        maxPromptTokens: 2_048,
        maxExamples: 24,
        selectionStrategy: "stable_hash_top_n",
      },
      lora: { rank: 8 },
      rollout: {
        groupSize: 2,
        concurrency: 1,
        maxTurns: 8,
        maxOutputTokens: 1_024,
        temperature: 0.2,
        topP: 0.95,
        seed: 17,
      },
      optimizer: {
        learningRate: 0.00001,
        maxSteps: 1,
      },
      loss: {
        method: "grpo",
        klBeta: null,
      },
      reward: {
        graderId: grader.id,
        graderHash: contentHash(grader),
        environmentId: "marketing-portfolio-v1",
        environmentVersion: String(input.taskset.revision),
        toolContractHash: contentHash({
          toolNames: input.taskset.environment.toolNames,
          actionBindings: input.taskset.environment.actionBindings,
        }),
      },
      resourceLimits: {
        wallTimeMs: 10 * 60_000,
        maxRollouts: 2,
        maxPayloadBytes: 2 * 1024 * 1024,
      },
      policyOptimization: null,
    },
    createdAt: input.timestamp,
    updatedAt: input.timestamp,
  });
  const capabilityReceipt = contentHash({
    runId: input.runId,
    target: "prime-rollout-smoke",
  });
  const release = publishTasksetTrainingGraph({
    taskset: input.taskset,
    modelRun,
    runtime: {
      adapterId: "local-harness",
      placement: "local",
      capabilityReceipt,
      runtimeVersion: "openpond.primeRolloutSmoke.v1",
      dataPlane: null,
    },
    compute: {
      adapterId: "prime-raw",
      kind: "managed",
      deviceOrPool: "secure-h100",
      capabilityReceipt,
      provider: "prime",
    },
    engine: {
      adapterId: "prime-rollout-coordinator",
      workerVersion: "1",
      workerImageDigest: null,
      upstreamRevision: "prime_rl",
      capabilityReceipt,
    },
    approval: {
      approvalHash: contentHash({
        runId: input.runId,
        maximumSpendUsd: input.maximumSpendUsd,
      }),
      approvedAt: input.timestamp,
      maximumSpendUsd: input.maximumSpendUsd,
    },
    openpondRelease: input.openpondRelease,
    workerProtocol: "openpond.primeRolloutAssignment.v1",
  });
  const releaseMaterialized = await materializeResolvedTrainingBundle({
    manifest: release.resolvedBundleManifest,
    assets: release.assets,
    cacheRoot: path.join(input.artifactRoot, "resolved-training-bundle"),
  });
  const readAsset = async (asset: { path: string }) => {
    const bytes = release.assets.get(asset.path);
    if (!bytes) throw new Error(`Release asset ${asset.path} is missing.`);
    return bytes;
  };
  const materializationTarget = (
    projection: "student" | "environment",
  ) => ({
    adapterId: "local-harness",
    projection,
    runtimeVersion: "openpond.primeRolloutSmoke.v1",
    expectedContracts: release.harnessRelease.requiredContracts,
  });
  const [student, environment] = await Promise.all([
    materializeHarnessRelease({
      release: release.harnessRelease,
      cacheRoot: path.join(input.artifactRoot, "harness", "student"),
      target: materializationTarget("student"),
      readAsset,
    }),
    materializeHarnessRelease({
      release: release.harnessRelease,
      cacheRoot: path.join(input.artifactRoot, "harness", "environment"),
      target: materializationTarget("environment"),
      readAsset,
    }),
  ]);
  const coordinatorSource = path.resolve(
    process.cwd(),
    "python",
    "openpond-training",
    "src",
    "openpond_training",
    "prime_rollout_smoke_coordinator.py",
  );
  const coordinatorPath = path.join(
    input.artifactRoot,
    "prime_rollout_smoke_coordinator.py",
  );
  await copyFile(coordinatorSource, coordinatorPath);
  const agentRelease =
    input.taskset.environment.actionBindings?.[0]?.agentRelease;
  if (!input.taskset.profileRelease || !agentRelease) {
    throw new Error("Marketing Taskset release graph is incomplete.");
  }
  const launchPath = path.join(input.artifactRoot, "launch.json");
  await writeFile(
    launchPath,
    canonicalJson({
      schemaVersion: "openpond.primeRolloutLaunch.v1",
      assignment: {
        schemaVersion: "openpond.primeRolloutAssignment.v1",
        runId: input.runId,
        resolvedBundleHash: release.resolvedBundleManifest.contentHash,
        taskset: {
          id: input.taskset.id,
          revision: input.taskset.revision,
          contentHash: input.taskset.contentHash,
        },
        harnessRelease: {
          id: release.harnessRelease.id,
          contentHash: release.harnessRelease.contentHash,
        },
        profileRelease: input.taskset.profileRelease,
        agentRelease,
        split: "train",
        policyVersion: "base",
        model: {
          id: PRIME_SMOKE_MODEL_ID,
          revision: PRIME_SMOKE_MODEL_REVISION,
        },
        inferencePort: REMOTE_INFERENCE_PORT,
      },
      taskIds: input.taskset.tasks
        .filter((task) => task.split === "train")
        .map((task) => task.id),
    }),
    { mode: 0o600 },
  );
  return {
    release: {
      ...release,
      directory: releaseMaterialized.directory,
    },
    student,
    environment,
    coordinatorPath,
    launchPath,
  };
}

async function startHarnessCallback(input: {
  expectedResolvedBundleHash: string;
  taskset: Taskset;
  studentManifest: Awaited<
    ReturnType<typeof materializeHarnessRelease>
  >["manifest"];
  environmentManifest: Awaited<
    ReturnType<typeof materializeHarnessRelease>
  >["manifest"];
  localInferencePort: number;
  artifactRoot: string;
  agentRoot: string;
  scorerModulePath: string;
}) {
  let settled = false;
  let resolveResult!: (result: PrimeRolloutResult) => void;
  let rejectResult!: (error: Error) => void;
  const result = new Promise<PrimeRolloutResult>((resolve, reject) => {
    resolveResult = resolve;
    rejectResult = reject;
  });
  // The coordinator command can fail before execute() reaches its await below.
  // Observe the rejection immediately while preserving it for the later lineage check.
  void result.catch(() => undefined);
  const runtime = createProfileAgentHarnessRuntime({
    agentRoot: input.agentRoot,
    scorerModulePath: input.scorerModulePath,
    artifactRoot: input.artifactRoot,
  });
  const server = createServer(async (request, response) => {
    if (request.method !== "POST" || request.url !== "/assignment") {
      response.writeHead(404).end();
      return;
    }
    if (settled) {
      response.writeHead(409, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: "assignment_already_consumed" }));
      return;
    }
    settled = true;
    try {
      const assignment = verifyAssignment(
        JSON.parse(await readRequestBody(request)),
        input.expectedResolvedBundleHash,
      );
      const task = input.taskset.tasks.find(
        (candidate) => candidate.id === assignment.taskId,
      );
      if (!task) {
        throw new Error(`Assigned Dataset task was not found: ${assignment.taskId}`);
      }
      const rollout = await runMarketingPortfolioRollout({
        assignment,
        taskset: input.taskset,
        task,
        studentManifest: input.studentManifest,
        environmentManifest: input.environmentManifest,
        policy: createOpenAiCompatibleMarketingPolicy({
          baseUrl: `http://127.0.0.1:${input.localInferencePort}/v1`,
          modelId: PRIME_SMOKE_MODEL_ID,
          captureOptimizerSample: true,
        }),
        executeAction: runtime.executeAction,
        scoreDecision: runtime.scoreDecision,
      });
      response.writeHead(200, { "content-type": "application/json" });
      response.end(canonicalJson(rollout));
      resolveResult(rollout);
    } catch (error) {
      const message = safeMessage(error);
      response.writeHead(500, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: message }));
      rejectResult(error instanceof Error ? error : new Error(message));
    }
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  return {
    port: (server.address() as AddressInfo).port,
    result,
    close: () => closeServer(server),
  };
}

function verifyAssignment(
  raw: unknown,
  expectedResolvedBundleHash: string,
): PrimeRolloutAssignment {
  const assignment = PrimeRolloutAssignmentSchema.parse(raw);
  const { assignmentHash, ...content } = assignment;
  if (
    assignmentHash !== contentHash(content)
    || assignment.resolvedBundleHash !== expectedResolvedBundleHash
  ) {
    throw new Error("Prime rollout assignment hash is invalid.");
  }
  return assignment;
}

function verifyResult(
  raw: unknown,
  assignment: PrimeRolloutAssignment,
): PrimeRolloutResult {
  const result = PrimeRolloutResultSchema.parse(raw);
  const { resultHash, ...content } = result;
  if (
    resultHash !== contentHash(content)
    || result.assignmentHash !== assignment.assignmentHash
    || result.runId !== assignment.runId
    || result.taskId !== assignment.taskId
    || result.model.id !== assignment.model.id
    || result.model.revision !== assignment.model.revision
  ) {
    throw new Error("Prime rollout result hash or lineage is invalid.");
  }
  return result;
}

async function verifyDownloadedReceipt(
  artifactRoot: string,
  assignment: PrimeRolloutAssignment,
  result: PrimeRolloutResult,
): Promise<void> {
  const downloadedAssignment = verifyAssignment(
    JSON.parse(await readFile(path.join(artifactRoot, "assignment.json"), "utf8")),
    assignment.resolvedBundleHash,
  );
  const downloadedResult = verifyResult(
    JSON.parse(await readFile(path.join(artifactRoot, "result.json"), "utf8")),
    downloadedAssignment,
  );
  if (
    canonicalJson(downloadedAssignment) !== canonicalJson(assignment)
    || canonicalJson(downloadedResult) !== canonicalJson(result)
  ) {
    throw new Error("Downloaded Prime rollout receipts changed in transport.");
  }
}

async function requireTaskset(
  store: SqliteStore,
  tasksetId: string,
): Promise<Taskset> {
  const taskset = await store.getTaskset(tasksetId);
  if (!taskset) throw new Error(`Dataset was not found: ${tasksetId}`);
  return taskset;
}

export function assertPrimeRolloutSmokeDataset(taskset: Taskset): void {
  const splitCounts = {
    train: taskset.tasks.filter((task) => task.split === "train").length,
    validation: taskset.tasks.filter((task) => task.split === "validation").length,
    frozenEval: taskset.tasks.filter((task) => task.split === "frozen_eval").length,
  };
  if (
    splitCounts.train !== 24
    || splitCounts.validation !== 8
    || splitCounts.frozenEval !== 8
  ) {
    throw new Error("Prime smoke requires the exact 24/8/8 marketing Dataset.");
  }
  if (
    taskset.graders.length !== 1
    || taskset.graders[0]?.kind !== "custom_verifier"
    || taskset.graders[0]?.id !== "marketing_portfolio_reward"
  ) {
    throw new Error("Prime smoke requires the audited private receipt verifier.");
  }
  if (
    taskset.readiness
    && taskset.readiness.blockers.some(
      (blocker) =>
        !blocker.code.includes("baseline")
        && !blocker.code.includes("variance"),
    )
  ) {
    throw new Error(
      "Dataset readiness has a non-baseline blocker; run Dataset tests before Prime.",
    );
  }
}

async function availablePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const port = (server.address() as AddressInfo).port;
  await closeServer(server);
  return port;
}

function closeServer(server: Server): Promise<void> {
  if (!server.listening) return Promise.resolve();
  return new Promise((resolve, reject) => {
    server.close((error) => {
      if (error) reject(error);
      else resolve();
    });
  });
}

async function readRequestBody(
  request: import("node:http").IncomingMessage,
): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += bytes.byteLength;
    if (size > 1024 * 1024) {
      throw new Error("Prime assignment payload exceeded 1 MiB.");
    }
    chunks.push(bytes);
  }
  return Buffer.concat(chunks).toString("utf8");
}

async function terminatePrimeNode(
  client: PrimeRawComputeHttpClient,
  nodeId: string,
): Promise<void> {
  let lastError: unknown = null;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      await client.terminate(nodeId);
      return;
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError instanceof Error
    ? lastError
    : new Error("Prime pod termination failed.");
}

function object(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object.`);
  }
  return value as Record<string, unknown>;
}

function safeMessage(error: unknown): string {
  return (error instanceof Error ? error.message : String(error))
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 2_000)
    || "Prime rollout smoke failed.";
}

function isPrimeCapacityFailure(error: unknown): boolean {
  const message = safeMessage(error).toLowerCase();
  return (
    message.includes("insufficient capacity")
    || message.includes("not available right now")
    || message.includes("capacity")
  );
}
