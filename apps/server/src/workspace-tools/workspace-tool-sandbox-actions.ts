import { Buffer } from "node:buffer";
import { randomUUID } from "node:crypto";
import {
  SANDBOX_TEMPLATE_PREVIEW_PORT_MAX,
  SANDBOX_TEMPLATE_PREVIEW_PORT_MIN,
  type Session,
  type WorkspaceToolRequest,
  type WorkspaceToolResult,
} from "@openpond/contracts";
import type { SandboxRuntime } from "@openpond/cloud";
import { sandboxRequestPayload } from "../openpond/sandboxes.js";

type SandboxToolAction = Extract<
  WorkspaceToolRequest["action"],
  | "sandbox_create"
  | "sandbox_templates"
  | "sandbox_template_launch"
  | "sandbox_status"
  | "sandbox_list_files"
  | "sandbox_read_file"
  | "sandbox_search_files"
  | "sandbox_upload_file"
  | "sandbox_write_file"
  | "sandbox_edit_file"
  | "sandbox_delete_file"
  | "sandbox_mkdir"
  | "sandbox_move_file"
  | "sandbox_exec"
  | "sandbox_git_status"
  | "sandbox_git_diff"
  | "sandbox_git_export_patch"
  | "sandbox_git_branch"
  | "sandbox_git_commit"
  | "sandbox_git_pull"
  | "sandbox_git_push"
  | "sandbox_preserve_source"
  | "sandbox_promote_source"
  | "sandbox_run_action"
  | "sandbox_open_port"
  | "sandbox_snapshot_catalog"
  | "sandbox_snapshot_create"
  | "sandbox_snapshot_update"
  | "sandbox_snapshot_validate"
  | "sandbox_snapshot_publish"
  | "sandbox_replays"
  | "sandbox_replay_start"
  | "sandbox_replay_get"
  | "sandbox_replay_logs"
  | "sandbox_replay_artifacts"
  | "sandbox_replay_cancel"
  | "sandbox_logs"
  | "sandbox_receipts"
  | "sandbox_schedule_create"
  | "sandbox_stop"
>;

const SANDBOX_ACTIONS = new Set<WorkspaceToolRequest["action"]>([
  "sandbox_create",
  "sandbox_templates",
  "sandbox_template_launch",
  "sandbox_status",
  "sandbox_list_files",
  "sandbox_read_file",
  "sandbox_search_files",
  "sandbox_upload_file",
  "sandbox_write_file",
  "sandbox_edit_file",
  "sandbox_delete_file",
  "sandbox_mkdir",
  "sandbox_move_file",
  "sandbox_exec",
  "sandbox_git_status",
  "sandbox_git_diff",
  "sandbox_git_export_patch",
  "sandbox_git_branch",
  "sandbox_git_commit",
  "sandbox_git_pull",
  "sandbox_git_push",
  "sandbox_preserve_source",
  "sandbox_promote_source",
  "sandbox_run_action",
  "sandbox_open_port",
  "sandbox_snapshot_catalog",
  "sandbox_snapshot_create",
  "sandbox_snapshot_update",
  "sandbox_snapshot_validate",
  "sandbox_snapshot_publish",
  "sandbox_replays",
  "sandbox_replay_start",
  "sandbox_replay_get",
  "sandbox_replay_logs",
  "sandbox_replay_artifacts",
  "sandbox_replay_cancel",
  "sandbox_logs",
  "sandbox_receipts",
  "sandbox_schedule_create",
  "sandbox_stop",
]);

const SANDBOX_ACTIONS_WITHOUT_ACTIVE_SANDBOX = new Set<WorkspaceToolRequest["action"]>([
  "sandbox_create",
  "sandbox_templates",
  "sandbox_template_launch",
  "sandbox_snapshot_catalog",
  "sandbox_replays",
  "sandbox_replay_start",
  "sandbox_replay_get",
  "sandbox_replay_logs",
  "sandbox_replay_artifacts",
  "sandbox_replay_cancel",
  "sandbox_schedule_create",
]);

const SANDBOX_CREATE_REQUEST_ID_METADATA_KEY = "openpondAppCreateRequestId";
const SANDBOX_CHAT_DEFAULT_RUNTIME_METADATA_KEY = "openpondAppDefaultRuntime";
const SANDBOX_CREATE_REQUEST_TIMEOUT_MS = 30_000;
const SANDBOX_CREATE_RECOVERY_TIMEOUT_MS = 180_000;
const SANDBOX_CREATE_RECOVERY_POLL_MS = 3_000;

class SandboxCreateRequestTimeoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SandboxCreateRequestTimeoutError";
  }
}
const TERMINAL_RUNTIME_STATUSES = new Set(["archived", "failed", "expired"]);

