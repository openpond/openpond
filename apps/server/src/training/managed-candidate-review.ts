import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { TrainingExecutionRefSchema } from "@openpond/contracts";
import { contentHash } from "@openpond/taskset-sdk";
import {
  createTrainingClient, canonicalSha256, parseAndVerifyTrainingCandidateDecision,
  parseAndVerifyTrainingExecutionReceipt, TrainingCandidateDecisionRequestSchema,
  type TrainingCandidateDecision,
} from "openpond-sdk/training";
import { z } from "zod";
import type { SqliteStore } from "../store/store.js";
import { hostedApiAuthHeaders, resolveManagedAdapterUserAccess } from "../openpond/hosted-api-access.js";
import { assertManagedTrainingEvaluationReceipt } from "./managed-training-evaluation-source.js";

const TargetSchema = TrainingCandidateDecisionRequestSchema.pick({ teamId: true, jobId: true, artifact: true, evaluation: true, executionReceipt: true });
export type ManagedCandidateReview = {
  target: z.infer<typeof TargetSchema>;
  decision: TrainingCandidateDecision | null;
  syncedAt: string;
};
const ViewSchema = z.object({ target: TargetSchema, decision: z.unknown().nullable(), syncedAt: z.string().datetime({ offset: true }) }).strict();

