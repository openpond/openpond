import { randomUUID } from "node:crypto";
import path from "node:path";
import { loadOpenPondProfileState } from "@openpond/cloud";
import {
  TASK_AUTHORING_MAX_DISCLOSED_EVIDENCE_TOKENS,
  conciseWorkproductName,
  TaskCreationRequestSchema,
  TaskCreationSnapshotSchema,
  TaskDesignProposalSchema,
  TasksetSchema,
  TrainingSourceRefSchema,
  TrainingSourceEstimateSchema,
  type ChatModelRef,
  type CodexReasoningEffort,
  type RuntimeEvent,
  type TaskCreationMode,
  type NewModelMode,
  type TaskCreationRequest,
  type TaskCreationSnapshot,
  type TaskCreationSurface,
  type AuthoringRepair,
  type BaseModelPreference,
  type TaskDataRecord,
  type TaskDesignProposal,
  type Taskset,
  type TrainingSourceRef,
  type TrainingSourceEstimate,
  type Session,
  type Turn,
} from "@openpond/contracts";
import { buildTaskset, computeTasksetHash, contentHash } from "@openpond/taskset-sdk";
import type { SqliteStore } from "../store/store.js";
import { now } from "../utils.js";
import { scanAndRedactEvidence } from "./privacy.js";
import type { TaskAuthoringEvidence } from "./task-authoring-model.js";
import {
  crossSystemExampleMetadata,
  crossSystemGroundTruth,
  crossSystemStructuredExample,
  crossSystemTasksetMetadata,
  enrichCrossSystemProposal,
} from "./task-creator-cross-system.js";
import { defaultFixtureTemplates } from "./task-creator-fixtures.js";

export { crossSystemStructuredExample, enrichCrossSystemProposal };

export type TaskProposalAuthor = (input: {
  id: string;
  model: ChatModelRef;
  reasoningEffort: CodexReasoningEffort | null;
  evidence: TaskAuthoringEvidence[];
  methodHint?: TaskCreationRequest["methodHint"];
  instruction?: string | null;
  currentProposal?: TaskDesignProposal | null;
  signal: AbortSignal;
}) => Promise<TaskDesignProposal | { proposal: TaskDesignProposal; repairHistory: AuthoringRepair[] }>;

