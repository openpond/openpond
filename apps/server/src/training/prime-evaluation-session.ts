import { randomUUID } from "node:crypto";
import { createServer } from "node:net";
import {
  mkdir,
  readdir,
  readFile,
  writeFile,
} from "node:fs/promises";
import path from "node:path";

import {
  type ChatModelRef,
} from "@openpond/contracts";
import {
  listPrimeSshKeys,
  PrimeRawComputeHttpClient,
} from "@openpond/compute-provider-prime";
import type {
  HostedChatToolCall,
} from "@openpond/cloud";
import {
  canonicalJson,
  contentHash,
} from "@openpond/taskset-sdk";
import { scanSshHostFingerprint } from "@openpond/trainer-connected";

import {
  materializeRemotePythonProject,
} from "./prime-grpo-model-run-service.js";
import {
  PRIME_GRPO_QWEN3_0_6B_PROFILE,
  primeGrpoBaseProfileForModel,
  type PrimeGrpoBaseProfile,
} from "./prime-grpo-base-profiles.js";
import {
  choosePrimeGrpoQuote,
  type PrimeQuoteCandidate,
} from "./prime-grpo-plan.js";
import {
  createPrimeRolloutSshTransport,
  resolvePrimeSshIdentity,
} from "./prime-rollout-ssh.js";
import type {
  CrossSystemFrontierModelDelta,
  CrossSystemFrontierModelStream,
} from "./cross-system-operations/index.js";
import type {
  FireworksBaselinePrepareOptions,
  PreparedBaselineModels,
} from "./fireworks-baseline-deployment.js";

const REMOTE_INFERENCE_PORT = 8_000;
export const PRIME_EVALUATION_PYTHON_EXECUTABLE = "python";
const CANDIDATE_ALIAS = "openpond-policy-v1";
const MARKER_PREFIX = "openpond-prime-eval:";
const DEFAULT_INVENTORY_WAIT_MS = 10 * 60_000;
const DEFAULT_INVENTORY_POLL_INTERVAL_MS = 15_000;

type AdapterInput = {
  directory: string;
  configSha256: string;
  weightsSha256: string;
};

type RequestFact = {
  requestId: string;
  servedModel: string;
  responseModel: string;
  startedAt: string;
  completedAt: string;
  latencyMs: number;
  promptTokens: number | null;
  completionTokens: number | null;
  totalTokens: number | null;
  finishReason: string | null;
  toolCallCount: number;
};

type LiveSession = {
  id: string;
  localPort: number;
  aliases: Map<string, string>;
  requests: RequestFact[];
  signal: AbortSignal;
  models: {
    base: ChatModelRef;
    candidate: ChatModelRef | null;
  };
  resource: {
    nodeId: string;
    deviceOrPool: string;
    gpuType: string;
  };
  release(): Promise<{
    costUsd: number | null;
    receiptPath: string;
  }>;
};

