import { createHash, randomUUID } from "node:crypto";
import { CreateImproveRunActionSchema, CreateImproveRunSchema,
  type CreateImproveRun, type CreateImproveRunAction } from "@openpond/contracts";
import { HOST_STORAGE_CONTRACT_VERSION, type AgentHostStorageClient } from "@openpond/agent-runtime";
import { z } from "zod";

const cursorSchema = z.object({ updatedAt: z.string(), id: z.string().min(1) }).strict();
const pageSchema = z.object({ entries: z.array(CreateImproveRunSchema).max(200), nextBefore: cursorSchema.nullable() }).strict();
const mutationResultSchema = z.object({ run: CreateImproveRunSchema, replayed: z.boolean() }).strict();

/** Hosted Create/Improve state shares one fenced conversation with the active Work turn. */
export class HostedCreateImproveStorage {
  constructor(private readonly client: AgentHostStorageClient) {}

  async getCreateImproveRun(runId: string): Promise<CreateImproveRun | null> {
    const value = await this.client.request({ contractVersion: HOST_STORAGE_CONTRACT_VERSION,
      requestId: randomUUID(), operation: "create-improve/execute", params: { action: "get", runId } });
    return value === null ? null : CreateImproveRunSchema.parse(value);
  }

  async listCreateImproveRuns(query: {
    profileId?: string | null; conversationId?: string | null;
    targetKind?: CreateImproveRun["target"]["kind"] | null; targetId?: string | null;
    state?: CreateImproveRun["state"] | readonly CreateImproveRun["state"][] | null; limit?: number;
  } = {}): Promise<CreateImproveRun[]> {
    const maximum = Math.max(1, Math.min(1_000, Math.trunc(query.limit ?? 250)));
    const states = Array.isArray(query.state) ? [...query.state] : query.state ? [query.state] : [];
    const runs: CreateImproveRun[] = [];
    let before: z.infer<typeof cursorSchema> | null = null;
    while (runs.length < maximum) {
      const page = pageSchema.parse(await this.client.request({ contractVersion: HOST_STORAGE_CONTRACT_VERSION,
        requestId: randomUUID(), operation: "create-improve/execute",
        params: { action: "page", query: {
          profileId: query.profileId ?? null, targetKind: query.targetKind ?? null,
          targetId: query.targetId ?? null, state: states,
        }, before, limit: Math.min(50, maximum - runs.length) },
      }));
      if (query.conversationId && page.entries.some((run) => run.scope.conversationId !== query.conversationId)) {
        throw new Error("Hosted Create/Improve page crossed its conversation scope.");
      }
      runs.push(...page.entries);
      if (!page.nextBefore) break;
      if (page.entries.length === 0 || (before && (page.nextBefore.updatedAt > before.updatedAt ||
          (page.nextBefore.updatedAt === before.updatedAt && page.nextBefore.id >= before.id)))) {
        throw new Error("Hosted Create/Improve cursor did not advance.");
      }
      before = page.nextBefore;
    }
    return runs;
  }

  async upsertCreateImproveRun(value: CreateImproveRun): Promise<CreateImproveRun> {
    const run = CreateImproveRunSchema.parse(value);
    const requestId = `create-improve:${createHash("sha256").update(JSON.stringify(run)).digest("hex")}`;
    const response = await this.client.request({ contractVersion: HOST_STORAGE_CONTRACT_VERSION,
      requestId, operation: "create-improve/execute", params: { action: "put", run } });
    return CreateImproveRunSchema.parse(z.object({ run: z.unknown() }).strict().parse(response).run);
  }

  async mutateCreateImproveRun(actionValue: CreateImproveRunAction,
    updater: (run: CreateImproveRun) => CreateImproveRun): Promise<{ run: CreateImproveRun; replayed: boolean }> {
    const mutation = CreateImproveRunActionSchema.parse(actionValue);
    const current = await this.getCreateImproveRun(mutation.runId);
    if (!current) throw new Error(`Create/Improve run not found: ${mutation.runId}`);
    if (current.appliedActionIds.includes(mutation.actionId)) return { run: current, replayed: true };
    if (current.revision !== mutation.expectedRevision) {
      throw new Error(`Create/Improve run changed from revision ${mutation.expectedRevision} to ${current.revision}. Refresh and try again.`);
    }
    const next = CreateImproveRunSchema.parse(updater(current));
    if (next.id !== current.id || next.revision !== current.revision + 1 ||
        !next.appliedActionIds.includes(mutation.actionId)) {
      throw new Error("Create/Improve mutation must preserve identity, advance one revision and record its action.");
    }
    return mutationResultSchema.parse(await this.client.request({ contractVersion: HOST_STORAGE_CONTRACT_VERSION,
      requestId: mutation.actionId, operation: "create-improve/execute",
      params: { action: "mutate", mutation, next },
    }));
  }
}