export function createTaskCreatorService(deps: {
  store: SqliteStore;
  tasksetRootDir?: string | null;
  authorProposal?: TaskProposalAuthor | null;
  authoringSkillHash: string;
  loadProfileState?: typeof loadOpenPondProfileState;
  loadCodexHistoryThread?: ((sessionId: string) => Promise<{ session: Session; events: RuntimeEvent[] }>) | null;
}) {
  async function reconcileInterruptedCreations(): Promise<void> {
    const profile = await (deps.loadProfileState ?? loadOpenPondProfileState)();
    const profileId = profile.activeProfile ?? "default";
    const snapshots = await deps.store.listTaskCreationSnapshots(profileId);
    for (const snapshot of snapshots) {
      if (!(["planning", "materializing", "validating"] as const).includes(snapshot.state as "planning" | "materializing" | "validating")) continue;
      if ((snapshot.state === "materializing" || snapshot.state === "validating") && snapshot.proposal) {
        const tasksetId = safeTasksetId(snapshot.proposal.name, snapshot.id);
        if (await deps.store.getTaskset(tasksetId)) {
          await persist({
            ...snapshot,
            state: "ready",
            materializedTasksetId: tasksetId,
            blockedReason: null,
            updatedAt: now(),
          });
          continue;
        }
      }
      const timestamp = now();
      await persist({
        ...snapshot,
        state: "failed",
        blockedReason: "OpenPond restarted during Taskset authoring. The reviewed evidence and proposal were preserved; start authoring again to continue.",
        transcript: [...snapshot.transcript, {
          id: `task_message_${randomUUID()}`,
          role: "assistant",
          text: "Taskset authoring stopped when OpenPond restarted. The reviewed evidence and any completed proposal were preserved.",
          createdAt: timestamp,
        }],
        updatedAt: timestamp,
      });
    }
  }

  async function addSessionSource(input: {
    profileId: string;
    sessionId: string;
    turnIds?: string[];
    consentScope?: "selected_turns" | "full_session";
  }): Promise<TrainingSourceRef> {
    const loaded = await loadSessionEvidence(deps, input.sessionId, input.turnIds);
    const { session, evidence, turnIds } = loaded;
    if (turnIds.length === 0) throw new Error("No completed turns were selected.");
    const scan = scanAndRedactEvidence(evidence.map((item) => item.text).join("\n"));
    const occurredAt = loaded.occurredAt;
    const estimate = estimateForEvidence(input.sessionId, evidence);
    const timestamp = now();
    const source = TrainingSourceRefSchema.parse({
      schemaVersion: "openpond.trainingSource.v1",
      id: `training_source_${randomUUID()}`,
      profileId: input.profileId,
      sessionId: input.sessionId,
      turnIds,
      workspaceId: session.workspaceId ?? null,
      sourceHash: contentHash({ session: { id: session.id, title: session.title.trim() }, evidence }),
      clusterKey: `session_${session.id}`,
      title: session.title,
      occurredAt,
      consent: { status: "granted", scope: input.consentScope ?? (input.turnIds?.length ? "selected_turns" : "full_session"), grantedBy: "local_user", grantedAt: timestamp, purpose: "task_authoring_and_evaluation" },
      connectedAppIds: session.appId ? [session.appId] : [],
      secretScanStatus: scan.secretStatus,
      piiScanStatus: scan.piiStatus,
      licensingStatus: session.appId ? "review" : "approved",
      metadata: {
        privacyFindings: scan.findings,
        evidenceCount: evidence.length,
        messageCount: estimate.messageCount,
        estimatedTokens: estimate.estimatedTokens,
        textBytes: estimate.textBytes,
        workflowSignature: workflowSignatureForEvidence(session.title, evidence),
        licensingBasis: session.appId ? "connected_app_review_required" : "local_user_selected_chat",
      },
    });
    const existing = await deps.store.getTrainingSourceForSession({
      profileId: input.profileId,
      sessionId: source.sessionId,
      sourceHash: source.sourceHash,
    });
    if (existing) return existing;
    return deps.store.upsertTrainingSource(source);
  }

  async function estimateSessionSources(sessionIds: string[]): Promise<TrainingSourceEstimate[]> {
    const estimates: TrainingSourceEstimate[] = [];
    for (const sessionId of [...new Set(sessionIds)]) {
      const loaded = await loadSessionEvidence(deps, sessionId);
      estimates.push(estimateForEvidence(sessionId, loaded.evidence));
    }
    return estimates;
  }

  async function start(input: {
    profileId: string;
    sourceIds: string[];
    surface: TaskCreationSurface;
    mode: TaskCreationMode;
    entryMode?: NewModelMode;
    resourceIntent?: TaskCreationRequest["resourceIntent"];
    objective?: string | null;
    methodHint?: TaskCreationRequest["methodHint"];
    preferredBaseModelId?: string | null;
    preferredBaseModel?: BaseModelPreference | null;
    candidateId?: string | null;
    analysisModel?: ChatModelRef | null;
    analysisReasoningEffort?: CodexReasoningEffort | null;
    createImproveRunId?: string | null;
    targetIntent?: TaskCreationRequest["targetIntent"];
  }): Promise<TaskCreationSnapshot> {
    const sources = await requireSources(input.profileId, input.sourceIds);
    assertSourcesEligible(sources);
    const timestamp = now();
    const disclosureApprovalId = input.analysisModel && sources.length ? `task_disclosure_${randomUUID()}` : null;
    const request = TaskCreationRequestSchema.parse({
      schemaVersion: "openpond.taskCreationRequest.v1",
      id: `task_creation_request_${randomUUID()}`,
      profileId: input.profileId,
      surface: input.surface,
      mode: input.mode,
      entryMode: input.entryMode ?? (input.surface === "task_candidate" ? "automated" : "manual"),
      resourceIntent: input.resourceIntent ?? "workproduct",
      objective: input.objective?.trim() || null,
      methodHint: input.methodHint ?? null,
      preferredBaseModelId: input.preferredBaseModelId ?? null,
      preferredBaseModel: input.preferredBaseModel ?? null,
      sourceIds: input.sourceIds,
      candidateId: input.candidateId ?? null,
      analysisModel: input.analysisModel ?? null,
      analysisReasoningEffort: input.analysisReasoningEffort ?? null,
      createImproveRunId: input.createImproveRunId ?? null,
      targetIntent: input.targetIntent ?? {
        kind: "model",
        id: null,
        displayName: null,
        operation: "create",
      },
      disclosure: {
        status: disclosureApprovalId ? "pending" : "not_required",
        content: "raw_excerpts",
        sourceIds: input.sourceIds,
        providerModel: input.analysisModel ?? null,
        approvalId: disclosureApprovalId,
        approvedAt: null,
      },
      createdAt: timestamp,
    });
    const needsDisclosure = request.disclosure.status === "pending";
    const blockingQuestions = [
      ...(!request.objective && request.mode === "customize" ? [{ id: `task_question_${randomUUID()}`, kind: "objective" as const, prompt: "What repeatable capability should this Taskset teach or evaluate?", answer: null }] : []),
      ...(!sources.length ? [{ id: `task_question_${randomUUID()}`, kind: "success_signal" as const, prompt: "Add at least one successful example, correction, reviewer choice, or outcome-bearing run so the authoring model can ground this capability without fabricating demonstrations.", answer: null }] : []),
    ];
    const initialState = blockingQuestions.length ? "awaiting_questions" : needsDisclosure ? "awaiting_disclosure_approval" : "planning";
    let snapshot = TaskCreationSnapshotSchema.parse({
      schemaVersion: "openpond.taskCreationSnapshot.v1",
      id: `task_creation_${randomUUID()}`,
      request,
      state: initialState,
      proposal: null,
      materializedTasksetId: null,
      disclosureApprovalId,
      materializationApprovalId: null,
      blockingQuestions,
      transcript: [{ id: `task_message_${randomUUID()}`, role: "user", text: request.objective ?? "Create a Taskset from the selected conversations.", createdAt: timestamp }],
      blockedReason: null,
      createdAt: timestamp,
      updatedAt: timestamp,
    });
    if (initialState === "planning") snapshot = await plan(snapshot, sources, new AbortController().signal);
    await deps.store.upsertTaskCreationSnapshot(snapshot);
    return snapshot;
  }

  async function approveDisclosure(id: string, approved: boolean, signal = new AbortController().signal): Promise<TaskCreationSnapshot> {
    const snapshot = await requireSnapshot(id);
    if (snapshot.state !== "awaiting_disclosure_approval") throw new Error("Task creation is not awaiting disclosure approval.");
    if (!approved) return persist({ ...snapshot, request: { ...snapshot.request, disclosure: { ...snapshot.request.disclosure, status: "declined" } }, state: "cancelled", blockedReason: "Hosted evidence disclosure was declined.", updatedAt: now() });
    const sources = await requireSources(snapshot.request.profileId, snapshot.request.sourceIds);
    const approvedAt = now();
    const planning = await persist({ ...snapshot, request: { ...snapshot.request, disclosure: { ...snapshot.request.disclosure, status: "approved", approvedAt } }, state: "planning", blockedReason: null, updatedAt: approvedAt });
    try {
      return persist(await plan(planning, sources, signal));
    } catch (error) {
      return persist({
        ...planning,
        state: "failed",
        blockedReason: taskAuthoringFailureMessage(error),
        updatedAt: now(),
      });
    }
  }

  async function retry(id: string, signal = new AbortController().signal): Promise<TaskCreationSnapshot> {
    const snapshot = await requireSnapshot(id);
    if (snapshot.state !== "failed") {
      throw new Error("Only a failed Task creation can retry authoring.");
    }
    if (snapshot.request.analysisModel && snapshot.request.disclosure.status !== "approved") {
      throw new Error("Task authoring evidence must remain approved before retrying.");
    }
    const sources = await requireSources(snapshot.request.profileId, snapshot.request.sourceIds);
    assertSourcesEligible(sources);
    const timestamp = now();
    const planning = await persist({
      ...snapshot,
      state: "planning",
      blockedReason: null,
      transcript: [...snapshot.transcript, {
        id: `task_message_${randomUUID()}`,
        role: "user",
        text: "Retry Taskset authoring with the same approved evidence and authoring configuration.",
        createdAt: timestamp,
      }],
      updatedAt: timestamp,
    });
    try {
      return persist(await plan(planning, sources, signal, snapshot.request.objective, snapshot.proposal));
    } catch (error) {
      return persist({
        ...planning,
        state: "failed",
        blockedReason: taskAuthoringFailureMessage(error),
        updatedAt: now(),
      });
    }
  }

  async function answerQuestions(id: string, answers: Record<string, string>): Promise<TaskCreationSnapshot> {
    const snapshot = await requireSnapshot(id);
    const questions = snapshot.blockingQuestions.map((question) => ({ ...question, answer: answers[question.id]?.trim() || question.answer }));
    if (questions.some((question) => !question.answer)) return persist({ ...snapshot, blockingQuestions: questions, state: "awaiting_questions", updatedAt: now() });
    const objective = questions.find((question) => question.kind === "objective")?.answer ?? snapshot.request.objective;
    const updated = await persist({ ...snapshot, request: { ...snapshot.request, objective }, blockingQuestions: questions, state: "planning", blockedReason: null, updatedAt: now() });
    const sources = await requireSources(snapshot.request.profileId, snapshot.request.sourceIds);
    if (!sources.length) return persist({ ...updated, state: "awaiting_questions", blockedReason: "Supporting evidence is required before authoring can continue.", updatedAt: now() });
    try {
      return persist(await plan(updated, sources, new AbortController().signal));
    } catch (error) {
      return persist({
        ...updated,
        state: "failed",
        blockedReason: taskAuthoringFailureMessage(error),
        updatedAt: now(),
      });
    }
  }

  async function approveMaterialization(id: string, approved: boolean): Promise<TaskCreationSnapshot> {
    const snapshot = await requireSnapshot(id);
    if (snapshot.state !== "awaiting_materialization_approval" || !snapshot.proposal) throw new Error("Task creation is not ready for materialization approval.");
    if (!approved) return persist({ ...snapshot, state: "cancelled", blockedReason: "Taskset materialization was declined.", updatedAt: now() });
    let applying = await persist({ ...snapshot, state: "materializing", blockedReason: null, updatedAt: now() });
    try {
      const sources = await requireSources(snapshot.request.profileId, snapshot.request.sourceIds);
      const proposal = enrichCrossSystemProposal(snapshot.proposal, sources);
      assertProposalMaterializable(proposal, sources);
      applying = await persist({ ...applying, proposal, updatedAt: now() });
      const taskset = await materializeTaskset(applying, proposal, sources);
      return persist({ ...applying, state: "ready", materializedTasksetId: taskset.id, blockedReason: null, updatedAt: now(), transcript: [...applying.transcript, { id: `task_message_${randomUUID()}`, role: "assistant", text: `Materialized ${taskset.name} with ${taskset.tasks.length} tasks and ${taskset.graders.length} graders.`, createdAt: now() }] });
    } catch (error) {
      return persist({ ...applying, state: "failed", blockedReason: error instanceof Error ? error.message : String(error), updatedAt: now() });
    }
  }

  async function chat(id: string, message: string, signal = new AbortController().signal): Promise<TaskCreationSnapshot> {
    const snapshot = await requireSnapshot(id);
    const instruction = message.trim();
    if (!instruction) throw new Error("Task Creator message is required.");
    if (!snapshot.request.analysisModel || !deps.authorProposal) throw new Error("Task Creator chat requires a configured authoring model.");
    if (["materializing", "validating", "ready", "cancelled"].includes(snapshot.state)) throw new Error(`Task Creator cannot revise a ${snapshot.state} creation.`);
    const timestamp = now();
    const chatting = TaskCreationSnapshotSchema.parse({ ...snapshot, state: "planning", blockedReason: null, transcript: [...snapshot.transcript, { id: `task_message_${randomUUID()}`, role: "user", text: instruction, createdAt: timestamp }], updatedAt: timestamp });
    await persist(chatting);
    const sources = await requireSources(snapshot.request.profileId, snapshot.request.sourceIds);
    try {
      return persist(await plan(chatting, sources, signal, instruction, snapshot.proposal));
    } catch (error) {
      return persist({
        ...chatting,
        state: "failed",
        blockedReason: taskAuthoringFailureMessage(error),
        updatedAt: now(),
      });
    }
  }

  async function rename(id: string, name: string): Promise<TaskCreationSnapshot> {
    const snapshot = await requireSnapshot(id);
    if (!snapshot.proposal) throw new Error("Task Creator has no proposal to rename.");
    if (["materializing", "validating", "ready", "cancelled"].includes(snapshot.state)) throw new Error(`Task Creator cannot rename a ${snapshot.state} creation.`);
    const proposal = TaskDesignProposalSchema.parse({
      ...snapshot.proposal,
      name: conciseWorkproductName(name, snapshot.proposal.name),
    });
    return persist({ ...snapshot, proposal, updatedAt: now() });
  }

  async function cancel(id: string): Promise<TaskCreationSnapshot> {
    const snapshot = await requireSnapshot(id);
    if (["materializing", "validating", "ready"].includes(snapshot.state)) throw new Error(`Task Creator cannot cancel a ${snapshot.state} creation.`);
    return persist({ ...snapshot, state: "cancelled", blockedReason: "Taskset creation was cancelled.", updatedAt: now() });
  }

  async function plan(snapshot: TaskCreationSnapshot, sources: TrainingSourceRef[], signal: AbortSignal, instruction: string | null = null, currentProposal: TaskDesignProposal | null = null): Promise<TaskCreationSnapshot> {
    if (snapshot.blockingQuestions.some((question) => !question.answer)) return TaskCreationSnapshotSchema.parse({ ...snapshot, state: "awaiting_questions", updatedAt: now() });
    const evidence = await Promise.all(sources.map((source) => sourceEvidence(deps.store, source, deps.loadCodexHistoryThread)));
    if (snapshot.request.analysisModel) assertHostedAuthoringEvidenceBudget(evidence);
    const proposalId = `task_proposal_${randomUUID()}`;
    const authored = snapshot.request.analysisModel && deps.authorProposal
      ? await deps.authorProposal({ id: proposalId, model: snapshot.request.analysisModel, reasoningEffort: snapshot.request.analysisReasoningEffort, evidence, methodHint: snapshot.request.methodHint, signal, instruction: instruction ?? snapshot.request.objective, currentProposal })
      : heuristicProposal(proposalId, snapshot, sources, evidence);
    const proposal = "proposal" in authored ? authored.proposal : authored;
    const repairHistory = "proposal" in authored ? authored.repairHistory : [];
    const specialized = enrichCrossSystemProposal(proposal, sources);
    const parsed = TaskDesignProposalSchema.parse({
      ...specialized,
      name: conciseWorkproductName(specialized.name),
      trainingPath: trainingPathForProposal(specialized),
    });
    validateProposedExamples(parsed, evidence);
    const reviewBlockers = proposalMaterializationBlockers(parsed, sources);
    const reviewed = TaskDesignProposalSchema.parse({
      ...parsed,
      warnings: [...new Set([...parsed.warnings, ...reviewBlockers])],
    });
    return TaskCreationSnapshotSchema.parse({
      ...snapshot,
      state: reviewBlockers.length ? "recommendation_ready" : "awaiting_materialization_approval",
      proposal: reviewed,
      blockedReason: null,
      repairHistory: [...snapshot.repairHistory, ...repairHistory],
      materializationApprovalId: `task_materialization_${randomUUID()}`,
      transcript: [...snapshot.transcript, { id: `task_message_${randomUUID()}`, role: "assistant", text: `Proposed “${reviewed.name}”. Review what should be learned, what should remain context, and the evidence before creating a Taskset.`, createdAt: now() }],
      updatedAt: now(),
    });
  }

  async function materializeTaskset(snapshot: TaskCreationSnapshot, proposal: TaskDesignProposal, sources: TrainingSourceRef[]): Promise<Taskset> {
    const profile = await (deps.loadProfileState ?? loadOpenPondProfileState)();
    if (profile.mode !== "local" || !profile.sourcePath) throw new Error("An active local OpenPond profile is required to materialize Tasksets.");
    if ((profile.activeProfile ?? "default") !== snapshot.request.profileId) throw new Error(`Active profile ${profile.activeProfile ?? "default"} does not match Taskset profile ${snapshot.request.profileId}.`);
    if (!deps.tasksetRootDir) {
      throw new Error("A managed Taskset storage root is required for private evaluation material.");
    }
    const tasks = taskRecords(proposal, sources);
    const agentTarget = snapshot.request.targetIntent.kind === "agent";
    const timestamp = now();
    const tasksetId = safeTasksetId(proposal.name, snapshot.id);
    const draft = {
      schemaVersion: "openpond.taskset.v1" as const,
      id: tasksetId,
      profileId: snapshot.request.profileId,
      createImproveRunId: snapshot.request.createImproveRunId,
      name: proposal.name,
      objective: proposal.objective,
      status: "needs_review" as const,
      sourceRefs: sources,
      policy: proposal.policy,
      environment: {
        protocolVersion: "openpond.taskEnvironment.v1" as const,
        kind: agentTarget ? "agent" as const : proposal.taskKind === "chat" ? "chat" as const : "agent" as const,
        entrypoint: agentTarget ? "chat" : "environment/taskset.ts",
        stateful: proposal.taskKind === "custom_program" || proposal.taskKind === "multi_agent" || proposal.diagnosis.requiredTools.length > 0,
        deterministicSeeds: true,
        toolNames: proposal.diagnosis.requiredTools,
        lifecycle: ["create", "reset", "step", "grade", "cleanup"] as const,
        defaultTimeoutMs: 120_000,
        networkPolicy: "none" as const,
        metadata: {
          ...crossSystemTasksetMetadata(sources),
          ...(agentTarget ? { executor: "openpond-agent-sdk", action: "chat" } : {}),
        },
      },
      capabilities: {
        schemaVersion: "openpond.tasksetCapabilities.v1" as const,
        taskKind: agentTarget ? "single_agent" as const : proposal.taskKind,
        supportedSignals: proposal.trainingPath?.primaryMethod === "grpo" ? ["demonstration", "reward"] as const : ["demonstration"] as const,
        compatibleMethods: proposal.trainingPath ? [...new Set([proposal.trainingPath.primaryMethod, ...(proposal.trainingPath.bootstrap ? [proposal.trainingPath.bootstrap.method] : [])])] : ["sft"],
        rewardKinds: proposal.trainingPath?.primaryMethod === "grpo" ? ["exact", "deterministic"] as const : ["deterministic"] as const,
        requiresTools: proposal.diagnosis.requiredTools.length > 0,
        requiresState: agentTarget || proposal.taskKind !== "chat",
        requiresPrivilegedGrading: true,
        environmentPlacements: ["local", "remote", "colocated"] as const,
        exportable: true,
        portabilityBlockers: [],
      },
      tasks,
      graders: normalizeAuthoredGraders(proposal.proposedGraders),
      graderFixtures: proposal.graderFixtures.map((fixture) => {
        const task = fixture.metadata.preferFrozenEvaluation === true ? tasks.find((item) => item.split === "frozen_eval") ?? tasks[fixture.taskIndex] ?? tasks[0]! : tasks[fixture.taskIndex] ?? tasks[0]!;
        const output = fixture.metadata.substituteExpectedOutput === true
          ? { ...(task.expectedOutput ?? {}), ...Object.fromEntries(Object.entries(fixture.output).filter(([, value]) => value !== "__EXPECTED_OUTPUT__")) }
          : fixture.output;
        return { ...fixture, taskId: task.id, output };
      }),
      learningSignals: {
        demonstrations: tasks
          .filter(
            (task) =>
              task.split === "train"
              && task.expectedOutput
              && (
                task.metadata.flagship !== "cross-system-operations"
                || task.tags.includes("structured-tool-trajectory")
              ),
          )
          .map((task) => ({
            id: `demo_${task.id}`,
            kind: "demonstration" as const,
            taskId: task.id,
            sourceRefs: task.sourceRefs,
            artifactRef: `task_output_${task.id}`,
            approved: true,
            confidence: task.metadata.exampleOrigin === "extracted"
              ? 0.8
              : task.metadata.exampleOrigin === "expert_authored"
                ? 1
                : 0.6,
            metadata: {
              exampleOrigin: task.metadata.exampleOrigin,
              approvedBy: "local_user",
              approval: "taskset_materialization",
            },
          })),
        preferences: [],
        corrections: [],
        feedback: [],
        rewards: [],
        labels: [],
      },
      authoringProvenance: { schemaVersion: "openpond.taskAuthoringProvenance.v1" as const, model: snapshot.request.analysisModel, modelConfig: snapshot.request.analysisReasoningEffort ? { reasoningEffort: snapshot.request.analysisReasoningEffort } : {}, skillHash: deps.authoringSkillHash, promptTemplateVersion: "task-authoring.v2", evidenceHashes: sources.map((source) => source.sourceHash), tasksetSdkVersion: "0.0.1", sourceCommit: profile.git?.head ?? null, repairHistory: snapshot.repairHistory, createdAt: timestamp },
      readiness: null,
      contentHash: "",
      createdAt: timestamp,
      updatedAt: timestamp,
      metadata: {
        creationSnapshotId: snapshot.id,
        resourceIntent: snapshot.request.resourceIntent,
        targetIntent: snapshot.request.targetIntent,
        privateMaterialManaged: true,
        trainingMethod: proposal.proposedMethod,
        trainingPath: proposal.trainingPath,
        diagnosis: proposal.diagnosis,
        assumptions: proposal.assumptions,
        warnings: proposal.warnings,
        ...crossSystemTasksetMetadata(sources),
      },
    };
    const unhashed = TasksetSchema.parse({ ...draft, contentHash: "00000000" });
    const taskset = TasksetSchema.parse({ ...unhashed, contentHash: computeTasksetHash(unhashed) });
    await buildTaskset(taskset, path.join(deps.tasksetRootDir, taskset.id), { generatedFiles: proposal.generatedFiles });
    await deps.store.upsertTaskset(taskset);
    return taskset;
  }

  async function persist(snapshotInput: unknown): Promise<TaskCreationSnapshot> {
    return deps.store.upsertTaskCreationSnapshot(TaskCreationSnapshotSchema.parse(snapshotInput));
  }
  async function requireSnapshot(id: string): Promise<TaskCreationSnapshot> { const snapshot = await deps.store.getTaskCreationSnapshot(id); if (!snapshot) throw new Error("Task creation not found."); return snapshot; }
  async function requireSources(profileId: string, ids: string[]): Promise<TrainingSourceRef[]> {
    const sources = await Promise.all(ids.map((id) => deps.store.getTrainingSource(id)));
    if (sources.some((source) => !source)) throw new Error("One or more training sources were not found.");
    const typed = sources as TrainingSourceRef[];
    if (typed.some((source) => source.profileId !== profileId)) throw new Error("Training sources must belong to the selected profile.");
    return Promise.all(typed.map((source) => {
      if (source.licensingStatus !== "review" || source.connectedAppIds.length > 0 || source.consent.grantedBy !== "local_user") return source;
      return deps.store.upsertTrainingSource({
        ...source,
        licensingStatus: "approved",
        metadata: { ...source.metadata, licensingBasis: "local_user_selected_chat" },
      });
    }));
  }

  return { reconcileInterruptedCreations, addSessionSource, estimateSessionSources, start, approveDisclosure, retry, answerQuestions, approveMaterialization, chat, rename, cancel };
}

