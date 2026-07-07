import type {
  ChatModelRef,
  CreatePipelineSnapshot,
  SubagentIsolationMode,
  SubagentPeerMessages,
  SubagentRunStatus,
  SubagentToolPolicy,
} from "@openpond/contracts";
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
  action: "start" | "restart" | "pause" | "resume" | "complete" | "stop";
  objective?: string | null;
  targetGoalId?: string | null;
  mode?: "local" | "remote" | "auto" | null;
  reason: string;
};

export type OpenPondGoalControlToolResult = {
  goalId: string;
  action: "start" | "restart" | "pause" | "resume" | "complete" | "stop";
  status: string;
  objective: string;
  mode: "local" | "remote";
  nextStep: string;
};

export type OpenPondSubagentStartToolInput = {
  roleId: string;
  objective: string;
  context?: string | null;
  required?: boolean | null;
};

export type OpenPondSubagentToolResult = {
  runId: string;
  childSessionId: string | null;
  roleId: string;
  status: SubagentRunStatus;
  modelRef: ChatModelRef | null;
  isolationMode: SubagentIsolationMode;
  toolPolicy: SubagentToolPolicy;
  background: boolean;
  peerMessages: SubagentPeerMessages;
  nextStep: string;
};

export type OpenPondSubagentStatusToolInput = {
  runId?: string | null;
  parentGoalId?: string | null;
};

export type OpenPondSubagentStatusToolResult = {
  runs: OpenPondSubagentToolResult[];
  nextStep: string;
};

export type OpenPondSubagentJoinToolInput = {
  runId: string;
};

export type OpenPondSubagentCancelToolInput = {
  runId: string;
  reason?: string | null;
  cleanupWorkspace?: boolean | null;
};

export type OpenPondSubagentMessageToolInput = {
  toRunId?: string | null;
  toRole?: string | null;
  kind: "question" | "answer" | "handoff" | "artifact" | "status" | "blocker";
  priority?: "normal" | "interrupt" | null;
  body: string;
};

