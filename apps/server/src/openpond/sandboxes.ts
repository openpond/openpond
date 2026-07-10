import { createOpenPondSandboxClient, normalizeSandboxApiUrl } from "@openpond/cloud";
import type {
  SandboxRuntimeCreateInput,
  SandboxRuntimeSandboxCreateInput,
  OpenPondSandboxClient,
  OpenPondOrganization,
  SandboxCreateInput,
  SandboxRecord,
  SandboxExecInput,
  SandboxFileDownloadInput,
  SandboxForkInput,
  SandboxGitBranchInput,
  SandboxGitCommitInput,
  SandboxGitPullInput,
  SandboxGitPushInput,
  SandboxIntegrationConnection,
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
  buildConnectedAppStatusRows,
  connectedAppBundleByProvider,
  normalizeConnectedAppProviderFamilyId,
  SANDBOX_TEMPLATE_PREVIEW_PORT_MAX,
  SANDBOX_TEMPLATE_PREVIEW_PORT_MIN,
} from "@openpond/contracts";
import { loadOpenPondAccountContext } from "@openpond/runtime";
import type { RuntimeAccountContext } from "@openpond/runtime";
import { pipefailSandboxShellCommand } from "./shell-command.js";
import {
  normalizeOptionalUrl,
  asRecord,
  sanitizeCreateMetadata,
  sanitizeSandboxRuntimeInput,
  normalizeCreateInput,
  normalizeSandboxRuntimeCreateInput,
  normalizeSandboxRuntimeSandboxCreateInput,
  normalizeSnapshotCreateInput,
  normalizeSandboxListInput,
  normalizeReplayStartInput,
  normalizeIntegrationStatusFilter,
  normalizeIntegrationAttachInput,
  normalizeIntegrationLeaseRefsForRuntime,
  normalizeIntegrationLeaseRefForRuntime,
  normalizeLeaseableIntegrationProvider,
  assertNoSensitiveIntegrationLeaseKeys,
  validateIntegrationCapabilitiesForProvider,
  normalizeIntegrationLeaseId,
  normalizeStringArray,
  normalizeOptionalStringArray,
  normalizeIntegrationTtlSeconds,
  normalizeIntegrationExpiresAt,
  normalizeIntegrationResourcePolicy,
  assertNoSensitiveResourcePolicyKeys,
  isSensitivePolicyKey,
  normalizeExecInput,
  normalizeProcessStartInput,
  normalizePtyStartInput,
  normalizePtyInput,
  normalizeProcessCursorInput,
  normalizeOpenPortInput,
  normalizeSnapshotUpdateInput,
  normalizeSnapshotValidateInput,
  normalizeForkInput,
  normalizeSandboxEnvRefsForApp,
  normalizeSnapshotForkInput,
  normalizeTemplateLaunchInput,
  normalizeTemplateBuildListInput,
  normalizeTemplateBuildCreateInput,
  normalizeListFilesInput,
  normalizeSearchFilesInput,
  normalizeDeleteFileInput,
  normalizeDownloadFileInput,
  normalizeUploadFileInput,
  normalizeMoveFileInput,
  normalizeGitBranchInput,
  normalizeGitCommitInput,
  normalizeGitPullInput,
  normalizeGitPushInput,
} from "./sandbox-inputs.js";

export {
  normalizeCreateInput,
  normalizeSandboxRuntimeCreateInput,
  normalizeSandboxRuntimeSandboxCreateInput,
  normalizeIntegrationAttachInput,
  normalizeIntegrationLeaseId,
  normalizeSandboxEnvRefsForApp,
} from "./sandbox-inputs.js";

