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
  images: string[];
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
  workerTemplateId?: string;
  gpuType?: string;
  image?:
    | "prime_rl"
    | "vllm_llama_8b"
    | "ubuntu_22_cuda_12"
    | "custom_template";
  request?: typeof fetch;
  baseUrl?: string;
  diskSizeGb?: number;
  pollIntervalMs?: number;
  readyTimeoutMs?: number;
  autoRestart?: boolean;
  now?: () => Date;
  verifySshHostKey(input: { host: string; port: number }): Promise<string>;
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
  private readonly image:
    | "prime_rl"
    | "vllm_llama_8b"
    | "ubuntu_22_cuda_12"
    | "custom_template";
  private readonly gpuType: string;

  constructor(private readonly options: PrimeRawComputeHttpClientOptions) {
    this.image =
      options.image ??
      (options.workerTemplateId ? "custom_template" : "prime_rl");
    if (
      !options.sshKeyId.trim() ||
      (this.image === "custom_template" && !options.workerTemplateId?.trim())
    ) {
      throw new Error(
        this.image === "custom_template"
          ? "Prime custom-template compute requires an SSH key ID and immutable worker template ID."
          : "Prime raw compute requires an SSH key ID."
      );
    }
    this.request = options.request ?? fetch;
    this.baseUrl = (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, "");
    this.diskSizeGb = options.diskSizeGb ?? 120;
    this.pollIntervalMs = options.pollIntervalMs ?? 2_000;
    this.readyTimeoutMs = options.readyTimeoutMs ?? 10 * 60_000;
    this.now = options.now ?? (() => new Date());
    this.gpuType = options.gpuType?.trim() || "H100_80GB";
  }

  async walletBalance() {
    const payload = object(
      await this.json("/api/v1/billing/wallet?limit=1&offset=0"),
      "Prime wallet response"
    );
    const walletId = string(payload.wallet_id, "wallet_id");
    const teamId =
      payload.team_id === null || payload.team_id === undefined
        ? null
        : string(payload.team_id, "team_id");
    const balanceUsd = nonnegativeNumber(payload.balance_usd, "balance_usd");
    const currency = string(payload.currency, "currency");
    const checkedAt = this.now().toISOString();
    return {
      walletId,
      teamId,
      balanceUsd,
      currency,
      checkedAt,
      receipt: contentHash({
        walletId,
        teamId,
        balanceUsd,
        currency,
        checkedAt,
      }),
    };
  }

  async inventory() {
    const query = new URLSearchParams({
      gpu_type: this.gpuType,
      gpu_count: "1",
      security: "secure_cloud",
      page: "1",
      page_size: "100",
    });
    const payload = object(
      await this.json(`/api/v1/availability/gpus?${query}`),
      "Prime availability response"
    );
    const items = array(payload.items, "Prime availability items")
      .map(parseOffering)
      .filter(
        (offering) =>
          offering.gpuType === this.gpuType &&
          offering.gpuCount === 1 &&
          offering.security === "secure_cloud" &&
          !offering.variablePrice &&
          offering.prepaidHours === null &&
          offering.images.includes(this.image) &&
          offering.stockStatus.toLowerCase() === "available"
      );
    this.offerings.clear();
    for (const offering of items) {
      const id = offeringDeviceId(offering);
      if (this.offerings.has(id)) {
        throw new Error(
          `Prime availability returned duplicate offering ${id}.`
        );
      }
      this.offerings.set(id, offering);
    }
    const checkedAt = this.now().toISOString();
    const devices = items.map((offering) => ({
      id: offeringDeviceId(offering),
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
      (deadline.getTime() - this.now().getTime()) / 3_600_000
    );
    const totalHourlyUsd =
      offering.hourlyUsd + offering.diskHourlyUsdPerGb * this.diskSizeGb;
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
        Math.min(deadline.getTime(), this.now().getTime() + 15 * 60_000)
      ).toISOString(),
      assumptions: [
        `Prime availability ${offering.cloudId}`,
        `${this.diskSizeGb} GB ephemeral disk`,
        `One secure-cloud ${offering.gpuType} (${offering.gpuMemory} GB)`,
      ],
    };
  }

  async provision(input: {
    deviceOrPool: string;
    deadline: string;
    idempotencyKey: string;
    signal?: AbortSignal;
    onProvisioned?: (resource: {
      nodeId: string;
      acquiredAt: string;
    }) => void | Promise<void>;
  }) {
    throwIfAborted(input.signal);
    const offering = await this.requireOffering(input.deviceOrPool);
    const name = `openpond-${contentHash(input.idempotencyKey).slice(0, 24)}`;
    const existing = (await this.listPods()).find(
      (pod) => pod.name === name && !terminalPodStatus(pod.status)
    );
    throwIfAborted(input.signal);
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
              image: this.image,
              ...(this.image === "custom_template"
                ? { customTemplateId: this.options.workerTemplateId }
                : {}),
              dataCenterId: offering.dataCenter ?? undefined,
              country: offering.country,
              security: offering.security,
              envVars: [],
              sshKeyId: this.options.sshKeyId,
              autoRestart: this.options.autoRestart ?? true,
            },
            provider: { type: offering.provider },
            disks: [],
            shared_with_team: false,
          }),
        })
      );
    }
    try {
      await input.onProvisioned?.({
        nodeId: pod.id,
        acquiredAt: pod.createdAt,
      });
      const ready = await this.waitForSsh(pod.id, input.signal);
      const connection = parseSshConnection(ready.sshConnection);
      const sshHostFingerprint = await this.options.verifySshHostKey(
        connection
      );
      if (!/^SHA256:[A-Za-z0-9+/]+$/.test(sshHostFingerprint)) {
        throw new Error(
          "Prime SSH host-key verifier returned an invalid fingerprint."
        );
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

  async connect(nodeId: string, deadline: string) {
    const ready = await this.waitForSsh(nodeId);
    const connection = parseSshConnection(ready.sshConnection);
    const sshHostFingerprint = await this.options.verifySshHostKey(connection);
    if (!/^SHA256:[A-Za-z0-9+/]+$/.test(sshHostFingerprint)) {
      throw new Error(
        "Prime SSH host-key verifier returned an invalid fingerprint."
      );
    }
    this.deadlines.set(nodeId, deadline);
    return {
      nodeId,
      ...connection,
      sshHostFingerprint,
      acquiredAt: ready.createdAt,
      expiresAt: deadline,
      capabilityReceipt: contentHash({
        podId: nodeId,
        sshHostFingerprint,
        reconnected: true,
      }),
    };
  }

  async terminate(nodeId: string): Promise<void> {
    await this.json(
      `/api/v1/pods/${encodeURIComponent(nodeId)}`,
      {
        method: "DELETE",
      },
      true
    );
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

  private async waitForSsh(
    podId: string,
    signal?: AbortSignal
  ): Promise<PrimePod> {
    const deadline = this.now().getTime() + this.readyTimeoutMs;
    while (true) {
      throwIfAborted(signal);
      const pod = await this.getPod(podId, signal);
      if (pod.sshConnection && readyPodStatus(pod.status)) return pod;
      if (terminalPodStatus(pod.status) || pod.installationFailure) {
        throw new Error(
          `Prime node ${podId} failed before SSH bootstrap: ${
            pod.installationFailure ?? pod.status
          }.`
        );
      }
      if (this.now().getTime() >= deadline) {
        throw new Error(`Prime node ${podId} did not become SSH-ready.`);
      }
      await delay(this.pollIntervalMs, signal);
    }
  }

  private async getPod(
    podId: string,
    signal?: AbortSignal
  ): Promise<PrimePod> {
    return parsePod(
      await this.json(
        `/api/v1/pods/${encodeURIComponent(podId)}`,
        signal ? { signal } : {}
      )
    );
  }

  private async listPods(): Promise<PrimePod[]> {
    const payload = object(
      await this.json("/api/v1/pods/?offset=0&limit=100"),
      "Prime pod list"
    );
    return array(payload.data, "Prime pods").map(parsePod);
  }

  private async json(
    path: string,
    init: RequestInit = {},
    allowEmpty = false
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
        `Prime API ${init.method ?? "GET"} ${path} failed (${
          response.status
        }): ${text.slice(0, 300)}`
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
      ? (item.disk as Record<string, unknown>)
      : {};
  const diskPricePerUnit =
    disk.pricePerUnit === null || disk.pricePerUnit === undefined
      ? 0
      : nonnegativeNumber(disk.pricePerUnit, "disk.pricePerUnit");
  const diskIncluded = disk.defaultIncludedInPrice === true;
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
    diskHourlyUsdPerGb: diskIncluded ? 0 : diskPricePerUnit,
    variablePrice:
      prices.isVariable === undefined || prices.isVariable === null
        ? false
        : boolean(prices.isVariable, "prices.isVariable"),
    prepaidHours:
      item.prepaidTime === undefined || item.prepaidTime === null
        ? null
        : nonnegativeNumber(item.prepaidTime, "prepaidTime"),
    images: array(item.images, "images").map((image) =>
      string(image, "images item")
    ),
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
      pod.installationFailure === null || pod.installationFailure === undefined
        ? null
        : string(pod.installationFailure, "pod.installationFailure"),
    createdAt: utcTimestamp(pod.createdAt, "pod.createdAt"),
  };
}

function utcTimestamp(value: unknown, label: string): string {
  const raw = string(value, label);
  const timezoneQualified = /(?:Z|[+-][0-9]{2}:?[0-9]{2})$/i.test(raw)
    ? raw
    : `${raw}Z`;
  const timestamp = Date.parse(timezoneQualified);
  if (!Number.isFinite(timestamp)) {
    throw new Error(`${label} must be an ISO-8601 timestamp.`);
  }
  return new Date(timestamp).toISOString();
}

function parseSshConnection(value: PrimePod["sshConnection"]): {
  host: string;
  port: number;
  user: string;
} {
  const command = Array.isArray(value)
    ? value.find((item) => item.trim().length > 0)
    : value;
  if (!command) throw new Error("Prime pod has no SSH connection.");
  const destination = command.match(
    /(?:^|\s)([A-Za-z0-9._-]+)@(\[[0-9A-Fa-f:]+\]|[A-Za-z0-9._:-]+)/
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
    images: offering.images,
  };
}

function offeringDeviceId(offering: PrimeOffering): string {
  return `prime-offering-${contentHash(offeringIdentity(offering)).slice(
    0,
    24
  )}`;
}

function readyPodStatus(value: string): boolean {
  return ["active", "running", "ready"].includes(value.toLowerCase());
}

function terminalPodStatus(value: string): boolean {
  return ["failed", "terminated", "cancelled", "canceled"].includes(
    value.toLowerCase()
  );
}

function object(value: unknown, label: string): Record<string, unknown> {
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

function delay(
  milliseconds: number,
  signal?: AbortSignal
): Promise<void> {
  throwIfAborted(signal);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, milliseconds);
    const onAbort = () => {
      clearTimeout(timer);
      reject(abortError(signal));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

function throwIfAborted(signal?: AbortSignal): void {
  if (!signal?.aborted) return;
  throw abortError(signal);
}

function abortError(signal?: AbortSignal): Error {
  return signal?.reason instanceof Error
    ? signal.reason
    : new Error("Prime provisioning was cancelled.");
}
