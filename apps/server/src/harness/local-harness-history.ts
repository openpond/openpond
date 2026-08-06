import {
  createImprovementApplyReceipt,
  type HarnessAdvanceReceipt,
  HarnessHistoryChange,
  HarnessHistoryPayload,
  HarnessHistoryPendingReview,
  HarnessHistoryRoute,
  HarnessImprovementProposal,
  HarnessRefinerOutcome,
  HarnessRollbackRequest,
  HarnessRollbackResponse,
  HarnessProposalReviewRequest,
  HarnessProposalReviewResponse,
  HarnessRunOverlay,
  HarnessTargetedValidationReceipt,
  ImprovementApplyReceipt,
  ImprovementRouteDecision,
  RefinementTriggerDecision,
} from "@openpond/contracts";
import { contentHash } from "@openpond/evals";

import type { SqliteStore } from "../store/store.js";
import {
  DESKTOP_PERSONAL_HARNESS_OWNER_ID,
} from "./local-harness-selection.js";
import {
  applyLocalHarnessRefinerProposal,
  rollbackLocalHarnessWorkspaceRelease,
} from "./local-harness-refiner.js";

export function createLocalHarnessSettingsRoutePayloads(input: {
  store: SqliteStore;
  storeDir: string;
}) {
  return {
    harnessHistoryRoutePayload: () => localHarnessHistoryPayload(input.store),
    rollbackHarnessRoutePayload: (payload: unknown) =>
      rollbackLocalHarnessFromSettings({
        ...input,
        request: parseHarnessRollbackRequest(payload),
      }),
    reviewHarnessProposalRoutePayload: (payload: unknown) =>
      reviewLocalHarnessProposalFromSettings({
        ...input,
        request: parseHarnessProposalReviewRequest(payload),
      }),
  };
}

function parseHarnessRollbackRequest(payload: unknown): HarnessRollbackRequest {
  if (!payload || typeof payload !== "object") {
    throw new Error("Harness rollback requires a workspace and target release.");
  }
  const record = payload as Record<string, unknown>;
  const targetRelease = record.targetRelease;
  if (
    typeof record.workspaceId !== "string" ||
    !targetRelease ||
    typeof targetRelease !== "object"
  ) {
    throw new Error("Harness rollback requires a workspace and target release.");
  }
  const target = targetRelease as Record<string, unknown>;
  if (typeof target.id !== "string" || typeof target.contentHash !== "string") {
    throw new Error("Harness rollback target requires an id and content hash.");
  }
  return {
    workspaceId: record.workspaceId,
    targetRelease: { id: target.id, contentHash: target.contentHash },
  };
}

function parseHarnessProposalReviewRequest(payload: unknown): HarnessProposalReviewRequest {
  if (!payload || typeof payload !== "object") {
    throw new Error("Harness review requires a workspace, proposal, and decision.");
  }
  const record = payload as Record<string, unknown>;
  const proposal = record.proposal;
  if (
    typeof record.workspaceId !== "string" ||
    (record.decision !== "approve" && record.decision !== "decline") ||
    !proposal ||
    typeof proposal !== "object"
  ) {
    throw new Error("Harness review requires a workspace, proposal, and decision.");
  }
  const proposalRef = proposal as Record<string, unknown>;
  if (typeof proposalRef.id !== "string" || typeof proposalRef.contentHash !== "string") {
    throw new Error("Harness proposal review requires an id and content hash.");
  }
  return {
    workspaceId: record.workspaceId,
    proposal: { id: proposalRef.id, contentHash: proposalRef.contentHash },
    decision: record.decision,
  };
}