export function createPrimeEvaluationSessionService(input: {
  storeDir: string;
  resolvePrimeCredential(): Promise<string>;
  request?: typeof fetch;
  now?: () => Date;
  inventoryWaitMs?: number;
  inventoryPollIntervalMs?: number;
}) {
  const request = input.request ?? fetch;
  const now = input.now ?? (() => new Date());
  const live = new Map<string, LiveSession>();

  async function prepareBaselineModels(
    models: ChatModelRef[],
    options: FireworksBaselinePrepareOptions = {},
  ): Promise<PreparedBaselineModels> {
    const exact = models.flatMap((model) => {
      if (model.providerId !== "custom-openai-compatible") {
        return [];
      }
      const baseProfile = primeGrpoBaseProfileForModel(
        model.modelId,
      );
      return baseProfile ? [{ model, baseProfile }] : [];
    });
    if (!exact.length) {
      return {
        models,
        release: async () => ({ costUsd: null }),
      };
    }
    if (models.length !== 1 || exact.length !== 1) {
      throw new Error(
        "The raw-Prime Qwen signal check supports exactly one pinned base model.",
      );
    }
    const session = await start({
      purpose: "train-signal",
      signal: options.signal,
      baseProfile: exact[0]!.baseProfile,
    });
    return {
      models: [{
        providerId: "custom-openai-compatible",
        modelId: marker(session.id, "base"),
      }],
      release: async () => {
        const released = await session.release();
        return { costUsd: released.costUsd };
      },
    };
  }

  async function start(options: {
    purpose: "train-signal" | "frozen-benchmark";
    adapter?: AdapterInput | null;
    baseProfile?: PrimeGrpoBaseProfile;
    signal?: AbortSignal;
  }): Promise<LiveSession> {
    throwIfAborted(options.signal);
    const baseProfile =
      options.baseProfile ?? PRIME_GRPO_QWEN3_0_6B_PROFILE;
    const baseAlias = baseProfile.modelId;
    const sessionId = `prime_eval_${contentHash([
      options.purpose,
      now().toISOString(),
      randomUUID(),
    ]).slice(0, 24)}`;
    const artifactRoot = path.join(
      input.storeDir,
      "training",
      "prime-evaluation",
      sessionId,
    );
    await mkdir(artifactRoot, {
      recursive: true,
      mode: 0o700,
    });
    const controllerStatePath = path.join(
      artifactRoot,
      "controller-state.json",
    );
    const provider = await resolveProvider();
    const inventory = await waitForPrimeEvaluationInventory({
      inventory: () => provider.client.inventory(),
      artifactRoot,
      signal: options.signal,
      now,
      waitMs:
        input.inventoryWaitMs ?? DEFAULT_INVENTORY_WAIT_MS,
      pollIntervalMs:
        input.inventoryPollIntervalMs
        ?? DEFAULT_INVENTORY_POLL_INTERVAL_MS,
    });
    throwIfAborted(options.signal);
    const wallet = await provider.client.walletBalance();
    const quoteDeadline = new Date(
      now().getTime() + 60 * 60_000,
    ).toISOString();
    const hourly = await Promise.all(
      inventory.devices.map(async (device) => ({
        device,
        quote: await provider.client.quote({
          deviceOrPool: device.id,
          deadline: quoteDeadline,
        }),
      })),
    );
    const hourlyByDevice = new Map(
      hourly.map(({ device, quote: candidate }) => [
        device.id,
        {
          quoteId: candidate.quoteId,
          hourlyCostUsd: candidate.hourlyCostUsd,
        },
      ]),
    );
    const orderedDevices = [...inventory.devices].sort(
      (left, right) =>
        (hourlyByDevice.get(left.id)?.hourlyCostUsd
          ?? Number.POSITIVE_INFINITY)
        - (hourlyByDevice.get(right.id)?.hourlyCostUsd
          ?? Number.POSITIVE_INFINITY)
        || left.id.localeCompare(right.id),
    );
    const startedAt = now().toISOString();
    let node: Awaited<
      ReturnType<PrimeRawComputeHttpClient["provision"]>
    > | null = null;
    let provisionedNodeId: string | null = null;
    let transport: Awaited<
      ReturnType<typeof createPrimeRolloutSshTransport>
    > | null = null;
    let tunnel: Awaited<
      ReturnType<
        Awaited<
          ReturnType<typeof createPrimeRolloutSshTransport>
        >["openTunnel"]
      >
    > | null = null;
    let released = false;
    let remoteDirectory: string | null = null;
    let failureStage = "provisioning";
    let providerResource: {
      nodeId: string;
      deviceOrPool: string;
      sshHostFingerprint: string;
      acquiredAt: string;
    } | null = null;
    let releasePromise: Promise<{
      costUsd: number | null;
      receiptPath: string;
    }> | null = null;
    const deadlineController = new AbortController();
    let deadlineTimer: ReturnType<typeof setTimeout> | null =
      null;
    let deadlineSession: LiveSession | null = null;
    const requestFacts: RequestFact[] = [];
    const provisionAttempts: Array<{
      deviceOrPool: string;
      deviceName: string;
      quoteId: string | null;
      estimatedCostUsd: number | null;
      startedAt: string;
      completedAt: string | null;
      status: "starting" | "failed" | "ready";
      error: string | null;
    }> = [];
    let quoted: PrimeQuoteCandidate | null = null;
    let selectedWallet = wallet;
    try {
      for (const [index, device] of orderedDevices
        .slice(0, 3)
        .entries()) {
        throwIfAborted(options.signal);
        const currentWallet = index === 0
          ? wallet
          : await provider.client.walletBalance();
        let candidate: PrimeQuoteCandidate;
        try {
          candidate = choosePrimeGrpoQuote({
            devices: [{
              id: device.id,
              name: device.name,
            }],
            hourlyQuotes: hourlyByDevice,
            walletBalanceUsd: currentWallet.balanceUsd,
            now: now(),
            minimumDurationMs: 15 * 60_000,
            targetDurationMs:
              options.purpose === "train-signal"
                ? 30 * 60_000
                : 45 * 60_000,
          });
        } catch (error) {
          provisionAttempts.push({
            deviceOrPool: device.id,
            deviceName: device.name,
            quoteId: null,
            estimatedCostUsd: null,
            startedAt: now().toISOString(),
            completedAt: now().toISOString(),
            status: "failed",
            error: safeMessage(error),
          });
          break;
        }
        const exactQuote = await provider.client.quote({
          deviceOrPool: candidate.device.id,
          deadline: candidate.deadline,
        });
        const exactCandidate = {
          ...candidate,
          quoteId: exactQuote.quoteId,
          hourlyCostUsd: exactQuote.hourlyCostUsd,
          estimatedCostUsd: exactQuote.estimatedCostUsd,
        };
        if (
          exactCandidate.estimatedCostUsd
          > currentWallet.balanceUsd
        ) {
          provisionAttempts.push({
            deviceOrPool: device.id,
            deviceName: device.name,
            quoteId: exactCandidate.quoteId,
            estimatedCostUsd:
              exactCandidate.estimatedCostUsd,
            startedAt: now().toISOString(),
            completedAt: now().toISOString(),
            status: "failed",
            error:
              "The refreshed exact quote exceeds the current Prime wallet balance.",
          });
          await saveProvisionAttempts(
            artifactRoot,
            provisionAttempts,
          );
          break;
        }
        const attempt: (typeof provisionAttempts)[number] = {
          deviceOrPool: device.id,
          deviceName: device.name,
          quoteId: exactCandidate.quoteId,
          estimatedCostUsd: exactCandidate.estimatedCostUsd,
          startedAt: now().toISOString(),
          completedAt: null as string | null,
          status: "starting",
          error: null as string | null,
        };
        provisionAttempts.push(attempt);
        await saveProvisionAttempts(
          artifactRoot,
          provisionAttempts,
        );
        try {
          provisionedNodeId = null;
          node = await provider.client.provision({
            deviceOrPool: exactCandidate.device.id,
            deadline: exactCandidate.deadline,
            idempotencyKey:
              `${sessionId}:${exactCandidate.device.id}`,
            signal: options.signal,
            onProvisioned: async (resource) => {
              provisionedNodeId = resource.nodeId;
              await writeFile(
                controllerStatePath,
                canonicalJson({
                  schemaVersion:
                    "openpond.primeEvaluationControllerState.v1",
                  sessionId,
                  status: "active",
                  providerNodeId: resource.nodeId,
                  deadline: exactCandidate.deadline,
                  provisioning: true,
                  updatedAt: now().toISOString(),
                }),
                { mode: 0o600 },
              );
            },
          });
          attempt.status = "ready";
          attempt.completedAt = now().toISOString();
          quoted = exactCandidate;
          selectedWallet = currentWallet;
          await saveProvisionAttempts(
            artifactRoot,
            provisionAttempts,
          );
          break;
        } catch (error) {
          attempt.status = "failed";
          attempt.completedAt = now().toISOString();
          attempt.error = safeMessage(error);
          await saveProvisionAttempts(
            artifactRoot,
            provisionAttempts,
          );
          if (provisionedNodeId) {
            await provider.client
              .terminate(provisionedNodeId)
              .catch(() => undefined);
            provisionedNodeId = null;
          }
          throwIfAborted(options.signal);
        }
      }
      if (!node || !quoted) {
        throw new Error(
          `Prime evaluation exhausted ${provisionAttempts.length} wallet-bounded H100 provisioning attempt${provisionAttempts.length === 1 ? "" : "s"}: ${
            provisionAttempts
              .map((attempt) =>
                `${attempt.deviceName}: ${attempt.error ?? "unavailable"}`
              )
              .join("; ")
          }`,
        );
      }
      const lockedQuote = quoted;
      const sessionSignal = options.signal
        ? AbortSignal.any([
            options.signal,
            deadlineController.signal,
          ])
        : deadlineController.signal;
      deadlineTimer = setTimeout(() => {
        deadlineController.abort(
          new Error(
            `Prime evaluation reached its locked ${lockedQuote.deadline} deadline.`,
          ),
        );
        void deadlineSession?.release().catch(() => undefined);
      }, Math.max(
        0,
        new Date(lockedQuote.deadline).getTime()
          - now().getTime(),
      ));
      deadlineTimer.unref?.();
      providerResource = {
        nodeId: node.nodeId,
        deviceOrPool: lockedQuote.device.id,
        sshHostFingerprint: node.sshHostFingerprint,
        acquiredAt: node.acquiredAt,
      };
      provisionedNodeId = node.nodeId;
      await writeFile(
        controllerStatePath,
        canonicalJson({
          schemaVersion:
            "openpond.primeEvaluationControllerState.v1",
          sessionId,
          status: "active",
          providerNodeId: node.nodeId,
          deadline: lockedQuote.deadline,
          updatedAt: now().toISOString(),
        }),
        { mode: 0o600 },
      );
      throwIfAborted(sessionSignal);
      failureStage = "ssh_transport";
      transport = await createPrimeRolloutSshTransport({
        host: node.host,
        port: node.port,
        user: node.user,
        expectedFingerprint: node.sshHostFingerprint,
        privateKeyPath: provider.privateKeyPath,
        artifactRoot: path.join(artifactRoot, "ssh"),
      });
      remoteDirectory = `/tmp/openpond-${sessionId}`;
      failureStage = "remote_staging";
      await transport.runRemote([
        "mkdir",
        "-p",
        remoteDirectory,
      ]);
      const sourceProject = path.resolve(
        process.cwd(),
        "python",
        "openpond-training",
      );
      const remoteProjectBundle =
        await materializeRemotePythonProject({
          sourceDirectory: sourceProject,
          artifactRoot,
        });
      const uploads = [remoteProjectBundle];
      if (options.adapter) uploads.push(options.adapter.directory);
      await transport.upload(uploads, remoteDirectory);
      const localPort = await availablePort();
      const unusedHarnessPort = await availablePort();
      tunnel = await transport.openTunnel({
        localInferencePort: localPort,
        remoteInferencePort: REMOTE_INFERENCE_PORT,
        localHarnessPort: unusedHarnessPort,
        remoteHarnessPort: 17_779,
      });
      const remoteProject =
        `${remoteDirectory}/openpond-training`;
      const remoteAdapter = options.adapter
        ? `${remoteDirectory}/${path.basename(options.adapter.directory)}`
        : "";
      const command = [
        "env",
        `PYTHONPATH=${remoteProject}/src`,
        PRIME_EVALUATION_PYTHON_EXECUTABLE,
        "-m",
        "openpond_training.vllm_evaluation_server",
        "--run-dir",
        remoteDirectory,
        "--model-repository",
        baseProfile.modelId,
        "--model-revision",
        baseProfile.revision,
        "--base-alias",
        baseAlias,
        "--port",
        String(REMOTE_INFERENCE_PORT),
        "--model-timeout-seconds",
        "900",
      ];
      if (options.adapter) {
        command.push(
          "--adapter-path",
          remoteAdapter,
          "--adapter-config-sha256",
          options.adapter.configSha256,
          "--adapter-weights-sha256",
          options.adapter.weightsSha256,
          "--adapter-alias",
          CANDIDATE_ALIAS,
        );
      }
      failureStage = "vllm_launch";
      await transport.runRemote([
        "bash",
        "-lc",
        [
          'run_dir="$1"',
          "shift",
          'nohup "$@" > "$run_dir/evaluation-server.log" 2>&1 < /dev/null &',
          'echo "$!"',
        ].join("\n"),
        "openpond-prime-evaluation",
        remoteDirectory,
        ...command,
      ]);
      failureStage = "vllm_readiness";
      await waitForVllm({
        port: localPort,
        request,
        signal: sessionSignal,
      });
      const aliases = new Map<string, string>([
        [marker(sessionId, "base"), baseAlias],
      ]);
      if (options.adapter) {
        aliases.set(
          marker(sessionId, "candidate"),
          CANDIDATE_ALIAS,
        );
      }
      const session: LiveSession = {
        id: sessionId,
        localPort,
        aliases,
        requests: requestFacts,
        signal: sessionSignal,
        models: {
          base: {
            providerId: "custom-openai-compatible",
            modelId: marker(sessionId, "base"),
          },
          candidate: options.adapter
            ? {
                providerId:
                  "custom-openai-compatible",
                modelId: marker(sessionId, "candidate"),
              }
            : null,
        },
        resource: {
          nodeId: providerResource.nodeId,
          deviceOrPool: providerResource.deviceOrPool,
          gpuType: lockedQuote.device.name.split(" · ", 1)[0]!,
        },
        release() {
          if (releasePromise) return releasePromise;
          releasePromise = (async () => {
            if (released) {
              return {
                costUsd: null,
                receiptPath: path.join(
                  artifactRoot,
                  "evaluation-session-receipt.json",
                ),
              };
            }
            released = true;
            if (deadlineTimer) {
              clearTimeout(deadlineTimer);
              deadlineTimer = null;
            }
            const cleanupStartedAt = now().toISOString();
            let remoteStopped = false;
            let tunnelClosed = false;
            let computeReleased = false;
            if (transport && remoteDirectory) {
              remoteStopped = await stopPrimeEvaluationRemote(
                transport,
                remoteDirectory,
              );
              await downloadPrimeEvaluationArtifacts({
                transport,
                remoteDirectory,
                artifactRoot,
              });
            }
            if (tunnel) {
              tunnelClosed = await tunnel.close().then(
                () => true,
                () => false,
              );
              tunnel = null;
            } else {
              tunnelClosed = true;
            }
            if (node) {
              computeReleased = await provider.client
                .terminate(node.nodeId)
                .then(
                  () => true,
                  () => false,
                );
              if (computeReleased) {
                node = null;
                provisionedNodeId = null;
              }
            } else {
              computeReleased = true;
            }
            const completedAt = now().toISOString();
            const elapsedHours = Math.max(
              0,
              new Date(completedAt).getTime()
                - new Date(startedAt).getTime(),
            ) / 3_600_000;
            const estimatedCostUsd = roundUsd(
              Math.min(
                lockedQuote.estimatedCostUsd,
                elapsedHours * lockedQuote.hourlyCostUsd,
              ),
            );
            const receiptCore = {
              schemaVersion:
                "openpond.primeEvaluationSessionReceipt.v1",
              sessionId,
              purpose: options.purpose,
              model: {
                repository: baseProfile.modelId,
                revision: baseProfile.revision,
                baseAlias,
                candidateAlias:
                  options.adapter ? CANDIDATE_ALIAS : null,
              },
              adapter: options.adapter
                ? {
                    configSha256:
                      options.adapter.configSha256,
                    weightsSha256:
                      options.adapter.weightsSha256,
                  }
                : null,
              wallet: selectedWallet,
              quote: lockedQuote,
              provisionAttempts,
              providerResource: {
                nodeId: providerResource?.nodeId ?? null,
                deviceOrPool:
                  providerResource?.deviceOrPool
                  ?? lockedQuote.device.id,
                sshHostFingerprint:
                  providerResource?.sshHostFingerprint ?? null,
                acquiredAt:
                  providerResource?.acquiredAt ?? null,
              },
              requests: requestFacts,
              usage: summarizeUsage(requestFacts),
              cost: {
                providerReportedUsd: null,
                estimatedUsd: estimatedCostUsd,
                methodology:
                  "elapsed_hours_times_locked_hourly_quote_capped_at_quote",
                methodologyVersion: "1",
              },
              cleanup: {
                remoteStopped,
                tunnelClosed,
                computeReleased,
                startedAt: cleanupStartedAt,
                completedAt,
              },
              startedAt,
              completedAt,
            };
            const receiptPath = path.join(
              artifactRoot,
              "evaluation-session-receipt.json",
            );
            await writeFile(
              receiptPath,
              canonicalJson({
                ...receiptCore,
                contentHash: contentHash(receiptCore),
              }),
              { mode: 0o600 },
            );
            await writeFile(
              controllerStatePath,
              canonicalJson({
                schemaVersion:
                  "openpond.primeEvaluationControllerState.v1",
                sessionId,
                status:
                  remoteStopped
                  && tunnelClosed
                  && computeReleased
                    ? "released"
                    : "cleanup_pending",
                providerNodeId:
                  providerResource?.nodeId ?? null,
                deadline: lockedQuote.deadline,
                updatedAt: completedAt,
              }),
              { mode: 0o600 },
            );
            live.delete(sessionId);
            if (
              !remoteStopped
              || !tunnelClosed
              || !computeReleased
            ) {
              throw new Error(
                `Prime evaluation ${sessionId} completed, but cleanup remains pending.`,
              );
            }
            return {
              costUsd: estimatedCostUsd,
              receiptPath,
            };
          })();
          return releasePromise;
        },
      };
      deadlineSession = session;
      live.set(sessionId, session);
      return session;
    } catch (error) {
      if (deadlineTimer) {
        clearTimeout(deadlineTimer);
        deadlineTimer = null;
      }
      const cleanupStartedAt = now().toISOString();
      let remoteStopped = transport === null;
      let tunnelClosed = tunnel === null;
      const targetNodeId =
        node?.nodeId ?? provisionedNodeId;
      let computeReleased = targetNodeId === null;
      if (transport && remoteDirectory) {
        remoteStopped = await stopPrimeEvaluationRemote(
          transport,
          remoteDirectory,
        );
        await downloadPrimeEvaluationArtifacts({
          transport,
          remoteDirectory,
          artifactRoot,
        });
      }
      if (tunnel) {
        tunnelClosed = await tunnel.close().then(
          () => true,
          () => false,
        );
        tunnel = null;
      }
      if (targetNodeId) {
        computeReleased = await provider.client
          .terminate(targetNodeId)
          .then(
            () => true,
            () => false,
          );
        if (computeReleased) {
          node = null;
          provisionedNodeId = null;
        }
      }
      const completedAt = now().toISOString();
      const elapsedHours = Math.max(
        0,
        new Date(completedAt).getTime()
          - new Date(startedAt).getTime(),
      ) / 3_600_000;
      const estimatedCostUsd = quoted
        ? roundUsd(
            Math.min(
              quoted.estimatedCostUsd,
              elapsedHours * quoted.hourlyCostUsd,
            ),
          )
        : null;
      const failureReceipt =
        createPrimeEvaluationFailureReceipt({
          sessionId,
          purpose: options.purpose,
          stage: failureStage,
          error: safeMessage(error),
          model: {
            repository: baseProfile.modelId,
            revision: baseProfile.revision,
            baseAlias,
            candidateAlias:
              options.adapter ? CANDIDATE_ALIAS : null,
          },
          adapter: options.adapter
            ? {
                configSha256:
                  options.adapter.configSha256,
                weightsSha256:
                  options.adapter.weightsSha256,
              }
            : null,
          wallet: selectedWallet,
          quote: quoted,
          provisionAttempts,
          providerResource: {
            nodeId: targetNodeId,
            deviceOrPool:
              providerResource?.deviceOrPool
              ?? quoted?.device.id
              ?? null,
            sshHostFingerprint:
              providerResource?.sshHostFingerprint ?? null,
            acquiredAt:
              providerResource?.acquiredAt ?? null,
          },
          requests: requestFacts,
          usage: summarizeUsage(requestFacts),
          cost: {
            providerReportedUsd: null,
            estimatedUsd: estimatedCostUsd,
            methodology:
              "elapsed_hours_times_locked_hourly_quote_capped_at_quote",
            methodologyVersion: "1",
          },
          cleanup: {
            remoteStopped,
            tunnelClosed,
            computeReleased,
            startedAt: cleanupStartedAt,
            completedAt,
          },
          startedAt,
          completedAt,
        });
      await writeFile(
        path.join(
          artifactRoot,
          "evaluation-session-failure-receipt.json",
        ),
        canonicalJson(failureReceipt),
        { mode: 0o600 },
      ).catch(() => undefined);
      await writeFile(
        controllerStatePath,
        canonicalJson({
          schemaVersion:
            "openpond.primeEvaluationControllerState.v1",
          sessionId,
          status: computeReleased
            ? "failed"
            : "cleanup_pending",
          providerNodeId: targetNodeId,
          deadline: quoted?.deadline ?? null,
          error:
            error instanceof Error
              ? error.message
              : String(error),
          updatedAt: completedAt,
        }),
        { mode: 0o600 },
      ).catch(() => undefined);
      throw error;
    }
  }

  function applies(model: ChatModelRef): boolean {
    return model.providerId === "custom-openai-compatible"
      && model.modelId.startsWith(MARKER_PREFIX);
  }

  const stream: CrossSystemFrontierModelStream =
    async function* (streamInput) {
      const parsed = parseMarker(streamInput.model.modelId);
      const session = parsed ? live.get(parsed.sessionId) : null;
      const servedModel = session?.aliases.get(
        streamInput.model.modelId,
      );
      if (!session || !servedModel) {
        throw new Error(
          "The raw-Prime evaluation session is unavailable.",
        );
      }
      const startedAt = now().toISOString();
      const response = await request(
        `http://127.0.0.1:${session.localPort}/v1/chat/completions`,
        {
          method: "POST",
          headers: {
            accept: "application/json",
            "content-type": "application/json",
          },
          body: JSON.stringify({
            model: servedModel,
            messages: streamInput.messages,
            tools: streamInput.tools,
            tool_choice: streamInput.toolChoice,
            max_tokens: streamInput.maxOutputTokens ?? 1_024,
            temperature: streamInput.temperature ?? 0.2,
            top_p: streamInput.topP ?? 0.95,
            seed: streamInput.seed,
          }),
          signal: streamInput.signal
            ? AbortSignal.any([
                streamInput.signal,
                session.signal,
              ])
            : session.signal,
        },
      );
      const payload = await response.json() as unknown;
      if (!response.ok) {
        throw new Error(
          `Prime vLLM evaluation failed (${response.status}): ${
            safeJson(payload).slice(0, 2_000)
          }`,
        );
      }
      const completion = parsePrimeEvaluationCompletion(
        payload,
        servedModel,
      );
      const completedAt = now().toISOString();
      session.requests.push({
        requestId: streamInput.requestId,
        servedModel,
        responseModel: completion.responseModel,
        startedAt,
        completedAt,
        latencyMs: Math.max(
          0,
          new Date(completedAt).getTime()
            - new Date(startedAt).getTime(),
        ),
        promptTokens: completion.promptTokens,
        completionTokens: completion.completionTokens,
        totalTokens: completion.totalTokens,
        finishReason: completion.finishReason,
        toolCallCount: completion.toolCalls.length,
      });
      const delta: CrossSystemFrontierModelDelta = {};
      if (completion.content) delta.text = completion.content;
      if (completion.toolCalls.length) {
        delta.toolCalls = completion.toolCalls;
      }
      delta.responseFacts = {
        providerResponseIdentity: canonicalJson({
          provider: "prime",
          responseModel: completion.responseModel,
        }),
        promptTokens: completion.promptTokens,
        generatedTokens: completion.completionTokens,
        samplingSupport: {
          seed: true,
          temperature: true,
          topP: true,
        },
      };
      yield delta;
    };

  async function cleanup(): Promise<string[]> {
    const ids = [...live.keys()];
    for (const session of [...live.values()]) {
      await session.release();
    }
    const root = path.join(
      input.storeDir,
      "training",
      "prime-evaluation",
    );
    const entries = await readdir(root, {
      withFileTypes: true,
    }).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return [];
      throw error;
    });
    let provider:
      | Awaited<ReturnType<typeof resolveProvider>>
      | null = null;
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const statePath = path.join(
        root,
        entry.name,
        "controller-state.json",
      );
      let state: Record<string, unknown>;
      try {
        const parsed = JSON.parse(
          await readFile(statePath, "utf8"),
        );
        if (
          !parsed
          || typeof parsed !== "object"
          || Array.isArray(parsed)
        ) {
          continue;
        }
        state = parsed as Record<string, unknown>;
      } catch {
        continue;
      }
      if (
        state.status !== "active"
        && state.status !== "cleanup_pending"
      ) {
        continue;
      }
      if (typeof state.providerNodeId !== "string") {
        continue;
      }
      provider ??= await resolveProvider();
      const reconciled = await provider.client
        .terminate(state.providerNodeId)
        .then(
          () => true,
          () => false,
        );
      if (!reconciled) continue;
      const cleanedAt = now().toISOString();
      await writeFile(
        statePath,
        canonicalJson({
          ...state,
          status: "reconciled",
          updatedAt: cleanedAt,
        }),
        { mode: 0o600 },
      );
      const failureReceiptPath = path.join(
        root,
        entry.name,
        "evaluation-session-failure-receipt.json",
      );
      try {
        const failureReceipt = JSON.parse(
          await readFile(failureReceiptPath, "utf8"),
        ) as Record<string, unknown>;
        const {
          contentHash: _discardedContentHash,
          ...failureCore
        } = failureReceipt;
        const cleanupRecord =
          failureCore.cleanup
          && typeof failureCore.cleanup === "object"
          && !Array.isArray(failureCore.cleanup)
            ? failureCore.cleanup as Record<string, unknown>
            : {};
        const reconciledCore = {
          ...failureCore,
          cleanup: {
            ...cleanupRecord,
            remoteStopped: true,
            tunnelClosed: true,
            computeReleased: true,
            completedAt: cleanedAt,
            reconciledAt: cleanedAt,
          },
        };
        await writeFile(
          failureReceiptPath,
          canonicalJson({
            ...reconciledCore,
            contentHash: contentHash(reconciledCore),
          }),
          { mode: 0o600 },
        );
      } catch {
        // Older active sessions may predate the canonical failure receipt.
      }
      ids.push(entry.name);
    }
    return ids;
  }

  async function resolveProvider() {
    const apiKey = await input.resolvePrimeCredential();
    const identity = await resolvePrimeSshIdentity(
      await listPrimeSshKeys({ apiKey, request }),
    );
    return {
      privateKeyPath: identity.privateKeyPath,
      client: new PrimeRawComputeHttpClient({
        apiKey: input.resolvePrimeCredential,
        sshKeyId: identity.sshKeyId,
        image: "prime_rl",
        gpuType: "A10_24GB",
        request,
        autoRestart: false,
        readyTimeoutMs: 15 * 60_000,
        verifySshHostKey: scanSshHostFingerprint,
        now,
      }),
    };
  }

  return {
    applies,
    stream,
    start,
    prepareBaselineModels,
    cleanup,
  };
}

