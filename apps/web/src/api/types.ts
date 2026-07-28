import type {
  BootstrapPayload,
  CloudProject,
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
    headCommit: string | null;
    fileCount: number;
    byteCount: number;
    skippedCount: number;
    initializedEmptyProject: boolean;
    transport?: "git_head" | "snapshot" | "api_source_upload";
  };
};

export type LocalProjectCloudSourcePreviewResponse = {
  localProject: LocalProject;
  preview: {
    rootPath: string;
    branch: string;
    headCommit: string | null;
    targetProjectId: string | null;
    targetProjectName: string;
    fileCount: number;
    byteCount: number;
    skippedCount: number;
    initializedEmptyProject: boolean;
  };
};
