import { cancelLearningIterationReservation } from "./iteration-reservation-cancellation.js";
import { commandLearningIterationDispatch } from "./iteration-dispatch-commands.js";
import { reserveLearningIteration } from "./iteration-reservation-service.js";
import { synchronizeLearningSchedule } from "./schedule-service.js";
import { inspectLearningPolicy } from "./policy-inspection.js";
import { requireCurrentLearningEvidence as currentEvidence, sealLearningBatch } from "./batch-service.js";
import { saveAuthoringDraft, archiveAuthoringDraft, finalizeAuthoringDraft, currentDraft } from "./authoring-service.js";
import { assertRewardCalibration, qualifyRewardCheck } from "./reward-calibration.js";
import { queueRewardCheck, cancelRewardCheck } from "./reward-check-service.js";
import { LearningDomainError } from "./errors.js";
import { contentHash } from "@openpond/harness";
import { inspectLearningTaskQueue } from "./task-queue-inspection.js";
import { LearningReadRequestSchema } from "./transport.js";

import { createRewardBinding, createRewardRelease, type RewardComposition } from "../rewards.js";
import { assertBoundedTaskJson, validateTaskValue } from "../task-schema.js";
import { assertAdmissionDecision, assertGradeIdentity, inspectTaskEvidence } from "./admission.js";
import { learningRef, LearningSourceSchema, LearningPolicySchema, sameLearningRef, sealLearningContent, TaskAdmissionDecisionContentSchema, TaskAdmissionDecisionSchema, TaskDefinitionSchema, TaskEvidenceContentSchema, TaskEvidenceSchema, TaskFeedbackSchema, TaskGradeRunSchema, type LearningRevisionRef, type TaskEvidence, type TaskGradeRun } from "./contracts.js";
import { LearningCommandSchema, type LearningCommand, type PublishLearningResourceCommand } from "./operations.js";
import { LearningConflictError, learningEvidenceId, learningOperationId, requireLearningRelease, requireLearningResource, type LearningRepository, type LearningResourceFor, type LearningResourceKind, type LearningResourcePage, type LearningResourcePointer, type LearningResourceQuery, type LearningStoredResource, type LearningTransaction } from "./repository.js";
import { validateSourceSubmission } from "./admission.js";
import { LearningTextAssetSchema, verifyLearningTextAsset } from "./assets.js";
import { LearningRevisionRefSchema } from "./contracts.js";
import { importTaskIntake } from "./intake-service.js";

export type LearningActor = { id: string; role: "editor" | "reviewer" | "source"; sourceId?: string };
export type LearningServiceContext = { scope: string; actor: LearningActor };
export type LearningOperationResult = { operationId: string; resources: LearningStoredResource[] };