function marker(
  sessionId: string,
  arm: "base" | "candidate",
): string {
  return `${MARKER_PREFIX}${sessionId}:${arm}`;
}

export function createPrimeEvaluationFailureReceipt(input: {
  sessionId: string;
  purpose: "train-signal" | "frozen-benchmark";
  stage: string;
  error: string;
  model: Record<string, unknown>;
  adapter: Record<string, unknown> | null;
  wallet: unknown;
  quote: unknown;
  provisionAttempts: unknown[];
  providerResource: Record<string, unknown>;
  requests: unknown[];
  usage: unknown;
  cost: Record<string, unknown>;
  cleanup: {
    remoteStopped: boolean;
    tunnelClosed: boolean;
    computeReleased: boolean;
    startedAt: string;
    completedAt: string;
  };
  startedAt: string;
  completedAt: string;
}) {
  const core = {
    schemaVersion:
      "openpond.primeEvaluationSessionFailureReceipt.v1" as const,
    ...input,
  };
  return {
    ...core,
    contentHash: contentHash(core),
  };
}

type PrimeEvaluationTransport = Awaited<
  ReturnType<typeof createPrimeRolloutSshTransport>
>;

async function stopPrimeEvaluationRemote(
  transport: PrimeEvaluationTransport,
  remoteDirectory: string,
): Promise<boolean> {
  return transport
    .runRemote([
      "bash",
      "-lc",
      [
        'run_dir="$1"',
        'touch "$run_dir/cancel"',
        "attempt=0",
        'while [ -f "$run_dir/openpond-runner.pid" ] && [ "$attempt" -lt 50 ]; do',
        "  sleep 0.2",
        "  attempt=$((attempt + 1))",
        "done",
        'test ! -f "$run_dir/openpond-runner.pid"',
      ].join("\n"),
      "openpond-prime-evaluation-stop",
      remoteDirectory,
    ])
    .then(
      () => true,
      () => false,
    );
}

