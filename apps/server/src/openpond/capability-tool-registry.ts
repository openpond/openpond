import type { CreatePipelineSnapshot } from "@openpond/contracts";
import type {
  ModelToolDefinition,
  ModelToolExecutionContext,
} from "./model-tool-registry.js";
import type { NativeModelToolResult } from "./native-tool-calls.js";

export type OpenPondCreatePipelineToolInput = {
  operation: "create" | "edit";
  objective: string;
  targetAgentId?: string | null;
  source?: "natural_language" | "model_tool" | null;
};

export type OpenPondCreatePipelineToolResult = {
  requestId: string;
  pipelineId: string;
  operation: "create" | "edit";
  state: CreatePipelineSnapshot["state"];
  nextStep: string;
};

export type OpenPondProfileSkillGoalToolInput = {
  operation: "create" | "edit";
  objective: string;
  skillName?: string | null;
  changeRequest?: string | null;
  source?: "natural_language" | "model_tool" | null;
};

export type OpenPondProfileSkillGoalToolResult = {
  goalId: string;
  operation: "create" | "edit";
  targetSkillName: string | null;
  targetSkillPath: string | null;
  status: string;
  nextStep: string;
  validationStatus?: string;
  validationMessages?: string[];
  invocation?: string;
};

export type OpenPondGoalControlToolInput = {
  action: "start" | "restart" | "pause" | "resume" | "stop";
  objective?: string | null;
  targetGoalId?: string | null;
  mode?: "local" | "remote" | "auto" | null;
  reason: string;
};

export type OpenPondGoalControlToolResult = {
  goalId: string;
  action: "start" | "restart" | "pause" | "resume" | "stop";
  status: string;
  objective: string;
  mode: "local" | "remote";
  nextStep: string;
};

export function createOpenPondCapabilityModelToolDefinitions(deps: {
  startCreatePipeline: (
    context: ModelToolExecutionContext,
    input: OpenPondCreatePipelineToolInput,
  ) => Promise<OpenPondCreatePipelineToolResult>;
  startProfileSkillGoal?: (
    context: ModelToolExecutionContext,
    input: OpenPondProfileSkillGoalToolInput,
  ) => Promise<OpenPondProfileSkillGoalToolResult>;
  startGoalControl: (
    context: ModelToolExecutionContext,
    input: OpenPondGoalControlToolInput,
  ) => Promise<OpenPondGoalControlToolResult>;
}): ModelToolDefinition[] {
  const definitions: ModelToolDefinition[] = [
    {
      name: "openpond_create_pipeline",
      description:
        "Start the OpenPond Create Pipeline workflow to create or edit a source-backed agent or workflow after interpreting the user's request.",
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: {
          operation: {
            type: "string",
            enum: ["create", "edit"],
            description: "Use create for new agents/workflows and edit for an existing selected or targeted agent.",
          },
          objective: {
            type: "string",
            minLength: 1,
            description: "The user-facing create/edit objective to plan.",
          },
          targetAgentId: {
            type: "string",
            minLength: 1,
            description: "Required for edit unless the current chat has exactly one selected target agent.",
          },
          source: {
            type: "string",
            enum: ["natural_language", "model_tool"],
            description: "Optional routing source for diagnostics.",
          },
        },
        required: ["operation", "objective"],
      },
      execute: async (context) => {
        const input = createPipelineToolInput(context.args);
        const result = await deps.startCreatePipeline(context, input);
        return createPipelineToolResult(context.callId, result);
      },
    },
    {
      name: "openpond_goal_control",
      description:
        "Start, restart, pause, resume, or stop the current OpenPond goal after resolving the target goal and execution mode from chat context.",
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: {
          action: {
            type: "string",
            enum: ["start", "restart", "pause", "resume", "stop"],
            description: "Goal lifecycle action to perform after interpreting the user's request.",
          },
          objective: {
            type: "string",
            minLength: 1,
            description: "Required for start. Optional replacement objective for restart.",
          },
          targetGoalId: {
            type: "string",
            minLength: 1,
            description: "Goal id to control when the current chat context is not enough.",
          },
          mode: {
            type: "string",
            enum: ["local", "remote", "auto"],
            description: "Use auto unless the user or current chat context clearly selects local or remote execution.",
          },
          reason: {
            type: "string",
            minLength: 1,
            description: "Concise reason for this lifecycle control action.",
          },
        },
        required: ["action", "reason"],
      },
      execute: async (context) => {
        const input = goalControlToolInput(context.args);
        const result = await deps.startGoalControl(context, input);
        return goalControlToolResult(context.callId, result);
      },
    },
  ];
  if (deps.startProfileSkillGoal) {
    definitions.push({
      name: "openpond_profile_skill_goal",
      description:
        "Start the OpenPond profile-skill goal workflow to create or edit a single-file profile-backed SKILL.md after deciding that a skill is appropriate.",
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: {
          operation: {
            type: "string",
            enum: ["create", "edit"],
            description: "Use create for a new profile skill and edit for an existing profile skill.",
          },
          objective: {
            type: "string",
            minLength: 1,
            description: "The user-facing skill creation or edit objective.",
          },
          skillName: {
            type: "string",
            minLength: 1,
            description: "Lowercase kebab-case skill name. Required for edit; optional for create.",
          },
          changeRequest: {
            type: "string",
            minLength: 1,
            description: "Specific edit request for an existing skill. Defaults to objective for edit.",
          },
          source: {
            type: "string",
            enum: ["natural_language", "model_tool"],
            description: "Optional routing source for diagnostics.",
          },
        },
        required: ["operation", "objective"],
      },
      execute: async (context) => {
        const input = profileSkillGoalToolInput(context.args);
        const result = await deps.startProfileSkillGoal!(context, input);
        return profileSkillGoalToolResult(context.callId, result);
      },
    });
  }
  return definitions;
}

