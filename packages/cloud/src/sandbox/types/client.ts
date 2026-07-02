import type {
  SandboxExecInput,
  SandboxExecResponse,
  SandboxFileDeleteResponse,
  SandboxFileDownloadInput,
  SandboxFileDownloadResponse,
  SandboxFileListInput,
  SandboxFileListResponse,
  SandboxFileMkdirInput,
  SandboxFileMkdirResponse,
  SandboxFileMoveInput,
  SandboxFileMoveResponse,
  SandboxFileSearchInput,
  SandboxFileSearchResponse,
  SandboxFileStatResponse,
  SandboxFileUploadResponse,
  SandboxOpenPortInput,
  SandboxOpenPortResponse,
  SandboxRecord,
  SandboxReservation,
  SandboxRuntime,
  SandboxRuntimeCheckpointInput,
  SandboxRuntimeDriver,
  SandboxRuntimeEventInput,
  SandboxRuntimeEventResponse,
  SandboxRuntimeEventsResponse,
  SandboxRuntimePromoteInput,
  SandboxRuntimePromoteResponse,
  SandboxRuntimeSourcePreserveInput,
  SandboxRuntimeSourcePreserveResponse,
  SandboxRuntimeSandboxCreateInput,
  SandboxRuntimeSandboxResponse,
  SandboxRuntimeTransitionInput,
  SandboxState,
  SandboxAsyncRequestOptions,
} from "./index.js";
export type SandboxSmokeOptions = {
  repo?: string;
  budgetUsd?: string;
  cpu?: number;
  memoryGb?: number;
  diskGb?: number;
  keep?: boolean;
  preview?: boolean;
  snapshot?: boolean;
  fork?: boolean;
  expectedRuntimeDriver?: SandboxRuntimeDriver;
  expectedMppMode?: NonNullable<SandboxReservation["mpp"]>["mode"];
};

export type SandboxSmokeSummary = {
  deleted: boolean;
  execOutput: string;
  fileRoundtrip: boolean;
  forkSandboxId: string | null;
  previewStatus: number | null;
  receiptRefs: Array<string | null>;
  reservationRef: string | null;
  runId: string;
  sandboxId: string;
  snapshotId: string | null;
  state: SandboxState;
};

export type OpenPondSandboxClientOptions = {
  baseUrl?: string;
  sandboxApiUrl?: string;
  apiKey: string;
};

export type OpenPondSandboxMcpServerConfig = {
  name: "openpond-sandboxes";
  transport: "streamable-http";
  url: string;
  headers: Record<string, string>;
};

export type OpenPondRuntimeFilesHandle = {
  write(path: string, contents: string): Promise<SandboxFileUploadResponse>;
  read(path: string): Promise<string>;
  readResponse(
    input: string | SandboxFileDownloadInput
  ): Promise<SandboxFileDownloadResponse>;
  list(input?: SandboxFileListInput): Promise<SandboxFileListResponse>;
  delete(
    path: string,
    input?: { recursive?: boolean }
  ): Promise<SandboxFileDeleteResponse>;
  search(input: SandboxFileSearchInput): Promise<SandboxFileSearchResponse>;
  stat(path: string): Promise<SandboxFileStatResponse>;
  mkdir(
    input: string | SandboxFileMkdirInput
  ): Promise<SandboxFileMkdirResponse>;
  move(input: SandboxFileMoveInput): Promise<SandboxFileMoveResponse>;
};

export type OpenPondRuntimeCommandsHandle = {
  run(command: string | SandboxExecInput): Promise<SandboxExecResponse>;
};

export type OpenPondRuntimePortsHandle = {
  expose(port: number | SandboxOpenPortInput): Promise<SandboxOpenPortResponse>;
};

export type RuntimeWorkflowCheckpointHintInput = {
  reason?: string;
  summary?: string | null;
  payload?: Record<string, unknown>;
  artifactRefs?: string[];
};

export type RuntimeWorkflowWaitForUserInput = {
  reason?: string;
  summary?: string | null;
  payload?: Record<string, unknown>;
};

export type RuntimeWorkflowKeepAliveInput = {
  reason?: string;
  summary?: string | null;
  payload?: Record<string, unknown>;
  until?: string | Date;
  seconds?: number;
};

export type OpenPondSandboxRuntimeHandle = {
  id: string;
  initial: SandboxRuntime | null;
  get(): Promise<SandboxRuntime>;
  sandbox(
    input?: SandboxRuntimeSandboxCreateInput,
    options?: SandboxAsyncRequestOptions
  ): Promise<SandboxRecord>;
  resume(
    input?: SandboxRuntimeSandboxCreateInput,
    options?: SandboxAsyncRequestOptions
  ): Promise<SandboxRecord>;
  createSandbox(
    input?: SandboxRuntimeSandboxCreateInput,
    options?: SandboxAsyncRequestOptions
  ): Promise<SandboxRuntimeSandboxResponse>;
  status(
    input: SandboxRuntimeTransitionInput | SandboxRuntime["status"]
  ): Promise<SandboxRuntime>;
  events(): Promise<SandboxRuntimeEventsResponse>;
  event(input: SandboxRuntimeEventInput): Promise<SandboxRuntimeEventResponse>;
  recordCommit(
    commitSha: string,
    input?: Omit<SandboxRuntimeEventInput, "commitSha" | "type"> & {
      type?: string;
    }
  ): Promise<SandboxRuntimeEventResponse>;
  checkpointHint(
    input?: RuntimeWorkflowCheckpointHintInput
  ): Promise<SandboxRuntimeEventResponse>;
  waitForUser(input?: RuntimeWorkflowWaitForUserInput): Promise<SandboxRuntime>;
  keepAlive(
    input?: RuntimeWorkflowKeepAliveInput
  ): Promise<SandboxRuntimeEventResponse>;
  checkpoint(input: SandboxRuntimeCheckpointInput): Promise<SandboxRuntime>;
  files: OpenPondRuntimeFilesHandle;
  commands: OpenPondRuntimeCommandsHandle;
  ports: OpenPondRuntimePortsHandle;
  promote(
    input: SandboxRuntimePromoteInput,
    options?: { teamId?: string }
  ): Promise<SandboxRuntimePromoteResponse>;
  preserveSource(
    input?: SandboxRuntimeSourcePreserveInput,
    options?: { teamId?: string }
  ): Promise<SandboxRuntimeSourcePreserveResponse>;
  archive(expectedVersion?: number): Promise<SandboxRuntime>;
};
