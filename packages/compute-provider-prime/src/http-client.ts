import { contentHash } from "@openpond/taskset-sdk";

import type { PrimeRawComputeClient } from "./index.js";

const DEFAULT_BASE_URL = "https://api.primeintellect.ai";

type PrimeOffering = {
  cloudId: string;
  gpuType: string;
  socket: string;
  provider: string;
  region: string;
  dataCenter: string | null;
  country: string;
  gpuCount: number;
  gpuMemory: number;
  stockStatus: string;
  security: string;
  hourlyUsd: number;
  diskHourlyUsdPerGb: number;
  variablePrice: boolean;
  prepaidHours: number | null;
};

type PrimePod = {
  id: string;
  name: string;
  status: string;
  sshConnection: string | string[] | null;
  installationFailure: string | null;
  createdAt: string;
};

export type PrimeRawComputeHttpClientOptions = {
  apiKey(): Promise<string> | string;
  sshKeyId: string;
  workerTemplateId: string;
  request?: typeof fetch;
  baseUrl?: string;
  diskSizeGb?: number;
  pollIntervalMs?: number;
  readyTimeoutMs?: number;
  now?: () => Date;
  verifySshHostKey(input: {
    host: string;
    port: number;
  }): Promise<string>;
};

/**
 * Thin Prime API transport for raw, SSH-reachable compute. It deliberately
 * stops at provider-neutral connection facts; worker installation and engine
 * selection remain in the generic connected-worker layer.
 */
export class PrimeRawComputeHttpClient implements PrimeRawComputeClient {
  private readonly offerings = new Map<string, PrimeOffering>();
  private readonly deadlines = new Map<string, string>();
  private readonly request: typeof fetch;
  private readonly baseUrl: string;
  private readonly diskSizeGb: number;
  private readonly pollIntervalMs: number;
  private readonly readyTimeoutMs: number;
  private readonly now: () => Date;

  constructor(private readonly options: PrimeRawComputeHttpClientOptions) {
    if (!options.sshKeyId.trim() || !options.workerTemplateId.trim()) {
      throw new Error(
        "Prime raw compute requires an SSH key ID and immutable worker template ID.",
      );
    }
    this.request = options.request ?? fetch;
    this.baseUrl = (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, "");
    this.diskSizeGb = options.diskSizeGb ?? 120;
    this.pollIntervalMs = options.pollIntervalMs ?? 2_000;
    this.readyTimeoutMs = options.readyTimeoutMs ?? 10 * 60_000;
    this.now = options.now ?? (() => new Date());
  }

  async inventory() {
    const query = new URLSearchParams({
      gpu_type: "H100_80GB",
      gpu_count: "1",
      security: "secure_cloud",
      page: "1",
      page_size: "100",
    });
    const payload = object(
      await this.json(`/api/v1/availability/gpus?${query}`),
      "Prime availability response",
    );
    const items = array(payload.items, "Prime availability items")
      .map(parseOffering)
      .filter(
        (offering) =>
          offering.gpuType === "H100_80GB" &&
          offering.gpuCount === 1 &&
          offering.security === "secure_cloud" &&
          !offering.variablePrice &&
          offering.prepaidHours === null &&
          offering.stockStatus.toLowerCase() === "available",
      );
    this.offerings.clear();
    for (const offering of items) {
      if (this.offerings.has(offering.cloudId)) {
        throw new Error(
          `Prime availability returned duplicate cloud ID ${offering.cloudId}.`,
        );
      }
      this.offerings.set(offering.cloudId, offering);
    }
    const checkedAt = this.now().toISOString();
    const devices = items.map((offering) => ({
      id: offering.cloudId,
      kind: "gpu" as const,
      vendor: "nvidia" as const,
      name: `${offering.gpuType} · ${offering.provider} · ${offering.region}`,
      memoryBytes: Math.round(offering.gpuMemory * 1_000_000_000),
      runtime: "cuda" as const,
    }));
    return {
      devices,
      capabilityReceipt: contentHash({
        provider: "prime",
        offerings: items.map(offeringIdentity),
        checkedAt,
      }),
      checkedAt,
    };
  }

