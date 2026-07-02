import { randomUUID } from "node:crypto";
import {
  CreatePipelineRequestSchema,
  type CreatePipelineRequest,
} from "@openpond/contracts";
import type {
  SandboxAgentEditWorkItemOpenInput,
  SandboxAgentEntrypointScope,
  SandboxAgentSourceCheckKind,
  SandboxAgentSourceChecksRequestInput,
  SandboxAgentSourcePublishInput,
  SandboxAgentRuntimeSourceConfig as SandboxAgentSourceConfig,
  SandboxAgentRuntimeSourceMode as SandboxAgentSourceMode,
  SandboxAgentTriggerType,
  SandboxAgentUpdateInput,
  SandboxAgentUpsertInput,
  SandboxCodingWorkItemBackgroundInput,
  SandboxCodingWorkItemChatInput,
  SandboxCodingWorkItemPromotionInput,
  SandboxProjectSourceType,
  SandboxProjectUpdateInput,
  SandboxProjectUpsertInput,
} from "../sandbox/types/index";
import {
  optionString,
  optionalJsonObject,
  parseBooleanOption,
  parseCsvOption,
  parseIntegerOption,
  parseSandboxWorkflowModeOption,
  parseSandboxRuntimePromotionPolicyOption,
  requiredTeamId,
} from "./common";

export function parseProjectSourceType(
  value: string | boolean | undefined
): SandboxProjectSourceType {
  const sourceType =
    typeof value === "string" && value.trim() ? value.trim() : "manual";
  if (
    sourceType !== "github_repo" &&
    sourceType !== "internal_repo" &&
    sourceType !== "template" &&
    sourceType !== "manual"
  ) {
    throw new Error(
      "source-type must be one of github_repo, internal_repo, template, manual"
    );
  }
  return sourceType;
}

export function parseAgentEntrypointScope(
  value: string | boolean | undefined
): SandboxAgentEntrypointScope | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !value.trim()) {
    throw new Error("entrypoint-scope must be a non-empty value");
  }
  const scope = value.trim() as SandboxAgentEntrypointScope;
  if (
    scope !== "entire_manifest" &&
    scope !== "start" &&
    scope !== "action" &&
    scope !== "service" &&
    scope !== "schedule"
  ) {
    throw new Error(
      "entrypoint-scope must be one of entire_manifest, start, action, service, schedule"
    );
  }
  return scope;
}

export function parseAgentTriggerType(
  value: string | boolean | undefined
): SandboxAgentTriggerType | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !value.trim()) {
    throw new Error("trigger-type must be a non-empty value");
  }
  const triggerType = value.trim() as SandboxAgentTriggerType;
  if (
    triggerType !== "manual" &&
    triggerType !== "schedule" &&
    triggerType !== "endpoint" &&
    triggerType !== "background"
  ) {
    throw new Error(
      "trigger-type must be one of manual, schedule, endpoint, background"
    );
  }
  return triggerType;
}

