import { z } from "zod";
import { LearningCommandRequestSchema, LearningReadRequestSchema, OpenPondLearningError, learningEvidenceId, learningRef, sameLearningRef, type LearningPolicy, type LearningRevisionRef, type OpenPondLearningClient } from "openpond-sdk/learning";

export const HostedLearningReviewRequestSchema = z.object({
  policyId: z.string().min(1), sourceId: z.string().min(1),
  endpoint: z.enum(["read", "commands"]), request: z.unknown(),
}).strict();

/** Review shares public SDK contracts, but can reach only this policy's source
 * and its evidence, grading receipts and immutable task/reward dependencies. */
export async function runHostedLearningReview(client: OpenPondLearningClient, policy: LearningPolicy, sourceId: string, endpoint: "read" | "commands", raw: unknown) {
  const deny = (): never => { throw new OpenPondLearningError(403, "hosted_review_scope_mismatch", "This resource does not belong to the selected hosted learning source.", null); };
  const sourceRef = policy.sources.find(source => source.id === sourceId);
  if (!sourceRef) return deny();
  const source = await client.get("source", sourceRef.id, sourceRef.revision);
  if (!sameLearningRef(learningRef(source), sourceRef)) return deny();
  async function evidence(id: string, revision?: number, ref?: LearningRevisionRef) {
    const value = await client.get("evidence", id, revision);
    if (!sameLearningRef(value.source, sourceRef!) || value.submission.sourceId !== sourceId || !sameLearningRef(value.submission.taskDefinition, policy.taskDefinition) || ref && !sameLearningRef(learningRef(value), ref)) return deny();
    return value;
  }
  async function receipt(kind: "grade" | "decision" | "feedback", id: string, revision?: number) {
    const value = await client.get(kind, id, revision);
    if (!value.evidence) return deny();
    await evidence(value.evidence.id, value.evidence.revision, value.evidence);
    return value;
  }
  if (endpoint === "read") {
    const request = LearningReadRequestSchema.parse(raw);
    if (request.action === "inspect_evidence") {
      await evidence(request.evidence.id, request.evidence.revision, request.evidence);
      return client.inspectEvidence(request.evidence);
    }
    if (request.action === "get") {
      if (request.kind === "evidence") return evidence(request.id, request.revision);
      if (request.kind === "grade" || request.kind === "decision" || request.kind === "feedback") return receipt(request.kind, request.id, request.revision);
      if (request.kind === "source" && request.id === sourceId && (request.revision === undefined || request.revision === source.revision)) return source;
      if (request.kind === "definition" || request.kind === "binding" || request.kind === "reward") {
        const refs = request.kind === "definition" ? [policy.taskDefinition] : request.kind === "binding" ? [policy.rewardBinding] : (await client.get("binding", policy.rewardBinding.id, policy.rewardBinding.revision)).sources.map(item => item.reward);
        const ref = refs.find(ref => ref.id === request.id && ref.revision === request.revision);
        if (!ref) return deny();
        const value = await client.get(request.kind, ref.id, ref.revision);
        if (!sameLearningRef(learningRef(value), ref)) return deny();
        return value;
      }
    }
    if (request.action === "list") {
      const { kind, parentId, afterId, limit, status } = request;
      if (kind === "evidence" && parentId === sourceId) {
        const page = await client.list(kind, { parentId, afterId, limit, status });
        // Preserve the server cursor while limiting the view to the pinned source release.
        return { ...page, items: page.items.filter(item => sameLearningRef(item.source, sourceRef) && sameLearningRef(item.submission.taskDefinition, policy.taskDefinition)) };
      }
      if ((kind === "grade" || kind === "decision" || kind === "feedback") && parentId) {
        await evidence(parentId);
        const page = await client.list(kind, { parentId, afterId, limit, status });
        if (page.items.some(item => item.evidence?.id !== parentId)) return deny();
        return page;
      }
    }
    return deny();
  }
  const { command } = LearningCommandRequestSchema.parse(raw);
  if (command.action === "submit_feedback") {
    const feedback = command.feedback;
    if (feedback.sourceId !== sourceId) return deny();
    const value = await evidence(learningEvidenceId(sourceId, feedback.exampleId, feedback.attemptId));
    if (feedback.expectedEvidenceHash !== value.contentHash) return deny();
  } else if (command.action === "queue_grade" || command.action === "review" || command.action === "apply_correction") {
    await evidence(command.evidence.id, command.evidence.revision, command.evidence);
    if (command.action === "apply_correction") {
      const feedback = await receipt("feedback", command.feedbackId);
      if (!sameLearningRef(feedback.evidence!, command.evidence)) return deny();
    }
    if (command.action === "review") {
      for (const id of [command.observedGradeId, command.targetGradeId]) {
        if (id && !sameLearningRef((await receipt("grade", id)).evidence!, command.evidence)) return deny();
      }
    }
  } else if (command.action === "cancel_grade") await receipt("grade", command.gradeId);
  else if (command.action === "resolve_feedback") {
    const feedback = await receipt("feedback", command.feedbackId);
    if (command.decision) {
      const decision = await receipt("decision", command.decision.id, command.decision.revision);
      if (!sameLearningRef(decision.evidence!, feedback.evidence!)) return deny();
    }
  } else return deny();
  return client.command(command);
}
