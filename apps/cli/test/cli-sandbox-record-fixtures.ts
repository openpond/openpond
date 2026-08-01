export function sandboxRecord(
  overrides: { runtimeId?: string | null } = {}
): Record<string, unknown> {
  return {
    id: "sandbox_test",
    state: "running",
    repo: null,
    teamId: "team_test",
    projectId: null,
    agentId: null,
    visibility: "private",
    ownerUserId: "user_test",
    runtimeId: overrides.runtimeId ?? null,
    runtimeProfileId: "openpond-coding-core-v1",
    workspaceRoot: "/workspace/project",
    runtimeProfile: {
      id: "openpond-coding-core-v1",
      label: "OpenPond Coding Core",
      version: 1,
      workspaceRoot: "/workspace/project",
      defaultExecutionProfileId: "firecracker-direct-k8s",
      requiredTools: ["git", "sh", "rg", "curl", "tar", "unzip"],
      excludedToolchains: ["node", "pnpm", "python", "browser"],
      capabilities: [
        "files",
        "exec",
        "processes",
        "pty",
        "ports",
        "preview",
        "git",
      ],
    },
    executionProfileId: "firecracker-direct-k8s",
    billingAccountId: "billing_test",
    resources: { cpu: 1, memoryGb: 1, diskGb: 4 },
    budget: { maxUsd: "0.05" },
    quotas: {},
    reservation: {
      capturedUsd: "0",
      mpp: null,
    },
    commands: [],
    integrationLeases: [],
    previewPorts: [],
    snapshots: [],
    archive: null,
    receipts: [],
    logs: [],
    metadata: {},
    createdAt: "2026-05-20T00:00:00.000Z",
    updatedAt: "2026-05-20T00:00:00.000Z",
    startedAt: "2026-05-20T00:00:00.000Z",
    stoppedAt: null,
    deletedAt: null,
  };
}

export function sandboxGitPatchExportRecord(
  input: Record<string, unknown> = {}
): Record<string, unknown> {
  return {
    isRepo: true,
    baseRef:
      typeof input.baseRef === "string" && input.baseRef.trim()
        ? input.baseRef.trim()
        : "openpond/base",
    patch: "diff --git a/README.md b/README.md\n",
    filename: "sandbox_test-abc123.patch",
    sha256: "a".repeat(64),
    bytes: 35,
    lineCount: 2,
    empty: false,
  };
}

export function sandboxRuntimeRecord(
  overrides: {
    projectId?: string | null;
    agentId?: string | null;
  } = {}
): Record<string, unknown> {
  return {
    id: "workspace_test",
    teamId: "team_test",
    userId: "user_test",
    projectId: overrides.projectId ?? null,
    agentId: overrides.agentId ?? null,
    sandboxId: "sandbox_test",
    workflowMode: "attempt",
    status: "waiting_for_user",
    baseBranch: "master",
    baseSha: null,
    currentSha: null,
    sourceRef: null,
    rootfsSnapshotId: null,
    dependencySnapshotId: null,
    checkpointSnapshotIds: [],
    artifactRefs: [],
    lifecyclePolicy: {
      mode: "auto",
      idleTimeoutSeconds: 900,
      archiveStoppedAfterSeconds: null,
      deleteAfterSeconds: null,
      retentionClass: "ephemeral",
    },
    checkpointPolicy: {
      workflow: "on_idle",
      source: "if_dirty",
      rootfs: "if_dirty",
      volumes: "explicit",
    },
    lifecycleState: {
      status: "waiting_for_user",
      lastInteractionAt: "2026-05-20T00:00:00.000Z",
      lastDirtyAt: null,
      lastCheckpointAt: null,
      lifecycleReason: "waiting_for_user",
    },
    promotionPolicy: "manual",
    permissions: {},
    runtimeProfileId: "openpond-coding-core-v1",
    workspaceRoot: "/workspace/project",
    runtimeProfile: {
      id: "openpond-coding-core-v1",
      label: "OpenPond Coding Core",
      version: 1,
      workspaceRoot: "/workspace/project",
      defaultExecutionProfileId: "firecracker-direct-k8s",
      requiredTools: ["git", "sh", "rg", "curl", "tar", "unzip"],
      excludedToolchains: ["node", "pnpm", "python", "browser"],
      capabilities: [
        "files",
        "exec",
        "processes",
        "pty",
        "ports",
        "preview",
        "git",
      ],
    },
    executionProfileId: "firecracker-direct-k8s",
    metadata: {},
    version: 2,
    createdAt: "2026-05-20T00:00:00.000Z",
    updatedAt: "2026-05-20T00:00:00.000Z",
  };
}

