import {
  AttemptReceiptSchema,
  BenchmarkComparisonSchema,
  BenchmarkRunSummarySchema,
  EvaluationResultSchema,
  ProfileEvaluationComparisonSchema,
  ProfileEvaluationSuiteRunSchema,
  createProfileEvaluationSuiteRun,
  createProfileEvaluationComparison,
  TaskGradeSchema,
  TasksetMetricResultSchema,
  TasksetRunManifestSchema,
  assertTasksetMetricResult,
  verifyAttemptReceipt,
  type AttemptReceipt,
  type BenchmarkComparison,
  type BenchmarkRunSummary,
  type EvaluationResult,
  type ProfileEvaluationComparison,
  type ProfileEvaluationSuiteRun,
  type ProfileEvaluationCatalog,
  type TaskGrade,
} from "@openpond/evals";
import { assertContentHash, contentHash, ImmutableReleaseRefSchema } from "@openpond/harness";
import { OpenPondProfileRefSchema, type OpenPondProfileRef } from "@openpond/contracts";
import { z } from "zod";

import { SqliteDatasetStore } from "./store-datasets.js";

export const LocalProfileEvaluationRunSchema = z.object({
  profileRef: OpenPondProfileRefSchema,
  manifest: TasksetRunManifestSchema,
  metric: TasksetMetricResultSchema,
  gradeRefs: z.array(ImmutableReleaseRefSchema),
  receiptRefs: z.array(ImmutableReleaseRefSchema),
  passRate: z.number().min(0).max(1),
  passed: z.boolean(),
  completedAt: z.string().datetime(),
  contentHash: z.string().regex(/^[a-f0-9]{64}$/),
}).strict();
export type LocalProfileEvaluationRun = z.infer<typeof LocalProfileEvaluationRunSchema>;

export class SqliteEvaluationResultStore extends SqliteDatasetStore {
  async saveProfileEvaluationGrade(gradeInput: TaskGrade) {
    const grade = TaskGradeSchema.parse(gradeInput);
    assertContentHash(grade, "Profile evaluation grade");
    const existing = await this.getProfileEvaluationGrade(grade.contentHash);
    if (existing) return existing;
    await this.upsertPayload(
      "INSERT INTO profile_evaluation_grades (content_hash, payload) VALUES (?, ?) ON CONFLICT(content_hash) DO NOTHING",
      [grade.contentHash, JSON.stringify(grade)],
    );
    return grade;
  }

  async getProfileEvaluationGrade(contentHashValue: string): Promise<TaskGrade | null> {
    return this.getParsedPayload(
      "SELECT payload FROM profile_evaluation_grades WHERE content_hash = ?", [contentHashValue], TaskGradeSchema.parse,
    );
  }

  async saveProfileEvaluationReceipt(receiptInput: AttemptReceipt): Promise<AttemptReceipt> {
    const receipt = AttemptReceiptSchema.parse(receiptInput);
    verifyAttemptReceipt(receipt);
    const existing = await this.getProfileEvaluationReceipt(receipt.id);
    if (existing) {
      if (existing.contentHash !== receipt.contentHash) throw new Error(`Profile evaluation receipt ${receipt.id} is immutable.`);
      return existing;
    }
    await this.upsertPayload(
      "INSERT INTO profile_evaluation_receipts (id, run_id, payload) VALUES (?, ?, ?)",
      [receipt.id, receipt.runManifest.id, JSON.stringify(receipt)],
    );
    return receipt;
  }

  async getProfileEvaluationReceipt(id: string): Promise<AttemptReceipt | null> {
    return this.getParsedPayload(
      "SELECT payload FROM profile_evaluation_receipts WHERE id = ?", [id], AttemptReceiptSchema.parse,
    );
  }

