import type {
  ChatModelRef,
  CreateImproveRun,
  SubagentIsolationMode,
  SubagentPeerMessages,
  SubagentProgress,
  SubagentReport,
  SubagentRunStatus,
  SubagentRoleSettings,
  SubagentToolPolicy,
} from "@openpond/contracts";
import { SUBAGENT_ROLE_PRESETS } from "@openpond/contracts";
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
  runId: string;
  operation: CreateImproveRun["operation"];
  state: CreateImproveRun["state"];
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
  progress?: SubagentProgress;
  report?: SubagentReport | null;
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

export type OpenPondSubagentFollowupToolInput = {
  runId: string;
  message: string;
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
    deliveredParentSessionId?: string | null;
    acknowledgedParentSessionId?: string | null;
    wakeRequestedParentSessionId?: string | null;
    wakeQueuedParentSessionId?: string | null;
    wakeDeferredParentSessionId?: string | null;
    wakeParentReason?: string | null;
    wakeRequestedRunIds?: string[];
    wakeInterruptedRunIds?: string[];
    wakeDeferredRunIds?: string[];
    reason: string | null;
  };
  nextStep: string;
};

export function createOpenPondCapabilityModelToolDefinitions(deps: {
  startCreateImprove: (
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
  followupSubagent?: (
    context: ModelToolExecutionContext,
    input: OpenPondSubagentFollowupToolInput,
  ) => Promise<OpenPondSubagentToolResult>;
  sendSubagentMessage?: (
    context: ModelToolExecutionContext,
    input: OpenPondSubagentMessageToolInput,
  ) => Promise<OpenPondSubagentMessageToolResult>;
  subagentRoles?: readonly SubagentRoleSettings[];
}): ModelToolDefinition[] {
  const enabledSubagentRoles = (deps.subagentRoles ?? []).filter((role) => role.enabled);
  const definitions: ModelToolDefinition[] = [
    {
      name: "openpond_create_improve",
      description:
        "Start the OpenPond Create/Improve workflow for a source-backed workproduct after interpreting the user's request.",
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
            description: "The user-facing Create/Improve objective to plan.",
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
        const result = await deps.startCreateImprove(context, input);
        return createPipelineToolResult(context.callId, result);
      },
    },
    {
      name: "openpond_goal_control",
      description:
        "Start a goal only when the thread has no nonterminal goal, or restart, pause, resume, complete, or stop the current goal. Never use start from a goal continuation; control the supplied goal id instead. Omit targetGoalId when action is start because a new goal has no id yet.",
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
            description: "Goal id to control when the current chat context is not enough. Omit this field when action is start.",
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
        "Start an addressable specialist child conversation for a bounded role and objective. Use this for independent research, review, testing, planning, docs, or coding subtasks; the child can later hand important findings back to the parent through openpond_subagent_send_message.",
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: {
          roleId: {
            type: "string",
            minLength: 1,
            ...(enabledSubagentRoles.length > 0 ? { enum: enabledSubagentRoles.map((role) => role.id) } : {}),
            description: subagentRoleCatalogDescription(enabledSubagentRoles),
          },
          objective: {
            type: "string",
            minLength: 1,
            description: "Specific child assignment. The child owns its thread and returns one final result.",
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
        "Wait up to 60 seconds for a specific child and return its final result when available. Call once when you need the result; do not poll or add shell sleeps.",
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
  if (deps.followupSubagent) {
    definitions.push({
      name: "openpond_subagent_followup",
      description:
        "Send a follow-up task to an existing child conversation. If it is idle, start a new turn in that same thread; if it is running, queue the message for its next safe model boundary.",
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: {
          runId: {
            type: "string",
            minLength: 1,
            description: "Existing child run id returned by openpond_subagent_start.",
          },
          message: {
            type: "string",
            minLength: 1,
            description: "The next task or correction for the existing child thread.",
          },
        },
        required: ["runId", "message"],
      },
      execute: async (context) => {
        const input = subagentFollowupToolInput(context.args);
        const result = await deps.followupSubagent!(context, input);
        return subagentToolResult(context.callId, "openpond_subagent_followup", result);
      },
    });
  }
  if (deps.sendSubagentMessage) {
    definitions.push({
      name: "openpond_subagent_send_message",
      description:
        "Send a typed runtime-mediated message to a sibling child run/role under the same goal, or from a child session back to the parent chat. From a child session, use this for blockers, decision requests, important findings, or final handoffs that should return control to the main agent.",
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: {
          toRunId: {
            type: "string",
            minLength: 1,
            description: "Specific child run id to receive the message. From a child session, omit target fields or use the parent session id to send to the parent chat and wake the main agent when idle.",
          },
          toRole: {
            type: "string",
            minLength: 1,
            description: "Role id to receive the message when no exact run id is known. From a child session, omit target fields or use parent to send to the parent chat and wake the main agent when idle.",
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

function subagentRoleCatalogDescription(roles: readonly SubagentRoleSettings[]): string {
  if (roles.length === 0) {
    return "Configured subagent role id. The runtime validates that the selected role is enabled.";
  }
  const presetById = new Map(SUBAGENT_ROLE_PRESETS.map((preset) => [preset.id, preset]));
  const catalog = roles.map((role) => {
    const preset = presetById.get(role.id as (typeof SUBAGENT_ROLE_PRESETS)[number]["id"]);
    const model = role.modelRef
      ? `${role.modelRef.providerId}/${role.modelRef.modelId}`
      : "configured default or parent model";
    const purpose = preset?.description ?? "Run the configured bounded specialist assignment.";
    return `${role.id}: ${purpose} Capabilities: ${role.toolPolicy}, ${role.isolationMode}, ${role.background ? "background" : "foreground"}, ${role.peerMessages} peer messages, model ${model}.`;
  });
  return `Enabled subagent roles: ${catalog.join(" ")}`;
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

function subagentFollowupToolInput(args: Record<string, unknown>): OpenPondSubagentFollowupToolInput {
  return {
    runId: stringArg(args, "runId"),
    message: stringArg(args, "message"),
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
  name:
    | "openpond_subagent_start"
    | "openpond_subagent_join"
    | "openpond_subagent_cancel"
    | "openpond_subagent_followup",
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
    name: "openpond_create_improve",
    ok: true,
    contentText: JSON.stringify(
      {
        ok: true,
        action: "openpond_create_improve",
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
