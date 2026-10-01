import { z } from "zod";
import { contentHash } from "@openpond/harness";
import {
  RefinerReleaseSchema,
  serializeReviewProfile,
} from "@openpond/harness/refiner";
import type {
  OpenPondProfileState,
  HarnessWorkspace,
  Session,
} from "@openpond/contracts";
import { SessionSchema, ModelRunSchema } from "@openpond/contracts";
import { AdvancedRefinerEvaluationStartSchema } from "openpond-sdk/advanced-refiner-evaluations";
import type { SqliteStore } from "../store/store.js";
import { refinerProfilePaths } from "../refiner/refiner-profile-service.js";
import { createLocalRefinerProfileRepository } from "../refiner/refiner-profile-repository.js";
import { createBenchmarkTasksetService } from "./benchmark-tasksets.js";
import { createTaskEvaluationService } from "./evaluation-service.js";
import { createTaskAttemptModelJudge } from "./task-attempt-grader-evidence.js";
import { createHarnessRefinerBenchmarkService } from "./harness-refiner-benchmark-service.js";
import {
  currentAdvancedRefinerBoundary,
  createAdvancedRefinerPaidBoundary,
} from "./advanced-refiner-paid-boundary.js";
import { createAdvancedRefinerReviewQuality } from "./advanced-refiner-review-quality.js";
import {
  HostedAdvancedBridgeSchema,
  createHostedAdvancedModelBridge,
} from "./hosted-advanced-model-bridge.js";
import {
  HostedAdvancedPrivateSourceSchema,
  createHostedAdvancedRefinerSource,
} from "./hosted-advanced-refiner-source.js";
import { createHostedAdvancedWorkRuntime } from "./hosted-advanced-work-runtime.js";
const Hash = z.string().regex(/^[a-f0-9]{64}$/);
const Pricing = z
  .object({
    version: z.string().min(1),
    source: z.string().min(1),
    effectiveAt: z.string().min(1),
    inputUsdPerMillionTokens: z.number().finite().nonnegative(),
    cachedInputUsdPerMillionTokens: z.number().finite().nonnegative(),
    outputUsdPerMillionTokens: z.number().finite().nonnegative(),
  })
  .strict();
export const HostedAdvancedOwnerRequestSchema = z
  .object({
    operation: z.enum(["prepare_run", "start", "read", "resume", "cancel"]),
    request: AdvancedRefinerEvaluationStartSchema,
    configuration: z
      .object({
        id: z.string().min(1),
        profileId: z.string().min(1),
        etag: Hash,
      })
      .strict(),
    refinerRelease: RefinerReleaseSchema,
    privateSource: HostedAdvancedPrivateSourceSchema,
    upstream: z
      .object({
        modelId: z.string().min(1),
        revision: z.string().min(1),
        pricing: Pricing,
      })
      .strict(),
    judgeModels: z
      .array(
        z
          .object({
            modelId: z.string().min(1),
            revision: z.string().min(1),
            pricing: Pricing,
          })
          .strict(),
      )
      .max(50),
    bridge: HostedAdvancedBridgeSchema.optional(),
    hostedTurnId: z.string().min(1).optional(),
  })
  .strict();
/** A real private hosted compiler/store owner composes the existing sequential
 * and review engines. Only its worker-side grant can execute a model or guest. */
