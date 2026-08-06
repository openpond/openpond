import { promises as fs } from "node:fs";
import path from "node:path";

import {
  HarnessSourceManifestSchema,
  ImprovementObservationSchema,
  RefinementTriggerDecisionSchema,
  createHarnessImprovementProposal,
  createHarnessRefinerOutcome,
  createImprovementApplyReceipt,
  createImprovementRouteDecision,
  type HarnessAdvanceReceipt,
  type HarnessImprovementProposal,
  type HarnessRefinerOutcome,
  type HarnessRunOverlay,
  type HarnessTargetedValidationReceipt,
  type HarnessWorkspace,
  type ImprovementObservation,
  type RefinementTriggerDecision,
} from "@openpond/contracts";
import { contentHash } from "@openpond/evals";

import type { SqliteStore } from "../store/store.js";
import {
  authorLocalHarnessRefinementWithModel,
  type LocalHarnessRefinerDecision,
  type LocalHarnessRefinerModelStream,
} from "./local-harness-refiner-model.js";
import {
  applyLocalHarnessRefinerProposal,
  validateLocalHarnessRefinerProposal,
} from "./local-harness-refiner.js";

const MAX_REFINER_SOURCE_BYTES = 60_000;

export type LocalHarnessRefinerWorkerResult = {
  outcome: HarnessRefinerOutcome;
  overlay: HarnessRunOverlay;
  proposal: HarnessImprovementProposal | null;
  validations: HarnessTargetedValidationReceipt[];
  workspace: HarnessWorkspace;
  advanceReceipt: HarnessAdvanceReceipt | null;
};