export function sandboxProjectRecord(
  overrides: {
    name?: string;
    description?: string | null;
    status?: string;
    sourceType?: string;
    gitOwner?: string | null;
    gitRepo?: string | null;
  } = {}
): Record<string, unknown> {
  return {
    id: "project_test",
    teamId: "team_test",
    createdByUserId: "user_test",
    name: overrides.name ?? "Demo Project",
    slug: "demo-project",
    description: overrides.description ?? null,
    status: overrides.status ?? "active",
    sourceType: overrides.sourceType ?? "internal_repo",
    sourceConfig: {},
    normalizedSourceIdentity: "internal_repo:openpond.ai:openpond/demo-project",
    externalId: null,
    gitProvider: null,
    gitHost: "openpond.ai",
    gitOwner: overrides.gitOwner ?? "openpond",
    gitRepo: overrides.gitRepo ?? "demo-project",
    gitBranch: null,
    defaultBranch: "master",
    internalRepoPath: null,
    templateSourceProjectId: null,
    templateRepoUrl: null,
    templateBranch: null,
    templateRemoteSha: null,
    sandboxManifest: null,
    sandboxActionRegistry: null,
    sandboxManifestHash: null,
    sandboxManifestPath: null,
    sandboxManifestSyncedAt: null,
    sandboxManifestError: null,
    metadata: {},
    createdAt: "2026-05-20T00:00:00.000Z",
    updatedAt: "2026-05-20T00:00:00.000Z",
    archivedAt:
      overrides.status === "archived" ? "2026-05-20T00:00:00.000Z" : null,
  };
}

export function sandboxAgentRecord(
  overrides: {
    name?: string;
    status?: string;
    triggerType?: string;
    selectedEntrypoint?: Record<string, unknown>;
  } = {}
): Record<string, unknown> {
  return {
    id: "agent_test",
    teamId: "team_test",
    createdByUserId: "user_test",
    name: overrides.name ?? "Daily Report",
    slug: "daily-report",
    description: null,
    status: overrides.status ?? "active",
    projectId: "project_test",
    workflowIntent: null,
    selectedEntrypoint: overrides.selectedEntrypoint ?? {
      scope: "entire_manifest",
      name: null,
    },
    triggerType: overrides.triggerType ?? "manual",
    endpointPolicy: {},
    backgroundTaskPolicy: {},
    defaultWorkflowMode: "attempt",
    defaultBranch: null,
    sourceRefOverride: null,
    defaultPromotionPolicy: "manual",
    defaultResourcePolicy: {},
    defaultLifecyclePolicy: {},
    defaultCheckpointPolicy: {},
    requiredIntegrationRefs: [],
    requiredEnvironmentVariableRefs: [],
    schedulePolicy: {},
    externalId: null,
    metadata: {},
    createdAt: "2026-05-20T00:00:00.000Z",
    updatedAt: "2026-05-20T00:00:00.000Z",
    archivedAt:
      overrides.status === "archived" ? "2026-05-20T00:00:00.000Z" : null,
  };
}

export function sandboxAgentRunRecord(
  input: Record<string, unknown>
): Record<string, unknown> {
  return {
    id: "agent_run_test",
    teamId: "team_test",
    projectId: "project_test",
    agentId: "agent_test",
    requestedByUserId: "user_test",
    conversationId: input.conversationId ?? null,
    idempotencyKey: input.idempotencyKey ?? null,
    triggerType: input.triggerType ?? "manual",
    status: "running",
    runtimeId: "workspace_test",
    sandboxId: "sandbox_test",
    selectedEntrypoint: { scope: "action", name: "hello" },
    input: input.input ?? {},
    metadata: input.metadata ?? {},
    createdAt: "2026-05-20T00:00:00.000Z",
    updatedAt: "2026-05-20T00:00:00.000Z",
    completedAt: null,
  };
}