export async function localHarnessHistoryPayload(
  store: SqliteStore,
): Promise<HarnessHistoryPayload> {
  const workspace = await store.getSelectedHarnessWorkspace({
    ownerKind: "personal",
    ownerId: DESKTOP_PERSONAL_HARNESS_OWNER_ID,
  });
  if (!workspace) {
    return {
      workspace: null,
      releases: [],
      changes: [],
      routes: [],
      pendingReviews: [],
      memories: [],
    };
  }

  const [
    releaseRecords,
    receipts,
    proposals,
    validations,
    routeDecisions,
    applyReceipts,
    outcomes,
    triggers,
  ] = await Promise.all([
    store.listHarnessReleaseRecords(workspace.id),
    store.listHarnessAdvanceReceipts(workspace.id),
    store.listHarnessImprovementArtifacts(workspace.id, "proposal", 1_000),
    store.listHarnessImprovementArtifacts(workspace.id, "targeted_validation", 1_000),
    store.listHarnessImprovementArtifacts(workspace.id, "route_decision", 1_000),
    store.listHarnessImprovementArtifacts(workspace.id, "apply_receipt", 1_000),
    store.listHarnessImprovementArtifacts(workspace.id, "refiner_outcome", 1_000),
    store.listHarnessImprovementArtifacts(workspace.id, "trigger_decision", 1_000),
  ]);
  const typedProposals = proposals as HarnessImprovementProposal[];
  const typedValidations = validations as HarnessTargetedValidationReceipt[];
  const typedRoutes = routeDecisions as ImprovementRouteDecision[];
  const typedApplies = applyReceipts as ImprovementApplyReceipt[];
  const typedOutcomes = outcomes as HarnessRefinerOutcome[];
  const typedTriggers = triggers as RefinementTriggerDecision[];

  const changes: HarnessHistoryChange[] = receipts
    .slice()
    .reverse()
    .map((receipt) => {
      const proposal = receipt.proposal
        ? typedProposals.find((candidate) =>
            candidate.id === receipt.proposal!.id &&
            candidate.contentHash === receipt.proposal!.contentHash,
          ) ?? null
        : null;
      const outcome = proposal
        ? typedOutcomes.find((candidate) =>
            candidate.proposal?.id === proposal.id &&
            candidate.proposal.contentHash === proposal.contentHash,
          ) ?? null
        : null;
      const trigger = outcome
        ? typedTriggers.find((candidate) =>
            candidate.id === outcome.trigger.id &&
            candidate.contentHash === outcome.trigger.contentHash,
          ) ?? null
        : null;
      return {
        receipt,
        proposal,
        validations: proposal
          ? typedValidations.filter((candidate) =>
              candidate.proposal.id === proposal.id &&
              candidate.proposal.contentHash === proposal.contentHash,
            )
          : [],
        routeDecision: proposal
          ? typedRoutes.find((candidate) => candidate.metadata.proposalId === proposal.id) ?? null
          : null,
        applyReceipt: proposal
          ? typedApplies.find((candidate) =>
              candidate.proposal.id === proposal.id &&
              candidate.proposal.contentHash === proposal.contentHash,
            ) ?? null
          : null,
        outcome,
        trigger,
      };
    });

  const proposalRouteIds = new Set(
    changes.flatMap((change) => change.routeDecision ? [change.routeDecision.id] : []),
  );
  const routes: HarnessHistoryRoute[] = typedRoutes
    .filter((decision) => !proposalRouteIds.has(decision.id))
    .map((decision) => {
      const trigger = typedTriggers.find((candidate) =>
        candidate.id === decision.trigger.id &&
        candidate.contentHash === decision.trigger.contentHash,
      ) ?? null;
      const outcome = typedOutcomes.find((candidate) =>
        candidate.trigger.id === decision.trigger.id &&
        candidate.trigger.contentHash === decision.trigger.contentHash,
      ) ?? null;
      return { decision, trigger, outcome };
    });

  const pendingReviews = typedProposals
    .reduce<HarnessHistoryPendingReview[]>((result, proposal) => {
      const proposalApplies = typedApplies
        .filter((candidate) =>
          candidate.proposal.id === proposal.id &&
          candidate.proposal.contentHash === proposal.contentHash,
        )
        .sort((left, right) => right.createdAt.localeCompare(left.createdAt));
      const latestApply = proposalApplies[0] ?? null;
      if (!latestApply || latestApply.decision !== "retained") return result;
      const outcome = typedOutcomes.find((candidate) =>
        candidate.proposal?.id === proposal.id &&
        candidate.proposal.contentHash === proposal.contentHash,
      ) ?? null;
      const trigger = outcome
        ? typedTriggers.find((candidate) =>
            candidate.id === outcome.trigger.id &&
            candidate.contentHash === outcome.trigger.contentHash,
          ) ?? null
        : null;
      result.push({
        proposal,
        validations: typedValidations.filter((candidate) =>
          candidate.proposal.id === proposal.id &&
          candidate.proposal.contentHash === proposal.contentHash,
        ),
        applyReceipt: latestApply,
        outcome,
        trigger,
      });
      return result;
    }, []);

  return {
    workspace,
    releases: releaseRecords.map((record) => ({
      id: record.harnessRelease.id,
      contentHash: record.harnessRelease.contentHash,
      sourceRevision: record.sourceRevision,
      createdAt: record.createdAt,
      current: workspace.currentChannel.release?.contentHash === record.harnessRelease.contentHash,
      files: record.harnessRelease.files.map((file) => ({
        id: file.id,
        path: file.path,
        contentHash: file.contentHash,
        sizeBytes: file.sizeBytes,
        mediaType: file.mediaType,
      })),
    })),
    changes,
    routes,
    pendingReviews,
    memories: await store.listHarnessMemories(workspace.id),
  };
}