  async saveProfileEvaluationRun(runInput: LocalProfileEvaluationRun): Promise<LocalProfileEvaluationRun> {
    const run = LocalProfileEvaluationRunSchema.parse(runInput);
    assertContentHash(run, "Profile evaluation run");
    assertContentHash(run.manifest, "Profile evaluation run manifest");
    assertTasksetMetricResult(run.metric);
    const source = run.manifest.profileEvaluation;
    if (!source || source.profileId !== run.profileRef.profileId || run.metric.runManifest.id !== run.manifest.id
      || run.metric.runManifest.contentHash !== run.manifest.contentHash
      || contentHash(run.receiptRefs) !== contentHash(run.metric.receiptRefs)) {
      throw new Error("Profile evaluation run differs from its manifest or metric receipts.");
    }
    if (run.receiptRefs.length !== run.manifest.population.length || run.gradeRefs.length !== run.receiptRefs.length) {
      throw new Error("Profile evaluation run has an incomplete receipt or grade population.");
    }
    for (const [index, member] of run.manifest.population.entries()) {
      const receiptRef = run.receiptRefs[index]!;
      const receipt = await this.getProfileEvaluationReceipt(receiptRef.id);
      if (!receipt || receipt.contentHash !== receiptRef.contentHash
        || receipt.runManifest.id !== run.manifest.id
        || receipt.runManifest.contentHash !== run.manifest.contentHash
        || receipt.id !== member.receiptId || receipt.taskId !== member.taskId || receipt.seed !== member.seed) {
        throw new Error("Profile evaluation run references a missing or mismatched receipt.");
      }
      const gradeRef = run.gradeRefs[index]!;
      const grade = await this.getProfileEvaluationGrade(gradeRef.contentHash);
      if (!grade || grade.contentHash !== gradeRef.contentHash
        || !receipt.graderEvidenceRefs.some((ref) => ref.id === gradeRef.id && ref.contentHash === gradeRef.contentHash)) {
        throw new Error("Profile evaluation run references a missing or mismatched grade.");
      }
    }
    const existing = await this.getProfileEvaluationRun(run.manifest.id);
    if (existing) {
      if (existing.contentHash !== run.contentHash) throw new Error(`Profile evaluation run ${run.manifest.id} is immutable.`);
      return existing;
    }
    await this.upsertPayload(
      "INSERT INTO profile_evaluation_runs (id, profile_key, taskset_id, payload, created_at) VALUES (?, ?, ?, ?, ?)",
      [run.manifest.id, contentHash(run.profileRef), run.manifest.tasksetRelease.id, JSON.stringify(run), run.completedAt],
    );
    return run;
  }

  async getProfileEvaluationRun(id: string): Promise<LocalProfileEvaluationRun | null> {
    return this.getParsedPayload(
      "SELECT payload FROM profile_evaluation_runs WHERE id = ?", [id], LocalProfileEvaluationRunSchema.parse,
    );
  }

  async listProfileEvaluationRuns(profileRef: OpenPondProfileRef): Promise<LocalProfileEvaluationRun[]> {
    return this.listParsedPayloads(
      "SELECT payload FROM profile_evaluation_runs WHERE profile_key = ? ORDER BY created_at DESC, id ASC",
      [contentHash(OpenPondProfileRefSchema.parse(profileRef))], LocalProfileEvaluationRunSchema.parse,
    );
  }

