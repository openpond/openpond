import type { GoalState } from "../types";

export type GoalProfileDescriptor = {
  id: GoalState["profile"];
  promptPack: string;
  defaultVerificationCommands: string[];
  toolNames: string[];
};

export const GENERIC_CODING_PROFILE: GoalProfileDescriptor = {
  id: "generic_coding",
  promptPack: "generic_coding_v1",
  defaultVerificationCommands: [],
  toolNames: [
    "shell",
    "files",
    "checks",
    "artifacts",
    "questions",
    "approvals",
    "source",
  ],
};