function assertHostedAuthoringEvidenceBudget(evidence: TaskAuthoringEvidence[]): void {
  const estimatedTokens = evidence.reduce(
    (total, item) => total + item.excerpts.reduce(
      (sourceTotal, excerpt) => sourceTotal + Math.ceil(Buffer.byteLength(excerpt.text, "utf8") / 4),
      0,
    ),
    0,
  );
  if (estimatedTokens <= TASK_AUTHORING_MAX_DISCLOSED_EVIDENCE_TOKENS) return;
  throw new Error(
    `Selected evidence is approximately ${estimatedTokens.toLocaleString("en-US")} tokens; hosted Taskset authoring accepts at most ${TASK_AUTHORING_MAX_DISCLOSED_EVIDENCE_TOKENS.toLocaleString("en-US")} raw-evidence tokens. Choose fewer chats or selected turns and try again. No evidence was sent to the authoring provider.`,
  );
}

function taskAuthoringFailureMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  const code = error instanceof Error && error.cause && typeof error.cause === "object"
    ? String((error.cause as { code?: unknown }).code ?? "")
    : "";
  if (message.trim().toLowerCase() === "terminated" || code === "UND_ERR_SOCKET") {
    return "OpenPond Chat closed the Taskset authoring stream before a proposal was returned. Retry the same approved evidence, or choose fewer chats if the failure repeats. No Taskset was created.";
  }
  return message;
}

