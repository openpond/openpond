import { z } from "zod";
import {
  AgentImportCommitRequestSchema,
  AgentImportPreviewRequestSchema,
} from "./connected-evidence-contracts.js";
import { fetchConnectedJson } from "./connected-evidence-http.js";
const Id = z.string().trim().min(1).max(240);
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
export const ConnectedSyncRequestSchema = z.object({
  id: Id,
  operationId: Id,
  expectedRevision: z.number().int().positive(),
}).strict();
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
  .refine(value => value.completedSyncRevision <= value.requestedSyncRevision && value.requestedSyncRevision <= value.revision, "Invalid sync acknowledgement generation.");
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
      await this.request("/sync-now", "POST", ConnectedSyncRequestSchema.parse(raw), signal),
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