async function downloadPrimeEvaluationArtifacts(input: {
  transport: PrimeEvaluationTransport;
  remoteDirectory: string;
  artifactRoot: string;
}): Promise<void> {
  await Promise.all([
    "evaluation-server.log",
    "evaluation-server-receipt.json",
    "vllm-bootstrap.log",
    "vllm-help.txt",
    "vllm.log",
  ].map((filename) =>
    input.transport
      .download(
        `${input.remoteDirectory}/${filename}`,
        input.artifactRoot,
      )
      .catch(() => undefined)
  ));
}

function parseMarker(value: string): {
  sessionId: string;
  arm: "base" | "candidate";
} | null {
  if (!value.startsWith(MARKER_PREFIX)) return null;
  const parts = value.slice(MARKER_PREFIX.length).split(":");
  if (
    parts.length !== 2
    || !parts[0]
    || (parts[1] !== "base" && parts[1] !== "candidate")
  ) {
    return null;
  }
  return {
    sessionId: parts[0],
    arm: parts[1],
  };
}

async function waitForVllm(input: {
  port: number;
  request: typeof fetch;
  signal?: AbortSignal;
}): Promise<void> {
  const deadline = Date.now() + 15 * 60_000;
  let lastError = "vLLM did not answer.";
  while (Date.now() < deadline) {
    throwIfAborted(input.signal);
    try {
      const response = await input.request(
        `http://127.0.0.1:${input.port}/v1/models`,
        { signal: AbortSignal.timeout(5_000) },
      );
      if (response.ok) return;
      lastError = `${response.status} ${response.statusText}`;
    } catch (error) {
      lastError = error instanceof Error
        ? error.message
        : String(error);
    }
    await delay(2_000);
  }
  throw new Error(
    `Prime vLLM evaluation readiness timed out: ${lastError}`,
  );
}

