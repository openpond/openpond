import { contentHash } from "@openpond/harness";
import {
  LocalExperimentRunSchema,
  LocalExperimentRunFromReleaseSchema,
  LocalExperimentConfigurationSnapshotSchema,
  LocalExperimentRecordSchema,
  type LocalExperimentRecord,
} from "@openpond/contracts";
import {
  validateTasksetPackage,
  type TasksetPackage,
} from "openpond-sdk/taskset-packages";
import type { z } from "zod";
import {
  LocalExperimentDefinitionSchema,
  LocalExperimentExecutionSchema,
  LocalExperimentError,
  type LocalExperimentDefinition,
  type LocalExperimentExecution,
  type LocalExperimentAdmission,
} from "./local-experiment-contract.js";
import {
  localExperimentAdmissions,
  localPackageGraders,
  selectLocalPackageGraders,
} from "./local-experiment-admission.js";
import {
  prepareLocalExperimentModel,
  type LocalModelAdmission,
} from "./local-experiment-model.js";
import type { loadOpenPondHostedModels } from "@openpond/runtime";
import type { LocalExperimentStorage } from "../store/store-local-experiments.js";
type Configuration = z.infer<typeof LocalExperimentRunSchema>["configuration"];

/** One immutable configuration and one operation receipt share the run's
 * atomic admission. All private source/model checks finish before that write. */
