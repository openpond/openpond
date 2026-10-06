import type { LearningPolicy, LearningRevisionRef, TaskDefinition } from "@openpond/evals/learning";
import type { RewardRelease } from "@openpond/evals/rewards";

export type SourceBinding = { origin: string; sourceInstanceId: string | null; enabled: boolean };
export type LearningSource = Omit<SourceBinding, "enabled"> & {
  projectId: string;
  name: string;
  state: string;
};
export type ModelConfiguration = {
  id: string;
  name: string;
  revision: number;
  etag: string;
  portableProjectId: string | null;
};
export type ServingTarget = {
  id: string;
  projectId: string;
  enabled: boolean;
  role: string;
  roleTargetId: string;
  hostedPonder?: { bindingId: string };
};
export type LearningConfiguration = {
  projectId: string;
  name: string;
  sources: SourceBinding[];
  mode: "evaluate" | "train" | "activate";
  serving?: { targetId: string; canarySeconds: number; rollbackOnRuntimeFailure: true };
  definition: LearningRevisionRef;
  configuration: { id: string; expectedRevision: number; expectedEtag: string } | null;
  learningPolicy: LearningRevisionRef | null;
  adapter:
    | { kind: "reference_text"; inputPointer: string; match: "exact" | "contained" }
    | { kind: "complete_text"; qualitativeOnly: true };
  generator: { modelId: string; maximumOutputTokens: number; maximumSpendUsd: number } | null;
  graderSelection?:
    | {
        mode: "manual";
        graders?: Array<{ reward: LearningRevisionRef; weight: number; reason: string }>;
      }
    | {
        mode: "auto";
        modelId: string;
        sampleSize: number;
        maximumOutputTokens: number;
        maximumSpendUsd: number;
      };
  schedule: {
    timezone: string;
    hour: number;
    minute: number;
    endHour?: number;
    endMinute?: number;
  };
  limits: {
    perCycleUsd: number;
    dailyUsd: number;
    monthlyUsd: number;
    gradeUsd: number;
    maximumTasks: number;
    minimumExamples: number;
    maxGpuSeconds: number;
    maximumAttempts: number;
    lookbackDays: number;
  };
  exceptions: "block" | "eligible_remainder";
  minimumScore: number;
  acceptance?: {
    minimumCasesPerCheck: number;
    minimumImprovement: number;
    windowCasesPerCheck: number;
  };
  failurePolicy?: { pauseAfterConsecutiveFailures: number };
  selection?: {
    maximumSourceShare: number;
    maximumFailureShare: number;
    maximumLengthShare: number;
    replayFraction: number;
    auditFraction: number;
  };
};
export type ConversationPolicy = {
  id: string;
  revision: number;
  teamId: string;
  ownerUserId: string;
  configuration: LearningConfiguration;
  status: "enabled" | "paused";
  nextRunAt: string;
};
export type LearningOptions = {
  ponderBindingId: string;
  nextRuns: Record<string, string>;
  projects: Array<{ id: string; name: string; configurationIds: string[] }>;
  policies: ConversationPolicy[];
  sources: LearningSource[];
  servingTargets: ServingTarget[];
  configurations: ModelConfiguration[];
  generators: Array<{ id: string; name: string }>;
  graders: Array<RewardRelease | null>;
  definitions: TaskDefinition[];
  trainingPolicies: LearningPolicy[];
};
export const sourceKey = (source: Pick<SourceBinding, "origin" | "sourceInstanceId">) =>
  JSON.stringify([source.origin, source.sourceInstanceId]);
export const revisionRef = (value: LearningRevisionRef) => ({
  id: value.id,
  revision: value.revision,
  contentHash: value.contentHash,
});
