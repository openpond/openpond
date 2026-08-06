import {
  advanceHarnessWorkspace,
  classifyHarnessAutoAdvanceAuthority,
  createHarnessImprovementProposal,
  createHarnessOverlayMergeReceipt,
  createHarnessRunOverlay,
  createHarnessTargetedValidationReceipt,
  HarnessOverlayEditSchema,
  HarnessOverlayMergeReceiptSchema,
  HarnessWorkspaceSchema,
  rollbackHarnessWorkspace,
  type HarnessChangeEffect,
  type HarnessImprovementRoute,
  type HarnessWorkspace,
} from "@openpond/contracts";
import { contentHash } from "@openpond/evals";
import { describe, expect, it } from "vitest";

const NOW = "2026-08-05T12:00:00.000Z";
const LATER = "2026-08-05T12:05:00.000Z";
const baseRelease = { id: "harness-before", contentHash: contentHash("before") };
const nextRelease = { id: "harness-after", contentHash: contentHash("after") };

function workspace(kind: "personal" | "team" = "personal"): HarnessWorkspace {
  return HarnessWorkspaceSchema.parse({
    schemaVersion: "openpond.harnessWorkspace.v1",
    id: "workspace-1",
    ownerScope: { kind, id: kind === "personal" ? "person-1" : "team-1" },
    name: "Default Harness",
    location: "local",
    sourceRevision: "source-before",
    revision: 4,
    dirty: false,
    currentChannel: {
      name: kind,
      release: baseRelease,
      revision: 7,
    },
    createdAt: NOW,
    updatedAt: NOW,
    metadata: {},
  });
}

function candidate(input: {
  ownerKind?: "personal" | "team";
  route?: HarnessImprovementRoute;
  risk?: "low" | "review" | "restricted";
  effects?: HarnessChangeEffect[];
} = {}) {
  const current = workspace(input.ownerKind);
  const route = input.route ?? "skill";
  const effects = input.effects ?? ["text_instruction"];
  const editContent = "Use the bundled document dependency before generating DOCX files.";
  const edit = HarnessOverlayEditSchema.parse({
    id: "edit-1",
    route,
    operation: "update",
    target: "skills/documents/SKILL.md",
    summary: "Use the available document runtime before generation.",
    content: editContent,
    contentHash: contentHash(editContent),
    effects,
  });
  const overlay = createHarnessRunOverlay({
    schemaVersion: "openpond.harnessRunOverlay.v1",
    id: "overlay-1",
    runId: "work-1",
    baseHarnessRelease: baseRelease,
    workspace: {
      workspaceId: current.id,
      revision: current.revision,
      sourceRevision: current.sourceRevision,
      channelRevision: current.currentChannel.revision,
    },
    revision: 1,
    status: "frozen",
    edits: [edit],
    createdAt: NOW,
    updatedAt: NOW,
    metadata: {},
  });
  const proposal = createHarnessImprovementProposal({
    schemaVersion: "openpond.harnessImprovementProposal.v1",
    id: "proposal-1",
    overlay: {
      id: overlay.id,
      revision: overlay.revision,
      contentHash: overlay.contentHash,
    },
    baseHarnessRelease: baseRelease,
    expectedWorkspace: overlay.workspace,
    requestedScope: input.ownerKind === "team" ? "team" : "personal",
    route,
    risk: input.risk ?? "low",
    effects,
    evidence: [
      {
        kind: "recovery",
        id: "recovery-1",
        contentHash: contentHash("missing module then recovered"),
      },
    ],
    edits: [edit],
    validationPlan: [
      {
        id: "document-check",
        kind: "file_render",
        description: "Generate and render a bounded document fixture.",
        required: true,
      },
    ],
    expectedOutcome: "Future document work selects the available dependency without a failed import.",
    createdAt: NOW,
    metadata: {},
  });
  const validation = createHarnessTargetedValidationReceipt({
    schemaVersion: "openpond.harnessTargetedValidationReceipt.v1",
    id: "validation-1",
    proposal: { id: proposal.id, contentHash: proposal.contentHash },
    validationId: "document-check",
    kind: "file_render",
    status: "passed",
    summary: "The fixture generated and rendered successfully.",
    evidenceRefs: [
      { kind: "validation", id: "render-1", contentHash: contentHash("render") },
    ],
    createdAt: LATER,
    metadata: {},
  });
  return { current, overlay, proposal, validation };
}

