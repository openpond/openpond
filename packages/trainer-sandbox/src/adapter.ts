import type {
  AdapterValidationReceipt,
  HarnessRelease,
  LearningSignalBatch,
  ResolvedTrainingPlan,
  TrainingArtifacts,
  TrainingEngineCapabilities,
  TrainingExecutionRef,
  TrainingExecutionStatus,
} from "@openpond/contracts";
import { contentHash } from "@openpond/taskset-sdk";
import type { TrainingEngineAdapter } from "@openpond/training-sdk";

import type { SandboxManagedTrainingClient } from "./client.js";

export interface SandboxReleaseResolver {
  resolve(input: {
    harnessRelease: ResolvedTrainingPlan["manifest"]["harnessRelease"];
  }): Promise<{
    release: HarnessRelease;
    assetBundle: {
      objectRef: string;
      sha256: string;
      sizeBytes: number;
    };
  }>;
}

export interface SandboxInputBundleFactory {
  create(input: {
    plan: ResolvedTrainingPlan;
    materialization: {
      materializationRef: string;
      materializationHash: string;
      environmentArchiveRef: string;
      environmentArchiveHash: string;
    };
    quote: Awaited<ReturnType<SandboxManagedTrainingClient["quote"]>>;
  }): Promise<unknown>;
}

export class SandboxTrainingEngineAdapter
  implements TrainingEngineAdapter
{
  readonly id: string;
  private readonly manifestHashes = new Map<string, string>();

  constructor(
    private readonly client: SandboxManagedTrainingClient,
    private readonly releases: SandboxReleaseResolver,
    private readonly inputBundles: SandboxInputBundleFactory,
    private readonly capabilitiesProvider: () => Promise<TrainingEngineCapabilities>,
    id = "connected-prime-rl",
  ) {
    this.id = id;
  }

  async capabilities(): Promise<TrainingEngineCapabilities> {
    return this.capabilitiesProvider();
  }

  async validate(
    plan: ResolvedTrainingPlan,
  ): Promise<AdapterValidationReceipt> {
    const issues: AdapterValidationReceipt["issues"] = [];
    if (!plan.manifest.runtimeTarget.dataPlane) {
      issues.push({
        code: "sandbox_placement_missing",
        path: "manifest.runtimeTarget.dataPlane",
        message: "Sandbox training requires an exact data-plane placement receipt.",
      });
    }
    const base = {
      schemaVersion: "openpond.adapterValidationReceipt.v1" as const,
      adapterId: this.id,
      valid: issues.length === 0,
      issues,
      capabilityReceipt: plan.manifest.runtimeTarget.capabilityReceipt,
      planHash: plan.contentHash,
      createdAt: new Date().toISOString(),
    };
    return { ...base, contentHash: contentHash(base) };
  }

  async launch(plan: ResolvedTrainingPlan): Promise<TrainingExecutionRef> {
    const resolved = await this.releases.resolve({
      harnessRelease: plan.manifest.harnessRelease,
    });
    if (resolved.release.contentHash !== plan.manifest.harnessRelease.contentHash) {
      throw new Error("Resolved Harness Release does not match the run manifest.");
    }
    if (
      resolved.assetBundle.sha256 !==
      plan.manifest.resolvedBundleHash
    ) {
      throw new Error(
        "Resolved Sandbox environment bundle does not match the run manifest.",
      );
    }
    const uploaded = await this.client.uploadHarnessRelease({
      release: resolved.release,
      assetBundle: resolved.assetBundle,
      idempotencyKey: resolved.release.contentHash,
    });
    const materialized = await this.client.materialize({
      manifest: plan.manifest,
      releaseRef: uploaded.releaseRef,
      releaseContentHash: uploaded.releaseContentHash,
      projection: "environment",
    });
    const placement = plan.manifest.runtimeTarget.dataPlane;
    if (
      !placement ||
      materialized.placementCapabilityReceipt !== placement.capabilityReceipt
    ) {
      throw new Error("Sandbox materialization placement receipt changed.");
    }
    const quote = await this.client.quote({
      manifest: plan.manifest,
      materializationRef: materialized.materializationRef,
      materializationHash: materialized.materializationHash,
    });
    if (
      plan.maximumSpendUsd === null ||
      (quote.estimatedCostUsd !== null &&
        quote.estimatedCostUsd > plan.maximumSpendUsd)
    ) {
      throw new Error("Sandbox quote is not covered by the approved maximum spend.");
    }
    const approval = await this.client.approve({
      manifestHash: plan.manifest.contentHash,
      materializationRef: materialized.materializationRef,
      materializationHash: materialized.materializationHash,
      providerQuote: quote.providerQuote,
      quoteSignature: quote.quoteSignature,
      maximumSpendUsd: plan.maximumSpendUsd,
      approvalHash: plan.approvalHash,
    });
    const inputBundle = await this.inputBundles.create({
      plan,
      materialization: materialized,
      quote,
    });
    const ref = await this.client.launch({
      runId: plan.manifest.id,
      manifestHash: plan.manifest.contentHash,
      name: `OpenPond ${plan.manifest.id}`,
      inputBundle,
      approvalLeaseRef: approval.approvalLeaseRef,
      idempotencyKey: plan.contentHash,
    });
    if (
      ref.runId !== plan.manifest.id ||
      (ref.manifestHash !== undefined &&
        ref.manifestHash !== plan.manifest.contentHash)
    ) {
      throw new Error(
        "Sandbox changed the canonical Harness Run Manifest execution lineage.",
      );
    }
    this.manifestHashes.set(ref.runId, plan.manifest.contentHash);
    return {
      ...ref,
      manifestHash: plan.manifest.contentHash,
    };
  }

  async consumeSignals(
    ref: TrainingExecutionRef,
    batch: LearningSignalBatch,
  ): Promise<void> {
    const manifestHash =
      ref.manifestHash ?? this.manifestHashes.get(ref.runId);
    if (
      batch.manifestId !== ref.runId ||
      batch.manifestHash !== manifestHash
    ) {
      throw new Error(
        "Sandbox signals do not match the launched Harness Run Manifest.",
      );
    }
    // Offline signals are already sealed in Evidence Set Releases and live
    // signals are delivered inside Sandbox. Acceptance here confirms that the
    // canonical batch is bound to the same run; it does not re-upload data.
  }

  async status(
    ref: TrainingExecutionRef,
  ): Promise<TrainingExecutionStatus> {
    return this.client.status(ref);
  }

  async logs(ref: TrainingExecutionRef, cursor?: string) {
    return this.client.logs(ref, cursor);
  }

  async cancel(ref: TrainingExecutionRef): Promise<void> {
    await this.client.cancel(ref);
  }

  async collect(ref: TrainingExecutionRef): Promise<TrainingArtifacts> {
    const artifacts = await this.client.artifacts(ref);
    if (
      ref.manifestHash !== undefined &&
      artifacts.manifestHash !== ref.manifestHash
    ) {
      throw new Error(
        "Sandbox artifacts changed the canonical Harness Run Manifest lineage.",
      );
    }
    return artifacts;
  }
}
