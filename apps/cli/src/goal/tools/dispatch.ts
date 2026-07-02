import { Buffer } from "node:buffer";
import { randomUUID } from "node:crypto";
import { isAbsolute, relative, resolve } from "node:path";

import { createGoalApprovalRequest } from "../approvals";
import { createGoalEvent, recordGoalEvent } from "../events";
import { truncateForEvent } from "../redaction";
import type { HostedGoalClient } from "../state/hosted";
import type { GoalStateAdapter } from "../state/adapter";
import type {
  GoalApprovalKind,
  GoalArtifact,
  GoalCheckResult,
  GoalLlmToolCall,
  GoalQuestion,
  GoalState,
} from "../types";
import { createGoalArtifact, recordGoalArtifact } from "./artifacts";
import { runGoalVerificationChecks } from "./checks";
import { listGoalFiles, readGoalPath, writeGoalFile } from "./files";
import { askGoalQuestion } from "./questions";
import { normalizeGoalToolName } from "./registry";
import {
  runAgentSdkCommand,
  runDefaultAgentSdkChecks,
  type AgentSdkCommand,
} from "./sdk-agent";
import { runGoalShellCommand } from "./shell";
import { finalizeCheckedSourceUpdate } from "./source";

type ToolStatus = "ok" | "blocked" | "needs_user_input" | "needs_approval";

export type GoalToolExecutionResult = {
  toolCallId: string;
  name: string;
  status: ToolStatus;
  summary: string;
  output?: Record<string, unknown>;
  checksPassed?: boolean;
};

export type GoalToolExecutionContext = {
  goal: GoalState;
  iterationId: string;
  workspace: string;
  storageRoot?: string | null;
  localState?: GoalStateAdapter | null;
  hostedClient?: HostedGoalClient | null;
};

export async function runGoalLlmToolCall(
  context: GoalToolExecutionContext,
  toolCall: GoalLlmToolCall
): Promise<GoalToolExecutionResult> {
  const normalizedName = normalizeGoalToolName(toolCall.name, toolCall.arguments);
  try {
    return await runKnownTool(context, toolCall, normalizedName);
  } catch (error) {
    const summary =
      error instanceof Error ? error.message : `Tool failed: ${normalizedName}`;
    await recordGoalEvent(
      createGoalEvent({
        goalId: context.goal.id,
        iterationId: context.iterationId,
        kind: "goal.blocked",
        summary,
        payload: {
          toolCallId: toolCall.id,
          toolName: normalizedName,
        },
      }),
      context
    );
    return {
      toolCallId: toolCall.id,
      name: normalizedName,
      status: "blocked",
      summary,
    };
  }
}

