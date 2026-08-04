import {
  GET_LEARNING_EVIDENCE_CONTRACT_VERSION,
  GetLearningEvidenceToolResultSchema,
  type GetConversationsToolResult,
  type GetLearningEvidenceToolResult,
  type LearningWorkEvidence,
  type LocalContinuousLearningDefinition,
  type LocalContinuousLearningState,
} from "@openpond/contracts";
import {
  classifyWorkEvidence,
  eligibleEvidenceUses,
  toWorkEvidenceAuthoringInput,
  workWorkspaceOpaqueRef,
  type WorkFeedbackReceipt,
} from "@openpond/evals/evidence";

import type { SqliteStore } from "../store/store.js";
import type { StoredWorkEvidenceProjection } from "../store/store-work-evidence.js";

const WORK_EVIDENCE_QUERY_MULTIPLIER = 4;

export async function collectLocalLearningEvidence(input: {
  store: SqliteStore;
  state: LocalContinuousLearningState;
  definition: LocalContinuousLearningDefinition;
  conversations: GetConversationsToolResult;
}): Promise<GetLearningEvidenceToolResult> {
  const projections = await input.store.listWorkEvidenceProjections(
    input.definition.limits.maxConversations * WORK_EVIDENCE_QUERY_MULTIPLIER,
  );
  const cutoff =
    Date.now() - input.definition.limits.lookbackDays * 86_400_000;
  const watermark = watermarkTimestamp(input.conversations.inputWatermark);
  const candidates: Array<{
    projection: StoredWorkEvidenceProjection;
    feedback: WorkFeedbackReceipt[];
  }> = [];
  let workExcluded = 0;
  const workRevoked = 0;

  for (const projection of projections) {
    const receipt = projection.receipt;
    if (!matchesScope(receipt.provenance, input.state)) {
      workExcluded += 1;
      continue;
    }
    if (Date.parse(receipt.timing.completedAt) < cutoff) {
      workExcluded += 1;
      continue;
    }
    if (watermark && Date.parse(receipt.timing.completedAt) <= watermark) {
      workExcluded += 1;
      continue;
    }
    const expiresAt = receipt.provenance.retention.expiresAt;
    if (expiresAt && Date.parse(expiresAt) <= Date.now()) {
      workExcluded += 1;
      continue;
    }
    const feedback = await input.store.listWorkFeedbackForEvidence(receipt);
    candidates.push({
      projection,
      feedback: feedback.map((item) => item.receipt),
    });
  }

  const normalized = candidates
    .map(({ projection, feedback }) =>
      normalizeLocalWorkEvidence(projection, feedback, input.state.scope),
    )
    .sort(compareWorkEvidence);
  const selectedWork = normalized.slice(
    0,
    input.definition.limits.maxConversations,
  );
  workExcluded += normalized.length - selectedWork.length;

  const selectedChat = input.conversations.conversations
    .filter(
      (conversation) => conversation.sourceReference.experience === "chat",
    )
    .map((conversation) => ({
      purpose: "recurrence_context" as const,
      conversation,
    }));
  const selectedOccurrences = [
    ...selectedWork.map((item) => item.sourceReference.occurredAt),
    ...selectedChat.map(
      (item) => item.conversation.sourceReference.occurredAt,
    ),
  ];
  const proposedWatermark = latestOccurrence(selectedOccurrences)
    ?? input.conversations.proposedWatermark;
  const chatSelected = selectedChat.length;
  const chatConsidered = input.conversations.consideredSourceCount;
  const totalSelected = selectedWork.length + chatSelected;

  return GetLearningEvidenceToolResultSchema.parse({
    schemaVersion: GET_LEARNING_EVIDENCE_CONTRACT_VERSION,
    scope: input.state.scope,
    inputWatermark: input.conversations.inputWatermark,
    proposedWatermark,
    lanes: {
      work: {
        counts: {
          considered: projections.length,
          excluded: workExcluded,
          selected: selectedWork.length,
          revoked: workRevoked,
        },
        evidence: selectedWork,
      },
      chat: {
        counts: {
          considered: chatConsidered,
          excluded: Math.max(chatConsidered - chatSelected, 0),
          selected: chatSelected,
          revoked: input.conversations.excludedCounts.revoked,
        },
        evidence: selectedChat,
      },
    },
    emptyReason:
      totalSelected > 0
        ? null
        : input.conversations.emptyReason ?? "no_eligible_sources",
  });
}

