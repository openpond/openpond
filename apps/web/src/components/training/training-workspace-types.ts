import type {
  AppPreferences,
  ChatModelRef,
  CodexReasoningEffort,
  LocalProject,
  ProviderSettings,
  Session,
} from "@openpond/contracts";

import type { ClientConnection, PreferencesPayload } from "../../api";
import type { ShowAppToast } from "../../app/app-state";
import type { useTraining } from "../../hooks/useTraining";
import type { TrainingModelChatHandoff } from "../../lib/training-model-chat-handoff";

export type TrainingController = ReturnType<typeof useTraining>;

export type TrainingLaunchRequest = {
  id: number;
  objective: string | null;
  initialSessionIds?: string[];
  initialTasksetId?: string;
};

export type TrainingWorkspaceProps = {
  training: TrainingController;
  sessions: Session[];
  localProjects?: LocalProject[];
  connection: ClientConnection | null;
  defaultModel: ChatModelRef;
  onError: (message: string | null) => void;
  onToast: ShowAppToast;
  onSettingsPreferences: (payload: PreferencesPayload) => void;
  onOpenComputeSettings: () => void;
  onOpenProviderSettings: () => void;
  onOpenDatasetStorageSettings: () => void;
  onOpenChat: (sessionId: string) => void;
  onChatWithModel: (handoff: TrainingModelChatHandoff) => void;
  onOpenTasksetFiles: () => void;
  selectedTasksetId: string | null;
  onSelectedTasksetIdChange: (id: string | null) => void;
  onSelectedTrainingJobIdChange: (id: string | null) => void;
  detailTasksetId: string | null;
  onDetailTasksetIdChange: (id: string | null) => void;
  launchRequest: TrainingLaunchRequest | null;
  onLaunchHandled: (id: number) => void;
  preferences: AppPreferences["training"];
  settingsPreferences: AppPreferences;
  providerSettings: ProviderSettings | null;
  reasoningEffort: CodexReasoningEffort;
};