export function createManagedCandidateReviewService(deps: {
  store: SqliteStore;
  storeDir: string;
  resolveAccess?: () => Promise<{ apiBaseUrl: string; token: string; teamId: string }>;
  fetch?: typeof fetch;
}) {
  const pending = new Map<string, Promise<unknown>>();
  async function serialized<T>(id: string, operation: () => Promise<T>): Promise<T> {
    const previous = pending.get(id);
    const current = (previous ?? Promise.resolve()).catch(() => undefined).then(operation);
    pending.set(id, current);
    try { return await current; } finally { if (pending.get(id) === current) pending.delete(id); }
  }
  async function context(lineageId: string) {
    const lineage = await deps.store.getModelArtifactLineage(lineageId);
    if (!lineage) throw new Error("Model Version not found.");
    const job = await deps.store.getTrainingJob(lineage.jobId);
    if (!job || job.destinationId !== "openpond_managed" || job.status !== "succeeded") throw new Error("A completed managed training run is required for candidate review.");
    const ref = TrainingExecutionRefSchema.parse(job.metadata.portableExecutionRef);
    if (ref.adapterId !== "sandbox-managed-rl" || ref.runId !== job.id || !ref.tenantId || !ref.manifestHash) throw new Error("The candidate has no bound managed training identity.");
    const artifacts = await deps.store.listTrainingArtifacts(job.id);
    const artifact = artifacts.find(value => value.id === lineage.artifactId);
    if (!artifact || artifact.metadata.verified !== true || artifact.metadata.portableKind !== "adapter"
      || artifact.metadata.managedRlJobId !== ref.runId || artifact.metadata.managedRlTeamId !== ref.tenantId
      || typeof artifact.metadata.managedRlOutputId !== "string") throw new Error("The Model Version has no verified managed adapter output.");
    const receiptArtifact = artifacts.find(value => value.metadata.portableKind === "receipt" && value.metadata.verified === true
      && value.metadata.managedRlJobId === ref.runId && value.metadata.managedRlTeamId === ref.tenantId);
    if (!receiptArtifact) throw new Error("The candidate has no retained execution receipt.");
    const target = { teamId: ref.tenantId, jobId: ref.runId, artifact: { id: artifact.metadata.managedRlOutputId, contentHash: artifact.sha256 } };
    return { lineage, job, ref, artifacts, artifact, receiptArtifact, target };
  }
  type Context = Awaited<ReturnType<typeof context>>;
  async function client(value: Context) {
    const access = deps.resolveAccess ? await deps.resolveAccess() : await resolveManagedAdapterUserAccess({ teamId: value.ref.tenantId! });
    if (access.teamId !== value.ref.tenantId) throw new Error("The selected team does not own this candidate.");
    const headers = hostedApiAuthHeaders(access.token);
    headers.set("x-openpond-team-id", access.teamId);
    return createTrainingClient({ baseUrl: access.apiBaseUrl, fetch: deps.fetch, headers });
  }
  function assertTarget(value: Context, target: ManagedCandidateReview["target"]) {
    if (target.teamId !== value.target.teamId || target.jobId !== value.target.jobId
      || contentHash(target.artifact) !== contentHash(value.target.artifact)
      || target.executionReceipt.contentHash !== value.receiptArtifact.sha256) throw new Error("The review cache does not match the imported candidate and execution receipt.");
    const evaluation = value.artifacts.find(item => item.metadata.managedRlOutputId === target.evaluation.id
      && item.sha256 === target.evaluation.contentHash && item.metadata.portableKind === "evaluation"
      && item.metadata.verified === true && item.metadata.managedRlJobId === value.ref.runId && item.metadata.managedRlTeamId === value.ref.tenantId);
    if (!evaluation || (evaluation.metadata.managedRlOutputMetadata as Record<string, unknown> | undefined)?.kind !== "candidate") throw new Error("The review must retain an imported candidate evaluation.");
    return evaluation;
  }
  function cacheFile(lineageId: string) { return path.join(deps.storeDir, "training", "candidate-reviews", `${contentHash(lineageId)}.json`); }
  async function readCached(value: Context): Promise<ManagedCandidateReview | null> {
    let bytes: string;
    try { bytes = await readFile(cacheFile(value.lineage.id), "utf8"); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; }
    const envelope = z.object({ view: ViewSchema, contentHash: z.string() }).strict().parse(JSON.parse(bytes));
    if (await canonicalSha256(envelope.view) !== envelope.contentHash) throw new Error("The saved candidate review changed.");
    assertTarget(value, envelope.view.target);
    const decision = envelope.view.decision === null ? null : await parseAndVerifyTrainingCandidateDecision(envelope.view.decision, envelope.view.target);
    if (decision && (contentHash(decision.request.evaluation) !== contentHash(envelope.view.target.evaluation)
      || contentHash(decision.request.executionReceipt) !== contentHash(envelope.view.target.executionReceipt))) throw new Error("The saved decision references different candidate evidence.");
    return { ...envelope.view, decision };
  }
  async function persist(value: Context, view: ManagedCandidateReview) {
    const evaluation = assertTarget(value, view.target);
    const previous = await readCached(value);
    if (previous?.decision && (!view.decision || view.decision.revision < previous.decision.revision)) throw new Error("The hosted candidate review is older than the saved decision.");
    const file = cacheFile(value.lineage.id);
    await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
    const temporary = `${file}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporary, JSON.stringify({ view, contentHash: await canonicalSha256(view) }), { mode: 0o600 });
      await rename(temporary, file);
    } finally { await rm(temporary, { force: true }); }
    const current = await deps.store.getModelArtifactLineage(value.lineage.id);
    if (!current) throw new Error("The reviewed Model Version no longer exists locally.");
    if (view.decision) await deps.store.updateModelArtifactLineageReview(current.id, {
      frozenEvaluationArtifactId: evaluation.id,
      status: view.decision.request.decision === "rejected" ? "rejected" : "imported",
      rejectedAt: view.decision.request.decision === "rejected" ? view.decision.decidedAt : null,
      rejectionReason: view.decision.request.decision === "rejected" ? view.decision.request.reason : null,
    });
    return view;
  }
  async function targetFromHosted(value: Context, hosted: Awaited<ReturnType<typeof client>>) {
    const outputs = await hosted.outputs(value.ref.runId);
    const adapter = outputs.outputs.find(item => item.kind === "adapter" && item.id === value.target.artifact.id && item.contentHash === value.target.artifact.contentHash);
    if (!adapter || !outputs.receipt) throw new Error("The hosted candidate differs from the imported Version.");
    const policyVersion = z.number().int().nonnegative().parse(adapter.metadata?.policyVersion);
    const evaluation = outputs.outputs.find(item => item.kind === "evaluation" && item.metadata?.kind === "candidate" && item.metadata?.policyVersion === policyVersion);
    if (!evaluation) throw new Error("The adapter has no matching retained candidate evaluation.");
    const receipt = await parseAndVerifyTrainingExecutionReceipt(outputs.receipt, {
      id: outputs.receipt.id, contentHash: value.receiptArtifact.sha256,
      teamId: value.ref.tenantId!, jobId: value.ref.runId, requireCleanup: true,
    });
    await assertManagedTrainingEvaluationReceipt({ storeDir: deps.storeDir, receipt, expectedManifestHash: value.ref.manifestHash, expectedSubmissionHash: value.ref.inputBundleHash });
    const target = { ...value.target, evaluation: { id: evaluation.id, contentHash: evaluation.contentHash }, executionReceipt: { id: receipt.id, contentHash: value.receiptArtifact.sha256 } };
    assertTarget(value, target);
    return target;
  }
  async function read(lineageId: string, refresh: boolean): Promise<ManagedCandidateReview | null> {
    return serialized(lineageId, async () => {
      const value = await context(lineageId);
      if (!refresh) return readCached(value);
      const hosted = await client(value);
      const target = await targetFromHosted(value, hosted);
      const decision = await hosted.candidateDecision(target);
      return persist(value, { target, decision, syncedAt: new Date().toISOString() });
    });
  }
  async function record(lineageId: string, requestValue: unknown): Promise<ManagedCandidateReview> {
    return serialized(lineageId, async () => {
      const value = await context(lineageId);
      const request = TrainingCandidateDecisionRequestSchema.parse(requestValue);
      assertTarget(value, request);
      const activeBindings = (await deps.store.listModelBindings()).some(binding => binding.status === "active" && binding.modelArtifactLineageId === lineageId);
      if (request.decision === "rejected" && activeBindings) throw new Error("Deactivate every active binding before rejecting this candidate.");
      const hosted = await client(value);
      const target = await targetFromHosted(value, hosted);
      if (contentHash(TargetSchema.strip().parse(request)) !== contentHash(target)) throw new Error("The candidate evidence changed. Refresh before recording a review.");
      const decision = await hosted.recordCandidateDecision(request);
      return persist(value, { target, decision, syncedAt: new Date().toISOString() });
    });
  }
  async function history(lineageId: string, decision: { id: string; contentHash: string }): Promise<TrainingCandidateDecision> {
    const value = await context(lineageId);
    const hosted = await client(value);
    const result = await hosted.candidateDecision(value.target, { decision });
    if (!result) throw new Error("Candidate decision history entry not found.");
    assertTarget(value, result.request);
    return result;
  }
  return { read, record, history };
}
