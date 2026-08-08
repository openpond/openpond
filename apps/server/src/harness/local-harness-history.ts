import path from "node:path";

import {
  type HarnessBackgroundReviewRequest,
  type HarnessBackgroundReviewResponse,
  type HarnessEvaluationReviewRequest,
  type HarnessEvaluationReviewResponse,
  type HarnessEvaluationReviewScheduleRequest,
  type HarnessEvaluationReviewScheduleResponse,
  createImprovementApplyReceipt,
  type HarnessAdvanceReceipt,
  HarnessHistoryChange,
  HarnessHistoryPayload,
  HarnessHistoryReleaseRef,
  HarnessHistoryPendingReview,
  HarnessHistoryRoute,
  HarnessImprovementProposal,
  HarnessEvaluationReviewReceipt,
  HarnessRefinerOutcome,
  HarnessRollbackRequest,
  HarnessRollbackResponse,
  HarnessProposalReviewRequest,
  HarnessProposalReviewResponse,
  HarnessReleaseDiffPayload,
  HarnessReleaseDiffRequest,
  HarnessRunOverlay,
  HarnessTargetedValidationReceipt,
  ImprovementApplyReceipt,
  ImprovementRouteDecision,
  RefinementTriggerDecision,
} from "@openpond/contracts";
import type { ModelImprovementQualificationReceipt } from "@openpond/evals";
import { contentHash } from "@openpond/harness";

import type { SqliteStore } from "../store/store.js";
import type { LocalHarnessReleaseRecord } from "../store/store-harness-release-record.js";
import { truncatePatch } from "../workspace-tools/workspace-tool-common.js";
import { runWorkspaceCommand } from "../workspace/workspaces.js";
import {
  DESKTOP_PERSONAL_HARNESS_OWNER_ID,
} from "./local-harness-selection.js";
import {
  applyLocalHarnessRefinerProposal,
  rollbackLocalHarnessWorkspaceRelease,
} from "./local-harness-refiner.js";
import { reviewSelectedLocalHarnessEvaluationFromHost } from "./local-harness-evaluation-review-host.js";
import { nextHarnessEvaluationReviewRunAt } from "./local-harness-evaluation-review-scheduler.js";

export function createLocalHarnessSettingsRoutePayloads(input: {
  store: SqliteStore;
  storeDir: string;
}) {
  return {
    harnessHistoryPayload: () => localHarnessHistoryPayload(input.store),
    updateHarnessBackgroundReviewPayload: (payload: unknown) =>
      updateLocalHarnessBackgroundReviewFromSettings({
        store: input.store,
        request: parseHarnessBackgroundReviewRequest(payload),
      }),
    reviewHarnessEvaluationPayload: (payload: unknown) =>
      reviewLocalHarnessEvaluationFromSettings({
        store: input.store,
        request: parseHarnessEvaluationReviewRequest(payload),
      }),
    updateHarnessEvaluationReviewSchedulePayload: (payload: unknown) =>
      updateLocalHarnessEvaluationReviewScheduleFromSettings({
        store: input.store,
        request: parseHarnessEvaluationReviewScheduleRequest(payload),
      }),
    harnessDiffPayload: (payload: unknown) =>
      localHarnessReleaseDiffPayload({
        ...input,
        request: parseHarnessReleaseDiffRequest(payload),
      }),
    rollbackHarnessPayload: (payload: unknown) =>
      rollbackLocalHarnessFromSettings({
        ...input,
        request: parseHarnessRollbackRequest(payload),
      }),
    reviewHarnessProposalPayload: (payload: unknown) =>
      reviewLocalHarnessProposalFromSettings({
        ...input,
        request: parseHarnessProposalReviewRequest(payload),
      }),
  };
}

function parseHarnessEvaluationReviewRequest(payload: unknown): HarnessEvaluationReviewRequest {
  if (!payload || typeof payload !== "object") {
    throw new Error("Harness evaluation review requires a workspace.");
  }
  const record = payload as Record<string, unknown>;
  if (typeof record.workspaceId !== "string") {
    throw new Error("Harness evaluation review requires a workspace.");
  }
  if (
    record.maxEstimatedCostUsd !== undefined &&
    (typeof record.maxEstimatedCostUsd !== "number" ||
      !Number.isFinite(record.maxEstimatedCostUsd) ||
      record.maxEstimatedCostUsd < 0)
  ) {
    throw new Error("Harness evaluation review cost must be a non-negative number.");
  }
  return {
    workspaceId: record.workspaceId,
    maxEstimatedCostUsd: record.maxEstimatedCostUsd as number | undefined,
  };
}