export function parsePrimeEvaluationCompletion(
  value: unknown,
  expectedModel: string,
) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Prime vLLM returned a non-object completion.");
  }
  const record = value as Record<string, unknown>;
  const responseModel =
    typeof record.model === "string" ? record.model : "";
  if (responseModel !== expectedModel) {
    throw new Error(
      `Prime vLLM served ${responseModel || "no model identity"} instead of ${expectedModel}.`,
    );
  }
  const choices = Array.isArray(record.choices)
    ? record.choices
    : [];
  const choice =
    choices[0]
    && typeof choices[0] === "object"
    && !Array.isArray(choices[0])
      ? choices[0] as Record<string, unknown>
      : null;
  const message =
    choice?.message
    && typeof choice.message === "object"
    && !Array.isArray(choice.message)
      ? choice.message as Record<string, unknown>
      : null;
  if (!choice || !message) {
    throw new Error("Prime vLLM completion has no assistant choice.");
  }
  const toolCalls = Array.isArray(message.tool_calls)
    ? message.tool_calls.map(parseToolCall)
    : [];
  const usage =
    record.usage
    && typeof record.usage === "object"
    && !Array.isArray(record.usage)
      ? record.usage as Record<string, unknown>
      : {};
  return {
    responseModel,
    content:
      typeof message.content === "string"
        ? message.content
        : null,
    toolCalls,
    finishReason:
      typeof choice.finish_reason === "string"
        ? choice.finish_reason
        : null,
    promptTokens: nullableInteger(usage.prompt_tokens),
    completionTokens: nullableInteger(
      usage.completion_tokens,
    ),
    totalTokens: nullableInteger(usage.total_tokens),
  };
}

