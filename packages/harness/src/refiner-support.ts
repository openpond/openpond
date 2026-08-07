import { contentHash } from "./common.js";
import type {
  ImprovementObservation,
  RefinementTriggerDecision,
} from "./harness-improvements.js";
import type {
  HarnessImprovementProposal,
  HarnessRunOverlay,
  HarnessWorkspace,
} from "./harness-workspaces.js";

export function memoryKeyFromTarget(target: string): string {
  const match = /^memory\/([a-z0-9][a-z0-9-]{0,119})$/.exec(
    target.replaceAll("\\", "/"),
  );
  if (!match) throw new Error(`Invalid Harness memory target: ${target}.`);
  return match[1]!;
}

export function expectedMemoryRevision(
  proposal: HarnessImprovementProposal,
  target: string,
): {
  revision: number | null;
  contentHash: string | null;
  status: "active" | "deleted" | null;
} {
  const expected = proposal.metadata.expectedMemory;
  if (!expected || typeof expected !== "object" || Array.isArray(expected)) {
    throw new Error("Memory proposal is missing its expected revision snapshot.");
  }
  const record = expected as Record<string, unknown>;
  if (record.key !== memoryKeyFromTarget(target)) {
    throw new Error("Memory proposal expected revision targets a different key.");
  }
  if (record.revision !== null && (!Number.isInteger(record.revision) || Number(record.revision) < 1)) {
    throw new Error("Memory proposal expected revision is invalid.");
  }
  if (record.contentHash !== null && typeof record.contentHash !== "string") {
    throw new Error("Memory proposal expected content hash is invalid.");
  }
  if (record.status !== null && record.status !== "active" && record.status !== "deleted") {
    throw new Error("Memory proposal expected status is invalid.");
  }
  return {
    revision: record.revision as number | null,
    contentHash: record.contentHash as string | null,
    status: record.status as "active" | "deleted" | null,
  };
}

export function boundedTriggerEvidence(
  trigger: RefinementTriggerDecision,
): Record<string, unknown> {
  return {
    id: trigger.id,
    runRef: trigger.runRef,
    turnId: trigger.turnId,
    reason: trigger.reason,
    suggestedRoutes: trigger.suggestedRoutes,
    boundary: trigger.boundary,
  };
}

export function boundedObservationEvidence(
  observation: ImprovementObservation,
): Record<string, unknown> {
  return {
    id: observation.id,
    kind: observation.kind,
    state: observation.state,
    tool: observation.tool?.name ?? null,
    deterministicClass: observation.deterministicClass,
    summary: observation.summary,
  };
}

export function proposalEvidence(observations: ImprovementObservation[]) {
  const byId = new Map<string, ReturnType<typeof observationEvidence>>();
  for (const observation of observations) {
    for (const event of observation.eventRefs) {
      const evidence = observationEvidence(observation, event);
      byId.set(`${evidence.kind}:${evidence.id}`, evidence);
    }
  }
  return [...byId.values()];
}

function observationEvidence(
  observation: ImprovementObservation,
  event: ImprovementObservation["eventRefs"][number],
) {
  const kind = observation.kind === "recovery"
    ? "recovery"
    : observation.kind === "validation"
      ? "validation"
      : observation.kind === "user_turn"
        ? "user_turn"
        : "tool_event";
  return {
    kind: kind as "recovery" | "validation" | "user_turn" | "tool_event",
    id: event.id,
    contentHash: event.contentHash,
  };
}

export function uniqueEventRefs(observations: ImprovementObservation[]) {
  const byId = new Map<string, ImprovementObservation["eventRefs"][number]>();
  for (const observation of observations) {
    for (const event of observation.eventRefs) byId.set(event.id, event);
  }
  return [...byId.values()];
}

export function sameOverlayRef(
  overlay: HarnessRunOverlay,
  reference: { id: string; revision: number; contentHash: string },
): boolean {
  return overlay.id === reference.id &&
    overlay.revision === reference.revision &&
    overlay.contentHash === reference.contentHash;
}

export function overlayRef(overlay: HarnessRunOverlay) {
  return {
    id: overlay.id,
    revision: overlay.revision,
    contentHash: overlay.contentHash,
  };
}

export function sameWorkspaceRevision(
  workspace: HarnessWorkspace,
  overlay: HarnessRunOverlay,
): boolean {
  return workspace.revision === overlay.workspace.revision &&
    workspace.sourceRevision === overlay.workspace.sourceRevision &&
    workspace.currentChannel.revision === overlay.workspace.channelRevision &&
    workspace.currentChannel.release?.id === overlay.baseHarnessRelease.id &&
    workspace.currentChannel.release.contentHash === overlay.baseHarnessRelease.contentHash;
}

export function stableId(prefix: string, value: unknown): string {
  return `${prefix}-${contentHash(value).slice(0, 24)}`;
}
