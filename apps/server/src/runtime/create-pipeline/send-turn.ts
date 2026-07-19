import type {
  CreateImproveRun,
  RuntimeEvent,
  Session,
  Turn,
} from "@openpond/contracts";
import { event } from "../../utils.js";
import type { CreateImproveRuntime } from "./runtime.js";
import {
  createImproveRuntimeEventStatus,
  shouldRunCreateImprovePlanner,
} from "./snapshots.js";

export function createCreateImproveTurnHandler(deps: {
  appendRuntimeEvent(runtimeEvent: RuntimeEvent): Promise<void>;
  planCreateImproveForTurn: CreateImproveRuntime["planCreateImproveForTurn"];
  persistCreateImproveRun: CreateImproveRuntime["persistCreateImproveRun"];
  completeTurn(sessionId: string, turnId: string, providerTurnId: string | null): Promise<Turn>;
}) {
  return async function handleCreateImproveTurn(input: {
    session: Session;
    turn: Turn;
    run: CreateImproveRun;
    signal: AbortSignal;
  }): Promise<Turn> {
    let persistedTurn = await deps.persistCreateImproveRun({
      session: input.session,
      turnId: input.turn.id,
      run: input.run,
      source: "server",
    });
    let run = persistedTurn.createImproveRun ?? input.run;
    if (shouldRunCreateImprovePlanner(run)) {
      await deps.appendRuntimeEvent(event({
        sessionId: input.session.id,
        turnId: input.turn.id,
        name: "create_improve.updated",
        source: "server",
        appId: input.session.appId,
        status: "pending",
        output: "Create/Improve planner is preparing the plan.",
        data: { createImproveRun: run },
      }));
      run = await deps.planCreateImproveForTurn({
        session: input.session,
        turn: persistedTurn,
        run,
        signal: input.signal,
      });
      persistedTurn = await deps.persistCreateImproveRun({
        session: input.session,
        turnId: input.turn.id,
        run,
        source: "server",
      });
    } else {
      await deps.appendRuntimeEvent(event({
        sessionId: input.session.id,
        turnId: input.turn.id,
        name: "create_improve.updated",
        source: "server",
        appId: input.session.appId,
        status: createImproveRuntimeEventStatus(run),
        output: run.state === "awaiting_questions"
          ? "Create/Improve question ready."
          : "Create/Improve plan ready for review.",
        data: { createImproveRun: run },
      }));
    }
    await deps.appendRuntimeEvent(event({
      sessionId: input.session.id,
      turnId: input.turn.id,
      name: "turn.completed",
      source: "server",
      appId: input.session.appId,
      status: "completed",
      output: run.state === "awaiting_questions"
        ? "Create/Improve paused for questions."
        : "Create/Improve paused for plan review.",
    }));
    return deps.completeTurn(input.session.id, persistedTurn.id, null);
  };
}