async function runKnownTool(
  context: GoalToolExecutionContext,
  toolCall: GoalLlmToolCall,
  normalizedName: string
): Promise<GoalToolExecutionResult> {
  const args = toolCall.arguments;
  if (normalizedName === "files.read") {
    const path = requireString(args, "path");
    const result = await readGoalPath({ workspace: context.workspace, path });
    if (result.type === "directory") {
      return ok(toolCall, normalizedName, `Path is a directory; listed entries: ${path}`, {
        path,
        type: "directory",
        entries: result.entries,
        next: "Use files.read with one of the listed file paths, or files.list for another directory.",
      });
    }
    const content = result.content;
    return ok(toolCall, normalizedName, `Read file: ${path}`, {
      path,
      type: "file",
      contentTail: truncateForEvent(content),
    });
  }

  if (normalizedName === "files.write") {
    const path = requireString(args, "path");
    const content = requireRawString(args, "content");
    const policyBlock = hostedFileWritePolicyBlock(context, path);
    if (policyBlock) {
      await recordGoalEvent(
        createGoalEvent({
          goalId: context.goal.id,
          iterationId: context.iterationId,
          kind: "command.completed",
          summary: policyBlock.summary,
          payload: {
            path: policyBlock.path,
            reason: policyBlock.reason,
            skipped: true,
            next: policyBlock.next,
          },
        }),
        context
      );
      return ok(toolCall, normalizedName, policyBlock.summary, {
        path: policyBlock.path,
        reason: policyBlock.reason,
        skipped: true,
        next: policyBlock.next,
      });
    }
    const result = await writeGoalFile({ workspace: context.workspace, path, content });
    await recordGoalEvent(
      createGoalEvent({
        goalId: context.goal.id,
        iterationId: context.iterationId,
        kind: "source.updated",
        summary: `${result.created ? "Created" : "Updated"} file: ${path}`,
        payload: {
          path,
          created: result.created,
          bytes: Buffer.byteLength(content, "utf-8"),
        },
      }),
      context
    );
    return ok(toolCall, normalizedName, `${result.created ? "Created" : "Updated"} file: ${path}`, result);
  }

  if (normalizedName === "files.list") {
    const path = optionalString(args, "path") || ".";
    const entries = await listGoalFiles({ workspace: context.workspace, path });
    return ok(toolCall, normalizedName, `Listed files: ${path}`, {
      path,
      entries,
    });
  }

  if (normalizedName === "shell.run") {
    const command = requireString(args, "command");
    const policyBlock = hostedShellCommandPolicyBlock(context, command);
    if (policyBlock) {
      await recordGoalEvent(
        createGoalEvent({
          goalId: context.goal.id,
          iterationId: context.iterationId,
          kind: "command.completed",
          summary: policyBlock.summary,
          payload: {
            command: policyBlock.command,
            reason: policyBlock.reason,
            skipped: true,
            next: policyBlock.next,
          },
        }),
        context
      );
      return {
        toolCallId: toolCall.id,
        name: normalizedName,
        status: "ok",
        summary: policyBlock.summary,
        output: {
          reason: policyBlock.reason,
          skipped: true,
          next: policyBlock.next,
        },
      };
    }
    const cwd = resolveToolCwd(context.workspace, optionalString(args, "cwd"));
    const result = await runGoalShellCommand({
      goalId: context.goal.id,
      iterationId: context.iterationId,
      command,
      cwd,
      timeoutSeconds: optionalNumber(args, "timeoutSeconds") ?? undefined,
      workspace: context.workspace,
      storageRoot: context.storageRoot,
      localState: context.localState,
      hostedClient: context.hostedClient,
    });
    const passed = result.code === 0 && !result.timedOut;
    return {
      toolCallId: toolCall.id,
      name: normalizedName,
      status: passed ? "ok" : "blocked",
      summary: passed ? `Command completed: ${command}` : `Command failed: ${command}`,
      output: {
        code: result.code,
        timedOut: result.timedOut,
        stdoutTail: result.stdoutTail,
        stderrTail: result.stderrTail,
      },
    };
  }

  if (normalizedName === "questions.ask") {
    const question = await askGoalQuestion({
      goalId: context.goal.id,
      iterationId: context.iterationId,
      title: requireString(args, "title"),
      reason: requireString(args, "reason"),
      required: optionalBoolean(args, "required") ?? true,
      freeformAllowed: optionalBoolean(args, "freeformAllowed") ?? true,
      options: normalizeQuestionOptions(args.options),
      localState: context.localState,
      hostedClient: context.hostedClient,
    });
    return {
      toolCallId: toolCall.id,
      name: normalizedName,
      status: question.required ? "needs_user_input" : "ok",
      summary: `Question created: ${question.title}`,
      output: { questionId: question.id, required: question.required },
    };
  }

  if (normalizedName === "approvals.request") {
    const kind = normalizeApprovalKind(requireString(args, "kind"));
    const request = createGoalApprovalRequest({
      goal: context.goal,
      kind,
      title: requireString(args, "title"),
      reason: requireString(args, "reason"),
      payload: optionalRecord(args, "payload"),
    });
    if (context.hostedClient) {
      await context.hostedClient.requestApproval(request);
    } else {
      await recordGoalEvent(
        createGoalEvent({
          goalId: context.goal.id,
          iterationId: context.iterationId,
          kind: "approval.requested",
          summary: request.title,
          payload: {
            ...request.payload,
            kind: request.kind,
            reason: request.reason,
          },
        }),
        context
      );
      if (context.localState) {
        const current = await context.localState.get(context.goal.id);
        await context.localState.update({
          ...(current ?? context.goal),
          status: "awaiting_approval",
          approvals: [
            ...((current ?? context.goal).approvals ?? []),
            {
              ...request,
              id: `approval_${randomUUID()}`,
              status: "pending",
              decidedAt: null,
              decisionNote: null,
            },
          ],
          updatedAt: new Date().toISOString(),
        });
      }
    }
    return {
      toolCallId: toolCall.id,
      name: normalizedName,
      status: "needs_approval",
      summary: `Approval requested: ${request.title}`,
      output: {
        kind: request.kind,
      },
    };
  }

  if (normalizedName === "checks.run") {
    const checks = await runGoalVerificationChecks({
      goal: context.goal,
      iterationId: context.iterationId,
      cwd: context.workspace,
      workspace: context.workspace,
      storageRoot: context.storageRoot,
      localState: context.localState,
      hostedClient: context.hostedClient,
    });
    const failed = checks.find((check) => check.status !== "passed");
    return {
      toolCallId: toolCall.id,
      name: normalizedName,
      status: failed ? "blocked" : "ok",
      summary: failed ? "Goal checks failed" : "Goal checks passed",
      output: { checks: compactChecks(checks) },
      checksPassed: !failed,
    };
  }

  if (normalizedName === "artifacts.create") {
    const artifact = createGoalArtifact({
      goalId: context.goal.id,
      iterationId: context.iterationId,
      kind: normalizeArtifactKind(optionalString(args, "kind")),
      name: requireString(args, "name"),
      mimeType: optionalString(args, "mimeType") || "text/plain",
      content: requireRawString(args, "content"),
    });
    const ref = await recordGoalArtifact({
      artifact,
      workspace: context.workspace,
      storageRoot: context.storageRoot,
      localState: context.localState,
      hostedClient: context.hostedClient,
    });
    return ok(toolCall, normalizedName, `Artifact created: ${artifact.name}`, {
      artifactRef: ref.ref,
      artifactId: ref.id,
      bytes: ref.bytes,
    });
  }

  if (normalizedName === "source.finalize") {
    const result = await finalizeCheckedSourceUpdate({
      goal: context.goal,
      iterationId: context.iterationId,
      cwd: context.workspace,
      checksPassed: optionalBoolean(args, "checksPassed") ?? false,
      defaultBranch: optionalString(args, "defaultBranch") || null,
      workspace: context.workspace,
      storageRoot: context.storageRoot,
      localState: context.localState,
      hostedClient: context.hostedClient,
    });
    return {
      toolCallId: toolCall.id,
      name: normalizedName,
      status: result.status === "blocked" ? "blocked" : "ok",
      summary: result.summary,
      output: result,
    };
  }

  if (normalizedName.startsWith("openpond_agent.")) {
    return runAgentTool(context, toolCall, normalizedName);
  }

  throw new Error(`Unsupported goal tool: ${toolCall.name}`);
}