function parseHarnessEvaluationReviewScheduleRequest(
  payload: unknown,
): HarnessEvaluationReviewScheduleRequest {
  if (!payload || typeof payload !== "object") {
    throw new Error("Harness evaluation review schedule requires a workspace and cadence.");
  }
  const record = payload as Record<string, unknown>;
  if (
    typeof record.workspaceId !== "string" ||
    typeof record.enabled !== "boolean" ||
    (record.cadence !== "manual" && record.cadence !== "daily" && record.cadence !== "weekly") ||
    typeof record.maxEstimatedCostUsd !== "number" ||
    !Number.isFinite(record.maxEstimatedCostUsd) ||
    record.maxEstimatedCostUsd < 0
  ) {
    throw new Error("Harness evaluation review schedule requires a valid workspace, cadence, and cost limit.");
  }
  return {
    workspaceId: record.workspaceId,
    enabled: record.enabled,
    cadence: record.cadence,
    maxEstimatedCostUsd: record.maxEstimatedCostUsd,
  };
}

function parseHarnessBackgroundReviewRequest(payload: unknown): HarnessBackgroundReviewRequest {
  if (!payload || typeof payload !== "object") {
    throw new Error("Harness background review requires a workspace and enabled state.");
  }
  const record = payload as Record<string, unknown>;
  if (typeof record.workspaceId !== "string" || typeof record.enabled !== "boolean") {
    throw new Error("Harness background review requires a workspace and enabled state.");
  }
  return { workspaceId: record.workspaceId, enabled: record.enabled };
}

function parseHarnessReleaseRef(value: unknown, label: string): HarnessHistoryReleaseRef {
  if (!value || typeof value !== "object") {
    throw new Error(`${label} requires an id and content hash.`);
  }
  const record = value as Record<string, unknown>;
  if (typeof record.id !== "string" || typeof record.contentHash !== "string") {
    throw new Error(`${label} requires an id and content hash.`);
  }
  return { id: record.id, contentHash: record.contentHash };
}

function parseHarnessReleaseDiffRequest(payload: unknown): HarnessReleaseDiffRequest {
  if (!payload || typeof payload !== "object") {
    throw new Error("Harness release diff requires a workspace and target release.");
  }
  const record = payload as Record<string, unknown>;
  if (typeof record.workspaceId !== "string") {
    throw new Error("Harness release diff requires a workspace and target release.");
  }
  return {
    workspaceId: record.workspaceId,
    baseRelease: record.baseRelease === null
      ? null
      : parseHarnessReleaseRef(record.baseRelease, "Harness base release"),
    targetRelease: parseHarnessReleaseRef(record.targetRelease, "Harness target release"),
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
      backgroundReview: { enabled: true, updatedAt: null },
      evaluationReviewSchedule: {
        enabled: false,
        cadence: "manual",
        maxEstimatedCostUsd: 0,
        nextRunAt: null,
        lastRunAt: null,
        lastResult: null,
        lastError: null,
        updatedAt: null,
      },
      releases: [],
      changes: [],
      routes: [],
      evaluationReviews: [],
      modelImprovementQualifications: [],
      pendingReviews: [],
      memories: [],
    };
  }

  const [
    backgroundReview,
    evaluationReviewSchedule,
    releaseRecords,
    receipts,
    proposals,
    validations,
    routeDecisions,
    evaluationReviews,
    modelImprovementQualifications,
    applyReceipts,
    outcomes,
    triggers,
  ] = await Promise.all([
    store.getHarnessBackgroundReviewSettings(workspace.id),
    store.getHarnessEvaluationReviewSettings(workspace.id),
    store.listHarnessReleaseRecords(workspace.id),
    store.listHarnessAdvanceReceipts(workspace.id),
    store.listHarnessImprovementArtifacts(workspace.id, "proposal", 1_000),
    store.listHarnessImprovementArtifacts(workspace.id, "targeted_validation", 1_000),
    store.listHarnessImprovementArtifacts(workspace.id, "route_decision", 1_000),
    store.listHarnessImprovementArtifacts(workspace.id, "evaluation_review", 1_000),
    store.listHarnessImprovementArtifacts(workspace.id, "training_qualification", 1_000),
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
    backgroundReview,
    evaluationReviewSchedule,
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
    evaluationReviews: evaluationReviews as HarnessEvaluationReviewReceipt[],
    modelImprovementQualifications: modelImprovementQualifications as ModelImprovementQualificationReceipt[],
    pendingReviews,
    memories: await store.listHarnessMemories(workspace.id),
  };
}

