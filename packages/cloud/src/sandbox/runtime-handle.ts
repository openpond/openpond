import type {
  OpenPondSandboxRuntimeHandle,
  RuntimeWorkflowCheckpointHintInput,
  RuntimeWorkflowKeepAliveInput,
  RuntimeWorkflowWaitForUserInput,
  SandboxExecInput,
  SandboxFileDownloadInput,
  SandboxFileListInput,
  SandboxFileMkdirInput,
  SandboxFileMoveInput,
  SandboxFileSearchInput,
  SandboxOpenPortInput,
  SandboxRecord,
  SandboxRuntime,
  SandboxRuntimeCheckpointInput,
  SandboxRuntimeEventInput,
  SandboxRuntimePromoteInput,
  SandboxRuntimePromoteResponse,
  SandboxRuntimeSourcePreserveInput,
  SandboxRuntimeSourcePreserveResponse,
  SandboxRuntimeSandboxCreateInput,
  SandboxRuntimeSandboxResponse,
  SandboxRuntimeTransitionInput,
  SandboxRuntimeEventsResponse,
  SandboxRuntimeEventResponse,
  SandboxAsyncRequestOptions,
  SandboxFileUploadResponse,
  SandboxFileDownloadResponse,
  SandboxFileDeleteResponse,
  SandboxFileListResponse,
  SandboxFileMkdirResponse,
  SandboxFileMoveResponse,
  SandboxFileStatResponse,
  SandboxFileSearchResponse,
  SandboxOpenPortResponse,
  SandboxExecResponse,
} from "./types/index.js";

export type SandboxRuntimeHandleClient = {
  getSandboxRuntime(runtimeId: string): Promise<SandboxRuntime>;
  createSandboxRuntimeSandbox(
    runtimeId: string,
    input?: SandboxRuntimeSandboxCreateInput,
    options?: SandboxAsyncRequestOptions
  ): Promise<SandboxRuntimeSandboxResponse>;
  updateSandboxRuntimeStatus(
    runtimeId: string,
    input: SandboxRuntimeTransitionInput
  ): Promise<SandboxRuntime>;
  listSandboxRuntimeEvents(
    runtimeId: string
  ): Promise<SandboxRuntimeEventsResponse>;
  emitSandboxRuntimeEvent(
    runtimeId: string,
    input: SandboxRuntimeEventInput
  ): Promise<SandboxRuntimeEventResponse>;
  checkpointSandboxRuntime(
    runtimeId: string,
    input: SandboxRuntimeCheckpointInput
  ): Promise<SandboxRuntime>;
  promoteSandboxRuntime(
    runtimeId: string,
    input: SandboxRuntimePromoteInput,
    options?: { teamId?: string }
  ): Promise<SandboxRuntimePromoteResponse>;
  preserveSandboxRuntimeSource(
    runtimeId: string,
    input?: SandboxRuntimeSourcePreserveInput,
    options?: { teamId?: string }
  ): Promise<SandboxRuntimeSourcePreserveResponse>;
  get(sandboxId: string): Promise<SandboxRecord>;
  start(
    sandboxId: string,
    options?: SandboxAsyncRequestOptions
  ): Promise<{ sandbox: SandboxRecord }>;
  restore(sandboxId: string): Promise<{ sandbox: SandboxRecord }>;
  uploadFile(
    sandboxId: string,
    path: string,
    contents: string
  ): Promise<SandboxFileUploadResponse>;
  downloadFile(sandboxId: string, path: string): Promise<string>;
  downloadFileResponse(
    sandboxId: string,
    input: string | SandboxFileDownloadInput
  ): Promise<SandboxFileDownloadResponse>;
  listFiles(
    sandboxId: string,
    input?: SandboxFileListInput
  ): Promise<SandboxFileListResponse>;
  deleteFile(
    sandboxId: string,
    path: string,
    input?: { recursive?: boolean }
  ): Promise<SandboxFileDeleteResponse>;
  searchFiles(
    sandboxId: string,
    input: SandboxFileSearchInput
  ): Promise<SandboxFileSearchResponse>;
  statFile(sandboxId: string, path: string): Promise<SandboxFileStatResponse>;
  mkdir(
    sandboxId: string,
    input: string | SandboxFileMkdirInput
  ): Promise<SandboxFileMkdirResponse>;
  moveFile(
    sandboxId: string,
    input: SandboxFileMoveInput
  ): Promise<SandboxFileMoveResponse>;
  exec(
    sandboxId: string,
    input: SandboxExecInput
  ): Promise<SandboxExecResponse>;
  openPort(
    sandboxId: string,
    input: SandboxOpenPortInput
  ): Promise<SandboxOpenPortResponse>;
};