function goalControlToolInput(args: Record<string, unknown>): OpenPondGoalControlToolInput {
  const action = args.action;
  if (
    action !== "start" &&
    action !== "restart" &&
    action !== "pause" &&
    action !== "resume" &&
    action !== "stop"
  ) {
    throw new Error("action must be start, restart, pause, resume, or stop");
  }
  const objective = optionalStringArg(args, "objective");
  const targetGoalId = optionalStringArg(args, "targetGoalId");
  const mode = args.mode;
  if (mode !== undefined && mode !== null && mode !== "local" && mode !== "remote" && mode !== "auto") {
    throw new Error("mode must be local, remote, or auto");
  }
  return {
    action,
    ...(objective ? { objective } : {}),
    ...(targetGoalId ? { targetGoalId } : {}),
    ...(mode ? { mode } : {}),
    reason: stringArg(args, "reason"),
  };
}

function goalControlToolResult(
  callId: string,
  result: OpenPondGoalControlToolResult,
): NativeModelToolResult {
  return {
    toolCallId: callId,
    name: "openpond_goal_control",
    ok: true,
    contentText: JSON.stringify(
      {
        ok: true,
        action: "openpond_goal_control",
        output: result.nextStep,
        data: result,
      },
      null,
      2,
    ),
    data: result,
  };
}

function createPipelineToolInput(args: Record<string, unknown>): OpenPondCreatePipelineToolInput {
  const operation = args.operation;
  if (operation !== "create" && operation !== "edit") {
    throw new Error("operation must be create or edit");
  }
  const objective = stringArg(args, "objective");
  const targetAgentId = optionalStringArg(args, "targetAgentId");
  const source = args.source;
  if (source !== undefined && source !== null && source !== "natural_language" && source !== "model_tool") {
    throw new Error("source must be natural_language or model_tool");
  }
  return {
    operation,
    objective,
    ...(targetAgentId ? { targetAgentId } : {}),
    ...(source ? { source } : {}),
  };
}

function createPipelineToolResult(
  callId: string,
  result: OpenPondCreatePipelineToolResult,
): NativeModelToolResult {
  return {
    toolCallId: callId,
    name: "openpond_create_pipeline",
    ok: true,
    contentText: JSON.stringify(
      {
        ok: true,
        action: "openpond_create_pipeline",
        output: result.nextStep,
        data: result,
      },
      null,
      2,
    ),
    data: result,
  };
}

function profileSkillGoalToolInput(args: Record<string, unknown>): OpenPondProfileSkillGoalToolInput {
  const operation = args.operation;
  if (operation !== "create" && operation !== "edit") {
    throw new Error("operation must be create or edit");
  }
  const objective = stringArg(args, "objective");
  const skillName = optionalStringArg(args, "skillName");
  const changeRequest = optionalStringArg(args, "changeRequest");
  const source = args.source;
  if (source !== undefined && source !== null && source !== "natural_language" && source !== "model_tool") {
    throw new Error("source must be natural_language or model_tool");
  }
  return {
    operation,
    objective,
    ...(skillName ? { skillName } : {}),
    ...(changeRequest ? { changeRequest } : {}),
    ...(source ? { source } : {}),
  };
}

function profileSkillGoalToolResult(
  callId: string,
  result: OpenPondProfileSkillGoalToolResult,
): NativeModelToolResult {
  return {
    toolCallId: callId,
    name: "openpond_profile_skill_goal",
    ok: true,
    contentText: JSON.stringify(
      {
        ok: true,
        action: "openpond_profile_skill_goal",
        output: result.nextStep,
        data: result,
      },
      null,
      2,
    ),
    data: result,
  };
}

function stringArg(args: Record<string, unknown>, key: string): string {
  const value = args[key];
  if (typeof value !== "string" || !value.trim()) throw new Error(`${key} is required`);
  return value.trim();
}

function optionalStringArg(args: Record<string, unknown>, key: string): string | null {
  const value = args[key];
  return typeof value === "string" && value.trim() ? value.trim() : null;
}