export async function handleSandboxWorkspaceToolAction(input: {
  session: Session;
  request: WorkspaceToolRequest;
  updateSession: (sessionId: string, patch: Partial<Session>) => Promise<Session>;
}): Promise<WorkspaceToolResult | null> {
  if (!SANDBOX_ACTIONS.has(input.request.action)) {
    return null;
  }
  const action = input.request.action as SandboxToolAction;
  const args = input.request.args ?? {};
  const explicitSandboxId = stringArg(args, "sandboxId", "");
  const explicitProjectId = stringArg(args, "projectId", "");
  const explicitAgentId = stringArg(args, "agentId", "");
  const attachToSession = booleanArg(args, "attachToSession") !== false;
  const canCreateActionSandbox =
    action === "sandbox_run_action" && Boolean(explicitProjectId || explicitAgentId);
  if (
    !SANDBOX_ACTIONS_WITHOUT_ACTIVE_SANDBOX.has(input.request.action) &&
    !explicitSandboxId &&
    !canCreateActionSandbox &&
    (input.session.workspaceKind !== "sandbox" || !input.session.workspaceId)
  ) {
    throw new Error("Select a sandbox workspace before using sandbox tools.");
  }

  const sandboxId = explicitSandboxId || (input.session.workspaceId ?? "");
  let result: unknown;
  if (action === "sandbox_create") {
    result = await createSandboxFromToolArgs({
      args,
      session: input.session,
      source: "openpond-app-sandbox-chat",
    });
  } else if (action === "sandbox_templates") {
    result = await sandboxRequestPayload({
      type: "template_catalog",
      payload: sandboxCatalogPayload(args),
    });
  } else if (action === "sandbox_template_launch") {
    result = await sandboxRequestPayload({
      type: "template_launch",
      payload: {
        ...sandboxCatalogPayload(args),
        snapshotId: stringArg(args, "snapshotId", ""),
        templateName: stringArg(args, "templateName", ""),
        version: stringArg(args, "version", ""),
        useCase: stringArg(args, "useCase", ""),
        visibility: stringArg(args, "visibility", "team"),
        resources: recordArg(args, "resources"),
        budget: recordArg(args, "budget"),
        volumes: arrayArg(args, "volumes"),
        quotas: recordArg(args, "quotas"),
        metadata: {
          source: "openpond-app-sandbox-chat-template",
          ...recordArg(args, "metadata"),
        },
      },
    });
  } else if (action === "sandbox_snapshot_catalog") {
    result = await sandboxRequestPayload({
      type: "snapshot_catalog",
      payload: {
        ...sandboxCatalogPayload(args),
        replayState: stringArg(args, "replayState", ""),
      },
    });
  } else if (action === "sandbox_snapshot_create") {
    result = await sandboxRequestPayload({
      type: "snapshot_create",
      sandboxId,
      payload: {
        name: requiredStringArg(args, "name"),
        template: recordArg(args, "template"),
        replay: recordArg(args, "replay"),
      },
    });
  } else if (action === "sandbox_snapshot_update") {
    result = await sandboxRequestPayload({
      type: "snapshot_update",
      sandboxId,
      snapshotId: requiredStringArg(args, "snapshotId"),
      payload: {
        template: recordArg(args, "template"),
        retention: recordArg(args, "retention"),
      },
    });
  } else if (action === "sandbox_snapshot_validate") {
    result = await sandboxRequestPayload({
      type: "snapshot_validate",
      sandboxId,
      snapshotId: requiredStringArg(args, "snapshotId"),
      payload: { cleanup: stringArg(args, "cleanup", "") },
    });
  } else if (action === "sandbox_snapshot_publish") {
    result = await sandboxRequestPayload({
      type: "snapshot_publish",
      sandboxId,
      snapshotId: requiredStringArg(args, "snapshotId"),
    });
  } else if (action === "sandbox_replays") {
    result = await sandboxRequestPayload({
      type: "replays",
      payload: sandboxCatalogPayload(args),
    });
  } else if (action === "sandbox_replay_start") {
    result = await sandboxRequestPayload({
      type: "replay_start",
      payload: {
        ...sandboxCatalogPayload(args),
        snapshotId: requiredStringArg(args, "snapshotId"),
        sourceSandboxId: stringArg(args, "sourceSandboxId", ""),
        entrypoint: stringArg(args, "entrypoint", ""),
        params: recordArg(args, "params"),
        budget: recordArg(args, "budget"),
        maxDurationSeconds: numberArg(args, "maxDurationSeconds"),
        idleTimeoutSeconds: numberArg(args, "idleTimeoutSeconds"),
        cleanup: stringArg(args, "cleanup", ""),
        artifactPaths: arrayArg(args, "artifactPaths"),
        integrationLeases: arrayArg(args, "integrationLeases"),
        idempotencyKey: stringArg(args, "idempotencyKey", ""),
      },
    });
  } else if (action === "sandbox_replay_get") {
    result = await sandboxRequestPayload({
      type: "replay_get",
      replayId: requiredStringArg(args, "replayId"),
      payload: sandboxCatalogPayload(args),
    });
  } else if (action === "sandbox_replay_logs") {
    result = await sandboxRequestPayload({
      type: "replay_logs",
      replayId: requiredStringArg(args, "replayId"),
      payload: sandboxCatalogPayload(args),
    });
  } else if (action === "sandbox_replay_artifacts") {
    result = await sandboxRequestPayload({
      type: "replay_artifacts",
      replayId: requiredStringArg(args, "replayId"),
      payload: sandboxCatalogPayload(args),
    });
  } else if (action === "sandbox_replay_cancel") {
    result = await sandboxRequestPayload({
      type: "replay_cancel",
      replayId: requiredStringArg(args, "replayId"),
      payload: sandboxCatalogPayload(args),
    });
  } else if (action === "sandbox_status") {
    result = await sandboxRequestPayload({ type: "get", sandboxId });
  } else if (action === "sandbox_list_files") {
    result = await sandboxRequestPayload({
      type: "list_files",
      sandboxId,
      payload: {
        path: stringArg(args, "path", "."),
        recursive: booleanArg(args, "recursive"),
        maxEntries: numberArg(args, "maxEntries"),
      },
    });
  } else if (action === "sandbox_read_file") {
    result = await sandboxRequestPayload({
      type: "download_file",
      sandboxId,
      payload: {
        path: requiredStringArg(args, "path"),
        maxBytes: numberArg(args, "maxBytes") ?? 512 * 1024,
      },
    });
  } else if (action === "sandbox_search_files") {
    result = await sandboxRequestPayload({
      type: "search_files",
      sandboxId,
      payload: {
        query: requiredStringArg(args, "query"),
        path: stringArg(args, "path", "."),
        maxResults: numberArg(args, "maxResults"),
      },
    });
  } else if (action === "sandbox_upload_file") {
    result = await sandboxRequestPayload({
      type: "upload_file",
      sandboxId,
      payload: {
        path: requiredStringArg(args, "path"),
        contentsBase64: requiredStringArg(args, "contentsBase64"),
      },
    });
  } else if (action === "sandbox_write_file") {
    result = await sandboxRequestPayload({
      type: "upload_file",
      sandboxId,
      payload: {
        path: requiredStringArg(args, "path"),
        contents: stringArg(args, "content", ""),
      },
    });
  } else if (action === "sandbox_edit_file") {
    result = await editSandboxFile({
      sandboxId,
      args,
    });
  } else if (action === "sandbox_delete_file") {
    result = await sandboxRequestPayload({
      type: "delete_file",
      sandboxId,
      payload: {
        path: requiredStringArg(args, "path"),
        recursive: booleanArg(args, "recursive"),
      },
    });
  } else if (action === "sandbox_mkdir") {
    result = await sandboxRequestPayload({
      type: "mkdir",
      sandboxId,
      payload: {
        path: requiredStringArg(args, "path"),
        recursive: booleanArg(args, "recursive") ?? true,
      },
    });
  } else if (action === "sandbox_move_file") {
    result = await sandboxRequestPayload({
      type: "move_file",
      sandboxId,
      payload: {
        fromPath: requiredStringArg(args, "fromPath"),
        toPath: requiredStringArg(args, "toPath"),
        overwrite: booleanArg(args, "overwrite"),
      },
    });
  } else if (action === "sandbox_exec") {
    result = await sandboxRequestPayload({
      type: "exec",
      sandboxId,
      payload: {
        command: requiredStringArg(args, "command"),
        timeoutSeconds: numberArg(args, "timeoutSeconds") ?? 120,
      },
    });
  } else if (action === "sandbox_git_status") {
    result = await sandboxRequestPayload({
      type: "git_status",
      sandboxId,
    });
  } else if (action === "sandbox_git_diff") {
    result = await sandboxRequestPayload({
      type: "git_diff",
      sandboxId,
      payload: {
        baseRef: stringArg(args, "baseRef", ""),
      },
    });
  } else if (action === "sandbox_git_export_patch") {
    result = await sandboxRequestPayload({
      type: "git_export_patch",
      sandboxId,
      payload: {
        baseRef: stringArg(args, "baseRef", ""),
      },
    });
  } else if (action === "sandbox_git_branch") {
    result = await sandboxRequestPayload({
      type: "git_branch",
      sandboxId,
      payload: {
        branch: requiredStringArg(args, "branch"),
        create: booleanArg(args, "create"),
        startPoint: stringArg(args, "startPoint", ""),
      },
    });
  } else if (action === "sandbox_git_commit") {
    const gitCommitPaths = arrayArg(args, "paths");
    result = await sandboxRequestPayload({
      type: "git_commit",
      sandboxId,
      payload: {
        message: requiredStringArg(args, "message"),
        all: booleanArg(args, "all") ?? !(gitCommitPaths && gitCommitPaths.length > 0),
        paths: gitCommitPaths,
      },
    });
  } else if (action === "sandbox_git_pull") {
    result = await sandboxRequestPayload({
      type: "git_pull",
      sandboxId,
      payload: {
        remote: stringArg(args, "remote", ""),
        branch: stringArg(args, "branch", ""),
        rebase: booleanArg(args, "rebase"),
      },
    });
  } else if (action === "sandbox_git_push") {
    result = await sandboxRequestPayload({
      type: "git_push",
      sandboxId,
      payload: {
        remote: stringArg(args, "remote", ""),
        branch: stringArg(args, "branch", ""),
        setUpstream: booleanArg(args, "setUpstream"),
      },
    });
  } else if (action === "sandbox_preserve_source") {
    const runtimeId = await resolveSandboxRuntimeId({
      args,
      sandboxId,
    });
    result = await sandboxRequestPayload({
      type: "sandbox_runtime_preserve_source",
      runtimeId,
      payload: {
        sandboxId,
        message: stringArg(args, "message", ""),
        teamId: stringArg(args, "teamId", ""),
      },
    });
  } else if (action === "sandbox_promote_source") {
    const runtimeId = await resolveSandboxRuntimeId({
      args,
      sandboxId,
    });
    const expectedTargetSha =
      stringArg(args, "expectedTargetSha", "") ||
      (await resolveRuntimeBaseSha(runtimeId));
    result = await sandboxRequestPayload({
      type: "sandbox_runtime_promote",
      runtimeId,
      payload: {
        expectedTargetSha,
        validationState: stringArg(args, "validationState", ""),
        summary: stringArg(args, "summary", ""),
        teamId: stringArg(args, "teamId", ""),
      },
    });
  } else if (action === "sandbox_run_action") {
    let actionSandboxId = sandboxId;
    let createdSandboxResult: unknown | null = null;
    if (!actionSandboxId && (explicitProjectId || explicitAgentId)) {
      createdSandboxResult = await createSandboxFromToolArgs({
        args,
        session: input.session,
        source: "openpond-app-sandbox-action",
        reuseDefaultRuntime: false,
        markDefaultRuntime: false,
      });
      actionSandboxId = sandboxIdFromPayload(createdSandboxResult);
      if (!actionSandboxId) {
        throw new Error("sandbox_create_failed");
      }
    }
    const actionResult = await sandboxRequestPayload({
      type: "action_run",
      sandboxId: actionSandboxId,
      actionName: requiredStringArg(args, "actionName"),
      payload: recordArg(args, "input") ?? recordArg(args, "params") ?? {},
    });
    result = createdSandboxResult
      ? mergeSandboxActionResultWithCreate(actionResult, createdSandboxResult)
      : actionResult;
  } else if (action === "sandbox_open_port") {
    result = await sandboxRequestPayload({
      type: "open_port",
      sandboxId,
      payload: {
        port: numberArg(args, "port"),
        label: stringArg(args, "label", ""),
        access: stringArg(args, "access", ""),
        autoStart: booleanArg(args, "autoStart"),
      },
    });
  } else if (action === "sandbox_logs") {
    result = await sandboxRequestPayload({ type: "logs", sandboxId });
  } else if (action === "sandbox_receipts") {
    result = await sandboxRequestPayload({ type: "receipts", sandboxId });
  } else if (action === "sandbox_schedule_create") {
    result = await sandboxRequestPayload({
      type: "schedule_create",
      payload: args,
    });
  } else {
    result = await sandboxRequestPayload({
      type: "stop",
      sandboxId,
      failOnUnpreservedChanges: true,
    });
  }

  if (action === "sandbox_create" || action === "sandbox_template_launch") {
    const nextSandboxId = sandboxIdFromPayload(result);
    const previewPort = previewPortArg(args);
    if (nextSandboxId && previewPort) {
      const previewResult = await sandboxRequestPayload({
        type: "open_port",
        sandboxId: nextSandboxId,
        payload: {
          port: previewPort,
          label: stringArg(args, "previewLabel", "web"),
          access: stringArg(args, "previewAccess", "private"),
          autoStart: booleanArg(args, "previewAutoStart") ?? true,
        },
      });
      result = mergeSandboxPreviewResult(result, previewResult);
    }
  }

  if (attachToSession && (action === "sandbox_create" || action === "sandbox_template_launch")) {
    const nextSandboxId = sandboxIdFromPayload(result);
    if (nextSandboxId) {
      const sandbox = asRecord(asRecord(result).sandbox);
      await input.updateSession(input.session.id, {
        appId: null,
        appName: null,
        workspaceKind: "sandbox",
        workspaceId: nextSandboxId,
        workspaceName: sandboxName(sandbox),
        cwd: null,
      });
    }
  }

  return {
    ok: true,
    action,
    appId: null,
    output: summarizeSandboxToolResult(action, result, { attached: attachToSession }),
    data: result,
  };
}

