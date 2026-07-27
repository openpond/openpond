import { realpath } from "node:fs/promises";
import path from "node:path";
import { runAgentSdkProjectCommand } from "@openpond/cloud";
import type {
  OpenPondProfileRef,
  OpenPondProfileState,
} from "@openpond/contracts";
import type {
  ModelToolDefinition,
  ModelToolExecutionContext,
} from "./model-tool-registry.js";
import type { NativeModelToolResult } from "./native-tool-calls.js";

type LoadProfileState = (
  ref: OpenPondProfileRef | null | undefined,
) => Promise<OpenPondProfileState>;

type AgentSdkToolName =
  | "agent_inspect"
  | "agent_build"
  | "agent_validate"
  | "agent_eval"
  | "agent_run"
  | "agent_traces"
  | "agent_check";

type AgentSdkCommand = "inspect" | "build" | "validate" | "eval" | "run" | "traces";

export function createAuthoringModelToolDefinitions(deps: {
  loadProfileState?: LoadProfileState;
}): ModelToolDefinition[] {
  const definitions: ModelToolDefinition[] = [askUserDefinition()];
  if (!deps.loadProfileState) return definitions;
  definitions.push(
    getProfileDefinition(deps.loadProfileState),
    agentCommandDefinition(deps.loadProfileState, "agent_inspect", "inspect"),
    agentCommandDefinition(deps.loadProfileState, "agent_build", "build"),
    agentCommandDefinition(deps.loadProfileState, "agent_validate", "validate"),
    agentCommandDefinition(deps.loadProfileState, "agent_eval", "eval"),
    agentRunDefinition(deps.loadProfileState),
    agentCommandDefinition(deps.loadProfileState, "agent_traces", "traces"),
    agentCheckDefinition(deps.loadProfileState),
  );
  return definitions;
}

function askUserDefinition(): ModelToolDefinition {
  return {
    name: "ask_user",
    description:
      "Ask one blocking user question when the answer materially changes the requested work and cannot be inferred safely. This call ends the current model turn after persisting the question; do not batch it with mutations.",
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        question: { type: "string", minLength: 1, maxLength: 2_000 },
        reason: { type: "string", minLength: 1, maxLength: 1_000 },
        options: {
          type: "array",
          minItems: 2,
          maxItems: 5,
          items: {
            type: "object",
            additionalProperties: false,
            properties: {
              id: { type: "string", minLength: 1, maxLength: 80 },
              label: { type: "string", minLength: 1, maxLength: 160 },
              description: { type: "string", minLength: 1, maxLength: 500 },
            },
            required: ["id", "label"],
          },
        },
        allowFreeform: { type: "boolean" },
      },
      required: ["question"],
    },
    execute: async (context) => {
      const question = stringArg(context.args, "question");
      const reason = optionalStringArg(context.args, "reason");
      const options = arrayArg(context.args, "options")
        .map((value) => recordArg(value))
        .filter((value): value is Record<string, unknown> => Boolean(value))
        .map((value) => ({
          id: stringArg(value, "id"),
          label: stringArg(value, "label"),
          description: optionalStringArg(value, "description"),
        }));
      const data = {
        questionId: `question_${context.turnId}_${context.callId}`,
        question,
        reason,
        options,
        allowFreeform: context.args.allowFreeform !== false,
        status: "awaiting_user_input",
        nextStep: "end_turn",
      };
      return {
        ...modelResult(
          context.callId,
          "ask_user",
          true,
          question,
          data,
        ),
        turnControl: "await_user_input",
      };
    },
  };
}

function getProfileDefinition(loadProfileState: LoadProfileState): ModelToolDefinition {
  return {
    name: "get_profile",
    description:
      "Return the exact OpenPond Profile selected for this chat turn, including bounded local path, Skill, Agent, action, and Git context. Call before Profile authoring. This tool does not change the selected Profile or grant filesystem permission.",
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {},
    },
    execute: async (context) => {
      const profileRef = selectedProfileRef(context);
      const profile = await loadProfileState(profileRef);
      const data = profileProjection(profile, context.turnMetadata, profileRef);
      return modelResult(context.callId, "get_profile", !profile.error, profile.error ?? "Resolved selected Profile.", data);
    },
  };
}

function agentCommandDefinition(
  loadProfileState: LoadProfileState,
  toolName: Exclude<AgentSdkToolName, "agent_run" | "agent_check">,
  command: Exclude<AgentSdkCommand, "run">,
): ModelToolDefinition {
  return {
    name: toolName,
    description: agentToolDescription(toolName),
    parameters: agentTargetParameters(),
    execute: async (context) => {
      const target = await resolveAgentTarget(loadProfileState, context);
      const result = await executeAgentCommand(command, target.cwd);
      return modelResult(
        context.callId,
        toolName,
        result.code === 0 && !result.timedOut,
        result.code === 0 && !result.timedOut
          ? `${toolName} passed for ${target.agentId}.`
          : `${toolName} failed for ${target.agentId}.`,
        { agentId: target.agentId, cwd: target.cwd, command, ...commandReceipt(result) },
      );
    },
  };
}