export async function reviewLocalHarnessEvaluationFromSettings(input: {
  store: SqliteStore;
  request: HarnessEvaluationReviewRequest;
}): Promise<HarnessEvaluationReviewResponse> {
  const settings = await input.store.getHarnessEvaluationReviewSettings(input.request.workspaceId);
  const receipt = await reviewSelectedLocalHarnessEvaluationFromHost({
    store: input.store,
    workspaceId: input.request.workspaceId,
    maxEstimatedCostUsd: input.request.maxEstimatedCostUsd ?? settings.maxEstimatedCostUsd,
  });
  const timestamp = new Date().toISOString();
  await input.store.setHarnessEvaluationReviewSettings({
    workspaceId: input.request.workspaceId,
    settings: {
      ...settings,
      lastRunAt: timestamp,
      lastResult: {
        id: receipt.id,
        contentHash: receipt.contentHash,
        classification: receipt.classification,
      },
      lastError: null,
      updatedAt: timestamp,
    },
  });
  return { receipt, history: await localHarnessHistoryPayload(input.store) };
}

export async function updateLocalHarnessEvaluationReviewScheduleFromSettings(input: {
  store: SqliteStore;
  request: HarnessEvaluationReviewScheduleRequest;
}): Promise<HarnessEvaluationReviewScheduleResponse> {
  const workspace = await input.store.getHarnessWorkspace(input.request.workspaceId);
  if (!workspace || workspace.ownerScope.kind !== "personal" || workspace.location !== "local") {
    throw new Error("Evaluation review schedule requires the selected Personal Local Harness.");
  }
  const selected = await input.store.getSelectedHarnessWorkspace({
    ownerKind: "personal",
    ownerId: DESKTOP_PERSONAL_HARNESS_OWNER_ID,
  });
  if (selected?.id !== workspace.id) {
    throw new Error("Evaluation review schedule requires the selected Personal Local Harness.");
  }
  const previous = await input.store.getHarnessEvaluationReviewSettings(workspace.id);
  const timestamp = new Date().toISOString();
  const enabled = input.request.enabled && input.request.cadence !== "manual";
  await input.store.setHarnessEvaluationReviewSettings({
    workspaceId: workspace.id,
    settings: {
      ...previous,
      enabled,
      cadence: input.request.cadence,
      maxEstimatedCostUsd: input.request.maxEstimatedCostUsd,
      nextRunAt: enabled
        ? nextHarnessEvaluationReviewRunAt(input.request.cadence, timestamp)
        : null,
      lastError: null,
      updatedAt: timestamp,
    },
  });
  return { history: await localHarnessHistoryPayload(input.store) };
}

export async function updateLocalHarnessBackgroundReviewFromSettings(input: {
  store: SqliteStore;
  request: HarnessBackgroundReviewRequest;
}): Promise<HarnessBackgroundReviewResponse> {
  const workspace = await input.store.getHarnessWorkspace(input.request.workspaceId);
  if (!workspace || workspace.ownerScope.kind !== "personal" || workspace.location !== "local") {
    throw new Error("Background review settings require the selected Personal Local Harness.");
  }
  await input.store.setHarnessBackgroundReviewSettings({
    workspaceId: workspace.id,
    enabled: input.request.enabled,
    updatedAt: new Date().toISOString(),
  });
  return { history: await localHarnessHistoryPayload(input.store) };
}

async function requireHarnessReleaseRecord(input: {
  store: SqliteStore;
  workspaceId: string;
  release: HarnessHistoryReleaseRef;
  label: string;
}): Promise<LocalHarnessReleaseRecord> {
  const record = await input.store.getHarnessReleaseRecord(input.release.contentHash);
  if (
    !record ||
    record.workspaceId !== input.workspaceId ||
    record.harnessRelease.id !== input.release.id ||
    record.harnessRelease.contentHash !== input.release.contentHash
  ) {
    throw new Error(`${input.label} is unavailable or hash-mismatched.`);
  }
  return record;
}

function releaseSourcePath(record: LocalHarnessReleaseRecord, filePath: string): string {
  const sourceRoot = path.resolve(record.bundlePath, "source");
  const target = path.resolve(sourceRoot, ...filePath.split("/"));
  if (target !== sourceRoot && !target.startsWith(`${sourceRoot}${path.sep}`)) {
    throw new Error(`Harness release contains an unsafe file path: ${filePath}.`);
  }
  return target;
}

