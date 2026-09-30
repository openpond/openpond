import { randomUUID } from "node:crypto";
import { z } from "zod";
import { HOST_STORAGE_CONTRACT_VERSION, type AgentHostStorageClient, type HostStorageRequest } from "@openpond/agent-runtime";
import { OpenPondProfileRefSchema, type OpenPondProfileRef } from "@openpond/contracts";
import { assertContentHash, contentHash } from "@openpond/harness";
import { AttemptReceiptSchema, TaskGradeSchema, ProfileEvaluationComparisonSchema, ProfileEvaluationSuiteRunSchema,
  verifyAttemptReceipt, type TaskGrade, type AttemptReceipt, type ProfileEvaluationComparison,
  type ProfileEvaluationSuiteRun, type ProfileEvaluationCatalog } from "@openpond/evals";
import { LocalProfileEvaluationRunSchema, type LocalProfileEvaluationRun } from "./profile-evaluation-record.js";

type Kind = "grade" | "receipt" | "run" | "comparison" | "suite";
const cursorSchema = z.object({ createdAt: z.string().datetime(), id: z.string().min(1) }).strict();
const pageSchema = z.object({ entries: z.array(z.unknown()).max(100), nextBefore: cursorSchema.nullable() }).strict();

/** All writes use the host's active lease and immutable-reference validation. */
export class HostedProfileEvaluationStorage {
  constructor(private readonly client: AgentHostStorageClient) {}

  private execute(params: Extract<HostStorageRequest, { operation: "profile-evaluations/execute" }>["params"]): Promise<unknown> {
    return this.client.request({ contractVersion: HOST_STORAGE_CONTRACT_VERSION,
      requestId: randomUUID(), operation: "profile-evaluations/execute", params });
  }
  private async get<T extends { contentHash: string } & Record<string, unknown>>(kind: Kind, id: string, schema: z.ZodType<T>): Promise<T | null> {
    const value = await this.execute({ action: "get", kind, id });
    if (value === null) return null;
    const parsed = schema.parse(value);
    assertContentHash(parsed, `Hosted Profile evaluation ${kind}`);
    return parsed;
  }
  private async put<T extends { contentHash: string }>(kind: Kind, value: T, schema: z.ZodType<T>,
    profileKey: string | null, createdAt: string): Promise<T> {
    const payload = schema.parse(value);
    assertContentHash(payload, `Hosted Profile evaluation ${kind}`);
    const saved = schema.parse(await this.execute({ action: "put", kind, payload, profileKey, createdAt }));
    if (saved.contentHash !== payload.contentHash || contentHash(saved) !== contentHash(payload)) {
      throw new Error("Hosted Profile evaluation write returned different evidence.");
    }
    return saved;
  }
  private async page<T extends { contentHash: string } & Record<string, unknown>>(kind: Kind, ref: OpenPondProfileRef, schema: z.ZodType<T>): Promise<T[]> {
    const entries: T[] = [];
    let before: z.infer<typeof cursorSchema> | null = null;
    do {
      const page = pageSchema.parse(await this.execute({ action: "page", kind,
        profileKey: contentHash(OpenPondProfileRefSchema.parse(ref)), before, limit: 100 }));
      if (page.nextBefore && (page.entries.length === 0 || before &&
        (page.nextBefore.createdAt > before.createdAt || page.nextBefore.createdAt === before.createdAt && page.nextBefore.id >= before.id))) {
        throw new Error("Hosted Profile evaluation cursor did not advance.");
      }
      for (const value of page.entries) {
        const parsed = schema.parse(value);
        assertContentHash(parsed, `Hosted Profile evaluation ${kind}`);
        entries.push(parsed);
      }
      if (entries.length > 10_000) throw new Error("Hosted Profile evaluation history exceeds the bounded catalog limit.");
      before = page.nextBefore;
    } while (before);
    return entries;
  }
  getProfileEvaluationGrade(hash: string) { return this.get("grade", hash, TaskGradeSchema); }
  saveProfileEvaluationGrade(grade: TaskGrade) { return this.put("grade", grade, TaskGradeSchema, null, new Date().toISOString()); }
  getProfileEvaluationReceipt(id: string) { return this.get("receipt", id, AttemptReceiptSchema); }
  saveProfileEvaluationReceipt(receipt: AttemptReceipt) {
    if (!verifyAttemptReceipt(receipt)) throw new Error("Hosted Profile evaluation receipt is invalid.");
    return this.put("receipt", receipt, AttemptReceiptSchema, null, receipt.completedAt);
  }
  getProfileEvaluationRun(id: string) { return this.get("run", id, LocalProfileEvaluationRunSchema); }
  saveProfileEvaluationRun(run: LocalProfileEvaluationRun) {
    return this.put("run", run, LocalProfileEvaluationRunSchema, contentHash(OpenPondProfileRefSchema.parse(run.profileRef)), run.completedAt);
  }
  listProfileEvaluationRuns(ref: OpenPondProfileRef) { return this.page("run", ref, LocalProfileEvaluationRunSchema); }
  getProfileEvaluationComparison(id: string) { return this.get("comparison", id, ProfileEvaluationComparisonSchema); }
  saveProfileEvaluationComparison(ref: OpenPondProfileRef, value: ProfileEvaluationComparison) {
    return this.put("comparison", value, ProfileEvaluationComparisonSchema, contentHash(OpenPondProfileRefSchema.parse(ref)), value.createdAt);
  }
  listProfileEvaluationComparisons(ref: OpenPondProfileRef) { return this.page("comparison", ref, ProfileEvaluationComparisonSchema); }
  getProfileEvaluationSuiteRun(id: string) { return this.get("suite", id, ProfileEvaluationSuiteRunSchema); }
  saveProfileEvaluationSuiteRun(ref: OpenPondProfileRef, catalog: ProfileEvaluationCatalog, value: ProfileEvaluationSuiteRun) {
    if (contentHash(catalog) !== value.catalogHash) throw new Error("Hosted Profile evaluation suite differs from its catalog.");
    return this.put("suite", value, ProfileEvaluationSuiteRunSchema, contentHash(OpenPondProfileRefSchema.parse(ref)), value.createdAt);
  }
  listProfileEvaluationSuiteRuns(ref: OpenPondProfileRef) { return this.page("suite", ref, ProfileEvaluationSuiteRunSchema); }
}
