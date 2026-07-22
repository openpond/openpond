import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { parse as parseShellCommand } from "shell-quote";
import {
  DEFAULT_OPENPOND_COMMAND_ACCESS_MODE,
  ResolveApprovalRequestSchema,
  type Approval,
  type ResolveApprovalRequest,
  type RuntimeEvent,
  type Session,
} from "@openpond/contracts";
import { event, now } from "../utils.js";
import { resolveWorkspaceExecutionTarget } from "../workspace/workspace-execution-target.js";
import { pipefailLocalShellCommand } from "./shell-command.js";

const DEFAULT_COMMAND_TIMEOUT_SECONDS = 120;
const MAX_COMMAND_TIMEOUT_SECONDS = 3600;
const MAX_COMMAND_OUTPUT_CHARS = 60_000;
const MODEL_COMMAND_OUTPUT_CHARS = 20_000;
const SELECT_PROJECT_MESSAGE = "Select a project to use this.";

export type OpenPondCommandRequestSource = "model_tool" | "direct_command";

export type OpenPondCommandExecutionInput = {
  session: Session;
  turnId?: string | null;
  providerRequestId?: string | number | null;
  command: string;
  cwd?: string | null;
  timeoutSeconds?: number | null;
  source: OpenPondCommandRequestSource;
  signal?: AbortSignal;
};

export type OpenPondCommandRunResult = {
  ok: boolean;
  command: string;
  cwd: string | null;
  exitCode: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  timeoutSeconds: number;
  truncated: boolean;
  blockedReason: string | null;
};

type PendingCommandApproval = {
  approval: Approval;
  family: CommandFamily;
  resolve: (decision: ResolveApprovalRequest["decision"]) => void;
};

type CommandFamily = {
  key: string;
  label: string;
  broad: boolean;
  reason: string;
};

