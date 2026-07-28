import type { ProfileSkillCommandResult } from "@openpond/cloud";
import type { RuntimeEvent, Session, Turn } from "@openpond/contracts";
import { event } from "../../utils.js";

export function createProfileSkillCommandRuntime(deps: {
  appendRuntimeEvent(runtimeEvent: RuntimeEvent): Promise<void>;
  completeTurn(sessionId: string, turnId: string, providerTurnId: string | null): Promise<Turn>;
}) {
  return async function handleProfileSkillCommand(input: {
    session: Session;
    turn: Turn;
    command: ProfileSkillCommandResult;
  }): Promise<Turn> {
    const { session, turn, command } = input;
    await deps.appendRuntimeEvent(event({
      sessionId: session.id,
      turnId: turn.id,
      name: "diagnostic",
      source: "server",
      appId: session.appId,
      status: "completed",
      output: `Profile skill command ${command.action}.`,
      data: {
        kind: "profile_skill_command",
        action: command.action,
        skillCount: command.skills?.length ?? null,
      },
    }));
    await deps.appendRuntimeEvent(event({
      sessionId: session.id,
      turnId: turn.id,
      name: "assistant.delta",
      source: "server",
      appId: session.appId,
      output: command.message,
    }));
    await deps.appendRuntimeEvent(event({
      sessionId: session.id,
      turnId: turn.id,
      name: "turn.completed",
      source: "server",
      appId: session.appId,
      status: "completed",
      output: `Profile skill command ${command.action}.`,
    }));
    return deps.completeTurn(session.id, turn.id, null);
  };
}
