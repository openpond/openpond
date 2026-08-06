import type { ImmutableReleaseRef } from "./release-core.js";
import {
  createHarnessAdvanceReceipt,
  HarnessImprovementProposalSchema,
  HarnessTargetedValidationReceiptSchema,
  HarnessWorkspaceSchema,
  type HarnessAdvanceReceipt,
  type HarnessChangeEffect,
  type HarnessImprovementProposal,
  type HarnessTargetedValidationReceipt,
  type HarnessWorkspace,
} from "./harness-workspaces.js";

const AUTO_ADVANCE_EFFECTS = new Set<HarnessChangeEffect>([
  "text_instruction",
  "memory",
  "dependency_selection",
]);

const AUTO_ADVANCE_ROUTES = new Set([
  "runtime",
  "memory",
  "prompt",
  "skill",
]);

export type HarnessAdvanceAuthority =
  | { eligible: true }
  | { eligible: false; reason: string };

export type HarnessWorkspaceAdvanceResult = {
  workspace: HarnessWorkspace;
  receipt: HarnessAdvanceReceipt;
};

export function classifyHarnessAutoAdvanceAuthority(input: {
  workspace: HarnessWorkspace;
  proposal: HarnessImprovementProposal;
}): HarnessAdvanceAuthority {
  const workspace = HarnessWorkspaceSchema.parse(input.workspace);
  const proposal = HarnessImprovementProposalSchema.parse(input.proposal);

  if (workspace.ownerScope.kind !== "personal") {
    return { eligible: false, reason: "Team workspaces require explicit promotion authority." };
  }
  if (proposal.requestedScope !== "personal") {
    return { eligible: false, reason: `${proposal.requestedScope} changes require explicit promotion authority.` };
  }
  if (proposal.risk !== "low") {
    return { eligible: false, reason: `${proposal.risk} risk changes require review.` };
  }
  if (!AUTO_ADVANCE_ROUTES.has(proposal.route)) {
    return { eligible: false, reason: `${proposal.route} changes cannot auto-advance.` };
  }
  if (proposal.edits.some((edit) => edit.operation === "delete")) {
    return { eligible: false, reason: "Delete edits require review." };
  }
  const structurallyRestricted = proposal.edits
    .map((edit) => edit.target.replaceAll("\\", "/").toLowerCase())
    .filter((target) =>
      target === "harness.json" ||
      target === "program.json" ||
      target.startsWith("agents/") ||
      /\.(?:[cm]?[jt]sx?|py|sh|bash|zsh|fish|ps1|exe|dll|so|dylib)$/.test(target),
    );
  if (structurallyRestricted.length > 0) {
    return {
      eligible: false,
      reason: `Executable or structural targets require review: ${[...new Set(structurallyRestricted)].join(", ")}.`,
    };
  }
  const blocked = proposal.effects.filter((effect) => !AUTO_ADVANCE_EFFECTS.has(effect));
  if (blocked.length > 0) {
    return {
      eligible: false,
      reason: `Effects require review: ${[...new Set(blocked)].join(", ")}.`,
    };
  }
  return { eligible: true };
}

export function advanceHarnessWorkspace(input: {
  receiptId: string;
  workspace: HarnessWorkspace;
  proposal: HarnessImprovementProposal;
  validations: HarnessTargetedValidationReceipt[];
  nextRelease: ImmutableReleaseRef;
  nextSourceRevision: string;
  now: string;
}): HarnessWorkspaceAdvanceResult {
  const workspace = HarnessWorkspaceSchema.parse(input.workspace);
  const proposal = HarnessImprovementProposalSchema.parse(input.proposal);
  const validations = input.validations.map((receipt) =>
    HarnessTargetedValidationReceiptSchema.parse(receipt),
  );
  const proposalRef = { id: proposal.id, contentHash: proposal.contentHash };
  const validationRefs = validations.map((receipt) => ({
    id: receipt.id,
    contentHash: receipt.contentHash,
  }));
  const common = {
    schemaVersion: "openpond.harnessAdvanceReceipt.v1" as const,
    id: input.receiptId,
    workspaceId: workspace.id,
    ownerScope: workspace.ownerScope,
    proposal: proposalRef,
    expectedWorkspaceRevision: proposal.expectedWorkspace.revision,
    observedWorkspaceRevision: workspace.revision,
    previousChannelRevision: workspace.currentChannel.revision,
    previousRelease: workspace.currentChannel.release,
    validationReceipts: validationRefs,
    rollbackOf: null,
    createdAt: input.now,
    metadata: {},
  };

  const conflictReason = workspaceConflictReason(workspace, proposal);
  if (conflictReason) {
    return {
      workspace,
      receipt: createHarnessAdvanceReceipt({
        ...common,
        nextChannelRevision: workspace.currentChannel.revision,
        nextRelease: null,
        decision: "conflict",
        reason: conflictReason,
      }),
    };
  }

  const validationReason = failedValidationReason(proposal, validations);
  if (validationReason) {
    return {
      workspace,
      receipt: createHarnessAdvanceReceipt({
        ...common,
        nextChannelRevision: workspace.currentChannel.revision,
        nextRelease: null,
        decision: "retained",
        reason: validationReason,
      }),
    };
  }

  const authority = classifyHarnessAutoAdvanceAuthority({ workspace, proposal });
  if (!authority.eligible) {
    return {
      workspace,
      receipt: createHarnessAdvanceReceipt({
        ...common,
        nextChannelRevision: workspace.currentChannel.revision,
        nextRelease: null,
        decision: "retained",
        reason: authority.reason,
      }),
    };
  }

  if (
    workspace.currentChannel.release?.id === input.nextRelease.id &&
    workspace.currentChannel.release.contentHash === input.nextRelease.contentHash
  ) {
    return {
      workspace,
      receipt: createHarnessAdvanceReceipt({
        ...common,
        nextChannelRevision: workspace.currentChannel.revision,
        nextRelease: null,
        decision: "retained",
        reason: "The candidate release is already current.",
      }),
    };
  }

  const nextWorkspace = HarnessWorkspaceSchema.parse({
    ...workspace,
    sourceRevision: input.nextSourceRevision,
    revision: workspace.revision + 1,
    dirty: false,
    currentChannel: {
      ...workspace.currentChannel,
      release: input.nextRelease,
      revision: workspace.currentChannel.revision + 1,
    },
    updatedAt: input.now,
  });

  return {
    workspace: nextWorkspace,
    receipt: createHarnessAdvanceReceipt({
      ...common,
      nextChannelRevision: nextWorkspace.currentChannel.revision,
      nextRelease: input.nextRelease,
      decision: "advanced",
      reason: "Validated low-risk Personal proposal advanced atomically.",
    }),
  };
}