function parseToolCall(
  value: unknown,
  index: number,
): HostedChatToolCall {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Prime vLLM returned an invalid tool call.");
  }
  const call = value as Record<string, unknown>;
  const fn =
    call.function
    && typeof call.function === "object"
    && !Array.isArray(call.function)
      ? call.function as Record<string, unknown>
      : null;
  if (
    !fn
    || typeof fn.name !== "string"
    || typeof fn.arguments !== "string"
  ) {
    throw new Error("Prime vLLM returned an incomplete tool call.");
  }
  return {
    id:
      typeof call.id === "string"
        ? call.id
        : `call_${index + 1}`,
    type: "function",
    function: {
      name: fn.name,
      arguments: fn.arguments,
    },
  };
}

function summarizeUsage(facts: RequestFact[]) {
  return {
    requests: facts.length,
    promptTokens: sumNullable(
      facts.map((fact) => fact.promptTokens),
    ),
    completionTokens: sumNullable(
      facts.map((fact) => fact.completionTokens),
    ),
    totalTokens: sumNullable(
      facts.map((fact) => fact.totalTokens),
    ),
    toolCalls: facts.reduce(
      (sum, fact) => sum + fact.toolCallCount,
      0,
    ),
  };
}

function sumNullable(
  values: Array<number | null>,
): number | null {
  return values.some((value) => value === null)
    ? null
    : values.reduce<number>(
        (sum, value) => sum + (value ?? 0),
        0,
      );
}

