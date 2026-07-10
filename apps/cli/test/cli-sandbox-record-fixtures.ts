export const LARGE_RAW_MARKER = "raw-large-payload-that-must-not-echo";

export function largeRawPayload(): string {
  return `${LARGE_RAW_MARKER}:`.repeat(10_000);
}

export function largeArtifactRecord(
  id: string,
  kind: string,
  ref: unknown
): Record<string, unknown> {
  return {
    id,
    kind,
    ref,
    createdAt: "2026-05-20T00:00:00.000Z",
    metadata: {
      rawPatch: largeRawPayload(),
    },
    rawDiff: largeRawPayload(),
  };
}

export function largeSourceCheckPayload(): Record<string, unknown> {
  return {
    checkKind: "all",
    deployPlanStatus: "needs_validation",
    canDeploy: false,
    blockedReasons: ["source_commit_sha_missing"],
    sourceMaterialization: {
      status: "completed",
      sourceCommitSha: "source_sha_large",
      rawCheckoutLog: largeRawPayload(),
    },
    sourceUploadMetadata: {
      ...sourceUploadMetadataStatusFixture(),
      rawSetupOutput: largeRawPayload(),
    },
    setup: {
      status: "completed",
      passed: true,
      commands: ["bun install --offline"],
      expectedBinaryPath: "node_modules/.bin/openpond-agent",
      rawInstallLog: largeRawPayload(),
    },
    policyDiscovery: {
      status: "completed",
      command: "openpond agent inspect --json",
      exitCode: 0,
      durationMs: 12,
      requiredChecks: ["openpond agent validate", "openpond agent eval"],
      rawStdout: largeRawPayload(),
    },
    discoveredRequiredChecks: [
      "openpond agent validate",
      "openpond agent eval",
    ],
    checkRuns: [
      {
        commandId: "validation-large",
        command: "openpond agent validate",
        status: "passed",
        passed: true,
        exitCode: 0,
        rawStderr: largeRawPayload(),
      },
    ],
    validation: {
      status: "passed",
      passed: true,
      rawValidatorOutput: largeRawPayload(),
    },
    eval: {
      status: "passed",
      passed: true,
      rawEvalResultsJson: largeRawPayload(),
    },
    traceArtifactRef: "artifacts/trace-large.jsonl",
    traceArtifactRefs: ["artifacts/trace-large.jsonl"],
    evalResultArtifactRef: "artifacts/eval-large.json",
    evalResultArtifactRefs: ["artifacts/eval-large.json"],
    validatorArtifactRefs: ["artifacts/validator-large.json"],
    patchArtifactRef: "openpond://coding-task-runs/task_run_large/patch",
    draftSourceRef: "draft/source-large",
    finalResultState: "completed",
    publishBlockers: ["source_commit_sha_missing"],
    rawSandboxProcessOutput: largeRawPayload(),
  };
}

export function largeWorkItemStatusResponse(): Record<string, unknown> {
  return {
    workItem: {
      id: "work_item_large",
      projectId: "project_test",
      assignedAgentId: "agent_test",
      status: "needs_review",
      latestTaskRunId: "task_run_large",
      latestRuntimeId: "runtime_large",
      latestSandboxId: "sandbox_large",
      metadata: {
        rawTaskPayload: largeRawPayload(),
      },
    },
    activity: [
      {
        id: "activity_large",
        type: "task_event",
        payload: largeSourceCheckPayload(),
        rawEvents: largeRawPayload(),
      },
    ],
    sourceCheckStatus: {
      workItemId: "work_item_large",
      workItemStatus: "needs_review",
      latestTaskRunId: "task_run_large",
      latestRuntimeId: "runtime_large",
      latestSandboxId: "sandbox_large",
      ...largeSourceCheckPayload(),
      requestedCheckKind: "all",
      deployPlan: {
        status: "needs_validation",
        canDeploy: false,
        blockedReasons: ["source_commit_sha_missing"],
        rawPlan: largeRawPayload(),
      },
      rawStatusPayload: largeRawPayload(),
    },
    rawResponsePayload: largeRawPayload(),
  };
}

export function sourceUploadMetadataStatusFixture(): Record<string, unknown> {
  return {
    schema: "openpond.agent.source_upload.v1",
    sourceTreeMode: "typescript_agent_sdk",
    packageManager: "bun",
    commands: {
      inspect: "bun run agent:inspect",
      build: "bun run agent:build",
      validate: "bun run agent:validate",
      eval: "bun run agent:eval",
    },
    generatedManifestPath: ".openpond/openpond-manifest.preview.yaml",
    synthesizedOpenPondYaml: true,
    openPondYamlMode: "synthesized",
    uploadMetadataPath: ".openpond/source-upload-metadata.json",
    uploadMetadataHash: {
      sha256:
        "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      sizeBytes: 2816,
    },
    artifactHashes: {
      ".openpond/openpond-manifest.preview.yaml": {
        sha256:
          "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
        sizeBytes: 567,
      },
      ".openpond/agent-manifest.json": {
        sha256:
          "cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",
        sizeBytes: 1024,
      },
      "openpond.yaml": {
        sha256:
          "dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd",
        sizeBytes: 530,
      },
    },
    dependencySetup: {
      required: true,
      installCommand: "bun install --offline",
      commands: ["bun install --offline"],
      packageJsonPath: "package.json",
      expectedBinaryPath: "node_modules/.bin/openpond-agent",
      generatedArtifactDirectory: ".openpond",
      sdkPackage: {
        packageName: "openpond-agent-sdk",
        source: "uploaded_tarball",
        path: ".openpond/vendor/openpond-agent-sdk.tgz",
        sha256:
          "eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee",
        sizeBytes: 52319,
      },
      dependencyPackages: [
        {
          packageName: "yaml",
          source: "npm_dependency_tarball",
          versionSpec: "^2.9.0",
          path: ".openpond/vendor/npm/yaml.tgz",
          sha256:
            "ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff",
          sizeBytes: 112086,
        },
        {
          packageName: "zod",
          source: "npm_dependency_tarball",
          versionSpec: "^4.1.11",
          path: ".openpond/vendor/npm/zod.tgz",
          sha256:
            "1111111111111111111111111111111111111111111111111111111111111111",
          sizeBytes: 759588,
        },
      ],
    },
    redactedSetupOutputRefs: [
      "openpond://coding-task-runs/task_run_test/setup-output",
    ],
  };
}

