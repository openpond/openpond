import { randomUUID } from "node:crypto";
import {
  CrossSystemFrontierBaselineResultSchema,
  CrossSystemFrontierBaselineRunSchema,
  type ChatModelRef,
  type CodexReasoningEffort,
  type CrossSystemFrontierBaselineRun,
  type CrossSystemTrajectory,
  type CrossSystemVerifierResult,
  type CrossSystemWorldSpec,
  type LocalProject,
  type TrainingSourceRef,
} from "@openpond/contracts";
import type { SqliteStore } from "../../store/store.js";
import { now } from "../../utils.js";
import type { CrossSystemTask } from "./types.js";
import { recordFrontierBaselineSources } from "./frontier-baseline-sources.js";
import type { CrossSystemFrontierModelStream } from "./frontier-baseline.js";

type ProjectIdentity = Pick<LocalProject, "id" | "name" | "workspacePath" | "agentSdk">;

export function createCrossSystemFrontierBaselineService(deps: {
  store: SqliteStore;
  stream: CrossSystemFrontierModelStream;
  findLocalProject: (projectId: string) => Promise<ProjectIdentity | null>;
  createEvidenceSource: (input: {
    profileId: string;
    model: ChatModelRef;
    localProject: ProjectIdentity;
    task: CrossSystemTask;
    trajectory: CrossSystemTrajectory;
  }) => Promise<TrainingSourceRef>;
}) {
  const activeRuns = new Map<string, { controller: AbortController; execution: Promise<void> }>();
  let closing = false;
  const ready = reconcileInterruptedRuns();

  async function startRun(input: {
    profileId: string;
    createImproveRunId?: string | null;
    localProjectId: string;
    worldSpecs: CrossSystemWorldSpec[];
    model: ChatModelRef;
    reasoningEffort: CodexReasoningEffort | null;
  }): Promise<CrossSystemFrontierBaselineRun> {
    await ready;
    if (closing) throw new Error("The frontier baseline service is closing.");
    const project = await requiredCrossSystemProject(input.localProjectId);
    const existing = (await deps.store.listCrossSystemFrontierBaselineRuns(input.profileId)).find((run) => isActive(run.status));
    if (existing) throw new Error(`Frontier baseline ${existing.id} is already ${existing.status}.`);
    const timestamp = now();
    const run = CrossSystemFrontierBaselineRunSchema.parse({
      schemaVersion: "openpond.crossSystemFrontierBaselineRun.v1",
      id: `cso_frontier_run_${randomUUID()}`,
      profileId: input.profileId,
      createImproveRunId: input.createImproveRunId ?? null,
      localProjectId: project.id,
      localProjectName: project.name,
      model: input.model,
      reasoningEffort: input.reasoningEffort,
      worldSpecs: input.worldSpecs,
      status: "queued",
      progress: {
        stage: "queued",
        completedTasks: 0,
        totalTasks: input.worldSpecs.length * 5,
        currentTask: null,
        outcomes: emptyOutcomes(),
      },
      sourceIds: [],
      reboundSessionCount: 0,
      result: null,
      cancelRequested: false,
      error: null,
      createdAt: timestamp,
      startedAt: null,
      completedAt: null,
      updatedAt: timestamp,
    });
    await deps.store.saveCrossSystemFrontierBaselineRun(run);
    const controller = new AbortController();
    const execution = Promise.resolve()
      .then(() => executeRun(run, project, controller))
      .catch(async (error) => {
        const persisted = await deps.store.getCrossSystemFrontierBaselineRun(run.id).catch(() => null);
        if (!persisted || !isActive(persisted.status)) return;
        const completedAt = now();
        await deps.store.saveCrossSystemFrontierBaselineRun({
          ...persisted,
          status: controller.signal.aborted ? "cancelled" : "failed",
          cancelRequested: controller.signal.aborted || persisted.cancelRequested,
          error: controller.signal.aborted ? null : errorMessage(error),
          completedAt,
          updatedAt: completedAt,
        });
      })
      .finally(() => activeRuns.delete(run.id));
    activeRuns.set(run.id, { controller, execution });
    return run;
  }

  async function executeRun(
    initial: CrossSystemFrontierBaselineRun,
    project: ProjectIdentity,
    controller: AbortController,
  ): Promise<void> {
    const startedAt = now();
    let current = await deps.store.saveCrossSystemFrontierBaselineRun({
      ...initial,
      status: "running",
      progress: { ...initial.progress, stage: "preparing" },
      startedAt,
      updatedAt: startedAt,
    });
    try {
      const reboundSessionCount = await bindExistingEvidenceToProject(current.profileId, project);
      current = await deps.store.saveCrossSystemFrontierBaselineRun({ ...current, reboundSessionCount, updatedAt: now() });
      throwIfAborted(controller.signal);
      const result = await recordFrontierBaselineSources({
        store: deps.store,
        profileId: current.profileId,
        worldSpecs: current.worldSpecs,
        model: current.model,
        reasoningEffort: current.reasoningEffort,
        stream: deps.stream,
        approvedBy: "local_user_visible_baseline_action",
        signal: controller.signal,
        createEvidenceSource: ({ profileId, task, trajectory }) => deps.createEvidenceSource({
          profileId,
          model: current.model,
          localProject: project,
          task,
          trajectory,
        }),
        onTaskStarted: async ({ index, total, task }) => {
          const persisted = await currentRun(current.id, controller);
          current = await deps.store.saveCrossSystemFrontierBaselineRun({
            ...persisted,
            status: "running",
            progress: {
              ...persisted.progress,
              stage: "running",
              totalTasks: total,
              currentTask: { index, taskId: task.id, worldId: task.worldId, family: task.family },
            },
            updatedAt: now(),
          });
        },
        onTaskRecorded: async ({ total, result: verifierResult, source }) => {
          const persisted = await deps.store.getCrossSystemFrontierBaselineRun(current.id);
          if (!persisted) throw new Error("Cross-System frontier baseline run disappeared while it was recording evidence.");
          current = await deps.store.saveCrossSystemFrontierBaselineRun({
            ...persisted,
            status: "running",
            progress: {
              ...persisted.progress,
              stage: "running",
              completedTasks: persisted.progress.completedTasks + 1,
              totalTasks: total,
              outcomes: incrementOutcome(persisted.progress.outcomes, verifierResult),
            },
            sourceIds: [...persisted.sourceIds, source.id],
            updatedAt: now(),
          });
          if (persisted.cancelRequested && !controller.signal.aborted) {
            controller.abort(abortError("Cross-System frontier baseline was cancelled."));
          }
          throwIfAborted(controller.signal);
        },
      });
      throwIfAborted(controller.signal);
      current = await deps.store.saveCrossSystemFrontierBaselineRun({
        ...current,
        status: "running",
        progress: { ...current.progress, stage: "persisting", currentTask: null },
        updatedAt: now(),
      });
      const completedAt = now();
      await deps.store.saveCrossSystemFrontierBaselineRun({
        ...current,
        status: "succeeded",
        progress: { ...current.progress, stage: "complete", currentTask: null },
        sourceIds: result.sources.map((source) => source.id),
        result: CrossSystemFrontierBaselineResultSchema.parse(result),
        completedAt,
        updatedAt: completedAt,
      });
    } catch (error) {
      const persisted = await deps.store.getCrossSystemFrontierBaselineRun(current.id) ?? current;
      const cancelled = controller.signal.aborted || persisted.cancelRequested;
      const completedAt = now();
      await deps.store.saveCrossSystemFrontierBaselineRun({
        ...persisted,
        status: cancelled ? "cancelled" : "failed",
        progress: { ...persisted.progress, currentTask: null },
        cancelRequested: cancelled || persisted.cancelRequested,
        error: cancelled ? null : errorMessage(error),
        completedAt,
        updatedAt: completedAt,
      });
    }
  }

  async function cancelRun(id: string): Promise<CrossSystemFrontierBaselineRun> {
    await ready;
    const run = await deps.store.getCrossSystemFrontierBaselineRun(id);
    if (!run) throw new Error("Cross-System frontier baseline run not found.");
    if (!isActive(run.status)) return run;
    const updated = await deps.store.saveCrossSystemFrontierBaselineRun({
      ...run,
      status: "cancelling",
      cancelRequested: true,
      updatedAt: now(),
    });
    activeRuns.get(id)?.controller.abort(abortError("Cross-System frontier baseline was cancelled."));
    return updated;
  }

  async function currentRun(id: string, controller: AbortController): Promise<CrossSystemFrontierBaselineRun> {
    const persisted = await deps.store.getCrossSystemFrontierBaselineRun(id);
    if (!persisted) throw new Error("Cross-System frontier baseline run disappeared while it was executing.");
    if (persisted.cancelRequested && !controller.signal.aborted) {
      controller.abort(abortError("Cross-System frontier baseline was cancelled."));
    }
    throwIfAborted(controller.signal);
    return persisted;
  }

  async function close(): Promise<void> {
    closing = true;
    await ready;
    for (const { controller } of activeRuns.values()) {
      controller.abort(abortError("Cross-System frontier baseline stopped because the server is closing."));
    }
    await Promise.allSettled([...activeRuns.values()].map(({ execution }) => execution));
  }

  async function reconcileInterruptedRuns(): Promise<void> {
    const runs = await deps.store.listCrossSystemFrontierBaselineRuns();
    for (const run of runs) {
      if (!isActive(run.status)) continue;
      const completedAt = now();
      await deps.store.saveCrossSystemFrontierBaselineRun({
        ...run,
        status: "failed",
        progress: { ...run.progress, currentTask: null },
        error: "The server restarted before this frontier baseline completed. Start a new run; completed evidence chats were preserved.",
        completedAt,
        updatedAt: completedAt,
      });
    }
  }

  async function requiredCrossSystemProject(projectId: string): Promise<ProjectIdentity> {
    const project = await deps.findLocalProject(projectId);
    if (!project) throw new Error("The selected local project no longer exists.");
    if (!isCrossSystemProject(project) || !project.agentSdk?.detected) {
      throw new Error("Select the imported Cross-System Operations Agent SDK project before running the frontier baseline.");
    }
    return project;
  }

  async function bindExistingEvidenceToProject(profileId: string, project: ProjectIdentity): Promise<number> {
    const sessions = (await deps.store.snapshot()).sessions.filter((session) =>
      session.metadata?.crossSystemFrontierBaseline === true && !session.localProjectId,
    );
    if (!sessions.length) return 0;
    const sessionIds = new Set(sessions.map((session) => session.id));
    for (const session of sessions) {
      await deps.store.updateSession(session.id, (currentSession) => ({
        ...currentSession,
        workspaceKind: "local_project",
        workspaceId: project.id,
        workspaceName: project.name,
        localProjectId: project.id,
        cwd: project.workspacePath,
        metadata: { ...currentSession.metadata, localProjectId: project.id },
        updatedAt: now(),
      }));
    }
    for (const source of await deps.store.listTrainingSources(profileId)) {
      if (!sessionIds.has(source.sessionId) || source.workspaceId === project.id) continue;
      await deps.store.upsertTrainingSource({
        ...source,
        workspaceId: project.id,
        metadata: { ...source.metadata, localProjectId: project.id },
      });
    }
    return sessions.length;
  }

  return { startRun, cancelRun, close };
}