  async quote(input: { deviceOrPool: string; deadline: string }) {
    const offering = await this.requireOffering(input.deviceOrPool);
    const deadline = new Date(input.deadline);
    const hours = Math.max(
      0,
      (deadline.getTime() - this.now().getTime()) / 3_600_000,
    );
    const totalHourlyUsd =
      offering.hourlyUsd +
      offering.diskHourlyUsdPerGb * this.diskSizeGb;
    const estimatedCostUsd = roundUsd(totalHourlyUsd * hours);
    const quoteId = contentHash({
      offering: offeringIdentity(offering),
      deadline: deadline.toISOString(),
      estimatedCostUsd,
    });
    return {
      quoteId,
      estimatedCostUsd,
      hourlyCostUsd: totalHourlyUsd,
      expiresAt: new Date(
        Math.min(
          deadline.getTime(),
          this.now().getTime() + 15 * 60_000,
        ),
      ).toISOString(),
      assumptions: [
        `Prime availability ${offering.cloudId}`,
        `${this.diskSizeGb} GB ephemeral disk`,
        "One secure-cloud H100 80 GB",
      ],
    };
  }

  async provision(input: {
    deviceOrPool: string;
    deadline: string;
    idempotencyKey: string;
  }) {
    const offering = await this.requireOffering(input.deviceOrPool);
    const name = `openpond-${contentHash(input.idempotencyKey).slice(0, 24)}`;
    const existing = (await this.listPods()).find(
      (pod) => pod.name === name && !terminalPodStatus(pod.status),
    );
    let pod = existing;
    if (!pod) {
      pod = parsePod(
        await this.json("/api/v1/pods/", {
          method: "POST",
          body: JSON.stringify({
            pod: {
              cloudId: offering.cloudId,
              gpuType: offering.gpuType,
              socket: offering.socket,
              gpuCount: offering.gpuCount,
              name,
              diskSize: this.diskSizeGb,
              maxPrice: offering.hourlyUsd,
              image: "custom_template",
              customTemplateId: this.options.workerTemplateId,
              dataCenterId: offering.dataCenter ?? undefined,
              country: offering.country,
              security: offering.security,
              envVars: [],
              sshKeyId: this.options.sshKeyId,
              autoRestart: true,
            },
            provider: { type: offering.provider },
            disks: [],
            shared_with_team: false,
          }),
        }),
      );
    }
    try {
      const ready = await this.waitForSsh(pod.id);
      const connection = parseSshConnection(ready.sshConnection);
      const sshHostFingerprint =
        await this.options.verifySshHostKey(connection);
      if (!/^SHA256:[A-Za-z0-9+/]+$/.test(sshHostFingerprint)) {
        throw new Error("Prime SSH host-key verifier returned an invalid fingerprint.");
      }
      this.deadlines.set(ready.id, input.deadline);
      return {
        nodeId: ready.id,
        ...connection,
        sshHostFingerprint,
        acquiredAt: ready.createdAt,
        expiresAt: input.deadline,
        capabilityReceipt: contentHash({
          offering: offeringIdentity(offering),
          podId: ready.id,
          sshHostFingerprint,
        }),
      };
    } catch (error) {
      await this.terminate(pod.id).catch(() => undefined);
      throw error;
    }
  }

  async heartbeat(nodeId: string): Promise<{ expiresAt: string }> {
    const pod = await this.getPod(nodeId);
    if (terminalPodStatus(pod.status)) {
      throw new Error(`Prime node ${nodeId} is ${pod.status}.`);
    }
    return {
      expiresAt:
        this.deadlines.get(nodeId) ??
        new Date(this.now().getTime() + 5 * 60_000).toISOString(),
    };
  }

  async terminate(nodeId: string): Promise<void> {
    await this.json(`/api/v1/pods/${encodeURIComponent(nodeId)}`, {
      method: "DELETE",
    }, true);
    this.deadlines.delete(nodeId);
  }

