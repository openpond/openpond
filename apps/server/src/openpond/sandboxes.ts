import { createOpenPondSandboxClient, normalizeSandboxApiUrl } from "@openpond/cloud";
import type {
  SandboxRuntimeCreateInput,
  SandboxRuntimeSandboxCreateInput,
  OpenPondSandboxClient,
  SandboxCreateInput,
  SandboxExecInput,
  SandboxFileDownloadInput,
  SandboxForkInput,
  SandboxGitBranchInput,
  SandboxGitCommitInput,
  SandboxGitPullInput,
  SandboxGitPushInput,
  SandboxIntegrationConnectionLeaseInput,
  SandboxIntegrationConnectionStatusFilter,
  SandboxOpenPortInput,
  SandboxProcessStartInput,
  SandboxPtyInput,
  SandboxPtyStartInput,
  SandboxReplayInput,
  SandboxScheduleCreateInput,
  SandboxSnapshotInput,
  SandboxTemplateBuildCreateInput,
  SandboxTemplateLaunchInput,
  SandboxSnapshotValidateInput,
  SandboxSnapshotUpdateInput,
  SandboxEnvVarInput,
} from "@openpond/cloud";
import {
  SANDBOX_TEMPLATE_PREVIEW_PORT_MAX,
  SANDBOX_TEMPLATE_PREVIEW_PORT_MIN,
} from "@openpond/contracts";
import { loadOpenPondAccountContext } from "@openpond/runtime";
import type { RuntimeAccountContext } from "@openpond/runtime";

export type SandboxRequestAction =
  | { type: "list"; payload?: unknown }
  | { type: "volume_list"; payload?: unknown }
  | { type: "volume_create"; payload: unknown }
  | { type: "volume_get"; volumeId: string; payload?: unknown }
  | { type: "volume_delete"; volumeId: string; payload?: unknown }
  | { type: "secret_list"; payload?: unknown }
  | { type: "secret_get"; secretId: string; payload?: unknown }
  | { type: "secret_create"; payload: unknown }
  | { type: "secret_rotate"; secretId: string; payload: unknown }
  | { type: "secret_attach"; secretId: string; payload: unknown }
  | { type: "secret_revoke"; secretId: string; payload?: unknown }
  | { type: "secret_delete"; secretId: string; payload?: unknown }
  | { type: "snapshot_catalog"; payload: unknown }
  | { type: "snapshot_create"; sandboxId: string; payload: unknown }
  | { type: "template_catalog"; payload: unknown }
  | { type: "template_launch"; payload: unknown }
  | { type: "template_builds"; payload: unknown }
  | { type: "template_build_create"; payload: unknown }
  | { type: "template_build_get"; buildId: string }
  | { type: "template_build_logs"; buildId: string }
  | { type: "template_build_cancel"; buildId: string }
  | { type: "integration_connections"; payload: unknown }
  | { type: "integration_leases"; sandboxId: string }
  | { type: "integration_attach"; sandboxId: string; payload: unknown }
  | { type: "integration_remove"; sandboxId: string; payload: unknown }
  | { type: "sandbox_runtime_list"; payload?: unknown }
  | { type: "sandbox_runtime_get"; runtimeId: string; payload?: unknown }
  | { type: "sandbox_runtime_create"; payload: unknown }
  | { type: "sandbox_runtime_sandbox_create"; runtimeId: string; payload: unknown }
  | { type: "sandbox_runtime_resume"; runtimeId: string; payload?: unknown }
  | { type: "sandbox_runtime_preserve_source"; runtimeId: string; payload: unknown }
  | { type: "sandbox_runtime_promote"; runtimeId: string; payload: unknown }
  | { type: "project_list"; payload: unknown }
  | { type: "profile_get"; payload: unknown }
  | { type: "profile_ensure"; payload: unknown }
  | { type: "profile_push"; payload: unknown }
  | { type: "project_upsert"; payload: unknown }
  | { type: "project_get"; projectId: string; payload: unknown }
  | { type: "project_git"; projectId: string; payload: unknown }
  | { type: "project_sync"; projectId: string; payload: unknown }
  | { type: "project_source_upload"; projectId: string; payload: unknown }
  | { type: "project_archive"; projectId: string; payload: unknown }
  | { type: "work_item_list"; projectId: string; payload: unknown }
  | { type: "work_item_create"; projectId: string; payload: unknown }
  | { type: "work_item_get"; workItemId: string; payload: unknown }
  | { type: "work_item_messages"; workItemId: string; payload: unknown }
  | { type: "work_item_message_create"; workItemId: string; payload: unknown }
  | { type: "work_item_chat"; workItemId: string; payload: unknown }
  | { type: "work_item_activity"; workItemId: string; payload: unknown }
  | { type: "work_item_handle_background"; workItemId: string; payload: unknown }
  | { type: "work_item_cancel_task"; workItemId: string; payload: unknown }
  | { type: "work_item_open_cloud"; workItemId: string; payload: unknown }
  | { type: "agent_list"; payload: unknown }
  | { type: "agent_upsert"; payload: unknown }
  | { type: "agent_get"; agentId: string; payload: unknown }
  | { type: "agent_archive"; agentId: string; payload: unknown }
  | { type: "agent_run"; agentId: string; payload: unknown }
  | { type: "create"; payload: unknown }
  | { type: "get"; sandboxId: string }
  | { type: "delete"; sandboxId: string; failOnUnpreservedChanges?: boolean }
  | { type: "exec"; sandboxId: string; payload: unknown }
  | { type: "action_run"; sandboxId: string; actionName: string; payload?: unknown }
  | { type: "open_port"; sandboxId: string; payload: unknown }
  | { type: "snapshot_update"; sandboxId: string; snapshotId: string; payload: unknown }
  | { type: "snapshot_validate"; sandboxId: string; snapshotId: string; payload: unknown }
  | { type: "snapshot_publish"; sandboxId: string; snapshotId: string }
  | { type: "snapshot_fork"; snapshotId: string; payload: unknown }
  | { type: "replays"; payload: unknown }
  | { type: "replay_start"; payload: unknown }
  | { type: "replay_get"; replayId: string; payload?: unknown }
  | { type: "replay_logs"; replayId: string; payload?: unknown }
  | { type: "replay_artifacts"; replayId: string; payload?: unknown }
  | { type: "replay_cancel"; replayId: string; payload?: unknown }
  | { type: "schedule_create"; payload: unknown }
  | { type: "fork"; sandboxId: string; payload: unknown }
  | { type: "stop"; sandboxId: string; failOnUnpreservedChanges?: boolean }
  | { type: "receipts"; sandboxId: string }
  | { type: "logs"; sandboxId: string }
  | { type: "billing"; sandboxId: string }
  | { type: "process_start"; sandboxId: string; payload: unknown }
  | { type: "process_list"; sandboxId: string }
  | { type: "process_get"; sandboxId: string; processId: string; payload: unknown }
  | { type: "process_stop"; sandboxId: string; processId: string }
  | { type: "pty_start"; sandboxId: string; payload: unknown }
  | { type: "pty_list"; sandboxId: string }
  | { type: "pty_get"; sandboxId: string; ptyId: string; payload: unknown }
  | { type: "pty_input"; sandboxId: string; ptyId: string; payload: unknown }
  | { type: "pty_stop"; sandboxId: string; ptyId: string }
  | { type: "upload_file"; sandboxId: string; payload: unknown }
  | { type: "download_file"; sandboxId: string; payload: unknown }
  | { type: "list_files"; sandboxId: string; payload: unknown }
  | { type: "search_files"; sandboxId: string; payload: unknown }
  | { type: "delete_file"; sandboxId: string; payload: unknown }
  | { type: "stat_file"; sandboxId: string; payload: unknown }
  | { type: "mkdir"; sandboxId: string; payload: unknown }
  | { type: "move_file"; sandboxId: string; payload: unknown }
  | { type: "git_status"; sandboxId: string }
  | { type: "git_diff"; sandboxId: string; payload: unknown }
  | { type: "git_export_patch"; sandboxId: string; payload: unknown }
  | { type: "git_branch"; sandboxId: string; payload: unknown }
  | { type: "git_commit"; sandboxId: string; payload: unknown }
  | { type: "git_pull"; sandboxId: string; payload: unknown }
  | { type: "git_push"; sandboxId: string; payload: unknown };

type ResolvedSandboxClient = {
  client: OpenPondSandboxClient;
  context: RuntimeAccountContext | null;
  apiKey: string;
  sandboxApiUrl: string;
};

const DEFAULT_OPENPOND_SANDBOX_BASE_URL = "https://api.openpond.ai";