async function editSandboxFile(input: {
  sandboxId: string;
  args: Record<string, unknown>;
}): Promise<Record<string, unknown>> {
  const filePath = requiredStringArg(input.args, "path");
  const oldText = requiredStringArg(input.args, "oldText");
  const newText =
    typeof input.args.newText === "string" ? input.args.newText : "";
  const replaceAll = booleanArg(input.args, "replaceAll") === true;
  const maxBytes = numberArg(input.args, "maxBytes") ?? 2 * 1024 * 1024;
  const currentPayload = asRecord(
    await sandboxRequestPayload({
      type: "download_file",
      sandboxId: input.sandboxId,
      payload: {
        path: filePath,
        maxBytes,
      },
    }),
  );
  const currentFile = asRecord(currentPayload.file);
  const currentText = sandboxTextFileContents(currentFile, filePath);
  const replacements = currentText.split(oldText).length - 1;
  if (replacements === 0) {
    throw new Error(`Text not found in ${filePath}`);
  }
  if (replacements > 1 && !replaceAll) {
    throw new Error(
      `Text matched ${replacements} times in ${filePath}; provide a longer oldText that matches only the intended location, or set replaceAll true.`
    );
  }
  const nextText = currentText.split(oldText).join(newText);
  const uploadPayload = asRecord(
    await sandboxRequestPayload({
      type: "upload_file",
      sandboxId: input.sandboxId,
      payload: {
        path: filePath,
        contents: nextText,
      },
    }),
  );
  const verifyPayload = asRecord(
    await sandboxRequestPayload({
      type: "download_file",
      sandboxId: input.sandboxId,
      payload: {
        path: filePath,
        maxBytes: Math.max(1, Buffer.byteLength(nextText, "utf8")),
      },
    }),
  );
  const verifiedText = sandboxTextFileContents(
    asRecord(verifyPayload.file),
    filePath,
  );
  if (verifiedText !== nextText) {
    throw new Error(`Failed to verify sandbox edit for ${filePath}`);
  }
  return {
    ...uploadPayload,
    edit: {
      path: filePath,
      replacements,
      verified: true,
      sizeBytes: Buffer.byteLength(nextText, "utf8"),
    },
  };
}

