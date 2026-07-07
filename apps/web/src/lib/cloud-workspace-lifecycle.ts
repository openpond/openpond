import type {
  BootstrapPayload,
  LocalProject,
  Session,
  WorkspaceToolResult,
} from "@openpond/contracts";
import { api, type ClientConnection } from "../api";
import type { SandboxRecord } from "./sandbox-types";
import { isCloudWorkspaceKind } from "./workspace-location";

const CLOUD_CODING_RUNTIME_PROFILE_ID = "openpond-coding-core-v1";
const CLOUD_CODING_IDLE_TIMEOUT_SECONDS = 15 * 60;
const CLOUD_CODING_MAX_SPEND_USD = "0.05";

const DEFAULT_CLOUD_SANDBOX_START_TIMEOUT_MS = 10 * 60_000;
const DEFAULT_CHAT_PREFLIGHT_SANDBOX_START_TIMEOUT_MS = 60_000;
const DEFAULT_CLOUD_SANDBOX_START_POLL_MS = 1_500;

export type CloudWorkspaceReadyStatus =
  | "already_running"
  | "waited_for_creating"
  | "started"
  | "resumed"
  | "restored"
  | "recreated";

export type CloudWorkspaceReadyResult = {
  bootstrap?: BootstrapPayload;
  output?: string;
  sandbox: SandboxRecord | null;
  session: Session;
  status: CloudWorkspaceReadyStatus;
};

type CloudProjectTarget = {
  branch: string;
  label: string;
  projectId: string | null;
  teamId: string;
  localProjectId: string | null;
  localProjectName: string | null;
};

type EnsureCloudWorkspaceRunningInput = {
  branch?: string | null;
  connection: ClientConnection;
  localProject?: LocalProject | null;
  session: Session;
  source: string;
  waitOptions?: CloudSandboxStartWaitOptions;
};

type CloudSandboxStartWaitOptions = {
  delay?: (ms: number) => Promise<void>;
  now?: () => number;
  pollMs?: number;
  timeoutMs?: number;
};

export async function ensureCloudWorkspaceRunning({
  branch,
  connection,
  localProject,
  session,
  source,
  waitOptions,
}: EnsureCloudWorkspaceRunningInput): Promise<CloudWorkspaceReadyResult> {
  if (!isCloudWorkspaceKind(session.workspaceKind)) {
    return {
      sandbox: null,
      session,
      status: "already_running",
    };
  }

  const attachedSandboxId = session.workspaceId?.trim() ?? "";
  if (attachedSandboxId) {
    const current = await readAttachedSandbox(connection, attachedSandboxId);
    if (current?.state === "running") {
      return {
        sandbox: current,
        session,
        status: "already_running",
      };
    }
    if (current?.state === "creating") {
      assertAttachedCreatingSandboxNotStale(current, waitOptions);
      return {
        sandbox: await waitForSandboxRunning(
          connection,
          attachedSandboxId,
          withDefaultWaitTimeout(
            waitOptions,
            defaultSandboxStartTimeoutForSource(source),
          ),
        ),
        session,
        status: "waited_for_creating",
      };
    }
    const target = resolveCloudProjectTarget({
      branch,
      localProject,
      sandbox: current,
      session,
      runtimeOnly: Boolean(current?.runtimeId),
    });
    const result = await startCloudWorkspaceSession({
      connection,
      runtimeId: current?.runtimeId ?? null,
      session,
      source,
      target,
      waitOptions,
    });
    const nextSandbox =
      result.sandbox ??
      (result.session.workspaceId
        ? await waitForSandboxRunning(
            connection,
            result.session.workspaceId,
            withDefaultWaitTimeout(
              waitOptions,
              defaultSandboxStartTimeoutForSource(source),
            ),
          )
        : null);
    return {
      ...result,
      sandbox: nextSandbox,
      status:
        current?.state === "archived"
          ? "restored"
          : current?.state === "deleted" || current?.state === "error"
            ? "recreated"
            : "resumed",
    };
  }

  const target = resolveCloudProjectTarget({ branch, localProject, session });
  return startCloudWorkspaceSession({
    connection,
    runtimeId: null,
    session,
    source,
    target,
    waitOptions,
  });
}

function resolveCloudProjectTarget(input: {
  branch?: string | null;
  localProject?: LocalProject | null;
  runtimeOnly?: boolean;
  sandbox?: SandboxRecord | null;
  session: Session;
}): CloudProjectTarget {
  const linked = input.localProject?.linkedSandboxProject ?? null;
  const teamId = input.session.cloudTeamId ?? linked?.teamId ?? input.sandbox?.teamId ?? "";
  const projectId = input.session.cloudProjectId ?? linked?.projectId ?? input.sandbox?.projectId ?? "";
  if (!teamId || (!projectId && !input.runtimeOnly)) {
    throw new Error("Link this Project to OpenPond before Cloud coding.");
  }
  return {
    branch:
      input.branch?.trim() ||
      linked?.defaultBranch?.trim() ||
      "main",
    label:
      linked?.projectName ??
      linked?.projectSlug ??
      input.session.workspaceName ??
      input.localProject?.name ??
      "Cloud workspace",
    projectId: projectId || null,
    teamId,
    localProjectId: input.localProject?.id ?? input.session.localProjectId ?? null,
    localProjectName: input.localProject?.name ?? null,
  };
}