export async function sandboxRequestPayload(action: SandboxRequestAction): Promise<unknown> {
  const { client, context, apiKey, sandboxApiUrl } = await resolveSandboxClient();
  const account = sandboxAccountSummary(context, sandboxApiUrl);

  if (action.type === "list") {
    return { sandboxes: await client.list(normalizeSandboxListInput(action.payload)), account };
  }
  if (action.type === "volume_list") {
    return {
      ...(await requestSandboxApiRoot({
        apiKey,
        sandboxApiUrl,
        path: sandboxScopedCollectionPath("/sandboxes/volumes", normalizeSandboxListInput(action.payload)),
      })),
      account,
    };
  }
  if (action.type === "volume_create") {
    return {
      ...(await requestSandboxApiRoot({
        apiKey,
        sandboxApiUrl,
        path: "/sandboxes/volumes",
        method: "POST",
        body: asRecord(action.payload),
      })),
      account,
    };
  }
  if (action.type === "volume_get") {
    return {
      ...(await requestSandboxApiRoot({
        apiKey,
        sandboxApiUrl,
        path: sandboxScopedCollectionPath(
          `/sandboxes/volumes/${encodeURIComponent(action.volumeId)}`,
          normalizeSandboxListInput(action.payload),
        ),
      })),
      account,
    };
  }
  if (action.type === "volume_delete") {
    return {
      ...(await requestSandboxApiRoot({
        apiKey,
        sandboxApiUrl,
        path: sandboxScopedCollectionPath(
          `/sandboxes/volumes/${encodeURIComponent(action.volumeId)}`,
          normalizeSandboxListInput(action.payload),
        ),
        method: "DELETE",
      })),
      account,
    };
  }
  if (action.type === "secret_list") {
    return { secrets: await client.listSecrets(normalizeSandboxListInput(action.payload)), account };
  }
  if (action.type === "secret_get") {
    return {
      ...(await requestSandboxApiRoot({
        apiKey,
        sandboxApiUrl,
        path: sandboxSecretPath(
          `/sandbox-secrets/${encodeURIComponent(action.secretId)}`,
          normalizeSandboxListInput(action.payload),
        ),
      })),
      account,
    };
  }
  if (action.type === "secret_create") {
    return { secret: await client.createSecret(asRecord(action.payload) as Parameters<typeof client.createSecret>[0]), account };
  }
  if (action.type === "secret_rotate") {
    return {
      secret: await client.rotateSecret(
        action.secretId,
        asRecord(action.payload) as Parameters<typeof client.rotateSecret>[1],
      ),
      account,
    };
  }
  if (action.type === "secret_attach") {
    return {
      secret: await client.attachSecret(
        action.secretId,
        asRecord(action.payload) as Parameters<typeof client.attachSecret>[1],
      ),
      account,
    };
  }
  if (action.type === "secret_revoke") {
    return {
      secret: await client.revokeSecret(
        action.secretId,
        normalizeSandboxListInput(action.payload),
      ),
      account,
    };
  }
  if (action.type === "secret_delete") {
    return {
      secret: await client.deleteSecret(
        action.secretId,
        normalizeSandboxListInput(action.payload),
      ),
      account,
    };
  }
  if (action.type === "snapshot_catalog") {
    const input = asRecord(action.payload);
    const teamId = typeof input.teamId === "string" ? input.teamId.trim() : "";
    const projectId = typeof input.projectId === "string" ? input.projectId.trim() : "";
    const agentId = typeof input.agentId === "string" ? input.agentId.trim() : "";
    const query = typeof input.q === "string" ? input.q.trim() : "";
    const tag = typeof input.tag === "string" ? input.tag.trim() : "";
    const useCase = typeof input.useCase === "string" ? input.useCase.trim() : "";
    const replayState =
      input.replayState === "draft" ||
      input.replayState === "validated" ||
      input.replayState === "published"
        ? input.replayState
        : undefined;
    return {
      ...(await client.snapshotCatalog({
        ...(teamId ? { teamId } : {}),
        ...(projectId ? { projectId } : {}),
        ...(agentId ? { agentId } : {}),
        ...(query ? { q: query } : {}),
        ...(tag ? { tag } : {}),
        ...(useCase ? { useCase } : {}),
        ...(replayState ? { replayState } : {}),
      })),
      account,
    };
  }
  if (action.type === "snapshot_create") {
    return {
      ...(await client.createSnapshot(
        action.sandboxId,
        normalizeSnapshotCreateInput(action.payload),
      )),
      account,
    };
  }
  if (action.type === "template_catalog") {
    const input = asRecord(action.payload);
    const teamId = typeof input.teamId === "string" ? input.teamId.trim() : "";
    const projectId = typeof input.projectId === "string" ? input.projectId.trim() : "";
    const query = typeof input.q === "string" ? input.q.trim() : "";
    const name = typeof input.name === "string" ? input.name.trim() : "";
    const version = typeof input.version === "string" ? input.version.trim() : "";
    const tag = typeof input.tag === "string" ? input.tag.trim() : "";
    const useCase = typeof input.useCase === "string" ? input.useCase.trim() : "";
    return {
      ...(await client.templates({
        ...(teamId ? { teamId } : {}),
        ...(projectId ? { projectId } : {}),
        ...(query ? { q: query } : {}),
        ...(name ? { name } : {}),
        ...(version ? { version } : {}),
        ...(tag ? { tag } : {}),
        ...(useCase ? { useCase } : {}),
      })),
      account,
    };
  }
  if (action.type === "integration_connections") {
    const input = asRecord(action.payload);
    const teamId = typeof input.teamId === "string" ? input.teamId.trim() : "";
    const projectId = typeof input.projectId === "string" ? input.projectId.trim() : "";
    const agentId = typeof input.agentId === "string" ? input.agentId.trim() : "";
    const status = normalizeIntegrationStatusFilter(input.status);
    return {
      ...(await client.integrationConnections({
        ...(teamId ? { teamId } : {}),
        ...(projectId ? { projectId } : {}),
        ...(agentId ? { agentId } : {}),
        ...(status ? { status } : {}),
      })),
      account,
    };
  }
  if (action.type === "sandbox_runtime_list") {
    return {
      runtimes: await client.listSandboxRuntimes(normalizeSandboxListInput(action.payload)),
      account,
    };
  }
  if (action.type === "sandbox_runtime_get") {
    return {
      runtime: await client.getSandboxRuntime(action.runtimeId),
      account,
    };
  }
  if (action.type === "sandbox_runtime_create") {
    return {
      runtime: await client.createSandboxRuntime(
        normalizeSandboxRuntimeCreateInput(action.payload),
      ),
      account,
    };
  }
  if (action.type === "sandbox_runtime_sandbox_create") {
    return {
      ...(await client.createSandboxRuntimeSandbox(
        action.runtimeId,
        normalizeSandboxRuntimeSandboxCreateInput(action.payload),
        { respondAsync: true },
      )),
      account,
    };
  }
  if (action.type === "sandbox_runtime_resume") {
    const sandbox = await client
      .sandboxRuntime(action.runtimeId)
      .resume(normalizeSandboxRuntimeSandboxCreateInput(action.payload), {
        respondAsync: true,
      });
    const runtime = await client.getSandboxRuntime(action.runtimeId);
    return {
      runtime,
      sandbox,
      account,
    };
  }
  if (action.type === "sandbox_runtime_preserve_source") {
    const input = asRecord(action.payload);
    return {
      ...(await client.preserveSandboxRuntimeSource(
        action.runtimeId,
        {
          ...(typeof input.sandboxId === "string" && input.sandboxId.trim()
            ? { sandboxId: input.sandboxId.trim() }
            : {}),
          ...(typeof input.message === "string" && input.message.trim()
            ? { message: input.message.trim() }
            : {}),
        },
        normalizeSandboxListInput(action.payload),
      )),
      account,
    };
  }
  if (action.type === "sandbox_runtime_promote") {
    const input = asRecord(action.payload);
    return {
      ...(await client.promoteSandboxRuntime(
        action.runtimeId,
        {
          expectedTargetSha:
            typeof input.expectedTargetSha === "string"
              ? input.expectedTargetSha.trim()
              : "",
          ...(input.validationState === "pending" || input.validationState === "passed"
            ? { validationState: input.validationState }
            : {}),
          ...(typeof input.summary === "string" && input.summary.trim()
            ? { summary: input.summary.trim() }
            : {}),
        },
        normalizeSandboxListInput(action.payload),
      )),
      account,
    };
  }
  if (action.type === "project_list") {
    return {
      ...(await requestSandboxPublicApiRoot({
        apiKey,
        sandboxApiUrl,
        path: sandboxScopedCollectionPath("/projects", normalizeSandboxListInput(action.payload)),
      })),
      account,
    };
  }
  if (action.type === "profile_get") {
    return {
      ...(await requestSandboxPublicApiRoot({
        apiKey,
        sandboxApiUrl,
        path: sandboxScopedCollectionPath("/profile", normalizeSandboxListInput(action.payload)),
      })),
      account,
    };
  }
  if (action.type === "profile_ensure") {
    return {
      ...(await requestSandboxPublicApiRoot({
        apiKey,
        sandboxApiUrl,
        path: sandboxScopedCollectionPath("/profile/ensure", normalizeSandboxListInput(action.payload)),
        method: "POST",
      })),
      account,
    };
  }
  if (action.type === "profile_push") {
    const payload = asRecord(action.payload);
    const { teamId: _teamId, ...body } = payload;
    return {
      ...(await requestSandboxPublicApiRoot({
        apiKey,
        sandboxApiUrl,
        path: sandboxScopedCollectionPath("/profile/push", normalizeSandboxListInput(payload)),
        method: "POST",
        body,
      })),
      account,
    };
  }
  if (action.type === "project_upsert") {
    return {
      ...(await requestSandboxPublicApiRoot({
        apiKey,
        sandboxApiUrl,
        path: "/projects",
        method: "POST",
        body: asRecord(action.payload),
      })),
      account,
    };
  }
  if (action.type === "project_get") {
    return {
      ...(await requestSandboxPublicApiRoot({
        apiKey,
        sandboxApiUrl,
        path: sandboxScopedCollectionPath(
          `/projects/${encodeURIComponent(action.projectId)}`,
          normalizeSandboxListInput(action.payload),
        ),
      })),
      account,
    };
  }
  if (action.type === "project_git") {
    return {
      ...(await requestSandboxPublicApiRoot({
        apiKey,
        sandboxApiUrl,
        path: sandboxScopedCollectionPath(
          `/projects/${encodeURIComponent(action.projectId)}/git`,
          normalizeSandboxListInput(action.payload),
        ),
        method: "POST",
      })),
      account,
    };
  }
  if (action.type === "project_sync") {
    return {
      ...(await requestSandboxPublicApiRoot({
        apiKey,
        sandboxApiUrl,
        path: sandboxScopedCollectionPath(
          `/projects/${encodeURIComponent(action.projectId)}/sync`,
          normalizeSandboxListInput(action.payload),
        ),
        method: "POST",
      })),
      account,
    };
  }
  if (action.type === "project_source_upload") {
    const payload = asRecord(action.payload);
    const { teamId: _teamId, ...body } = payload;
    return {
      ...(await requestSandboxPublicApiRoot({
        apiKey,
        sandboxApiUrl,
        path: sandboxScopedCollectionPath(
          `/projects/${encodeURIComponent(action.projectId)}/source`,
          normalizeSandboxListInput(payload),
        ),
        method: "POST",
        body,
      })),
      account,
    };
  }
  if (action.type === "project_archive") {
    return {
      ...(await requestSandboxPublicApiRoot({
        apiKey,
        sandboxApiUrl,
        path: sandboxScopedCollectionPath(
          `/projects/${encodeURIComponent(action.projectId)}`,
          normalizeSandboxListInput(action.payload),
        ),
        method: "DELETE",
      })),
      account,
    };
  }
  if (action.type === "work_item_list") {
    return {
      ...(await requestSandboxPublicApiRoot({
        apiKey,
        sandboxApiUrl,
        path: workItemScopedPath(
          `/projects/${encodeURIComponent(action.projectId)}/work-items`,
          action.payload,
        ),
      })),
      account,
    };
  }
  if (action.type === "work_item_create") {
    const payload = asRecord(action.payload);
    const { projectId: _projectId, ...body } = payload;
    return {
      ...(await requestSandboxPublicApiRoot({
        apiKey,
        sandboxApiUrl,
        path: `/projects/${encodeURIComponent(action.projectId)}/work-items`,
        method: "POST",
        body,
      })),
      account,
    };
  }
  if (action.type === "work_item_get") {
    return {
      ...(await requestSandboxPublicApiRoot({
        apiKey,
        sandboxApiUrl,
        path: workItemScopedPath(
          `/work-items/${encodeURIComponent(action.workItemId)}`,
          action.payload,
        ),
      })),
      account,
    };
  }
  if (action.type === "work_item_messages") {
    return {
      ...(await requestSandboxPublicApiRoot({
        apiKey,
        sandboxApiUrl,
        path: workItemScopedPath(
          `/work-items/${encodeURIComponent(action.workItemId)}/messages`,
          action.payload,
        ),
      })),
      account,
    };
  }
  if (action.type === "work_item_message_create") {
    return {
      ...(await requestSandboxPublicApiRoot({
        apiKey,
        sandboxApiUrl,
        path: `/work-items/${encodeURIComponent(action.workItemId)}/messages`,
        method: "POST",
        body: asRecord(action.payload),
      })),
      account,
    };
  }
  if (action.type === "work_item_chat") {
    return {
      ...(await requestSandboxPublicApiRoot({
        apiKey,
        sandboxApiUrl,
        path: `/work-items/${encodeURIComponent(action.workItemId)}/chat`,
        method: "POST",
        body: asRecord(action.payload),
      })),
      account,
    };
  }
  if (action.type === "work_item_activity") {
    return {
      ...(await requestSandboxPublicApiRoot({
        apiKey,
        sandboxApiUrl,
        path: workItemScopedPath(
          `/work-items/${encodeURIComponent(action.workItemId)}/activity`,
          action.payload,
        ),
      })),
      account,
    };
  }
  if (action.type === "work_item_handle_background") {
    return {
      ...(await requestSandboxPublicApiRoot({
        apiKey,
        sandboxApiUrl,
        path: `/work-items/${encodeURIComponent(action.workItemId)}/handle-background`,
        method: "POST",
        body: asRecord(action.payload),
      })),
      account,
    };
  }
  if (action.type === "work_item_cancel_task") {
    return {
      ...(await requestSandboxPublicApiRoot({
        apiKey,
        sandboxApiUrl,
        path: `/work-items/${encodeURIComponent(action.workItemId)}/cancel-task`,
        method: "POST",
        body: asRecord(action.payload),
      })),
      account,
    };
  }
  if (action.type === "work_item_open_cloud") {
    return {
      ...(await requestSandboxPublicApiRoot({
        apiKey,
        sandboxApiUrl,
        path: `/work-items/${encodeURIComponent(action.workItemId)}/open-cloud`,
        method: "POST",
        body: asRecord(action.payload),
      })),
      account,
    };
  }
  if (action.type === "agent_list") {
    return {
      ...(await requestSandboxPublicApiRoot({
        apiKey,
        sandboxApiUrl,
        path: sandboxScopedCollectionPath("/agents", normalizeSandboxListInput(action.payload)),
      })),
      account,
    };
  }
  if (action.type === "agent_upsert") {
    return {
      ...(await requestSandboxPublicApiRoot({
        apiKey,
        sandboxApiUrl,
        path: "/agents",
        method: "POST",
        body: asRecord(action.payload),
      })),
      account,
    };
  }
  if (action.type === "agent_get") {
    return {
      ...(await requestSandboxPublicApiRoot({
        apiKey,
        sandboxApiUrl,
        path: sandboxScopedCollectionPath(
          `/agents/${encodeURIComponent(action.agentId)}`,
          normalizeSandboxListInput(action.payload),
        ),
      })),
      account,
    };
  }
  if (action.type === "agent_archive") {
    return {
      ...(await requestSandboxPublicApiRoot({
        apiKey,
        sandboxApiUrl,
        path: sandboxScopedCollectionPath(
          `/agents/${encodeURIComponent(action.agentId)}`,
          normalizeSandboxListInput(action.payload),
        ),
        method: "DELETE",
      })),
      account,
    };
  }
  if (action.type === "agent_run") {
    return {
      ...(await requestSandboxPublicApiRoot({
        apiKey,
        sandboxApiUrl,
        path: `/agents/${encodeURIComponent(action.agentId)}/run`,
        method: "POST",
        body: asRecord(action.payload),
      })),
      account,
    };
  }
  if (action.type === "create") {
    return { sandbox: await client.create(normalizeCreateInput(action.payload)), account };
  }
  if (action.type === "get") {
    return { sandbox: await client.get(action.sandboxId), account };
  }
  if (action.type === "delete") {
    return {
      sandbox: await client.delete(action.sandboxId, {
        failOnUnpreservedChanges: action.failOnUnpreservedChanges,
        respondAsync: true,
      }),
      account,
    };
  }
  if (action.type === "exec") {
    return {
      ...(await client.exec(action.sandboxId, normalizeExecInput(action.payload))),
      account,
    };
  }
  if (action.type === "action_run") {
    return {
      ...(await requestSandboxApiRoot({
        apiKey,
        sandboxApiUrl,
        path: `/sandboxes/${encodeURIComponent(
          action.sandboxId,
        )}/actions/${encodeURIComponent(action.actionName)}/run`,
        method: "POST",
        body: asRecord(action.payload),
      })),
      account,
    };
  }
  if (action.type === "open_port") {
    return {
      ...(await client.openPort(action.sandboxId, normalizeOpenPortInput(action.payload))),
      account,
    };
  }
  if (action.type === "snapshot_update") {
    return {
      ...(await client.updateSnapshot(
        action.sandboxId,
        action.snapshotId,
        normalizeSnapshotUpdateInput(action.payload),
      )),
      account,
    };
  }
  if (action.type === "snapshot_validate") {
    return {
      ...(await client.validateSnapshot(
        action.sandboxId,
        action.snapshotId,
        normalizeSnapshotValidateInput(action.payload),
      )),
      account,
    };
  }
  if (action.type === "snapshot_publish") {
    return {
      ...(await client.publishSnapshot(action.sandboxId, action.snapshotId)),
      account,
    };
  }
  if (action.type === "snapshot_fork") {
    return {
      ...(await client.forkSnapshot(
        action.snapshotId,
        normalizeSnapshotForkInput(action.payload),
      )),
      account,
    };
  }
  if (action.type === "replays") {
    return {
      ...(await client.listReplays(normalizeSandboxListInput(action.payload))),
      account,
    };
  }
  if (action.type === "replay_start") {
    return {
      ...(await client.startReplay(normalizeReplayStartInput(action.payload))),
      account,
    };
  }
  if (action.type === "replay_get") {
    return {
      ...(await client.getReplay(
        action.replayId,
        normalizeSandboxListInput(action.payload),
      )),
      account,
    };
  }
  if (action.type === "replay_logs") {
    return {
      ...(await client.getReplayLogs(
        action.replayId,
        normalizeSandboxListInput(action.payload),
      )),
      account,
    };
  }
  if (action.type === "replay_artifacts") {
    return {
      ...(await client.getReplayArtifacts(
        action.replayId,
        normalizeSandboxListInput(action.payload),
      )),
      account,
    };
  }
  if (action.type === "replay_cancel") {
    return {
      ...(await client.cancelReplay(
        action.replayId,
        normalizeSandboxListInput(action.payload),
      )),
      account,
    };
  }
  if (action.type === "schedule_create") {
    return {
      ...(await client.createSchedule(
        asRecord(action.payload) as SandboxScheduleCreateInput,
      )),
      account,
    };
  }
  if (action.type === "template_launch") {
    return {
      ...(await client.launchTemplate(normalizeTemplateLaunchInput(action.payload))),
      account,
    };
  }
  if (action.type === "template_builds") {
    return {
      builds: await client.listTemplateBuilds(normalizeTemplateBuildListInput(action.payload)),
      account,
    };
  }
  if (action.type === "template_build_create") {
    return {
      build: await client.createTemplateBuild(normalizeTemplateBuildCreateInput(action.payload)),
      account,
    };
  }
  if (action.type === "template_build_get") {
    return {
      build: await client.getTemplateBuild(action.buildId),
      account,
    };
  }
  if (action.type === "template_build_logs") {
    return {
      ...(await client.getTemplateBuildLogs(action.buildId)),
      account,
    };
  }
  if (action.type === "template_build_cancel") {
    return {
      build: await client.cancelTemplateBuild(action.buildId),
      account,
    };
  }
  if (action.type === "fork") {
    return {
      ...(await client.fork(action.sandboxId, normalizeForkInput(action.payload))),
      account,
    };
  }
  if (action.type === "stop") {
    return {
      ...(await client.stop(action.sandboxId, {
        failOnUnpreservedChanges: action.failOnUnpreservedChanges,
        respondAsync: true,
      })),
      account,
    };
  }
  if (action.type === "receipts") {
    return { receipts: await client.receipts(action.sandboxId), account };
  }
  if (action.type === "logs") {
    return { logs: await client.logs(action.sandboxId), account };
  }
  if (action.type === "billing") {
    return { ...(await client.billing(action.sandboxId)), account };
  }
  if (action.type === "integration_leases") {
    return { ...(await client.integrationLeases(action.sandboxId)), account };
  }
  if (action.type === "integration_attach") {
    return {
      ...(await client.attachIntegrationConnection(
        action.sandboxId,
        normalizeIntegrationAttachInput(action.payload),
      )),
      account,
    };
  }
  if (action.type === "integration_remove") {
    return {
      ...(await client.removeIntegrationLease(
        action.sandboxId,
        normalizeIntegrationLeaseId(action.payload),
      )),
      account,
    };
  }
  if (action.type === "process_start") {
    return {
      ...(await client.startProcess(action.sandboxId, normalizeProcessStartInput(action.payload))),
      account,
    };
  }
  if (action.type === "process_list") {
    return { ...(await client.listProcesses(action.sandboxId)), account };
  }
  if (action.type === "process_get") {
    return {
      ...(await client.getProcess(
        action.sandboxId,
        action.processId,
        normalizeProcessCursorInput(action.payload),
      )),
      account,
    };
  }
  if (action.type === "process_stop") {
    return { ...(await client.stopProcess(action.sandboxId, action.processId)), account };
  }
  if (action.type === "pty_start") {
    return {
      ...(await client.startPty(action.sandboxId, normalizePtyStartInput(action.payload))),
      account,
    };
  }
  if (action.type === "pty_list") {
    return { ...(await client.listPtys(action.sandboxId)), account };
  }
  if (action.type === "pty_get") {
    return {
      ...(await client.getPty(
        action.sandboxId,
        action.ptyId,
        normalizeProcessCursorInput(action.payload),
      )),
      account,
    };
  }
  if (action.type === "pty_input") {
    return {
      ...(await client.writePtyInput(action.sandboxId, action.ptyId, normalizePtyInput(action.payload))),
      account,
    };
  }
  if (action.type === "pty_stop") {
    return { ...(await client.stopPty(action.sandboxId, action.ptyId)), account };
  }
  if (action.type === "upload_file") {
    const input = normalizeUploadFileInput(action.payload);
    return {
      ...(input.contentsBase64
        ? await client.uploadFileBase64(action.sandboxId, input.path, input.contentsBase64)
        : await client.uploadFile(action.sandboxId, input.path, input.contents)),
      account,
    };
  }
  if (action.type === "download_file") {
    const input = normalizeDownloadFileInput(action.payload);
    return {
      ...(await client.downloadFileResponse(action.sandboxId, input)),
      account,
    };
  }
  if (action.type === "list_files") {
    return {
      ...(await client.listFiles(action.sandboxId, normalizeListFilesInput(action.payload))),
      account,
    };
  }
  if (action.type === "search_files") {
    return {
      ...(await client.searchFiles(action.sandboxId, normalizeSearchFilesInput(action.payload))),
      account,
    };
  }
  if (action.type === "delete_file") {
    const input = normalizeDeleteFileInput(action.payload);
    return {
      ...(await client.deleteFile(action.sandboxId, input.path, {
        recursive: input.recursive,
      })),
      account,
    };
  }
  if (action.type === "stat_file") {
    const input = normalizeDeleteFileInput(action.payload);
    return {
      ...(await client.statFile(action.sandboxId, input.path)),
      account,
    };
  }
  if (action.type === "mkdir") {
    const input = normalizeDeleteFileInput(action.payload);
    return {
      ...(await client.mkdir(action.sandboxId, {
        path: input.path,
        recursive: input.recursive,
      })),
      account,
    };
  }
  if (action.type === "move_file") {
    const input = normalizeMoveFileInput(action.payload);
    return {
      ...(await client.moveFile(action.sandboxId, input)),
      account,
    };
  }
  if (action.type === "git_status") {
    return { ...(await client.gitStatus(action.sandboxId)), account };
  }
  if (action.type === "git_diff") {
    const input = asRecord(action.payload);
    const baseRef = typeof input.baseRef === "string" ? input.baseRef.trim() : "";
    return {
      ...(await client.gitDiff(action.sandboxId, {
        ...(baseRef ? { baseRef } : {}),
      })),
      account,
    };
  }
  if (action.type === "git_export_patch") {
    const input = asRecord(action.payload);
    const baseRef = typeof input.baseRef === "string" ? input.baseRef.trim() : "";
    return {
      ...(await client.gitExportPatch(action.sandboxId, {
        ...(baseRef ? { baseRef } : {}),
      })),
      account,
    };
  }
  if (action.type === "git_branch") {
    return {
      ...(await client.gitBranch(action.sandboxId, normalizeGitBranchInput(action.payload))),
      account,
    };
  }
  if (action.type === "git_commit") {
    return {
      ...(await client.gitCommit(action.sandboxId, normalizeGitCommitInput(action.payload))),
      account,
    };
  }
  if (action.type === "git_pull") {
    return {
      ...(await client.gitPull(action.sandboxId, normalizeGitPullInput(action.payload))),
      account,
    };
  }
  if (action.type === "git_push") {
    return {
      ...(await client.gitPush(action.sandboxId, normalizeGitPushInput(action.payload))),
      account,
    };
  }
  throw new Error(`Unsupported sandbox action: ${(action as { type: string }).type}`);
}

