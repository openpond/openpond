import type {
  ProfileSkillCommandResult,
  ProfileSkillGoalExecutionResult,
  ProfileSkillGoalRequest,
} from "@openpond/cloud";
import { executeProfileSkillGoalRequest } from "@openpond/cloud";
import type { RuntimeEvent, Session } from "@openpond/contracts";
import type {
  OpenPondProfileSkillGoalToolInput,
  OpenPondProfileSkillGoalToolResult,
} from "../../openpond/capability-tool-registry.js";
import type { ModelToolExecutionContext } from "../../openpond/model-tool-registry.js";
import { resolveWorkspaceExecutionTarget } from "../../workspace/workspace-execution-target.js";
import { event, textFromUnknown } from "../../utils.js";
import type { TurnRunnerDependencies } from "../turns/ports.js";

export function createProfileSkillGoalRuntime(deps: {
  executeProfileSkillGoal: NonNullable<TurnRunnerDependencies["executeProfileSkillGoal"]> | undefined;
  updateSession: TurnRunnerDependencies["updateSession"];
  appendRuntimeEvent: TurnRunnerDependencies["appendRuntimeEvent"];
}) {
  async function startProfileSkillGoalFromModelTool(
    context: ModelToolExecutionContext,
    input: OpenPondProfileSkillGoalToolInput,
  ): Promise<OpenPondProfileSkillGoalToolResult> {
    if (!deps.executeProfileSkillGoal) {
      throw new Error("Profile skill goal execution is not configured for this turn.");
    }
    if (resolveWorkspaceExecutionTarget({ session: context.session }).target === "sandbox") {
      throw new Error(
        "Profile skill goals are local profile workspace actions and are not supported while Working in Hybrid or sandbox. Use Create Pipeline for hosted agent/workflow changes, or switch Working in to Local before creating or editing profile skills.",
      );
    }
    const objective = input.objective.trim();
    if (!objective) throw new Error("objective is required");
    const command = await deps.executeProfileSkillGoal({
      profileRef: context.session.currentProfile ?? null,
      request: {
        operation: input.operation,
        objective,
        skillName: input.skillName ?? null,
        changeRequest: input.changeRequest ?? null,
        source: input.source ?? "model_tool",
      },
    });
    if (command.handled || command.action !== "goal") {
      throw new Error("Profile skill goal execution did not produce a goal request.");
    }
    await deps.updateSession(context.session.id, { cwd: command.workspaceCwd });
    await deps.appendRuntimeEvent(event({
      sessionId: context.session.id,
      turnId: context.turnId,
      name: "diagnostic",
      source: "provider",
      appId: context.session.appId,
      status: "completed",
      output: "Profile skill goal routed.",
      data: {
        kind: "profile_skill_command",
        action: command.action,
        routing: "goal",
        source: input.source ?? "model_tool",
        goal: command.goal,
        skill: command.skill ?? null,
      },
    }));
    await deps.appendRuntimeEvent(event({
      sessionId: context.session.id,
      turnId: context.turnId,
      name: "diagnostic",
      source: "provider",
      appId: context.session.appId,
      status: "completed",
      output: command.goal.objective,
      data: { kind: "thread_goal", provider: "openpond", goal: command.goal },
    }));
    return profileSkillGoalToolResultFromExecution(await executeProfileSkillGoalForTurn({
      session: context.session,
      turnId: context.turnId,
      command,
      eventSource: "provider",
    }));
  }

  async function executeProfileSkillGoalForTurn(input: {
    session: Session;
    turnId: string;
    command: Extract<ProfileSkillCommandResult, { action: "goal" }>;
    eventSource: RuntimeEvent["source"];
  }): Promise<ProfileSkillGoalExecutionResult> {
    const queuedGoal = input.command.goal;
    await deps.appendRuntimeEvent(event({
      sessionId: input.session.id,
      turnId: input.turnId,
      name: "diagnostic",
      source: input.eventSource,
      appId: input.session.appId,
      status: "completed",
      output: `Creating profile skill: ${queuedGoal.objective}`,
      data: { kind: "thread_goal", provider: "openpond", goal: { ...queuedGoal, status: "running" } },
    }));
    try {
      const executed = await executeProfileSkillGoalRequest(queuedGoal as ProfileSkillGoalRequest);
      await deps.appendRuntimeEvent(event({
        sessionId: input.session.id,
        turnId: input.turnId,
        name: "diagnostic",
        source: input.eventSource,
        appId: input.session.appId,
        status: "completed",
        output: executed.message,
        data: { kind: "thread_goal", provider: "openpond", goal: executed.goal },
      }));
      return executed;
    } catch (error) {
      const message = textFromUnknown(error) || "Profile skill goal failed.";
      await deps.appendRuntimeEvent(event({
        sessionId: input.session.id,
        turnId: input.turnId,
        name: "diagnostic",
        source: input.eventSource,
        appId: input.session.appId,
        status: "failed",
        output: message,
        error: message,
        data: { kind: "thread_goal", provider: "openpond", goal: { ...queuedGoal, status: "failed" } },
      }));
      throw error;
    }
  }

  return {
    executeProfileSkillGoalForTurn,
    profileSkillGoalToolResultFromExecution,
    startProfileSkillGoalFromModelTool,
  };
}

function profileSkillGoalToolResultFromExecution(
  executed: ProfileSkillGoalExecutionResult,
): OpenPondProfileSkillGoalToolResult {
  return {
    goalId: executed.goal.id,
    operation: executed.goal.operation,
    targetSkillName: executed.goal.targetSkillName,
    targetSkillPath: executed.goal.targetSkillPath,
    status: executed.goal.status,
    nextStep: executed.message,
    validationStatus: executed.validationStatus,
    validationMessages: executed.validationMessages,
    invocation: executed.invocation,
  };
}