function hostedFileWritePolicyBlock(
  context: GoalToolExecutionContext,
  filePath: string
): { path: string; reason: string; summary: string; next: string } | null {
  if (!context.hostedClient) return null;
  const path = normalizedWorkspaceRelativePath(context.workspace, filePath);
  if (!path) return null;
  if (isHostedProtectedWritePath(path)) {
    return {
      path,
      reason: "hosted_protected_source_path",
      summary: `Skipped write to protected hosted path: ${path}`,
      next:
        "Use normal source files for edits. Do not write generated metadata, dependency directories, git internals, or secret/env files.",
    };
  }
  if (context.goal.profile === "openpond_agent" && path === "openpond.yaml") {
    return {
      path,
      reason: "hosted_openpond_agent_manifest_write_disallowed",
      summary: "Skipped write to generated OpenPond agent manifest: openpond.yaml",
      next:
        "For hosted OpenPond-agent goals, edit agent/** source files and run openpond_agent_* tools. Do not change openpond.yaml directly.",
    };
  }
  return null;
}

function normalizedWorkspaceRelativePath(
  workspace: string,
  filePath: string
): string | null {
  const resolved = resolve(workspace, filePath);
  const rel = relative(workspace, resolved);
  if (!rel || rel.startsWith("..") || isAbsolute(rel)) return null;
  return rel.replace(/\\/g, "/");
}