async function resolveSandboxClient(): Promise<ResolvedSandboxClient> {
  const configuredSandboxApiUrl = normalizeOptionalUrl(process.env.OPENPOND_SANDBOX_API_URL);
  const configuredSandboxApiKey = process.env.OPENPOND_SANDBOX_API_KEY?.trim();
  if (configuredSandboxApiKey && configuredSandboxApiUrl) {
    return {
      client: createOpenPondSandboxClient({
        apiKey: configuredSandboxApiKey,
        sandboxApiUrl: configuredSandboxApiUrl,
      }),
      context: await loadOpenPondAccountContext().catch(() => null),
      apiKey: configuredSandboxApiKey,
      sandboxApiUrl: normalizeSandboxApiUrl(configuredSandboxApiUrl),
    };
  }

  const context = await loadOpenPondAccountContext();
  const apiKey = context.token?.trim();
  if (!apiKey) {
    throw new Error("OpenPond account API key is required to manage sandboxes.");
  }

  if (configuredSandboxApiUrl) {
    return {
      client: createOpenPondSandboxClient({ apiKey, sandboxApiUrl: configuredSandboxApiUrl }),
      context,
      apiKey,
      sandboxApiUrl: normalizeSandboxApiUrl(configuredSandboxApiUrl),
    };
  }

  const baseUrl = resolveSandboxBaseUrl(context);
  return {
    client: createOpenPondSandboxClient({ apiKey, baseUrl }),
    context,
    apiKey,
    sandboxApiUrl: normalizeSandboxApiUrl(baseUrl),
  };
}

