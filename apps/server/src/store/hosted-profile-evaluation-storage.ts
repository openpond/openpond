import { randomUUID } from "node:crypto";
import { HOST_STORAGE_CONTRACT_VERSION, type AgentHostStorageClient } from "@openpond/agent-runtime";
import { OpenPondProfileRefSchema, type OpenPondProfileRef } from "@openpond/contracts";
import { AttemptReceiptSchema, ProfileEvaluationComparisonSchema, ProfileEvaluationSuiteRunSchema,
  TaskGradeSchema, createProfileEvaluationSuiteRun,
  type AttemptReceipt, type ProfileEvaluationComparison, type ProfileEvaluationSuiteRun,
  type ProfileEvaluationCatalog, type TaskGrade } from "@openpond/evals";
import { contentHash } from "@openpond/harness";
import { z } from "zod";

import { LocalProfileEvaluationRunSchema, type LocalProfileEvaluationRun } from "./profile-evaluation-record.js";

type Kind = "grade" | "receipt" | "run" | "comparison" | "suite";
const schemas = { grade: TaskGradeSchema, receipt: AttemptReceiptSchema, run: LocalProfileEvaluationRunSchema,
  comparison: ProfileEvaluationComparisonSchema, suite: ProfileEvaluationSuiteRunSchema };
const cursor = z.object({ createdAt: z.string().datetime(), id: z.string().min(1) }).strict();

/** Evaluation records are immutable and fenced by the owner's active generation. */
export class HostedProfileEvaluationStorage {
  constructor(private readonly client: AgentHostStorageClient) {}

  private async get<T>(kind: Kind, id: string, schema: z.ZodType<T>): Promise<T | null> {
    const raw = await this.client.request({ contractVersion: HOST_STORAGE_CONTRACT_VERSION,
      requestId: randomUUID(), operation: "profile-evaluations/execute", params: { action: "get", kind, id } });
    return schema.nullable().parse(raw);
  }
  private async put<T extends { contentHash: string }>(kind: Kind, payload: T, schema: z.ZodType<T>,
    createdAt: string, profileKey: string | null = null): Promise<T> {
    return schema.parse(await this.client.request({ contractVersion: HOST_STORAGE_CONTRACT_VERSION,
      requestId: `profile-evaluation:${kind}:${payload.contentHash}`, operation: "profile-evaluations/execute",
      params: { action: "put", kind, payload, profileKey, createdAt } }));
  }
  private async list<T>(kind: Kind, profileRef: OpenPondProfileRef, schema: z.ZodType<T>): Promise<T[]> {
    const profileKey = contentHash(OpenPondProfileRefSchema.parse(profileRef));
    const pageSchema = z.object({ entries: z.array(schema).max(100), nextBefore: cursor.nullable() }).strict();
    const entries: T[] = [];
    let before: z.infer<typeof cursor> | null = null;
    do {
      const page = pageSchema.parse(await this.client.request({ contractVersion: HOST_STORAGE_CONTRACT_VERSION,
        requestId: randomUUID(), operation: "profile-evaluations/execute",
        params: { action: "page", kind, profileKey, before, limit: Math.min(100, 1_001 - entries.length) } }));
      entries.push(...page.entries);
      if (entries.length > 1_000) throw new Error("Hosted Profile evidence exceeds the bounded inspection window.");
      if (page.nextBefore && (!page.entries.length || (before &&
          (page.nextBefore.createdAt > before.createdAt ||
            (page.nextBefore.createdAt === before.createdAt && page.nextBefore.id >= before.id))))) {
        throw new Error("Hosted Profile evaluation cursor did not advance.");
      }
      before = page.nextBefore;
    } while (before);
    return entries;
  }

  getProfileEvaluationGrade(id: string) { return this.get("grade", id, schemas.grade); }
  getProfileEvaluationReceipt(id: string) { return this.get("receipt", id, schemas.receipt); }
  getProfileEvaluationRun(id: string) { return this.get("run", id, schemas.run); }
  getProfileEvaluationComparison(id: string) { return this.get("comparison", id, schemas.comparison); }
  getProfileEvaluationSuiteRun(id: string) { return this.get("suite", id, schemas.suite); }
  listProfileEvaluationRuns(ref: OpenPondProfileRef) { return this.list("run", ref, schemas.run); }
  listProfileEvaluationComparisons(ref: OpenPondProfileRef) { return this.list("comparison", ref, schemas.comparison); }
  listProfileEvaluationSuiteRuns(ref: OpenPondProfileRef) { return this.list("suite", ref, schemas.suite); }

  saveProfileEvaluationGrade(input: TaskGrade) {
    return this.put("grade", schemas.grade.parse(input), schemas.grade, new Date(0).toISOString());
  }
  saveProfileEvaluationReceipt(input: AttemptReceipt) {
    const receipt = schemas.receipt.parse(input);
    return this.put("receipt", receipt, schemas.receipt, receipt.completedAt);
  }
  saveProfileEvaluationRun(input: LocalProfileEvaluationRun) {
    const run = schemas.run.parse(input);
    return this.put("run", run, schemas.run, run.completedAt, contentHash(run.profileRef));
  }
  saveProfileEvaluationComparison(ref: OpenPondProfileRef, input: ProfileEvaluationComparison) {
    const comparison = schemas.comparison.parse(input);
    return this.put("comparison", comparison, schemas.comparison, comparison.createdAt, contentHash(OpenPondProfileRefSchema.parse(ref)));
  }
  async saveProfileEvaluationSuiteRun(ref: OpenPondProfileRef, catalog: ProfileEvaluationCatalog, input: ProfileEvaluationSuiteRun) {
    const suite = schemas.suite.parse(input);
    const members = [];
    for (const member of suite.members) {
      const run = await this.getProfileEvaluationRun(member.runManifest.id);
      if (!run || contentHash(run.profileRef) !== contentHash(ref)) throw new Error("Hosted Profile suite member is unavailable.");
      members.push({ definitionId: member.definitionId, manifest: run.manifest,
        runHash: run.contentHash, passed: run.passed, score: run.metric.value });
    }
    const verified = createProfileEvaluationSuiteRun({ id: suite.id, suiteId: suite.suiteId, catalog, members,
      createdAt: suite.createdAt, completedAt: suite.completedAt });
    if (verified.contentHash !== suite.contentHash) throw new Error("Hosted Profile suite differs from retained evidence.");
    return this.put("suite", suite, schemas.suite, suite.createdAt, contentHash(OpenPondProfileRefSchema.parse(ref)));
  }
}