function sandboxTextFileContents(
  file: Record<string, unknown>,
  filePath: string,
): string {
  if (file.isBinary === true) {
    throw new Error(`Cannot text-edit binary sandbox file ${filePath}`);
  }
  if (file.truncated === true) {
    throw new Error(`Cannot text-edit truncated sandbox file ${filePath}`);
  }
  if (typeof file.contentsBase64 !== "string") {
    throw new Error(`Sandbox file ${filePath} did not return text contents`);
  }
  return Buffer.from(file.contentsBase64, "base64").toString("utf8");
}

async function createSandboxFromToolArgs(params: {
  args: Record<string, unknown>;
  session: Session;
  source: string;
  reuseDefaultRuntime?: boolean;
  markDefaultRuntime?: boolean;
}): Promise<unknown> {
  const { args } = params;
  const teamId = stringArg(args, "teamId", "");
  const projectId = stringArg(args, "projectId", "");
  const agentId = stringArg(args, "agentId", "");
  const requestedRuntime = recordArg(args, "runtime") ?? {};
  const requestedRuntimeId =
    typeof requestedRuntime.runtimeId === "string"
      ? requestedRuntime.runtimeId.trim()
      : "";
  const requestedRuntimeCreate = { ...requestedRuntime };
  delete requestedRuntimeCreate.runtimeId;
  const workflowMode =
    stringArg(args, "workflowMode", "") ||
    (typeof requestedRuntime.workflowMode === "string"
      ? requestedRuntime.workflowMode
      : projectId || agentId
        ? "feature"
        : "attempt");
  const runtimeBaseBranch =
    stringArg(args, "runtimeBaseBranch", "") ||
    (typeof requestedRuntime.baseBranch === "string"
      ? requestedRuntime.baseBranch
      : "master");
  const runtimePromotionPolicy =
    stringArg(args, "runtimePromotionPolicy", "") ||
    (typeof requestedRuntime.promotionPolicy === "string"
      ? requestedRuntime.promotionPolicy
      : projectId || agentId
        ? "manual"
        : "none");
  const createRequestId = randomUUID();
  const reuseDefaultRuntime = params.reuseDefaultRuntime ?? true;
  const markDefaultRuntime = params.markDefaultRuntime ?? Boolean(projectId || agentId);
  const metadata = {
    source: params.source,
    ...recordArg(args, "metadata"),
    [SANDBOX_CREATE_REQUEST_ID_METADATA_KEY]: createRequestId,
  };
  const requestedRuntimeMetadata = asRecord(requestedRuntime.metadata);
  const runtimeMetadata = sandboxChatDefaultRuntimeMetadata({
    ...requestedRuntimeMetadata,
    requestId: createRequestId,
    defaultRuntime: markDefaultRuntime,
    ...(projectId ? { projectId } : {}),
    ...(agentId ? { agentId } : {}),
  });
  const reusableRuntimeId =
    requestedRuntimeId ||
    (reuseDefaultRuntime && (projectId || agentId)
      ? await findReusableSandboxChatRuntimeId({
          projectId,
          agentId,
          teamId,
          mode: workflowMode,
        })
      : "");

  return createSandboxWithTimeoutRecovery({
    runtimeId: reusableRuntimeId,
    runtimePayload: {
      ...requestedRuntimeCreate,
      ...(teamId ? { teamId } : {}),
      workflowMode,
      baseBranch: runtimeBaseBranch,
      promotionPolicy: runtimePromotionPolicy,
      ...(projectId ? { projectId } : {}),
      ...(agentId ? { agentId } : {}),
      metadata: runtimeMetadata,
    },
    sandboxPayload: {
      repo: stringArg(args, "repo", ""),
      teamId,
      projectId,
      agentId,
      command: stringArg(args, "command", ""),
      visibility: stringArg(args, "visibility", "team"),
      resources: recordArg(args, "resources"),
      budget: recordArg(args, "budget"),
      volumes: arrayArg(args, "volumes"),
      quotas: recordArg(args, "quotas"),
      metadata,
    },
    teamId,
    projectId,
    agentId,
    metadata,
  });
}