export function parseAgentSourceMode(
  value: string | boolean | undefined,
  optionName = "source-mode"
): SandboxAgentSourceMode | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${optionName} must be a non-empty value`);
  }
  const mode = value.trim() as SandboxAgentSourceMode;
  if (
    mode !== "latest_source" &&
    mode !== "published_snapshot" &&
    mode !== "auto"
  ) {
    throw new Error(
      `${optionName} must be one of latest_source, published_snapshot, auto`
    );
  }
  return mode;
}

export function buildAgentSourceConfig(
  options: Record<string, string | boolean>
): Partial<SandboxAgentSourceConfig> | undefined {
  const hasSourceMode = Object.prototype.hasOwnProperty.call(
    options,
    "sourceMode"
  );
  const mode = parseAgentSourceMode(
    hasSourceMode ? options.sourceMode : options.runtimeSourceMode,
    hasSourceMode ? "source-mode" : "runtime-source-mode"
  );
  const sourceRef = optionString(options, "sourceRef");
  const sourceCommitSha = optionString(options, "sourceCommitSha");
  const publishedSnapshotId =
    optionString(options, "publishedSnapshotId") ||
    optionString(options, "snapshotId");
  const publishedSnapshotName =
    optionString(options, "publishedSnapshotName") ||
    optionString(options, "snapshotName");
  const publishedSnapshotVersion =
    optionString(options, "publishedSnapshotVersion") ||
    optionString(options, "snapshotVersion");
  const buildStatus = optionString(options, "buildStatus");
  const validationStatus = optionString(options, "validationStatus");
  const validatedAt = optionString(options, "validatedAt");
  const config: Partial<SandboxAgentSourceConfig> = {
    ...(mode ? { mode } : {}),
    ...(sourceRef ? { sourceRef } : {}),
    ...(sourceCommitSha ? { sourceCommitSha } : {}),
    ...(publishedSnapshotId ? { publishedSnapshotId } : {}),
    ...(publishedSnapshotName ? { publishedSnapshotName } : {}),
    ...(publishedSnapshotVersion ? { publishedSnapshotVersion } : {}),
    ...(buildStatus ? { buildStatus } : {}),
    ...(validationStatus ? { validationStatus } : {}),
    ...(validatedAt ? { validatedAt } : {}),
  };
  return Object.keys(config).length > 0 ? config : undefined;
}

export function buildAgentSourcePolicy(
  options: Record<string, string | boolean>,
  source: "manual" | "diagnostic" = "manual"
) {
  const requirePublishedSnapshot = parseBooleanOption(
    options.requirePublishedSnapshot
  );
  const allowLatestSource = parseBooleanOption(options.allowLatestSource);
  if (!requirePublishedSnapshot && !allowLatestSource && source === "manual") {
    return undefined;
  }
  return {
    source,
    ...(requirePublishedSnapshot ? { requirePublishedSnapshot } : {}),
    ...(allowLatestSource || source === "diagnostic"
      ? { allowLatestSource: allowLatestSource || source === "diagnostic" }
      : {}),
  };
}

export function parseAgentSourceCheckKind(
  value: string | boolean | undefined
): SandboxAgentSourceCheckKind | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !value.trim()) {
    throw new Error("check-kind must be a non-empty value");
  }
  const checkKind = value.trim() as SandboxAgentSourceCheckKind;
  if (
    checkKind !== "validate" &&
    checkKind !== "eval" &&
    checkKind !== "publish_review" &&
    checkKind !== "all"
  ) {
    throw new Error(
      "check-kind must be one of validate, eval, publish_review, all"
    );
  }
  return checkKind;
}

export function parsePositiveLimit(
  value: string | boolean | undefined
): number | undefined {
  if (value === undefined) return undefined;
  const parsed = parseIntegerOption(value, "limit");
  if (parsed === undefined) return undefined;
  if (parsed <= 0) throw new Error("limit must be greater than 0");
  return parsed;
}

export function buildAgentSourceChecksInput(
  teamId: string,
  options: Record<string, string | boolean>
): SandboxAgentSourceChecksRequestInput {
  const metadata = optionalJsonObject(options, "metadata", "metadata");
  const checkKind = parseAgentSourceCheckKind(options.checkKind);
  return {
    teamId,
    ...(optionString(options, "sourceRef")
      ? { sourceRef: optionString(options, "sourceRef") }
      : {}),
    ...(optionString(options, "baseSha")
      ? { baseSha: optionString(options, "baseSha") }
      : {}),
    ...(checkKind ? { checkKind } : {}),
    ...(metadata ? { metadata } : {}),
  };
}

export function buildAgentSourcePublishInput(
  teamId: string,
  options: Record<string, string | boolean>
): SandboxAgentSourcePublishInput {
  return {
    teamId,
    ...(optionString(options, "expectedManifestHash")
      ? { expectedManifestHash: optionString(options, "expectedManifestHash") }
      : {}),
    ...(optionString(options, "expectedSourceCommitSha")
      ? {
          expectedSourceCommitSha: optionString(
            options,
            "expectedSourceCommitSha"
          ),
        }
      : {}),
    ...(optionString(options, "evalStatus")
      ? { evalStatus: optionString(options, "evalStatus") }
      : {}),
    ...(optionString(options, "workItemId")
      ? { workItemId: optionString(options, "workItemId") }
      : {}),
    ...(optionString(options, "taskRunId")
      ? { taskRunId: optionString(options, "taskRunId") }
      : {}),
    ...(optionString(options, "traceArtifactRef")
      ? { traceArtifactRef: optionString(options, "traceArtifactRef") }
      : {}),
    ...(optionString(options, "evalResultArtifactRef")
      ? { evalResultArtifactRef: optionString(options, "evalResultArtifactRef") }
      : {}),
  };
}

export function buildAgentEditOpenInput(
  agentId: string,
  teamId: string,
  options: Record<string, string | boolean>
): SandboxAgentEditWorkItemOpenInput {
  const projectId = optionString(options, "projectId");
  if (!projectId) {
    throw new Error(
      "agent edit open requires --project-id <id> so the edit work item is project scoped"
    );
  }
  const initialMessage =
    optionString(options, "initialMessage") ||
    optionString(options, "message") ||
    optionString(options, "prompt");
  const sourceRef = optionString(options, "sourceRef") ?? null;
  const baseSha = optionString(options, "baseSha") ?? null;
  return {
    teamId,
    projectId,
    ...(initialMessage ? { initialMessage } : {}),
    ...(sourceRef ? { sourceRef } : {}),
    ...(baseSha ? { baseSha } : {}),
    createPipelineRequest: buildAgentEditCreatePipelineRequest({
      agentId,
      teamId,
      projectId,
      objective: initialMessage || `Edit hosted agent ${agentId}`,
      sourceRef,
      baseSha,
      activeProfile: optionString(options, "profile") || "default",
    }),
  };
}

function buildAgentEditCreatePipelineRequest(input: {
  agentId: string;
  teamId: string;
  projectId: string;
  objective: string;
  sourceRef: string | null;
  baseSha: string | null;
  activeProfile: string;
}): CreatePipelineRequest {
  const now = new Date().toISOString();
  return CreatePipelineRequestSchema.parse({
    schemaVersion: "openpond.createPipeline.request.v1",
    id: `create_request_${randomUUID()}`,
    operation: "edit",
    surface: "hosted_edit",
    command: "/edit",
    objective: input.objective,
    adapter: {
      kind: "hosted",
      sourceAuthority: "hosted_profile",
      teamId: input.teamId,
      projectId: input.projectId,
      activeProfile: input.activeProfile,
      sourceRef: input.sourceRef,
      baseSha: input.baseSha,
      workItemId: null,
      confirmationPolicy: "always_require_plan_approval",
    },
    actor: {
      id: null,
      kind: "user",
      label: null,
    },
    scope: {
      conversationId: null,
      workItemId: null,
      projectId: input.projectId,
      targetProject: {
        id: input.projectId,
        name: null,
        workspacePath: null,
        sourceRef: input.sourceRef,
        baseSha: input.baseSha,
      },
    },
    context: {
      messageIds: [],
      conversationExcerpts: [],
      attachments: [],
      apps: [],
      tools: [],
      targetRepoAssumptions: [`cloud project: ${input.projectId}`],
    },
    targetAgent: {
      agentId: input.agentId,
      displayName: null,
      defaultActionKey: `${input.agentId}.chat`,
    },
    metadata: {
      source: "cli_agent_edit_open",
      selectedCommand: "/edit",
    },
    createdAt: now,
  });
}

export function buildCodingWorkItemChatInput(
  teamId: string,
  options: Record<string, string | boolean>
): SandboxCodingWorkItemChatInput {
  const message =
    optionString(options, "message") || optionString(options, "prompt");
  if (!message) {
    throw new Error("agent edit chat requires --message <text>");
  }
  const mode = optionString(options, "chatMode") || "queue_cloud";
  if (mode !== "sync_cloud" && mode !== "queue_cloud") {
    throw new Error(
      "agent edit chat --chat-mode must be sync_cloud or queue_cloud"
    );
  }
  const payload = optionalJsonObject(options, "payload", "payload");
  return {
    teamId,
    message,
    mode,
    ...(optionString(options, "sourceRef")
      ? { sourceRef: optionString(options, "sourceRef") }
      : {}),
    ...(optionString(options, "baseSha")
      ? { baseSha: optionString(options, "baseSha") }
      : {}),
    ...(payload ? { payload } : {}),
  };
}

export function buildCodingWorkItemBackgroundInput(
  teamId: string,
  options: Record<string, string | boolean>
): SandboxCodingWorkItemBackgroundInput {
  const payload = optionalJsonObject(options, "payload", "payload");
  return {
    teamId,
    ...(optionString(options, "prompt")
      ? { prompt: optionString(options, "prompt") }
      : {}),
    ...(optionString(options, "sourceRef")
      ? { sourceRef: optionString(options, "sourceRef") }
      : {}),
    ...(optionString(options, "baseSha")
      ? { baseSha: optionString(options, "baseSha") }
      : {}),
    ...(optionString(options, "sourceRuntimeId")
      ? { sourceRuntimeId: optionString(options, "sourceRuntimeId") }
      : {}),
    ...(optionString(options, "sourceSandboxId")
      ? { sourceSandboxId: optionString(options, "sourceSandboxId") }
      : {}),
    ...(optionString(options, "agentId")
      ? { agentId: optionString(options, "agentId") }
      : {}),
    ...(optionalJsonObject(options, "agentEdit", "agent-edit")
      ? { agentEdit: optionalJsonObject(options, "agentEdit", "agent-edit") }
      : {}),
    ...(optionalJsonObject(options, "setup", "setup")
      ? { setup: optionalJsonObject(options, "setup", "setup") }
      : {}),
    ...(optionalJsonObject(options, "validation", "validation")
      ? { validation: optionalJsonObject(options, "validation", "validation") }
      : {}),
    ...(optionalJsonObject(options, "branchPolicy", "branch-policy")
      ? {
          branchPolicy: optionalJsonObject(
            options,
            "branchPolicy",
            "branch-policy"
          ),
        }
      : {}),
    ...(payload ? { payload } : {}),
  };
}

export function buildCodingWorkItemPromotionInput(
  teamId: string,
  options: Record<string, string | boolean>
): SandboxCodingWorkItemPromotionInput {
  const ref = optionString(options, "ref") || optionString(options, "artifactRef");
  if (!ref) throw new Error("result promotion requires --ref <artifact-ref>");
  const metadata = optionalJsonObject(options, "metadata", "metadata");
  return {
    teamId,
    ref,
    ...(metadata ? { metadata } : {}),
  };
}

export function buildProjectUpsertInput(
  options: Record<string, string | boolean>
): SandboxProjectUpsertInput {
  const usage = "usage: project create --team-id <id> --name <name>";
  const teamId = requiredTeamId(options, usage);
  const name = optionString(options, "name");
  if (!name) {
    throw new Error(
      `${usage} [--source-type manual|github_repo|internal_repo|template]`
    );
  }
  const sourceType = parseProjectSourceType(options.sourceType);
  const repoUrl =
    optionString(options, "repoUrl") || optionString(options, "repo");
  const sourceConfig = {
    ...(optionalJsonObject(options, "sourceConfig", "source-config") ?? {}),
    ...(repoUrl ? { repoUrl } : {}),
  };
  const metadata = optionalJsonObject(options, "metadata", "metadata");
  return {
    teamId,
    name,
    sourceType,
    ...(optionString(options, "slug")
      ? { slug: optionString(options, "slug") }
      : {}),
    ...(optionString(options, "description")
      ? { description: optionString(options, "description") }
      : {}),
    ...(options.status === "active" ||
    options.status === "disabled" ||
    options.status === "archived"
      ? { status: options.status }
      : {}),
    ...(Object.keys(sourceConfig).length > 0 ? { sourceConfig } : {}),
    ...(optionString(options, "normalizedSourceIdentity")
      ? {
          normalizedSourceIdentity: optionString(
            options,
            "normalizedSourceIdentity"
          ),
        }
      : {}),
    ...(optionString(options, "externalId")
      ? { externalId: optionString(options, "externalId") }
      : {}),
    ...(optionString(options, "gitProvider")
      ? { gitProvider: optionString(options, "gitProvider") }
      : {}),
    ...(optionString(options, "gitHost")
      ? { gitHost: optionString(options, "gitHost") }
      : {}),
    ...(optionString(options, "gitOwner")
      ? { gitOwner: optionString(options, "gitOwner") }
      : {}),
    ...(optionString(options, "gitRepo")
      ? { gitRepo: optionString(options, "gitRepo") }
      : {}),
    ...(optionString(options, "gitBranch")
      ? { gitBranch: optionString(options, "gitBranch") }
      : {}),
    ...(optionString(options, "defaultBranch")
      ? { defaultBranch: optionString(options, "defaultBranch") }
      : {}),
    ...(optionString(options, "internalRepoPath")
      ? { internalRepoPath: optionString(options, "internalRepoPath") }
      : {}),
    ...(optionString(options, "templateSourceProjectId")
      ? {
          templateSourceProjectId: optionString(
            options,
            "templateSourceProjectId"
          ),
        }
      : {}),
    ...(optionString(options, "templateRepoUrl")
      ? { templateRepoUrl: optionString(options, "templateRepoUrl") }
      : {}),
    ...(optionString(options, "templateBranch")
      ? { templateBranch: optionString(options, "templateBranch") }
      : {}),
    ...(optionString(options, "templateRemoteSha")
      ? { templateRemoteSha: optionString(options, "templateRemoteSha") }
      : {}),
    ...(metadata ? { metadata } : {}),
  };
}

export function buildProjectUpdateInput(
  teamId: string,
  options: Record<string, string | boolean>
): SandboxProjectUpdateInput {
  const repoUrl =
    optionString(options, "repoUrl") || optionString(options, "repo");
  const sourceConfig = optionalJsonObject(
    options,
    "sourceConfig",
    "source-config"
  );
  const metadata = optionalJsonObject(options, "metadata", "metadata");
  return {
    teamId,
    ...(optionString(options, "name")
      ? { name: optionString(options, "name") }
      : {}),
    ...(optionString(options, "slug")
      ? { slug: optionString(options, "slug") }
      : {}),
    ...(optionString(options, "description")
      ? { description: optionString(options, "description") }
      : {}),
    ...(options.status === "active" ||
    options.status === "disabled" ||
    options.status === "archived"
      ? { status: options.status }
      : {}),
    ...(options.sourceType !== undefined
      ? { sourceType: parseProjectSourceType(options.sourceType) }
      : {}),
    ...(sourceConfig || repoUrl
      ? {
          sourceConfig: {
            ...(sourceConfig ?? {}),
            ...(repoUrl ? { repoUrl } : {}),
          },
        }
      : {}),
    ...(optionString(options, "normalizedSourceIdentity")
      ? {
          normalizedSourceIdentity: optionString(
            options,
            "normalizedSourceIdentity"
          ),
        }
      : {}),
    ...(optionString(options, "externalId")
      ? { externalId: optionString(options, "externalId") }
      : {}),
    ...(optionString(options, "gitProvider")
      ? { gitProvider: optionString(options, "gitProvider") }
      : {}),
    ...(optionString(options, "gitHost")
      ? { gitHost: optionString(options, "gitHost") }
      : {}),
    ...(optionString(options, "gitOwner")
      ? { gitOwner: optionString(options, "gitOwner") }
      : {}),
    ...(optionString(options, "gitRepo")
      ? { gitRepo: optionString(options, "gitRepo") }
      : {}),
    ...(optionString(options, "gitBranch")
      ? { gitBranch: optionString(options, "gitBranch") }
      : {}),
    ...(optionString(options, "defaultBranch")
      ? { defaultBranch: optionString(options, "defaultBranch") }
      : {}),
    ...(optionString(options, "internalRepoPath")
      ? { internalRepoPath: optionString(options, "internalRepoPath") }
      : {}),
    ...(optionString(options, "templateSourceProjectId")
      ? {
          templateSourceProjectId: optionString(
            options,
            "templateSourceProjectId"
          ),
        }
      : {}),
    ...(optionString(options, "templateRepoUrl")
      ? { templateRepoUrl: optionString(options, "templateRepoUrl") }
      : {}),
    ...(optionString(options, "templateBranch")
      ? { templateBranch: optionString(options, "templateBranch") }
      : {}),
    ...(optionString(options, "templateRemoteSha")
      ? { templateRemoteSha: optionString(options, "templateRemoteSha") }
      : {}),
    ...(metadata ? { metadata } : {}),
  };
}

export function buildAgentUpsertInput(
  options: Record<string, string | boolean>
): SandboxAgentUpsertInput {
  const usage =
    "usage: agent create --team-id <id> --project-id <id> --name <name>";
  const teamId = requiredTeamId(options, usage);
  const projectId = optionString(options, "projectId");
  const name = optionString(options, "name");
  if (!projectId || !name) {
    throw new Error(usage);
  }
  const entrypointScope = parseAgentEntrypointScope(options.entrypointScope);
  const entrypointName = optionString(options, "entrypointName");
  const triggerType = parseAgentTriggerType(options.triggerType);
  const workflowMode = parseSandboxWorkflowModeOption(options.workflowMode);
  const promotionPolicy = parseSandboxRuntimePromotionPolicyOption(
    options.runtimePromotionPolicy
  );
  const agentSource = buildAgentSourceConfig(options);
  const metadata = optionalJsonObject(options, "metadata", "metadata");
  return {
    teamId,
    projectId,
    name,
    ...(optionString(options, "slug")
      ? { slug: optionString(options, "slug") }
      : {}),
    ...(optionString(options, "description")
      ? { description: optionString(options, "description") }
      : {}),
    ...(options.status === "active" ||
    options.status === "disabled" ||
    options.status === "archived"
      ? { status: options.status }
      : {}),
    ...(entrypointScope
      ? {
          selectedEntrypoint: {
            scope: entrypointScope,
            name: entrypointName || null,
          },
        }
      : {}),
    ...(triggerType ? { triggerType } : {}),
    ...(workflowMode ? { defaultWorkflowMode: workflowMode } : {}),
    ...(optionString(options, "defaultBranch")
      ? { defaultBranch: optionString(options, "defaultBranch") }
      : {}),
    ...(optionString(options, "sourceRefOverride")
      ? { sourceRefOverride: optionString(options, "sourceRefOverride") }
      : {}),
    ...(promotionPolicy ? { defaultPromotionPolicy: promotionPolicy } : {}),
    ...(agentSource ? { runtimeSource: agentSource } : {}),
    ...(optionalJsonObject(options, "endpointPolicy", "endpoint-policy")
      ? {
          endpointPolicy: optionalJsonObject(
            options,
            "endpointPolicy",
            "endpoint-policy"
          ),
        }
      : {}),
    ...(optionalJsonObject(
      options,
      "backgroundTaskPolicy",
      "background-task-policy"
    )
      ? {
          backgroundTaskPolicy: optionalJsonObject(
            options,
            "backgroundTaskPolicy",
            "background-task-policy"
          ),
        }
      : {}),
    ...(optionalJsonObject(options, "resourcePolicy", "resource-policy")
      ? {
          defaultResourcePolicy: optionalJsonObject(
            options,
            "resourcePolicy",
            "resource-policy"
          ),
        }
      : {}),
    ...(optionalJsonObject(options, "lifecyclePolicy", "lifecycle-policy")
      ? {
          defaultLifecyclePolicy: optionalJsonObject(
            options,
            "lifecyclePolicy",
            "lifecycle-policy"
          ),
        }
      : {}),
    ...(optionalJsonObject(options, "checkpointPolicy", "checkpoint-policy")
      ? {
          defaultCheckpointPolicy: optionalJsonObject(
            options,
            "checkpointPolicy",
            "checkpoint-policy"
          ),
        }
      : {}),
    ...(parseCsvOption(options.requiredIntegrations).length > 0
      ? {
          requiredIntegrationRefs: parseCsvOption(options.requiredIntegrations),
        }
      : {}),
    ...(parseCsvOption(options.requiredEnv).length > 0
      ? { requiredEnvironmentVariableRefs: parseCsvOption(options.requiredEnv) }
      : {}),
    ...(optionalJsonObject(options, "schedulePolicy", "schedule-policy")
      ? {
          schedulePolicy: optionalJsonObject(
            options,
            "schedulePolicy",
            "schedule-policy"
          ),
        }
      : {}),
    ...(optionString(options, "externalId")
      ? { externalId: optionString(options, "externalId") }
      : {}),
    ...(metadata ? { metadata } : {}),
  };
}

export function buildAgentUpdateInput(
  teamId: string,
  options: Record<string, string | boolean>
): SandboxAgentUpdateInput {
  const entrypointScope = parseAgentEntrypointScope(options.entrypointScope);
  const entrypointName = optionString(options, "entrypointName");
  const triggerType = parseAgentTriggerType(options.triggerType);
  const workflowMode = parseSandboxWorkflowModeOption(options.workflowMode);
  const promotionPolicy = parseSandboxRuntimePromotionPolicyOption(
    options.runtimePromotionPolicy
  );
  const agentSource = buildAgentSourceConfig(options);
  const metadata = optionalJsonObject(options, "metadata", "metadata");
  return {
    teamId,
    ...(optionString(options, "projectId")
      ? { projectId: optionString(options, "projectId") }
      : {}),
    ...(optionString(options, "name")
      ? { name: optionString(options, "name") }
      : {}),
    ...(optionString(options, "slug")
      ? { slug: optionString(options, "slug") }
      : {}),
    ...(optionString(options, "description")
      ? { description: optionString(options, "description") }
      : {}),
    ...(options.status === "active" ||
    options.status === "disabled" ||
    options.status === "archived"
      ? { status: options.status }
      : {}),
    ...(entrypointScope
      ? {
          selectedEntrypoint: {
            scope: entrypointScope,
            name: entrypointName || null,
          },
        }
      : {}),
    ...(triggerType ? { triggerType } : {}),
    ...(workflowMode ? { defaultWorkflowMode: workflowMode } : {}),
    ...(optionString(options, "defaultBranch")
      ? { defaultBranch: optionString(options, "defaultBranch") }
      : {}),
    ...(optionString(options, "sourceRefOverride")
      ? { sourceRefOverride: optionString(options, "sourceRefOverride") }
      : {}),
    ...(promotionPolicy ? { defaultPromotionPolicy: promotionPolicy } : {}),
    ...(agentSource ? { runtimeSource: agentSource } : {}),
    ...(optionalJsonObject(options, "endpointPolicy", "endpoint-policy")
      ? {
          endpointPolicy: optionalJsonObject(
            options,
            "endpointPolicy",
            "endpoint-policy"
          ),
        }
      : {}),
    ...(optionalJsonObject(
      options,
      "backgroundTaskPolicy",
      "background-task-policy"
    )
      ? {
          backgroundTaskPolicy: optionalJsonObject(
            options,
            "backgroundTaskPolicy",
            "background-task-policy"
          ),
        }
      : {}),
    ...(optionalJsonObject(options, "resourcePolicy", "resource-policy")
      ? {
          defaultResourcePolicy: optionalJsonObject(
            options,
            "resourcePolicy",
            "resource-policy"
          ),
        }
      : {}),
    ...(optionalJsonObject(options, "lifecyclePolicy", "lifecycle-policy")
      ? {
          defaultLifecyclePolicy: optionalJsonObject(
            options,
            "lifecyclePolicy",
            "lifecycle-policy"
          ),
        }
      : {}),
    ...(optionalJsonObject(options, "checkpointPolicy", "checkpoint-policy")
      ? {
          defaultCheckpointPolicy: optionalJsonObject(
            options,
            "checkpointPolicy",
            "checkpoint-policy"
          ),
        }
      : {}),
    ...(parseCsvOption(options.requiredIntegrations).length > 0
      ? {
          requiredIntegrationRefs: parseCsvOption(options.requiredIntegrations),
        }
      : {}),
    ...(parseCsvOption(options.requiredEnv).length > 0
      ? { requiredEnvironmentVariableRefs: parseCsvOption(options.requiredEnv) }
      : {}),
    ...(optionalJsonObject(options, "schedulePolicy", "schedule-policy")
      ? {
          schedulePolicy: optionalJsonObject(
            options,
            "schedulePolicy",
            "schedule-policy"
          ),
        }
      : {}),
    ...(optionString(options, "externalId")
      ? { externalId: optionString(options, "externalId") }
      : {}),
    ...(metadata ? { metadata } : {}),
  };
}
