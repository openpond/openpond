import {
  HarnessSourceManifestSchema,
  RefinementTriggerDecisionSchema,
  createHarnessImprovementProposal,
  createHarnessRefinerOutcome,
  createImprovementApplyReceipt,
  createImprovementRouteDecision,
  type HarnessAdvanceReceipt,
  type HarnessChangeEffect,
  type HarnessImprovementProposal,
  type HarnessOverlayEdit,
  type HarnessRefinerOutcome,
  type HarnessRunOverlay,
  type HarnessSourceManifest,
  type HarnessTargetedValidationReceipt,
  type HarnessWorkspace,
  type ImprovementObservation,
  type RefinementTriggerDecision,
} from "@openpond/contracts";
import {
  authorLocalHarnessRefinementWithModel,
  HostedHarnessRefinerRequestSchema,
  HostedHarnessRefinerResponseSchema,
  contentHash,
  type HostedHarnessRefinerRequest,
  type HostedHarnessRefinerResponse,
  type LocalHarnessRefinerDecision,
  type LocalHarnessRefinerModelStream,
} from "@openpond/harness";

import type { SqliteStore } from "../store/store.js";
import {
  applyLocalHarnessRefinerProposal,
  validateLocalHarnessRefinerProposal,
} from "./local-harness-refiner.js";
import {
  loadBoundedRefinerContext,
  loadExactObservations,
  readBoundedRefinerSource,
} from "./local-harness-refiner-context.js";
import {
  boundedObservationEvidence,
  boundedTriggerEvidence,
  expectedMemoryRevision,
  findProposal,
  findProposalByTrigger,
  findProposalValidations,
  findRefinerOutcome,
  memoryKeyFromTarget,
  overlayRef,
  proposalEvidence,
  sameOverlayRef,
  sameWorkspaceRevision,
  stableId,
  uniqueEventRefs,
} from "./local-harness-refiner-worker-support.js";

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
  stream?: LocalHarnessRefinerModelStream;
  refine?: (input: {
    request: HostedHarnessRefinerRequest;
    signal: AbortSignal;
  }) => Promise<HostedHarnessRefinerResponse>;
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
  const rebasedOntoCurrent = !sameWorkspaceRevision(workspace, overlay);
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

  const effectiveReleaseRef = rebasedOntoCurrent
    ? workspace.currentChannel.release
    : overlay.baseHarnessRelease;
  if (!effectiveReleaseRef) {
    throw new Error("Queued Refiner trigger references a Harness workspace without a current release.");
  }
  const release = await input.store.getHarnessReleaseRecord(
    effectiveReleaseRef.contentHash,
  );
  if (
    !release ||
    release.harnessRelease.id !== effectiveReleaseRef.id ||
    release.workspaceId !== workspace.id
  ) {
    throw new Error("Queued Refiner trigger references an unavailable effective Harness release.");
  }
  const source = await readBoundedRefinerSource(
    release.bundlePath,
    trigger,
  );
  const memorySource = (await input.store.listHarnessMemories(workspace.id))
    .slice(0, 100)
    .map((entry) => ({
      path: `memory/${entry.key}`,
      kind: "memory" as const,
      content: entry.content,
      loaded: true,
    }));
  source.catalog.push(...memorySource.map(({ path, kind, loaded }) => ({ path, kind, loaded })));
  source.files.push(...memorySource);
  const boundedContext = await loadBoundedRefinerContext(
    input.store,
    trigger,
    observations,
  );
  const refinerEvidence = {
    trigger: boundedTriggerEvidence(trigger),
    observations: observations.map(boundedObservationEvidence),
    task: boundedContext.task,
    eventExcerpts: boundedContext.eventExcerpts,
    artifactDiagnostics: boundedContext.artifactDiagnostics,
    sourceFiles: source.files,
    sourceCatalog: source.catalog,
  };
  let decision: LocalHarnessRefinerDecision;
  if (input.stream) {
    decision = await authorLocalHarnessRefinementWithModel({
      evidence: refinerEvidence,
      stream: input.stream,
      signal: input.signal,
    });
  } else if (input.refine) {
    const request = HostedHarnessRefinerRequestSchema.parse({
      schemaVersion: "openpond.hostedHarnessRefinerRequest.v1",
      requestId: trigger.id,
      idempotencyKey: trigger.contentHash,
      evidenceHash: contentHash(refinerEvidence),
      harness: {
        admittedRelease: overlay.baseHarnessRelease,
        currentRelease: effectiveReleaseRef,
        overlay: overlayRef(overlay),
        workspace: {
          id: workspace.id,
          revision: workspace.revision,
          sourceRevision: workspace.sourceRevision,
          channelRevision: workspace.currentChannel.revision,
        },
        capabilities: {
          memory: true,
          prompt: true,
          skill: true,
          agent: false,
        },
      },
      evidence: refinerEvidence,
    });
    const response = HostedHarnessRefinerResponseSchema.parse(
      await input.refine({ request, signal: input.signal }),
    );
    assertHostedResponseBinding(request, response);
    decision = response.decision;
  } else {
    throw new Error("Harness Refiner requires a public model stream or managed adapter.");
  }
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
  if (decision.decision === "route") {
    return persistExternalRoute({
      store: input.store,
      workspace,
      overlay,
      trigger,
      observations,
      decision,
      now: input.now,
    });
  }
  assertSafeDecision(decision, source.catalog, source.files);
  const materializedContent = materializeDecisionContent(decision, source.files);
  const expectedMemory = decision.route === "memory"
    ? await input.store.getHarnessMemory(workspace.id, memoryKeyFromTarget(decision.target))
    : null;

  const timestamp = (input.now ?? (() => new Date().toISOString()))();
  const effects = classifyProposalEffects(decision);
  const edits = buildProposalEdits({
    trigger,
    decision,
    materializedContent,
    manifest: source.manifest,
    effects,
  });
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
    edits,
    updatedAt: timestamp,
    buildProposal: (frozenOverlay) =>
      createHarnessImprovementProposal({
        schemaVersion: "openpond.harnessImprovementProposal.v1",
        id: proposalId,
        overlay: overlayRef(frozenOverlay),
        baseHarnessRelease: {
          id: release.harnessRelease.id,
          contentHash: release.harnessRelease.contentHash,
        },
        expectedWorkspace: {
          workspaceId: workspace.id,
          revision: workspace.revision,
          sourceRevision: workspace.sourceRevision,
          channelRevision: workspace.currentChannel.revision,
        },
        requestedScope: "personal",
        route: decision.route,
        risk: decision.operation === "delete" || effects.some(
          (effect) => !["text_instruction", "memory", "dependency_selection"].includes(effect),
        )
          ? "review"
          : "low",
        effects,
        evidence,
        edits,
        validationPlan: proposalValidationPlan({
          decision,
          evidence,
          validationId,
          effects,
        }),
        expectedOutcome: decision.expectedOutcome,
        createdAt: timestamp,
        metadata: {
          trigger: { id: trigger.id, contentHash: trigger.contentHash },
          reason: decision.reason,
          generatedManifestEditId:
            edits.find((candidate) => candidate.target === "harness.json")?.id ?? null,
          rebasedFromHarnessRelease: rebasedOntoCurrent
            ? overlay.baseHarnessRelease
            : null,
          expectedMemory: decision.route === "memory"
            ? {
                key: memoryKeyFromTarget(decision.target),
                revision: expectedMemory?.revision ?? null,
                contentHash: expectedMemory?.contentHash ?? null,
                status: expectedMemory?.status ?? null,
              }
            : null,
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

function assertHostedResponseBinding(
  request: HostedHarnessRefinerRequest,
  response: HostedHarnessRefinerResponse,
): void {
  if (
    response.requestId !== request.requestId ||
    response.evidenceHash !== request.evidenceHash ||
    response.admittedRelease.id !== request.harness.admittedRelease.id ||
    response.admittedRelease.contentHash !==
      request.harness.admittedRelease.contentHash ||
    response.currentRelease.id !== request.harness.currentRelease.id ||
    response.currentRelease.contentHash !== request.harness.currentRelease.contentHash
  ) {
    throw new Error("Managed Harness Refiner response binding does not match the request.");
  }
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
  if (input.proposal.route === "memory") {
    return finishMemoryProposal({ ...input, validations, timestamp });
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
    afterOverlay: advanced.receipt.decision === "advanced"
      ? overlayRef(input.overlay)
      : null,
    decision: advanced.receipt.decision === "advanced" ? "applied" : "retained",
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

async function finishMemoryProposal(input: {
  store: SqliteStore;
  workspace: HarnessWorkspace;
  overlay: HarnessRunOverlay;
  trigger: RefinementTriggerDecision;
  proposal: HarnessImprovementProposal;
  observations: ImprovementObservation[];
  validations: HarnessTargetedValidationReceipt[];
  timestamp: string;
}): Promise<LocalHarnessRefinerWorkerResult> {
  const requiredPassed = input.proposal.validationPlan
    .filter((plan) => plan.required)
    .every((plan) => input.validations.some(
      (validation) => validation.validationId === plan.id && validation.status === "passed",
    ));
  const edit = input.proposal.edits.find((candidate) => candidate.route === "memory");
  if (!edit) throw new Error("Memory proposal has no memory edit.");
  const expectedMemory = expectedMemoryRevision(input.proposal, edit.target);
  const canApply = requiredPassed && edit.operation !== "delete";
  if (canApply) {
    await input.store.writeHarnessMemory({
      workspaceId: input.workspace.id,
      key: memoryKeyFromTarget(edit.target),
      content: edit.content,
      expectedRevision: expectedMemory.revision,
      sourceRunId: input.trigger.runRef,
      sourceProposal: { id: input.proposal.id, contentHash: input.proposal.contentHash },
      createdAt: input.timestamp,
    });
  }
  const reason = canApply
    ? "Validated low-risk Personal memory applied at the safe turn boundary."
    : edit.operation === "delete"
      ? "Memory deletion requires explicit review."
      : "Required memory validation did not pass.";
  const route = createImprovementRouteDecision({
    schemaVersion: "openpond.improvementRouteDecision.v1",
    id: stableId("route", input.trigger.contentHash),
    trigger: { id: input.trigger.id, contentHash: input.trigger.contentHash },
    route: "memory",
    authority: "refiner_model",
    automatic: canApply,
    reason,
    createdAt: input.timestamp,
    metadata: { proposalId: input.proposal.id },
  });
  await input.store.saveHarnessImprovementArtifact(input.workspace.id, "route_decision", route);
  const applyReceipt = createImprovementApplyReceipt({
    schemaVersion: "openpond.improvementApplyReceipt.v1",
    id: stableId("apply", input.proposal.contentHash),
    proposal: { id: input.proposal.id, contentHash: input.proposal.contentHash },
    beforeOverlay: input.trigger.overlay!,
    afterOverlay: canApply ? overlayRef(input.overlay) : null,
    decision: canApply ? "applied" : "retained",
    boundary: input.trigger.boundary,
    validationRefs: input.validations.map((validation) => ({ id: validation.id, contentHash: validation.contentHash })),
    outcomeEvidenceRefs: uniqueEventRefs(input.observations),
    rollbackOf: null,
    createdAt: input.timestamp,
    metadata: { externalState: "harness_memory" },
  });
  await input.store.saveHarnessImprovementArtifact(input.workspace.id, "apply_receipt", applyReceipt);
  const outcome = createHarnessRefinerOutcome({
    schemaVersion: "openpond.harnessRefinerOutcome.v1",
    id: stableId("refiner-outcome", input.trigger.contentHash),
    trigger: { id: input.trigger.id, contentHash: input.trigger.contentHash },
    decision: "proposed",
    proposal: { id: input.proposal.id, contentHash: input.proposal.contentHash },
    reason,
    evidenceRefs: input.trigger.observations,
    estimatedCostUsd: input.trigger.estimatedMaxCostUsd,
    createdAt: input.timestamp,
    metadata: { validationStatuses: input.validations.map((validation) => validation.status) },
  });
  await input.store.saveHarnessImprovementArtifact(input.workspace.id, "refiner_outcome", outcome);
  return {
    outcome,
    overlay: input.overlay,
    proposal: input.proposal,
    validations: input.validations,
    workspace: input.workspace,
    advanceReceipt: null,
  };
}

async function persistNoAction(input: {
  store: SqliteStore;
  workspace: HarnessWorkspace;
  overlay: HarnessRunOverlay;
  trigger: RefinementTriggerDecision;
  observations: ImprovementObservation[];
  reason: string;
  metadata?: Record<string, unknown>;
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
    metadata: input.metadata ?? {},
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

async function persistExternalRoute(input: {
  store: SqliteStore;
  workspace: HarnessWorkspace;
  overlay: HarnessRunOverlay;
  trigger: RefinementTriggerDecision;
  observations: ImprovementObservation[];
  decision: Extract<LocalHarnessRefinerDecision, { decision: "route" }>;
  now?: () => string;
}): Promise<LocalHarnessRefinerWorkerResult> {
  const timestamp = (input.now ?? (() => new Date().toISOString()))();
  const route = createImprovementRouteDecision({
    schemaVersion: "openpond.improvementRouteDecision.v1",
    id: stableId("route", input.trigger.contentHash),
    trigger: { id: input.trigger.id, contentHash: input.trigger.contentHash },
    route: input.decision.route,
    authority: "refiner_model",
    automatic: false,
    reason: input.decision.reason,
    createdAt: timestamp,
    metadata: {
      summary: input.decision.summary,
      expectedOutcome: input.decision.expectedOutcome,
    },
  });
  await input.store.saveHarnessImprovementArtifact(
    input.workspace.id,
    "route_decision",
    route,
  );
  return persistNoAction({
    store: input.store,
    workspace: input.workspace,
    overlay: input.overlay,
    trigger: input.trigger,
    observations: input.observations,
    reason: `Routed to ${input.decision.route}: ${input.decision.summary}`,
    metadata: {
      routed: true,
      route: input.decision.route,
      routeDecision: { id: route.id, contentHash: route.contentHash },
      expectedOutcome: input.decision.expectedOutcome,
    },
    now: () => timestamp,
  });
}

function assertSafeDecision(
  decision: Extract<LocalHarnessRefinerDecision, { decision: "propose" }>,
  sourceCatalog: Array<{
    path: string;
    kind: "memory" | "instruction" | "skill" | "agent";
    loaded: boolean;
  }>,
  sourceFiles: Array<{
    path: string;
    kind: "memory" | "instruction" | "skill" | "agent";
    content: string;
    loaded: boolean;
  }>,
): void {
  const expectedKind = decision.route === "memory"
    ? "memory"
    : decision.route === "skill"
    ? "skill"
    : decision.route === "agent"
      ? "agent"
      : "instruction";
  const target = sourceCatalog.find((file) => file.path === decision.target);
  if (decision.operation === "create") {
    if (target) throw new Error(`Refiner create target already exists: ${decision.target}.`);
    if (!safeCreatedComponentPath(decision.route, decision.target)) {
      throw new Error(`Refiner create target is not a safe ${decision.route} component path: ${decision.target}.`);
    }
    return;
  }
  if (!target) throw new Error(`Refiner targeted an unlisted source file: ${decision.target}.`);
  if (target.kind !== expectedKind) {
    throw new Error(`Refiner route ${decision.route} cannot ${decision.operation} ${target.kind} file ${target.path}.`);
  }
  const loaded = sourceFiles.find((file) => file.path === decision.target);
  if (decision.operation === "update" && !loaded) {
    throw new Error(`Refiner update target ${decision.target} exceeded the bounded source budget.`);
  }
}

function materializeDecisionContent(
  decision: Extract<LocalHarnessRefinerDecision, { decision: "propose" }>,
  sourceFiles: Array<{
    path: string;
    kind: "memory" | "instruction" | "skill" | "agent";
    content: string;
    loaded: boolean;
  }>,
): string | null {
  if (decision.operation === "delete") return null;
  if (decision.operation === "create") {
    if (decision.createContent === null) {
      throw new Error("Refiner create proposal is missing bounded component content.");
    }
    return decision.createContent;
  }
  const loaded = sourceFiles.find((file) => file.path === decision.target);
  if (!loaded) {
    throw new Error(`Refiner update target ${decision.target} exceeded the bounded source budget.`);
  }
  if (decision.find === null || decision.replace === null) {
    throw new Error("Refiner update proposal is missing its exact find/replace edit.");
  }
  const occurrences = loaded.content.split(decision.find).length - 1;
  if (occurrences !== 1) {
    throw new Error(
      `Refiner update find text must occur exactly once in ${decision.target}; found ${occurrences}.`,
    );
  }
  const materialized = loaded.content.replace(decision.find, decision.replace);
  if (materialized === loaded.content) {
    throw new Error("Refiner proposal does not change the selected source file.");
  }
  return materialized;
}

function safeCreatedComponentPath(
  route: "memory" | "prompt" | "skill" | "agent",
  target: string,
): boolean {
  const normalized = target.replaceAll("\\", "/");
  if (route === "memory") {
    return /^memory\/[a-z0-9][a-z0-9-]{0,119}$/.test(normalized);
  }
  if (route === "prompt") {
    return /^instructions\/refinements\/[a-z0-9][a-z0-9-]*\.md$/.test(normalized);
  }
  if (route === "skill") {
    return /^skills\/[a-z0-9][a-z0-9-]*\/SKILL\.md$/.test(normalized);
  }
  return /^agents\/[a-z0-9][a-z0-9-]*\/agent\.ts$/.test(normalized);
}

function buildProposalEdits(input: {
  trigger: RefinementTriggerDecision;
  decision: Extract<LocalHarnessRefinerDecision, { decision: "propose" }>;
  materializedContent: string | null;
  manifest: HarnessSourceManifest;
  effects: HarnessChangeEffect[];
}): HarnessOverlayEdit[] {
  const { decision } = input;
  const primary: HarnessOverlayEdit = {
    id: stableId("overlay-edit", {
      trigger: input.trigger.contentHash,
      operation: decision.operation,
      target: decision.target,
      content: input.materializedContent,
    }),
    route: decision.route,
    operation: decision.operation,
    target: decision.target,
    summary: decision.summary,
    content: input.materializedContent,
    contentHash: input.materializedContent === null
      ? null
      : contentHash(input.materializedContent),
    effects: input.effects,
  };
  if (decision.route === "memory") return [primary];
  if (decision.operation === "update") return [primary];

  const existing = input.manifest.files.find((file) => file.path === decision.target);
  const removedIds = new Set<string>();
  const relatedDeletes: HarnessOverlayEdit[] = [];
  let files = input.manifest.files;
  if (decision.operation === "create") {
    const kind = decision.route === "skill"
      ? "skill"
      : decision.route === "agent"
        ? "agent"
        : "instruction";
    files = [
      ...files,
      {
        id: stableId(kind, decision.target),
        kind,
        path: decision.target,
        parentId: null,
        mediaType: decision.route === "agent" ? "text/javascript" : "text/markdown",
        visibility: "policy" as const,
        portability: "portable" as const,
      },
    ];
  } else {
    if (!existing) throw new Error(`Refiner delete target is not declared: ${decision.target}.`);
    removedIds.add(existing.id);
    for (const file of input.manifest.files) {
      if (file.parentId !== existing.id) continue;
      removedIds.add(file.id);
      relatedDeletes.push({
        id: stableId("overlay-edit", {
          trigger: input.trigger.contentHash,
          operation: "delete",
          target: file.path,
        }),
        route: decision.route,
        operation: "delete",
        target: file.path,
        summary: `Remove resource ${file.path} with ${decision.target}.`,
        content: null,
        contentHash: null,
        effects: input.effects,
      });
    }
    files = files.filter((file) => !removedIds.has(file.id));
  }

  const reconciled = HarnessSourceManifestSchema.parse({
    ...input.manifest,
    files,
  });
  const manifestContent = `${JSON.stringify(reconciled, null, 2)}\n`;
  const manifestEdit: HarnessOverlayEdit = {
    id: stableId("overlay-edit", {
      trigger: input.trigger.contentHash,
      operation: "update",
      target: "harness.json",
      content: manifestContent,
    }),
    route: decision.route,
    operation: "update",
    target: "harness.json",
    summary: `${decision.operation === "create" ? "Register" : "Remove"} Harness component ${decision.target}.`,
    content: manifestContent,
    contentHash: contentHash(manifestContent),
    effects: input.effects,
  };
  return [primary, ...relatedDeletes, manifestEdit];
}

function classifyProposalEffects(
  decision: Extract<LocalHarnessRefinerDecision, { decision: "propose" }>,
): HarnessChangeEffect[] {
  if (decision.route === "agent") return ["executable_code"];
  if (decision.route === "memory") return ["memory"];

  const text = [
    decision.summary,
    decision.expectedOutcome,
    decision.createContent ?? "",
    decision.find ?? "",
    decision.replace ?? "",
  ].join("\n");
  const effects = new Set<HarnessChangeEffect>(["text_instruction"]);
  if (/\b(?:margin|markup|revenue|profit|pricing|invoice|quote|job premium|per[- ]truck cost|cost estimate|estimate cost)\b|(?:\$|usd\s*)\d/i.test(text)) {
    effects.add("financial_logic");
  }
  if (/\b(?:business rule|decision rule|eligibility|approval threshold|pricing policy|per[- ]truck governor)\b/i.test(text)) {
    effects.add("business_logic");
  }
  if (/\b(?:permission|access control|credential|secret handling|authorization scope|allowlist)\b/i.test(text)) {
    effects.add("permission");
  }
  if (/\bconnected app\b/i.test(text)) effects.add("connected_app");
  if (/\b(?:publish|publication)\b/i.test(text)) effects.add("publication");
  if (/\bdeploy(?:ment|ed|ing)?\b/i.test(text)) effects.add("deployment");
  if (/\b(?:train(?:ing)?|fine[- ]tun(?:e|ing)|reinforcement learning|\brl\b)\b/i.test(text)) {
    effects.add("training");
  }
  if (/\b(?:model binding|serving model|model selection)\b/i.test(text)) {
    effects.add("model_binding");
  }
  if (/\b(?:team-wide|global harness|all users)\b/i.test(text)) {
    effects.add("team_or_global");
  }
  return [...effects];
}

function proposalValidationPlan(input: {
  decision: Extract<LocalHarnessRefinerDecision, { decision: "propose" }>;
  evidence: ReturnType<typeof proposalEvidence>;
  validationId: string;
  effects: HarnessChangeEffect[];
}) {
  const plans: Array<{
    id: string;
    kind:
      | "observed_recovery"
      | "memory"
      | "prompt"
      | "skill"
      | "package"
      | "component_activation"
      | "business_formula"
      | "targeted_evaluation";
    description: string;
    required: boolean;
  }> = [];
  if (
    input.decision.operation !== "delete" &&
    input.evidence.some((item) => item.kind === "recovery")
  ) {
    plans.push({
      id: `${input.validationId}-observed-recovery`,
      kind: "observed_recovery",
      description: "Verify that the proposal is grounded in the recorded successful recovery.",
      required: true,
    });
  }
  plans.push({
    id: `${input.validationId}-component`,
    kind: input.decision.route === "memory"
      ? "memory"
      : input.decision.route === "skill"
      ? "skill"
      : input.decision.route === "agent"
        ? "package"
        : "prompt",
    description: `Compile and validate the ${input.decision.operation} ${input.decision.route} component ${input.decision.target}.`,
    required: true,
  });
  if (input.decision.route !== "memory") {
    plans.push({
      id: `${input.validationId}-activation`,
      kind: "component_activation",
      description: `Prove the ${input.decision.route} edit is present in the effective Desktop Work runtime surface.`,
      required: true,
    });
  }
  if (input.effects.some((effect) => ["business_logic", "financial_logic"].includes(effect))) {
    plans.push({
      id: `${input.validationId}-business-formula`,
      kind: "business_formula",
      description: "Verify business or financial logic against an approved deterministic fixture before release.",
      required: true,
    });
  }
  if (input.effects.some((effect) => [
    "permission",
    "connected_app",
    "publication",
    "deployment",
    "training",
    "model_binding",
    "team_or_global",
  ].includes(effect))) {
    plans.push({
      id: `${input.validationId}-targeted-evaluation`,
      kind: "targeted_evaluation",
      description: "Run an authority-preserving targeted Evaluation before this sensitive change can release.",
      required: true,
    });
  }
  return plans;
}