export function createOpenPondCommandAccessService(deps: {
  upsertApproval: (approval: Approval) => Promise<void>;
  appendRuntimeEvent: (runtimeEvent: RuntimeEvent) => Promise<void>;
}) {
  const { upsertApproval, appendRuntimeEvent } = deps;
  const pendingApprovals = new Map<string, PendingCommandApproval>();
  const acceptedSessionFamilies = new Set<string>();

  async function executeCommand(input: OpenPondCommandExecutionInput): Promise<OpenPondCommandRunResult> {
    const command = input.command.trim();
    if (!command) {
      return blockedCommandResult(command, null, "Command is empty.", normalizedTimeout(input.timeoutSeconds));
    }
    const timeoutSeconds = normalizedTimeout(input.timeoutSeconds);
    const target = resolveWorkspaceExecutionTarget({ session: input.session });
    const cwd = resolveCommandCwd({ requestedCwd: input.cwd, session: input.session });
    const explicitCwd = Boolean(input.cwd?.trim() && path.isAbsolute(input.cwd.trim()));
    if (target.target === "sandbox" || !cwd || (target.target !== "local" && !explicitCwd)) {
      return blockedCommandResult(command, cwd, SELECT_PROJECT_MESSAGE, timeoutSeconds);
    }

    const mode = input.session.openPondCommandAccessMode ?? DEFAULT_OPENPOND_COMMAND_ACCESS_MODE;
    if (mode === "disabled") {
      return blockedCommandResult(command, cwd, "Command access is disabled for this chat.", timeoutSeconds);
    }

    const family = classifyCommandFamily(command);
    if (mode === "ask" && !acceptedSessionFamilies.has(sessionFamilyKey(input.session.id, family))) {
      const decision = await requestCommandApproval({
        command,
        cwd,
        family,
        input,
        timeoutSeconds,
      });
      if (decision === "acceptForSession") {
        acceptedSessionFamilies.add(sessionFamilyKey(input.session.id, family));
      }
      if (decision !== "accept" && decision !== "acceptForSession") {
        return blockedCommandResult(
          command,
          cwd,
          decision === "cancel" ? "Command was cancelled." : "Command was not approved.",
          timeoutSeconds,
        );
      }
    }

    return runShellCommand({ command, cwd, timeoutSeconds, signal: input.signal });
  }

  async function resolveApproval(approvalId: string, payload: unknown): Promise<Approval | null> {
    const pending = pendingApprovals.get(approvalId);
    if (!pending) return null;
    const input = ResolveApprovalRequestSchema.parse(payload);
    pendingApprovals.delete(approvalId);
    const status = approvalStatusForDecision(input.decision);
    const approval: Approval = { ...pending.approval, status };
    await upsertApproval(approval);
    await appendRuntimeEvent(
      event({
        sessionId: approval.sessionId,
        turnId: approval.turnId ?? undefined,
        name: "approval.resolved",
        source: "server",
        action: "command",
        status: status === "accepted" || status === "accepted_for_session" ? "completed" : "failed",
        output: approval.title,
        data: {
          approvalId,
          status,
          decision: input.decision,
          family: pending.family,
        },
      }),
    );
    pending.resolve(input.decision);
    return approval;
  }

  async function requestCommandApproval(input: {
    command: string;
    cwd: string;
    family: CommandFamily;
    input: OpenPondCommandExecutionInput;
    timeoutSeconds: number;
  }): Promise<ResolveApprovalRequest["decision"]> {
    const approval: Approval = {
      id: `approval_${randomUUID()}`,
      sessionId: input.input.session.id,
      turnId: input.input.turnId ?? null,
      providerRequestId: input.input.providerRequestId ?? input.input.turnId ?? input.input.session.id,
      kind: "command",
      title: input.command,
      detail: JSON.stringify(
        {
          command: input.command,
          cwd: input.cwd,
          timeoutSeconds: input.timeoutSeconds,
          source: input.input.source,
          mode: input.input.session.openPondCommandAccessMode ?? DEFAULT_OPENPOND_COMMAND_ACCESS_MODE,
          risk: commandRiskLabel(input.command),
          sessionApprovalFamily: {
            key: input.family.key,
            label: input.family.label,
            broad: input.family.broad,
            reason: input.family.reason,
          },
        },
        null,
        2,
      ),
      status: "pending",
      createdAt: now(),
    };
    await upsertApproval(approval);
    await appendRuntimeEvent(
      event({
        sessionId: input.input.session.id,
        turnId: input.input.turnId ?? undefined,
        name: "approval.requested",
        source: "server",
        action: "command",
        appId: input.input.session.appId,
        status: "pending",
        output: approval.title,
        data: approval,
      }),
    );
    return new Promise<ResolveApprovalRequest["decision"]>((resolve) => {
      pendingApprovals.set(approval.id, { approval, family: input.family, resolve });
    });
  }

  return {
    executeCommand,
    resolveApproval,
  };
}

export function commandResultForModel(result: OpenPondCommandRunResult): string {
  return JSON.stringify(
    {
      ok: result.ok,
      action: "exec_command",
      output: commandResultSummary(result),
      data: {
        command: result.command,
        cwd: result.cwd,
        exitCode: result.exitCode,
        stdout: trimForModel(result.stdout),
        stderr: trimForModel(result.stderr),
        timedOut: result.timedOut,
        timeoutSeconds: result.timeoutSeconds,
        truncated: result.truncated,
        blockedReason: result.blockedReason,
      },
    },
    null,
    2,
  );
}

export function classifyCommandFamily(command: string): CommandFamily {
  const tokens = safeShellTokens(command);
  if (!tokens) {
    return exactCommandFamily(command, "Could not safely parse shell command.");
  }
  const commandIndex = firstCommandTokenIndex(tokens);
  if (commandIndex === -1) return exactCommandFamily(command, "Could not find command executable.");
  if (hasUnsafeShellSyntax(tokens)) {
    return exactCommandFamily(command, "Shell operators require exact-command session approval.");
  }

  const executable = tokens[commandIndex];
  const next = tokens[commandIndex + 1] ?? null;
  if (executable === "pwd") return broadFamily("pwd", "pwd", "Allowlisted read-only command.");
  if (executable === "ls") return broadFamily("ls", "ls", "Allowlisted directory listing command.");
  if (executable === "git" && next === "status") {
    return broadFamily("git status", "git status", "Allowlisted git status family.");
  }
  if (executable === "docker" && next === "system") {
    return broadFamily("docker system", "docker system", "Allowlisted Docker system inspection family.");
  }
  if (executable === "bun" && next === "run") {
    return broadFamily("bun run", "bun run", "Allowlisted Bun script execution family.");
  }
  return exactCommandFamily(command, "Command is not in the broad session-approval allowlist.");
}

