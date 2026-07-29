import type { CreateImproveRun } from "@openpond/contracts";

export type LocalCreatePipelineCheckInput = {
  snapshot: CreateImproveRun;
  target: LocalCreatePipelineTarget;
  requireEvalPass?: boolean;
};

export type LocalCreatePipelineCheckResult = {
  checkRefs: string[];
  metadata?: Record<string, unknown>;
};

export type LocalCreatePipelineTarget = {
  activeProfile: string;
  agentId: string;
  defaultAction: string;
  repoPath: string;
  sourcePath: string;
  workspaceRoot: string;
  profileRelativePath: string;
  sourceRoot: string;
  sourceRootRelativePath: string;
};