  async saveProfileEvaluationComparison(profileRef: OpenPondProfileRef, comparisonInput: ProfileEvaluationComparison): Promise<ProfileEvaluationComparison> {
    const ref = OpenPondProfileRefSchema.parse(profileRef);
    const comparison = ProfileEvaluationComparisonSchema.parse(comparisonInput);
    assertContentHash(comparison, "Profile evaluation comparison");
    const members: Array<{ manifest: LocalProfileEvaluationRun["manifest"]; result: LocalProfileEvaluationRun["metric"] }> = [];
    for (const member of comparison.members) {
      const run = await this.getProfileEvaluationRun(member.runManifest.id);
      if (!run || contentHash(run.profileRef) !== contentHash(ref)
        || run.manifest.contentHash !== member.runManifest.contentHash
        || run.metric.contentHash !== member.metricResultHash) {
        throw new Error("Profile evaluation comparison references a missing or mismatched run.");
      }
      members.push({ manifest: run.manifest, result: run.metric });
    }
    if (createProfileEvaluationComparison({ id: comparison.id, members, createdAt: comparison.createdAt }).contentHash !== comparison.contentHash) {
      throw new Error("Profile evaluation comparison differs from retained run evidence.");
    }
    const existing = await this.getProfileEvaluationComparison(comparison.id);
    if (existing) {
      if (existing.contentHash !== comparison.contentHash) throw new Error(`Profile evaluation comparison ${comparison.id} is immutable.`);
      return existing;
    }
    await this.upsertPayload(
      "INSERT INTO profile_evaluation_comparisons (id, profile_key, payload, created_at) VALUES (?, ?, ?, ?)",
      [comparison.id, contentHash(ref), JSON.stringify(comparison), comparison.createdAt],
    );
    return comparison;
  }

  async getProfileEvaluationComparison(id: string): Promise<ProfileEvaluationComparison | null> {
    return this.getParsedPayload(
      "SELECT payload FROM profile_evaluation_comparisons WHERE id = ?", [id], ProfileEvaluationComparisonSchema.parse,
    );
  }

  async listProfileEvaluationComparisons(profileRef: OpenPondProfileRef): Promise<ProfileEvaluationComparison[]> {
    return this.listParsedPayloads(
      "SELECT payload FROM profile_evaluation_comparisons WHERE profile_key = ? ORDER BY created_at DESC, id ASC",
      [contentHash(OpenPondProfileRefSchema.parse(profileRef))], ProfileEvaluationComparisonSchema.parse,
    );
  }

  async saveProfileEvaluationSuiteRun(profileRef: OpenPondProfileRef, catalog: ProfileEvaluationCatalog, suiteInput: ProfileEvaluationSuiteRun): Promise<ProfileEvaluationSuiteRun> {
    const ref = OpenPondProfileRefSchema.parse(profileRef);
    const suite = ProfileEvaluationSuiteRunSchema.parse(suiteInput);
    assertContentHash(suite, "Profile evaluation suite run");
    const members = [];
    for (const member of suite.members) {
      const run = await this.getProfileEvaluationRun(member.runManifest.id);
      if (!run || contentHash(run.profileRef) !== contentHash(ref)
        || run.manifest.contentHash !== member.runManifest.contentHash
        || run.contentHash !== member.runHash
        || run.passed !== member.passed
        || run.metric.value !== member.score) {
        throw new Error("Profile evaluation suite references a missing or mismatched run.");
      }
      members.push({ definitionId: member.definitionId, manifest: run.manifest, runHash: run.contentHash, passed: run.passed, score: run.metric.value });
    }
    const verified = createProfileEvaluationSuiteRun({ id: suite.id, suiteId: suite.suiteId, catalog, members, createdAt: suite.createdAt, completedAt: suite.completedAt });
    if (verified.contentHash !== suite.contentHash) throw new Error("Profile evaluation suite differs from retained run evidence.");
    const existing = await this.getProfileEvaluationSuiteRun(suite.id);
    if (existing) {
      if (existing.contentHash !== suite.contentHash) throw new Error(`Profile evaluation suite run ${suite.id} is immutable.`);
      return existing;
    }
    await this.upsertPayload(
      "INSERT INTO profile_evaluation_suite_runs (id, profile_key, payload, created_at) VALUES (?, ?, ?, ?)",
      [suite.id, contentHash(ref), JSON.stringify(suite), suite.createdAt],
    );
    return suite;
  }

  async getProfileEvaluationSuiteRun(id: string): Promise<ProfileEvaluationSuiteRun | null> {
    return this.getParsedPayload(
      "SELECT payload FROM profile_evaluation_suite_runs WHERE id = ?", [id], ProfileEvaluationSuiteRunSchema.parse,
    );
  }

