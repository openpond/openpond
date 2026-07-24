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

export interface LocalHarnessRuntimeDriver {
  materialize(release: HarnessRelease): Promise<{ bundleHash: string }>;
  create(manifest: HarnessRunManifest): Promise<HarnessLease>;
  reset(lease: HarnessLease, seed: string): Promise<void>;
  step(lease: HarnessLease, action: ModelAction): Promise<ToolObservation>;
  grade(lease: HarnessLease): Promise<HarnessGraderEvidence[]>;
  collect(lease: HarnessLease): Promise<HarnessArtifacts>;
  destroy(lease: HarnessLease): Promise<void>;
}

export class LocalHarnessRuntimeAdapter implements HarnessRuntimeAdapter {
  readonly id: string;

  constructor(
    private readonly driver: LocalHarnessRuntimeDriver,
    private readonly capabilitiesProvider: () => Promise<HarnessRuntimeCapabilities>,
    id = "local-harness",
  ) {
    this.id = id;
  }

  capabilities(): Promise<HarnessRuntimeCapabilities> {
    return this.capabilitiesProvider();
  }

  materialize(release: HarnessRelease): Promise<{ bundleHash: string }> {
    return this.driver.materialize(release);
  }

  create(manifest: HarnessRunManifest): Promise<HarnessLease> {
    return this.driver.create(manifest);
  }

  reset(lease: HarnessLease, seed: string): Promise<void> {
    return this.driver.reset(lease, seed);
  }

  step(lease: HarnessLease, action: ModelAction): Promise<ToolObservation> {
    return this.driver.step(lease, action);
  }

  grade(lease: HarnessLease): Promise<HarnessGraderEvidence[]> {
    return this.driver.grade(lease);
  }

  collect(lease: HarnessLease): Promise<HarnessArtifacts> {
    return this.driver.collect(lease);
  }

  destroy(lease: HarnessLease): Promise<void> {
    return this.driver.destroy(lease);
  }
}