function isHostedProtectedWritePath(path: string): boolean {
  return (
    path === ".env" ||
    path.startsWith(".env.") ||
    path.includes("/.env") ||
    path === ".git" ||
    path.startsWith(".git/") ||
    path === ".openpond" ||
    path.startsWith(".openpond/") ||
    path === "node_modules" ||
    path.startsWith("node_modules/")
  );
}

function hostedShellCommandPolicyBlock(
  context: GoalToolExecutionContext,
  command: string
): { command: string; reason: string; summary: string; next: string } | null {
  if (!context.hostedClient || context.goal.profile !== "openpond_agent") {
    return null;
  }
  if (!/\bopenpond-agent\b/.test(command)) return null;
  return {
    command,
    reason: "hosted_openpond_agent_shell_disallowed",
    summary:
      "Skipped direct OpenPond agent shell command; use openpond_agent_* tools",
    next:
      "Call openpond_agent_inspect, openpond_agent_build, openpond_agent_validate, openpond_agent_eval, openpond_agent_traces, openpond_agent_run, or openpond_agent_default_checks.",
  };
}

async function runAgentTool(
  context: GoalToolExecutionContext,
  toolCall: GoalLlmToolCall,
  normalizedName: string
): Promise<GoalToolExecutionResult> {
  if (normalizedName === "openpond_agent.default_checks") {
    const results = await runDefaultAgentSdkChecks({
      goalId: context.goal.id,
      iterationId: context.iterationId,
      cwd: context.workspace,
      workspace: context.workspace,
      storageRoot: context.storageRoot,
      localState: context.localState,
      hostedClient: context.hostedClient,
    });
    const failed = results.find((result) => result.code !== 0 || result.timedOut);
    return {
      toolCallId: toolCall.id,
      name: normalizedName,
      status: failed ? "blocked" : "ok",
      summary: failed ? "OpenPond agent SDK checks failed" : "OpenPond agent SDK checks passed",
      output: {
        commands: results.map((result) => ({
          command: result.command,
          code: result.code,
          timedOut: result.timedOut,
        })),
      },
      checksPassed: !failed,
    };
  }

  const sdkCommand = normalizedName.replace("openpond_agent.", "");
  if (!isAgentSdkCommand(sdkCommand)) {
    throw new Error(`Unsupported OpenPond agent SDK command: ${sdkCommand}`);
  }
  const result = await runAgentSdkCommand({
    goalId: context.goal.id,
    iterationId: context.iterationId,
    cwd: context.workspace,
    sdkCommand,
    args: optionalStringArray(toolCall.arguments, "args"),
    json: optionalBoolean(toolCall.arguments, "json") ?? shouldDefaultJson(sdkCommand),
    workspace: context.workspace,
    storageRoot: context.storageRoot,
    localState: context.localState,
    hostedClient: context.hostedClient,
  });
  const passed = result.code === 0 && !result.timedOut;
  return {
    toolCallId: toolCall.id,
    name: normalizedName,
    status: passed ? "ok" : "blocked",
    summary: passed
      ? `openpond-agent ${sdkCommand} completed`
      : `openpond-agent ${sdkCommand} failed`,
    output: {
      code: result.code,
      timedOut: result.timedOut,
      stdoutTail: result.stdoutTail,
      stderrTail: result.stderrTail,
    },
  };
}

