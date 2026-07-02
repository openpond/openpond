import type {
  BootstrapPayload,
  CloudProject,
  CloudWorkItem,
  CloudWorkItemDetail,
  CloudWorkItemMessage,
  LocalProject,
} from "@openpond/contracts";

export type VoiceTranscriptionStatus = {
  available: boolean;
  binaryPath: string | null;
  modelName: string;
  modelPath: string;
  modelReady: boolean;
  canDownloadModel: boolean;
  installHint: string | null;
};

export type VoiceTranscriptionRequest = {
  audioBase64: string;
  mimeType: "audio/wav";
  durationMs: number;
  language?: string;
};

export type VoiceTranscriptionResponse = {
  text: string;
  binaryPath: string;
  modelName: string;
  modelPath: string;
  durationMs: number;
};

export type GitAvailability =
  | { ok: true; command: string; version: string }
  | { ok: false; error: string; installAction: "macos_command_line_tools" | "manual_git_install" };

export type LocalProjectCloudSourceUploadResponse = {
  project: CloudProject;
  localProject: LocalProject;
  bootstrap: BootstrapPayload;
  upload: {
    rootPath: string;
    branch: string;
    fileCount: number;
    byteCount: number;
    skippedCount: number;
    initializedEmptyProject: boolean;
  };
};

export type CloudWorkItemsResponse = {
  workItems: CloudWorkItem[];
};

export type CloudWorkItemMessageResponse = {
  message: CloudWorkItemMessage;
  userMessage: CloudWorkItemMessage;
};

export type CloudWorkItemOpenCloudResponse = {
  workItem: CloudWorkItem;
  runtime?: unknown;
  session?: CloudWorkItemDetail["runtimeSessions"][number];
  activity?: CloudWorkItemDetail["activity"][number];
  resumed?: boolean;
};

export type CloudWorkItemCancelTaskResponse = {
  workItem: CloudWorkItem;
  taskRun: unknown;
};