function assertSourcesEligible(sources: TrainingSourceRef[]): void {
  const blocked = sources.find((source) => source.consent.status !== "granted" || source.secretScanStatus === "blocked" || source.piiScanStatus === "blocked" || source.licensingStatus === "blocked");
  if (blocked) throw new Error(`Source ${blocked.id} has an unresolved consent, privacy, secret, or licensing blocker.`);
}

async function selectedTurns(store: SqliteStore, sessionId: string, turnIds?: string[]): Promise<Turn[]> {
  const turns = await store.turnsForSession(sessionId, 10_000);
  const selected = turnIds?.length ? new Set(turnIds) : null;
  return turns.filter((turn) => turn.status === "completed" && (!selected || selected.has(turn.id)));
}

async function sourceEvidence(store: SqliteStore, source: TrainingSourceRef, loadCodexHistoryThread?: ((sessionId: string) => Promise<{ session: Session; events: RuntimeEvent[] }>) | null): Promise<TaskAuthoringEvidence> {
  const loaded = await loadSessionEvidence({ store, loadCodexHistoryThread }, source.sessionId, source.turnIds);
  const excerpts = loaded.evidence;
  const currentHash = contentHash({ session: { id: source.sessionId, title: source.title.trim() }, evidence: excerpts });
  if (currentHash !== source.sourceHash) throw new Error(`Source ${source.id} changed after selection. Remove and add it again before authoring.`);
  return { source, excerpts };
}