function nullableInteger(value: unknown): number | null {
  return typeof value === "number"
    && Number.isInteger(value)
    && value >= 0
    ? value
    : null;
}

function throwIfAborted(signal?: AbortSignal): void {
  if (!signal?.aborted) return;
  throw signal.reason instanceof Error
    ? signal.reason
    : new Error("Prime evaluation was cancelled.");
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, milliseconds);
    timer.unref?.();
  });
}

type PrimeEvaluationInventory = Awaited<
  ReturnType<PrimeRawComputeHttpClient["inventory"]>
>;

type PrimeEvaluationInventoryAttempt = {
  attempt: number;
  checkedAt: string;
  status: "available" | "empty" | "error";
  deviceCount: number;
  capabilityReceipt: string | null;
  error: string | null;
};

export async function waitForPrimeEvaluationInventory(input: {
  inventory(): Promise<PrimeEvaluationInventory>;
  artifactRoot: string;
  waitMs: number;
  pollIntervalMs: number;
  signal?: AbortSignal;
  now?: () => Date;
  wait?: (milliseconds: number) => Promise<void>;
}): Promise<PrimeEvaluationInventory> {
  if (
    !Number.isFinite(input.waitMs)
    || input.waitMs < 0
    || !Number.isFinite(input.pollIntervalMs)
    || input.pollIntervalMs <= 0
  ) {
    throw new Error(
      "Prime inventory polling requires a non-negative wait and a positive interval.",
    );
  }
  const now = input.now ?? (() => new Date());
  const wait = input.wait ?? delay;
  const maximumAttempts = Math.max(
    1,
    Math.floor(input.waitMs / input.pollIntervalMs) + 1,
  );
  const attempts: PrimeEvaluationInventoryAttempt[] = [];
  let lastError: string | null = null;
  for (let attempt = 1; attempt <= maximumAttempts; attempt += 1) {
    throwIfAborted(input.signal);
    try {
      const inventory = await input.inventory();
      const available = inventory.devices.length > 0;
      attempts.push({
        attempt,
        checkedAt: inventory.checkedAt || now().toISOString(),
        status: available ? "available" : "empty",
        deviceCount: inventory.devices.length,
        capabilityReceipt: inventory.capabilityReceipt,
        error: null,
      });
      await saveInventoryAttempts(input.artifactRoot, attempts, {
        waitMs: input.waitMs,
        pollIntervalMs: input.pollIntervalMs,
      });
      if (available) return inventory;
      lastError = null;
    } catch (error) {
      lastError = safeMessage(error);
      attempts.push({
        attempt,
        checkedAt: now().toISOString(),
        status: "error",
        deviceCount: 0,
        capabilityReceipt: null,
        error: lastError,
      });
      await saveInventoryAttempts(input.artifactRoot, attempts, {
        waitMs: input.waitMs,
        pollIntervalMs: input.pollIntervalMs,
      });
    }
    if (attempt < maximumAttempts) {
      await wait(input.pollIntervalMs);
    }
  }
  throwIfAborted(input.signal);
  const duration = formatWaitDuration(input.waitMs);
  throw new Error(
    `Prime evaluation inventory remained unavailable after ${attempts.length} check${attempts.length === 1 ? "" : "s"} over up to ${duration}; no H100 was provisioned.${
      lastError ? ` Last inventory error: ${lastError}` : ""
    }`,
  );
}