function agentRunDefinition(loadProfileState: LoadProfileState): ModelToolDefinition {
  return {
    name: "agent_run",
    description:
      "Run one declared action on an exact enabled Profile Agent with typed JSON input. Use for behavioral proof, not as the default validation gate.",
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        agentId: { type: "string", minLength: 1 },
        action: { type: "string", minLength: 1 },
        input: { type: "object", additionalProperties: true },
      },
      required: ["agentId", "action"],
    },
    execute: async (context) => {
      const target = await resolveAgentTarget(loadProfileState, context);
      const action = stringArg(context.args, "action");
      const actionInput = recordArg(context.args, "input") ?? {};
      const result = await runAgentSdkProjectCommand({
        command: "run",
        args: [action, "--json", "--input", JSON.stringify(actionInput), "--cwd", target.cwd],
        cwd: target.cwd,
        timeoutMs: 120_000,
        maxOutputBytes: 250_000,
        throwOnFailure: false,
      });
      return modelResult(
        context.callId,
        "agent_run",
        result.code === 0 && !result.timedOut,
        result.code === 0 && !result.timedOut
          ? `Action ${action} passed for ${target.agentId}.`
          : `Action ${action} failed for ${target.agentId}.`,
        {
          agentId: target.agentId,
          cwd: target.cwd,
          action,
          input: actionInput,
          ...commandReceipt(result),
        },
      );
    },
  };
}

function agentCheckDefinition(loadProfileState: LoadProfileState): ModelToolDefinition {
  return {
    name: "agent_check",
    description:
      "Run the mandatory Agent authoring gate—inspect, build, validate, and eval—in order for one exact Profile Agent. Stops on the first failure and returns bounded per-step receipts.",
    parameters: agentTargetParameters(),
    execute: async (context) => {
      const target = await resolveAgentTarget(loadProfileState, context);
      const steps: Array<{ command: "inspect" | "build" | "validate" | "eval"; receipt: unknown }> = [];
      for (const command of ["inspect", "build", "validate", "eval"] as const) {
        const result = await executeAgentCommand(command, target.cwd);
        const receipt = commandReceipt(result);
        steps.push({ command, receipt });
        if (result.code !== 0 || result.timedOut) {
          return modelResult(
            context.callId,
            "agent_check",
            false,
            `agent_check stopped at ${command} for ${target.agentId}.`,
            { agentId: target.agentId, cwd: target.cwd, passed: false, failedStep: command, steps },
          );
        }
      }
      return modelResult(
        context.callId,
        "agent_check",
        true,
        `agent_check passed for ${target.agentId}.`,
        { agentId: target.agentId, cwd: target.cwd, passed: true, failedStep: null, steps },
      );
    },
  };
}

async function resolveAgentTarget(
  loadProfileState: LoadProfileState,
  context: ModelToolExecutionContext,
): Promise<{ profile: OpenPondProfileState; agentId: string; cwd: string }> {
  const agentId = stringArg(context.args, "agentId");
  const profile = await loadProfileState(selectedProfileRef(context));
  assertEditableProfile(profile);
  const authoring = recordArg(context.turnMetadata, "authoringIntent");
  if (
    authoring?.artifact === "agent" &&
    authoring.operation === "improve" &&
    typeof authoring.targetAgentId === "string" &&
    authoring.targetAgentId !== agentId
  ) {
    throw new Error(`Agent improve is bound to ${authoring.targetAgentId}; ${agentId} is not authorized.`);
  }
  const agent = profile.agents.find((candidate) => candidate.id === agentId);
  if (!agent?.enabled) throw new Error(`Enabled Profile Agent not found: ${agentId}`);
  const candidate = agentId === "default"
    ? profile.sourcePath!
    : path.resolve(profile.sourcePath!, "agents", agentId);
  const canonicalRoot = await realpath(profile.sourcePath!);
  const canonicalTarget = await realpath(candidate).catch(() => null);
  if (!canonicalTarget) throw new Error(`Profile Agent source does not exist: ${agentId}`);
  if (!isWithin(canonicalRoot, canonicalTarget)) {
    throw new Error(`Profile Agent source escapes the selected Profile: ${agentId}`);
  }
  return { profile, agentId, cwd: canonicalTarget };
}