function mergeSandboxActionResultWithCreate(
  actionResult: unknown,
  createResult: unknown,
): Record<string, unknown> {
  const createdPayload = asRecord(createResult);
  return {
    ...asRecord(actionResult),
    createdSandbox: asRecord(createdPayload.sandbox),
    recovery: asRecord(createdPayload.recovery),
  };
}

function summarizeSandboxToolResult(
  action: SandboxToolAction,
  result: unknown,
  options: { attached?: boolean } = {},
): string {
  const payload = asRecord(result);
  if (action === "sandbox_create" || action === "sandbox_template_launch") {
    const sandbox = asRecord(payload.sandbox);
    const id = typeof sandbox.id === "string" ? sandbox.id : "sandbox";
    const recovery = asRecord(payload.recovery);
    const recoveredFromTimeout =
      recovery.reason === "gateway_timeout" || recovery.reason === "request_timeout";
    const state = typeof sandbox.state === "string" ? sandbox.state : "";
    const preview = asRecord(payload.preview);
    const label = options.attached === false ? "Sandbox started" : "Active sandbox workspace";
    const message = typeof preview.url === "string"
      ? `${label}: ${id}\nPreview: ${preview.url}`
      : `${label}: ${id}`;
    return recoveredFromTimeout
      ? `Sandbox create/resume timed out, then recovered ${id}${state ? ` in ${state} state` : ""}.\n${message}`
      : message;
  }
  if (action === "sandbox_templates") {
    const templates = Array.isArray(payload.templates) ? payload.templates.length : 0;
    return `Listed ${templates} sandbox templates.`;
  }
  if (action === "sandbox_snapshot_catalog") {
    const snapshots = Array.isArray(payload.snapshots) ? payload.snapshots.length : 0;
    return `Listed ${snapshots} sandbox snapshots.`;
  }
  if (
    action === "sandbox_snapshot_create" ||
    action === "sandbox_snapshot_update" ||
    action === "sandbox_snapshot_publish"
  ) {
    const snapshot = asRecord(payload.snapshot);
    const id = typeof snapshot.id === "string" ? snapshot.id : "snapshot";
    return `Updated sandbox snapshot ${id}.`;
  }
  if (action === "sandbox_snapshot_validate") {
    const validation = asRecord(payload.validation);
    const status = typeof validation.status === "string" ? validation.status : "completed";
    return `Snapshot validation ${status}.`;
  }
  if (action === "sandbox_replays") {
    const replays = Array.isArray(payload.replays) ? payload.replays.length : 0;
    return `Listed ${replays} sandbox replay runs.`;
  }
  if (action === "sandbox_replay_start" || action === "sandbox_replay_get" || action === "sandbox_replay_cancel") {
    const replay = asRecord(payload.replay);
    const id = typeof replay.id === "string" ? replay.id : "replay";
    const state = typeof replay.state === "string" ? replay.state : "updated";
    return `Sandbox replay ${id} is ${state}.`;
  }
  if (action === "sandbox_replay_logs") {
    const logs = Array.isArray(payload.logs) ? payload.logs : [];
    return logs.length ? logs.slice(-24).join("\n") : "No replay logs.";
  }
  if (action === "sandbox_schedule_create") {
    const schedule = asRecord(payload.schedule);
    const name = typeof schedule.name === "string" ? schedule.name : "schedule";
    return `Created sandbox schedule ${name}.`;
  }
  if (action === "sandbox_replay_artifacts") {
    const artifacts = Array.isArray(payload.artifacts) ? payload.artifacts.length : 0;
    return `Read ${artifacts} replay artifacts.`;
  }
  if (action === "sandbox_read_file") {
    const file = asRecord(payload.file);
    const contentsBase64 = typeof file.contentsBase64 === "string" ? file.contentsBase64 : "";
    const text = contentsBase64 ? Buffer.from(contentsBase64, "base64").toString("utf8") : "";
    const path = typeof file.path === "string" ? file.path : "file";
    return text ? `${path}\n\n${text}` : `Read ${path}`;
  }
  if (action === "sandbox_exec") {
    const command = asRecord(payload.command);
    const status = typeof command.status === "string" ? command.status : "completed";
    const output = typeof command.output === "string" ? command.output.trim() : "";
    return output ? `Command ${status}\n\n${output}` : `Command ${status}`;
  }
  if (action === "sandbox_run_action") {
    const createdSandbox = asRecord(payload.createdSandbox);
    const createdSandboxId =
      typeof createdSandbox.id === "string" ? createdSandbox.id : "";
    const actionPayload = asRecord(payload.action);
    const actionName = typeof actionPayload.name === "string" ? actionPayload.name : "action";
    const command = asRecord(payload.command);
    const status = typeof command.status === "string" ? command.status : "completed";
    const output = typeof command.output === "string" ? command.output.trim() : "";
    const prefix = createdSandboxId ? `Sandbox started: ${createdSandboxId}\n` : "";
    const actionSummary = output
      ? `Action ${actionName} ${status}\n\n${output}`
      : `Action ${actionName} ${status}`;
    return `${prefix}${actionSummary}`;
  }
  if (action === "sandbox_list_files") {
    const files = Array.isArray(payload.files) ? payload.files.length : 0;
    return `Listed ${files} sandbox file entries.`;
  }
  if (action === "sandbox_search_files") {
    const matches = Array.isArray(payload.matches) ? payload.matches.length : 0;
    return `Found ${matches} sandbox file matches.`;
  }
  if (action === "sandbox_upload_file") {
    const file = asRecord(payload.file);
    const path = typeof file.path === "string" ? file.path : "file";
    return `Uploaded ${path}.`;
  }
  if (action === "sandbox_write_file") {
    const file = asRecord(payload.file);
    const path = typeof file.path === "string" ? file.path : "file";
    return `Wrote ${path}.`;
  }
  if (action === "sandbox_edit_file") {
    const edit = asRecord(payload.edit);
    const path = typeof edit.path === "string" ? edit.path : "file";
    const replacements =
      typeof edit.replacements === "number" ? edit.replacements : 0;
    return `Edited ${path} with ${replacements} replacement${replacements === 1 ? "" : "s"}.`;
  }
  if (action === "sandbox_delete_file") {
    const deleted = asRecord(payload.deleted);
    const path = typeof deleted.path === "string" ? deleted.path : "file";
    return `Deleted ${path}.`;
  }
  if (action === "sandbox_mkdir") {
    const directory = asRecord(payload.directory);
    const path = typeof directory.path === "string" ? directory.path : "directory";
    return `Created directory ${path}.`;
  }
  if (action === "sandbox_move_file") {
    const moved = asRecord(payload.moved);
    const fromPath = typeof moved.fromPath === "string" ? moved.fromPath : "";
    const toPath = typeof moved.toPath === "string" ? moved.toPath : "";
    return fromPath && toPath
      ? `Moved ${fromPath} to ${toPath}.`
      : "Moved sandbox file.";
  }
  if (action === "sandbox_git_status") {
    const status = asRecord(payload.status);
    const porcelain = typeof status.porcelain === "string" ? status.porcelain : "";
    const files = porcelain.split("\n").filter((line) => line.trim()).length;
    return `Sandbox git status has ${files} changed file${files === 1 ? "" : "s"}.`;
  }
  if (action === "sandbox_git_diff") {
    const diff = asRecord(payload.diff);
    const text = typeof diff.diff === "string" ? diff.diff.trim() : "";
    return text ? `Sandbox git diff\n\n${text}` : "Sandbox git diff is empty.";
  }
  if (action === "sandbox_git_export_patch") {
    const patch = asRecord(payload.patch);
    const bytes = typeof patch.bytes === "number" ? patch.bytes : 0;
    const filename = typeof patch.filename === "string" ? patch.filename : "sandbox.patch";
    const text = typeof patch.patch === "string" ? patch.patch.trim() : "";
    return text
      ? `Exported sandbox patch ${filename} (${bytes} bytes)\n\n${text}`
      : `Exported empty sandbox patch ${filename}.`;
  }
  if (action === "sandbox_git_branch") {
    const branch = asRecord(payload.branch);
    const name = typeof branch.branch === "string" ? branch.branch : "branch";
    return `Sandbox git branch is ${name}.`;
  }
  if (action === "sandbox_git_commit") {
    const commit = asRecord(payload.commit);
    const sha = typeof commit.commitHash === "string" ? commit.commitHash : "commit";
    return `Committed sandbox changes at ${sha}.`;
  }
  if (action === "sandbox_git_pull") {
    const operation = asRecord(payload.pull);
    const output = typeof operation.output === "string" ? operation.output.trim() : "";
    return output ? `Sandbox git pull completed\n\n${output}` : "Sandbox git pull completed.";
  }
  if (action === "sandbox_git_push") {
    const operation = asRecord(payload.push);
    const output = typeof operation.output === "string" ? operation.output.trim() : "";
    return output ? `Sandbox git push completed\n\n${output}` : "Sandbox git push completed.";
  }
  if (action === "sandbox_preserve_source") {
    const preservedSha = typeof payload.preservedSha === "string" ? payload.preservedSha : "";
    const preserved = payload.preserved === true;
    return preserved
      ? `Preserved sandbox changes to runtime source ref at ${preservedSha}.`
      : "No sandbox source changes needed preservation.";
  }
  if (action === "sandbox_promote_source") {
    const promotedSha = typeof payload.promotedSha === "string" ? payload.promotedSha : "";
    return promotedSha
      ? `Promoted runtime source ref to the Project branch at ${promotedSha}.`
      : "Promoted runtime source ref.";
  }
  if (action === "sandbox_logs") {
    const logs = Array.isArray(payload.logs) ? payload.logs : [];
    return logs.length ? logs.slice(-24).join("\n") : "No sandbox logs.";
  }
  if (action === "sandbox_receipts") {
    const receipts = Array.isArray(payload.receipts) ? payload.receipts.length : 0;
    return `Read ${receipts} sandbox receipts.`;
  }
  if (action === "sandbox_open_port") {
    const preview = asRecord(payload.preview);
    return typeof preview.url === "string" ? `Opened preview ${preview.url}` : "Opened preview port.";
  }
  if (action === "sandbox_stop") {
    const changes = asRecord(payload.unpreservedChanges);
    const state = typeof changes.state === "string" ? changes.state : "";
    return state ? `Stopped sandbox. Source change state: ${state}.` : "Stopped sandbox.";
  }
  return "Read sandbox status.";
}