function sandboxApiRootUrl(sandboxApiUrl: string): string {
  return normalizeSandboxApiUrl(sandboxApiUrl).replace(/\/sandboxes\/?$/, "");
}

function sandboxPublicApiRootUrl(sandboxApiUrl: string): string {
  const normalized = normalizeSandboxApiUrl(sandboxApiUrl);
  if (/\/api\/sandboxes\/?$/.test(normalized)) {
    return normalized.replace(/\/api\/sandboxes\/?$/, "/v1");
  }
  return normalized.replace(/\/sandboxes\/?$/, "");
}

function sandboxSecretPath(
  path: string,
  queryInput: { teamId?: string; projectId?: string; agentId?: string },
): string {
  return sandboxScopedCollectionPath(path, queryInput);
}

function sandboxScopedCollectionPath(
  path: string,
  queryInput: { teamId?: string; projectId?: string; agentId?: string },
): string {
  const query = new URLSearchParams();
  if (queryInput.teamId) query.set("teamId", queryInput.teamId);
  if (queryInput.projectId) query.set("projectId", queryInput.projectId);
  if (queryInput.agentId) query.set("agentId", queryInput.agentId);
  return `${path}${query.size > 0 ? `?${query.toString()}` : ""}`;
}

function workItemScopedPath(path: string, payload: unknown): string {
  const input = asRecord(payload);
  const query = new URLSearchParams();
  const teamId = typeof input.teamId === "string" ? input.teamId.trim() : "";
  if (teamId) query.set("teamId", teamId);
  if (input.includeArchived === true) query.set("includeArchived", "true");
  const limit = typeof input.limit === "number" && Number.isFinite(input.limit)
    ? Math.trunc(input.limit)
    : Number.parseInt(typeof input.limit === "string" ? input.limit : "", 10);
  if (limit > 0) query.set("limit", String(Math.min(limit, 250)));
  return `${path}${query.size > 0 ? `?${query.toString()}` : ""}`;
}