export function createSandboxRuntimeHandle(
  client: SandboxRuntimeHandleClient,
  runtimeId: string,
  initial: SandboxRuntime | null = null
): OpenPondSandboxRuntimeHandle {
  const currentSandbox = async (
    input: SandboxRuntimeSandboxCreateInput = {},
    options: SandboxAsyncRequestOptions = {}
  ): Promise<SandboxRecord> => {
    const runtime = await client.getSandboxRuntime(runtimeId);
    if (runtime.sandboxId) {
      return client.get(runtime.sandboxId);
    }
    return client
      .createSandboxRuntimeSandbox(runtimeId, input, options)
      .then((payload) => payload.sandbox);
  };
  const resume = async (
    input: SandboxRuntimeSandboxCreateInput = {},
    options: SandboxAsyncRequestOptions = {}
  ): Promise<SandboxRecord> => {
    const runtime = await client.getSandboxRuntime(runtimeId);
    if (!runtime.sandboxId) {
      return client
        .createSandboxRuntimeSandbox(runtimeId, input, options)
        .then((payload) => payload.sandbox);
    }
    const sandbox = await client.get(runtime.sandboxId);
    if (sandbox.state === "stopped") {
      return client.start(sandbox.id, options).then((payload) => payload.sandbox);
    }
    if (sandbox.state === "archived") {
      return client.restore(sandbox.id).then((payload) => payload.sandbox);
    }
    if (sandbox.state === "deleted" || sandbox.state === "error") {
      return client
        .createSandboxRuntimeSandbox(runtimeId, input, options)
        .then((payload) => payload.sandbox);
    }
    return sandbox;
  };
  const checkpointHint = (input: RuntimeWorkflowCheckpointHintInput = {}) =>
    client.emitSandboxRuntimeEvent(runtimeId, {
      type: "workflow.checkpoint_hint",
      summary: input.summary ?? input.reason ?? "Workflow checkpoint hint",
      payload: {
        ...input.payload,
        reason: input.reason ?? null,
      },
      artifactRefs: input.artifactRefs,
      lifecycleHint: {
        kind: "checkpoint",
        reason: input.reason ?? null,
      },
    });
  const waitForUser = async (input: RuntimeWorkflowWaitForUserInput = {}) => {
    await client.emitSandboxRuntimeEvent(runtimeId, {
      type: "workflow.waiting_for_user",
      summary: input.summary ?? input.reason ?? "Waiting for user",
      payload: {
        ...input.payload,
        reason: input.reason ?? null,
      },
      lifecycleHint: {
        kind: "waiting_for_user",
        reason: input.reason ?? null,
      },
    });
    const current = await client.getSandboxRuntime(runtimeId);
    if (current.status === "waiting_for_user") return current;
    return client.updateSandboxRuntimeStatus(runtimeId, {
      status: "waiting_for_user",
      expectedVersion: current.version,
      summary: input.summary ?? input.reason,
      metadata: {
        workflowWaitForUserReason: input.reason ?? null,
      },
    });
  };
  const keepAlive = (input: RuntimeWorkflowKeepAliveInput = {}) => {
    const keepaliveUntil = runtimeKeepaliveUntilIso(input);
    return client.emitSandboxRuntimeEvent(runtimeId, {
      type: "workflow.keepalive",
      summary: input.summary ?? input.reason ?? "Workflow keepalive",
      payload: {
        ...input.payload,
        reason: input.reason ?? null,
        keepaliveUntil,
      },
      lifecycleHint: {
        kind: "keepalive",
        reason: input.reason ?? null,
        keepaliveUntil,
      },
    });
  };
  return {
    id: runtimeId,
    initial,
    get: () => client.getSandboxRuntime(runtimeId),
    sandbox: currentSandbox,
    resume,
    createSandbox: (input = {}, options = {}) =>
      client.createSandboxRuntimeSandbox(runtimeId, input, options),
    status: async (input) => {
      if (typeof input !== "string") {
        return client.updateSandboxRuntimeStatus(runtimeId, input);
      }
      const current = await client.getSandboxRuntime(runtimeId);
      return client.updateSandboxRuntimeStatus(runtimeId, {
        status: input,
        expectedVersion: current.version,
      });
    },
    events: () => client.listSandboxRuntimeEvents(runtimeId),
    event: (input) => client.emitSandboxRuntimeEvent(runtimeId, input),
    recordCommit: (commitSha, input = {}) =>
      client.emitSandboxRuntimeEvent(runtimeId, {
        ...input,
        type: input.type ?? "git.commit",
        commitSha,
      }),
    checkpointHint,
    waitForUser,
    keepAlive,
    checkpoint: (input) => client.checkpointSandboxRuntime(runtimeId, input),
    files: {
      write: async (path, contents) =>
        client.uploadFile((await resume()).id, path, contents),
      read: async (path) => client.downloadFile((await resume()).id, path),
      readResponse: async (input) =>
        client.downloadFileResponse((await resume()).id, input),
      list: async (input = {}) => client.listFiles((await resume()).id, input),
      delete: async (path, input = {}) =>
        client.deleteFile((await resume()).id, path, input),
      search: async (input) => client.searchFiles((await resume()).id, input),
      stat: async (path) => client.statFile((await resume()).id, path),
      mkdir: async (input) => client.mkdir((await resume()).id, input),
      move: async (input) => client.moveFile((await resume()).id, input),
    },
    commands: {
      run: async (command) =>
        client.exec(
          (await resume()).id,
          typeof command === "string" ? { command } : command
        ),
    },
    ports: {
      expose: async (port) =>
        client.openPort(
          (await resume()).id,
          typeof port === "number" ? { port } : port
        ),
    },
    promote: (input, options = {}) =>
      client.promoteSandboxRuntime(runtimeId, input, options),
    preserveSource: (input = {}, options = {}) =>
      client.preserveSandboxRuntimeSource(runtimeId, input, options),
    archive: async (expectedVersion) => {
      const version =
        expectedVersion ?? (await client.getSandboxRuntime(runtimeId)).version;
      return client.updateSandboxRuntimeStatus(runtimeId, {
        status: "archived",
        expectedVersion: version,
      });
    },
  };
}

function runtimeKeepaliveUntilIso(
  input: RuntimeWorkflowKeepAliveInput | undefined
): string {
  if (input?.until instanceof Date) {
    return input.until.toISOString();
  }
  if (typeof input?.until === "string" && input.until.trim()) {
    return new Date(input.until).toISOString();
  }
  const seconds =
    typeof input?.seconds === "number" && Number.isFinite(input.seconds)
      ? Math.max(1, Math.trunc(input.seconds))
      : 60;
  return new Date(Date.now() + seconds * 1000).toISOString();
}