export function createLocalExperimentRunAdmission(deps: {
  store: LocalExperimentStorage;
  ownerId: string;
  localInference?: {
    prepare(
      configuration: LocalExperimentDefinition["configuration"],
    ): Promise<LocalModelAdmission>;
  };
  actorId(): Promise<string>;
  requireActor(id: string): Promise<void>;
  requireTeam(id: string): Promise<void>;
  ownedRecord(teamId: string, id: string): Promise<LocalExperimentRecord>;
  assertScope(configuration: Configuration): void;
  closing(): boolean;
  catalog?: typeof loadOpenPondHostedModels;
  prepareModel?(configuration:LocalExperimentDefinition["configuration"]):Promise<LocalModelAdmission>;
  authorize(
    configuration: LocalExperimentDefinition["configuration"],
  ): Promise<void>;
  preflight(
    configuration: LocalExperimentDefinition["configuration"],
    value: TasksetPackage,
  ): Promise<{ profile: boolean; native: boolean; environment: boolean }>;
  package(
    input: z.infer<typeof LocalExperimentRunFromReleaseSchema>,
  ): Promise<TasksetPackage>;
  schedule(
    execution: LocalExperimentExecution,
    admissions: LocalExperimentAdmission[],
    model: LocalModelAdmission,
  ): void;
}) {
  async function begin(configuration: Configuration, intent: unknown) {
    if (deps.closing())
      throw new LocalExperimentError(
        "local_runtime_closing",
        "The local execution owner is closing.",
        503,
      );
    const teamId = configuration.request.teamId;
    await deps.requireTeam(teamId);
    deps.assertScope(configuration);
    const ownerActorId = await deps.actorId();
    if (!ownerActorId.trim())
      throw new LocalExperimentError(
        "local_account_required",
        "Sign in before running a local Experiment.",
        403,
      );
    const intentHash = contentHash({ ownerActorId, intent });
    const prior = await deps.store.recoverLocalExperimentOperation(
      teamId,
      configuration.operationId,
      "run",
      intentHash,
    );
    if (prior)
      return {
        prior: await deps.ownedRecord(
          teamId,
          LocalExperimentRecordSchema.parse(prior).id,
        ),
        ownerActorId,
        intentHash,
      };
    if (configuration.sourceExperimentId)
      await deps.ownedRecord(teamId, configuration.sourceExperimentId);
    return { prior: null, ownerActorId, intentHash };
  }
  async function qualify(
    configuration: Configuration,
    rawPackage: unknown,
    ownerActorId: string,
  ) {
    const value = validateTasksetPackage(rawPackage),
      teamId = configuration.request.teamId;
    const { sourceExperimentId, ...runConfiguration } = configuration;
    void sourceExperimentId;
    const internalConfiguration = { ...runConfiguration, expectedRevision: 0 };
    await deps.authorize(internalConfiguration);
    const qualified = await deps.preflight(internalConfiguration, value);
    const model = deps.prepareModel ? await deps.prepareModel(internalConfiguration) :
      configuration.request.policy.kind === "hosted_chat" &&
      configuration.request.policy.localRuntime
        ? await (deps.localInference?.prepare(internalConfiguration) ??
            Promise.reject(
              new LocalExperimentError(
                "local_inference_unavailable",
                "The configured local inference owner is unavailable.",
                422,
              ),
            ))
        : await prepareLocalExperimentModel(
            configuration.request.policy,
            deps.catalog,
            qualified.native,
          );
    await deps.requireActor(ownerActorId);
    await deps.requireTeam(teamId);
    const id = `local-run-${contentHash([teamId, ownerActorId, configuration.operationId]).slice(0, 48)}`,
      now = new Date().toISOString();
    const content = {
      schemaVersion: "openpond.localExperimentDefinition.v1" as const,
      location: "local" as const,
      id: `local-configuration-${contentHash([teamId, ownerActorId, configuration.operationId]).slice(0, 40)}`,
      teamId,
      ownerActorId: ownerActorId,
      revision: 1,
      configuration: internalConfiguration,
      model: model.model,
      packageHash: value.contentHash,
      graders: selectLocalPackageGraders(value, configuration.graders),
      availableGraders: localPackageGraders(value),
      createdAt: now,
      updatedAt: now,
    };
    const definition = LocalExperimentDefinitionSchema.parse({
      ...content,
      contentHash: contentHash(content),
    });
    const snapshotContent = {
      configuration,
      model: definition.model,
      packageHash: definition.packageHash,
      graders: definition.graders,
      availableGraders: definition.availableGraders,
    };
    const snapshot = LocalExperimentConfigurationSnapshotSchema.parse({
      ...snapshotContent,
      configurationHash: contentHash(snapshotContent),
    });
    const admissions = localExperimentAdmissions(
      definition,
      value,
      id,
      qualified.native,
      qualified.environment,
      qualified.profile,
    );
    return { definition, snapshot, admissions, model, value, id, now };
  }
  async function admit(
    configuration: Configuration,
    rawPackage: unknown,
    state: Awaited<ReturnType<typeof begin>>,
  ) {
    const { definition, snapshot, admissions, model, value, id, now } =
      await qualify(configuration, rawPackage, state.ownerActorId);
    const teamId = configuration.request.teamId,
      ownerActorId = state.ownerActorId;
    const reference = {
      id: definition.id,
      revision: 1,
      contentHash: definition.contentHash,
    };
    const execution = LocalExperimentExecutionSchema.parse({
      schemaVersion: "openpond.localExperimentExecution.v1",
      location: "local",
      id,
      teamId,
      ownerActorId: ownerActorId,
      kind: "target",
      operationId: configuration.operationId,
      definition: reference,
      packageHash: value.contentHash,
      maximumCostUsd: configuration.maximumCostUsd,
      executionHash: contentHash({
        id,
        teamId,
        configurationHash: snapshot.configurationHash,
        packageHash: value.contentHash,
        admissions,
      }),
      sourceExecution: null,
      status: "queued",
      createdAt: now,
      completedAt: null,
      counts: {
        pending: admissions.length,
        running: 0,
        completed: 0,
        failed: 0,
        cancelled: 0,
        unknown: 0,
      },
      usage: { knownCostUsd: 0, costUsd: 0, heldUsd: 0, uncertainRequests: 0 },
      cleanupComplete: false,
      error: null,
    });
    const record = await deps.store.admitLocalExperimentRun({
      ownerId: deps.ownerId,
      intentHash: state.intentHash,
      definition,
      snapshot,
      package: value,
      execution,
      admissions,
    });
    const current = await deps.ownedRecord(teamId, record.id);
    if (current.status === "queued")
      deps.schedule(execution, admissions, model);
    return current;
  }
  return {
    authorize: async (raw: unknown) => {
      const input = LocalExperimentRunFromReleaseSchema.parse(raw),
        configuration = input.configuration;
      await deps.requireTeam(configuration.request.teamId);
      deps.assertScope(configuration);
      const actor = await deps.actorId();
      if (!actor.trim())
        throw new LocalExperimentError(
          "local_account_required",
          "Sign in before qualifying local evaluation.",
          403,
        );
      if (configuration.sourceExperimentId)
        await deps.ownedRecord(
          configuration.request.teamId,
          configuration.sourceExperimentId,
        );
      const value = validateTasksetPackage(await deps.package(input));
      if (
        input.expectedPackageHash &&
        value.contentHash !== input.expectedPackageHash
      )
        throw new LocalExperimentError(
          "local_package_pin_conflict",
          "The exact Dataset package changed.",
          409,
        );
      await qualify(configuration, value, actor);
      await deps.requireActor(actor);
      await deps.requireTeam(configuration.request.teamId);
    },
    run: async (raw: unknown) => {
      const input = LocalExperimentRunSchema.parse(raw),
        value = validateTasksetPackage(input.package),
        state = await begin(input.configuration, {
          kind: "package",
          configuration: input.configuration,
          packageHash: value.contentHash,
        });
      return state.prior ?? admit(input.configuration, value, state);
    },
    runFromRelease: async (raw: unknown) => {
      const input = LocalExperimentRunFromReleaseSchema.parse(raw),
        state = await begin(input.configuration, { kind: "release", input });
      if (state.prior) return state.prior;
      const value = validateTasksetPackage(await deps.package(input));
      if (
        input.expectedPackageHash &&
        value.contentHash !== input.expectedPackageHash
      )
        throw new LocalExperimentError(
          "local_package_pin_conflict",
          "The retained Dataset package differs from the reviewed release.",
          409,
        );
      return admit(input.configuration, value, state);
    },
  };
}
