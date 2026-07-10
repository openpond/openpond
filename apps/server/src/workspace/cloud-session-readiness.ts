import {
  EnsureCloudWorkspaceReadyRequestSchema,
  type CloudWorkspaceReadyStatus,
  type EnsureCloudWorkspaceReadyResponse,
  type Session,
  type WorkspaceToolResult,
} from "@openpond/contracts";
import type { SandboxRequestAction } from "../openpond/sandboxes.js";

type SandboxSummary = {
  id: string;
  state: string;
  runtimeId: string | null;
  createdAt: string | null;
};

const RUNTIME_PROFILE_ID = "openpond-coding-core-v1";
const START_TIMEOUT_MS = 60_000;
const POLL_MS = 1_500;

export function createCloudSessionReadinessService(deps: {
  getSession(sessionId: string): Promise<Session>;
  executeWorkspaceTool(sessionId: string, payload: unknown): Promise<WorkspaceToolResult>;
  sandboxRequest(payload: SandboxRequestAction): Promise<unknown>;
  delay?: (ms: number) => Promise<void>;
  now?: () => number;
}) {
  const inFlight = new Map<string, Promise<EnsureCloudWorkspaceReadyResponse>>();
  const now = deps.now ?? Date.now;
  const closeController = new AbortController();
  let closed = false;
  let closePromise: Promise<void> | null = null;

  function ensureReady(sessionId: string, payload: unknown): Promise<EnsureCloudWorkspaceReadyResponse> {
    if (closed) return Promise.reject(new Error("Cloud workspace readiness service is closed."));
    const existing = inFlight.get(sessionId);
    if (existing) return existing;
    const operation = run(sessionId, payload).finally(() => {
      if (inFlight.get(sessionId) === operation) inFlight.delete(sessionId);
    });
    inFlight.set(sessionId, operation);
    return operation;
  }

  async function run(sessionId: string, payload: unknown): Promise<EnsureCloudWorkspaceReadyResponse> {
    const input = EnsureCloudWorkspaceReadyRequestSchema.parse(payload);
    const session = await deps.getSession(sessionId);
    if (!isCloudWorkspace(session)) return { session, status: "already_running" };
    await assertProjectAvailable(session);
    const attachedId = session.workspaceId?.trim() ?? "";
    const attached = attachedId ? await readSandbox(attachedId) : null;
    if (attached?.state === "running") return { session, status: "already_running" };
    if (attached?.state === "creating") {
      assertCreatingNotStale(attached);
      await waitForRunning(attached.id);
      return { session: await deps.getSession(sessionId), status: "waited_for_creating" };
    }

    const result = await deps.executeWorkspaceTool(sessionId, {
      action: "sandbox_create",
      source: "ui_button",
      args: sandboxCreateArgs(session, input.branch, input.surface, attached?.runtimeId ?? null),
    });
    if (!result.ok) throw new Error(result.output);
    const updated = await deps.getSession(sessionId);
    const created = sandboxFromToolResult(result);
    const sandboxId = created?.id ?? updated.workspaceId ?? null;
    if (sandboxId && created?.state !== "running") await waitForRunning(sandboxId);
    return {
      output: result.output,
      session: await deps.getSession(sessionId),
      status: statusAfterStart(attached),
    };
  }

  async function assertProjectAvailable(session: Session): Promise<void> {
    if (!session.cloudProjectId || !session.cloudTeamId) return;
    try {
      await deps.sandboxRequest({
        type: "project_get",
        projectId: session.cloudProjectId,
        payload: { teamId: session.cloudTeamId },
      });
    } catch {
      throw new Error(
        "This Cloud session belongs to a different OpenPond account or its Project is unavailable. Sync or select a Project in the current account.",
      );
    }
  }

  async function readSandbox(sandboxId: string): Promise<SandboxSummary | null> {
    try {
      return sandboxSummary(await deps.sandboxRequest({ type: "get", sandboxId }));
    } catch {
      return null;
    }
  }

  async function waitForRunning(sandboxId: string): Promise<SandboxSummary> {
    const startedAt = now();
    let latest: SandboxSummary | null = null;
    while (now() - startedAt < START_TIMEOUT_MS) {
      if (closed) throw new Error("Cloud workspace readiness service is closed.");
      latest = await readSandbox(sandboxId);
      if (latest?.state === "running") return latest;
      if (latest?.state === "error" || latest?.state === "deleted") {
        throw new Error(`Cloud sandbox ${sandboxId} is ${latest.state}.`);
      }
      if (deps.delay) await deps.delay(POLL_MS);
      else await abortableDelay(POLL_MS, closeController.signal);
    }
    throw new Error(
      `Timed out waiting for Cloud sandbox ${sandboxId} to start${latest ? `; latest state is ${latest.state}` : ""}.`,
    );
  }

  function close(): Promise<void> {
    if (closePromise) return closePromise;
    closed = true;
    closeController.abort();
    closePromise = Promise.allSettled([...inFlight.values()]).then(() => undefined);
    return closePromise;
  }

  function assertCreatingNotStale(sandbox: SandboxSummary): void {
    const createdAt = sandbox.createdAt ? Date.parse(sandbox.createdAt) : Number.NaN;
    if (Number.isFinite(createdAt) && now() - createdAt >= START_TIMEOUT_MS) {
      throw new Error(`Timed out waiting for Cloud sandbox ${sandbox.id} to start; latest state is creating.`);
    }
  }

  return { close, ensureReady };
}

