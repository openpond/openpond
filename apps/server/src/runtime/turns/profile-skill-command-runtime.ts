import type {
  ProfileSkillCommandResult,
  ProfileSkillGoalExecutionResult,
} from "@openpond/cloud";
import type { RuntimeEvent, Session, Turn } from "@openpond/contracts";
import type { OpenPondProfileSkillGoalToolResult } from "../../openpond/capability-tool-registry.js";
import { event, textFromUnknown } from "../../utils.js";

export function createProfileSkillCommandRuntime(deps: {
  appendRuntimeEvent(runtimeEvent: RuntimeEvent): Promise<void>;
  executeProfileSkillGoalForTurn(input: {
    session: Session;
    turnId: string;
    command: Extract<ProfileSkillCommandResult, { action: "goal" }>;
    eventSource: RuntimeEvent["source"];
  }): Promise<ProfileSkillGoalExecutionResult>;
  profileSkillGoalToolResultFromExecution(
    executed: ProfileSkillGoalExecutionResult,
  ): OpenPondProfileSkillGoalToolResult;
  completeTurn(sessionId: string, turnId: string, providerTurnId: string | null): Promise<Turn>;
  failTurn(session: Session, turnId: string, error: string): Promise<Turn>;
}) {
  return async function handleProfileSkillCommand(input: {
    session: Session;
    turn: Turn;
    command: ProfileSkillCommandResult;
  }): Promise<Turn> {
    const { session, turn, command } = input;
    if (command.handled) {
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
    }

    await deps.appendRuntimeEvent(event({
      sessionId: session.id,
      turnId: turn.id,
      name: "diagnostic",
      source: "server",
      appId: session.appId,
      status: "completed",
      output: "Profile skill command routed to goal.",
      data: {
        kind: "profile_skill_command",
        action: command.action,
        routing: "goal",
        goal: command.goal,
        skill: command.skill ?? null,
      },
    }));
    await deps.appendRuntimeEvent(event({
      sessionId: session.id,
      turnId: turn.id,
      name: "diagnostic",
      source: "server",
      appId: session.appId,
      status: "completed",
      output: command.goal.objective.trim() || command.message,
      data: {
        kind: "thread_goal",
        provider: command.goal.provider || "openpond",
        goal: command.goal,
      },
    }));
    await deps.appendRuntimeEvent(event({
      sessionId: session.id,
      turnId: turn.id,
      name: "tool.started",
      source: "server",
      action: "openpond_profile_skill_goal",
      appId: session.appId,
      status: "started",
      output: "Creating profile skill.",
      args: {
        operation: command.goal.operation,
        objective: command.goal.userObjective,
        skillName: command.goal.targetSkillName,
      },
      data: { tool: "openpond_profile_skill_goal", type: "profile_skill_goal" },
    }));
    try {
      const executed = await deps.executeProfileSkillGoalForTurn({
        session,
        turnId: turn.id,
        command,
        eventSource: "server",
      });
      const result = deps.profileSkillGoalToolResultFromExecution(executed);
      await deps.appendRuntimeEvent(event({
        sessionId: session.id,
        turnId: turn.id,
        name: "tool.completed",
        source: "server",
        action: "openpond_profile_skill_goal",
        appId: session.appId,
        status: "completed",
        output: JSON.stringify({
          ok: true,
          action: "openpond_profile_skill_goal",
          output: result.nextStep,
          data: result,
        }, null, 2),
        data: { tool: "openpond_profile_skill_goal", type: "profile_skill_goal", result },
      }));
      await deps.appendRuntimeEvent(event({
        sessionId: session.id,
        turnId: turn.id,
        name: "assistant.delta",
        source: "server",
        appId: session.appId,
        output: executed.message,
      }));
      await deps.appendRuntimeEvent(event({
        sessionId: session.id,
        turnId: turn.id,
        name: "turn.completed",
        source: "server",
        appId: session.appId,
        status: "completed",
        output: executed.message,
      }));
      return deps.completeTurn(session.id, turn.id, null);
    } catch (error) {
      const message = textFromUnknown(error) || "Profile skill goal failed.";
      await deps.appendRuntimeEvent(event({
        sessionId: session.id,
        turnId: turn.id,
        name: "tool.completed",
        source: "server",
        action: "openpond_profile_skill_goal",
        appId: session.appId,
        status: "failed",
        output: JSON.stringify({
          ok: false,
          action: "openpond_profile_skill_goal",
          output: message,
        }, null, 2),
        error: message,
        data: { tool: "openpond_profile_skill_goal", type: "profile_skill_goal" },
      }));
      await deps.appendRuntimeEvent(event({
        sessionId: session.id,
        turnId: turn.id,
        name: "assistant.delta",
        source: "server",
        appId: session.appId,
        output: message,
      }));
      await deps.appendRuntimeEvent(event({
        sessionId: session.id,
        turnId: turn.id,
        name: "turn.completed",
        source: "server",
        appId: session.appId,
        status: "failed",
        output: message,
      }));
      return deps.failTurn(session, turn.id, message);
    }
  };
}
