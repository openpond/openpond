import path from "node:path";
import {
  DEFAULT_CHAT_PROVIDER,
  type ChatProvider,
} from "@openpond/contracts";
import {
  normalizeTerminalProvider,
  parseProviderModelSelection,
} from "./formatting.js";

export type TerminalOptions = {
  server: string;
  provider: ChatProvider;
  model: string | null;
  cwd: string;
  cwdExplicit?: boolean;
  project: string | null;
  resume: string | null;
  noServerStart: boolean;
  message: string | null;
  messageFile: string | null;
  stdin: boolean;
  nonInteractive: boolean;
  json: boolean;
  yes: boolean;
  approvalPolicy: TerminalApprovalPolicy;
  sandbox: TerminalSandboxMode;
  timeoutSec: number | null;
  maxOutputBytes: number | null;
};

export type TerminalApprovalPolicy = "on-request" | "never" | "on-failure" | "untrusted";
export type TerminalSandboxMode = "read-only" | "workspace-write" | "danger-full-access";
export type TerminalChatMode = "one-shot" | "line-mode" | "interactive";

export class TerminalUsageError extends Error {
  readonly exitCode = 2;

  constructor(message: string) {
    super(message);
    this.name = "TerminalUsageError";
  }
}

export function parseTerminalArgs(
  argv: string[],
  defaultCwd = process.cwd()
): { command: string; options: TerminalOptions } {
  const [command = "chat", ...rest] = argv;
  const options: TerminalOptions = {
    server: "http://127.0.0.1:17874",
    provider: DEFAULT_CHAT_PROVIDER,
    model: null,
    cwd: defaultCwd,
    project: null,
    resume: null,
    noServerStart: false,
    message: null,
    messageFile: null,
    stdin: false,
    nonInteractive: false,
    json: false,
    yes: false,
    approvalPolicy: "on-request",
    sandbox: "workspace-write",
    timeoutSec: null,
    maxOutputBytes: null,
  };
  for (let i = 0; i < rest.length; i += 1) {
    const arg = rest[i]!;
    if (arg === "--server") options.server = rest[++i] ?? options.server;
    else if (arg === "--provider") {
      options.provider = normalizeTerminalProvider(rest[++i] ?? null) ?? options.provider;
    } else if (arg === "--model") {
      const selection = parseProviderModelSelection(rest[++i] ?? null, options.provider);
      if (selection.provider) options.provider = selection.provider;
      options.model = selection.model;
    } else if (arg === "--cwd") {
      options.cwd = path.resolve(rest[++i] ?? options.cwd);
      options.cwdExplicit = true;
    } else if (arg === "--project") {
      options.project = rest[++i] ?? null;
    } else if (arg === "--resume") {
      options.resume = rest[++i] ?? null;
    } else if (arg === "--no-server-start") {
      options.noServerStart = true;
    } else if (arg === "--message") {
      options.message = readStringArg(rest, ++i, "message");
    } else if (arg === "--message-file") {
      options.messageFile = path.resolve(readStringArg(rest, ++i, "message-file"));
    } else if (arg === "--stdin") {
      const parsed = readOptionalBoolean(rest, i);
      options.stdin = parsed.value;
      i = parsed.index;
    } else if (arg === "--non-interactive") {
      const parsed = readOptionalBoolean(rest, i);
      options.nonInteractive = parsed.value;
      i = parsed.index;
    } else if (arg === "--json") {
      const parsed = readOptionalBoolean(rest, i);
      options.json = parsed.value;
      i = parsed.index;
    } else if (arg === "--yes") {
      const parsed = readOptionalBoolean(rest, i);
      options.yes = parsed.value;
      i = parsed.index;
    } else if (arg === "--approval-policy") {
      options.approvalPolicy = parseApprovalPolicy(readStringArg(rest, ++i, "approval-policy"));
    } else if (arg === "--sandbox") {
      options.sandbox = parseSandboxMode(readStringArg(rest, ++i, "sandbox"));
    } else if (arg === "--timeout-sec") {
      options.timeoutSec = parsePositiveInteger(readStringArg(rest, ++i, "timeout-sec"), "timeout-sec");
    } else if (arg === "--max-output-bytes") {
      options.maxOutputBytes = parsePositiveInteger(readStringArg(rest, ++i, "max-output-bytes"), "max-output-bytes");
    } else if (arg.startsWith("-")) {
      throw new TerminalUsageError(`unknown option ${arg}`);
    }
  }
  return { command, options };
}

export function shouldRunOneShotChat(options: TerminalOptions): boolean {
  return Boolean(options.nonInteractive || options.message || options.messageFile || options.stdin);
}

export function resolveTerminalChatMode(
  options: TerminalOptions,
  streams: { inputIsTTY: boolean; outputIsTTY: boolean },
): TerminalChatMode {
  if (shouldRunOneShotChat(options)) return "one-shot";
  if (!streams.inputIsTTY || !streams.outputIsTTY) return "line-mode";
  return "interactive";
}

function readStringArg(args: string[], index: number, label: string): string {
  const value = args[index];
  if (!value || value.startsWith("--")) {
    throw new TerminalUsageError(`${label} requires a value`);
  }
  return value;
}

function readOptionalBoolean(args: string[], index: number): { value: boolean; index: number } {
  const next = args[index + 1];
  if (next && isBooleanLiteral(next)) {
    return { value: parseBooleanLiteral(next), index: index + 1 };
  }
  return { value: true, index };
}

function isBooleanLiteral(value: string): boolean {
  return /^(true|false|1|0|yes|no)$/i.test(value);
}

function parseBooleanLiteral(value: string): boolean {
  return /^(true|1|yes)$/i.test(value);
}

function parseApprovalPolicy(value: string): TerminalApprovalPolicy {
  if (value === "on-request" || value === "never" || value === "on-failure" || value === "untrusted") {
    return value;
  }
  throw new TerminalUsageError("approval-policy must be on-request, never, on-failure, or untrusted");
}

function parseSandboxMode(value: string): TerminalSandboxMode {
  if (value === "read-only" || value === "workspace-write" || value === "danger-full-access") {
    return value;
  }
  throw new TerminalUsageError("sandbox must be read-only, workspace-write, or danger-full-access");
}

function parsePositiveInteger(value: string, label: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new TerminalUsageError(`${label} must be a positive integer`);
  }
  return parsed;
}