  async listProfileEvaluationSuiteRuns(profileRef: OpenPondProfileRef): Promise<ProfileEvaluationSuiteRun[]> {
    return this.listParsedPayloads(
      "SELECT payload FROM profile_evaluation_suite_runs WHERE profile_key = ? ORDER BY created_at DESC, id ASC",
      [contentHash(OpenPondProfileRefSchema.parse(profileRef))], ProfileEvaluationSuiteRunSchema.parse,
    );
  }

  async saveBenchmarkRun(input: {
    tasksetId: string;
    run: BenchmarkRunSummary;
  }): Promise<BenchmarkRunSummary> {
    const run = BenchmarkRunSummarySchema.parse(input.run);
    assertContentHash(run, "Benchmark run");
    await this.upsertPayload(
      `INSERT INTO benchmark_runs (id, taskset_id, phase, payload, created_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(id) DO NOTHING`,
      [run.id, input.tasksetId, run.phase, JSON.stringify(run), run.createdAt],
    );
    return run;
  }

  async listBenchmarkRuns(tasksetId: string): Promise<BenchmarkRunSummary[]> {
    return this.listParsedPayloads(
      "SELECT payload FROM benchmark_runs WHERE taskset_id = ? ORDER BY created_at DESC, id ASC",
      [tasksetId],
      BenchmarkRunSummarySchema.parse,
    );
  }

  async saveBenchmarkComparison(input: {
    tasksetId: string;
    comparison: BenchmarkComparison;
  }): Promise<BenchmarkComparison> {
    const comparison = BenchmarkComparisonSchema.parse(input.comparison);
    assertContentHash(comparison, "Benchmark comparison");
    await this.upsertPayload(
      `INSERT INTO benchmark_comparisons (id, taskset_id, payload, created_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(id) DO NOTHING`,
      [comparison.id, input.tasksetId, JSON.stringify(comparison), comparison.createdAt],
    );
    return comparison;
  }

  async listBenchmarkComparisons(tasksetId: string): Promise<BenchmarkComparison[]> {
    return this.listParsedPayloads(
      "SELECT payload FROM benchmark_comparisons WHERE taskset_id = ? ORDER BY created_at DESC, id ASC",
      [tasksetId],
      BenchmarkComparisonSchema.parse,
    );
  }

  async saveEvaluationResult(input: {
    tasksetId: string;
    kind: "baseline" | "adaptation" | "candidate";
    result: EvaluationResult;
    createdAt: string;
  }): Promise<EvaluationResult> {
    const result = EvaluationResultSchema.parse(input.result);
    assertContentHash(result, "Evaluation result");
    if (result.metadata.sourceTasksetId !== input.tasksetId) {
      throw new Error("Evaluation result does not match the supplied Taskset identity.");
    }
    const existing = await this.getEvaluationResult(result.id);
    if (existing) {
      if (existing.contentHash !== result.contentHash) {
        throw new Error(`Evaluation result ${result.id} is immutable and already has another content hash.`);
      }
      return existing;
    }
    await this.upsertPayload(
      `INSERT INTO evaluation_results (id, taskset_id, kind, payload, created_at)
       VALUES (?, ?, ?, ?, ?)`,
      [result.id, input.tasksetId, input.kind, JSON.stringify(result), input.createdAt],
    );
    return result;
  }

  async getEvaluationResult(id: string): Promise<EvaluationResult | null> {
    return this.getParsedPayload(
      "SELECT payload FROM evaluation_results WHERE id = ?",
      [id],
      EvaluationResultSchema.parse,
    );
  }

  async listEvaluationResults(
    tasksetId: string,
    kind?: "baseline" | "candidate",
  ): Promise<EvaluationResult[]> {
    return this.listParsedPayloads(
      kind
        ? "SELECT payload FROM evaluation_results WHERE taskset_id = ? AND kind = ? ORDER BY created_at DESC, id ASC"
        : "SELECT payload FROM evaluation_results WHERE taskset_id = ? ORDER BY created_at DESC, id ASC",
      kind ? [tasksetId, kind] : [tasksetId],
      EvaluationResultSchema.parse,
    );
  }
}
