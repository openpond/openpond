import type {
  HarnessRefinerOutcome,
  ImprovementSafeBoundaryKind,
  RefinementTriggerDecision,
  Session,
  Turn,
} from "@openpond/contracts";

import type { SqliteStore } from "../store/store.js";
import {
  DEFAULT_REFINEMENT_TRIGGER_POLICY,
  detectHarnessImprovementAtBoundary,
  type HarnessImprovementDetection,
} from "./improvement-trigger-detector.js";

export async function recordLocalHarnessImprovementBoundary(input: {
  store: SqliteStore;
  session: Session;
  turn: Turn;
  boundaryKind: ImprovementSafeBoundaryKind;
  now?: () => string;
}): Promise<HarnessImprovementDetection | null> {
  const snapshot = input.turn.harnessSnapshot;
  if (!snapshot) return null;
  const workspace = await input.store.getHarnessWorkspace(snapshot.workspaceId);
  if (!workspace || workspace.location !== "local") return null;
  const backgroundReview = await input.store.getHarnessBackgroundReviewSettings(workspace.id);
  if (!backgroundReview.enabled) return null;

  const events = (await input.store.runtimeEventsForSession(input.session.id, {
    limit: 1_000,
  })).filter((runtimeEvent) => runtimeEvent.turnId === input.turn.id);
  const eventSequence = events.reduce(
    (latest, runtimeEvent) => Math.max(latest, runtimeEvent.sequence ?? 0),
    0,
  );
  const priorTriggers = (
    await input.store.listHarnessImprovementArtifacts(
      workspace.id,
      "trigger_decision",
      1_000,
    )
  ).filter(
    (artifact): artifact is RefinementTriggerDecision =>
      artifact.schemaVersion === "openpond.refinementTriggerDecision.v1" &&
      artifact.runRef === input.session.id,
  );
  const outcomes = (
    await input.store.listHarnessImprovementArtifacts(
      workspace.id,
      "refiner_outcome",
      1_000,
    )
  ).filter(
    (artifact): artifact is HarnessRefinerOutcome =>
      artifact.schemaVersion === "openpond.harnessRefinerOutcome.v1",
  );
  const completedTriggerRefs = new Set(
    outcomes.map((outcome) => `${outcome.trigger.id}:${outcome.trigger.contentHash}`),
  );
  const pendingPlanCount = priorTriggers.filter(
    (trigger) =>
      trigger.decision === "queue_refiner" &&
      !completedTriggerRefs.has(`${trigger.id}:${trigger.contentHash}`),
  ).length;
  const latestActionable = priorTriggers.find(
    (trigger) => trigger.decision !== "no_action",
  );
  const cooldownUntil = latestActionable
    ? new Date(
        Date.parse(latestActionable.createdAt) +
          latestActionable.policy.cooldownMs,
      ).toISOString()
    : null;
  const detection = detectHarnessImprovementAtBoundary({
    runRef: input.session.id,
    turnId: input.turn.id,
    harnessRelease: snapshot.harnessRelease,
    overlay: snapshot.overlay,
    events,
    boundary: {
      kind: input.boundaryKind,
      eventSequence,
      occurredAt: (input.now ?? (() => new Date().toISOString()))(),
    },
    policy: DEFAULT_REFINEMENT_TRIGGER_POLICY,
    pendingPlanCount,
    priorDeduplicationKeys: new Set(
      priorTriggers.map((trigger) => trigger.deduplicationKey),
    ),
    cooldownUntil,
    loadedSkillNames: events.flatMap((runtimeEvent) => {
      if (runtimeEvent.name !== "skill.loaded" || runtimeEvent.status !== "completed") {
        return [];
      }
      const data = runtimeEvent.data && typeof runtimeEvent.data === "object"
        ? runtimeEvent.data as Record<string, unknown>
        : {};
      return typeof data.skillName === "string" && data.skillName.trim()
        ? [data.skillName.trim()]
        : [];
    }),
    turnReviewAlreadyQueued: priorTriggers.some(
      (trigger) =>
        trigger.turnId === input.turn.id && trigger.decision === "queue_refiner",
    ),
  });
  for (const observation of detection.observations) {
    await input.store.saveHarnessImprovementArtifact(
      workspace.id,
      "observation",
      observation,
    );
  }
  await input.store.saveHarnessImprovementArtifact(
    workspace.id,
    "trigger_decision",
    detection.trigger,
  );
  return detection;
}
