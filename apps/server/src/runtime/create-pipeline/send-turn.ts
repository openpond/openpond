import type {
  CreatePipelineRequest,
  CreatePipelineSnapshot,
  RuntimeEvent,
  Session,
  Turn,
} from "@openpond/contracts";
import { assertCreatePipelineSnapshotLinked } from "../../create-pipeline-guards.js";
import { event } from "../../utils.js";
import type { CreatePipelineRuntime } from "./runtime.js";
import { createPipelineRuntimeEventStatus } from "./snapshots.js";

export function createCreatePipelineTurnHandler(deps: {
  appendRuntimeEvent(runtimeEvent: RuntimeEvent): Promise<void>;
  planCreatePipelineForTurn: CreatePipelineRuntime["planCreatePipelineForTurn"];
  persistCreatePipelineSnapshot: CreatePipelineRuntime["persistCreatePipelineSnapshot"];
  syncCreatePlanApproval: CreatePipelineRuntime["syncCreatePlanApproval"];
  completeTurn(sessionId: string, turnId: string, providerTurnId: string | null): Promise<Turn>;
}) {
  return async function handleCreatePipelineTurn(input: {
    session: Session;
    turn: Turn;
    request: CreatePipelineRequest;
    snapshot?: CreatePipelineSnapshot | null;
    signal: AbortSignal;
  }): Promise<Turn> {
    let snapshot = input.snapshot ?? null;
    let plannedByServer = false;
    if (!snapshot) {
      await deps.appendRuntimeEvent(event({
        sessionId: input.session.id,
        turnId: input.turn.id,
        name: "create_pipeline.updated",
        source: "server",
        appId: input.session.appId,
        status: "pending",
        output: "Create planner is preparing the plan.",
        data: { createPipelineRequest: input.request, createPipeline: null },
      }));
      snapshot = await deps.planCreatePipelineForTurn({
        session: input.session,
        turn: input.turn,
        request: input.request,
        previousSnapshot: null,
        signal: input.signal,
      });
      plannedByServer = true;
      await deps.persistCreatePipelineSnapshot({
        session: input.session,
        turnId: input.turn.id,
        request: input.request,
        snapshot,
        source: "server",
      });
    } else {
      assertCreatePipelineSnapshotLinked({
        actionLabel: "Create pipeline send turn",
        request: input.request,
        snapshot,
      });
    }
    if (!plannedByServer) {
      await deps.appendRuntimeEvent(event({
        sessionId: input.session.id,
        turnId: input.turn.id,
        name: "create_pipeline.updated",
        source: "server",
        appId: input.session.appId,
        status: createPipelineRuntimeEventStatus(snapshot),
        output: snapshot.state === "awaiting_questions" ? "Create question ready." : "Create plan ready for review.",
        data: { createPipelineRequest: input.request, createPipeline: snapshot },
      }));
      await deps.syncCreatePlanApproval({
        session: input.session,
        turn: input.turn,
        request: input.request,
        snapshot,
      });
    }
    await deps.appendRuntimeEvent(event({
      sessionId: input.session.id,
      turnId: input.turn.id,
      name: "turn.completed",
      source: "server",
      appId: input.session.appId,
      status: "completed",
      output: snapshot.state === "awaiting_questions"
        ? "Create pipeline paused for questions."
        : "Create pipeline paused for plan review.",
    }));
    return deps.completeTurn(input.session.id, input.turn.id, null);
  };
}