export async function runLocalHarnessRefinerWorker(input: {
  store: SqliteStore;
  storeDir: string;
  trigger: RefinementTriggerDecision;
  stream: LocalHarnessRefinerModelStream;
  signal: AbortSignal;
  now?: () => string;
}): Promise<LocalHarnessRefinerWorkerResult> {
  const trigger = RefinementTriggerDecisionSchema.parse(input.trigger);
  if (trigger.decision !== "queue_refiner") {
    throw new Error("The model-backed Refiner only accepts queue_refiner decisions.");
  }
  if (!trigger.overlay) {
    throw new Error("A queued Local Harness Refiner decision requires a run overlay.");
  }
  const overlay = await input.store.getHarnessRunOverlay(trigger.runRef);
  if (!overlay || !sameOverlayRef(overlay, trigger.overlay)) {
    throw new Error("Queued Refiner trigger does not match the durable run overlay.");
  }
  const workspace = await input.store.getHarnessWorkspace(
    overlay.workspace.workspaceId,
  );
  if (!workspace || workspace.location !== "local") {
    throw new Error("Local Harness Refiner requires a local Harness workspace.");
  }

  const existingOutcome = await findRefinerOutcome(input.store, workspace.id, trigger);
  if (existingOutcome) {
    const proposal = existingOutcome.proposal
      ? await findProposal(input.store, workspace.id, existingOutcome.proposal.id)
      : null;
    return {
      outcome: existingOutcome,
      overlay: (await input.store.getHarnessRunOverlay(trigger.runRef)) ?? overlay,
      proposal,
      validations: proposal
        ? await findProposalValidations(input.store, workspace.id, proposal)
        : [],
      workspace: (await input.store.getHarnessWorkspace(workspace.id)) ?? workspace,
      advanceReceipt: null,
    };
  }

  const observations = await loadExactObservations(input.store, workspace.id, trigger);
  if (!sameWorkspaceRevision(workspace, overlay)) {
    return persistNoAction({
      store: input.store,
      workspace,
      overlay,
      trigger,
      observations,
      reason:
        "The Personal Harness advanced after this run began. Keep this evidence run-local until an explicit rebase or merge can validate it against the current release.",
      now: input.now,
    });
  }
  if (overlay.status !== "active") {
    const resumed = await findProposalByTrigger(input.store, workspace.id, trigger);
    if (resumed && sameOverlayRef(overlay, resumed.overlay)) {
      return finishPersistedProposal({
        ...input,
        trigger,
        workspace,
        overlay,
        proposal: resumed,
        observations,
      });
    }
    return persistNoAction({
      store: input.store,
      workspace,
      overlay,
      trigger,
      observations,
      reason: `The run overlay is ${overlay.status} and has no recoverable proposal for this trigger.`,
      now: input.now,
    });
  }

  const release = await input.store.getHarnessReleaseRecord(
    overlay.baseHarnessRelease.contentHash,
  );
  if (
    !release ||
    release.harnessRelease.id !== overlay.baseHarnessRelease.id ||
    release.workspaceId !== workspace.id
  ) {
    throw new Error("Queued Refiner trigger references an unavailable base Harness release.");
  }
  const sourceFiles = await readBoundedRefinerSource(
    release.bundlePath,
    loadedSkillNamesFromTrigger(trigger),
  );
  if (sourceFiles.length === 0) {
    return persistNoAction({
      store: input.store,
      workspace,
      overlay,
      trigger,
      observations,
      reason:
        "The evidence turn loaded no editable Skill and this immutable Harness release exposes no general instruction target.",
      now: input.now,
    });
  }
  const boundedContext = await loadBoundedRefinerContext(
    input.store,
    trigger,
    observations,
  );
  const decision = await authorLocalHarnessRefinementWithModel({
    evidence: {
      trigger: boundedTriggerEvidence(trigger),
      observations: observations.map(boundedObservationEvidence),
      task: boundedContext.task,
      eventExcerpts: boundedContext.eventExcerpts,
      sourceFiles,
    },
    stream: input.stream,
    signal: input.signal,
  });
  if (decision.decision === "no_action") {
    return persistNoAction({
      store: input.store,
      workspace,
      overlay,
      trigger,
      observations,
      reason: decision.reason,
      now: input.now,
    });
  }
  assertSafeDecision(decision, sourceFiles);

  const timestamp = (input.now ?? (() => new Date().toISOString()))();
  const edit = {
    id: stableId("overlay-edit", {
      trigger: trigger.contentHash,
      target: decision.target,
      content: decision.replacementContent,
    }),
    route: decision.route,
    operation: "update" as const,
    target: decision.target,
    summary: decision.summary,
    content: decision.replacementContent,
    contentHash: contentHash(decision.replacementContent),
    effects: ["text_instruction" as const],
  };
  const proposalId = stableId("proposal", trigger.contentHash);
  const validationId = stableId("targeted-check", {
    trigger: trigger.contentHash,
    route: decision.route,
    target: decision.target,
  });
  const evidence = proposalEvidence(observations);
  const atomic = await input.store.freezeHarnessRunOverlayWithProposalAtomically({
    runId: trigger.runRef,
    expectedRevision: overlay.revision,
    edits: [edit],
    updatedAt: timestamp,
    buildProposal: (frozenOverlay) =>
      createHarnessImprovementProposal({
        schemaVersion: "openpond.harnessImprovementProposal.v1",
        id: proposalId,
        overlay: overlayRef(frozenOverlay),
        baseHarnessRelease: frozenOverlay.baseHarnessRelease,
        expectedWorkspace: frozenOverlay.workspace,
        requestedScope: "personal",
        route: decision.route,
        risk: "low",
        effects: ["text_instruction"],
        evidence,
        edits: [edit],
        validationPlan: [
          {
            id: validationId,
            kind: decision.route === "skill" ? "skill" : "prompt",
            description: `Compile and validate the updated ${decision.route} file ${decision.target}.`,
            required: true,
          },
        ],
        expectedOutcome: decision.expectedOutcome,
        createdAt: timestamp,
        metadata: {
          trigger: { id: trigger.id, contentHash: trigger.contentHash },
          reason: decision.reason,
        },
      }),
  });
  return finishPersistedProposal({
    ...input,
    trigger,
    workspace,
    overlay: atomic.overlay,
    proposal: atomic.proposal,
    observations,
  });
}

