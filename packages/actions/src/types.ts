import type { z } from "zod";

export type ProjectActionApprovalMode = "never" | "always" | "writes" | "sensitive";
export type ProjectActionBehavior = "read" | "write";

export type ProjectActionApprovalPolicy = {
  mode: ProjectActionApprovalMode;
  reason?: string;
  required?: boolean;
  risk?: ProjectActionBehavior;
};

export type ProjectActionSetupRequirement = {
  kind: "connection" | "env" | "package" | "native_tool";
  name: string;
  required?: boolean;
  description?: string;
};

export type ProjectActionSchema = z.ZodType<unknown>;

export type ProjectActionTraceEvent = {
  name: string;
  payload?: Record<string, unknown>;
  timestamp: string;
};

export type ProjectActionOutput = {
  path: string;
  mimeType?: string;
  name?: string;
};

export interface ProjectActionContext {
  readonly runId: string;
  readonly actionId: string;
  readonly idempotencyKey: string | null;
  readonly projectRoot: string;
  readonly outputDirectory: string;
  readonly signal: AbortSignal;
  env(name: string): string | undefined;
  connection<T = unknown>(name: string): T;
  trace(name: string, payload?: Record<string, unknown>): void;
  output(output: ProjectActionOutput): void;
}

export type ProjectActionDefinition<TInput = unknown, TOutput = unknown> = {
  readonly kind: "openpond-project-action";
  readonly id: string;
  readonly label: string;
  readonly description: string;
  readonly behavior: ProjectActionBehavior;
  readonly inputSchema: ProjectActionSchema;
  readonly outputSchema: ProjectActionSchema;
  readonly approval: ProjectActionApprovalPolicy;
  readonly setup: readonly ProjectActionSetupRequirement[];
  readonly invokesModel: boolean;
  readonly timeoutMs: number;
  readonly concurrency: number | null;
  readonly run: (context: ProjectActionContext, input: TInput) => Promise<TOutput> | TOutput;
};

export type DefineProjectActionOptions<TInput, TOutput> = {
  label?: string;
  description: string;
  behavior?: ProjectActionBehavior;
  input: z.ZodType<TInput>;
  output: z.ZodType<TOutput>;
  approval?: ProjectActionApprovalPolicy;
  setup?: readonly ProjectActionSetupRequirement[];
  invokesModel?: boolean;
  timeoutMs?: number;
  concurrency?: number | null;
  run: (context: ProjectActionContext, input: TInput) => Promise<TOutput> | TOutput;
};

export type ProjectActionCatalogEntry = {
  id: string;
  sourceActionId: string;
  name: string;
  label: string;
  description: string;
  visibility: "default";
  inputSchema: Record<string, unknown>;
  outputSchema: Record<string, unknown>;
  approvalPolicy: ProjectActionApprovalPolicy;
  artifactPolicy: {
    outputArtifacts: string[];
    persistRunSummary: boolean;
    persistTrace: boolean;
  };
  setupRequirements: ProjectActionSetupRequirement[];
  mcp: { enabled: boolean };
  schedulePolicy: { enabled: boolean; allowAdHoc: boolean };
  trace: { name: string; namespace: "project-actions" };
  implementation: {
    type: "openpond-project-action";
    actionId: string;
    behavior: ProjectActionBehavior;
    timeoutMs: number;
    concurrency: number | null;
  };
  invokesModel: boolean;
};

export type ProjectActionRegistry = {
  schemaVersion: "openpond.projectActionRegistry.v1";
  actions: ProjectActionCatalogEntry[];
};

export type ProjectActionBuildManifest = {
  schemaVersion: "openpond.projectActionBuild.v1";
  sourceDirectory: string;
  sourceFiles: string[];
  bundleFile: string;
  runnerFile: string;
  registryFile: string;
  bundleHash: string;
  registryHash: string;
};

export type ProjectActionBuildResult = {
  projectRoot: string;
  outputDirectory: string;
  bundlePath: string;
  runnerPath: string;
  registryPath: string;
  manifestPath: string;
  registry: ProjectActionRegistry;
  manifest: ProjectActionBuildManifest;
};

export type ProjectActionRunRequest = {
  actionId: string;
  input?: unknown;
  runId?: string;
  idempotencyKey?: string | null;
  timeoutMs?: number;
  signal?: AbortSignal;
  environment?: Record<string, string>;
  connections?: Record<string, unknown>;
  outputDirectory?: string;
};

export type ProjectActionRunResult<TOutput = unknown> = {
  runId: string;
  actionId: string;
  status: "succeeded";
  output: TOutput;
  stdout: string;
  stderr: string;
  traces: ProjectActionTraceEvent[];
  outputs: ProjectActionOutput[];
  outputDirectory: string;
  durationMs: number;
};

export type ProjectActionRunnerOptions = {
  projectRoot: string;
  sourceDirectory?: string;
  outputDirectory?: string;
  build?: "always" | "if-missing" | "never";
};

export interface LocalProjectActionRunner {
  catalog(): Promise<ProjectActionRegistry>;
  build(): Promise<ProjectActionBuildResult>;
  run<TOutput = unknown>(request: ProjectActionRunRequest): Promise<ProjectActionRunResult<TOutput>>;
}