export function sourceCheckClassificationPayload(
  workItemId: string
): Record<string, unknown> {
  if (workItemId === "work_item_dependency_install_failure") {
    return {
      sourceUploadMetadata: sourceUploadMetadataStatusFixture(),
      setup: {
        status: "failed",
        message: "dependency install failed",
        command: "bun install --offline",
        exitCode: 1,
        commands: ["bun install --offline"],
        expectedBinaryPath: "node_modules/.bin/openpond-agent",
        dependencyPackages: [
          {
            packageName: "yaml",
            source: "npm_dependency_tarball",
            versionSpec: "^2.9.0",
            path: ".openpond/vendor/npm/yaml.tgz",
            sha256: "sha_yaml",
            sizeBytes: 112086,
          },
        ],
      },
    };
  }
  if (workItemId === "work_item_missing_sdk_binary") {
    return {
      policyDiscovery: {
        status: "failed",
        message: "missing node_modules/.bin/openpond-agent",
        command: "bun run agent:inspect",
        exitCode: 127,
      },
    };
  }
  if (workItemId === "work_item_unresolved_file_dependency") {
    return {
      setup: {
        status: "failed",
        message: "unresolved local file dependency",
        command: "bun install --offline",
        exitCode: 1,
        commands: ["bun install --offline"],
        expectedBinaryPath: "node_modules/.bin/openpond-agent",
        dependencyPackages: [
          {
            packageName: "openpond-agent-sdk",
            source: "uploaded_tarball",
            versionSpec: "file:.openpond/local-sdk-source",
            path: ".openpond/vendor/openpond-agent-sdk.tgz",
            sha256: "sha_sdk",
            sizeBytes: 12000,
          },
        ],
      },
    };
  }
  if (workItemId === "work_item_missing_artifact_directory") {
    return {
      policyDiscovery: {
        status: "failed",
        message: "missing generated artifact directory .openpond",
        command: "bun run agent:inspect",
        exitCode: 1,
      },
    };
  }
  if (workItemId === "work_item_missing_source_upload_metadata") {
    return {
      sourceMaterialization: {
        status: "blocked",
        message: "missing .openpond/source-upload-metadata.json",
        blockedReason: "source_upload_metadata_missing",
      },
      policyDiscovery: {
        status: "blocked",
        message: "source-upload metadata missing",
      },
      publishBlockers: ["source_upload_metadata_missing"],
    };
  }
  if (workItemId === "work_item_stale_source_upload_metadata") {
    return {
      sourceUploadMetadata: {
        ...sourceUploadMetadataStatusFixture(),
        status: "stale",
        staleReasons: ["artifact_hash_mismatch"],
      },
      policyDiscovery: {
        status: "blocked",
        message: "source-upload metadata is stale",
      },
      publishBlockers: ["source_upload_metadata_stale"],
    };
  }
  if (workItemId === "work_item_invalid_inspect_json") {
    return {
      policyDiscovery: {
        status: "failed",
        message: "invalid inspect JSON",
        command: "bun run agent:inspect",
        exitCode: 1,
      },
    };
  }
  if (workItemId === "work_item_validation_failure") {
    return {
      checkRuns: [
        {
          command: "bun run agent:validate",
          status: "failed",
          passed: false,
          exitCode: 1,
          artifactRefs: ["artifacts/validator-report.json"],
        },
      ],
      validation: {
        status: "failed",
        passed: false,
        artifactRef: "artifacts/validator-report.json",
      },
      validatorArtifactRefs: ["artifacts/validator-report.json"],
    };
  }
  if (workItemId === "work_item_eval_failure") {
    return {
      checkRuns: [
        {
          command: "bun run agent:eval",
          status: "failed",
          passed: false,
          exitCode: 1,
          artifactRefs: ["artifacts/openpond-eval-results.json"],
        },
      ],
      eval: {
        status: "failed",
        passed: false,
        artifactRef: "artifacts/openpond-eval-results.json",
      },
      evalResultArtifactRefs: ["artifacts/openpond-eval-results.json"],
    };
  }
  if (workItemId === "work_item_publish_blocked") {
    return {
      deployPlan: {
        status: "blocked",
        canDeploy: false,
        blockedReasons: ["source_commit_sha_missing", "failed_checks"],
      },
      publishBlockers: ["source_commit_sha_missing", "failed_checks"],
    };
  }
  return {};
}

export function sandboxRecord(
  overrides: { runtimeId?: string | null } = {}
): Record<string, unknown> {
  return {
    id: "sandbox_test",
    state: "running",
    runtimeDriver: "remote-firecracker",
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
      excludedToolchains: ["node", "bun", "python", "browser"],
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
      excludedToolchains: ["node", "bun", "python", "browser"],
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
    workItemId: "work_item_test",
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