function ok(
  toolCall: GoalLlmToolCall,
  name: string,
  summary: string,
  output?: Record<string, unknown>
): GoalToolExecutionResult {
  return {
    toolCallId: toolCall.id,
    name,
    status: "ok",
    summary,
    output,
  };
}

function requireString(args: Record<string, unknown>, key: string): string {
  const value = optionalString(args, key);
  if (!value) throw new Error(`Tool argument ${key} must be a non-empty string`);
  return value;
}

function requireRawString(args: Record<string, unknown>, key: string): string {
  const value = args[key];
  if (typeof value !== "string") {
    throw new Error(`Tool argument ${key} must be a string`);
  }
  return value;
}

function optionalString(args: Record<string, unknown>, key: string): string | null {
  const value = args[key];
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function optionalNumber(args: Record<string, unknown>, key: string): number | null {
  const value = args[key];
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function optionalBoolean(
  args: Record<string, unknown>,
  key: string
): boolean | null {
  const value = args[key];
  return typeof value === "boolean" ? value : null;
}

function optionalStringArray(
  args: Record<string, unknown>,
  key: string
): string[] {
  const value = args[key];
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}

function optionalRecord(
  args: Record<string, unknown>,
  key: string
): Record<string, unknown> {
  const value = args[key];
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return value as Record<string, unknown>;
}

function normalizeQuestionOptions(value: unknown): GoalQuestion["options"] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item): GoalQuestion["options"] => {
    if (!item || typeof item !== "object") return [];
    const record = item as Record<string, unknown>;
    const id = optionalString(record, "id");
    const label = optionalString(record, "label");
    if (!id || !label) return [];
    const description = optionalString(record, "description");
    return [{ id, label, ...(description ? { description } : {}) }];
  });
}

function normalizeApprovalKind(value: string): GoalApprovalKind {
  const allowed = new Set<GoalApprovalKind>([
    "create_plan",
    "deploy_publish",
    "integration_write",
    "secret_or_env_change",
    "budget_escalation",
    "external_effect",
  ]);
  if (!allowed.has(value as GoalApprovalKind)) {
    throw new Error(`Unsupported approval kind: ${value}`);
  }
  return value as GoalApprovalKind;
}

function normalizeArtifactKind(value: string | null): GoalArtifact["kind"] {
  const allowed = new Set<GoalArtifact["kind"]>([
    "command_log",
    "check_log",
    "patch",
    "trace",
    "manifest",
    "result",
  ]);
  return value && allowed.has(value as GoalArtifact["kind"])
    ? (value as GoalArtifact["kind"])
    : "result";
}

function compactChecks(checks: GoalCheckResult[]): Array<Record<string, unknown>> {
  return checks.map((check) => ({
    id: check.id,
    name: check.name,
    status: check.status,
    code: check.code,
    timedOut: check.timedOut,
  }));
}

function resolveToolCwd(workspace: string, cwd?: string | null): string {
  if (!cwd || cwd === ".") return workspace;
  const resolved = resolve(workspace, cwd);
  const rel = relative(workspace, resolved);
  if (rel.startsWith("..") || isAbsolute(rel)) {
    throw new Error(`Tool cwd is outside workspace: ${cwd}`);
  }
  return resolved;
}

function isAgentSdkCommand(value: string): value is AgentSdkCommand {
  return ["inspect", "build", "validate", "eval", "traces", "run"].includes(value);
}

function shouldDefaultJson(command: AgentSdkCommand): boolean {
  return (
    command === "inspect" ||
    command === "eval" ||
    command === "traces" ||
    command === "run"
  );
}