export async function runHostedAdvancedRefinerOwner(deps: {
  store: SqliteStore;
  storeDir: string;
  actor: { actorId: string; teamId: string };
  profile: OpenPondProfileState;
  workspace: HarnessWorkspace;
  source: { repositoryId: string; profileId: string; sourceRevision: string };
  evidence: unknown;
  request: unknown;
  authorize(): Promise<void>;
  signal: AbortSignal;
}) {
  const input = HostedAdvancedOwnerRequestSchema.parse(deps.request),
    pin = input.request.pin;
  if (
    input.request.model.providerId !== "openpond" ||
    input.request.model.modelId !== input.upstream.modelId ||
    input.configuration.id !== input.request.modelId ||
    input.configuration.profileId !== pin.profileRef.profileId ||
    input.request.profileId !== pin.profileRef.profileId ||
    input.refinerRelease.id !== pin.refinerRelease.id ||
    input.refinerRelease.contentHash !== pin.refinerRelease.contentHash
  )
    throw new Error(
      "The actual hosted advanced configuration/model/Refiner admission changed.",
    );
  const id = `advanced-refiner-${contentHash([pin.actorId, pin.teamId, pin.operationId, pin.contentHash, input.request.model, [input.request.seed], 1]).slice(0, 40)}`;
  const paid = input.operation === "start" || input.operation === "resume";
  if (paid && (!input.bridge || !input.hostedTurnId))
    throw new Error(
      "The actual hosted advanced execution grant is unavailable.",
    );
  const bridge = input.bridge
    ? createHostedAdvancedModelBridge(input.bridge, deps.signal)
    : null;
  if (
    input.bridge &&
    (input.bridge.jobId !== id || input.bridge.pinHash !== pin.contentHash)
  )
    throw new Error("The hosted model bridge belongs to another actual Run.");
  const authorize = async () => {
    deps.signal.throwIfAborted();
    await deps.authorize();
    if (bridge) await bridge.authorize();
  };
  const source = await createHostedAdvancedRefinerSource({
    ...deps,
    pin,
    privateSource: input.privateSource,
    authorize,
  });
  const refiner = createLocalRefinerProfileRepository(
    refinerProfilePaths(deps.storeDir),
  );
  await refiner.persistRelease(input.refinerRelease);
  await refiner.writeSource(
    serializeReviewProfile(input.refinerRelease.profile),
  );
  const current = refiner.binding();
  if (current?.release.contentHash !== pin.refinerRelease.contentHash)
    await refiner.transition(input.refinerRelease, {
      operation: "activate",
      bindingChanged: true,
      actor: deps.actor.actorId,
      reason:
        "Pin the actual hosted evaluation fork to its admitted immutable Refiner release.",
      authoringSkillHash: null,
    });
  const boundary = createAdvancedRefinerPaidBoundary({
    storeDir: deps.storeDir,
    authorize: async () => authorize(),
    packageForPin: async () => input.privateSource.packageValue,
    prepareModel: async (model, max, pricing) => {
      if (!bridge)
        throw new Error(
          "The actual hosted model ceiling owner is unavailable.",
        );
      return bridge.ceiling(model, pricing, max);
    },
  });
  const stream: import("./taskset-work-attempt-types.js").TasksetWorkModelStream =
    async function* (request) {
      const guard = currentAdvancedRefinerBoundary(),
        model = [input.upstream, ...input.judgeModels].find(
          (model) => model.modelId === request.model.modelId,
        );
      if (!bridge || !guard || !model)
        throw new Error(
          "The actual hosted model and durable shared budget are unavailable.",
        );
      const { signal, ...intent } = request,
        maximumOutputTokens = request.maxOutputTokens ?? 4096;
      const deltas = await guard.call(
        request.requestId,
        intent,
        model.pricing,
        maximumOutputTokens,
        async () => {
          const deltas: import("./taskset-work-attempt-types.js").TasksetWorkModelDelta[] =
            [];
          let costUsd: number | null = null;
          for await (const delta of bridge.stream({
            ...request,
            signal: AbortSignal.any([signal, guard.signal]),
          })) {
            deltas.push(delta);
            if (delta.costUsd !== undefined)
              costUsd = (costUsd ?? 0) + delta.costUsd;
          }
          return { value: deltas, costUsd };
        },
      );
      for (const delta of deltas) yield delta;
    };
  const text: ReturnType<
    typeof import("./training-model-runtime.js").createTrainingModelRuntime
  >["trainingModelText"] = async (request) => {
    let text = "";
    for await (const delta of stream({
      ...request,
      reasoningEffort: request.reasoningEffort ?? null,
      tools: [],
      toolChoice: "none",
    })) {
      if (delta.text) text += delta.text;
      if (delta.usage !== undefined)
        request.onUsage?.(delta.usage, delta.costUsd);
    }
    return text;
  };
  const tasksets = createBenchmarkTasksetService({
      store: deps.store,
      storeDir: deps.storeDir,
    }),
    taskset = await tasksets.projectSelected({
      profileId: pin.profileRef.profileId,
      package: input.privateSource.packageValue,
      adaptationSplit: pin.adaptationSplit,
      holdoutSplit: pin.holdoutSplit,
    });
  const createSession = async (raw: unknown): Promise<Session> => {
    const value = SessionSchema.partial().parse(raw),
      now = new Date().toISOString(),
      session = SessionSchema.parse({
        ...value,
        id: `hosted-review-${contentHash([id, value.metadata]).slice(0, 40)}`,
        cloudTeamId: pin.teamId,
        currentProfile: pin.profileRef,
        appId: null,
        appName: null,
        cwd: null,
        codexThreadId: null,
        title: value.title ?? "Hosted Refiner review",
        provider: "openpond",
        createdAt: now,
        updatedAt: now,
        status: "active",
        pinned: false,
        archived: false,
        order: 0,
        metadata: {
          ...value.metadata,
          hostedAdvancedTurnId: input.hostedTurnId ?? null,
          actorId: pin.actorId,
          source: "hosted-advanced-evaluation",
        },
      });
    await deps.store.insertSessionAtFront(session);
    return session;
  };
  const workRuntime =
    bridge && input.hostedTurnId
      ? createHostedAdvancedWorkRuntime({
          store: deps.store,
          bridge,
          teamId: pin.teamId,
          actorId: pin.actorId,
          hostedTurnId: input.hostedTurnId,
          modelRunId: id,
          profileRef: pin.profileRef,
        })
      : undefined;
  const evaluation = createTaskEvaluationService({
    store: deps.store,
    storeDir: deps.storeDir,
    modelJudge: createTaskAttemptModelJudge({
      store: deps.store,
      modelText: text,
    }),
    modelText: text,
    modelStream: stream,
    workRuntime,
    resolveTasksetRelease: (taskset) => tasksets.releaseForTaskset(taskset),
  });
  const benchmarkDeps = {
    store: deps.store,
    storeDir: deps.storeDir,
    evaluation,
    benchmarkTasksets: tasksets,
    loadProfileState: async () => deps.profile,
    resolveEvaluationProject: async (modelId: string, profileId: string) => {
      await authorize();
      if (
        modelId !== input.configuration.id ||
        profileId !== input.configuration.profileId
      )
        throw new Error("The actual hosted evaluation configuration changed.");
      return { id: modelId, profileId };
    },
    resolveUpstreamModel: async () => ({
      providerId: "openpond",
      modelId: input.upstream.modelId,
      revision: input.upstream.revision,
      pricing: input.upstream.pricing,
    }),
    advancedBoundary: boundary,
    refinerStream: async function* (
      request: Parameters<
        Parameters<
          typeof createHarnessRefinerBenchmarkService
        >[0]["refinerStream"]
      >[0],
    ) {
      if (!request.requestId)
        throw new Error("A hosted Refiner call needs its actual retained ID.");
      yield* stream({
        model: request.model,
        reasoningEffort: "low",
        messages: request.messages,
        tools: [],
        toolChoice: "none",
        requestId: request.requestId,
        maxOutputTokens: 4096,
        signal: request.signal,
        hostedTokenPricing: request.pricing,
      });
    },
  };
  const benchmarks = createHarnessRefinerBenchmarkService({
    ...benchmarkDeps,
    reviewQuality: createAdvancedRefinerReviewQuality({
      source,
      boundary,
      benchmark: benchmarkDeps,
      createSession,
    }),
  });
  const start = {
    advancedEvaluation: pin,
    selectedTaskset: {
      id: taskset.id,
      revision: taskset.revision,
      contentHash: taskset.contentHash,
    },
    modelId: input.request.modelId,
    profileId: input.request.profileId,
    model: input.request.model,
    reasoningEffort: input.request.reasoningEffort,
    seeds: [input.request.seed],
    repetitions: 1,
    maximumSpendUsd: pin.maximumCostUsd,
  };
  let poll: ReturnType<typeof setInterval> | undefined;
  const stop = () => {
    void benchmarks.cancel(id);
  };
  deps.signal.addEventListener("abort", stop, { once: true });
  try {
    if (input.operation === "prepare_run") return benchmarks.prepare(start);
    const prior = await deps.store.getModelRun(id);
    if (
      !prior ||
      prior.evaluation?.benchmarkId !== "harness-refiner" ||
      prior.evaluation.advancedEvaluation?.contentHash !== pin.contentHash
    )
      throw new Error("The original hosted advanced Run is unavailable.");
    if (input.operation === "read") return prior;
    if (input.operation === "cancel") return benchmarks.cancel(id);
    if (bridge) {
      let updating = false;
      poll = setInterval(() => {
        if (updating) return;
        updating = true;
        void deps.store
          .getModelRun(id)
          .then((run) => (run ? bridge.checkpoint(run) : undefined))
          .catch(() => stop())
          .finally(() => {
            updating = false;
          });
      }, 2000);
    }
    if (input.operation === "start") await benchmarks.start(start);
    else await benchmarks.resume(id);
    const result = await benchmarks.wait(id);
    if (!result)
      throw new Error(
        "The actual hosted advanced engine did not retain its Run.",
      );
    const verified = ModelRunSchema.parse(result);
    if (bridge) await bridge.checkpoint(verified);
    return verified;
  } finally {
    if (poll) clearInterval(poll);
    deps.signal.removeEventListener("abort", stop);
    await benchmarks.close();
    await boundary.close();
  }
}