type EvidenceExcerpt = { role: "user" | "assistant"; text: string; turnId: string };
type SessionEvidence = { session: Session; evidence: EvidenceExcerpt[]; turnIds: string[]; occurredAt: string };

async function loadSessionEvidence(
  deps: { store: SqliteStore; loadCodexHistoryThread?: ((sessionId: string) => Promise<{ session: Session; events: RuntimeEvent[] }>) | null },
  sessionId: string,
  turnIds?: string[],
): Promise<SessionEvidence> {
  const session = await deps.store.getSession(sessionId);
  if (session) {
    const turns = await selectedTurns(deps.store, sessionId, turnIds);
    return {
      session,
      evidence: await evidenceForTurns(deps.store, sessionId, turns),
      turnIds: turns.map((turn) => turn.id),
      occurredAt: turns[0]?.startedAt ?? session.createdAt,
    };
  }
  if (!deps.loadCodexHistoryThread) throw new Error("Session not found.");
  const history = await deps.loadCodexHistoryThread(sessionId).catch(() => null);
  if (!history) throw new Error("Session not found.");
  const selected = turnIds?.length ? new Set(turnIds) : null;
  const completed = new Set(history.events.filter((event) => event.name === "turn.completed" && event.turnId).map((event) => event.turnId!));
  const prompts = new Map<string, { text: string; occurredAt: string }>();
  const assistants = new Map<string, string>();
  for (const event of history.events) {
    if (!event.turnId || (selected && !selected.has(event.turnId))) continue;
    if (event.name === "turn.started" && typeof event.args?.prompt === "string") {
      prompts.set(event.turnId, { text: event.args.prompt, occurredAt: event.timestamp });
    } else if (event.name === "assistant.delta" && event.output) {
      assistants.set(event.turnId, `${assistants.get(event.turnId) ?? ""}${event.output}`);
    }
  }
  const resolvedTurnIds = [...prompts.keys()].filter((turnId) => completed.has(turnId));
  const evidence = resolvedTurnIds.flatMap((turnId) => {
    const prompt = scanAndRedactEvidence(prompts.get(turnId)?.text ?? "").redacted.slice(0, 50_000);
    const assistant = scanAndRedactEvidence(assistants.get(turnId) ?? "").redacted.slice(0, 100_000);
    return [{ role: "user" as const, text: prompt, turnId }, ...(assistant ? [{ role: "assistant" as const, text: assistant, turnId }] : [])];
  });
  return {
    session: history.session,
    evidence,
    turnIds: resolvedTurnIds,
    occurredAt: prompts.get(resolvedTurnIds[0] ?? "")?.occurredAt ?? history.session.createdAt,
  };
}

