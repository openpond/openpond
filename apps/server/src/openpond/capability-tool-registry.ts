import type {
  ChatModelRef,
  SubagentIsolationMode,
  SubagentPeerMessages,
  SubagentProgress,
  SubagentReport,
  SubagentRunStatus,
  SubagentRoleSettings,
  SubagentToolPolicy,
  SidebarFileBookmark,
} from "@openpond/contracts";
import { SUBAGENT_ROLE_PRESETS } from "@openpond/contracts";
import type {
  ModelToolDefinition,
  ModelToolExecutionContext,
} from "./model-tool-registry.js";
import type { NativeModelToolResult } from "./native-tool-calls.js";
import {
  createDatasetBuilderModelToolDefinitions,
  type OpenPondDatasetBuilderAction,
} from "./dataset-builder-tool-definitions.js";

export type { OpenPondDatasetBuilderAction } from "./dataset-builder-tool-definitions.js";

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

export type ManageSidebarFileToolInput = {
  action: "pin" | "save_for_later" | "remove" | "list";
  path?: string | null;
};

export type ManageSidebarFileToolResult = {
  items: SidebarFileBookmark[];
  changed: SidebarFileBookmark | null;
  nextStep: string;
};

export function createOpenPondCapabilityModelToolDefinitions(deps: {
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
  manageSidebarFile?: (
    context: ModelToolExecutionContext,
    input: ManageSidebarFileToolInput,
  ) => Promise<ManageSidebarFileToolResult>;
  runDatasetBuilder?: (
    context: ModelToolExecutionContext,
    action: OpenPondDatasetBuilderAction,
    input: Record<string, unknown>,
  ) => Promise<unknown>;
  subagentRoles?: readonly SubagentRoleSettings[];
}): ModelToolDefinition[] {
  const enabledSubagentRoles = (deps.subagentRoles ?? []).filter((role) => role.enabled);
  const definitions: ModelToolDefinition[] = [];
  if (deps.manageSidebarFile) {
    definitions.push({
      name: "manage_sidebar_file",
      description:
        "Pin, save for later, remove, or list workspace files in the user's sidebar. Use only when the user explicitly asks to manage a file in the sidebar.",
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: {
          action: {
            type: "string",
            enum: ["pin", "save_for_later", "remove", "list"],
            description: "The sidebar file action to perform.",
          },
          path: {
            type: "string",
            minLength: 1,
            description: "Workspace-relative file path. Required unless action is list.",
          },
        },
        required: ["action"],
      },
      execute: async (context) => {
        const input = manageSidebarFileToolInput(context.args);
        const result = await deps.manageSidebarFile!(context, input);
        return manageSidebarFileToolResult(context.callId, result);
      },
    });
  }
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
            description: "Whether the parent task should treat this child result as required.",
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
        "Read current status for a subagent run or all child runs under the parent chat.",
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: {
          runId: {
            type: "string",
            minLength: 1,
            description: "Specific subagent run id to inspect.",
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
        "Send a typed runtime-mediated message to a sibling child run or role under the same parent chat, or from a child session back to the parent chat. From a child session, use this for blockers, decision requests, important findings, or final handoffs that should return control to the main agent.",
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
  if (deps.runDatasetBuilder) {
    definitions.push(
      ...createDatasetBuilderModelToolDefinitions(deps.runDatasetBuilder),
    );
  }
  return definitions;
}

function manageSidebarFileToolInput(args: Record<string, unknown>): ManageSidebarFileToolInput {
  const action = args.action;
  if (
    action !== "pin" &&
    action !== "save_for_later" &&
    action !== "remove" &&
    action !== "list"
  ) {
    throw new Error("action must be pin, save_for_later, remove, or list");
  }
  const path = optionalStringArg(args, "path");
  if (action !== "list" && !path) throw new Error("path is required for this action");
  return { action, ...(path ? { path } : {}) };
}

function manageSidebarFileToolResult(
  callId: string,
  result: ManageSidebarFileToolResult,
): NativeModelToolResult {
  return {
    toolCallId: callId,
    name: "manage_sidebar_file",
    ok: true,
    contentText: JSON.stringify(
      {
        ok: true,
        action: "manage_sidebar_file",
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
  return {
    ...(runId ? { runId } : {}),
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
