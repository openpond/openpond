import type { GoalProfileDescriptor } from "./generic-coding";

export const OPENPOND_AGENT_PROFILE: GoalProfileDescriptor = {
  id: "openpond_agent",
  promptPack: "openpond_agent_create_v1",
  defaultVerificationCommands: [],
  toolNames: [
    "shell",
    "files",
    "checks",
    "artifacts",
    "questions",
    "approvals",
    "source",
    "openpond_agent_sdk",
  ],
};

export const OPENPOND_AGENT_SDK_CHECKS = [
  "inspect",
  "build",
  "validate",
  "eval",
] as const;