async function startCloudWorkspaceSession(input: {
  connection: ClientConnection;
  runtimeId: string | null;
  session: Session;
  source: string;
  target: CloudProjectTarget;
  waitOptions?: CloudSandboxStartWaitOptions;
}): Promise<CloudWorkspaceReadyResult> {
  const result = await api.workspaceTool(input.connection, input.session.id, {
    action: "sandbox_create",
    source: "ui_button",
    args: cloudCodingSandboxCreateArgs({
      runtimeId: input.runtimeId,
      source: input.source,
      target: input.target,
    }),
  });
  if (!result.ok) throw new Error(result.output);

  const bootstrap = await api.bootstrap(input.connection);
  const updatedSession =
    bootstrap.sessions.find((candidate) => candidate.id === input.session.id) ??
    input.session;
  const sandboxFromResult = sandboxFromWorkspaceToolResult(result);
  const sandboxId = sandboxFromResult?.id ?? updatedSession.workspaceId ?? null;
  const sandbox =
    sandboxFromResult?.state === "running" || !sandboxId
      ? sandboxFromResult
      : await waitForSandboxRunning(
          input.connection,
          sandboxId,
          withDefaultWaitTimeout(
            input.waitOptions,
            defaultSandboxStartTimeoutForSource(input.source),
          ),
        );

  return {
    bootstrap,
    output: result.output,
    sandbox,
    session: updatedSession,
    status: input.runtimeId ? "resumed" : "started",
  };
}

function cloudCodingSandboxCreateArgs(input: {
  runtimeId: string | null;
  source: string;
  target: CloudProjectTarget;
}): Record<string, unknown> {
  const metadata = {
    source: input.source,
    ...(input.target.localProjectId ? { localProjectId: input.target.localProjectId } : {}),
    ...(input.target.localProjectName ? { localProjectName: input.target.localProjectName } : {}),
  };
  return {
    teamId: input.target.teamId,
    ...(input.target.projectId ? { projectId: input.target.projectId } : {}),
    reuseDefaultRuntime: false,
    workflowMode: "feature",
    runtimeBaseBranch: input.target.branch,
    runtimePromotionPolicy: "manual",
    runtime: {
      ...(input.runtimeId ? { runtimeId: input.runtimeId } : {}),
      runtimeProfileId: CLOUD_CODING_RUNTIME_PROFILE_ID,
      metadata,
    },
    visibility: "team",
    budget: { maxUsd: CLOUD_CODING_MAX_SPEND_USD },
    quotas: {
      idleTimeoutSeconds: CLOUD_CODING_IDLE_TIMEOUT_SECONDS,
      maxSpendUsd: CLOUD_CODING_MAX_SPEND_USD,
    },
    metadata,
  };
}

async function readAttachedSandbox(
  connection: ClientConnection,
  sandboxId: string,
): Promise<SandboxRecord | null> {
  try {
    return (await api.sandbox(connection, sandboxId)).sandbox;
  } catch {
    return null;
  }
}

async function waitForSandboxRunning(
  connection: ClientConnection,
  sandboxId: string,
  waitOptions: CloudSandboxStartWaitOptions = {},
): Promise<SandboxRecord> {
  const now = waitOptions.now ?? Date.now;
  const timeoutMs = waitOptions.timeoutMs ?? DEFAULT_CLOUD_SANDBOX_START_TIMEOUT_MS;
  const pollMs = waitOptions.pollMs ?? DEFAULT_CLOUD_SANDBOX_START_POLL_MS;
  const sleep = waitOptions.delay ?? delay;
  const startedAt = now();
  let latest: SandboxRecord | null = null;
  while (true) {
    latest = (await api.sandbox(connection, sandboxId)).sandbox;
    if (latest.state === "running") return latest;
    if (latest.state === "error" || latest.state === "deleted") {
      throw new Error(`Cloud sandbox ${sandboxId} is ${latest.state}.`);
    }
    if (now() - startedAt >= timeoutMs) break;
    await sleep(pollMs);
  }
  throw new Error(
    `Timed out waiting for Cloud sandbox ${sandboxId} to start${
      latest ? `; latest state is ${latest.state}` : ""
    }.`,
  );
}

function assertAttachedCreatingSandboxNotStale(
  sandbox: SandboxRecord,
  waitOptions: CloudSandboxStartWaitOptions = {},
): void {
  const timeoutMs = waitOptions.timeoutMs ?? DEFAULT_CHAT_PREFLIGHT_SANDBOX_START_TIMEOUT_MS;
  const createdAtMs = Date.parse(sandbox.createdAt);
  if (!Number.isFinite(createdAtMs)) return;
  const now = waitOptions.now ?? Date.now;
  if (now() - createdAtMs < timeoutMs) return;
  throw new Error(
    `Timed out waiting for Cloud sandbox ${sandbox.id} to start; latest state is ${sandbox.state}.`,
  );
}

function defaultSandboxStartTimeoutForSource(source: string): number {
  return source.includes("chat-preflight")
    ? DEFAULT_CHAT_PREFLIGHT_SANDBOX_START_TIMEOUT_MS
    : DEFAULT_CLOUD_SANDBOX_START_TIMEOUT_MS;
}

function withDefaultWaitTimeout(
  waitOptions: CloudSandboxStartWaitOptions | undefined,
  timeoutMs: number,
): CloudSandboxStartWaitOptions {
  return {
    ...waitOptions,
    timeoutMs: waitOptions?.timeoutMs ?? timeoutMs,
  };
}

function sandboxFromWorkspaceToolResult(result: WorkspaceToolResult): SandboxRecord | null {
  const data = record(result.data);
  const sandbox = record(data?.sandbox);
  return sandbox ? (sandbox as unknown as SandboxRecord) : null;
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => globalThis.setTimeout(resolve, ms));
}
