import type {
  HarnessGraderEvidence,
  HarnessRelease,
  HarnessRunManifest,
  HarnessRuntimeCapabilities,
  ModelAction,
  ToolObservation,
} from "@openpond/contracts";
import type {
  HarnessArtifacts,
  HarnessLease,
  HarnessRuntimeAdapter,
} from "@openpond/training-sdk";

export interface SandboxHarnessRuntimeClient {
  capabilities(): Promise<HarnessRuntimeCapabilities>;
  uploadAndMaterialize(input: {
    release: HarnessRelease;
    projection: "environment";
  }): Promise<{ bundleHash: string }>;
  create(input: {
    manifest: HarnessRunManifest;
    placementCapabilityReceipt: string;
  }): Promise<HarnessLease>;
  reset(lease: HarnessLease, seed: string): Promise<void>;
  step(lease: HarnessLease, action: ModelAction): Promise<ToolObservation>;
  grade(lease: HarnessLease): Promise<HarnessGraderEvidence[]>;
  collect(lease: HarnessLease): Promise<HarnessArtifacts>;
  destroy(lease: HarnessLease): Promise<void>;
}

export class SandboxHarnessRuntimeAdapter implements HarnessRuntimeAdapter {
  readonly id = "sandbox-latitude";

  constructor(private readonly client: SandboxHarnessRuntimeClient) {}

  capabilities(): Promise<HarnessRuntimeCapabilities> {
    return this.client.capabilities();
  }

  materialize(release: HarnessRelease): Promise<{ bundleHash: string }> {
    return this.client.uploadAndMaterialize({
      release,
      projection: "environment",
    });
  }

  create(manifest: HarnessRunManifest): Promise<HarnessLease> {
    const placement = manifest.runtimeTarget.dataPlane;
    if (
      !placement ||
      placement.provider !== "latitude" ||
      manifest.runtimeTarget.adapterId !== this.id
    ) {
      throw new Error(
        "Sandbox runtime requires an exact Latitude data-plane receipt.",
      );
    }
    return this.client.create({
      manifest,
      placementCapabilityReceipt: placement.capabilityReceipt,
    });
  }

  reset(lease: HarnessLease, seed: string): Promise<void> {
    return this.client.reset(lease, seed);
  }

  step(lease: HarnessLease, action: ModelAction): Promise<ToolObservation> {
    return this.client.step(lease, action);
  }

  grade(lease: HarnessLease): Promise<HarnessGraderEvidence[]> {
    return this.client.grade(lease);
  }

  collect(lease: HarnessLease): Promise<HarnessArtifacts> {
    return this.client.collect(lease);
  }

  destroy(lease: HarnessLease): Promise<void> {
    return this.client.destroy(lease);
  }
}