export function rollbackHarnessWorkspace(input: {
  receiptId: string;
  workspace: HarnessWorkspace;
  expectedWorkspaceRevision: number;
  expectedChannelRevision: number;
  targetRelease: ImmutableReleaseRef;
  targetSourceRevision: string;
  rollbackOf: ImmutableReleaseRef;
  now: string;
}): HarnessWorkspaceAdvanceResult {
  const workspace = HarnessWorkspaceSchema.parse(input.workspace);
  const conflict =
    workspace.revision !== input.expectedWorkspaceRevision ||
    workspace.currentChannel.revision !== input.expectedChannelRevision;

  const common = {
    schemaVersion: "openpond.harnessAdvanceReceipt.v1" as const,
    id: input.receiptId,
    workspaceId: workspace.id,
    ownerScope: workspace.ownerScope,
    proposal: null,
    expectedWorkspaceRevision: input.expectedWorkspaceRevision,
    observedWorkspaceRevision: workspace.revision,
    previousChannelRevision: workspace.currentChannel.revision,
    previousRelease: workspace.currentChannel.release,
    validationReceipts: [],
    createdAt: input.now,
    metadata: {},
  };

  if (conflict) {
    return {
      workspace,
      receipt: createHarnessAdvanceReceipt({
        ...common,
        nextChannelRevision: workspace.currentChannel.revision,
        nextRelease: null,
        decision: "conflict",
        reason: "Workspace or current-channel revision changed before rollback.",
        rollbackOf: null,
      }),
    };
  }

  const nextWorkspace = HarnessWorkspaceSchema.parse({
    ...workspace,
    sourceRevision: input.targetSourceRevision,
    revision: workspace.revision + 1,
    dirty: false,
    currentChannel: {
      ...workspace.currentChannel,
      release: input.targetRelease,
      revision: workspace.currentChannel.revision + 1,
    },
    updatedAt: input.now,
  });

  return {
    workspace: nextWorkspace,
    receipt: createHarnessAdvanceReceipt({
      ...common,
      nextChannelRevision: nextWorkspace.currentChannel.revision,
      nextRelease: input.targetRelease,
      decision: "rolled_back",
      reason: "Current channel rolled back atomically to an immutable release.",
      rollbackOf: input.rollbackOf,
    }),
  };
}

function workspaceConflictReason(
  workspace: HarnessWorkspace,
  proposal: HarnessImprovementProposal,
): string | null {
  if (proposal.expectedWorkspace.workspaceId !== workspace.id) {
    return "Proposal targets a different Harness workspace.";
  }
  if (proposal.expectedWorkspace.revision !== workspace.revision) {
    return "Harness workspace revision changed before advancement.";
  }
  if (proposal.expectedWorkspace.sourceRevision !== workspace.sourceRevision) {
    return "Harness source revision changed before advancement.";
  }
  if (proposal.expectedWorkspace.channelRevision !== workspace.currentChannel.revision) {
    return "Harness current-channel revision changed before advancement.";
  }
  const current = workspace.currentChannel.release;
  if (
    current === null ||
    current.id !== proposal.baseHarnessRelease.id ||
    current.contentHash !== proposal.baseHarnessRelease.contentHash
  ) {
    return "Proposal base Harness release is not current.";
  }
  return null;
}

function failedValidationReason(
  proposal: HarnessImprovementProposal,
  validations: HarnessTargetedValidationReceipt[],
): string | null {
  const validationById = new Map<string, HarnessTargetedValidationReceipt>();
  for (const receipt of validations) {
    if (
      receipt.proposal.id !== proposal.id ||
      receipt.proposal.contentHash !== proposal.contentHash
    ) {
      return `Validation ${receipt.id} is bound to a different proposal.`;
    }
    validationById.set(receipt.validationId, receipt);
  }

  for (const plan of proposal.validationPlan) {
    if (!plan.required) continue;
    const receipt = validationById.get(plan.id);
    if (!receipt) return `Required validation ${plan.id} is missing.`;
    if (receipt.kind !== plan.kind) {
      return `Validation ${plan.id} has kind ${receipt.kind}; expected ${plan.kind}.`;
    }
    if (receipt.status !== "passed") {
      return `Required validation ${plan.id} did not pass (${receipt.status}).`;
    }
  }
  return null;
}