export function sandboxChatDefaultRuntimeMetadata(input: {
  requestId: string;
  defaultRuntime: boolean;
  [key: string]: unknown;
}): Record<string, unknown> {
  const { requestId, defaultRuntime, ...rest } = input;
  const metadata: Record<string, unknown> = {
    ...rest,
    source: "openpond-app-sandbox-chat",
    [SANDBOX_CREATE_REQUEST_ID_METADATA_KEY]: requestId,
  };
  if (defaultRuntime) {
    metadata[SANDBOX_CHAT_DEFAULT_RUNTIME_METADATA_KEY] = true;
  } else {
    delete metadata[SANDBOX_CHAT_DEFAULT_RUNTIME_METADATA_KEY];
  }
  return metadata;
}

export function pickSandboxChatDefaultRuntime(input: {
  runtimes: SandboxRuntime[];
  projectId?: string;
  agentId?: string;
  mode?: string;
}): SandboxRuntime | null {
  const projectId = input.projectId?.trim() ?? "";
  const agentId = input.agentId?.trim() ?? "";
  const mode = input.mode?.trim();
  if (!projectId && !agentId) return null;
  return (
    input.runtimes.find((runtime) => {
      if (projectId && runtime.projectId !== projectId) return false;
      if (agentId && runtime.agentId !== agentId) return false;
      const runtimeMode = runtime.workflowMode ?? (runtime as { mode?: string }).mode;
      if (mode && runtimeMode !== mode) return false;
      if (TERMINAL_RUNTIME_STATUSES.has(runtime.status)) return false;
      if (runtime.status === "checkpointed" && !runtime.rootfsSnapshotId) return false;
      return asRecord(runtime.metadata)[SANDBOX_CHAT_DEFAULT_RUNTIME_METADATA_KEY] === true;
    }) ?? null
  );
}