export async function rollbackLocalHarnessFromSettings(input: {
  store: SqliteStore;
  storeDir: string;
  request: HarnessRollbackRequest;
}): Promise<HarnessRollbackResponse> {
  const workspace = await input.store.getHarnessWorkspace(input.request.workspaceId);
  if (!workspace?.currentChannel.release) {
    throw new Error("The selected Harness workspace has no current release to roll back.");
  }
  if (workspace.ownerScope.kind !== "personal") {
    throw new Error("Settings rollback currently requires a Personal Harness workspace.");
  }
  const result = await rollbackLocalHarnessWorkspaceRelease({
    store: input.store,
    storeDir: input.storeDir,
    workspaceId: workspace.id,
    targetRelease: input.request.targetRelease,
    rollbackOf: workspace.currentChannel.release,
    receiptId: `rollback-${contentHash({
      workspaceId: workspace.id,
      current: workspace.currentChannel.release,
      target: input.request.targetRelease,
      channelRevision: workspace.currentChannel.revision,
    }).slice(0, 24)}`,
  });
  return {
    receipt: result.receipt,
    history: await localHarnessHistoryPayload(input.store),
  };
}

export async function reviewLocalHarnessProposalFromSettings(input: {
  store: SqliteStore;
  storeDir: string;
  request: HarnessProposalReviewRequest;
}): Promise<HarnessProposalReviewResponse> {
  const workspace = await input.store.getHarnessWorkspace(input.request.workspaceId);
  if (!workspace || workspace.ownerScope.kind !== "personal") {
    throw new Error("Harness proposal review requires the selected Personal workspace.");
  }
  const proposals = await input.store.listHarnessImprovementArtifacts(
    workspace.id,
    "proposal",
    1_000,
  ) as HarnessImprovementProposal[];
  const proposal = proposals.find((candidate) =>
    candidate.id === input.request.proposal.id &&
    candidate.contentHash === input.request.proposal.contentHash,
  );
  if (!proposal) throw new Error("Harness proposal is unavailable or hash-mismatched.");
  const overlays = await input.store.listHarnessImprovementArtifacts(
    workspace.id,
    "run_overlay",
    1_000,
  ) as HarnessRunOverlay[];
  const overlay = overlays.find((candidate) =>
    candidate.id === proposal.overlay.id &&
    candidate.revision === proposal.overlay.revision &&
    candidate.contentHash === proposal.overlay.contentHash,
  );
  if (!overlay) throw new Error("Harness proposal overlay is unavailable or hash-mismatched.");
  const validations = (await input.store.listHarnessImprovementArtifacts(
    workspace.id,
    "targeted_validation",
    1_000,
  ) as HarnessTargetedValidationReceipt[]).filter((candidate) =>
    candidate.proposal.id === proposal.id &&
    candidate.proposal.contentHash === proposal.contentHash,
  );
  const timestamp = new Date().toISOString();
  const priorApplyReceipts = (await input.store.listHarnessImprovementArtifacts(
    workspace.id,
    "apply_receipt",
    1_000,
  ) as ImprovementApplyReceipt[])
    .filter((candidate) =>
      candidate.proposal.id === proposal.id &&
      candidate.proposal.contentHash === proposal.contentHash,
    )
    .sort((left, right) => right.createdAt.localeCompare(left.createdAt));
  if (priorApplyReceipts[0]?.decision !== "retained") {
    throw new Error("Only a currently retained Harness proposal can be reviewed.");
  }
  if (input.request.decision === "decline") {
    const receipt = createImprovementApplyReceipt({
      schemaVersion: "openpond.improvementApplyReceipt.v1",
      id: `review-decline-${contentHash(input.request).slice(0, 24)}`,
      proposal: input.request.proposal,
      beforeOverlay: proposal.overlay,
      afterOverlay: null,
      decision: "declined",
      boundary: { kind: "turn_paused", eventSequence: 0, occurredAt: timestamp },
      validationRefs: validations.map((validation) => ({
        id: validation.id,
        contentHash: validation.contentHash,
      })),
      outcomeEvidenceRefs: [],
      rollbackOf: null,
      createdAt: timestamp,
      metadata: { authority: "human_review", reviewer: "local_user" },
    });
    await input.store.saveHarnessImprovementArtifact(workspace.id, "apply_receipt", receipt);
    return { receipt, history: await localHarnessHistoryPayload(input.store) };
  }
  if (proposal.route === "memory") {
    const requiredPassed = proposal.validationPlan
      .filter((plan) => plan.required)
      .every((plan) => validations.some(
        (validation) => validation.validationId === plan.id && validation.status === "passed",
      ));
    if (!requiredPassed) {
      throw new Error("The memory proposal cannot be approved until required validations pass.");
    }
    const edit = proposal.edits.find((candidate) => candidate.route === "memory");
    if (!edit) throw new Error("The memory proposal has no memory edit.");
    const key = memoryKeyFromTarget(edit.target);
    const existing = await input.store.getHarnessMemory(workspace.id, key);
    await input.store.writeHarnessMemory({
      workspaceId: workspace.id,
      key,
      content: edit.content,
      expectedRevision: edit.operation === "create" ? null : existing?.revision ?? null,
      sourceRunId: null,
      sourceProposal: { id: proposal.id, contentHash: proposal.contentHash },
      createdAt: timestamp,
    });
    const receipt = createImprovementApplyReceipt({
      schemaVersion: "openpond.improvementApplyReceipt.v1",
      id: `review-apply-${proposal.contentHash.slice(0, 24)}`,
      proposal: input.request.proposal,
      beforeOverlay: proposal.overlay,
      afterOverlay: proposal.overlay,
      decision: "applied",
      boundary: { kind: "turn_paused", eventSequence: 0, occurredAt: timestamp },
      validationRefs: validations.map((validation) => ({ id: validation.id, contentHash: validation.contentHash })),
      outcomeEvidenceRefs: [],
      rollbackOf: null,
      createdAt: timestamp,
      metadata: { authority: "human_review", reviewer: "local_user", externalState: "harness_memory" },
    });
    await input.store.saveHarnessImprovementArtifact(workspace.id, "apply_receipt", receipt);
    return { receipt, history: await localHarnessHistoryPayload(input.store) };
  }
  const result = await applyLocalHarnessRefinerProposal({
    store: input.store,
    storeDir: input.storeDir,
    overlay,
    proposal,
    validations,
    receiptId: `review-advance-${proposal.contentHash.slice(0, 24)}`,
    reviewAuthority: { reviewer: "local_user" },
    now: () => timestamp,
  });
  const receipt = createImprovementApplyReceipt({
    schemaVersion: "openpond.improvementApplyReceipt.v1",
    id: `review-apply-${proposal.contentHash.slice(0, 24)}`,
    proposal: input.request.proposal,
    beforeOverlay: proposal.overlay,
    afterOverlay: result.receipt.decision === "advanced" ? proposal.overlay : null,
    decision: result.receipt.decision === "advanced" ? "applied" : "conflict",
    boundary: { kind: "turn_paused", eventSequence: 0, occurredAt: timestamp },
    validationRefs: validations.map((validation) => ({
      id: validation.id,
      contentHash: validation.contentHash,
    })),
    outcomeEvidenceRefs: [],
    rollbackOf: null,
    createdAt: timestamp,
    metadata: {
      authority: "human_review",
      reviewer: "local_user",
      workspaceAdvanceReceipt: {
        id: result.receipt.id,
        contentHash: result.receipt.contentHash,
      },
    },
  });
  await input.store.saveHarnessImprovementArtifact(workspace.id, "apply_receipt", receipt);
  return {
    receipt: result.receipt as HarnessAdvanceReceipt,
    history: await localHarnessHistoryPayload(input.store),
  };
}

function memoryKeyFromTarget(target: string): string {
  const match = /^memory\/([a-z0-9][a-z0-9-]{0,119})$/.exec(target.replaceAll("\\", "/"));
  if (!match) throw new Error(`Invalid Harness memory target: ${target}.`);
  return match[1];
}
