import {
  ModelBindingRoleSchema,
  ModelBindingSchema,
  resolveModelBindingPromotionGate,
  type ModelBindingRole,
} from "@openpond/contracts";
import { contentHash } from "@openpond/taskset-sdk";
import type { SqliteStore } from "../store/store.js";
import {
  createManagedModelBindingCoordinator,
  type ManagedModelBindingCallbacks,
} from "./managed-model-binding-coordinator.js";
import { updateModelCreateImproveRelease } from "./model-release-reconciliation.js";
import {
  type createFireworksServingService,
} from "./fireworks-serving-service.js";
import {
  stopActiveFireworksServingSessions,
} from "./training-model-controls.js";
import { assertArtifactIntegrity } from "./training-service-helpers.js";

export function createTrainingModelBindingService(
  deps: {
    store: SqliteStore;
    fireworksServing: ReturnType<typeof createFireworksServingService>;
  } & ManagedModelBindingCallbacks,
) {
  const managedModelBindings = createManagedModelBindingCoordinator({
    store: deps.store,
    deactivateManagedBinding: deps.deactivateManagedBinding,
    reactivateManagedBinding: deps.reactivateManagedBinding,
    activateManagedBinding: deps.activateManagedBinding,
  });
  const updateModelRelease = (
    input: Omit<
      Parameters<typeof updateModelCreateImproveRelease>[0],
      "store"
    >,
  ) => updateModelCreateImproveRelease({ store: deps.store, ...input });

  async function rejectModel(input: {
    modelId: string;
    reason: string;
  }) {
    const model = await deps.store.getModelArtifactLineage(input.modelId);
    if (!model) throw new Error("Imported model not found.");
    const activeBindings = (await deps.store.listModelBindings()).filter(
      (binding) =>
        binding.status === "active"
        && binding.modelArtifactLineageId === model.id,
    );
    if (activeBindings.length) {
      throw new Error(
        "Roll back every active Model binding before rejecting this artifact.",
      );
    }
    await stopActiveFireworksServingSessions(deps.fireworksServing, {
      modelArtifactLineageId: model.id,
      reason: "Reject this Model",
    });
    const timestamp = new Date().toISOString();
    const rejected = await deps.store.saveModelArtifactLineage({
      ...model,
      status: "rejected",
      rejectedAt: timestamp,
      rejectionReason: input.reason,
    });
    await updateModelRelease({
      modelId: model.id,
      jobId: model.jobId,
      artifactId: model.artifactId,
      status: "rejected",
      receiptId: `model_rejection_${contentHash([
        model.id,
        timestamp,
        input.reason,
      ]).slice(0, 24)}`,
      timestamp,
      reason: input.reason,
    });
    return rejected;
  }

  async function bindModel(input: {
    profileId: string;
    modelId: string;
    role: ModelBindingRole;
    roleTargetId: string;
    promotedBy?: string;
  }) {
    const role = ModelBindingRoleSchema.parse(input.role);
    const roleTargetId = input.roleTargetId.trim();
    if (!roleTargetId) {
      throw new Error("Model binding target is required.");
    }
    const model = await deps.store.getModelArtifactLineage(input.modelId);
    if (!model || model.status !== "imported") {
      throw new Error("Imported model not found.");
    }
    const promotionGate = resolveModelBindingPromotionGate(model);
    if (!promotionGate) {
      throw new Error(
        "This Model did not pass a supported frozen evaluation promotion gate.",
      );
    }
    const [taskset, job, artifact, evaluationArtifact] = await Promise.all([
      deps.store.getTaskset(model.tasksetId),
      deps.store.getTrainingJob(model.jobId),
      deps.store.getTrainingArtifact(model.artifactId),
      promotionGate.evaluationArtifactId
        ? deps.store.getTrainingArtifact(
            promotionGate.evaluationArtifactId,
          )
        : Promise.resolve(null),
    ]);
    if (!taskset || taskset.profileId !== input.profileId) {
      throw new Error(
        "The Model does not belong to the active Profile.",
      );
    }
    if (!job || job.status !== "succeeded" || !artifact) {
      throw new Error(
        "The Model artifact does not have a completed training receipt.",
      );
    }
    if (
      promotionGate.kind === "source_frozen_evaluation"
      && (
        !evaluationArtifact
        || evaluationArtifact.kind !== "evaluation"
        || evaluationArtifact.jobId !== job.id
        || evaluationArtifact.metadata.thresholdPassed !== true
      )
    ) {
      throw new Error(
        "The Model has no matching frozen-evaluation threshold receipt.",
      );
    }
    await Promise.all([
      assertArtifactIntegrity(
        artifact.path,
        artifact.sha256,
        artifact.sizeBytes,
      ),
      ...(evaluationArtifact
        ? [
            assertArtifactIntegrity(
              evaluationArtifact.path,
              evaluationArtifact.sha256,
              evaluationArtifact.sizeBytes,
            ),
          ]
        : []),
    ]);
    let current = await deps.store.getActiveModelBinding({
      profileId: input.profileId,
      role,
      roleTargetId,
    });
    if (current?.modelArtifactLineageId === model.id) return current;
    const timestamp = new Date().toISOString();
    const binding = ModelBindingSchema.parse({
      schemaVersion: "openpond.modelBinding.v1",
      id: `model_binding_${contentHash([
        input.profileId,
        role,
        roleTargetId,
        model.id,
        timestamp,
      ]).slice(0, 24)}`,
      profileId: input.profileId,
      role,
      roleTargetId,
      modelArtifactLineageId: model.id,
      tasksetId: taskset.id,
      evaluationArtifactId: promotionGate.evaluationArtifactId,
      status: "active",
      priorBindingId: current?.id ?? null,
      rollbackTargetBindingId: current?.id ?? null,
      promotedBy: input.promotedBy?.trim() || "local_user",
      promotedAt: timestamp,
      rolledBackAt: null,
      metadata: {
        jobId: job.id,
        artifactId: artifact.id,
        artifactHash: artifact.sha256,
        trainingMethod:
          (await deps.store.getTrainingPlan(job.planId))?.recipe.method
          ?? null,
        evaluationThresholdPassed: true,
        promotionGate: promotionGate.kind,
        canonicalSandboxArtifactId: promotionGate.canonicalArtifactId,
        canonicalSandboxDeploymentId: promotionGate.canonicalDeploymentId,
        managedProjectionVersion: 1,
      },
    });
    current = (
      await managedModelBindings.replace({
        profileId: input.profileId,
        role,
        roleTargetId,
        current,
        next: binding,
        timestamp,
      })
    ).previous;
    await deps.store.saveModelArtifactLineage({
      ...model,
      pinned: true,
    });
    if (current) {
      const prior = await deps.store.getModelArtifactLineage(
        current.modelArtifactLineageId,
      );
      if (prior) {
        await deps.store.saveModelArtifactLineage({
          ...prior,
          pinned: true,
        });
      }
    }
    await updateModelRelease({
      modelId: model.id,
      jobId: model.jobId,
      artifactId: model.artifactId,
      status: "released",
      receiptId: binding.id,
      timestamp,
      reason: null,
    });
    return binding;
  }

  async function rollbackModelBinding(input: {
    bindingId: string;
    rolledBackBy?: string;
  }) {
    let binding = await deps.store.getModelBinding(input.bindingId);
    if (!binding || binding.status !== "active") {
      throw new Error("Active Model binding not found.");
    }
    const rollbackTarget = binding.rollbackTargetBindingId
      ? await deps.store.getModelBinding(binding.rollbackTargetBindingId)
      : null;
    if (
      rollbackTarget
      && (
        rollbackTarget.profileId !== binding.profileId
        || rollbackTarget.role !== binding.role
        || rollbackTarget.roleTargetId !== binding.roleTargetId
      )
    ) {
      throw new Error(
        "The recorded rollback target does not match the active Model role.",
      );
    }
    const timestamp = new Date().toISOString();
    const restored = rollbackTarget
      ? ModelBindingSchema.parse({
          ...rollbackTarget,
          id: `model_binding_${contentHash([
            binding.id,
            rollbackTarget.id,
            timestamp,
          ]).slice(0, 24)}`,
          status: "active",
          priorBindingId: binding.id,
          rollbackTargetBindingId: rollbackTarget.priorBindingId,
          promotedBy: input.rolledBackBy?.trim() || "local_user",
          promotedAt: timestamp,
          rolledBackAt: null,
          metadata: {
            ...rollbackTarget.metadata,
            action: "rollback",
            rolledBackBindingId: binding.id,
            restoredFromBindingId: rollbackTarget.id,
            managedProjectionVersion: 1,
          },
        })
      : null;
    binding = (
      await managedModelBindings.replace({
        profileId: binding.profileId,
        role: binding.role,
        roleTargetId: binding.roleTargetId,
        current: binding,
        next: restored,
        timestamp,
      })
    ).previous!;
    if (restored) {
      const restoredModel = await deps.store.getModelArtifactLineage(
        restored.modelArtifactLineageId,
      );
      if (restoredModel) {
        await deps.store.saveModelArtifactLineage({
          ...restoredModel,
          pinned: true,
        });
      }
    }
    const model = await deps.store.getModelArtifactLineage(
      binding.modelArtifactLineageId,
    );
    if (model) {
      await updateModelRelease({
        modelId: model.id,
        jobId: model.jobId,
        artifactId: model.artifactId,
        status: "rolled_back",
        receiptId: binding.id,
        timestamp,
        reason: null,
      });
    }
    return {
      rolledBackBindingId: binding.id,
      activeBinding: restored,
    };
  }

  return { rejectModel, bindModel, rollbackModelBinding };
}