export function createLearningService(repository: LearningRepository, options: { now?: () => string } = {}) {
  const now = options.now ?? (() => new Date().toISOString());

  async function command(context: LearningServiceContext, raw: unknown): Promise<LearningOperationResult> {
    assertBoundedTaskJson(raw, 16_777_216);
    const input = LearningCommandSchema.parse(raw);
    authorize(context, input);
    const producer = input.action === "submit_example" ? input.example : input.action === "submit_feedback" ? input.feedback : null;
    const operationId = producer ? contentHash([input.action, producer.sourceId, producer.idempotencyKey]) : learningOperationId(context.actor.id, input.operationId);
    const requestHash = contentHash(producer ? { action: input.action, value: producer } : input);
    return repository.transaction(context.scope, async (transaction) => {
      const previous = await transaction.operation(operationId);
      if (previous) {
        if (previous.requestHash !== requestHash) throw new LearningDomainError("learning_idempotency_conflict", 409);
        return { operationId: input.operationId, resources: await Promise.all(previous.resources.map((pointer) => requireLearningResource(transaction, pointer.kind, pointer.id, pointer.revision))) };
      }
      let pointers: LearningResourcePointer[];
      switch (input.action) {
        case "publish_checked_reward": {
          const draft = await currentDraft(transaction, input.draft);
          if (draft.targetKind !== "reward") throw new LearningDomainError("reward_calibration_draft_kind_invalid", 422);
          const base = draft.baseRelease ? await requireLearningRelease(transaction, "reward", draft.baseRelease) : null;
          const check = await requireLearningResource(transaction, "reward_check", input.checkId, input.checkRevision);
          const qualified = qualifyRewardCheck(draft, base, check);
          const { contentHash: _rewardHash, ...content } = qualified.reward;
          const publication = { action: "publish_resources" as const, operationId: input.operationId,
            finalizeDraft: { draft: input.draft, targetKind: "reward" as const, release: learningRef(qualified.reward) },
            resources: [
              ...qualified.assets.map(({ contentHash: _assetHash, ...content }) => ({ kind: "asset" as const, expectedRevision: 0, content })),
              { kind: "reward" as const, expectedRevision: base?.revision ?? 0, content },
            ],
          };
          pointers = [];
          for (const resource of publication.resources) pointers.push(await publish(transaction, { ...resource, action: "publish", operationId: input.operationId }));
          const finalized = await finalizeAuthoringDraft(transaction, publication, pointers, now());
          if (finalized) pointers.push(finalized);
          break;
        }
        case "import_intake": pointers = await importTaskIntake(transaction, input, now(), submit); break;
        case "cancel_iteration":
        case "retry_iteration_dispatch": pointers = await commandLearningIterationDispatch(transaction, input, now()); break;
        case "cancel_iteration_reservation": pointers = await cancelLearningIterationReservation(transaction, input, now()); break;
        case "reserve_iteration": pointers = await reserveLearningIteration(transaction, input, context.actor.id, now()); break;
        case "queue_reward_check": pointers = [await queueRewardCheck(transaction, input, operationId, now(), context.actor.id)]; break;
        case "cancel_reward_check": pointers = [await cancelRewardCheck(transaction, input, now())]; break;
        case "save_draft": pointers = [await saveAuthoringDraft(transaction, input, now())]; break;
        case "archive_draft": pointers = [await archiveAuthoringDraft(transaction, input.draft, now())]; break;
        case "publish": pointers = [await publish(transaction, input)]; break;
        case "publish_resources": {
          pointers = [];
          for (const resource of input.resources) pointers.push(await publish(transaction, { ...resource, action: "publish", operationId: input.operationId }));
          break;
        }
        case "submit_example": pointers = [await submit(transaction, input)]; break;
        case "submit_feedback": pointers = [await feedback(transaction, input, context.actor)]; break;
        case "apply_correction": pointers = await correct(transaction, input, context.actor.id); break;
        case "resolve_feedback": pointers = [await resolveFeedback(transaction, input, context.actor.id)]; break;
        case "queue_grade": pointers = [await queueGrade(transaction, input, operationId, context.actor.id)]; break;
        case "cancel_grade": pointers = [await cancelGrade(transaction, input)]; break;
        case "review": pointers = [await review(transaction, input, context.actor.id)]; break;
        case "seal_batch": pointers = await sealLearningBatch(transaction, input, context.actor.id, now()); break;
      }
      if (input.action === "publish" || input.action === "publish_resources") {
        const finalized = await finalizeAuthoringDraft(transaction, input, pointers, now());
        if (finalized) pointers.push(finalized);
      }
      await transaction.saveOperation(operationId, { requestHash, resources: pointers });
      return { operationId: input.operationId, resources: await Promise.all(pointers.map((pointer) => requireLearningResource(transaction, pointer.kind, pointer.id, pointer.revision))) };
    });
  }

  async function publish(transaction: LearningTransaction, input: PublishLearningResourceCommand): Promise<LearningResourcePointer> {
    if (input.content.revision !== input.expectedRevision + 1) throw new LearningDomainError("learning_publication_revision_invalid", 422);
    let resource: LearningStoredResource;
    switch (input.kind) {
      case "asset": {
        resource = LearningTextAssetSchema.parse(sealLearningContent(input.content));
        const existing = await transaction.get("asset", resource.id, 1);
        if (existing?.contentHash === resource.contentHash) return pointer("asset", existing);
        break;
      }
      case "reward": {
        resource = createRewardRelease(input.content);
        await assertRewardCalibration(transaction, resource);
        const implementation = input.content.implementation;
        const references = [
          ...input.content.assets,
          ...("verifierRef" in implementation ? [implementation.verifierRef] : []),
          ...("rubricRef" in implementation ? [implementation.rubricRef] : []),
          ...("inputContract" in implementation ? [implementation.inputContract] : []),
        ];
        for (const reference of references) {
          const asset = await requireLearningResource(transaction, "asset", reference.id, 1);
          verifyLearningTextAsset(asset, reference);
          if (reference.visibility === "policy") throw new LearningDomainError("reward_asset_visibility_invalid", 422, "Reward source and rubrics must be private to the evaluator.");
        }
        break;
      }
      case "binding": {
        if (input.content.recipeRef) await requireLearningRelease(transaction, "binding", input.content.recipeRef);
        const rewards = await Promise.all(input.content.sources.map((source) => requireLearningRelease(transaction, "reward", source.reward)));
        resource = createRewardBinding(input.content, rewards);
        break;
      }
      case "definition": {
        await requireLearningRelease(transaction, "binding", input.content.rewardBinding);
        resource = TaskDefinitionSchema.parse(sealLearningContent(input.content));
        break;
      }
      case "source": {
        await requireLearningRelease(transaction, "definition", input.content.taskDefinition);
        resource = LearningSourceSchema.parse(sealLearningContent(input.content));
        break;
      }
      case "policy": {
        const definition = await requireLearningRelease(transaction, "definition", input.content.taskDefinition);
        if (!sameLearningRef(definition.rewardBinding, input.content.rewardBinding)) throw new LearningDomainError("learning_policy_binding_mismatch", 422);
        for (const source of input.content.sources) {
          const resource = await requireLearningRelease(transaction, "source", source);
          if (!sameLearningRef(resource.taskDefinition, input.content.taskDefinition)) throw new LearningDomainError("learning_policy_source_definition_mismatch", 422);
        }
        resource = LearningPolicySchema.parse(sealLearningContent(input.content));
        break;
      }
    }
    await transaction.put(input.kind, resource as LearningResourceFor<typeof input.kind>, input.expectedRevision, input.kind === "policy" ? { parentId: input.content.modelProjectId } : undefined);
    if (input.kind === "policy") await synchronizeLearningSchedule(transaction, LearningPolicySchema.parse(resource), now());
    return pointer(input.kind, resource);
  }

  async function submit(transaction: LearningTransaction, input: Extract<LearningCommand, { action: "submit_example" }>): Promise<LearningResourcePointer> {
    const source = await requireLearningResource(transaction, "source", input.example.sourceId);
    const submission = validateSourceSubmission(source, input.example);
    await requireLearningRelease(transaction, "definition", submission.taskDefinition);
    const id = learningEvidenceId(submission.sourceId, submission.exampleId, submission.attemptId);
    const existing = await transaction.get("evidence", id, 1);
    if (existing) {
      const { idempotencyKey: _oldKey, ...oldPayload } = existing.submission;
      const { idempotencyKey: _newKey, ...newPayload } = submission;
      if (contentHash(oldPayload) !== contentHash(newPayload)) throw new LearningDomainError("task_evidence_identity_conflict", 409);
      return pointer("evidence", existing);
    }
    const evidence = TaskEvidenceSchema.parse(sealLearningContent(TaskEvidenceContentSchema.parse({
      schemaVersion: "openpond.taskEvidence.v1", id, revision: 1, source: learningRef(source), submission,
      supersedes: null, correctionFeedbackId: null, receivedAt: now(),
    })));
    await transaction.put("evidence", evidence, 0, { parentId: source.id });
    let afterId: string | undefined;
    do {
      const page = await transaction.list("feedback", { parentId: evidence.id, status: "pending_example", limit: 100, ...(afterId ? { afterId } : {}) });
      for (const feedback of page.items) {
        const updated = TaskFeedbackSchema.parse({ ...feedback, revision: feedback.revision + 1, status: "pending_review", evidence: learningRef(evidence) });
        await transaction.put("feedback", updated, feedback.revision, { parentId: evidence.id, status: updated.status });
      }
      afterId = page.nextCursor ?? undefined;
    } while (afterId);
    return pointer("evidence", evidence);
  }

  async function feedback(transaction: LearningTransaction, input: Extract<LearningCommand, { action: "submit_feedback" }>, actor: LearningActor): Promise<LearningResourcePointer> {
    const source = await requireLearningResource(transaction, "source", input.feedback.sourceId);
    if (!source.enabled) throw new LearningDomainError("learning_source_disabled", 409);
    const evidenceId = learningEvidenceId(source.id, input.feedback.exampleId, input.feedback.attemptId);
    const evidence = await transaction.get("evidence", evidenceId);
    if (input.feedback.value.schemaVersion === "openpond.taskRating.v1" && (!evidence || evidence.contentHash !== input.feedback.expectedEvidenceHash || !evidence.submission.observedOutput)) throw new LearningDomainError("task_rating_evidence_stale", 409, "Open the current observed response before submitting a rating.");
    const record = TaskFeedbackSchema.parse({
      schemaVersion: "openpond.taskFeedbackRecord.v1", id: `feedback-${contentHash([source.id, input.feedback.idempotencyKey])}`,
      submission: input.feedback, status: evidence ? "pending_review" : "pending_example",
      evidence: evidence ? learningRef(evidence) : null, createdAt: now(), revision: 1,
      submittedBy: { id: actor.id, role: actor.role, sourceId: actor.sourceId ?? null },
    });
    await transaction.put("feedback", record, 0, { parentId: evidenceId, status: record.status });
    return pointer("feedback", record);
  }

  async function correct(transaction: LearningTransaction, input: Extract<LearningCommand, { action: "apply_correction" }>, actorId: string): Promise<LearningResourcePointer[]> {
    const feedback = await requireLearningResource(transaction, "feedback", input.feedbackId);
    if (["applied", "rejected", "superseded"].includes(feedback.status)) throw new LearningDomainError("task_feedback_already_resolved", 409);
    const evidence = await currentEvidence(transaction, input.evidence);
    const expectedId = learningEvidenceId(feedback.submission.sourceId, feedback.submission.exampleId, feedback.submission.attemptId);
    if (expectedId !== evidence.id || (feedback.submission.expectedEvidenceHash !== null && feedback.submission.expectedEvidenceHash !== evidence.contentHash)) throw new LearningDomainError("task_feedback_evidence_mismatch", 409);
    const definition = await requireLearningRelease(transaction, "definition", evidence.submission.taskDefinition);
    const submission = { ...evidence.submission };
    const { kind, value } = feedback.submission;
    if (kind === "ground_truth_correction") {
      if (!validateTaskValue(definition.outputSchema, value).valid) throw new LearningDomainError("task_corrected_expected_schema_invalid", 422);
      submission.expected = value;
    } else if (kind === "input_correction") {
      if (!validateTaskValue(definition.inputSchema, value).valid) throw new LearningDomainError("task_corrected_input_schema_invalid", 422);
      submission.input = value;
    } else if (kind === "family_resolution") {
      if (typeof value.familyKey !== "string" || !value.familyKey.trim()) throw new LearningDomainError("task_family_resolution_invalid", 422);
      submission.familyKey = value.familyKey;
    } else throw new LearningDomainError("task_feedback_requires_target_review", 422);
    const { contentHash: _priorHash, ...priorContent } = evidence;
    const revised = TaskEvidenceSchema.parse(sealLearningContent(TaskEvidenceContentSchema.parse({
      ...priorContent, revision: evidence.revision + 1, submission, supersedes: learningRef(evidence), correctionFeedbackId: feedback.id, receivedAt: now(),
    })));
    const resolved = TaskFeedbackSchema.parse({ ...feedback, revision: feedback.revision + 1, status: "applied", evidence: learningRef(revised), review: { actorId, decision: null, note: "Applied as a corrected evidence revision.", resolvedAt: now() } });
    await transaction.put("evidence", revised, evidence.revision, { parentId: submission.sourceId });
    await transaction.put("feedback", resolved, feedback.revision, { parentId: evidence.id, status: resolved.status });
    return [pointer("evidence", revised), pointer("feedback", resolved)];
  }

  async function resolveFeedback(transaction: LearningTransaction, input: Extract<LearningCommand, { action: "resolve_feedback" }>, actorId: string): Promise<LearningResourcePointer> {
    const feedback = await requireLearningResource(transaction, "feedback", input.feedbackId);
    if (feedback.revision !== input.expectedRevision) throw new LearningConflictError("feedback", feedback.id, input.expectedRevision, feedback.revision);
    if (["applied", "rejected", "superseded"].includes(feedback.status)) throw new LearningDomainError("task_feedback_already_resolved", 409);
    if (input.disposition === "applied" && !input.decision) throw new LearningDomainError("task_feedback_decision_required");
    if (input.decision) {
      const decision = await requireLearningRelease(transaction, "decision", input.decision);
      const current = await requireLearningResource(transaction, "decision", decision.id);
      if (!sameLearningRef(learningRef(current), input.decision)) throw new LearningDomainError("task_admission_revision_stale", 409);
      const evidence = await currentEvidence(transaction, decision.evidence);
      if (learningEvidenceId(feedback.submission.sourceId, feedback.submission.exampleId, feedback.submission.attemptId) !== evidence.id || (feedback.submission.expectedEvidenceHash !== null && feedback.submission.expectedEvidenceHash !== evidence.contentHash)) throw new LearningDomainError("task_feedback_evidence_mismatch", 409);
      if (input.disposition === "applied") {
        if (decision.taskAdmissibility === "pending") throw new LearningDomainError("task_feedback_decision_pending");
        if (feedback.submission.kind === "target_correction") {
          if (decision.targetApproval !== "approved" || contentHash(decision.approvedTarget) !== contentHash(feedback.submission.value)) throw new LearningDomainError("task_feedback_target_not_approved");
        } else if (feedback.submission.kind !== "outcome") throw new LearningDomainError("task_feedback_requires_evidence_correction");
      }
    }
    const resolved = TaskFeedbackSchema.parse({ ...feedback, revision: feedback.revision + 1, status: input.disposition, review: { actorId, decision: input.decision, note: input.note, resolvedAt: now() } });
    await transaction.put("feedback", resolved, feedback.revision, { parentId: learningEvidenceId(feedback.submission.sourceId, feedback.submission.exampleId, feedback.submission.attemptId), status: resolved.status });
    return pointer("feedback", resolved);
  }

  async function queueGrade(transaction: LearningTransaction, input: Extract<LearningCommand, { action: "queue_grade" }>, operationId: string, requestedBy: string): Promise<LearningResourcePointer> {
    const evidence = await currentEvidence(transaction, input.evidence);
    const definition = await requireLearningRelease(transaction, "definition", evidence.submission.taskDefinition);
    if (!inspectTaskEvidence(evidence, definition).taskReady) throw new LearningDomainError("task_evidence_not_ready", 422);
    const output = input.target === "observed" ? evidence.submission.observedOutput : input.proposedTarget;
    if (output === null) throw new LearningDomainError("task_grade_output_required", 422);
    if (input.target === "observed" && input.proposedTarget !== null) throw new LearningDomainError("observed_grade_cannot_replace_output", 422);
    const grade = TaskGradeRunSchema.parse({
      schemaVersion: "openpond.taskGradeRun.v1", id: `grade-${operationId}`, revision: 1,
      evidence: learningRef(evidence), binding: definition.rewardBinding, target: input.target, output,
      status: "queued", composition: null, leaseOwner: null, leaseExpiresAt: null, attemptCount: 0,
      timeoutMs: input.timeoutMs, maximumSpendUsd: input.maximumSpendUsd, requestedBy, failure: null, createdAt: now(), updatedAt: now(),
    });
    await transaction.put("grade", grade, 0, { parentId: evidence.id, status: grade.status });
    return pointer("grade", grade);
  }

  async function cancelGrade(transaction: LearningTransaction, input: Extract<LearningCommand, { action: "cancel_grade" }>): Promise<LearningResourcePointer> {
    const grade = await requireLearningResource(transaction, "grade", input.gradeId);
    if (grade.revision !== input.expectedRevision) throw new LearningConflictError("grade", grade.id, input.expectedRevision, grade.revision);
    if (["completed", "failed", "cancelled"].includes(grade.status)) return pointer("grade", grade);
    const updated = TaskGradeRunSchema.parse({ ...grade, revision: grade.revision + 1, status: grade.status === "queued" ? "cancelled" : "cancelling", updatedAt: now() });
    await transaction.put("grade", updated, grade.revision, { parentId: grade.evidence.id, status: updated.status });
    return pointer("grade", updated);
  }

  async function review(transaction: LearningTransaction, input: Extract<LearningCommand, { action: "review" }>, actorId: string): Promise<LearningResourcePointer> {
    const evidence = await currentEvidence(transaction, input.evidence);
    const definition = await requireLearningRelease(transaction, "definition", evidence.submission.taskDefinition);
    const inspection = inspectTaskEvidence(evidence, definition);
    const id = `decision-${evidence.id}`;
    const previous = await transaction.get("decision", id);
    const observedGrade = await gradeResult(transaction, input.observedGradeId, evidence, "observed");
    const targetGrade = await gradeResult(transaction, input.targetGradeId, evidence, "proposed_target");
    const measured = observedGrade?.training.status === "scored" ? observedGrade.training : observedGrade?.evaluation;
    const decision = TaskAdmissionDecisionSchema.parse(sealLearningContent(TaskAdmissionDecisionContentSchema.parse({
      schemaVersion: "openpond.taskAdmissionDecision.v1", id, revision: input.expectedRevision + 1,
      evidence: learningRef(evidence), supersedes: previous ? learningRef(previous) : null,
      actor: { kind: "human", id: actorId, policy: null }, evidenceValidity: inspection.evidenceValidity,
      taskAdmissibility: input.disposition, observedQuality: measured?.status === "scored" ? measured.passed ? "passed" : "failed" : observedGrade ? "unavailable" : "unscored",
      targetApproval: input.targetApproval, approvedTarget: input.approvedTarget, grade: observedGrade, targetGrade,
      note: input.note, decidedAt: now(),
    })));
    if (input.disposition === "approved") assertAdmissionDecision({ decision, evidence, definition, purpose: input.targetApproval === "approved" ? "supervised_training" : "reward_training" });
    await transaction.put("decision", decision, input.expectedRevision, { parentId: evidence.id, status: decision.taskAdmissibility });
    return pointer("decision", decision);
  }

  return {
    command,
    async inspectTaskQueue(context: LearningServiceContext, modelProjectId: string | null = null) {
      authorizeRead(context);
      const input = LearningReadRequestSchema.parse({ action: "inspect_task_queue", scope: context.scope, modelProjectId });
      if (input.action !== "inspect_task_queue") throw new LearningDomainError("learning_request_invalid", 400);
      return repository.transaction(context.scope, transaction => inspectLearningTaskQueue(transaction, input.modelProjectId, now()));
    },
    async inspectPolicy(context: LearningServiceContext, reference: LearningRevisionRef) {
      authorizeRead(context);
      const ref = LearningRevisionRefSchema.parse(reference);
      return repository.transaction(context.scope, transaction => inspectLearningPolicy(transaction, ref, context.actor.id, now()));
    },
    async inspectEvidence(context: LearningServiceContext, reference: LearningRevisionRef) {
      authorizeRead(context);
      const ref = LearningRevisionRefSchema.parse(reference);
      return repository.transaction(context.scope, async (transaction) => {
        const evidence = await requireLearningRelease(transaction, "evidence", ref);
        const definition = await requireLearningRelease(transaction, "definition", evidence.submission.taskDefinition);
        return { evidence: learningRef(evidence), definition: learningRef(definition), inspection: inspectTaskEvidence(evidence, definition) };
      });
    },
    async get<K extends LearningResourceKind>(context: LearningServiceContext, kind: K, id: string, revision?: number): Promise<LearningResourceFor<K>> {
      authorizeRead(context);
      return repository.transaction(context.scope, (transaction) => requireLearningResource(transaction, kind, id, revision));
    },
    async list<K extends LearningResourceKind>(context: LearningServiceContext, kind: K, query: Partial<LearningResourceQuery> = {}): Promise<LearningResourcePage<K>> {
      authorizeRead(context);
      if (query.reviewState !== undefined && (kind !== "evidence" || !["inbox", "reviewed"].includes(query.reviewState))) throw new LearningDomainError("learning_review_filter_invalid", 400);
      const limit = Math.max(1, Math.min(100, Math.trunc(query.limit ?? 50)));
      return repository.transaction(context.scope, (transaction) => transaction.list(kind, { ...query, limit }));
    },
  };
}

