import type { AgentTraceArtifact, AgentTraceEvent } from "../index";

export type CliOptions = {
  command: string;
  cwd: string;
  outDir: string;
  json: boolean;
  actionName?: string;
  templateName?: string;
  force?: boolean;
  input?: Record<string, unknown>;
};

export type ValidationResult = {
  schemaVersion: number;
  schema: string;
  status: "passed" | "failed";
  summary: {
    errors: number;
    warnings: number;
  };
  issues: ValidationIssue[];
  errors: string[];
  warnings: string[];
};

export type ValidationIssue = {
  code: string;
  severity: "error" | "warning";
  message: string;
  summary: string;
  path?: string;
  source?: {
    file?: string;
    line?: number;
    column?: number;
  };
  setupRequirement?: {
    kind: "channel" | "connection" | "integration" | "env" | "volume" | "schedule";
    name: string;
    required: boolean;
  };
  details?: Record<string, unknown>;
};

export type RunState = {
  artifacts: AgentTraceArtifact[];
  assertions: Array<{ name: string; status: "passed" | "failed"; message?: string }>;
  commands: Array<{ command: string; options?: Record<string, unknown> }>;
  events: AgentTraceEvent[];
};

export type ExecuteActionOptions = {
  timeoutMs?: number;
  signal?: AbortSignal;
};