export type OpenPondSubagentMessageToolResult = {
  messageId: string;
  delivery: {
    status: "pending" | "delivered" | "undelivered";
    deliveredRunIds: string[];
    acknowledgedRunIds: string[];
    reason: string | null;
  };
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
  startSubagent?: (
    context: ModelToolExecutionContext,
    input: OpenPondSubagentStartToolInput,
  ) => Promise<OpenPondSubagentToolResult>;
  statusSubagents?: (
    context: ModelToolExecutionContext,
    input: OpenPondSubagentStatusToolInput,
  ) => Promise<OpenPondSubagentStatusToolResult>;
  joinSubagent?: (
    context: ModelToolExecutionContext,
    input: OpenPondSubagentJoinToolInput,
  ) => Promise<OpenPondSubagentToolResult>;
  cancelSubagent?: (
    context: ModelToolExecutionContext,
    input: OpenPondSubagentCancelToolInput,
  ) => Promise<OpenPondSubagentToolResult>;
  sendSubagentMessage?: (
    context: ModelToolExecutionContext,
    input: OpenPondSubagentMessageToolInput,
  ) => Promise<OpenPondSubagentMessageToolResult>;
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
        "Start, restart, pause, resume, complete, or stop the current OpenPond goal after resolving the target goal and execution mode from chat context.",
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: {
          action: {
            type: "string",
            enum: ["start", "restart", "pause", "resume", "complete", "stop"],
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
  if (deps.startSubagent) {
    definitions.push({
      name: "openpond_subagent_start",
      description:
        "Start a background specialist child conversation for a bounded role and objective. Use this for independent research, review, testing, planning, docs, or coding subtasks that can report back with receipts.",
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: {
          roleId: {
            type: "string",
            minLength: 1,
            description: "Configured subagent role id such as coding, research, review, test, docs, planner, or summarizer.",
          },
          objective: {
            type: "string",
            minLength: 1,
            description: "Specific child assignment. Keep it scoped enough for one background worker.",
          },
          context: {
            type: "string",
            minLength: 1,
            description: "Optional concise context pack or constraints not obvious from the parent chat.",
          },
          required: {
            type: "boolean",
            description: "Whether parent goal completion should treat this child result as required.",
          },
        },
        required: ["roleId", "objective"],
      },
      execute: async (context) => {
        const input = subagentStartToolInput(context.args);
        const result = await deps.startSubagent!(context, input);
        return subagentToolResult(context.callId, "openpond_subagent_start", result);
      },
    });
  }
  if (deps.statusSubagents) {
    definitions.push({
      name: "openpond_subagent_status",
      description:
        "Read current status for a subagent run or all child runs under a parent goal.",
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: {
          runId: {
            type: "string",
            minLength: 1,
            description: "Specific subagent run id to inspect.",
          },
          parentGoalId: {
            type: "string",
            minLength: 1,
            description: "Goal id whose child runs should be listed.",
          },
        },
      },
      execute: async (context) => {
        const input = subagentStatusToolInput(context.args);
        const result = await deps.statusSubagents!(context, input);
        return subagentStatusToolResult(context.callId, result);
      },
    });
  }
  if (deps.joinSubagent) {
    definitions.push({
      name: "openpond_subagent_join",
      description:
        "Inspect a specific child run report. If the child is still running or blocked, this returns its current receipt state instead of waiting indefinitely.",
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: {
          runId: {
            type: "string",
            minLength: 1,
            description: "Subagent run id to join or inspect.",
          },
        },
        required: ["runId"],
      },
      execute: async (context) => {
        const input = subagentJoinToolInput(context.args);
        const result = await deps.joinSubagent!(context, input);
        return subagentToolResult(context.callId, "openpond_subagent_join", result);
      },
    });
  }
  if (deps.cancelSubagent) {
    definitions.push({
      name: "openpond_subagent_cancel",
      description:
        "Cancel a queued, running, blocked, or needs-resume child subagent run and clean up its isolated workspace when possible.",
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: {
          runId: {
            type: "string",
            minLength: 1,
            description: "Subagent run id to cancel.",
          },
          reason: {
            type: "string",
            minLength: 1,
            description: "Concise cancellation reason.",
          },
          cleanupWorkspace: {
            type: "boolean",
            description: "Defaults to true. Set false only when the isolated child workspace should be retained for manual inspection.",
          },
        },
        required: ["runId"],
      },
      execute: async (context) => {
        const input = subagentCancelToolInput(context.args);
        const result = await deps.cancelSubagent!(context, input);
        return subagentToolResult(context.callId, "openpond_subagent_cancel", result);
      },
    });
  }
  if (deps.sendSubagentMessage) {
    definitions.push({
      name: "openpond_subagent_send_message",
      description:
        "Send a typed runtime-mediated message to a sibling child run or role under the same goal.",
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: {
          toRunId: {
            type: "string",
            minLength: 1,
            description: "Specific child run id to receive the message.",
          },
          toRole: {
            type: "string",
            minLength: 1,
            description: "Role id to receive the message when no exact run id is known.",
          },
          kind: {
            type: "string",
            enum: ["question", "answer", "handoff", "artifact", "status", "blocker"],
            description: "Message kind.",
          },
          priority: {
            type: "string",
            enum: ["normal", "interrupt"],
            description: "Use interrupt only when the receiver should see this steering at the next safe boundary instead of ordinary mailbox priority.",
          },
          body: {
            type: "string",
            minLength: 1,
            description: "Concise message body.",
          },
        },
        required: ["kind", "body"],
      },
      execute: async (context) => {
        const input = subagentMessageToolInput(context.args);
        const result = await deps.sendSubagentMessage!(context, input);
        return subagentMessageToolResult(context.callId, result);
      },
    });
  }
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
    action !== "complete" &&
    action !== "stop"
  ) {
    throw new Error("action must be start, restart, pause, resume, complete, or stop");
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

function subagentStartToolInput(args: Record<string, unknown>): OpenPondSubagentStartToolInput {
  const roleId = stringArg(args, "roleId");
  const objective = stringArg(args, "objective");
  const context = optionalStringArg(args, "context");
  const required = optionalBooleanArg(args, "required");
  return {
    roleId,
    objective,
    ...(context ? { context } : {}),
    ...(required === null ? {} : { required }),
  };
}

function subagentStatusToolInput(args: Record<string, unknown>): OpenPondSubagentStatusToolInput {
  const runId = optionalStringArg(args, "runId");
  const parentGoalId = optionalStringArg(args, "parentGoalId");
  return {
    ...(runId ? { runId } : {}),
    ...(parentGoalId ? { parentGoalId } : {}),
  };
}

function subagentJoinToolInput(args: Record<string, unknown>): OpenPondSubagentJoinToolInput {
  return { runId: stringArg(args, "runId") };
}

function subagentCancelToolInput(args: Record<string, unknown>): OpenPondSubagentCancelToolInput {
  return {
    runId: stringArg(args, "runId"),
    reason: optionalStringArg(args, "reason"),
    cleanupWorkspace: optionalBooleanArg(args, "cleanupWorkspace"),
  };
}

function subagentMessageToolInput(args: Record<string, unknown>): OpenPondSubagentMessageToolInput {
  const kind = args.kind;
  if (
    kind !== "question" &&
    kind !== "answer" &&
    kind !== "handoff" &&
    kind !== "artifact" &&
    kind !== "status" &&
    kind !== "blocker"
  ) {
    throw new Error("kind must be question, answer, handoff, artifact, status, or blocker");
  }
  return {
    toRunId: optionalStringArg(args, "toRunId"),
    toRole: optionalStringArg(args, "toRole"),
    kind,
    priority: subagentMessagePriorityArg(args),
    body: stringArg(args, "body"),
  };
}

function subagentMessagePriorityArg(args: Record<string, unknown>): "normal" | "interrupt" | null {
  const priority = args.priority;
  if (priority === undefined || priority === null || priority === "") return null;
  if (priority === "normal" || priority === "interrupt") return priority;
  throw new Error("priority must be normal or interrupt");
}

function subagentToolResult(
  callId: string,
  name: "openpond_subagent_start" | "openpond_subagent_join" | "openpond_subagent_cancel",
  result: OpenPondSubagentToolResult,
): NativeModelToolResult {
  return {
    toolCallId: callId,
    name,
    ok: true,
    contentText: JSON.stringify(
      {
        ok: true,
        action: name,
        output: result.nextStep,
        data: result,
      },
      null,
      2,
    ),
    data: result,
  };
}

function subagentStatusToolResult(
  callId: string,
  result: OpenPondSubagentStatusToolResult,
): NativeModelToolResult {
  return {
    toolCallId: callId,
    name: "openpond_subagent_status",
    ok: true,
    contentText: JSON.stringify(
      {
        ok: true,
        action: "openpond_subagent_status",
        output: result.nextStep,
        data: result,
      },
      null,
      2,
    ),
    data: result,
  };
}

function subagentMessageToolResult(
  callId: string,
  result: OpenPondSubagentMessageToolResult,
): NativeModelToolResult {
  return {
    toolCallId: callId,
    name: "openpond_subagent_send_message",
    ok: true,
    contentText: JSON.stringify(
      {
        ok: true,
        action: "openpond_subagent_send_message",
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

function optionalBooleanArg(args: Record<string, unknown>, key: string): boolean | null {
  const value = args[key];
  if (value === undefined || value === null) return null;
  if (typeof value !== "boolean") throw new Error(`${key} must be a boolean`);
  return value;
}