async function gradeResult(transaction: LearningTransaction, id: string | null, evidence: TaskEvidence, target: TaskGradeRun["target"]): Promise<RewardComposition | null> {
  if (id === null) return null;
  const grade = await requireLearningResource(transaction, "grade", id);
  if (grade.status !== "completed" || !grade.composition || grade.target !== target || !sameLearningRef(grade.evidence, learningRef(evidence))) throw new LearningDomainError("task_grade_not_applicable", 422);
  const definition = await requireLearningRelease(transaction, "definition", evidence.submission.taskDefinition);
  assertGradeIdentity(grade.composition, evidence, definition, grade.output);
  return grade.composition;
}
function pointer(kind: LearningResourceKind, resource: { id: string; revision: number }): LearningResourcePointer { return { kind, id: resource.id, revision: resource.revision }; }
function authorizeRead(context: LearningServiceContext): void {
  if (!context.scope.trim() || !context.actor.id.trim() || context.actor.role === "source") throw new LearningDomainError("learning_read_not_authorized", 403);
}
function authorize(context: LearningServiceContext, input: LearningCommand): void {
  if (!context.scope.trim() || !context.actor.id.trim()) throw new LearningDomainError("learning_scope_required", 400);
  const publications = input.action === "publish" ? [input] : input.action === "publish_resources" ? input.resources : [];
  if (context.actor.role !== "reviewer" && publications.some(value => value.kind === "policy" && value.content.enabled
    && value.content.automation.train && value.content.trigger.kind !== "manual")) throw new LearningDomainError("learning_review_not_authorized", 403);
  if (context.actor.role === "source") {
    const sourceId = input.action === "submit_example" ? input.example.sourceId : input.action === "submit_feedback" ? input.feedback.sourceId : null;
    if (!sourceId || sourceId !== context.actor.sourceId) throw new LearningDomainError("learning_source_not_authorized", 403);
  }
  if (["review", "apply_correction", "resolve_feedback", "seal_batch", "reserve_iteration", "cancel_iteration_reservation", "cancel_iteration", "retry_iteration_dispatch"].includes(input.action) && context.actor.role !== "reviewer") throw new LearningDomainError("learning_review_not_authorized", 403);
}