function abortableDelay(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal.addEventListener("abort", () => {
      clearTimeout(timer);
      resolve();
    }, { once: true });
  });
}

function isCloudWorkspace(session: Session): boolean {
  return session.workspaceKind === "sandbox" || session.workspaceKind === "sandbox_template";
}

function sandboxCreateArgs(
  session: Session,
  branch: string | null | undefined,
  surface: "desktop" | "terminal",
  runtimeId: string | null,
): Record<string, unknown> {
  if (!session.cloudTeamId || (!session.cloudProjectId && !runtimeId)) {
    throw new Error("Link this Project to OpenPond before Cloud coding.");
  }
  const source = session.metadata?.workspaceTarget === "hybrid"
    ? `openpond-${surface}-hybrid-chat-preflight`
    : `openpond-${surface}-cloud-chat-preflight`;
  const metadata = {
    source,
    ...(session.localProjectId ? { localProjectId: session.localProjectId } : {}),
    ...(session.workspaceName ? { localProjectName: session.workspaceName } : {}),
  };
  return {
    teamId: session.cloudTeamId,
    ...(session.cloudProjectId ? { projectId: session.cloudProjectId } : {}),
    reuseDefaultRuntime: false,
    workflowMode: "feature",
    runtimeBaseBranch: branch?.trim() || "main",
    runtimePromotionPolicy: "manual",
    runtime: { ...(runtimeId ? { runtimeId } : {}), runtimeProfileId: RUNTIME_PROFILE_ID, metadata },
    visibility: "team",
    budget: { maxUsd: "0.05" },
    quotas: { idleTimeoutSeconds: 15 * 60, maxSpendUsd: "0.05" },
    metadata,
  };
}

function sandboxSummary(payload: unknown): SandboxSummary | null {
  const envelope = record(payload);
  const sandbox = record(envelope?.sandbox ?? payload);
  const id = typeof sandbox?.id === "string" ? sandbox.id : "";
  const state = typeof sandbox?.state === "string" ? sandbox.state : "";
  if (!id || !state) return null;
  return {
    id,
    state,
    runtimeId: typeof sandbox?.runtimeId === "string" ? sandbox.runtimeId : null,
    createdAt: typeof sandbox?.createdAt === "string" ? sandbox.createdAt : null,
  };
}

function sandboxFromToolResult(result: WorkspaceToolResult): SandboxSummary | null {
  return sandboxSummary(record(result.data)?.sandbox ?? null);
}

function statusAfterStart(previous: SandboxSummary | null): CloudWorkspaceReadyStatus {
  if (!previous) return "started";
  if (previous.state === "archived") return "restored";
  if (previous.state === "deleted" || previous.state === "error") return "recreated";
  return "resumed";
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}
