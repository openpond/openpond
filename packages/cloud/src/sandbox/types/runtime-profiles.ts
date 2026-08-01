export const SANDBOX_RUNTIME_PROFILE_IDS = [
  "openpond-generic-v1",
  "openpond-work-v1",
  "openpond-coding-core-v1",
  "openpond-agent-harness-v1",
] as const;

export type SandboxRuntimeProfileId =
  (typeof SANDBOX_RUNTIME_PROFILE_IDS)[number];

export type SandboxRuntimeProfileCapability =
  | "files"
  | "exec"
  | "processes"
  | "pty"
  | "ports"
  | "preview"
  | "git"
  | "coding_task";

export type SandboxRuntimeProfile = {
  id: SandboxRuntimeProfileId;
  label: string;
  description: string;
  version: number;
  workspaceRoot: string;
  defaultExecutionProfileId: string;
  requiredTools: string[];
  excludedToolchains: string[];
  capabilities: SandboxRuntimeProfileCapability[];
};

export type SandboxRuntimeProfileSummary = Omit<
  SandboxRuntimeProfile,
  "description"
>;