function estimateForEvidence(sessionId: string, evidence: EvidenceExcerpt[]): TrainingSourceEstimate {
  const textBytes = evidence.reduce((sum, item) => sum + Buffer.byteLength(item.text, "utf8"), 0);
  return TrainingSourceEstimateSchema.parse({
    schemaVersion: "openpond.trainingSourceEstimate.v1",
    sessionId,
    messageCount: evidence.length,
    estimatedTokens: Math.ceil(textBytes / 4),
    textBytes,
  });
}

function workflowSignatureForEvidence(title: string, evidence: EvidenceExcerpt[]): string {
  const normalizedTitle = title.trim().toLowerCase();
  if (normalizedTitle && normalizedTitle !== "codex chat" && normalizedTitle !== "new chat") {
    return normalizedTitle.replace(/[^a-z0-9 ]/g, " ").split(/\s+/).filter(Boolean).slice(0, 8).sort().join(":");
  }
  const stop = new Set(["about", "after", "again", "also", "because", "been", "before", "being", "chat", "could", "from", "have", "into", "just", "like", "make", "more", "need", "openpond", "should", "that", "their", "then", "there", "these", "they", "this", "those", "want", "what", "when", "where", "which", "with", "would", "your"]);
  const counts = new Map<string, number>();
  for (const excerpt of evidence.filter((item) => item.role === "user")) {
    for (const token of excerpt.text.toLowerCase().replace(/[^a-z0-9 ]/g, " ").split(/\s+/)) {
      if (token.length < 4 || stop.has(token)) continue;
      counts.set(token, (counts.get(token) ?? 0) + 1);
    }
  }
  return [...counts.entries()].sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0])).slice(0, 6).map(([token]) => token).sort().join(":") || "general_workflow";
}

