import { createHash, randomUUID } from "node:crypto";
import {
  ApprovalSchema,
  ModelUsageRecordSchema,
  type Approval,
  type ModelUsageRecord,
  type ModelUsageStatus,
  type ModelUsageVisibility,
} from "@openpond/contracts";
import {
  HOST_STORAGE_CONTRACT_VERSION,
  type AgentHostStorageClient,
} from "@openpond/agent-runtime";
import { z } from "zod";

const approvalVersionSchema = z.object({
  approval: ApprovalSchema,
  revision: z.number().int().positive(),
}).strict();
const usageRecordSchema = z.object({ record: ModelUsageRecordSchema }).strict();
const usageCursorSchema = z.object({
  startedAt: z.string().min(1),
  requestOrdinal: z.number().int().nonnegative(),
  id: z.string().min(1),
}).strict();
const usagePageSchema = z.object({
  records: z.array(ModelUsageRecordSchema).max(200),
  nextBefore: usageCursorSchema.nullable(),
}).strict();

export type HostedUsageQuery = {
  sessionId?: string | null;
  turnId?: string | null;
  provider?: ModelUsageRecord["provider"] | null;
  model?: string | null;
  startedAtFrom?: string | null;
  startedAtTo?: string | null;
  visibility?: ModelUsageVisibility | "all" | null;
  status?: ModelUsageStatus | "missing" | "all" | null;
  limit?: number;
};

/** Complete hosted reads stop with an error beyond this bound. Callers must
 * narrow their query or use a purpose-built streamed aggregation. */
export const HOSTED_COMPLETE_USAGE_ROW_LIMIT = 10_000;

/** Durable approvals require a caller-owned retry ID and a revision check. */
export class HostedApprovalStorage {
  constructor(private readonly client: AgentHostStorageClient) {}

  async readApproval(approvalId: string): Promise<{ approval: Approval; revision: number } | null> {
    const value = await this.client.request({
      contractVersion: HOST_STORAGE_CONTRACT_VERSION,
      requestId: randomUUID(),
      operation: "approval/get",
      params: { approvalId },
    });
    return value === null ? null : approvalVersionSchema.parse(value);
  }

  async getApproval(approvalId: string): Promise<Approval | null> {
    return (await this.readApproval(approvalId))?.approval ?? null;
  }

  async putApproval(input: {
    approval: Approval;
    expectedRevision: number | null;
    requestId: string;
  }): Promise<{ approval: Approval; revision: number }> {
    const approval = ApprovalSchema.parse(input.approval);
    if (!input.requestId.trim()) throw new Error("Approval mutation requires a stable request ID.");
    return approvalVersionSchema.parse(await this.client.request({
      contractVersion: HOST_STORAGE_CONTRACT_VERSION,
      requestId: input.requestId,
      operation: "approval/upsert",
      params: { approval, expectedRevision: input.expectedRevision },
    }));
  }
}

/** Per-request usage identity is stable across retries; reads use <=200-row pages. */
export class HostedModelUsageStorage {
  constructor(private readonly client: AgentHostStorageClient) {}

  async upsertModelUsageRecord(record: ModelUsageRecord): Promise<ModelUsageRecord> {
    const parsed = ModelUsageRecordSchema.parse(record);
    // A request may progress from started to completed. Give each state a
    // stable retry identity while retaining requestId as the durable row key.
    const mutationId = createHash("sha256").update(JSON.stringify(parsed)).digest("hex");
    const value = await this.client.request({
      contractVersion: HOST_STORAGE_CONTRACT_VERSION,
      requestId: `usage:${mutationId}`,
      operation: "usage/upsert",
      params: { record: parsed },
    });
    const stored = usageRecordSchema.parse(value).record;
    if (stored.requestId !== parsed.requestId) throw new Error("Host usage upsert changed request identity.");
    return stored;
  }

  async getModelUsageRecordByRequestId(requestId: string): Promise<ModelUsageRecord | null> {
    const value = await this.client.request({
      contractVersion: HOST_STORAGE_CONTRACT_VERSION,
      requestId: randomUUID(),
      operation: "usage/getByRequestId",
      params: { requestId },
    });
    return value === null ? null : usageRecordSchema.parse(value).record;
  }

  async listModelUsageRecords(query: HostedUsageQuery = {}): Promise<ModelUsageRecord[]> {
    const complete = query.limit === undefined || query.limit >= HOSTED_COMPLETE_USAGE_ROW_LIMIT;
    const maximum = query.limit === undefined
      ? HOSTED_COMPLETE_USAGE_ROW_LIMIT
      : Math.max(1, Math.min(10_000, Math.trunc(query.limit)));
    const filters = {
      ...(query.sessionId ? { sessionId: query.sessionId } : {}),
      ...(query.turnId ? { turnId: query.turnId } : {}),
      ...(query.provider ? { provider: query.provider } : {}),
      ...(query.model ? { model: query.model } : {}),
      ...(query.startedAtFrom ? { startedAtFrom: query.startedAtFrom } : {}),
      ...(query.startedAtTo ? { startedAtTo: query.startedAtTo } : {}),
      ...(query.visibility && query.visibility !== "all" ? { visibility: query.visibility } : {}),
      ...(query.status && query.status !== "all" ? { status: query.status } : {}),
    };
    const records: ModelUsageRecord[] = [];
    let before: z.infer<typeof usageCursorSchema> | null = null;
    while (records.length < maximum + (complete ? 1 : 0)) {
      const page = usagePageSchema.parse(await this.client.request({
        contractVersion: HOST_STORAGE_CONTRACT_VERSION,
        requestId: randomUUID(),
        operation: "usage/page",
        params: { query: filters, before, limit: Math.min(200, maximum + (complete ? 1 : 0) - records.length) },
      }));
      records.push(...page.records);
      if (records.length > maximum) {
        throw new Error(`Hosted usage query exceeds ${maximum} rows; narrow its filters or use a streamed aggregation.`);
      }
      if (page.nextBefore === null) break;
      if (page.records.length === 0 || JSON.stringify(page.nextBefore) === JSON.stringify(before)) {
        throw new Error("Host usage cursor did not advance.");
      }
      before = page.nextBefore;
    }
    return records;
  }

  async listModelUsageRecordsComplete(query: Omit<HostedUsageQuery, "limit"> = {}): Promise<ModelUsageRecord[]> {
    return this.listModelUsageRecords(query);
  }
}