export function normalizeLocalWorkEvidence(
  projection: StoredWorkEvidenceProjection,
  feedback: WorkFeedbackReceipt[],
  scope: "personal" | "my_team",
): LearningWorkEvidence {
  const receipt = projection.receipt;
  const eligibility = classifyWorkEvidence({
    evidence: receipt,
    feedback,
    policyState: "active",
    reconstructability: {
      input: true,
      environment: receipt.agentSnapshot !== null,
      verifier: receipt.validationEvidenceRefs.length > 0,
    },
    replay: null,
  });
  const authoringInput = toWorkEvidenceAuthoringInput(receipt, eligibility);
  return {
    sourceReference: {
      referenceId: `work-evidence:${receipt.id}`,
      surface: "desktop",
      scope,
      experience: receipt.source.experience,
      revision: receipt.source.revisionHash,
      occurredAt: receipt.timing.completedAt,
      contentHash: receipt.contentHash,
    },
    authoringInput,
    eligibleUses: eligibleEvidenceUses(eligibility),
    recommendationWeight: recommendationWeight({
      terminalStatus: receipt.terminal.status,
      evalCandidate: authoringInput.evalCandidate,
      validationEvidenceCount: receipt.validationEvidenceRefs.length,
    }),
    terminalStatus: receipt.terminal.status,
    failureClass: receipt.terminal.failureClass,
    outputCount: receipt.outputRefs.length,
    validationEvidenceCount: receipt.validationEvidenceRefs.length,
    feedbackSignal: feedbackSignal(feedback),
    rewardCandidate: false,
  };
}

function matchesScope(
  provenance: StoredWorkEvidenceProjection["receipt"]["provenance"],
  state: LocalContinuousLearningState,
): boolean {
  if (state.scope === "personal") {
    return provenance.ownershipScope === "personal";
  }
  return (
    provenance.ownershipScope === "workspace" &&
    state.workspaceId !== null &&
    provenance.workspaceRef === workWorkspaceOpaqueRef(state.workspaceId)
  );
}

function recommendationWeight(input: {
  terminalStatus: "completed" | "failed" | "cancelled" | "timeout";
  evalCandidate: boolean;
  validationEvidenceCount: number;
}): LearningWorkEvidence["recommendationWeight"] {
  if (input.terminalStatus !== "completed") return "discovery_only";
  if (input.evalCandidate && input.validationEvidenceCount > 0) {
    return "verified_work";
  }
  return "successful_work";
}

function feedbackSignal(
  feedback: WorkFeedbackReceipt[],
): LearningWorkEvidence["feedbackSignal"] {
  const verdicts = new Set(feedback.map((item) => item.verdict));
  if (verdicts.size === 0) return "none";
  if (verdicts.size > 1) return "mixed";
  const verdict = [...verdicts][0];
  return verdict === "not_useful" ? "rejected" : verdict!;
}

function compareWorkEvidence(
  left: LearningWorkEvidence,
  right: LearningWorkEvidence,
): number {
  const rank = {
    verified_work: 0,
    successful_work: 1,
    discovery_only: 2,
  } as const;
  return (
    rank[left.recommendationWeight] - rank[right.recommendationWeight] ||
    right.sourceReference.occurredAt.localeCompare(
      left.sourceReference.occurredAt,
    )
  );
}

function watermarkTimestamp(value: string | null): number | null {
  if (!value) return null;
  const timestamp = Date.parse(value.split("|")[0]!);
  return Number.isFinite(timestamp) ? timestamp : null;
}

function latestOccurrence(values: string[]): string | null {
  return values.reduce<string | null>(
    (latest, value) => (!latest || value > latest ? value : latest),
    null,
  );
}