function emptyOutcomes(): CrossSystemFrontierBaselineRun["progress"]["outcomes"] {
  return { correct: 0, incorrect: 0, parseFailure: 0, budgetExhausted: 0, toolSchemaViolation: 0, infrastructureFailure: 0, cancelled: 0 };
}

function incrementOutcome(
  outcomes: CrossSystemFrontierBaselineRun["progress"]["outcomes"],
  result: CrossSystemVerifierResult,
): CrossSystemFrontierBaselineRun["progress"]["outcomes"] {
  const next = { ...outcomes };
  if (result.outcome === "correct") next.correct += 1;
  else if (result.outcome === "incorrect") next.incorrect += 1;
  else if (result.outcome === "parse_failure") next.parseFailure += 1;
  else if (result.outcome === "budget_exhausted") next.budgetExhausted += 1;
  else if (result.outcome === "tool_schema_violation") next.toolSchemaViolation += 1;
  else if (result.outcome === "infrastructure_failure") next.infrastructureFailure += 1;
  else next.cancelled += 1;
  return next;
}

function isActive(status: CrossSystemFrontierBaselineRun["status"]): boolean {
  return status === "queued" || status === "running" || status === "cancelling";
}

function isCrossSystemProject(project: Pick<ProjectIdentity, "name" | "workspacePath">): boolean {
  return [project.name, project.workspacePath.split(/[\\/]/).at(-1) ?? ""]
    .some((value) => value.toLowerCase().replace(/[^a-z0-9]/g, "") === "crosssystemoperations");
}

function throwIfAborted(signal: AbortSignal): void {
  if (!signal.aborted) return;
  throw signal.reason ?? abortError("Cross-System frontier baseline was cancelled.");
}

function abortError(message: string): Error {
  const error = new Error(message);
  error.name = "AbortError";
  return error;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
