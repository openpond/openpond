import { z } from "zod";
import {
  AgentImportCommitRequestSchema,
  AgentImportPreviewRequestSchema,
} from "./connected-evidence-contracts.js";
import { fetchConnectedJson } from "./connected-evidence-http.js";
import {
  CollectorCoverageManifestSchema,
  CollectorCoverageSummarySchema,
  summarizeCollectorCoverage,
} from "@openpond/evals/connected-evidence";
const Id = z.string().trim().min(1).max(240);
export const ConnectedSyncCoveragePublishSchema = z
  .object({
    id: Id,
    expectedRevision: z.number().int().positive(),
    manifest: CollectorCoverageManifestSchema,
  })
  .strict()
  .refine(
    (value) =>
      value.id === value.manifest.connectionId &&
      value.expectedRevision === value.manifest.connectionRevision,
    "Collector coverage scope differs from its connection.",
  );
export const ConnectedSyncCoverageReadSchema = z
  .object({ id: Id, cutoff: z.iso.datetime().optional() })
  .strict();
export const ConnectedSyncCoverageReceiptSchema = z
  .object({
    schemaVersion: z.literal("openpond.connectedSyncCoverageReceipt.v1"),
    id: Id,
    teamId: Id,
    ownerUserId: Id,
    connectionId: Id,
    connectionRevision: z.number().int().positive(),
    receivedAt: z.iso.datetime(),
    summary: CollectorCoverageSummarySchema,
  })
  .strict();
export const ConnectedSyncRegistrationSchema = z
  .object({
    id: Id,
    source: AgentImportPreviewRequestSchema.shape.source,
    machineId: Id,
    sourceInstanceId: Id,
    sourceLabel: z.string().trim().min(1).max(200),
    sourceRoot: z.string().min(1).max(2000),
    destination: AgentImportPreviewRequestSchema.shape.destination,
    since: z.string().datetime().nullable(),
    keepSyncing: z.boolean(),
    expectedRevision: z.number().int().nonnegative(),
  })
  .strict();
export const ConnectedSyncControlSchema = z
  .object({
    id: Id,
    expectedRevision: z.number().int().positive(),
    action: z.enum(["pause", "resume", "disconnect"]),
  })
  .strict();
export const ConnectedSyncRequestSchema = z
  .object({
    id: Id,
    operationId: Id,
    expectedRevision: z.number().int().positive(),
  })
  .strict();
export const ConnectedSyncHeartbeatSchema = z
  .object({
    id: Id,
    expectedRevision: z.number().int().positive(),
    pendingOperations: z.number().int().min(0).max(10000),
    error: z.string().max(500).nullable(),
    completedSyncRevision: z.number().int().nonnegative().default(0),
  })
  .strict();
export const ConnectedSyncConnectionSchema = z
  .object({
    teamId: Id,
    id: Id,
    revision: z.number().int().positive(),
    source: AgentImportPreviewRequestSchema.shape.source,
    sourceLabel: z.string(),
    sourceRoot: z.string(),
    taskDatasetId: Id.nullable(),
    conversationDatasetId: Id.nullable(),
    machineId: Id,
    sourceInstanceId: Id,
    projectId: Id,
    datasetIds: z.array(Id).max(2),
    since: z.string().datetime().nullable(),
    keepSyncing: z.boolean(),
    state: z.enum(["active", "paused", "disconnected"]),
    health: z.enum(["online", "offline"]),
    lastHeartbeatAt: z.string().datetime().nullable(),
    lastAdmissionAt: z.string().datetime().nullable(),
    pendingOperations: z.number().int().nonnegative(),
    admittedTasks: z.number().int().nonnegative(),
    error: z.string().nullable(),
    requestedSyncRevision: z.number().int().nonnegative().default(0),
    completedSyncRevision: z.number().int().nonnegative().default(0),
    syncRequestedAt: z.string().datetime().nullable().default(null),
    syncCompletedAt: z.string().datetime().nullable().default(null),
  })
  .strict()
  .refine(
    (value) =>
      value.completedSyncRevision <= value.requestedSyncRevision &&
      value.requestedSyncRevision <= value.revision,
    "Invalid sync acknowledgement generation.",
  );
export const ConnectedSyncCommitSchema = z
  .object({
    connectionId: Id,
    expectedRevision: z.number().int().positive(),
    request: AgentImportCommitRequestSchema,
  })
  .strict();
export type ConnectedSyncConnection = z.infer<
  typeof ConnectedSyncConnectionSchema