async function requestSandboxApiRoot(params: {
  apiKey: string;
  sandboxApiUrl: string;
  path: string;
  method?: "GET" | "POST" | "DELETE";
  body?: Record<string, unknown>;
}): Promise<Record<string, unknown>> {
  const response = await fetch(`${sandboxApiRootUrl(params.sandboxApiUrl)}${params.path}`, {
    method: params.method ?? "GET",
    headers: {
      "openpond-api-key": params.apiKey,
      ...(params.body ? { "content-type": "application/json" } : {}),
    },
    ...(params.body ? { body: JSON.stringify(params.body) } : {}),
  });
  const payload = (await response.json().catch(() => ({}))) as Record<
    string,
    unknown
  >;
  if (!response.ok) {
    const error =
      typeof payload.error === "string"
        ? payload.error
        : `Sandbox API request failed with status ${response.status}`;
    throw new Error(error);
  }
  return payload;
}

async function requestSandboxPublicApiRoot(params: {
  apiKey: string;
  sandboxApiUrl: string;
  path: string;
  method?: "GET" | "POST" | "DELETE";
  body?: Record<string, unknown>;
}): Promise<Record<string, unknown>> {
  const response = await fetch(`${sandboxPublicApiRootUrl(params.sandboxApiUrl)}${params.path}`, {
    method: params.method ?? "GET",
    headers: {
      "openpond-api-key": params.apiKey,
      ...(params.body ? { "content-type": "application/json" } : {}),
    },
    ...(params.body ? { body: JSON.stringify(params.body) } : {}),
  });
  const payload = (await response.json().catch(() => ({}))) as Record<
    string,
    unknown
  >;
  if (!response.ok) {
    const error =
      typeof payload.error === "string"
        ? payload.error
        : `Sandbox API request failed with status ${response.status}`;
    throw new Error(error);
  }
  return payload;
}

function sandboxAccountSummary(context: RuntimeAccountContext | null, sandboxApiUrl: string) {
  if (!context) {
    return {
      label: "Sandbox API",
      handle: null,
      baseUrl: null,
      sandboxApiUrl,
      state: "signed_out",
    };
  }
  const account = context.accountState;
  return {
    label: account.label,
    handle: account.activeProfile?.handle ?? context.account?.handle ?? null,
    baseUrl: account.baseUrl ?? context.account?.baseUrl ?? null,
    sandboxApiUrl,
    state: account.state,
  };
}

function resolveSandboxBaseUrl(context: RuntimeAccountContext): string {
  return (
    normalizeOptionalUrl(process.env.OPENPOND_SANDBOX_BASE_URL) ??
    normalizeOptionalUrl(process.env.OPENPOND_API_URL) ??
    normalizeOptionalUrl(context.apiBaseUrl) ??
    normalizeOptionalUrl(context.account?.baseUrl) ??
    normalizeOptionalUrl(context.config.baseUrl) ??
    DEFAULT_OPENPOND_SANDBOX_BASE_URL
  );
}

function webBaseFromApiBase(value: string): string | null {
  const normalized = normalizeOptionalUrl(value);
  if (!normalized) return null;
  try {
    const url = new URL(normalized);
    if (url.hostname === "api.openpond.ai") return "https://openpond.ai";
    if (url.hostname.startsWith("api.")) {
      url.hostname = url.hostname.slice(4);
      return url.toString().replace(/\/$/, "");
    }
  } catch {
    return null;
  }
  return normalized;
}

function normalizeOptionalUrl(value?: string | null): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed.replace(/\/$/, "") : null;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

const UI_PURPOSE_METADATA_KEYS = ["workspacePurpose", "purpose"] as const;

function sanitizeCreateMetadata(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const metadata = { ...(value as Record<string, unknown>) };
  for (const key of UI_PURPOSE_METADATA_KEYS) {
    delete metadata[key];
  }
  return metadata;
}

function sanitizeSandboxRuntimeInput(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const runtime = { ...(value as Record<string, unknown>) };
  for (const key of UI_PURPOSE_METADATA_KEYS) {
    delete runtime[key];
  }
  const metadata = sanitizeCreateMetadata(runtime.metadata);
  if (metadata) {
    runtime.metadata = metadata;
  } else {
    delete runtime.metadata;
  }
  return runtime;
}

