import type {
  AccountState,
  ChatModelRef,
  CreateImproveCandidate,
  CreateImproveRun,
  LearnedPreferenceRewardBinding,
  WorkspaceDiffSummary,
} from "@openpond/contracts";

import type { ProfileViewProps } from "../profile/ProfileView";
import type { TrainingWorkspaceProps } from "../training/training-workspace-types";
import type { LabDetailKind, LabDetailLocation } from "./lab-detail-navigation";
import type { LabSkillSourceSelection } from "./lab-skill-source";

export type LabsRouteProps = {
  account: AccountState | null;
  closeDetailKind: LabDetailKind | null;
  closeDetailRequestId: number;
  onNewModel: (
    initialTasksetId?: string,
    learnedPreferenceReward?: LearnedPreferenceRewardBinding | null,
  ) => void;
  onUseAgent: (actionId: string, agentName: string) => void;
  onCreateAgent: (
    objective: string,
    authoringRunId?: string | null,
    authoringModel?: ChatModelRef | null,
  ) => Promise<void>;
  onImproveAgent: (
    agentId: string,
    objective: string,
    agentName?: string | null,
    authoringRunId?: string | null,
    authoringModel?: ChatModelRef | null,
  ) => Promise<void>;
  onOpenRunConversation: (conversationId: string) => void;
  onDetailOpenChange: (location: LabDetailLocation | null) => void;
  onSkillSelectionChange: (selection: LabSkillSourceSelection | null) => void;
  profileView: ProfileViewProps;
  training: TrainingWorkspaceProps;
  onAnswerQuestion: (
    input: { run: CreateImproveRun },
    questionId: string,
    answerValue: string,
  ) => Promise<void>;
  onApprove: (input: { run: CreateImproveRun }) => Promise<void>;
  onApplyCandidate: (
    input: { run: CreateImproveRun },
    candidateId: string,
  ) => Promise<void>;
  onCancel: (input: { run: CreateImproveRun }) => Promise<void>;
  candidateReview: {
    diff: WorkspaceDiffSummary | null;
    error: string | null;
    loading: boolean;
  };
  onCandidateReviewChange: (
    input: {
      run: CreateImproveRun;
      candidate: CreateImproveCandidate;
      fileRootPath: string | null;
      initialPath: string | null;
    } | null,
  ) => void;
  onOpenCandidateFiles: () => void;
  onOpenPullRequest: (
    input: { run: CreateImproveRun },
    candidateId: string,
  ) => Promise<void>;
  onPause: (input: { run: CreateImproveRun }) => Promise<void>;
  onReconcilePullRequest: (
    input: { run: CreateImproveRun },
    candidateId: string,
  ) => Promise<void>;
  onRejectCandidate: (
    input: { run: CreateImproveRun },
    candidateId: string,
  ) => Promise<void>;
  onResume: (input: { run: CreateImproveRun }) => Promise<void>;
  onRevise: (
    input: { run: CreateImproveRun },
    revision: string,
  ) => Promise<void>;
};