export function sandboxAgentSourceDeployPlanRecord(): Record<string, unknown> {
  return {
    projectId: "project_test",
    agentId: "agent_test",
    status: "ready",
    canRun: true,
    canDeploy: true,
    blockedReasons: [],
    staleReasons: [],
    source: {
      sourceRef: "master",
      sourceCommitSha: "sha_test",
      manifestHash: "hash_test",
      manifestPath: "openpond.yaml",
      manifestSyncedAt: "2026-05-20T00:00:00.000Z",
      activeSnapshotId: null,
      activeSnapshotSourceSha: null,
    },
    defaultEntrypoint: { scope: "action", name: "chat" },
    checks: {
      setupCommands: [],
      validationCommands: ["openpond-agent validate"],
      requiredChecks: ["openpond-agent validate"],
      evalNames: ["basic"],
    },
    actions: [],
    channels: [],
    requiredIntegrations: [],
    optionalIntegrations: [],
    envRefs: [],
    requiredVolumes: [],
    optionalVolumes: [],
    schedules: [],
    artifactPaths: ["artifacts/openpond-trace.jsonl"],
    editable: {
      enabled: true,
      requiredChecks: ["openpond-agent validate"],
      defaultResultMode: "patch_only",
      supportedResultModes: ["patch_only"],
    },
  };
}

export function sandboxAgentManifestSnapshotRecord(): Record<string, unknown> {
  return {
    id: "snapshot_test",
    teamId: "team_test",
    projectId: "project_test",
    agentId: "agent_test",
    sourceRef: "master",
    sourceCommitSha: "sha_test",
    manifestHash: "hash_test",
    manifestPath: "openpond.yaml",
    manifestSyncedAt: "2026-05-20T00:00:00.000Z",
    manifestJson: {},
    actionRegistryJson: {},
    inspectJson: {},
    buildStatus: "passed",
    validationStatus: "passed",
    evalStatus: "passed",
    taskRunId: "task_run_test",
    traceArtifactRef: "artifacts/openpond-trace.jsonl",
    evalResultArtifactRef: "artifacts/openpond-eval-results.json",
    publishedAt: "2026-05-20T00:00:00.000Z",
    metadata: {},
    createdAt: "2026-05-20T00:00:00.000Z",
  };
}

export function sandboxCommandRecord(command: string): Record<string, unknown> {
  return {
    id: "command_test",
    command,
    status: "succeeded",
    output: "",
    exitCode: 0,
    startedAt: "2026-05-20T00:00:00.000Z",
    completedAt: "2026-05-20T00:00:01.000Z",
  };
}

export function sandboxProcessRecord(command: string): Record<string, unknown> {
  return {
    id: "process_test",
    command,
    status: "succeeded",
    output: "",
    exitCode: 0,
    startedAt: "2026-05-20T00:00:00.000Z",
    completedAt: "2026-05-20T00:00:01.000Z",
    durationMs: 1000,
    outputBytes: 0,
  };
}

export function sandboxScheduleRecord(
  input: Record<string, unknown>
): Record<string, unknown> {
  return {
    id: "schedule_test",
    teamId: "team_test",
    ownerUserId: "user_test",
    createdByUserId: "user_test",
    name: input.name,
    description: input.description ?? null,
    scheduleType: input.scheduleType,
    scheduleExpression: input.scheduleExpression,
    enabled: input.enabled ?? true,
    timezone: input.timezone ?? null,
    startAt: input.startAt ?? null,
    endAt: input.endAt ?? null,
    maxRuns: input.maxRuns ?? null,
    executionCount: 0,
    lifecycleStatus: "active",
    lifecycleReason: null,
    runtimePolicy: input.runtimePolicy ?? "run_and_stop",
    sourceSandboxId: input.sourceSandboxId ?? null,
    snapshotId: input.snapshotId ?? null,
    templateId: input.templateId ?? null,
    target: input.target ?? {
      kind: "command",
      actionName: null,
      command: null,
      requiresStart: false,
    },
    budget: input.budget ?? null,
    resources: input.resources ?? null,
    quotas: input.quotas ?? null,
    lifecycle: input.lifecycle ?? null,
    retentionPolicy: input.retentionPolicy ?? null,
    env: input.env ?? [],
    integrationLeases: input.integrationLeases ?? [],
    metadata: input.metadata ?? {},
    managementSource: input.managementSource ?? "api",
    manifestPath: input.manifestPath ?? null,
    awsScheduleProvider: null,
    awsScheduleName: null,
    awsScheduleArn: null,
    syncStatus: "pending",
    syncError: null,
    syncRequestedAt: null,
    lastSyncedAt: null,
    lastRunAt: null,
    lastRunStatus: null,
    createdAt: "2026-05-20T00:00:00.000Z",
    updatedAt: "2026-05-20T00:00:00.000Z",
  };
}

