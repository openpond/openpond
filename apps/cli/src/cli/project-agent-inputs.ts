import type {
  SandboxAgentEntrypointScope,
  SandboxAgentSourceCheckDispatchMode,
  SandboxAgentSourceCheckKind,
  SandboxAgentSourceChecksRequestInput,
  SandboxAgentSourcePublishInput,
  SandboxAgentRuntimeSourceConfig as SandboxAgentSourceConfig,
  SandboxAgentRuntimeSourceMode as SandboxAgentSourceMode,
  SandboxAgentTriggerType,
  SandboxAgentUpdateInput,
  SandboxAgentUpsertInput,
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

export function parseAgentSourceCheckDispatch(
  value: string | boolean | undefined,
  optionName = "source-check-dispatch"
): SandboxAgentSourceCheckDispatchMode | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${optionName} must be a non-empty value`);
  }
  const dispatch = value.trim() as SandboxAgentSourceCheckDispatchMode;
  if (dispatch !== "request_only" && dispatch !== "coding_core") {
    throw new Error(
      `${optionName} must be one of request_only, coding_core`
    );
  }
  return dispatch;
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
  const dispatch = parseAgentSourceCheckDispatch(
    options.sourceCheckDispatch ?? options.dispatch
  );
  return {
    teamId,
    ...(optionString(options, "sourceRef")
      ? { sourceRef: optionString(options, "sourceRef") }
      : {}),
    ...(optionString(options, "baseSha")
      ? { baseSha: optionString(options, "baseSha") }
      : {}),
    ...(checkKind ? { checkKind } : {}),
    ...(dispatch ? { dispatch } : {}),
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
