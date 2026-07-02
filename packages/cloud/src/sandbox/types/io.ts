export type SandboxSecretScope = "team" | "project" | "template";
export type SandboxSecretStatus = "active" | "revoked" | "deleted";
export type SandboxSecretAttachmentTarget =
  | "sandbox"
  | "template"
  | "project"
  | "agent"
  | "replay";

export type SandboxSecretAttachmentMetadata = {
  envName: string;
  targetType: SandboxSecretAttachmentTarget;
  targetId: string;
  attachedAt: string;
  detachedAt: string | null;
};

export type SandboxSecretMetadata = {
  id: string;
  teamId: string;
  ownerUserId: string;
  name: string;
  description: string | null;
  scope: SandboxSecretScope;
  status: SandboxSecretStatus;
  secretRef: string;
  currentVersion: number | null;
  createdAt: string;
  updatedAt: string;
  lastUsedAt: string | null;
  deletedAt: string | null;
  attachments?: SandboxSecretAttachmentMetadata[];
};

export type SandboxSecretCreateInput = {
  teamId?: string;
  name: string;
  value: string;
  description?: string;
  scope?: SandboxSecretScope;
};

export type SandboxSecretRotateInput = {
  teamId?: string;
  value: string;
};

export type SandboxSecretAttachInput = {
  teamId?: string;
  envName: string;
  targetType: SandboxSecretAttachmentTarget;
  targetId: string;
};

export type SandboxSecretListResponse = {
  secrets: SandboxSecretMetadata[];
};

export type SandboxSecretResponse = {
  secret: SandboxSecretMetadata;
};

export type SandboxExecInput = {
  command: string;
  timeoutSeconds?: number;
};

export type SandboxProcessStartInput = {
  command: string;
  timeoutSeconds?: number;
};

export type SandboxProcessStatus =
  | "running"
  | "succeeded"
  | "failed"
  | "timed_out"
  | "stopped";

export type SandboxProcess = {
  id: string;
  command: string;
  status: SandboxProcessStatus;
  output: string;
  exitCode: number | null;
  startedAt: string;
  completedAt: string | null;
  durationMs: number | null;
  outputBytes: number;
  truncated?: boolean;
};

export type SandboxPreviewAccess = "private" | "public";

export type SandboxPreviewCorsPolicy = {
  allowOrigins?: string[];
  allowMethods?: string[];
  allowHeaders?: string[];
  exposeHeaders?: string[];
  allowCredentials?: boolean;
  maxAgeSeconds?: number;
};

export type SandboxPreviewHeaderPolicy = {
  responseHeaders?: Record<string, string>;
};

export type SandboxPreviewAuthPolicyInput =
  | {
      mode: "bearer";
      token: string;
    }
  | {
      mode: "header";
      headerName: string;
      headerValue: string;
    };

export type SandboxPreviewAuthPolicy =
  | {
      mode: "bearer";
      tokenSha256: string;
    }
  | {
      mode: "header";
      headerName: string;
      headerValueSha256: string;
    };

export type SandboxPtyStartInput = {
  command?: string;
  timeoutSeconds?: number;
  rows?: number;
  cols?: number;
};

export type SandboxPtyInput = {
  dataBase64: string;
};

export type SandboxPtyStatus =
  | "running"
  | "exited"
  | "failed"
  | "timed_out"
  | "stopped";

export type SandboxPtySession = {
  id: string;
  command: string;
  status: SandboxPtyStatus;
  output: string;
  exitCode: number | null;
  startedAt: string;
  completedAt: string | null;
  durationMs: number | null;
  outputBytes: number;
  rows: number;
  cols: number;
  truncated?: boolean;
};

export type SandboxOpenPortInput = {
  port: number;
  label?: string;
  access?: SandboxPreviewAccess;
  autoStart?: boolean;
  customDomain?: string;
  cors?: SandboxPreviewCorsPolicy;
  headerPolicy?: SandboxPreviewHeaderPolicy;
  authPolicy?: SandboxPreviewAuthPolicyInput;
};

export type SandboxGitStatus = {
  isRepo: boolean;
  branch: string | null;
  upstream: string | null;
  ahead: number;
  behind: number;
  clean: boolean;
  porcelain: string;
};

export type SandboxGitDiffInput = {
  baseRef?: string;
};

export type SandboxGitDiff = {
  isRepo: boolean;
  baseRef: string | null;
  diff: string;
};

export type SandboxGitPatchExportInput = SandboxGitDiffInput;

export type SandboxGitPatchExport = {
  isRepo: boolean;
  baseRef: string | null;
  patch: string;
  filename: string;
  sha256: string;
  bytes: number;
  lineCount: number;
  empty: boolean;
};

export type SandboxGitBranchInput = {
  branch: string;
  create?: boolean;
  startPoint?: string;
};

export type SandboxGitBranch = {
  isRepo: boolean;
  branch: string | null;
  output: string;
  status: SandboxGitStatus;
};

export type SandboxGitCommitInput = {
  message: string;
  paths?: string[];
  all?: boolean;
};

export type SandboxGitCommit = {
  isRepo: boolean;
  commitHash: string | null;
  output: string;
  status: SandboxGitStatus;
};

export type SandboxGitPullInput = {
  remote?: string;
  branch?: string;
  rebase?: boolean;
  ffOnly?: boolean;
};

export type SandboxGitPushInput = {
  remote?: string;
  branch?: string;
  setUpstream?: boolean;
  forceWithLease?: boolean;
};

export type SandboxGitRemoteOperation = {
  isRepo: boolean;
  remote: string | null;
  branch: string | null;
  output: string;
  status: SandboxGitStatus;
};

export type SandboxFileRef = {
  path: string;
  sizeBytes: number;
  updatedAt: string;
  isBinary?: boolean | null;
  previewable?: boolean;
};

export type SandboxFileEntry = SandboxFileRef & {
  type: "file" | "directory";
};

export type SandboxFileDownloadInput = {
  path: string;
  offsetBytes?: number;
  maxBytes?: number;
};

export type SandboxFileListInput = {
  path?: string;
  recursive?: boolean;
  maxEntries?: number;
};

export type SandboxFileMkdirInput = {
  path: string;
  recursive?: boolean;
};

export type SandboxFileMoveInput = {
  fromPath: string;
  toPath: string;
  overwrite?: boolean;
};

export type SandboxFileSearchInput = {
  query: string;
  path?: string;
  maxResults?: number;
};

export type SandboxFileSearchMatch = {
  path: string;
  line: number;
  preview: string;
};