async function findReusableSandboxChatRuntimeId(input: {
  projectId: string;
  agentId: string;
  teamId: string;
  mode: string;
}): Promise<string> {
  const payload = await sandboxRequestPayload({
    type: "sandbox_runtime_list",
    payload: {
      ...(input.teamId ? { teamId: input.teamId } : {}),
      ...(input.projectId ? { projectId: input.projectId } : {}),
      ...(input.agentId ? { agentId: input.agentId } : {}),
    },
  });
  const runtimes = Array.isArray(asRecord(payload).runtimes)
    ? (asRecord(payload).runtimes as SandboxRuntime[])
    : [];
  return pickSandboxChatDefaultRuntime({
    runtimes,
    projectId: input.projectId,
    agentId: input.agentId,
    mode: input.mode,
  })?.id ?? "";
}

async function createSandboxWithTimeoutRecovery(input: {
  runtimeId?: string;
  runtimePayload: Record<string, unknown>;
  sandboxPayload: Record<string, unknown>;
  teamId: string;
  projectId: string;
  agentId: string;
  metadata: Record<string, unknown>;
}): Promise<unknown> {
  const requestedAtMs = Date.now();
  let resolvedRuntimeId = input.runtimeId ?? "";
  try {
    const runtimePayload = input.runtimeId
      ? {}
      : await sandboxCreateRequestWithTimeout(
          sandboxRequestPayload({
            type: "sandbox_runtime_create",
            payload: input.runtimePayload,
          }),
          "runtime create",
        );
    resolvedRuntimeId = input.runtimeId || runtimeIdFromPayload(runtimePayload);
    if (!resolvedRuntimeId) {
      throw new Error("Sandbox runtime create response did not include a runtime id.");
    }
    const sandboxPayload = await sandboxCreateRequestWithTimeout(
      sandboxRequestPayload(
        input.runtimeId
          ? {
              type: "sandbox_runtime_resume",
              runtimeId: resolvedRuntimeId,
              payload: input.sandboxPayload,
            }
          : {
              type: "sandbox_runtime_sandbox_create",
              runtimeId: resolvedRuntimeId,
              payload: input.sandboxPayload,
            },
      ),
      input.runtimeId ? "runtime resume" : "runtime sandbox create",
    );
    return mergeSandboxRuntimeSandboxResult(runtimePayload, sandboxPayload);
  } catch (error) {
    const recoveryReason = sandboxCreateRecoveryReason(error);
    if (!recoveryReason) throw error;
    const recovered = await waitForRecoveredSandboxCreate({
      teamId: input.teamId,
      projectId: input.projectId,
      agentId: input.agentId,
      metadata: input.metadata,
      requestedAtMs,
      runtimeId: resolvedRuntimeId,
      timeoutMs: SANDBOX_CREATE_RECOVERY_TIMEOUT_MS,
    });
    if (!recovered) {
      throw new Error("Sandbox create request timed out, and no matching sandbox appeared.");
    }

    const state = sandboxState(recovered.sandbox);
    if (state === "running") {
      return {
        sandbox: recovered.sandbox,
        account: recovered.account,
        recovery: { reason: recoveryReason },
      };
    }

    const id = sandboxId(recovered.sandbox);
    const logs = id ? await readSandboxRecoveryLogs(id) : [];
    throw new Error(sandboxCreateRecoveryMessage(recovered.sandbox, logs));
  }
}