async function executeAgentCommand(
  command: Exclude<AgentSdkCommand, "run">,
  cwd: string,
) {
  const json = command === "inspect" || command === "validate" || command === "eval" || command === "traces";
  return runAgentSdkProjectCommand({
    command,
    args: json ? ["--json"] : [],
    cwd,
    timeoutMs: command === "eval" ? 180_000 : 120_000,
    maxOutputBytes: 250_000,
    throwOnFailure: false,
  });
}

function assertEditableProfile(
  profile: OpenPondProfileState,
): asserts profile is OpenPondProfileState & { mode: "local"; repoPath: string; sourcePath: string } {
  if (profile.error) throw new Error(profile.error);
  if (profile.mode !== "local" || !profile.repoPath || !profile.sourcePath) {
    throw new Error("The selected OpenPond Profile is not locally editable.");
  }
}

function profileProjection(
  profile: OpenPondProfileState,
  turnMetadata: Record<string, unknown>,
  ref: OpenPondProfileRef | null,
) {
  const changedPaths = profile.git?.files.slice(0, 200).map((file) => file.path) ?? [];
  return {
    mode: profile.mode,
    editable: profile.mode === "local" && Boolean(profile.repoPath && profile.sourcePath) && !profile.error,
    blockedReason: profile.error ?? (
      profile.mode === "local" && profile.repoPath && profile.sourcePath
        ? null
        : "The selected Profile is not locally editable."
    ),
    ref,
    activeProfile: profile.activeProfile,
    repoPath: profile.repoPath,
    sourcePath: profile.sourcePath,
    manifestPath: profile.manifestPath,
    authoring: recordArg(turnMetadata, "authoringIntent"),
    skills: profile.skills.slice(0, 200).map((skill) => ({
      name: skill.name,
      description: skill.description,
      path: skill.path,
      sourcePath: skill.sourcePath,
      enabled: skill.enabled,
      validationStatus: skill.validationStatus,
    })),
    agents: profile.agents.slice(0, 200).map((agent) => ({
      id: agent.id,
      name: agent.name,
      path: agent.path,
      enabled: agent.enabled,
      actionNames: profile.actionCatalog
        .filter((action) => action.agentId === agent.id)
        .slice(0, 100)
        .map((action) => action.id),
    })),
    git: profile.git
      ? {
          branch: profile.git.branch,
          head: profile.git.head,
          dirty: profile.git.dirty,
          changedPaths,
          truncated: profile.git.files.length > changedPaths.length,
        }
      : null,
  };
}

function selectedProfileRef(context: ModelToolExecutionContext): OpenPondProfileRef | null {
  const selected = recordArg(context.turnMetadata, "selectedProfileRef");
  if (
    selected &&
    (selected.source === "local" || selected.source === "github" || selected.source === "openpond_git") &&
    typeof selected.repositoryId === "string" &&
    selected.repositoryId.trim() &&
    typeof selected.profileId === "string" &&
    selected.profileId.trim()
  ) {
    return {
      source: selected.source,
      repositoryId: selected.repositoryId,
      profileId: selected.profileId,
    };
  }
  return context.session.currentProfile ?? null;
}

function agentTargetParameters(): Record<string, unknown> {
  return {
    type: "object",
    additionalProperties: false,
    properties: {
      agentId: {
        type: "string",
        minLength: 1,
        description: "Exact enabled Agent ID from get_profile.",
      },
    },
    required: ["agentId"],
  };
}

function agentToolDescription(toolName: string): string {
  const command = toolName.replace(/^agent_/, "");
  return `Run OpenPond Agent SDK ${command} for one exact enabled Agent beneath the selected Profile and return a bounded structured receipt.`;
}

function commandReceipt(result: Awaited<ReturnType<typeof runAgentSdkProjectCommand>>) {
  return {
    code: result.code,
    timedOut: result.timedOut,
    stdout: parseJsonOrText(result.stdout),
    stderr: result.stderr,
    stdoutTruncated: result.stdoutTruncated,
    stderrTruncated: result.stderrTruncated,
  };
}

function parseJsonOrText(value: string): unknown {
  const trimmed = value.trim();
  if (!trimmed) return "";
  try {
    return JSON.parse(trimmed);
  } catch {
    return trimmed;
  }
}

function modelResult(
  callId: string,
  name: string,
  ok: boolean,
  output: string,
  data: unknown,
): NativeModelToolResult {
  return {
    toolCallId: callId,
    name,
    ok,
    contentText: JSON.stringify({ ok, action: name, output, data }, null, 2),
    data,
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

function arrayArg(args: Record<string, unknown>, key: string): unknown[] {
  const value = args[key];
  return Array.isArray(value) ? value : [];
}

function recordArg(value: unknown, key?: string): Record<string, unknown> | null {
  const candidate = key && value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)[key]
    : value;
  return candidate && typeof candidate === "object" && !Array.isArray(candidate)
    ? candidate as Record<string, unknown>
    : null;
}

function isWithin(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}