function safeShellTokens(command: string): string[] | null {
  try {
    const entries = parseShellCommand(command);
    const tokens: string[] = [];
    for (const entry of entries) {
      if (typeof entry === "string") {
        tokens.push(entry);
        continue;
      }
      if (!entry || typeof entry !== "object") return null;
      const op = (entry as { op?: unknown }).op;
      if (typeof op === "string") {
        tokens.push(op);
        continue;
      }
      return null;
    }
    return tokens;
  } catch {
    return null;
  }
}

function firstCommandTokenIndex(tokens: string[]): number {
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index]!;
    if (/^[A-Za-z_][A-Za-z0-9_]*=.*/.test(token)) continue;
    return index;
  }
  return -1;
}

function hasUnsafeShellSyntax(tokens: string[]): boolean {
  return tokens.some((token) => /^(?:\||&&|\|\||;|&|<|>|\(|\)|\{|\})$/.test(token));
}

function broadFamily(key: string, label: string, reason: string): CommandFamily {
  return { key, label, broad: true, reason };
}

function exactCommandFamily(command: string, reason: string): CommandFamily {
  return { key: `exact:${command}`, label: command, broad: false, reason };
}

function sessionFamilyKey(sessionId: string, family: CommandFamily): string {
  return `${sessionId}:${family.key}`;
}

function commandRiskLabel(command: string): "read" | "write" | "danger" {
  const normalized = command.toLowerCase();
  if (/\b(?:sudo|rm\s+-rf|mkfs|dd\s+if=|docker\s+(?:volume\s+rm|system\s+prune|container\s+rm)|kill(?:all)?)\b/.test(normalized)) {
    return "danger";
  }
  if (/\b(?:npm|pnpm|yarn|bun)\s+(?:install|add|remove)|\bgit\s+(?:commit|push|reset|checkout|merge|rebase)|[>|]|\b(?:mv|cp|rm|touch|mkdir|docker\s+(?:run|build|compose))\b/.test(normalized)) {
    return "write";
  }
  return "read";
}

function resolveCommandCwd(input: { requestedCwd?: string | null; session: Session }): string | null {
  const requested = input.requestedCwd?.trim();
  if (requested) {
    if (path.isAbsolute(requested)) return path.resolve(requested);
    return input.session.cwd ? path.resolve(input.session.cwd, requested) : null;
  }
  return input.session.cwd?.trim() || null;
}

function normalizedTimeout(value: number | null | undefined): number {
  if (!Number.isFinite(value ?? NaN)) return DEFAULT_COMMAND_TIMEOUT_SECONDS;
  return Math.max(1, Math.min(Math.floor(value!), MAX_COMMAND_TIMEOUT_SECONDS));
}

function blockedCommandResult(
  command: string,
  cwd: string | null,
  reason: string,
  timeoutSeconds: number,
): OpenPondCommandRunResult {
  return {
    ok: false,
    command,
    cwd,
    exitCode: null,
    stdout: "",
    stderr: reason,
    timedOut: false,
    timeoutSeconds,
    truncated: false,
    blockedReason: reason,
  };
}