describe("Harness workspace advancement contracts", () => {
  it("atomically advances a validated low-risk Personal proposal", () => {
    const { current, proposal, validation } = candidate();

    const result = advanceHarnessWorkspace({
      receiptId: "advance-1",
      workspace: current,
      proposal,
      validations: [validation],
      nextRelease,
      nextSourceRevision: "source-after",
      now: LATER,
    });

    expect(result.receipt.decision).toBe("advanced");
    expect(result.receipt.previousRelease).toEqual(baseRelease);
    expect(result.receipt.nextRelease).toEqual(nextRelease);
    expect(result.workspace.revision).toBe(5);
    expect(result.workspace.currentChannel.revision).toBe(8);
    expect(result.workspace.currentChannel.release).toEqual(nextRelease);
    expect(result.workspace.sourceRevision).toBe("source-after");
    expect(current.currentChannel.release).toEqual(baseRelease);
  });

  it("fails closed on stale compare-and-swap revisions", () => {
    const { current, proposal, validation } = candidate();
    const advancedElsewhere = HarnessWorkspaceSchema.parse({
      ...current,
      revision: current.revision + 1,
      sourceRevision: "concurrent-source",
      currentChannel: {
        ...current.currentChannel,
        revision: current.currentChannel.revision + 1,
      },
    });

    const result = advanceHarnessWorkspace({
      receiptId: "advance-conflict",
      workspace: advancedElsewhere,
      proposal,
      validations: [validation],
      nextRelease,
      nextSourceRevision: "source-after",
      now: LATER,
    });

    expect(result.receipt.decision).toBe("conflict");
    expect(result.workspace).toEqual(advancedElsewhere);
    expect(result.receipt.nextRelease).toBeNull();
  });

  it.each([
    {
      label: "Team",
      input: { ownerKind: "team" as const },
      reason: "Team workspaces require explicit promotion authority.",
    },
    {
      label: "financial",
      input: { effects: ["financial_logic" as const] },
      reason: "Effects require review: financial_logic.",
    },
    {
      label: "training",
      input: { route: "training" as const, effects: ["training" as const] },
      reason: "training changes cannot auto-advance.",
    },
  ])("retains $label proposals outside Personal low-risk authority", ({ input, reason }) => {
    const { current, proposal, validation } = candidate(input);
    expect(classifyHarnessAutoAdvanceAuthority({ workspace: current, proposal })).toEqual({
      eligible: false,
      reason,
    });

    const result = advanceHarnessWorkspace({
      receiptId: `advance-${input.route ?? input.ownerKind ?? "effect"}`,
      workspace: current,
      proposal,
      validations: [validation],
      nextRelease,
      nextSourceRevision: "source-after",
      now: LATER,
    });

    expect(result.receipt.decision).toBe("retained");
    expect(result.receipt.reason).toBe(reason);
    expect(result.workspace).toEqual(current);
  });

  it("retains a proposal when required targeted validation fails", () => {
    const { current, proposal, validation } = candidate();
    const { contentHash: _validationHash, ...validationContent } = validation;
    const failed = createHarnessTargetedValidationReceipt({
      ...validationContent,
      id: "validation-failed",
      status: "failed",
      summary: "The rendered fixture is invalid.",
    });

    const result = advanceHarnessWorkspace({
      receiptId: "advance-failed-validation",
      workspace: current,
      proposal,
      validations: [failed],
      nextRelease,
      nextSourceRevision: "source-after",
      now: LATER,
    });

    expect(result.receipt.decision).toBe("retained");
    expect(result.receipt.reason).toContain("did not pass (failed)");
    expect(result.workspace).toEqual(current);
  });

  it("rolls the channel back by a new CAS revision without mutating either release", () => {
    const { current, proposal, validation } = candidate();
    const advanced = advanceHarnessWorkspace({
      receiptId: "advance-before-rollback",
      workspace: current,
      proposal,
      validations: [validation],
      nextRelease,
      nextSourceRevision: "source-after",
      now: LATER,
    });

    const rolledBack = rollbackHarnessWorkspace({
      receiptId: "rollback-1",
      workspace: advanced.workspace,
      expectedWorkspaceRevision: advanced.workspace.revision,
      expectedChannelRevision: advanced.workspace.currentChannel.revision,
      targetRelease: baseRelease,
      targetSourceRevision: "source-before-restored",
      rollbackOf: nextRelease,
      now: "2026-08-05T12:10:00.000Z",
    });

    expect(rolledBack.receipt.decision).toBe("rolled_back");
    expect(rolledBack.receipt.rollbackOf).toEqual(nextRelease);
    expect(rolledBack.workspace.currentChannel.release).toEqual(baseRelease);
    expect(rolledBack.workspace.currentChannel.revision).toBe(9);
  });

  it("records merge and conflict outcomes while always requiring revalidation", () => {
    const { overlay } = candidate();
    const ref = { id: overlay.id, revision: overlay.revision, contentHash: overlay.contentHash };
    const other = { id: "overlay-2", revision: 1, contentHash: contentHash("overlay-2") };
    const merged = { id: "overlay-merged", revision: 1, contentHash: contentHash("merged") };

    const mergeReceipt = createHarnessOverlayMergeReceipt({
      schemaVersion: "openpond.harnessOverlayMergeReceipt.v1",
      id: "merge-1",
      workspaceId: "workspace-1",
      baseHarnessRelease: baseRelease,
      leftOverlay: ref,
      rightOverlay: other,
      decision: "merged",
      mergedOverlay: merged,
      conflictTargets: [],
      requiresRevalidation: true,
      createdAt: LATER,
      metadata: {},
    });
    expect(HarnessOverlayMergeReceiptSchema.parse(mergeReceipt).requiresRevalidation).toBe(true);

    const conflictReceipt = createHarnessOverlayMergeReceipt({
      schemaVersion: "openpond.harnessOverlayMergeReceipt.v1",
      id: "merge-conflict",
      workspaceId: "workspace-1",
      baseHarnessRelease: baseRelease,
      leftOverlay: ref,
      rightOverlay: other,
      decision: "conflict",
      mergedOverlay: null,
      conflictTargets: ["skills/documents/SKILL.md"],
      requiresRevalidation: true,
      createdAt: LATER,
      metadata: {},
    });
    expect(conflictReceipt.decision).toBe("conflict");
  });
});
