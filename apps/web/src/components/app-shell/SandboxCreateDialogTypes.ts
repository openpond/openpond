export type SandboxTemplateEntrypoint = {
  name: string;
  command: string;
  timeoutSeconds: number | null;
  ports: Array<{
    port: number;
    label: string;
    access: "private" | "public";
    path: string;
  }>;
};

export type SandboxScalarInput = {
  name: string;
  label: string;
  required: boolean;
  type: "string" | "number" | "integer" | "boolean";
  defaultValue: string;
  targetNames: string[] | null;
};

export type SandboxFileUploadSelection = {
  inputName: string;
  label: string;
  targetPath: string;
  multiple: boolean;
  files: File[];
};

export type SandboxEnvInput = {
  name: string;
  required: boolean;
  secret: boolean;
  description: string;
};

export type SandboxEnvMappingSelection = {
  name: string;
  secretRef: string;
};

export type SandboxScheduleSelection = {
  name: string;
  description?: string;
  enabled: boolean;
  scheduleType: "rate" | "cron" | "once";
  scheduleExpression: string;
  timezone?: string;
  startAt?: string;
  endAt?: string;
  maxRuns?: number | null;
  runtimePolicy?: string;
  target: {
    kind: "command";
    command: string;
    requiresStart?: boolean;
  };
  budget?: Record<string, unknown>;
  resources?: Record<string, unknown>;
  quotas?: Record<string, unknown>;
  lifecycle?: Record<string, unknown>;
  retentionPolicy?: Record<string, unknown>;
  env?: unknown[];
  integrationLeases?: unknown[];
  metadata?: Record<string, unknown>;
};

export type SandboxCreateDialogInput = {
  repoUrl: string;
  command: string;
  entrypointName: string;
  commitMessage: string;
  budgetUsd: string;
  params: Record<string, unknown>;
  env: SandboxEnvMappingSelection[];
  timeoutSeconds: number | null;
  uploads: SandboxFileUploadSelection[];
  resources: {
    cpu: number;
    memoryGb: number;
    diskGb: number;
  };
  volumes: Array<{
    name?: string;
    mountPath?: string;
    storageGb?: number;
    deleteOnSandboxDelete?: boolean;
  }>;
  schedules: SandboxScheduleSelection[];
  openPreview: boolean;
  previewPort: number | null;
  previewLabel: string;
  previewAccess: "private" | "public";
};

export type SandboxFileInput = {
  name: string;
  label: string;
  required: boolean;
  multiple: boolean;
  accept: string;
  targetPath: string;
  targetNames: string[] | null;
};

export type SandboxManifestModel = {
  entrypoints: SandboxTemplateEntrypoint[];
  scalarInputs: SandboxScalarInput[];
  fileInputs: SandboxFileInput[];
  envInputs: SandboxEnvInput[];
  resources: {
    cpu: number;
    memoryGb: number;
    diskGb: number;
  };
  volumes: Array<{
    name: string;
    mountPath: string;
    storageGb?: number;
    deleteOnSandboxDelete: boolean;
  }>;
  schedules: SandboxScheduleSelection[];
};