function runShellCommand(input: {
  command: string;
  cwd: string;
  timeoutSeconds: number;
  signal?: AbortSignal;
}): Promise<OpenPondCommandRunResult> {
  return new Promise((resolve) => {
    let settled = false;
    let timedOut = false;
    let stdout = "";
    let stderr = "";
    let truncated = false;
    let forceKillTimer: NodeJS.Timeout | null = null;
    const shellCommand = pipefailLocalShellCommand(input.command);
    const child = spawn(shellCommand.command, {
      cwd: input.cwd,
      shell: shellCommand.shell,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
      detached: process.platform !== "win32",
    });
    const finish = (result: OpenPondCommandRunResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (forceKillTimer) clearTimeout(forceKillTimer);
      input.signal?.removeEventListener("abort", abort);
      resolve(result);
    };
    const appendOutput = (stream: "stdout" | "stderr", chunk: Buffer) => {
      const text = chunk.toString("utf8");
      if (stream === "stdout") stdout = appendLimited(stdout, text);
      else stderr = appendLimited(stderr, text);
      if (stdout.length + stderr.length >= MAX_COMMAND_OUTPUT_CHARS) truncated = true;
    };
    const abort = () => {
      terminateShellProcessTree(child, "SIGTERM");
      finish({
        ok: false,
        command: input.command,
        cwd: input.cwd,
        exitCode: null,
        stdout,
        stderr: stderr || "Command was interrupted.",
        timedOut: false,
        timeoutSeconds: input.timeoutSeconds,
        truncated,
        blockedReason: "Command was interrupted.",
      });
      // finish() resolves the interrupted tool call immediately; keep the
      // escalation timer alive independently in case a descendant ignores
      // SIGTERM and still owns the command pipes.
      scheduleShellProcessTreeKill(child);
    };
    const timer = setTimeout(() => {
      timedOut = true;
      terminateShellProcessTree(child, "SIGTERM");
      forceKillTimer = scheduleShellProcessTreeKill(child);
    }, input.timeoutSeconds * 1000);
    input.signal?.addEventListener("abort", abort, { once: true });
    child.stdout?.on("data", (chunk: Buffer) => appendOutput("stdout", chunk));
    child.stderr?.on("data", (chunk: Buffer) => appendOutput("stderr", chunk));
    child.on("error", (error) => {
      finish({
        ok: false,
        command: input.command,
        cwd: input.cwd,
        exitCode: null,
        stdout,
        stderr: error.message,
        timedOut,
        timeoutSeconds: input.timeoutSeconds,
        truncated,
        blockedReason: null,
      });
    });
    child.on("close", (code) => {
      finish({
        ok: !timedOut && (code ?? 1) === 0,
        command: input.command,
        cwd: input.cwd,
        exitCode: timedOut ? null : code ?? 1,
        stdout,
        stderr: timedOut ? appendLimited(stderr, `\nCommand timed out after ${input.timeoutSeconds}s.`) : stderr,
        timedOut,
        timeoutSeconds: input.timeoutSeconds,
        truncated,
        blockedReason: null,
      });
    });
  });
}

function terminateShellProcessTree(child: ChildProcess, signal: NodeJS.Signals): void {
  if (child.pid && process.platform !== "win32") {
    try {
      process.kill(-child.pid, signal);
      return;
    } catch {
      // Fall back to the direct child below if the process group already exited
      // or could not be created by this platform/runtime.
    }
  }
  child.kill(signal);
}

function scheduleShellProcessTreeKill(child: ChildProcess): NodeJS.Timeout {
  const timer = setTimeout(() => terminateShellProcessTree(child, "SIGKILL"), 1_000);
  timer.unref();
  return timer;
}

function appendLimited(current: string, chunk: string): string {
  if (current.length >= MAX_COMMAND_OUTPUT_CHARS) return current;
  const next = `${current}${chunk}`;
  if (next.length <= MAX_COMMAND_OUTPUT_CHARS) return next;
  return `${next.slice(0, MAX_COMMAND_OUTPUT_CHARS)}\n[command output truncated]`;
}

function trimForModel(value: string): string {
  if (value.length <= MODEL_COMMAND_OUTPUT_CHARS) return value;
  return `${value.slice(0, MODEL_COMMAND_OUTPUT_CHARS)}\n[command output truncated for model]`;
}

function commandResultSummary(result: OpenPondCommandRunResult): string {
  if (result.blockedReason) return result.blockedReason;
  if (result.timedOut) return `Command timed out after ${result.timeoutSeconds}s.`;
  const code = result.exitCode ?? 1;
  return code === 0 ? "Command completed successfully." : `Command exited with code ${code}.`;
}

function approvalStatusForDecision(decision: ResolveApprovalRequest["decision"]): Approval["status"] {
  if (decision === "accept") return "accepted";
  if (decision === "acceptForSession") return "accepted_for_session";
  if (decision === "cancel") return "cancelled";
  return "declined";
}

export { SELECT_PROJECT_MESSAGE };
