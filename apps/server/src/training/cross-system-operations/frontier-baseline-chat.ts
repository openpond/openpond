import { randomUUID } from "node:crypto";
import type {
  ChatModelRef,
  RuntimeEvent,
  Session,
  TrainingSourceRef,
  Turn,
  CrossSystemTrajectory,
} from "@openpond/contracts";
import type { SqliteStore } from "../../store/store.js";
import { event } from "../../utils.js";
import type { CrossSystemTask } from "./types.js";

export async function createFrontierBaselineChatSource(input: {
  store: SqliteStore;
  profileId: string;
  model: ChatModelRef;
  task: CrossSystemTask;
  trajectory: CrossSystemTrajectory;
  createSession: (payload: unknown) => Promise<Session>;
  appendRuntimeEvent: (runtimeEvent: RuntimeEvent) => Promise<void>;
  addSessionSource: (input: { profileId: string; sessionId: string; turnIds?: string[]; consentScope?: "selected_turns" | "full_session" }) => Promise<TrainingSourceRef>;
}): Promise<TrainingSourceRef> {
  const session = await input.createSession({
    provider: input.model.providerId,
    modelRef: input.model,
    title: `Cross-System baseline · ${label(input.task.family)} · ${input.task.worldId}`,
    metadata: {
      crossSystemFrontierBaseline: true,
      worldId: input.task.worldId,
      taskId: input.task.id,
    },
  });
  const turn: Turn = {
    id: randomUUID(),
    sessionId: session.id,
    providerTurnId: null,
    modelRef: input.model,
    prompt: input.task.prompt,
    startedAt: input.trajectory.startedAt,
    completedAt: input.trajectory.completedAt,
    status: "completed",
    error: input.trajectory.infrastructureError,
    metadata: {
      crossSystemFrontierBaseline: true,
      trajectoryId: input.trajectory.id,
      taskId: input.task.id,
      worldId: input.task.worldId,
    },
    createPipelineRequest: null,
    createPipeline: null,
  };
  await input.store.insertTurn(turn);
  await input.appendRuntimeEvent(event({
    sessionId: session.id,
    turnId: turn.id,
    name: "turn.started",
    source: "ui_button",
    status: "started",
    args: { prompt: input.task.prompt, modelRef: input.model, crossSystemFrontierBaseline: true },
  }));
  for (const step of input.trajectory.steps) {
    if (step.kind === "model" || step.kind === "final") {
      if (!step.content) continue;
      await input.appendRuntimeEvent(event({
        sessionId: session.id,
        turnId: turn.id,
        name: "assistant.delta",
        source: "provider",
        status: "completed",
        output: step.content,
        data: { crossSystemStep: step.kind, turn: step.turn },
      }));
      continue;
    }
    if (step.kind === "tool_call") {
      await input.appendRuntimeEvent(event({
        sessionId: session.id,
        turnId: turn.id,
        name: "tool.started",
        source: "provider",
        action: step.name,
        status: "started",
        args: step.arguments,
        data: { toolCallId: step.callId, toolContract: "cross-system-operations", turn: step.turn },
      }));
      continue;
    }
    await input.appendRuntimeEvent(event({
      sessionId: session.id,
      turnId: turn.id,
      name: "tool.completed",
      source: "server",
      action: step.name,
      status: step.ok ? "completed" : "failed",
      output: step.ok ? JSON.stringify(step.result) : undefined,
      error: step.error ?? undefined,
      data: { toolCallId: step.callId, rows: step.rows, bytes: step.bytes, durationMs: step.durationMs, turn: step.turn },
    }));
  }
  await input.appendRuntimeEvent(event({
    sessionId: session.id,
    turnId: turn.id,
    name: "turn.completed",
    source: "server",
    status: "completed",
    output: `Cross-System frontier baseline ${input.trajectory.status}.`,
    data: { trajectoryId: input.trajectory.id, crossSystemFrontierBaseline: true },
  }));
  return input.addSessionSource({
    profileId: input.profileId,
    sessionId: session.id,
    turnIds: [turn.id],
    consentScope: "selected_turns",
  });
}

function label(value: string): string {
  return value.replaceAll("_", " ").replace(/\b\w/g, (character) => character.toUpperCase());
}