async function loadBoundedRefinerContext(
  store: SqliteStore,
  trigger: RefinementTriggerDecision,
  observations: ImprovementObservation[],
): Promise<{
  task: { prompt: string | null };
  eventExcerpts: Array<Record<string, unknown>>;
}> {
  const [turn, events] = await Promise.all([
    store.getTurn(trigger.turnId),
    store.runtimeEventsForSession(trigger.runRef, { limit: 1_000 }),
  ]);
  const eventRefs = new Map(
    observations.flatMap((observation) =>
      observation.eventRefs.map((reference) => [reference.id, reference] as const),
    ),
  );
  const exactEvents = events.filter((runtimeEvent) => eventRefs.has(runtimeEvent.id));
  for (const [eventId, reference] of eventRefs) {
    const runtimeEvent = exactEvents.find((candidate) => candidate.id === eventId);
    if (!runtimeEvent || contentHash(runtimeEvent) !== reference.contentHash) {
      throw new Error(`Refiner runtime event ${eventId} is unavailable or hash-mismatched.`);
    }
  }
  return {
    task: {
      prompt: turn?.prompt
        ? redactAndBoundRefinerText(turn.prompt, 8_000)
        : null,
    },
    eventExcerpts: exactEvents
      .slice(0, trigger.policy.maxEvidenceEvents)
      .map((runtimeEvent) => {
        const data = asRecord(runtimeEvent.data);
        const result = asRecord(data.result);
        return {
          id: runtimeEvent.id,
          name: runtimeEvent.name,
          action: runtimeEvent.action ?? null,
          status: runtimeEvent.status ?? null,
          error: textField(runtimeEvent.error, 2_000),
          output: textField(result.output, 2_000) ??
            textField(runtimeEvent.output, 2_000),
          exitCode: typeof result.exitCode === "number" ? result.exitCode : null,
          timedOut: result.timedOut === true,
          stderr: textField(result.stderr, 3_000),
          stdout: textField(result.stdout, 3_000),
        };
      }),
  };
}

function textField(value: unknown, maxLength: number): string | null {
  return typeof value === "string"
    ? redactAndBoundRefinerText(value, maxLength)
    : null;
}