export function normalizeCreateInput(payload: unknown): SandboxCreateInput {
  const input = asRecord(payload);
  if (input.sandboxRuntime) {
    throw new Error(
      "Sandbox runtime settings must use /v1/runtimes before materializing a sandbox.",
    );
  }
  const out: SandboxCreateInput = {};
  if (typeof input.repo === "string" && input.repo.trim()) out.repo = input.repo.trim();
  if (typeof input.teamId === "string" && input.teamId.trim()) out.teamId = input.teamId.trim();
  if (typeof input.projectId === "string" && input.projectId.trim()) {
    (out as Record<string, unknown>).projectId = input.projectId.trim();
  }
  if (typeof input.agentId === "string" && input.agentId.trim()) {
    (out as Record<string, unknown>).agentId = input.agentId.trim();
  }
  if (typeof input.command === "string" && input.command.trim()) out.command = input.command.trim();
  if (input.visibility === "private" || input.visibility === "team") {
    out.visibility = input.visibility;
  }
  if (input.resources && typeof input.resources === "object" && !Array.isArray(input.resources)) {
    out.resources = input.resources as SandboxCreateInput["resources"];
  }
  if (input.budget && typeof input.budget === "object" && !Array.isArray(input.budget)) {
    out.budget = input.budget as SandboxCreateInput["budget"];
  }
  if ("env" in input) {
    out.env = normalizeSandboxEnvRefsForApp(input.env);
  }
  if (input.networkPolicy && typeof input.networkPolicy === "object" && !Array.isArray(input.networkPolicy)) {
    out.networkPolicy = input.networkPolicy as SandboxCreateInput["networkPolicy"];
  }
  if (input.quotas && typeof input.quotas === "object" && !Array.isArray(input.quotas)) {
    out.quotas = input.quotas as SandboxCreateInput["quotas"];
  }
  if (Array.isArray(input.volumes)) {
    out.volumes = input.volumes as SandboxCreateInput["volumes"];
  }
  if (Array.isArray(input.integrationLeases)) {
    out.integrationLeases = input.integrationLeases as SandboxCreateInput["integrationLeases"];
  }
  if (Array.isArray(input.integrationConnectionLeases)) {
    out.integrationConnectionLeases =
      input.integrationConnectionLeases as SandboxCreateInput["integrationConnectionLeases"];
  }
  const metadata = sanitizeCreateMetadata(input.metadata);
  if (metadata) out.metadata = metadata;
  return out;
}

export function normalizeSandboxRuntimeCreateInput(
  payload: unknown,
): SandboxRuntimeCreateInput {
  const input = asRecord(payload);
  const runtime = sanitizeSandboxRuntimeInput(input) ?? {};
  const out: SandboxRuntimeCreateInput = {};
  if (typeof runtime.teamId === "string" && runtime.teamId.trim()) {
    out.teamId = runtime.teamId.trim();
  }
  if (typeof runtime.projectId === "string" && runtime.projectId.trim()) {
    (out as Record<string, unknown>).projectId = runtime.projectId.trim();
  }
  if (typeof runtime.agentId === "string" && runtime.agentId.trim()) {
    (out as Record<string, unknown>).agentId = runtime.agentId.trim();
  }
  if (typeof runtime.mode === "string" && runtime.mode.trim()) {
    (out as Record<string, unknown>).mode = runtime.mode.trim();
  }
  if (typeof runtime.baseBranch === "string" && runtime.baseBranch.trim()) {
    out.baseBranch = runtime.baseBranch.trim();
  }
  if (typeof runtime.baseSha === "string" && runtime.baseSha.trim()) {
    out.baseSha = runtime.baseSha.trim();
  }
  if (typeof runtime.sandboxId === "string" && runtime.sandboxId.trim()) {
    out.sandboxId = runtime.sandboxId.trim();
  }
  if (
    typeof runtime.rootfsSnapshotId === "string" &&
    runtime.rootfsSnapshotId.trim()
  ) {
    out.rootfsSnapshotId = runtime.rootfsSnapshotId.trim();
  }
  if (
    typeof runtime.dependencySnapshotId === "string" &&
    runtime.dependencySnapshotId.trim()
  ) {
    out.dependencySnapshotId = runtime.dependencySnapshotId.trim();
  }
  if (
    typeof runtime.promotionPolicy === "string" &&
    runtime.promotionPolicy.trim()
  ) {
    out.promotionPolicy =
      runtime.promotionPolicy.trim() as SandboxRuntimeCreateInput["promotionPolicy"];
  }
  if (
    runtime.metadata &&
    typeof runtime.metadata === "object" &&
    !Array.isArray(runtime.metadata)
  ) {
    out.metadata = runtime.metadata as Record<string, unknown>;
  }
  return out;
}

export function normalizeSandboxRuntimeSandboxCreateInput(
  payload: unknown,
): SandboxRuntimeSandboxCreateInput {
  return normalizeCreateInput(payload) as SandboxRuntimeSandboxCreateInput;
}

function normalizeSnapshotCreateInput(payload: unknown): SandboxSnapshotInput {
  return asRecord(payload) as SandboxSnapshotInput;
}

function normalizeSandboxListInput(payload: unknown): {
  teamId?: string;
  projectId?: string;
  agentId?: string;
} {
  const input = asRecord(payload);
  const teamId = typeof input.teamId === "string" ? input.teamId.trim() : "";
  const projectId = typeof input.projectId === "string" ? input.projectId.trim() : "";
  const agentId = typeof input.agentId === "string" ? input.agentId.trim() : "";
  return {
    ...(teamId ? { teamId } : {}),
    ...(projectId ? { projectId } : {}),
    ...(agentId ? { agentId } : {}),
  };
}

function normalizeReplayStartInput(payload: unknown): SandboxReplayInput & { teamId?: string; projectId?: string } {
  const input = asRecord(payload);
  const teamId = typeof input.teamId === "string" ? input.teamId.trim() : "";
  const projectId = typeof input.projectId === "string" ? input.projectId.trim() : "";
  const {
    teamId: _teamId,
    projectId: _projectId,
    appId: _appId,
    ...body
  } = input;
  const out = body as SandboxReplayInput & { teamId?: string; projectId?: string };
  if (teamId) out.teamId = teamId;
  if (projectId) out.projectId = projectId;
  return out;
}

function normalizeIntegrationStatusFilter(
  value: unknown,
): SandboxIntegrationConnectionStatusFilter | undefined {
  if (
    value === "active" ||
    value === "revoked" ||
    value === "error" ||
    value === "all"
  ) {
    return value;
  }
  return undefined;
}

function normalizeIntegrationAttachInput(
  payload: unknown,
): SandboxIntegrationConnectionLeaseInput {
  const input = asRecord(payload);
  const connectionId = typeof input.connectionId === "string" ? input.connectionId.trim() : "";
  if (!connectionId) {
    throw new Error("Sandbox integration connection is required.");
  }
  const capabilities = normalizeStringArray(input.capabilities);
  if (capabilities.length === 0) {
    throw new Error("Sandbox integration capabilities are required.");
  }
  const scopes = normalizeStringArray(input.scopes);
  const expiresAt = typeof input.expiresAt === "string" ? input.expiresAt.trim() : "";
  const ttlSeconds = Number(input.ttlSeconds);
  return {
    connectionId,
    capabilities,
    ...(scopes.length > 0 ? { scopes } : {}),
    ...(input.resourcePolicy && typeof input.resourcePolicy === "object" && !Array.isArray(input.resourcePolicy)
      ? { resourcePolicy: input.resourcePolicy as Record<string, unknown> }
      : {}),
    ...(expiresAt ? { expiresAt } : {}),
    ...(Number.isFinite(ttlSeconds) && ttlSeconds > 0
      ? { ttlSeconds: Math.floor(ttlSeconds) }
      : {}),
    ...(typeof input.required === "boolean" ? { required: input.required } : {}),
  };
}

function normalizeIntegrationLeaseId(payload: unknown): string {
  const input = asRecord(payload);
  const leaseId = typeof input.leaseId === "string" ? input.leaseId.trim() : "";
  if (!leaseId) {
    throw new Error("Sandbox integration lease is required.");
  }
  return leaseId;
}

function normalizeStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .map((item) => (typeof item === "string" ? item.trim() : ""))
    .filter(Boolean);
}

function normalizeExecInput(payload: unknown): SandboxExecInput {
  const input = asRecord(payload);
  const command = typeof input.command === "string" ? input.command.trim() : "";
  if (!command) throw new Error("Sandbox command is required.");
  const timeoutSeconds =
    typeof input.timeoutSeconds === "number" && Number.isFinite(input.timeoutSeconds)
      ? Math.max(1, Math.floor(input.timeoutSeconds))
      : undefined;
  return timeoutSeconds ? { command, timeoutSeconds } : { command };
}

