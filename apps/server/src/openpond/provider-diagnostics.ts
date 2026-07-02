import { Buffer } from "node:buffer";
import type { ProviderId, ProviderSettings } from "@openpond/contracts";

export type ProviderDiagnosticsOperationKind =
  | "provider_settings"
  | "model_discovery"
  | "provider_validation";

export type ProviderDiagnosticsOperation = {
  kind: ProviderDiagnosticsOperationKind;
  providerId: ProviderId | null;
  finishedAt: string;
  durationMs: number;
  status: "ok" | "error";
  payloadBytes: number;
  error?: string;
};

export type ProviderDiagnosticsSnapshot = {
  providerPayloadBytes: number;
  modelCacheBytes: number;
  modelCacheModelCount: number;
  providerErrorCount: number;
  modelCacheErrorCount: number;
  credentialErrorCount: number;
  recentOperations: ProviderDiagnosticsOperation[];
};

export class ProviderDiagnosticsTracker {
  private readonly maxOperations: number;
  private readonly now: () => number;
  private readonly dateNow: () => string;
  private readonly recentOperations: ProviderDiagnosticsOperation[] = [];
  private latestSettings: ProviderSettings | null = null;

  constructor(options: { maxOperations?: number; now?: () => number; dateNow?: () => string } = {}) {
    this.maxOperations = Math.max(1, Math.trunc(options.maxOperations ?? 50));
    this.now = options.now ?? (() => Date.now());
    this.dateNow = options.dateNow ?? (() => new Date().toISOString());
  }

  async track<T>(
    kind: ProviderDiagnosticsOperationKind,
    providerId: ProviderId | null,
    operation: () => Promise<T>,
  ): Promise<T> {
    const started = this.now();
    try {
      const result = await operation();
      if (isProviderSettings(result)) this.latestSettings = result;
      this.record({
        kind,
        providerId,
        durationMs: this.now() - started,
        status: "ok",
        payloadBytes: jsonSizeBytes(result),
      });
      return result;
    } catch (error) {
      this.record({
        kind,
        providerId,
        durationMs: this.now() - started,
        status: "error",
        payloadBytes: 0,
        error: errorMessage(error),
      });
      throw error;
    }
  }

  snapshot(settings: ProviderSettings | null = this.latestSettings): ProviderDiagnosticsSnapshot {
    if (settings) this.latestSettings = settings;
    const modelCaches = settings?.modelCaches ?? {};
    const statuses = settings?.statuses ?? {};
    return {
      providerPayloadBytes: jsonSizeBytes(settings ?? {}),
      modelCacheBytes: jsonSizeBytes(modelCaches),
      modelCacheModelCount: Object.values(modelCaches).reduce(
        (sum, cache) => sum + cache.models.length,
        0,
      ),
      providerErrorCount: Object.values(statuses).filter((status) => Boolean(status.lastError)).length,
      modelCacheErrorCount: Object.values(modelCaches).filter((cache) => Boolean(cache.lastError)).length,
      credentialErrorCount: Object.values(statuses).filter((status) => Boolean(status.credential.lastError)).length,
      recentOperations: [...this.recentOperations],
    };
  }

  private record(
    operation: Omit<ProviderDiagnosticsOperation, "durationMs" | "finishedAt"> & {
      durationMs: number;
    },
  ): void {
    this.recentOperations.push({
      ...operation,
      finishedAt: this.dateNow(),
      durationMs: Math.max(0, Math.round(operation.durationMs)),
    });
    if (this.recentOperations.length > this.maxOperations) {
      this.recentOperations.splice(0, this.recentOperations.length - this.maxOperations);
    }
  }
}

function isProviderSettings(value: unknown): value is ProviderSettings {
  return Boolean(
    value &&
      typeof value === "object" &&
      !Array.isArray(value) &&
      "providers" in value &&
      "statuses" in value &&
      "modelCaches" in value,
  );
}

function jsonSizeBytes(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value ?? null), "utf8");
}

function errorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.length > 500 ? `${message.slice(0, 500)}...` : message;
}