async function evidenceForTurns(store: SqliteStore, sessionId: string, turns: Turn[]): Promise<Array<{ role: "user" | "assistant"; text: string; turnId: string }>> {
  const selected = new Set(turns.map((turn) => turn.id));
  const events = await store.runtimeEventsForSession(sessionId, { names: ["assistant.delta"], limit: 100_000 });
  const assistantByTurn = new Map<string, string>();
  for (const event of events) if (event.turnId && selected.has(event.turnId) && event.output) assistantByTurn.set(event.turnId, (assistantByTurn.get(event.turnId) ?? "") + event.output);
  return turns.flatMap((turn) => {
    const prompt = scanAndRedactEvidence(turn.prompt).redacted.slice(0, 50_000);
    const assistant = scanAndRedactEvidence(assistantByTurn.get(turn.id) ?? "").redacted.slice(0, 100_000);
    return [{ role: "user" as const, text: prompt, turnId: turn.id }, ...(assistant ? [{ role: "assistant" as const, text: assistant, turnId: turn.id }] : [])];
  });
}

function heuristicProposal(id: string, snapshot: TaskCreationSnapshot, sources: TrainingSourceRef[], evidence: TaskAuthoringEvidence[]): TaskDesignProposal {
  const objective = snapshot.request.objective ?? `Reproduce the successful response behavior demonstrated across ${sources.length} selected conversations.`;
  const proposedMethod = snapshot.request.methodHint ?? "sft";
  const proposedExamples = sources.flatMap((source, sourceIndex) => pairEvidence(evidence[sourceIndex]?.excerpts ?? []).flatMap((pair, pairIndex) => pair.assistant ? [{ id: `example_${contentHash([source.id, pair.user.turnId, pairIndex]).slice(0, 20)}`, sourceId: source.id, sourceTurnId: pair.user.turnId, split: splitForSource(sourceIndex, sources.length), origin: "extracted" as const, inputPrompt: pair.user.text, expectedOutputText: pair.assistant.text, rationale: "Selected as a candidate example from the explicitly chosen conversation." }] : []));
  return TaskDesignProposalSchema.parse({
    schemaVersion: "openpond.taskDesignProposal.v1",
    id,
    name: conciseName(objective),
    objective,
    diagnosis: {
      schemaVersion: "openpond.capabilityDiagnosis.v1",
      summary: objective,
      stableBehavior: [objective],
      changingKnowledge: [],
      requiredContext: [],
      requiredTools: [],
      intervention: proposedMethod === "grpo" ? "grpo_rft" : proposedMethod === "dpo" ? "preference" : "sft",
      trainingEligible: true,
      rationale: ["The selected conversations contain candidate input-output examples; the user must review them before they become approved demonstrations."],
      confidence: 0.4,
    },
    taskKind: "chat",
    sourceIds: sources.map((source) => source.id),
    assumptions: ["Selected assistant responses are candidate outcomes pending Taskset review.", `The requested execution method is ${proposedMethod.toUpperCase()}; graders are used for training checks and test evaluation.`],
    successCriteria: ["Produce a response satisfying the reviewed expected outcome without exposing privileged context."],
    proposedGraders: [{ id: "expected_output", version: "1", label: "Expected output fields", kind: "state", weight: 1, hardGate: true, rewardEligible: true, privileged: true, config: { fields: ["text"] }, metadata: {} }],
    graderFixtures: defaultFixtureTemplates(),
    generatedFiles: [],
    proposedExamples,
    proposedMethod,
    policy: { policyVisibleFields: ["input.prompt"], privilegedFields: ["expectedOutput.text"], hiddenGraderRefs: ["expected_output"], connectedAppScopes: [] },
    warnings: ["No frontier authoring model reviewed the semantic boundary or factual quality of these examples."],
    createdAt: now(),
  });
}

function normalizeAuthoredGraders(graders: TaskDesignProposal["proposedGraders"]): TaskDesignProposal["proposedGraders"] {
  return graders.map((grader) => grader.kind === "model_judge" ? { ...grader, rewardEligible: false, calibrationStatus: "pending", metadata: { ...grader.metadata, requestedRewardEligible: grader.rewardEligible, calibrationSource: "openpond_fixture_audit_required" } } : grader);
}

function taskRecords(proposal: TaskDesignProposal, sources: TrainingSourceRef[]): TaskDataRecord[] {
  const sourceById = new Map(sources.map((source) => [source.id, source]));
  return proposal.proposedExamples.map((example) => {
    const source = sourceById.get(example.sourceId);
    if (!source) throw new Error(`Proposed example ${example.id} references a source outside this creation.`);
    const structured = crossSystemStructuredExample(source);
    const groundTruth = crossSystemGroundTruth(source);
    const expectedOutput = structured
      ? { text: structured.finalAnswer, messages: structured.outputMessages }
      : groundTruth
        ? { text: `ANSWER: ${JSON.stringify(groundTruth.expectedAnswer)}` }
        : example.expectedOutputText
          ? { text: example.expectedOutputText }
          : null;
    return {
      schemaVersion: "openpond.taskData.v1" as const,
      id: `task_${contentHash([proposal.id, example.id]).slice(0, 20)}`,
      clusterKey: source.clusterKey,
      split: example.split,
      input: structured
        ? { prompt: structured.prompt, messages: structured.inputMessages }
        : { prompt: groundTruth?.prompt ?? example.inputPrompt },
      expectedOutput,
      policyVisibleContext: {},
      privilegedContextRef: expectedOutput ? `expected_output_${example.id}` : null,
      sourceRefs: [source.id],
      tags: ["chat", example.origin, ...(structured ? ["structured-tool-trajectory"] : [])],
      metadata: {
        sourceTurnId: example.sourceTurnId,
        exampleOrigin: example.origin,
        exampleRationale: example.rationale,
        proposalExampleId: example.id,
        ...crossSystemExampleMetadata(source),
      },
    };
  });
}

function pairEvidence(excerpts: TaskAuthoringEvidence["excerpts"]): Array<{ user: TaskAuthoringEvidence["excerpts"][number]; assistant: TaskAuthoringEvidence["excerpts"][number] | null }> {
  const pairs: Array<{ user: TaskAuthoringEvidence["excerpts"][number]; assistant: TaskAuthoringEvidence["excerpts"][number] | null }> = [];
  for (const excerpt of excerpts) if (excerpt.role === "user") pairs.push({ user: excerpt, assistant: excerpts.find((item) => item.role === "assistant" && item.turnId === excerpt.turnId) ?? null });
  return pairs;
}