  private async requireOffering(deviceOrPool: string): Promise<PrimeOffering> {
    if (!this.offerings.has(deviceOrPool)) await this.inventory();
    const offering = this.offerings.get(deviceOrPool);
    if (!offering) {
      throw new Error(`Prime raw compute ${deviceOrPool} is unavailable.`);
    }
    return offering;
  }

  private async waitForSsh(podId: string): Promise<PrimePod> {
    const deadline = this.now().getTime() + this.readyTimeoutMs;
    while (true) {
      const pod = await this.getPod(podId);
      if (pod.sshConnection && readyPodStatus(pod.status)) return pod;
      if (terminalPodStatus(pod.status) || pod.installationFailure) {
        throw new Error(
          `Prime node ${podId} failed before SSH bootstrap: ${
            pod.installationFailure ?? pod.status
          }.`,
        );
      }
      if (this.now().getTime() >= deadline) {
        throw new Error(`Prime node ${podId} did not become SSH-ready.`);
      }
      await delay(this.pollIntervalMs);
    }
  }

  private async getPod(podId: string): Promise<PrimePod> {
    return parsePod(
      await this.json(`/api/v1/pods/${encodeURIComponent(podId)}`),
    );
  }

  private async listPods(): Promise<PrimePod[]> {
    const payload = object(
      await this.json("/api/v1/pods/?offset=0&limit=100"),
      "Prime pod list",
    );
    return array(payload.data, "Prime pods").map(parsePod);
  }

  private async json(
    path: string,
    init: RequestInit = {},
    allowEmpty = false,
  ): Promise<unknown> {
    const apiKey = (await this.options.apiKey()).trim();
    if (!apiKey) throw new Error("Prime API key is empty.");
    const response = await this.request(`${this.baseUrl}${path}`, {
      ...init,
      headers: {
        accept: "application/json",
        authorization: `Bearer ${apiKey}`,
        ...(init.body === undefined
          ? {}
          : { "content-type": "application/json" }),
        ...init.headers,
      },
      signal: init.signal ?? AbortSignal.timeout(30_000),
    });
    const text = await response.text();
    if (!response.ok) {
      throw new Error(
        `Prime API ${init.method ?? "GET"} ${path} failed (${response.status}): ${text.slice(0, 300)}`,
      );
    }
    if (!text) {
      if (allowEmpty) return null;
      throw new Error(`Prime API ${path} returned an empty response.`);
    }
    try {
      return JSON.parse(text);
    } catch {
      throw new Error(`Prime API ${path} returned invalid JSON.`);
    }
  }
}

function parseOffering(value: unknown): PrimeOffering {
  const item = object(value, "Prime availability item");
  const prices = object(item.prices, "Prime availability prices");
  const disk =
    item.disk && typeof item.disk === "object" && !Array.isArray(item.disk)
      ? item.disk as Record<string, unknown>
      : {};
  const diskPricePerUnit =
    disk.pricePerUnit === null || disk.pricePerUnit === undefined
      ? 0
      : nonnegativeNumber(disk.pricePerUnit, "disk.pricePerUnit");
  const diskIncluded =
    disk.defaultIncludedInPrice === true;
  return {
    cloudId: string(item.cloudId, "cloudId"),
    gpuType: string(item.gpuType, "gpuType"),
    socket: string(item.socket, "socket"),
    provider: string(item.provider, "provider"),
    region: string(item.region, "region"),
    dataCenter:
      item.dataCenter === null || item.dataCenter === undefined
        ? null
        : string(item.dataCenter, "dataCenter"),
    country: string(item.country, "country"),
    gpuCount: positiveNumber(item.gpuCount, "gpuCount"),
    gpuMemory: positiveNumber(item.gpuMemory, "gpuMemory"),
    stockStatus: string(item.stockStatus, "stockStatus"),
    security: string(item.security, "security"),
    hourlyUsd: nonnegativeNumber(prices.onDemand, "prices.onDemand"),
    diskHourlyUsdPerGb: diskIncluded
      ? 0
      : diskPricePerUnit,
    variablePrice:
      prices.isVariable === undefined ||
      prices.isVariable === null
        ? false
        : boolean(prices.isVariable, "prices.isVariable"),
    prepaidHours:
      item.prepaidTime === undefined || item.prepaidTime === null
        ? null
        : nonnegativeNumber(item.prepaidTime, "prepaidTime"),
  };
}