function normalizeProcessStartInput(payload: unknown): SandboxProcessStartInput {
  const input = asRecord(payload);
  const command = typeof input.command === "string" ? input.command.trim() : "";
  if (!command) throw new Error("Sandbox process command is required.");
  const timeoutSeconds =
    typeof input.timeoutSeconds === "number" && Number.isFinite(input.timeoutSeconds)
      ? Math.max(1, Math.floor(input.timeoutSeconds))
      : undefined;
  return timeoutSeconds ? { command, timeoutSeconds } : { command };
}

function normalizePtyStartInput(payload: unknown): SandboxPtyStartInput {
  const input = asRecord(payload);
  const command = typeof input.command === "string" ? input.command.trim() : "";
  const timeoutSeconds =
    typeof input.timeoutSeconds === "number" && Number.isFinite(input.timeoutSeconds)
      ? Math.max(1, Math.floor(input.timeoutSeconds))
      : undefined;
  const rows =
    typeof input.rows === "number" && Number.isFinite(input.rows)
      ? Math.max(1, Math.floor(input.rows))
      : undefined;
  const cols =
    typeof input.cols === "number" && Number.isFinite(input.cols)
      ? Math.max(1, Math.floor(input.cols))
      : undefined;
  return {
    ...(command ? { command } : {}),
    ...(timeoutSeconds ? { timeoutSeconds } : {}),
    ...(rows ? { rows } : {}),
    ...(cols ? { cols } : {}),
  };
}

function normalizePtyInput(payload: unknown): SandboxPtyInput {
  const input = asRecord(payload);
  const dataBase64 = typeof input.dataBase64 === "string" ? input.dataBase64.trim() : "";
  if (!dataBase64) {
    throw new Error("Sandbox PTY input is required.");
  }
  return { dataBase64 };
}

function normalizeProcessCursorInput(payload: unknown) {
  const input = asRecord(payload);
  const since = Number(input.since);
  return Number.isFinite(since) ? { since: Math.max(0, Math.floor(since)) } : {};
}

function normalizeOpenPortInput(payload: unknown): SandboxOpenPortInput {
  const input = asRecord(payload);
  const port = typeof input.port === "number" ? input.port : Number(input.port);
  if (
    !Number.isInteger(port) ||
    port < SANDBOX_TEMPLATE_PREVIEW_PORT_MIN ||
    port > SANDBOX_TEMPLATE_PREVIEW_PORT_MAX
  ) {
    throw new Error(
      `Sandbox preview port must be between ${SANDBOX_TEMPLATE_PREVIEW_PORT_MIN} and ${SANDBOX_TEMPLATE_PREVIEW_PORT_MAX}.`,
    );
  }
  const label =
    typeof input.label === "string" && input.label.trim() ? input.label.trim() : undefined;
  const access =
    input.access === "public" || input.access === "private" ? input.access : undefined;
  const autoStart = input.autoStart === true;
  const customDomain =
    typeof input.customDomain === "string" && input.customDomain.trim()
      ? input.customDomain.trim()
      : undefined;
  const out: SandboxOpenPortInput = {
    port,
    ...(label ? { label } : {}),
    ...(access ? { access } : {}),
    ...(autoStart ? { autoStart } : {}),
    ...(customDomain ? { customDomain } : {}),
  };
  if (input.cors && typeof input.cors === "object" && !Array.isArray(input.cors)) {
    out.cors = input.cors as SandboxOpenPortInput["cors"];
  }
  if (
    input.headerPolicy &&
    typeof input.headerPolicy === "object" &&
    !Array.isArray(input.headerPolicy)
  ) {
    out.headerPolicy = input.headerPolicy as SandboxOpenPortInput["headerPolicy"];
  }
  if (
    input.authPolicy &&
    typeof input.authPolicy === "object" &&
    !Array.isArray(input.authPolicy)
  ) {
    out.authPolicy = input.authPolicy as SandboxOpenPortInput["authPolicy"];
  }
  return out;
}

function normalizeSnapshotUpdateInput(payload: unknown): SandboxSnapshotUpdateInput {
  const input = asRecord(payload);
  const out: SandboxSnapshotUpdateInput = {};
  if (input.template && typeof input.template === "object" && !Array.isArray(input.template)) {
    const template = asRecord(input.template);
    const nextTemplate: NonNullable<SandboxSnapshotUpdateInput["template"]> = {};
    if (typeof template.description === "string") {
      nextTemplate.description = template.description.trim();
    } else if (template.description === null) {
      nextTemplate.description = null;
    }
    if (Array.isArray(template.tags)) {
      nextTemplate.tags = template.tags
        .map((item) => (typeof item === "string" ? item.trim() : ""))
        .filter(Boolean)
        .slice(0, 20);
    }
    if (template.visibility === "private" || template.visibility === "team") {
      nextTemplate.visibility = template.visibility;
    }
    if (typeof template.useCase === "string") {
      nextTemplate.useCase = template.useCase.trim();
    } else if (template.useCase === null) {
      nextTemplate.useCase = null;
    }
    if (Object.keys(nextTemplate).length > 0) {
      out.template = nextTemplate;
    }
  }
  if (input.retention && typeof input.retention === "object" && !Array.isArray(input.retention)) {
    const retention = asRecord(input.retention);
    const nextRetention: NonNullable<SandboxSnapshotUpdateInput["retention"]> = {};
    if (
      retention.class === "ephemeral" ||
      retention.class === "cached" ||
      retention.class === "pinned"
    ) {
      nextRetention.class = retention.class;
    }
    if (retention.ttlSeconds === null) {
      nextRetention.ttlSeconds = null;
    } else if (typeof retention.ttlSeconds === "number" && Number.isFinite(retention.ttlSeconds)) {
      nextRetention.ttlSeconds = Math.max(1, Math.floor(retention.ttlSeconds));
    }
    if (Object.keys(nextRetention).length > 0) {
      out.retention = nextRetention;
    }
  }
  if (!out.template && !out.retention) {
    throw new Error("Snapshot update requires template or retention changes.");
  }
  return out;
}

function normalizeSnapshotValidateInput(payload: unknown): SandboxSnapshotValidateInput {
  const input = asRecord(payload);
  const cleanup = typeof input.cleanup === "string" ? input.cleanup.trim() : "";
  if (cleanup === "delete" || cleanup === "stop" || cleanup === "archive") {
    return { cleanup };
  }
  return {};
}

function normalizeForkInput(payload: unknown): SandboxForkInput {
  const input = asRecord(payload);
  const out: SandboxForkInput = {};
  if (typeof input.snapshotId === "string" && input.snapshotId.trim()) {
    out.snapshotId = input.snapshotId.trim();
  }
  if (input.visibility === "private" || input.visibility === "team") {
    out.visibility = input.visibility;
  }
  if (input.resources && typeof input.resources === "object" && !Array.isArray(input.resources)) {
    out.resources = input.resources as SandboxForkInput["resources"];
  }
  if (input.budget && typeof input.budget === "object" && !Array.isArray(input.budget)) {
    out.budget = input.budget as SandboxForkInput["budget"];
  }
  if (input.networkPolicy && typeof input.networkPolicy === "object" && !Array.isArray(input.networkPolicy)) {
    out.networkPolicy = input.networkPolicy as SandboxForkInput["networkPolicy"];
  }
  if (input.quotas && typeof input.quotas === "object" && !Array.isArray(input.quotas)) {
    out.quotas = input.quotas as SandboxForkInput["quotas"];
  }
  if (Array.isArray(input.volumes)) {
    out.volumes = input.volumes as SandboxForkInput["volumes"];
  }
  if (Array.isArray(input.integrationLeases)) {
    out.integrationLeases = input.integrationLeases as SandboxForkInput["integrationLeases"];
  }
  if ("env" in input) {
    out.env = normalizeSandboxEnvRefsForApp(input.env) as SandboxForkInput["env"];
  }
  if (input.metadata && typeof input.metadata === "object" && !Array.isArray(input.metadata)) {
    out.metadata = input.metadata as Record<string, unknown>;
  }
  return out;
}

export function normalizeSandboxEnvRefsForApp(value: unknown): SandboxEnvVarInput[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) {
    throw new Error("Sandbox env must be an array.");
  }
  return value.map((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      throw new Error("Sandbox env entries must be objects.");
    }
    const record = item as Record<string, unknown>;
    if ("value" in record) {
      throw new Error("Sandbox env entries must use secretRef, not inline values.");
    }
    const name = typeof record.name === "string" ? record.name.trim() : "";
    const secretRef = typeof record.secretRef === "string" ? record.secretRef.trim() : "";
    if (!name || !secretRef) {
      throw new Error("Sandbox env entries require name and secretRef.");
    }
    return { name, secretRef };
  });
}