export function sandboxPricingRateCard(): Record<string, unknown> {
  return {
    currency: "USD",
    source: "openpond_poc_config",
    effectiveAt: "2026-05-20T00:00:00.000Z",
    rates: [
      {
        key: "cpu",
        label: "vCPU",
        unit: "vCPU-second",
        unitPriceUsd: "0.000010",
        unitPriceHourlyUsd: "0.036000",
        unitPriceMonthlyUsd: null,
      },
      {
        key: "memory",
        label: "Memory",
        unit: "GiB-second",
        unitPriceUsd: "0.000003",
        unitPriceHourlyUsd: "0.010800",
        unitPriceMonthlyUsd: null,
      },
      {
        key: "disk",
        label: "VM disk",
        unit: "GiB-second",
        unitPriceUsd: "0.000000",
        unitPriceHourlyUsd: "0.000072",
        unitPriceMonthlyUsd: null,
      },
      {
        key: "durable_volume_storage",
        label: "Durable volume storage",
        unit: "GiB-second",
        unitPriceUsd: "0.000000",
        unitPriceHourlyUsd: "0.000072",
        unitPriceMonthlyUsd: "0.051840",
      },
    ],
    tiers: [
      {
        key: "default",
        label: "Default",
        description:
          "Normal app workspaces, small dev servers, and basic test runs.",
        resources: {
          cpu: 1,
          memoryGb: 2,
          diskGb: 10,
        },
        goodFit: ["normal app workspace"],
        poorFit: ["large dependency installs"],
        keepRunningEstimate: {
          resources: {
            cpu: 1,
            memoryGb: 2,
            diskGb: 10,
          },
          matchedTierKey: "default",
          hourlyUsd: "0.058320",
          monthlyUsd: "41.990400",
          durationDays: 30,
          pricingSource: "openpond_poc_config",
          lineItems: [
            {
              label: "vCPU",
              quantity: 1,
              unit: "vCPU",
              hourlyUsd: "0.036000",
              monthlyUsd: "25.920000",
            },
            {
              label: "Memory",
              quantity: 2,
              unit: "GiB",
              hourlyUsd: "0.021600",
              monthlyUsd: "15.552000",
            },
            {
              label: "VM disk",
              quantity: 10,
              unit: "GiB",
              hourlyUsd: "0.000720",
              monthlyUsd: "0.518400",
            },
          ],
        },
      },
    ],
  };
}

export function sandboxSecretRecord(input: {
  name: string;
  status?: string;
  secretRef?: string;
  currentVersion?: number;
  attachments?: Array<Record<string, unknown>>;
}): Record<string, unknown> {
  return {
    id: "secret_test",
    teamId: "team_test",
    ownerUserId: "user_test",
    name: input.name,
    description: null,
    scope: "team",
    status: input.status ?? "active",
    secretRef: input.secretRef ?? "openpond://secret/team_test/secret_test#v1",
    currentVersion: input.currentVersion ?? 1,
    createdAt: "2026-05-20T00:00:00.000Z",
    updatedAt: "2026-05-20T00:00:00.000Z",
    lastUsedAt: null,
    deletedAt: input.status === "deleted" ? "2026-05-20T00:01:00.000Z" : null,
    attachments: input.attachments ?? [],
  };
}
