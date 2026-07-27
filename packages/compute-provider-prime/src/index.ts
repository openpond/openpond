import type { ComputeTargetCapabilities } from "@openpond/contracts";
import { contentHash } from "@openpond/taskset-sdk";
import type {
  ComputeLease,
  ComputeQuote,
  ComputeRequest,
  ComputeTargetAdapter,
} from "@openpond/training-sdk";

export * from "./http-client.js";
export * from "./credential-probe.js";

export interface PrimeRawComputeClient {
  walletBalance(): Promise<{
    walletId: string;
    teamId: string | null;
    balanceUsd: number;
    currency: string;
    checkedAt: string;
    receipt: string;
  }>;
  inventory(): Promise<{
    devices: ComputeTargetCapabilities["devices"];
    capabilityReceipt: string;
    checkedAt: string;
  }>;
  quote(input: {
    deviceOrPool: string;
    deadline: string;
  }): Promise<{
    quoteId: string;
    estimatedCostUsd: number;
    hourlyCostUsd: number;
    expiresAt: string;
    assumptions: string[];
  }>;
  provision(input: {
    deviceOrPool: string;
    deadline: string;
    idempotencyKey: string;
    signal?: AbortSignal;
    onProvisioned?: (resource: {
      nodeId: string;
      acquiredAt: string;
    }) => void | Promise<void>;
  }): Promise<{
    nodeId: string;
    host: string;
    port: number;
    user: string;
    sshHostFingerprint: string;
    acquiredAt: string;
    expiresAt: string;
    capabilityReceipt: string;
  }>;
  connect(
    nodeId: string,
    deadline: string,
  ): Promise<{
    nodeId: string;
    host: string;
    port: number;
    user: string;
    sshHostFingerprint: string;
    acquiredAt: string;
    expiresAt: string;
    capabilityReceipt: string;
  }>;
  heartbeat(nodeId: string): Promise<{ expiresAt: string }>;
  terminate(nodeId: string): Promise<void>;
}

export class PrimeComputeTargetAdapter implements ComputeTargetAdapter {
  readonly id = "prime-raw";

  constructor(private readonly client: PrimeRawComputeClient) {}

  async discover(): Promise<ComputeTargetCapabilities> {
    const inventory = await this.client.inventory();
    return {
      schemaVersion: "openpond.computeTargetCapabilities.v1",
      adapterId: this.id,
      kind: "managed",
      provider: "prime",
      available: inventory.devices.length > 0,
      devices: inventory.devices,
      supportsWorkerImages: true,
      supportsArtifactTransfer: true,
      supportsCancellation: true,
      capabilityReceipt: inventory.capabilityReceipt,
      checkedAt: inventory.checkedAt,
      unavailableReason:
        inventory.devices.length > 0 ? null : "Prime has no matching raw GPU.",
    };
  }

  async quote(request: ComputeRequest): Promise<ComputeQuote> {
    const quote = await this.client.quote({
      deviceOrPool: request.deviceOrPool,
      deadline: request.deadline,
    });
    const base = {
      adapterId: this.id,
      estimatedCostUsd: quote.estimatedCostUsd,
      hourlyCostUsd: quote.hourlyCostUsd,
      expiresAt: quote.expiresAt,
      assumptions: [...quote.assumptions, `provider quote ${quote.quoteId}`],
    };
    return { ...base, contentHash: contentHash(base) };
  }

  async acquire(request: ComputeRequest): Promise<ComputeLease> {
    const quote = await this.quote(request);
    const wallet = await this.client.walletBalance();
    if (wallet.currency.toUpperCase() !== "USD") {
      throw new Error(
        `Prime wallet ${wallet.walletId} uses unsupported currency ${wallet.currency}.`,
      );
    }
    const effectiveMaximumSpendUsd =
      request.maximumSpendUsd === null
        ? wallet.balanceUsd
        : Math.min(request.maximumSpendUsd, wallet.balanceUsd);
    if (
      quote.estimatedCostUsd !== null &&
      quote.estimatedCostUsd > effectiveMaximumSpendUsd
    ) {
      throw new Error(
        request.maximumSpendUsd !== null &&
          request.maximumSpendUsd <= wallet.balanceUsd
          ? `Prime quote $${quote.estimatedCostUsd} exceeds the approved maximum.`
          : `Prime quote $${quote.estimatedCostUsd} exceeds the available wallet balance of $${wallet.balanceUsd}.`,
      );
    }
    const node = await this.client.provision({
      deviceOrPool: request.deviceOrPool,
      deadline: request.deadline,
      idempotencyKey: request.runId,
    });
    return {
      id: node.nodeId,
      adapterId: this.id,
      deviceOrPool: request.deviceOrPool,
      acquiredAt: node.acquiredAt,
      expiresAt: node.expiresAt,
      capabilityReceipt: node.capabilityReceipt,
      connection: {
        transport: "ssh",
        host: node.host,
        port: node.port,
        user: node.user,
        sshHostFingerprint: node.sshHostFingerprint,
      },
    };
  }

  async heartbeat(lease: ComputeLease): Promise<ComputeLease> {
    const heartbeat = await this.client.heartbeat(lease.id);
    return { ...lease, expiresAt: heartbeat.expiresAt };
  }

  async release(lease: ComputeLease): Promise<void> {
    await this.client.terminate(lease.id);
  }
}