async function availablePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close();
        reject(new Error("Could not allocate a local port."));
        return;
      }
      server.close((error) => {
        if (error) reject(error);
        else resolve(address.port);
      });
    });
  });
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

async function saveProvisionAttempts(
  artifactRoot: string,
  attempts: unknown[],
): Promise<void> {
  await writeFile(
    path.join(artifactRoot, "provisioning-attempts.json"),
    canonicalJson({
      schemaVersion:
        "openpond.primeEvaluationProvisionAttempts.v1",
      attempts,
      contentHash: contentHash(attempts),
    }),
    { mode: 0o600 },
  );
}

async function saveInventoryAttempts(
  artifactRoot: string,
  attempts: PrimeEvaluationInventoryAttempt[],
  policy: {
    waitMs: number;
    pollIntervalMs: number;
  },
): Promise<void> {
  const receiptCore = {
    schemaVersion:
      "openpond.primeEvaluationInventoryAttempts.v1",
    policy,
    attempts,
  };
  await writeFile(
    path.join(artifactRoot, "inventory-attempts.json"),
    canonicalJson({
      ...receiptCore,
      contentHash: contentHash(receiptCore),
    }),
    { mode: 0o600 },
  );
}

function formatWaitDuration(milliseconds: number): string {
  if (milliseconds >= 60_000) {
    const minutes = milliseconds / 60_000;
    return Number.isInteger(minutes)
      ? `${minutes} minutes`
      : `${minutes.toFixed(1)} minutes`;
  }
  const seconds = milliseconds / 1_000;
  return Number.isInteger(seconds)
    ? `${seconds} seconds`
    : `${seconds.toFixed(1)} seconds`;
}

function safeMessage(error: unknown): string {
  return (
    error instanceof Error ? error.message : String(error)
  )
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 2_000);
}

function roundUsd(value: number): number {
  return Math.round(value * 1_000_000) / 1_000_000;
}
