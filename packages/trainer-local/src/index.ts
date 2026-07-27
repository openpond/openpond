import {
  type ComputeTargetCapabilities,
} from "@openpond/contracts";
import { contentHash } from "@openpond/taskset-sdk";
import {
  type ComputeLease,
  type ComputeQuote,
  type ComputeRequest,
  type ComputeTargetAdapter,
} from "@openpond/training-sdk";

export interface LocalCapabilityProbe {
  discover(): Promise<{
    devices: ComputeTargetCapabilities["devices"];
    workerImagesSupported: boolean;
    capabilityReceipt: string;
    checkedAt: string;
  }>;
}

export class LocalComputeTargetAdapter implements ComputeTargetAdapter {
  readonly id: string;

  constructor(
    private readonly probe: LocalCapabilityProbe,
    id = "local",
  ) {
    if (!id.trim()) {
      throw new Error("A local compute adapter ID is required.");
    }
    this.id = id;
  }

  async discover(): Promise<ComputeTargetCapabilities> {
    const result = await this.probe.discover();
    return {
      schemaVersion: "openpond.computeTargetCapabilities.v1",
      adapterId: this.id,
      kind: "local",
      provider: null,
      available: result.devices.length > 0,
      devices: result.devices,
      supportsWorkerImages: result.workerImagesSupported,
      supportsArtifactTransfer: true,
      supportsCancellation: true,
      capabilityReceipt: result.capabilityReceipt,
      checkedAt: result.checkedAt,
      unavailableReason:
        result.devices.length > 0 ? null : "No supported local compute was found.",
    };
  }

  async quote(request: ComputeRequest): Promise<ComputeQuote> {
    const base = {
      adapterId: this.id,
      estimatedCostUsd: 0,
      hourlyCostUsd: 0,
      expiresAt: request.deadline,
      assumptions: ["Local compute has no provider charge."],
    };
    return { ...base, contentHash: contentHash(base) };
  }

  async acquire(request: ComputeRequest): Promise<ComputeLease> {
    const capabilities = await this.discover();
    if (!capabilities.devices.some((device) => device.id === request.deviceOrPool)) {
      throw new Error(`Local device ${request.deviceOrPool} is unavailable.`);
    }
    return {
      id: `local-${request.runId}`,
      adapterId: this.id,
      deviceOrPool: request.deviceOrPool,
      acquiredAt: new Date().toISOString(),
      expiresAt: request.deadline,
      capabilityReceipt: capabilities.capabilityReceipt,
      connection: { transport: "process" },
    };
  }

  async heartbeat(lease: ComputeLease): Promise<ComputeLease> {
    return lease;
  }

  async release(): Promise<void> {}
}