async function sandboxCreateRequestWithTimeout<T>(
  promise: Promise<T>,
  label: string,
): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | null = null;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_resolve, reject) => {
        timeout = setTimeout(() => {
          reject(
            new SandboxCreateRequestTimeoutError(
              `Sandbox ${label} request did not complete within ${SANDBOX_CREATE_REQUEST_TIMEOUT_MS}ms.`,
            ),
          );
        }, SANDBOX_CREATE_REQUEST_TIMEOUT_MS);
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

async function waitForRecoveredSandboxCreate(input: {
  teamId: string;
  projectId: string;
  agentId: string;
  metadata: Record<string, unknown>;
  requestedAtMs: number;
  runtimeId: string;
  timeoutMs: number;
}): Promise<{ sandbox: Record<string, unknown>; account: unknown } | null> {
  const deadline = Date.now() + input.timeoutMs;
  let latestMatch: { sandbox: Record<string, unknown>; account: unknown } | null = null;

  while (Date.now() <= deadline) {
    const payload = await sandboxRequestPayload({
      type: "list",
      payload: {
        ...(input.teamId ? { teamId: input.teamId } : {}),
        ...(input.projectId ? { projectId: input.projectId } : {}),
        ...(input.agentId ? { agentId: input.agentId } : {}),
      },
    });
    const record = asRecord(payload);
    const account = record.account;
    const sandboxes = Array.isArray(record.sandboxes) ? record.sandboxes : [];
    const match = sandboxes
      .map(asRecord)
      .find((sandbox) => sandboxMatchesCreateRequest(sandbox, input));
    if (match) {
      latestMatch = { sandbox: match, account };
      const state = sandboxState(match);
      if (state === "running" || state === "error" || state === "failed" || state === "stopped" || state === "deleted") {
        return latestMatch;
      }
    }
    await sleep(SANDBOX_CREATE_RECOVERY_POLL_MS);
  }

  return latestMatch;
}

function sandboxMatchesCreateRequest(
  sandbox: Record<string, unknown>,
  input: {
    metadata: Record<string, unknown>;
    requestedAtMs: number;
    runtimeId: string;
  },
): boolean {
  const expectedRequestId = input.metadata[SANDBOX_CREATE_REQUEST_ID_METADATA_KEY];
  const sandboxMetadata = asRecord(sandbox.metadata);
  if (
    typeof expectedRequestId === "string" &&
    expectedRequestId &&
    sandboxMetadata[SANDBOX_CREATE_REQUEST_ID_METADATA_KEY] === expectedRequestId
  ) {
    return true;
  }

  if (!input.runtimeId || sandbox.runtimeId !== input.runtimeId) return false;
  const state = sandboxState(sandbox);
  if (state === "running" || state === "creating") return true;
  const startedAt = typeof sandbox.startedAt === "string" ? Date.parse(sandbox.startedAt) : NaN;
  return Number.isFinite(startedAt) && startedAt >= input.requestedAtMs;
}

async function readSandboxRecoveryLogs(sandboxId: string): Promise<string[]> {
  try {
    const payload = await sandboxRequestPayload({ type: "logs", sandboxId });
    const logs = asRecord(payload).logs;
    if (!Array.isArray(logs)) return [];
    return logs.map(formatSandboxLogLine).filter(Boolean).slice(-24);
  } catch {
    return [];
  }
}

function formatSandboxLogLine(value: unknown): string {
  if (typeof value === "string") return value.trim();
  const record = asRecord(value);
  const timestamp = typeof record.timestamp === "string" ? record.timestamp : "";
  const level = typeof record.level === "string" ? record.level : "";
  const message =
    typeof record.message === "string"
      ? record.message
      : typeof record.output === "string"
        ? record.output
        : typeof record.line === "string"
          ? record.line
          : "";
  return [timestamp, level, message].filter(Boolean).join(" ").trim();
}

function sandboxCreateRecoveryMessage(sandbox: Record<string, unknown>, logs: string[]): string {
  const id = sandboxId(sandbox) ?? "sandbox";
  const state = sandboxState(sandbox) || "unknown";
  const summary = `Sandbox create request timed out. Found ${id} in ${state} state.`;
  return logs.length > 0 ? `${summary}\n\nRecent sandbox logs:\n${logs.join("\n")}` : summary;
}

function sandboxId(sandbox: Record<string, unknown>): string | null {
  return typeof sandbox.id === "string" && sandbox.id ? sandbox.id : null;
}

function sandboxState(sandbox: Record<string, unknown>): string {
  return typeof sandbox.state === "string" ? sandbox.state : "";
}

function isSandboxCreateGatewayTimeout(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return message.includes("504") || /endpoint request timed out/i.test(message);
}

function sandboxCreateRecoveryReason(error: unknown): "gateway_timeout" | "request_timeout" | null {
  if (error instanceof SandboxCreateRequestTimeoutError) return "request_timeout";
  return isSandboxCreateGatewayTimeout(error) ? "gateway_timeout" : null;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function sandboxIdFromPayload(value: unknown): string {
  const sandbox = asRecord(asRecord(value).sandbox);
  return typeof sandbox.id === "string" ? sandbox.id : "";
}

function runtimeIdFromPayload(value: unknown): string {
  const runtime = asRecord(asRecord(value).runtime);
  return typeof runtime.id === "string" ? runtime.id : "";
}

async function resolveSandboxRuntimeId(input: {
  args: Record<string, unknown>;
  sandboxId: string;
}): Promise<string> {
  const explicitRuntimeId = stringArg(input.args, "runtimeId", "");
  if (explicitRuntimeId) return explicitRuntimeId;
  const payload = await sandboxRequestPayload({
    type: "get",
    sandboxId: input.sandboxId,
  });
  const sandbox = asRecord(asRecord(payload).sandbox);
  const runtimeId = typeof sandbox.runtimeId === "string" ? sandbox.runtimeId.trim() : "";
  if (runtimeId) return runtimeId;
  throw new Error("Active sandbox is not attached to a sandbox runtime.");
}

async function resolveRuntimeBaseSha(runtimeId: string): Promise<string> {
  const payload = await sandboxRequestPayload({
    type: "sandbox_runtime_get",
    runtimeId,
  });
  const runtime = asRecord(asRecord(payload).runtime);
  const baseSha = typeof runtime.baseSha === "string" ? runtime.baseSha.trim() : "";
  if (!baseSha) {
    throw new Error("Sandbox runtime does not have a base SHA for promotion.");
  }
  return baseSha;
}

function mergeSandboxRuntimeSandboxResult(
  runtimeResult: unknown,
  sandboxResult: unknown,
): Record<string, unknown> {
  const runtimePayload = asRecord(runtimeResult);
  const sandboxPayload = asRecord(sandboxResult);
  return {
    ...runtimePayload,
    ...sandboxPayload,
    runtime: sandboxPayload.runtime ?? runtimePayload.runtime,
    account: sandboxPayload.account ?? runtimePayload.account,
  };
}

function mergeSandboxPreviewResult(sandboxResult: unknown, previewResult: unknown): Record<string, unknown> {
  const sandboxPayload = asRecord(sandboxResult);
  const previewPayload = asRecord(previewResult);
  return {
    ...sandboxPayload,
    ...previewPayload,
    sandbox: previewPayload.sandbox ?? sandboxPayload.sandbox,
    account: previewPayload.account ?? sandboxPayload.account,
  };
}

function requiredStringArg(args: Record<string, unknown>, key: string): string {
  const value = stringArg(args, key, "");
  if (!value) throw new Error(`${key} is required.`);
  return value;
}

function stringArg(args: Record<string, unknown>, key: string, fallback: string): string {
  const value = args[key];
  return typeof value === "string" ? value.trim() : fallback;
}

function sandboxCatalogPayload(args: Record<string, unknown>): Record<string, unknown> {
  return {
    teamId: stringArg(args, "teamId", ""),
    projectId: stringArg(args, "projectId", ""),
    agentId: stringArg(args, "agentId", ""),
    q: stringArg(args, "q", ""),
    name: stringArg(args, "name", ""),
    version: stringArg(args, "version", ""),
    tag: stringArg(args, "tag", ""),
    useCase: stringArg(args, "useCase", ""),
  };
}

function numberArg(args: Record<string, unknown>, key: string): number | undefined {
  const value = Number(args[key]);
  return Number.isFinite(value) ? value : undefined;
}

function previewPortArg(args: Record<string, unknown>): number | undefined {
  const value = Number(args.previewPort);
  if (
    !Number.isInteger(value) ||
    value < SANDBOX_TEMPLATE_PREVIEW_PORT_MIN ||
    value > SANDBOX_TEMPLATE_PREVIEW_PORT_MAX
  ) {
    return undefined;
  }
  return value;
}

function booleanArg(args: Record<string, unknown>, key: string): boolean | undefined {
  return typeof args[key] === "boolean" ? (args[key] as boolean) : undefined;
}

function recordArg(args: Record<string, unknown>, key: string): Record<string, unknown> | undefined {
  const value = args[key];
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function arrayArg(args: Record<string, unknown>, key: string): unknown[] | undefined {
  const value = args[key];
  return Array.isArray(value) ? value : undefined;
}

function sandboxName(sandbox: Record<string, unknown>): string {
  const repo = typeof sandbox.repo === "string" ? sandbox.repo : "";
  if (!repo) return typeof sandbox.id === "string" ? sandbox.id : "Sandbox";
  const trimmed = repo.replace(/\.git$/, "").replace(/\/$/, "");
  const parts = trimmed.split("/");
  return parts.slice(-2).join("/");
}
