import { CreatePipelineSnapshotSchema } from "@openpond/contracts";

import { createGoalEvent, recordGoalEvent } from "./events";
import { createGoalRunResult } from "./result";
import type { GoalStateAdapter } from "./state/adapter";
import type {
  GoalEvent,
  GoalRunResult,
  GoalState,
} from "./types";

const MODEL_BACKED_LOCAL_CREATE_REQUIRED_REASON =
  "Approved local Create plans require model-backed SDK source application; no source mutation was performed.";

type LocalCreatePipelineRunInput = {
  goal: GoalState;
  iterationId: string;
  workspace: string;
  localState?: GoalStateAdapter | null;
  startedEvents: GoalEvent[];
};

export function shouldRunLocalCreatePipeline(goal: GoalState, mode: string): boolean {
  const pipeline = goal.createPipeline;
  return Boolean(
    mode === "local" &&
      pipeline &&
      pipeline.state === "applying_source" &&
      pipeline.request.adapter.kind === "local"
  );
}

export async function runLocalCreatePipeline(
  input: LocalCreatePipelineRunInput
): Promise<GoalRunResult> {
  const localState = input.localState;
  if (!localState) {
    const blocked = createGoalEvent({
      goalId: input.goal.id,
      iterationId: input.iterationId,
      kind: "goal.blocked",
      summary: "Local create pipeline requires local Goal state",
      payload: { reason: "missing_local_state" },
    });
    return createGoalRunResult({
      goal: input.goal,
      status: "blocked",
      summary: blocked.summary,
      events: [...input.startedEvents, blocked],
    });
  }

  const current = (await localState.get(input.goal.id)) ?? input.goal;
  const pipeline = current.createPipeline;
  if (!pipeline || pipeline.request.adapter.kind !== "local") {
    const blocked = createGoalEvent({
      goalId: current.id,
      iterationId: input.iterationId,
      kind: "goal.blocked",
      summary: "Goal does not have a local create pipeline to run",
      payload: { reason: "missing_local_create_pipeline" },
    });
    await recordGoalEvent(blocked, { localState });
    await localState.update({ ...current, status: "blocked" });
    return createGoalRunResult({
      goal: current,
      status: "blocked",
      summary: blocked.summary,
      events: [...input.startedEvents, blocked],
    });
  }

  const events = [...input.startedEvents];
  const blockedTransition = await transitionLocalCreatePipeline({
    localState,
    goalId: current.id,
    iterationId: input.iterationId,
    state: "blocked",
    summary: MODEL_BACKED_LOCAL_CREATE_REQUIRED_REASON,
    blockedReason: MODEL_BACKED_LOCAL_CREATE_REQUIRED_REASON,
  });
  events.push(blockedTransition.event);
  await localState.update({
    ...blockedTransition.goal,
    status: "blocked",
  });
  const blocked = createGoalEvent({
    goalId: current.id,
    iterationId: input.iterationId,
    kind: "goal.blocked",
    summary: MODEL_BACKED_LOCAL_CREATE_REQUIRED_REASON,
    payload: {
      pipelineId: pipeline.id,
      operation: pipeline.request.operation,
      reason: "model_backed_source_application_required",
      sourcePath: pipeline.request.adapter.sourcePath ?? null,
      repoPath: pipeline.request.adapter.repoPath ?? null,
    },
  });
  await recordGoalEvent(blocked, { localState });
  events.push(blocked);
  return createGoalRunResult({
    goal: blockedTransition.goal,
    status: "blocked",
    summary: blocked.summary,
    events,
  });
}

async function transitionLocalCreatePipeline(input: {
  localState: GoalStateAdapter;
  goalId: string;
  iterationId: string;
  state:
    | "running_checks"
    | "ready_local"
    | "blocked";
  summary: string;
  blockedReason?: string | null;
  checkRefs?: string[];
}): Promise<{ goal: GoalState; event: GoalEvent }> {
  const current = await input.localState.get(input.goalId);
  if (!current?.createPipeline) {
    throw new Error(`goal has no create pipeline: ${input.goalId}`);
  }
  const now = new Date().toISOString();
  const previousState = current.createPipeline.state;
  const nextPipeline = CreatePipelineSnapshotSchema.parse({
    ...current.createPipeline,
    state: input.state,
    checkRefs: mergeRefs(current.createPipeline.checkRefs, input.checkRefs ?? []),
    blockedReason:
      input.blockedReason === undefined
        ? current.createPipeline.blockedReason
        : input.blockedReason,
    updatedAt: now,
  });
  const goal = await input.localState.update({
    ...current,
    createPipeline: nextPipeline,
    updatedAt: now,
  });
  const event = createGoalEvent({
    goalId: input.goalId,
    iterationId: input.iterationId,
    kind: "create_pipeline.status_changed",
    summary: input.summary,
    payload: {
      fromState: previousState,
      toState: input.state,
      pipelineId: nextPipeline.id,
      blockedReason: nextPipeline.blockedReason,
      checkRefs: nextPipeline.checkRefs,
    },
  });
  await recordGoalEvent(event, { localState: input.localState });
  return {
    goal: (await input.localState.get(input.goalId)) ?? goal,
    event,
  };
}

function mergeRefs(existing: string[], next: string[]): string[] {
  return Array.from(new Set([...existing, ...next].filter(Boolean)));
}