function redactAndBoundRefinerText(value: string, maxLength: number): string {
  const redacted = value
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer [redacted]")
    .replace(
      /\b(api[_-]?key|access[_-]?token|auth(?:orization)?|password|secret)(\s*[:=]\s*)([^\s,;]+)/gi,
      "$1$2[redacted]",
    );
  return redacted.length <= maxLength
    ? redacted
    : `${redacted.slice(0, maxLength)}\n[truncated]`;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

async function finishPersistedProposal(input: {
  store: SqliteStore;
  storeDir: string;
  trigger: RefinementTriggerDecision;
  workspace: HarnessWorkspace;
  overlay: HarnessRunOverlay;
  proposal: HarnessImprovementProposal;
  observations: ImprovementObservation[];
  now?: () => string;
}): Promise<LocalHarnessRefinerWorkerResult> {
  const timestamp = (input.now ?? (() => new Date().toISOString()))();
  let validations = await findProposalValidations(
    input.store,
    input.workspace.id,
    input.proposal,
  );
  if (validations.length === 0) {
    validations = await validateLocalHarnessRefinerProposal({
      storeDir: input.storeDir,
      workspace: input.workspace,
      proposal: input.proposal,
      now: () => timestamp,
    });
    for (const validation of validations) {
      await input.store.saveHarnessImprovementArtifact(
        input.workspace.id,
        "targeted_validation",
        validation,
      );
    }
  }
  const advanced = await applyLocalHarnessRefinerProposal({
    store: input.store,
    storeDir: input.storeDir,
    overlay: input.overlay,
    proposal: input.proposal,
    validations,
    receiptId: stableId("harness-advance", input.proposal.contentHash),
    now: () => timestamp,
  });
  const route = createImprovementRouteDecision({
    schemaVersion: "openpond.improvementRouteDecision.v1",
    id: stableId("route", input.trigger.contentHash),
    trigger: { id: input.trigger.id, contentHash: input.trigger.contentHash },
    route: input.proposal.route,
    authority: "refiner_model",
    automatic: advanced.receipt.decision === "advanced",
    reason: advanced.receipt.reason,
    createdAt: timestamp,
    metadata: { proposalId: input.proposal.id },
  });
  await input.store.saveHarnessImprovementArtifact(
    input.workspace.id,
    "route_decision",
    route,
  );
  const applyReceipt = createImprovementApplyReceipt({
    schemaVersion: "openpond.improvementApplyReceipt.v1",
    id: stableId("apply", input.proposal.contentHash),
    proposal: { id: input.proposal.id, contentHash: input.proposal.contentHash },
    beforeOverlay: input.trigger.overlay!,
    afterOverlay: overlayRef(input.overlay),
    decision: "applied",
    boundary: input.trigger.boundary,
    validationRefs: validations.map((validation) => ({
      id: validation.id,
      contentHash: validation.contentHash,
    })),
    outcomeEvidenceRefs: uniqueEventRefs(input.observations),
    rollbackOf: null,
    createdAt: timestamp,
    metadata: { workspaceAdvanceDecision: advanced.receipt.decision },
  });
  await input.store.saveHarnessImprovementArtifact(
    input.workspace.id,
    "apply_receipt",
    applyReceipt,
  );
  const outcome = createHarnessRefinerOutcome({
    schemaVersion: "openpond.harnessRefinerOutcome.v1",
    id: stableId("refiner-outcome", input.trigger.contentHash),
    trigger: { id: input.trigger.id, contentHash: input.trigger.contentHash },
    decision: "proposed",
    proposal: { id: input.proposal.id, contentHash: input.proposal.contentHash },
    reason: advanced.receipt.reason,
    evidenceRefs: input.trigger.observations,
    estimatedCostUsd: input.trigger.estimatedMaxCostUsd,
    createdAt: timestamp,
    metadata: {
      validationStatuses: validations.map((validation) => validation.status),
      workspaceAdvanceReceipt: {
        id: advanced.receipt.id,
        contentHash: advanced.receipt.contentHash,
      },
    },
  });
  await input.store.saveHarnessImprovementArtifact(
    input.workspace.id,
    "refiner_outcome",
    outcome,
  );
  return {
    outcome,
    overlay: input.overlay,
    proposal: input.proposal,
    validations,
    workspace: advanced.workspace,
    advanceReceipt: advanced.receipt,
  };
}

async function persistNoAction(input: {
  store: SqliteStore;
  workspace: HarnessWorkspace;
  overlay: HarnessRunOverlay;
  trigger: RefinementTriggerDecision;
  observations: ImprovementObservation[];
  reason: string;
  now?: () => string;
}): Promise<LocalHarnessRefinerWorkerResult> {
  const timestamp = (input.now ?? (() => new Date().toISOString()))();
  const outcome = createHarnessRefinerOutcome({
    schemaVersion: "openpond.harnessRefinerOutcome.v1",
    id: stableId("refiner-outcome", input.trigger.contentHash),
    trigger: { id: input.trigger.id, contentHash: input.trigger.contentHash },
    decision: "no_action",
    proposal: null,
    reason: input.reason,
    evidenceRefs: input.trigger.observations,
    estimatedCostUsd: input.trigger.estimatedMaxCostUsd,
    createdAt: timestamp,
    metadata: {},
  });
  await input.store.saveHarnessImprovementArtifact(
    input.workspace.id,
    "refiner_outcome",
    outcome,
  );
  return {
    outcome,
    overlay: input.overlay,
    proposal: null,
    validations: [],
    workspace: input.workspace,
    advanceReceipt: null,
  };
}

async function loadExactObservations(
  store: SqliteStore,
  workspaceId: string,
  trigger: RefinementTriggerDecision,
): Promise<ImprovementObservation[]> {
  const available = await store.listHarnessImprovementArtifacts(
    workspaceId,
    "observation",
    1_000,
  );
  const byHash = new Map(
    available.map((artifact) => {
      const observation = ImprovementObservationSchema.parse(artifact);
      return [observation.contentHash, observation] as const;
    }),
  );
  return trigger.observations.map((reference) => {
    const observation = byHash.get(reference.contentHash);
    if (!observation || observation.id !== reference.id) {
      throw new Error(`Refiner observation ${reference.id} is unavailable or hash-mismatched.`);
    }
    return observation;
  });
}

async function readBoundedRefinerSource(
  bundlePath: string,
  loadedSkillNames: ReadonlySet<string>,
) {
  const sourceRoot = path.resolve(bundlePath, "source");
  const manifest = HarnessSourceManifestSchema.parse(
    JSON.parse(await fs.readFile(path.join(sourceRoot, "harness.json"), "utf8")),
  );
  let remaining = MAX_REFINER_SOURCE_BYTES;
  const result: Array<{
    path: string;
    kind: "instruction" | "skill";
    content: string;
  }> = [];
  for (const file of manifest.files) {
    if (
      (file.kind !== "instruction" && file.kind !== "skill") ||
      file.visibility !== "policy" ||
      !["text/markdown", "text/plain"].includes(file.mediaType)
    ) {
      continue;
    }
    if (file.kind === "skill" && !loadedSkillNames.has(skillNameFromPath(file.path))) {
      continue;
    }
    const target = containedSourcePath(sourceRoot, file.path);
    const stats = await fs.lstat(target);
    if (!stats.isFile() || stats.isSymbolicLink()) continue;
    const bytes = await fs.readFile(target);
    if (bytes.byteLength > remaining) continue;
    result.push({ path: file.path, kind: file.kind, content: bytes.toString("utf8") });
    remaining -= bytes.byteLength;
  }
  return result;
}

function loadedSkillNamesFromTrigger(
  trigger: RefinementTriggerDecision,
): ReadonlySet<string> {
  const names = trigger.metadata.loadedSkillNames;
  if (!Array.isArray(names)) return new Set();
  return new Set(
    names.filter((name): name is string => typeof name === "string" && name.trim().length > 0),
  );
}

function skillNameFromPath(sourcePath: string): string {
  const match = /^skills\/([^/]+)\/SKILL\.md$/.exec(sourcePath.replaceAll("\\", "/"));
  return match?.[1] ?? "";
}

function assertSafeDecision(
  decision: Extract<LocalHarnessRefinerDecision, { decision: "propose" }>,
  sourceFiles: Array<{ path: string; kind: "instruction" | "skill"; content: string }>,
): void {
  const target = sourceFiles.find((file) => file.path === decision.target);
  if (!target) throw new Error(`Refiner targeted an unlisted source file: ${decision.target}.`);
  const expectedKind = decision.route === "skill" ? "skill" : "instruction";
  if (target.kind !== expectedKind) {
    throw new Error(`Refiner route ${decision.route} cannot update ${target.kind} file ${target.path}.`);
  }
  if (target.content === decision.replacementContent) {
    throw new Error("Refiner proposal does not change the selected source file.");
  }
}

function boundedTriggerEvidence(trigger: RefinementTriggerDecision): Record<string, unknown> {
  return {
    id: trigger.id,
    runRef: trigger.runRef,
    turnId: trigger.turnId,
    reason: trigger.reason,
    suggestedRoutes: trigger.suggestedRoutes,
    boundary: trigger.boundary,
  };
}

function boundedObservationEvidence(observation: ImprovementObservation): Record<string, unknown> {
  return {
    id: observation.id,
    kind: observation.kind,
    state: observation.state,
    tool: observation.tool?.name ?? null,
    deterministicClass: observation.deterministicClass,
    summary: observation.summary,
  };
}

function proposalEvidence(observations: ImprovementObservation[]) {
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
      : observation.kind === "user_correction"
        ? "user_correction"
        : "tool_event";
  return { kind: kind as "recovery" | "validation" | "user_correction" | "tool_event", id: event.id, contentHash: event.contentHash };
}

function uniqueEventRefs(observations: ImprovementObservation[]) {
  const byId = new Map<string, ImprovementObservation["eventRefs"][number]>();
  for (const observation of observations) {
    for (const event of observation.eventRefs) byId.set(event.id, event);
  }
  return [...byId.values()];
}

async function findRefinerOutcome(
  store: SqliteStore,
  workspaceId: string,
  trigger: RefinementTriggerDecision,
): Promise<HarnessRefinerOutcome | null> {
  const outcomes = await store.listHarnessImprovementArtifacts(
    workspaceId,
    "refiner_outcome",
    1_000,
  );
  return (outcomes as HarnessRefinerOutcome[]).find(
    (outcome) =>
      outcome.trigger.id === trigger.id &&
      outcome.trigger.contentHash === trigger.contentHash,
  ) ?? null;
}

async function findProposal(
  store: SqliteStore,
  workspaceId: string,
  proposalId: string,
): Promise<HarnessImprovementProposal | null> {
  const proposals = await store.listHarnessImprovementArtifacts(
    workspaceId,
    "proposal",
    1_000,
  );
  return (proposals as HarnessImprovementProposal[]).find(
    (proposal) => proposal.id === proposalId,
  ) ?? null;
}

async function findProposalByTrigger(
  store: SqliteStore,
  workspaceId: string,
  trigger: RefinementTriggerDecision,
): Promise<HarnessImprovementProposal | null> {
  const proposal = await findProposal(
    store,
    workspaceId,
    stableId("proposal", trigger.contentHash),
  );
  const metadataTrigger = proposal?.metadata.trigger as
    | { id?: unknown; contentHash?: unknown }
    | undefined;
  return metadataTrigger?.id === trigger.id &&
    metadataTrigger.contentHash === trigger.contentHash
    ? proposal
    : null;
}

async function findProposalValidations(
  store: SqliteStore,
  workspaceId: string,
  proposal: HarnessImprovementProposal,
): Promise<HarnessTargetedValidationReceipt[]> {
  const validations = await store.listHarnessImprovementArtifacts(
    workspaceId,
    "targeted_validation",
    1_000,
  );
  return (validations as HarnessTargetedValidationReceipt[]).filter(
    (validation) =>
      validation.proposal.id === proposal.id &&
      validation.proposal.contentHash === proposal.contentHash,
  );
}

function sameOverlayRef(
  overlay: HarnessRunOverlay,
  reference: { id: string; revision: number; contentHash: string },
): boolean {
  return overlay.id === reference.id &&
    overlay.revision === reference.revision &&
    overlay.contentHash === reference.contentHash;
}

function overlayRef(overlay: HarnessRunOverlay) {
  return {
    id: overlay.id,
    revision: overlay.revision,
    contentHash: overlay.contentHash,
  };
}

function sameWorkspaceRevision(
  workspace: HarnessWorkspace,
  overlay: HarnessRunOverlay,
): boolean {
  return workspace.revision === overlay.workspace.revision &&
    workspace.sourceRevision === overlay.workspace.sourceRevision &&
    workspace.currentChannel.revision === overlay.workspace.channelRevision &&
    workspace.currentChannel.release?.id === overlay.baseHarnessRelease.id &&
    workspace.currentChannel.release.contentHash ===
      overlay.baseHarnessRelease.contentHash;
}

function containedSourcePath(root: string, relativePath: string): string {
  const target = path.resolve(root, ...relativePath.replaceAll("\\", "/").split("/"));
  const relative = path.relative(root, target);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(`Harness source path escapes its immutable bundle: ${relativePath}`);
  }
  return target;
}

function stableId(prefix: string, value: unknown): string {
  return `${prefix}-${contentHash(value).slice(0, 24)}`;
}
