import { randomUUID } from "node:crypto";
import { HOST_STORAGE_CONTRACT_VERSION, type AgentHostStorageClient } from "@openpond/agent-runtime";
import { HarnessCrossRunRefinementRequestSchema, HarnessRefinementCandidateSchema,
  type HarnessCrossRunRefinementRequest, type HarnessRefinementCandidate } from "@openpond/contracts";
import { z } from "zod";

const preferenceSchema = z.object({ revision: z.number().int().nonnegative(),
  payload: z.record(z.string(), z.unknown()).nullable() }).strict();
const pageSchema = z.object({ entries: z.array(z.unknown()).max(100),
  nextAfterId: z.string().min(1).nullable() }).strict();
type PreferenceKind = "selection" | "workspace_settings" | "evaluation_review_settings";
type PageKind = "candidates" | "cross_run_requests";

/** The child can read bounded Harness state. User decisions stay on the host action. */
export class HostedHarnessStateStorage {
  constructor(private readonly client: AgentHostStorageClient) {}

  async getPreference(workspaceId: string, kind: PreferenceKind): Promise<z.infer<typeof preferenceSchema>> {
    return preferenceSchema.parse(await this.client.request({ contractVersion: HOST_STORAGE_CONTRACT_VERSION,
      requestId: randomUUID(), operation: "harness/state/read",
      params: { workspaceId, kind, afterId: null, limit: 1 } }));
  }

  async listCandidates(workspaceId: string): Promise<HarnessRefinementCandidate[]> {
    return (await this.readAll(workspaceId, "candidates")).map((entry) => HarnessRefinementCandidateSchema.parse(entry));
  }

  async listCrossRunRequests(workspaceId: string): Promise<HarnessCrossRunRefinementRequest[]> {
    return (await this.readAll(workspaceId, "cross_run_requests"))
      .map((entry) => HarnessCrossRunRefinementRequestSchema.parse(entry));
  }

  private async readAll(workspaceId: string, kind: PageKind): Promise<unknown[]> {
    const entries: unknown[] = [];
    let afterId: string | null = null;
    do {
      const page = pageSchema.parse(await this.client.request({ contractVersion: HOST_STORAGE_CONTRACT_VERSION,
        requestId: randomUUID(), operation: "harness/state/read",
        params: { workspaceId, kind, afterId, limit: Math.min(100, 1_001 - entries.length) } }));
      if (page.nextAfterId && (page.entries.length === 0 || page.nextAfterId === afterId)) {
        throw new Error("Hosted Harness state cursor did not advance.");
      }
      entries.push(...page.entries);
      if (entries.length > 1_000) throw new Error("Hosted Harness state exceeds 1,000 entries.");
      afterId = page.nextAfterId;
    } while (afterId);
    return entries;
  }
}