function normalizeSnapshotForkInput(
  payload: unknown,
): SandboxForkInput & { teamId?: string; projectId?: string } {
  const input = asRecord(payload);
  const teamId = typeof input.teamId === "string" ? input.teamId.trim() : "";
  const projectId = typeof input.projectId === "string" ? input.projectId.trim() : "";
  return {
    ...normalizeForkInput(payload),
    ...(teamId ? { teamId } : {}),
    ...(projectId ? { projectId } : {}),
  };
}

function normalizeTemplateLaunchInput(
  payload: unknown,
): SandboxTemplateLaunchInput & { teamId?: string; projectId?: string } {
  const input = asRecord(payload);
  const teamId = typeof input.teamId === "string" ? input.teamId.trim() : "";
  const projectId = typeof input.projectId === "string" ? input.projectId.trim() : "";
  const snapshotId = typeof input.snapshotId === "string" ? input.snapshotId.trim() : "";
  const templateName =
    typeof input.templateName === "string" ? input.templateName.trim() : "";
  const version = typeof input.version === "string" ? input.version.trim() : "";
  const useCase = typeof input.useCase === "string" ? input.useCase.trim() : "";
  if (!snapshotId && !templateName && !useCase) {
    throw new Error("Sandbox template launch requires snapshotId, templateName, or useCase.");
  }
  return {
    ...normalizeForkInput(payload),
    ...(teamId ? { teamId } : {}),
    ...(projectId ? { projectId } : {}),
    ...(snapshotId ? { snapshotId } : {}),
    ...(templateName ? { templateName } : {}),
    ...(version ? { version } : {}),
    ...(useCase ? { useCase } : {}),
  };
}

function normalizeTemplateBuildListInput(payload: unknown): { teamId: string } {
  const input = asRecord(payload);
  const teamId = typeof input.teamId === "string" ? input.teamId.trim() : "";
  if (!teamId) {
    throw new Error("Template build team ID is required.");
  }
  return { teamId };
}

function normalizeTemplateBuildCreateInput(payload: unknown): SandboxTemplateBuildCreateInput {
  const input = asRecord(payload);
  const teamId = typeof input.teamId === "string" ? input.teamId.trim() : "";
  const sourceRepoUrl = typeof input.sourceRepoUrl === "string" ? input.sourceRepoUrl.trim() : "";
  const sourceProjectId = typeof input.sourceProjectId === "string" ? input.sourceProjectId.trim() : "";
  const branch = typeof input.branch === "string" ? input.branch.trim() : "";
  const manifestPath = typeof input.manifestPath === "string" ? input.manifestPath.trim() : "";
  if (!teamId) {
    throw new Error("Template build team ID is required.");
  }
  if (!sourceRepoUrl && !sourceProjectId) {
    throw new Error("Template build source repo or source project is required.");
  }
  return {
    teamId,
    ...(sourceRepoUrl ? { sourceRepoUrl } : {}),
    ...(sourceProjectId ? { sourceProjectId } : {}),
    ...(branch ? { branch } : {}),
    ...(manifestPath ? { manifestPath } : {}),
    ...(typeof input.publish === "boolean" ? { publish: input.publish } : {}),
  };
}

function normalizeListFilesInput(payload: unknown) {
  const input = asRecord(payload);
  const path = typeof input.path === "string" ? input.path.trim() : "";
  const maxEntries = Number(input.maxEntries);
  return {
    ...(path ? { path } : {}),
    ...(typeof input.recursive === "boolean" ? { recursive: input.recursive } : {}),
    ...(Number.isFinite(maxEntries) ? { maxEntries } : {}),
  };
}

function normalizeSearchFilesInput(payload: unknown) {
  const input = asRecord(payload);
  const query = typeof input.query === "string" ? input.query.trim() : "";
  if (!query) {
    throw new Error("Sandbox file search query is required.");
  }
  const path = typeof input.path === "string" ? input.path.trim() : "";
  const maxResults = Number(input.maxResults);
  return {
    query,
    ...(path ? { path } : {}),
    ...(Number.isFinite(maxResults) ? { maxResults } : {}),
  };
}

function normalizeDeleteFileInput(payload: unknown) {
  const input = asRecord(payload);
  const path = typeof input.path === "string" ? input.path.trim() : "";
  if (!path) {
    throw new Error("Sandbox file path is required.");
  }
  return {
    path,
    recursive: typeof input.recursive === "boolean" ? input.recursive : undefined,
  };
}

function normalizeDownloadFileInput(payload: unknown): SandboxFileDownloadInput {
  const input = normalizeDeleteFileInput(payload);
  const raw = asRecord(payload);
  const offsetBytes = Number(raw.offsetBytes);
  const maxBytes = Number(raw.maxBytes);
  return {
    path: input.path,
    ...(Number.isFinite(offsetBytes) ? { offsetBytes } : {}),
    ...(Number.isFinite(maxBytes) ? { maxBytes } : {}),
  };
}

function normalizeUploadFileInput(payload: unknown) {
  const input = asRecord(payload);
  const path = typeof input.path === "string" ? input.path.trim() : "";
  const contents = typeof input.contents === "string" ? input.contents : "";
  const contentsBase64 = typeof input.contentsBase64 === "string" ? input.contentsBase64.trim() : "";
  if (!path) {
    throw new Error("Sandbox file path is required.");
  }
  if (!contents && !contentsBase64) {
    throw new Error("Sandbox file contents are required.");
  }
  return {
    path,
    contents,
    contentsBase64,
  };
}

function normalizeMoveFileInput(payload: unknown) {
  const input = asRecord(payload);
  const fromPath = typeof input.fromPath === "string" ? input.fromPath.trim() : "";
  const toPath = typeof input.toPath === "string" ? input.toPath.trim() : "";
  if (!fromPath || !toPath) {
    throw new Error("Sandbox file source and target paths are required.");
  }
  return {
    fromPath,
    toPath,
    overwrite: typeof input.overwrite === "boolean" ? input.overwrite : undefined,
  };
}

function normalizeGitBranchInput(payload: unknown): SandboxGitBranchInput {
  const input = asRecord(payload);
  const branch = typeof input.branch === "string" ? input.branch.trim() : "";
  const startPoint = typeof input.startPoint === "string" ? input.startPoint.trim() : "";
  if (!branch) {
    throw new Error("Sandbox git branch name is required.");
  }
  return {
    branch,
    create: input.create === true,
    ...(startPoint ? { startPoint } : {}),
  };
}

function normalizeGitCommitInput(payload: unknown): SandboxGitCommitInput {
  const input = asRecord(payload);
  const message = typeof input.message === "string" ? input.message.trim() : "";
  const all = input.all === true;
  const paths = Array.isArray(input.paths)
    ? input.paths.filter((path): path is string => typeof path === "string" && path.trim() !== "")
    : [];
  if (!message) {
    throw new Error("Sandbox git commit message is required.");
  }
  if (!all && paths.length === 0) {
    throw new Error("Sandbox git commit requires all=true or at least one path.");
  }
  return {
    message,
    ...(all ? { all: true } : { paths: paths.map((path) => path.trim()) }),
  };
}

function normalizeGitPullInput(payload: unknown): SandboxGitPullInput {
  const input = asRecord(payload);
  const remote = typeof input.remote === "string" ? input.remote.trim() : "";
  const branch = typeof input.branch === "string" ? input.branch.trim() : "";
  const rebase = input.rebase === true;
  const ffOnly = typeof input.ffOnly === "boolean" ? input.ffOnly : undefined;
  if (rebase && ffOnly) {
    throw new Error("Sandbox git pull cannot use rebase and ff-only together.");
  }
  return {
    ...(remote ? { remote } : {}),
    ...(branch ? { branch } : {}),
    ...(rebase ? { rebase } : {}),
    ...(typeof ffOnly === "boolean" ? { ffOnly } : {}),
  };
}

function normalizeGitPushInput(payload: unknown): SandboxGitPushInput {
  const input = asRecord(payload);
  const remote = typeof input.remote === "string" ? input.remote.trim() : "";
  const branch = typeof input.branch === "string" ? input.branch.trim() : "";
  return {
    ...(remote ? { remote } : {}),
    ...(branch ? { branch } : {}),
    ...(input.setUpstream === true ? { setUpstream: true } : {}),
    ...(input.forceWithLease === true ? { forceWithLease: true } : {}),
  };
}