type SandboxRuntimeIntegrationLease = NonNullable<SandboxCreateInput["integrationLeases"]>[number];

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
  | { type: "connected_app_status"; payload: unknown }
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
  | { type: "agent_source_deploy_plan"; agentId: string; payload: unknown }
  | { type: "agent_source_checks"; agentId: string; payload: unknown }
  | { type: "agent_source_publish"; agentId: string; payload: unknown }
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
    const query = {
      ...(projectId ? { projectId } : {}),
      ...(agentId ? { agentId } : {}),
      status: status ?? "all",
    };
    const result = teamId
      ? await client.integrationConnections({
        teamId,
        ...query,
      })
      : await resolveImplicitConnectedAppStatusConnections(client, query);
    return {
      ...result,
      account,
    };
  }
  if (action.type === "connected_app_status") {
    const input = asRecord(action.payload);
    const explicitTeamId = typeof input.teamId === "string" ? input.teamId.trim() : "";
    const projectId = typeof input.projectId === "string" ? input.projectId.trim() : "";
    const agentId = typeof input.agentId === "string" ? input.agentId.trim() : "";
    const status = normalizeIntegrationStatusFilter(input.status) ?? "all";
    const query = {
      ...(projectId ? { projectId } : {}),
      ...(agentId ? { agentId } : {}),
      status,
    };
    const result = explicitTeamId
      ? await client.integrationConnections({
        teamId: explicitTeamId,
        ...query,
      })
      : await resolveImplicitConnectedAppStatusConnections(client, query);
    return {
      teamId: result.teamId,
      apps: buildConnectedAppStatusRows({ connections: result.connections }),
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
  if (action.type === "agent_source_deploy_plan") {
    return {
      ...(await requestSandboxPublicApiRoot({
        apiKey,
        sandboxApiUrl,
        path: sandboxScopedCollectionPath(
          `/agents/${encodeURIComponent(action.agentId)}/source/deploy-plan`,
          normalizeSandboxListInput(action.payload),
        ),
      })),
      account,
    };
  }
  if (action.type === "agent_source_checks") {
    const payload = asRecord(action.payload);
    const { teamId: _teamId, ...body } = payload;
    return {
      ...(await requestSandboxPublicApiRoot({
        apiKey,
        sandboxApiUrl,
        path: sandboxScopedCollectionPath(
          `/agents/${encodeURIComponent(action.agentId)}/source/checks`,
          normalizeSandboxListInput(payload),
        ),
        method: "POST",
        body,
      })),
      account,
    };
  }
  if (action.type === "agent_source_publish") {
    const payload = asRecord(action.payload);
    const { teamId: _teamId, ...body } = payload;
    return {
      ...(await requestSandboxPublicApiRoot({
        apiKey,
        sandboxApiUrl,
        path: sandboxScopedCollectionPath(
          `/agents/${encodeURIComponent(action.agentId)}/source/publish`,
          normalizeSandboxListInput(payload),
        ),
        method: "POST",
        body,
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
    const options = await sandboxLifecycleRequestOptions(client, action.sandboxId, {
      failOnUnpreservedChanges: action.failOnUnpreservedChanges,
    });
    const sandbox = await client.delete(action.sandboxId, options).catch((error) =>
      throwSandboxLifecycleRequestFailure("delete", client, action.sandboxId, error)
    );
    assertTerminalSandboxLifecycleSettled("delete", sandbox);
    return {
      sandbox,
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
    const options = await sandboxLifecycleRequestOptions(client, action.sandboxId, {
      failOnUnpreservedChanges: action.failOnUnpreservedChanges,
    });
    const result = await client.stop(action.sandboxId, options).catch((error) =>
      throwSandboxLifecycleRequestFailure("stop", client, action.sandboxId, error)
    );
    assertTerminalSandboxLifecycleSettled("stop", result.sandbox);
    return {
      ...result,
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

export async function listSandboxIntegrationConnections(input: {
  teamId?: string;
  projectId?: string;
  agentId?: string;
  status?: SandboxIntegrationConnectionStatusFilter;
} = {}) {
  const { client } = await resolveSandboxClient();
  if (input.teamId) return client.integrationConnections(input);
  return resolveImplicitConnectedAppStatusConnections(client, {
    ...(input.projectId ? { projectId: input.projectId } : {}),
    ...(input.agentId ? { agentId: input.agentId } : {}),
    status: input.status ?? "all",
  });
}

type SandboxLifecycleRequestOptions = {
  failOnUnpreservedChanges?: boolean;
  respondAsync?: boolean;
};

async function sandboxLifecycleRequestOptions(
  client: OpenPondSandboxClient,
  sandboxId: string,
  input: { failOnUnpreservedChanges?: boolean } = {},
): Promise<SandboxLifecycleRequestOptions> {
  const respondAsync = await client.get(sandboxId)
    .then((sandbox) => !sandboxLifecycleRequiresSynchronousAccounting(sandbox))
    .catch(() => true);
  return {
    failOnUnpreservedChanges: input.failOnUnpreservedChanges,
    ...(respondAsync ? { respondAsync: true } : {}),
  };
}

export function sandboxLifecycleRequiresSynchronousAccounting(
  sandbox: Pick<SandboxRecord, "state" | "reservation">,
): boolean {
  return sandbox.state === "creating" && sandbox.reservation.status === "reserved";
}

export function assertTerminalSandboxLifecycleSettled(
  operation: "delete" | "stop",
  sandbox: Pick<SandboxRecord, "id" | "state" | "reservation">,
): void {
  if (!terminalSandboxLifecycleStates.has(sandbox.state)) return;
  if (sandbox.reservation.status !== "reserved") return;
  throw new Error(
    `Sandbox ${operation} reached ${sandbox.state}, but reservation ${sandbox.reservation.id} is still reserved. ` +
    "Cleanup accounting has not settled; retry status before treating cleanup as complete.",
  );
}

async function throwSandboxLifecycleRequestFailure(
  operation: "delete" | "stop",
  client: OpenPondSandboxClient,
  sandboxId: string,
  error: unknown,
): Promise<never> {
  const latest = await client.get(sandboxId).catch(() => null);
  if (latest && sandboxLifecycleRequiresSynchronousAccounting(latest)) {
    const originalMessage = error instanceof Error ? error.message : String(error);
    throw new Error(
      `Sandbox ${operation} failed while sandbox ${sandboxId} is still creating with active reservation ${latest.reservation.id}. ` +
      `Cleanup accounting has not settled; retry status before treating cleanup as complete. Original error: ${originalMessage}`,
    );
  }
  throw error instanceof Error ? error : new Error(String(error));
}

const terminalSandboxLifecycleStates = new Set<SandboxRecord["state"]>([
  "stopped",
  "archived",
  "deleted",
  "error",
]);

type IntegrationConnectionsResult = Awaited<ReturnType<OpenPondSandboxClient["integrationConnections"]>>;
type ConnectedAppStatusConnectionsResult = {
  teamId: string | null;
  connections: SandboxIntegrationConnection[];
};

export async function resolveImplicitConnectedAppStatusConnections(
  client: OpenPondSandboxClient,
  query: {
    projectId?: string;
    agentId?: string;
    status: SandboxIntegrationConnectionStatusFilter;
  },
): Promise<ConnectedAppStatusConnectionsResult> {
  const organizations = await client.listOrganizations().catch(() => {
    throw new Error("Connected app status is unavailable because organizations could not be loaded.");
  });
  const teamIds = implicitConnectedAppStatusTeamIds(organizations);
  const fallbackTeamId = selectImplicitConnectedAppStatusTeamId(organizations) || null;

  if (teamIds.length === 0) {
    return {
      teamId: fallbackTeamId,
      connections: [],
    };
  }

  const results = await Promise.all(
    teamIds.map((teamId) =>
      client.integrationConnections({
        teamId,
        ...(query.projectId ? { projectId: query.projectId } : {}),
        ...(query.agentId ? { agentId: query.agentId } : {}),
        status: query.status,
      }).catch(() => null),
    ),
  );
  const successfulResults = successfulConnectedAppStatusConnectionResults(results);
  return {
    teamId:
      connectedAppStatusTeamIdWithConnections(successfulResults) ??
      fallbackTeamId ??
      successfulResults.find((result) => result.teamId.trim())?.teamId.trim() ??
      null,
    connections: mergeConnectedAppStatusConnectionResults(successfulResults),
  };
}

function connectedAppStatusTeamIdWithConnections(
  results: Array<{ teamId?: string | null; connections?: SandboxIntegrationConnection[] | null }>,
): string | null {
  for (const result of results) {
    if ((result.connections?.length ?? 0) === 0) continue;
    const teamId = result.teamId?.trim();
    if (teamId) return teamId;
  }
  return null;
}

export function mergeConnectedAppStatusConnectionResults(
  results: Array<{ connections?: SandboxIntegrationConnection[] | null }>,
): SandboxIntegrationConnection[] {
  const out: SandboxIntegrationConnection[] = [];
  const seen = new Set<string>();
  for (const result of results) {
    for (const connection of result.connections ?? []) {
      const key = connection.id.trim() || [
        connection.teamId,
        connection.provider,
        connection.providerAccountId,
      ].join(":");
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(connection);
    }
  }
  return out;
}

export function successfulConnectedAppStatusConnectionResults<T>(
  results: Array<(T & { connections?: SandboxIntegrationConnection[] | null }) | null>,
): T[] {
  const successfulResults = results.filter((result): result is T & { connections?: SandboxIntegrationConnection[] | null } =>
    result !== null,
  );
  const failedCount = results.length - successfulResults.length;
  const successfulConnectionCount = successfulResults.reduce(
    (count, result) => count + (result.connections?.length ?? 0),
    0,
  );
  if (failedCount > 0 && successfulConnectionCount === 0) {
    throw new Error("Connected app status is unavailable because one or more team integration connection lookups could not be loaded.");
  }
  return successfulResults;
}

export function selectImplicitConnectedAppStatusTeamId(
  organizations: OpenPondOrganization[],
): string {
  const active = organizations.filter((organization) => organizationStatus(organization) === "active");
  return (
    organizationTeamId(active.find((organization) => organization.role === "owner")) ??
    organizationTeamId(active.find((organization) => organization.role === "admin")) ??
    organizationTeamId(active[0]) ??
    ""
  );
}

export function implicitConnectedAppStatusTeamIds(
  organizations: OpenPondOrganization[],
): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const organization of organizations) {
    if (organizationStatus(organization) !== "active") continue;
    const teamId = organizationTeamId(organization);
    if (!teamId || seen.has(teamId)) continue;
    seen.add(teamId);
    out.push(teamId);
  }
  return out;
}

function organizationTeamId(
  organization: OpenPondOrganization | undefined,
): string | null {
  if (!organization) return null;
  const legacyId = (organization as unknown as { id?: unknown }).id;
  const value =
    typeof organization.teamId === "string"
      ? organization.teamId
      : typeof legacyId === "string"
        ? legacyId
        : "";
  const trimmed = value.trim();
  return trimmed || null;
}

function organizationStatus(
  organization: OpenPondOrganization,
): OpenPondOrganization["status"] {
  return typeof organization.status === "string" ? organization.status : "active";
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