function normalizeHarnessPatch(input: {
  patch: string;
  filePath: string;
  baseExists: boolean;
  targetExists: boolean;
}): string {
  return input.patch
    .split("\n")
    .map((line) => {
      if (line.startsWith("diff --git ")) {
        return `diff --git a/${input.filePath} b/${input.filePath}`;
      }
      if (line.startsWith("--- ")) {
        return input.baseExists ? `--- a/${input.filePath}` : "--- /dev/null";
      }
      if (line.startsWith("+++ ")) {
        return input.targetExists ? `+++ b/${input.filePath}` : "+++ /dev/null";
      }
      return line;
    })
    .join("\n");
}

function countHarnessPatchLines(patch: string): { additions: number; deletions: number } {
  let additions = 0;
  let deletions = 0;
  for (const line of patch.split("\n")) {
    if (line.startsWith("+++") || line.startsWith("---")) continue;
    if (line.startsWith("+")) additions += 1;
    if (line.startsWith("-")) deletions += 1;
  }
  return { additions, deletions };
}

export async function localHarnessReleaseDiffPayload(input: {
  store: SqliteStore;
  storeDir: string;
  request: HarnessReleaseDiffRequest;
}): Promise<HarnessReleaseDiffPayload> {
  const workspace = await input.store.getHarnessWorkspace(input.request.workspaceId);
  if (!workspace || workspace.ownerScope.kind !== "personal") {
    throw new Error("Harness release diff requires the selected Personal workspace.");
  }
  const target = await requireHarnessReleaseRecord({
    store: input.store,
    workspaceId: workspace.id,
    release: input.request.targetRelease,
    label: "Harness target release",
  });
  const base = input.request.baseRelease
    ? await requireHarnessReleaseRecord({
        store: input.store,
        workspaceId: workspace.id,
        release: input.request.baseRelease,
        label: "Harness base release",
      })
    : null;
  const baseFiles = new Set(base?.harnessRelease.files.map((file) => file.path) ?? []);
  const targetFiles = new Set(target.harnessRelease.files.map((file) => file.path));
  const filePaths = [...new Set([...baseFiles, ...targetFiles])]
    .sort((left, right) => left.localeCompare(right));
  const files: HarnessReleaseDiffPayload["files"] = [];

  for (const filePath of filePaths) {
    const baseExists = baseFiles.has(filePath);
    const targetExists = targetFiles.has(filePath);
    const oldPath = base && baseExists ? releaseSourcePath(base, filePath) : "/dev/null";
    const newPath = targetExists ? releaseSourcePath(target, filePath) : "/dev/null";
    const result = await runWorkspaceCommand(
      "git",
      ["diff", "--no-index", "--no-ext-diff", "--unified=80", "--", oldPath, newPath],
      input.storeDir,
    );
    if (result.code !== 0 && result.code !== 1) {
      throw new Error(result.stderr.trim() || result.stdout.trim() || `Unable to diff ${filePath}.`);
    }
    if (result.code === 0) continue;
    const patch = truncatePatch(normalizeHarnessPatch({
      patch: result.stdout || result.stderr,
      filePath,
      baseExists,
      targetExists,
    }));
    const counts = countHarnessPatchLines(patch);
    files.push({
      path: filePath,
      status: baseExists ? targetExists ? "modified" : "deleted" : "added",
      additions: counts.additions,
      deletions: counts.deletions,
      patch,
      content: null,
    });
  }

  return {
    baseRelease: input.request.baseRelease,
    targetRelease: input.request.targetRelease,
    filesChanged: files.length,
    additions: files.reduce((sum, file) => sum + file.additions, 0),
    deletions: files.reduce((sum, file) => sum + file.deletions, 0),
    files,
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
    await input.store.writeHarnessMemory({
      workspaceId: workspace.id,
      key,
      content: edit.content,
      expectedRevision: expectedMemoryRevision(proposal, key),
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

function expectedMemoryRevision(
  proposal: HarnessImprovementProposal,
  key: string,
): number | null {
  const expected = proposal.metadata.expectedMemory;
  if (!expected || typeof expected !== "object" || Array.isArray(expected)) {
    throw new Error("Memory proposal is missing its expected revision snapshot.");
  }
  const record = expected as Record<string, unknown>;
  if (record.key !== key) {
    throw new Error("Memory proposal expected revision targets a different key.");
  }
  if (record.revision === null) return null;
  if (!Number.isInteger(record.revision) || Number(record.revision) < 1) {
    throw new Error("Memory proposal expected revision is invalid.");
  }
  return Number(record.revision);
}
