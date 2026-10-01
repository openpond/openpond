import {assertHumanTaskProposal,redactHumanTaskProposal} from "./task-proposals.js";
import { contentHash } from "@openpond/harness";
import { LearningDomainError } from "../learning/errors.js";
import { assertHumanAnswers, HumanReviewCommandSchema, HumanReviewSchema, sealHumanRecord, type HumanReview, type HumanReviewCommand, type HumanReviewRequest } from "./contracts.js";
import type { HumanReviewAuthority, HumanReviewContext, HumanReviewRepository } from "./repository.js";
const closed = (r: HumanReview) => ["accepted", "rejected", "cancelled"].includes(r.status);
function fail(code: string, status: 400 | 403 | 404 | 409 | 422 = 422): never { throw new LearningDomainError(code, status); }
function answers(record: HumanReview, value: Parameters<typeof assertHumanAnswers>[1], complete: boolean) {
  try { assertHumanAnswers(record.form, value, complete); } catch (e) { fail(e instanceof Error ? e.message : "human_answer_invalid"); }
}
export function createHumanReviewService(repository: HumanReviewRepository, authority: HumanReviewAuthority, now = () => new Date().toISOString()) {
  async function access(context: HumanReviewContext, record: HumanReview) {
    if (record.scope !== context.scope) fail("human_scope_denied", 403);
    await authority.member(context);
    const owner = await authority.owner(context, record.projectId);
    const manager = owner || record.policy.managerIds.includes(context.actorId);
    const reviewer = owner || record.assigneeId === context.actorId || record.policy.reviewerIds.includes(context.actorId);
    const readable = owner || manager || reviewer || record.policy.teamVisible;
    if (!readable) fail("human_review_not_found", 404);
    await authority.evidence(context, record);
    return { owner, manager, reviewer };
  }
  async function command(context: HumanReviewContext, raw: HumanReviewCommand): Promise<HumanReview> {
    const input = HumanReviewCommandSchema.parse(raw);
    return repository.transaction(context.scope, async tx => {
      await authority.member(context);
      let current = await tx.get(input.id);
      let allowed = { owner: false, manager: false, reviewer: false };
      if (input.action === "create") {
        const spec = { projectId: input.projectId, evidence: input.evidence, form: input.form };
        if (!await authority.owner(context, input.projectId)) fail("human_assignment_owner_required", 403);
        await authority.evidence(context, spec);
        for (const actorId of new Set([...(input.assigneeId ? [input.assigneeId] : []), ...input.policy.managerIds, ...input.policy.reviewerIds])) await authority.assignee(context, actorId, spec);
        if (input.kind === "grade" && !input.evidence.attempts.length) fail("human_grade_requires_attempt");
        if (input.kind !== "grade" && !input.evidence.taskIds?.length) fail("human_task_assignment_requires_tasks");
        if ((input.form.mode === "pairwise") !== (input.evidence.attempts.length === 2)) fail("human_form_evidence_mode_mismatch");
      } else {
        if (!current) fail("human_review_not_found", 404);
        allowed = await access(context, current);
        if(input.action==="bind_author_publication"&&!allowed.owner)fail("human_task_publication_owner_required",403);
        if (["reassign", "cancel", "decide"].includes(input.action) && !allowed.manager) fail("human_manager_required", 403);
        if (["save_draft", "submit", "reserve_execution", "bind_execution"].includes(input.action) && !allowed.reviewer && !(input.action==="bind_execution"&&current.status==="cancelled"&&allowed.manager)) fail("human_assignee_required", 403);
        if (input.action === "claim" && (!current.policy.queueClaim || !current.policy.teamVisible || (current.policy.reviewerIds.length && !current.policy.reviewerIds.includes(context.actorId) && !allowed.owner))) fail("human_claim_denied", 403);
      }
      // Authority and evidence are checked before replaying a receipt. Revocation cannot be bypassed by retries.
      const operationKey = contentHash([context.actorId, input.operationId]);
      const requestHash = contentHash(input);
      const receipt = await tx.operation(operationKey);
      if (receipt) {
        if (receipt.requestHash !== requestHash) fail("human_operation_conflict", 409);
        const result = await tx.get(receipt.reviewId, receipt.revision);
        if (!result) fail("human_operation_result_unavailable", 409);
        return result;
      }
      if ((current?.revision ?? 0) !== input.expectedRevision) fail("human_revision_conflict", 409);
      const timestamp = now();
      if (input.action === "create") {
        if (current || input.expectedRevision !== 0) fail("human_review_exists", 409);
        current = HumanReviewSchema.parse(sealHumanRecord({ schemaVersion: "openpond.humanReview.v1", id: input.id, revision: 1, scope: context.scope, projectId: input.projectId, createdBy: context.actorId, kind: input.kind, title: input.title,...(input.dueAt?{dueAt:input.dueAt}:{}),authorPublication:null, evidence: input.evidence, form: input.form, policy: input.policy, status: input.assigneeId ? "assigned" : "queued", assigneeId: input.assigneeId, generation: 1, drafts: [], submissions: [], decisions: [], audit: [], execution: null, createdAt: timestamp, updatedAt: timestamp }));
      } else {
        if (!current) fail("human_review_not_found", 404);
        if (closed(current)&&input.action!=="bind_author_publication"&&!(current.status==="cancelled"&&input.action==="bind_execution")) fail("human_review_closed", 409);
        const { contentHash: _hash, ...previous } = current;
        let next = { ...previous, revision: current.revision + 1, updatedAt: timestamp };
        if(input.action==="bind_author_publication"){if(current.kind!=="author"||current.status!=="accepted"||current.decisions.at(-1)?.taskProposalHash!==input.proposalHash||current.authorPublication)fail("human_task_publication_stale",409);if(!authority.publication)fail("human_task_publication_owner_unavailable",422);await authority.publication(context,current,input.dataset,input.proposalHash);next.authorPublication={proposalHash:input.proposalHash,dataset:input.dataset,publishedBy:context.actorId,operationId:input.operationId,publishedAt:timestamp};}
        else if (input.action === "claim") {
          if (current.assigneeId || current.status !== "queued") fail("human_already_claimed", 409);
          await authority.assignee(context, context.actorId, current);
          next = { ...next, assigneeId: context.actorId, status: "assigned", generation: current.generation + 1, audit: [...current.audit, { actorId: context.actorId, action: "claim", priorAssigneeId: current.assigneeId, assigneeId: context.actorId, generation: current.generation + 1, note: "", occurredAt: timestamp }] };
        } else if (input.action === "reserve_execution" || input.action === "bind_execution") {
          if(current.kind!=="execute"||input.generation!==current.generation)fail("human_execution_assignment_stale",409);
          if(input.action==="reserve_execution") {
            if(current.execution)fail("human_execution_already_reserved",409);
            next.execution={executionId:null,operationId:input.runOperationId,boundBy:context.actorId,configurationHash:input.configurationHash,generation:input.generation,result:null};next.status="in_progress";
          } else {
            const prior=current.execution;
            if(!prior||prior.executionId||prior.operationId!==input.runOperationId||prior.configurationHash!==input.configurationHash||(prior.boundBy!==context.actorId&&!(current.status==="cancelled"&&allowed.manager))||prior.generation!==input.generation)fail("human_execution_binding_conflict",409);
            const binding={...prior,executionId:input.executionId};
            if(!authority.execution)fail("human_execution_owner_unavailable",422);
            await authority.execution(context,current,binding);next.execution=binding;
          }
        } else if (input.action === "reassign") {
          if(current.execution&&!current.execution.result)fail("human_execution_transfer_requires_completion",409);
          if (input.assigneeId) await authority.assignee(context, input.assigneeId, current);
          next = { ...next, execution:null, assigneeId: input.assigneeId, generation: current.generation + 1, status: input.assigneeId ? "assigned" : "queued", audit: [...current.audit, { actorId: context.actorId, action: "reassign", priorAssigneeId: current.assigneeId, assigneeId: input.assigneeId, generation: current.generation + 1, note: input.note, occurredAt: timestamp }] };
        } else if (input.action === "cancel") {
          next.status = "cancelled";
          next.audit = [...current.audit, { actorId: context.actorId, action: "cancel", priorAssigneeId: current.assigneeId, assigneeId: current.assigneeId, generation: current.generation, note: input.note, occurredAt: timestamp }];
        } else if (input.action === "save_draft" || input.action === "submit") {
          if(current.kind==="execute"&&!current.execution?.executionId)fail("human_execution_not_bound",409);
          if (input.generation !== current.generation) fail("human_assignment_generation_stale", 409);
          const latestDecision = current.decisions.at(-1);
          const currentSubmission = current.submissions.filter(s => s.actorId === context.actorId && s.generation === current!.generation).at(-1);
          if (currentSubmission && !(latestDecision?.outcome === "request_changes" && latestDecision.submissions.some(s => s.id === currentSubmission.id))) fail("human_submission_already_sealed", 409);
          if(input.taskProposal?.tasks.some(task=>task.expectedOutput!==undefined)&&!allowed.owner)fail("human_reference_edit_owner_required",403);
          if(input.taskProposal||input.action==="submit") {try{assertHumanTaskProposal(current,input.taskProposal);}catch(e){fail(e instanceof Error?e.message:"human_task_proposal_invalid");}}
          answers(current, input.answers, input.action === "submit");
          if (input.action === "save_draft") {
            next.drafts = [...current.drafts.filter(d => d.actorId !== context.actorId), { actorId: context.actorId, generation: current.generation, ...(input.taskProposal?{taskProposal:input.taskProposal}:{}),answers: input.answers, note: input.note, updatedAt: timestamp }];
            next.status = current.status === "returned" ? "returned" : "in_progress";
          } else {
            if(current.kind==="execute") {if(!input.executionResult||!authority.completeExecution)fail("human_execution_result_required",409);await authority.completeExecution(context,current,input.executionResult);next.execution={...current.execution!,result:input.executionResult};}
            if (input.evidenceHash !== contentHash(current.evidence) || input.formHash !== contentHash(current.form)) fail("human_review_snapshot_stale", 409);
            const submission = sealHumanRecord({ ...(input.taskProposal?{taskProposal:input.taskProposal}:{}),id: `submission-${operationKey}`, revision: 1, actorId: context.actorId, generation: current.generation, evidenceHash: input.evidenceHash, formHash: input.formHash, answers: input.answers, note: input.note, submittedAt: timestamp, supersedes: currentSubmission?.id ?? null });
            next.submissions = [...current.submissions, submission];
            next.drafts = current.drafts.filter(d => d.actorId !== context.actorId);
            next.status = current.policy.approval === "none" ? "accepted" : "submitted";
            if (current.policy.approval === "none") next.decisions = [...current.decisions, sealHumanRecord({ id: `decision-${operationKey}`, revision: 1, actorId: context.actorId, outcome: "accept" as const,...(input.taskProposal?{taskProposalHash:input.taskProposal.contentHash}:{}), submissions: [{ id: submission.id, contentHash: submission.contentHash }], answers: input.answers, note: "", decidedAt: timestamp })];
          }
        } else if (input.action === "decide") {
          if (current.policy.approval !== "manager" || current.status !== "submitted") fail("human_decision_not_required", 409);
          const selected = input.submissions.map(ref => current!.submissions.find(s => s.id === ref.id && s.contentHash === ref.contentHash && s.generation === current!.generation && !current!.submissions.some(newer => newer.supersedes === s.id)) ?? fail("human_submission_revision_stale", 409));
          if (current.policy.distinctManager && selected.some(s => s.actorId === context.actorId)) fail("human_distinct_manager_required", 403);
          if (new Set(selected.map(s => s.id)).size !== selected.length) fail("human_duplicate_submission");
          if (input.outcome === "accept" && new Set(selected.map(s => s.actorId)).size < current.policy.minimumRaters) fail("human_more_raters_required", 409);
          if (input.outcome !== "accept" && !input.note.trim()) fail("human_decision_reason_required");
          if(current.kind==="author"&&input.outcome==="accept"&&!selected.some(s=>s.taskProposal?.contentHash===input.taskProposalHash))fail("human_task_proposal_decision_required",409);
          if(current.kind!=="author"&&input.taskProposalHash)fail("human_task_proposal_unexpected");
          answers(current, input.answers, input.outcome === "accept");
          next.decisions = [...current.decisions, sealHumanRecord({...(input.taskProposalHash?{taskProposalHash:input.taskProposalHash}:{}), id: `decision-${operationKey}`, revision: 1, actorId: context.actorId, outcome: input.outcome, submissions: input.submissions, answers: input.answers, note: input.note, decidedAt: timestamp })];
          next.status = input.outcome === "accept" ? "accepted" : input.outcome === "reject" ? "rejected" : "returned";
        }
        current = HumanReviewSchema.parse(sealHumanRecord(next));
      }
      await tx.put(current, input.expectedRevision);
      await tx.saveOperation(operationKey, { requestHash, reviewId: current.id, revision: current.revision });
      return current;
    });
  }
  async function get(context: HumanReviewContext, id: string, revision?: number) {
    return repository.transaction(context.scope, async tx => {
      const current = await tx.get(id);
      if (!current) fail("human_review_not_found", 404);
      await access(context, current);
      const result = revision === undefined ? current : await tx.get(id, revision);
      if (!result) fail("human_review_not_found", 404);
      await authority.evidence(context, result);
      // Historical snapshots retain prior attribution but cannot reinstate earlier access grants.
      return result;
    });
  }
  async function inbox(context: HumanReviewContext, query: Extract<HumanReviewRequest, { endpoint: "inbox" }>) {
    await authority.member(context);
    return repository.transaction(context.scope, async tx => {
      let cursor: string | undefined;
      const permitted: HumanReview[] = [];
      const actionable = new Set<string>();
      let approvalAvailable = false;
      do {
        const page = await tx.list({ projectId: query.projectId, afterId: cursor, limit: 100 });
        for (const record of page.items) {
          let rights;
          try { rights = await access(context, record); } catch (e) { if (e instanceof LearningDomainError && [403, 404].includes(e.status)) continue; throw e; }
          const active = !closed(record);
          const directlyAssigned = record.assigneeId === context.actorId || record.policy.reviewerIds.includes(context.actorId) || rights.owner && record.assigneeId === null && record.createdBy === context.actorId;
          const myWork = directlyAssigned && rights.reviewer && active && !record.submissions.some(s => s.actorId === context.actorId && s.generation === record.generation && record.status !== "returned");
          const approval = rights.manager && record.policy.approval === "manager" && record.status === "submitted";
          if (rights.manager && record.policy.approval === "manager") approvalAvailable = true;
          if (myWork || approval) actionable.add(record.id);
          const match = query.view === "mine" ? directlyAssigned : query.view === "approval" ? rights.manager && record.policy.approval === "manager" : record.policy.teamVisible || rights.manager;
          if (match && (query.status === "active" ? active : !active) && (!query.afterId || record.id > query.afterId)) permitted.push(record);
        }
        cursor = page.nextCursor ?? undefined;
      } while (cursor);
      const items = permitted.slice(0, query.limit);
      return { items, nextCursor: permitted.length > query.limit ? items.at(-1)!.id : null, actionCount: actionable.size, approvalAvailable };
    });
  }
  async function view(context: HumanReviewContext, record: HumanReview) {
    const current = await get(context, record.id);
    const rights = await access(context, current);
    const privileged = rights.owner || rights.manager;
    const blind = !privileged && current.form.mode === "pairwise" && current.policy.blindPair;
    const independent = !privileged && current.policy.independentRaters;
    return { ...record, evidence: blind ? null : record.evidence, evidenceHash: contentHash(record.evidence), formHash: contentHash(record.form),
      drafts: record.drafts.filter(d => d.actorId === context.actorId).map(d=>({...d,taskProposal:rights.owner?d.taskProposal:redactHumanTaskProposal(d.taskProposal)})),
      submissions: (independent ? record.submissions.filter(s => s.actorId === context.actorId) : record.submissions).map(s=>({...s,taskProposal:rights.owner?s.taskProposal:redactHumanTaskProposal(s.taskProposal)})),
      decisions: independent && !closed(current) ? [] : record.decisions,
      audit: privileged ? record.audit : [], createdBy: blind ? "owner" : record.createdBy,
      permissions: { ...rights, claim: current.status === "queued" && current.policy.queueClaim && current.policy.teamVisible && (!current.policy.reviewerIds.length || current.policy.reviewerIds.includes(context.actorId) || rights.owner) },
    };
  }
  return { command, get, inbox, view };
}