>;
export class ConnectedSyncClient {
  constructor(
    private readonly options: {
      apiKey: string;
      baseUrl: string;
      teamId: string;
      fetch?: typeof fetch;
    },
  ) {
    const url = new URL(options.baseUrl);
    if (
      !["http:", "https:"].includes(url.protocol) ||
      url.username ||
      url.password ||
      url.search ||
      url.hash
    )
      throw new Error("Invalid connected-sync API origin.");
  }
  async list(signal?: AbortSignal) {
    const result = z
      .object({
        teamId: Id,
        items: z.array(ConnectedSyncConnectionSchema).max(100),
      })
      .strict()
      .parse(await this.request("", "GET", undefined, signal));
    if (
      result.teamId !== this.options.teamId ||
      result.items.some((item) => item.teamId !== result.teamId)
    )
      throw new Error("Sync workspace mismatch.");
    return result;
  }
  async register(
    raw: z.input<typeof ConnectedSyncRegistrationSchema>,
    signal?: AbortSignal,
  ) {
    return this.connection(
      await this.request(
        "",
        "POST",
        ConnectedSyncRegistrationSchema.parse(raw),
        signal,
      ),
      raw.id,
    );
  }
  async control(
    raw: z.input<typeof ConnectedSyncControlSchema>,
    signal?: AbortSignal,
  ) {
    return this.connection(
      await this.request(
        "/control",
        "POST",
        ConnectedSyncControlSchema.parse(raw),
        signal,
      ),
      raw.id,
    );
  }
  async heartbeat(
    raw: z.input<typeof ConnectedSyncHeartbeatSchema>,
    signal?: AbortSignal,
  ) {
    return this.connection(
      await this.request(
        "/heartbeat",
        "POST",
        ConnectedSyncHeartbeatSchema.parse(raw),
        signal,
      ),
      raw.id,
    );
  }
  async requestSync(
    raw: z.input<typeof ConnectedSyncRequestSchema>,
    signal?: AbortSignal,
  ) {
    return this.connection(
      await this.request(
        "/sync-now",
        "POST",
        ConnectedSyncRequestSchema.parse(raw),
        signal,
      ),
      raw.id,
    );
  }
  async commit(
    raw: z.input<typeof ConnectedSyncCommitSchema>,
    signal?: AbortSignal,
  ) {
    return this.request(
      "/commit",
      "POST",
      ConnectedSyncCommitSchema.parse(raw),
      signal,
    );
  }
  async publishCoverage(
    raw: z.input<typeof ConnectedSyncCoveragePublishSchema>,
    signal?: AbortSignal,
  ) {
    const request = ConnectedSyncCoveragePublishSchema.parse(raw);
    const receipt = this.coverageReceipt(
      await this.request(
        "/coverage",
        "POST",
        { action: "publish", ...request },
        signal,
      ),
      request.id,
    );
    if (
      !receipt ||
      receipt.connectionRevision !== request.expectedRevision ||
      receipt.summary.manifestHash !==
        summarizeCollectorCoverage(request.manifest).manifestHash
    )
      throw new Error(
        "Collector coverage acknowledgement differs from the retained manifest.",
      );
    return receipt;
  }
  async readCoverage(
    raw: z.input<typeof ConnectedSyncCoverageReadSchema>,
    signal?: AbortSignal,
  ) {
    const request = ConnectedSyncCoverageReadSchema.parse(raw);
    const query = new URLSearchParams(
      request.cutoff ? { cutoff: request.cutoff } : {},
    );
    return this.coverageReceipt(
      await this.request(
        `/${encodeURIComponent(request.id)}/coverage?${query}`,
        "GET",
        undefined,
        signal,
      ),
      request.id,
    );
  }
  private coverageReceipt(value: unknown, connectionId: string) {
    if (value === null) return null;
    const receipt = ConnectedSyncCoverageReceiptSchema.parse(value);
    if (
      receipt.teamId !== this.options.teamId ||
      receipt.connectionId !== connectionId
    )
      throw new Error("Collector coverage workspace mismatch.");
    return receipt;
  }
  private connection(raw: unknown, id: string) {
    const result = ConnectedSyncConnectionSchema.parse(raw);
    if (result.teamId !== this.options.teamId || result.id !== id)
      throw new Error("Sync connection identity mismatch.");
    return result;
  }
  private async request(
    path: string,
    method: string,
    body?: unknown,
    signal?: AbortSignal,
  ) {
    const { response, value } = await fetchConnectedJson(
      this.options.fetch ?? fetch,
      `${this.options.baseUrl.replace(/\/+$/u, "")}/v1/connected-evidence/sync/connections${path}`,
      {
        method,
        signal,
        redirect: "error",
        headers: {
          Authorization: `Bearer ${this.options.apiKey}`,
          "X-OpenPond-Team-Id": this.options.teamId,
          "Content-Type": "application/json",
          Accept: "application/json",
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      },
      (_status, _code, message) => new Error(message),
    );
    if (!response.ok)
      throw Object.assign(
        new Error(`Sync request failed (${response.status}).`),
        { status: response.status },
      );
    return value;
  }
}
