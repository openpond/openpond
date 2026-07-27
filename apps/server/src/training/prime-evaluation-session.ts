import { randomUUID } from "node:crypto";
import {
  mkdir,
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
import {
  canonicalJson,
  contentHash,
} from "@openpond/taskset-sdk";
import { scanSshHostFingerprint } from "@openpond/trainer-connected";

import {
  materializeRemotePythonProject,
} from "./python-project-staging.js";
import {
  PRIME_GRPO_QWEN3_0_6B_PROFILE,
  primeGrpoBaseProfileForModel,
  type PrimeGrpoBaseProfile,
} from "./prime-grpo-base-profiles.js";
import {
  choosePrimeComputeQuote,
  type PrimeComputeQuoteCandidate,
} from "./prime-compute-quote.js";
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
import {
  PRIME_EVALUATION_MARKER_PREFIX as MARKER_PREFIX,
  availablePort,
  cleanupPrimeEvaluationSessions,
  createPrimeEvaluationFailureReceipt,
  downloadPrimeEvaluationArtifacts,
  marker,
  parseMarker,
  parsePrimeEvaluationCompletion,
  preparePrimeEvaluationBaselineModels,
  roundUsd,
  safeJson,
  safeMessage,
  saveProvisionAttempts,
  stopPrimeEvaluationRemote,
  summarizeUsage,
  throwIfAborted,
  waitForPrimeEvaluationInventory,
  waitForVllm,
  type PrimeEvaluationAdapterInput,
  type PrimeEvaluationLiveSession,
  type PrimeEvaluationRequestFact,
} from "./prime-evaluation-session-support.js";

export {
  createPrimeEvaluationFailureReceipt,
  parsePrimeEvaluationCompletion,
  waitForPrimeEvaluationInventory,
} from "./prime-evaluation-session-support.js";

const REMOTE_INFERENCE_PORT = 8_000;
export const PRIME_EVALUATION_PYTHON_EXECUTABLE = "python";
const CANDIDATE_ALIAS = "openpond-policy-v1";
const DEFAULT_INVENTORY_WAIT_MS = 10 * 60_000;
const DEFAULT_INVENTORY_POLL_INTERVAL_MS = 15_000;

type AdapterInput = PrimeEvaluationAdapterInput;
type RequestFact = PrimeEvaluationRequestFact;
type LiveSession = PrimeEvaluationLiveSession;

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

  function prepareBaselineModels(
    models: ChatModelRef[],
    options: FireworksBaselinePrepareOptions = {},
  ): Promise<PreparedBaselineModels> {
    return preparePrimeEvaluationBaselineModels(
      models,
      options,
      start,
      primeGrpoBaseProfileForModel,
    );
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
    let quoted: PrimeComputeQuoteCandidate | null = null;
    let selectedWallet = wallet;
    try {
      for (const [index, device] of orderedDevices
        .slice(0, 3)
        .entries()) {
        throwIfAborted(options.signal);
        const currentWallet = index === 0
          ? wallet
          : await provider.client.walletBalance();
        let candidate: PrimeComputeQuoteCandidate;
        try {
          candidate = choosePrimeComputeQuote({
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

  function cleanup(): Promise<string[]> {
    return cleanupPrimeEvaluationSessions({
      live,
      storeDir: input.storeDir,
      resolveProvider,
      now,
    });
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