function splitForSource(index: number, count: number): "train" | "validation" | "frozen_eval" {
  if (count === 1) return "train";
  if (index === count - 1) return "frozen_eval";
  if (count >= 3 && index === count - 2) return "validation";
  return "train";
}

function validateProposedExamples(proposal: TaskDesignProposal, evidence: TaskAuthoringEvidence[]): void {
  const evidenceBySource = new Map(evidence.map((item) => [item.source.id, item]));
  for (const example of proposal.proposedExamples) {
    const source = evidenceBySource.get(example.sourceId);
    if (!source) throw new Error(`Proposed example ${example.id} references unselected source ${example.sourceId}.`);
    if (example.origin !== "extracted") continue;
    const user = source.excerpts.find((item) => item.role === "user" && item.turnId === example.sourceTurnId);
    const assistant = source.excerpts.find((item) => item.role === "assistant" && item.turnId === example.sourceTurnId);
    if (!user || !assistant || user.text !== example.inputPrompt || assistant.text !== example.expectedOutputText) throw new Error(`Extracted example ${example.id} does not exactly match its cited conversation turn.`);
  }
}

function proposalMaterializationBlockers(proposal: TaskDesignProposal, sources: TrainingSourceRef[]): string[] {
  if (!proposal.diagnosis.trainingEligible) return [`OpenPond recommends ${proposal.diagnosis.intervention.replaceAll("_", " ")} instead of model training.`];
  const blockers: string[] = [];
  if (!["sft", "dpo", "grpo", "sdft", "opsd", "sdpo"].includes(proposal.proposedMethod)) blockers.push(`The ${proposal.proposedMethod.replaceAll("_", " ")} recommendation does not create a trainable Taskset.`);
  const sourceById = new Map(sources.map((source) => [source.id, source]));
  const hasGroundTruth = (example: TaskDesignProposal["proposedExamples"][number]) =>
    Boolean(example.expectedOutputText || crossSystemGroundTruth(sourceById.get(example.sourceId)));
  const train = proposal.proposedExamples.filter(
    (example) =>
      example.split === "train"
      && (proposal.proposedMethod === "grpo" ? hasGroundTruth(example) : Boolean(example.expectedOutputText)),
  );
  const frozen = proposal.proposedExamples.filter(
    (example) => example.split === "frozen_eval" && hasGroundTruth(example),
  );
  if (!train.length) {
    blockers.push(
      proposal.proposedMethod === "grpo"
        ? "No reviewed reward-bearing training task was proposed."
        : "No reviewed training example was proposed.",
    );
  }
  if (!frozen.length) blockers.push("No independent evaluation example was proposed.");
  const clusterSplits = new Map<string, Set<string>>();
  for (const example of proposal.proposedExamples) {
    const cluster = sourceById.get(example.sourceId)?.clusterKey;
    if (!cluster) continue;
    const splits = clusterSplits.get(cluster) ?? new Set<string>();
    splits.add(example.split);
    clusterSplits.set(cluster, splits);
  }
  if ([...clusterSplits.values()].some((splits) => splits.size > 1)) blockers.push("A source conversation appears in both training and evaluation. Each conversation must remain in one split.");
  const trainClusters = new Set(train.map((example) => sourceById.get(example.sourceId)?.clusterKey).filter(Boolean));
  const frozenClusters = new Set(frozen.map((example) => sourceById.get(example.sourceId)?.clusterKey).filter(Boolean));
  if (!trainClusters.size || !frozenClusters.size || [...trainClusters].some((cluster) => frozenClusters.has(cluster))) blockers.push("Training and evaluation require independent source conversations.");
  if (!proposal.proposedGraders.length) blockers.push("No evaluation grader was proposed.");
  const fixtureLabels = new Set(proposal.graderFixtures.map((fixture) => fixture.label));
  for (const label of ["positive", "negative", "boundary", "adversarial", "prompt_injection", "infrastructure_failure"] as const) if (!fixtureLabels.has(label)) blockers.push(`The grader is missing its ${label.replaceAll("_", " ")} fixture.`);
  return [...new Set(blockers)];
}

function trainingPathForProposal(proposal: Pick<TaskDesignProposal, "proposedMethod" | "proposedExamples"> | Record<string, unknown>) {
  const method = proposal.proposedMethod;
  if (method !== "sft" && method !== "dpo" && method !== "grpo" && method !== "sdft" && method !== "opsd" && method !== "sdpo") return null;
  const examples = Array.isArray(proposal.proposedExamples) ? proposal.proposedExamples as TaskDesignProposal["proposedExamples"] : [];
  const demonstrationRefs = examples.filter((example) => example.split === "train" && Boolean(example.expectedOutputText)).map((example) => example.id);
  return {
    primaryMethod: method,
    bootstrap: method === "grpo" && demonstrationRefs.length ? {
      method: "sft" as const,
      purpose: "trajectory_bootstrap" as const,
      demonstrationRefs,
      limitations: [
        "The SFT bootstrap imitates approved trajectories; it does not optimize verifier reward.",
        "Completing the bootstrap does not satisfy the primary GRPO recommendation.",
      ],
    } : null,
  };
}

function assertProposalMaterializable(proposal: TaskDesignProposal, sources: TrainingSourceRef[]): void {
  const blockers = proposalMaterializationBlockers(proposal, sources);
  if (blockers.length) throw new Error(blockers[0]);
}
function conciseName(objective: string): string {
  return conciseWorkproductName(
    objective.replace(/[^a-zA-Z0-9 ]/g, " "),
    "Training Taskset",
  );
}
function safeTasksetId(name: string, snapshotId: string): string { const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 48) || "taskset"; return `${slug}-${contentHash(snapshotId).slice(0, 8)}`; }