function parsePod(value: unknown): PrimePod {
  const pod = object(value, "Prime pod");
  const rawConnection = pod.sshConnection;
  const sshConnection =
    rawConnection === null || rawConnection === undefined
      ? null
      : Array.isArray(rawConnection)
        ? rawConnection.map((item) => string(item, "sshConnection"))
        : string(rawConnection, "sshConnection");
  return {
    id: string(pod.id, "pod.id"),
    name: string(pod.name, "pod.name"),
    status: string(pod.status, "pod.status"),
    sshConnection,
    installationFailure:
      pod.installationFailure === null ||
      pod.installationFailure === undefined
        ? null
        : string(pod.installationFailure, "pod.installationFailure"),
    createdAt: string(pod.createdAt, "pod.createdAt"),
  };
}

function parseSshConnection(
  value: PrimePod["sshConnection"],
): { host: string; port: number; user: string } {
  const command = Array.isArray(value)
    ? value.find((item) => item.trim().length > 0)
    : value;
  if (!command) throw new Error("Prime pod has no SSH connection.");
  const destination = command.match(
    /(?:^|\s)([A-Za-z0-9._-]+)@(\[[0-9A-Fa-f:]+\]|[A-Za-z0-9._:-]+)/,
  );
  const port = command.match(/(?:^|\s)-p\s+([0-9]{1,5})(?:\s|$)/);
  if (!destination) {
    throw new Error("Prime pod returned an unsupported SSH connection.");
  }
  const parsedPort = port ? Number(port[1]) : 22;
  if (parsedPort < 1 || parsedPort > 65_535) {
    throw new Error("Prime pod returned an invalid SSH port.");
  }
  return {
    user: destination[1]!,
    host: destination[2]!.replace(/^\[|\]$/g, ""),
    port: parsedPort,
  };
}

function offeringIdentity(offering: PrimeOffering) {
  return {
    cloudId: offering.cloudId,
    gpuType: offering.gpuType,
    socket: offering.socket,
    provider: offering.provider,
    region: offering.region,
    dataCenter: offering.dataCenter,
    country: offering.country,
    gpuCount: offering.gpuCount,
    gpuMemory: offering.gpuMemory,
    security: offering.security,
    hourlyUsd: offering.hourlyUsd,
    diskHourlyUsdPerGb: offering.diskHourlyUsdPerGb,
    variablePrice: offering.variablePrice,
    prepaidHours: offering.prepaidHours,
  };
}

function readyPodStatus(value: string): boolean {
  return ["active", "running", "ready"].includes(value.toLowerCase());
}

function terminalPodStatus(value: string): boolean {
  return ["failed", "terminated", "cancelled", "canceled"].includes(
    value.toLowerCase(),
  );
}

function object(
  value: unknown,
  label: string,
): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object.`);
  }
  return value as Record<string, unknown>;
}

function array(value: unknown, label: string): unknown[] {
  if (!Array.isArray(value)) throw new Error(`${label} must be an array.`);
  return value;
}

function string(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${label} must be a non-empty string.`);
  }
  return value;
}

function positiveNumber(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    throw new Error(`${label} must be positive.`);
  }
  return value;
}

function nonnegativeNumber(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw new Error(`${label} must be nonnegative.`);
  }
  return value;
}

function boolean(value: unknown, label: string): boolean {
  if (typeof value !== "boolean") {
    throw new Error(`${label} must be a boolean.`);
  }
  return value;
}

function roundUsd(value: number): number {
  return Math.ceil(value * 1_000_000) / 1_000_000;
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
