import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  BootstrapPayloadSchema,
  ContextUsageSnapshotSchema,
  CompactSessionRequestSchema,
  AppPreferencesSchema,
  CloudWorkItemDetailSchema,
  CreateCloudWorkItemRequestSchema,
  CreateImproveRunSchema,
  CreateSessionRequestSchema,
  DEFAULT_OPENPOND_COMMAND_ACCESS_MODE,
  ChatProviderSchema,
  ChatModelRefSchema,
  ModelUsageRecordSchema,
  ProviderCredentialWriteRequestSchema,
  ProviderSettingsSchema,
  RuntimeEventNameSchema,
  SendCloudWorkItemMessageRequestSchema,
  SendTurnRequestSchema,
  SessionSchema,
  TurnSchema,
  CreateImproveWorkflowCaptureSchema,
  createPlaceholderPanes,
} from "../packages/contracts/dist/index.js";

function createImproveRunFixture(overrides = {}) {
  const timestamp = new Date().toISOString();
  return CreateImproveRunSchema.parse({
    schemaVersion: "openpond.createImprove.run.v1",
    id: "create_improve_fixture",
    revision: 0,
    operation: "create",
    surface: "direct_prompt_create",
    command: "/create",
    objective: "Create a fixture agent",
    state: "planning",
    adapter: {
      kind: "local",
      sourceAuthority: "local_profile",
      activeProfile: "default",
      repoPath: "/profiles/default-repo",
      sourcePath: "/profiles/default-repo/profiles/default",
      localHead: null,
      confirmationPolicy: "always_require_plan_approval",
    },
    actor: { id: "user", kind: "user", label: "User" },
    scope: {
      profileId: "default",
      conversationId: null,
      originTurnId: null,
      workItemId: null,
      projectId: null,
      targetProject: null,
    },
    context: {
      messageIds: [],
      conversationExcerpts: [],
      attachments: [],
      apps: [],
      tools: [],
      signalRefs: [],
      evalRefs: [],
      targetRepoAssumptions: [],
    },
    target: {
      kind: "agent",
      id: "fixture-agent",
      displayName: "Fixture Agent",
      defaultActionKey: "fixture-agent.chat",
    },
    plan: null,
    workflowCapture: null,
    executionPolicy: { mode: "background", pauseAllowed: true, cancellationAllowed: true },
    iterationPolicy: { mode: "single", maximumAttempts: 1, currentAttempt: 0 },
    approvalIds: [],
    questionIds: [],
    questions: [],
    candidates: [],
    evaluationReceipts: [],
    checkRefs: [],
    sourceRefs: [],
    externalExecutionRefs: [],
    localProfileCommit: null,
    hostedSourceCommit: null,
    hostedSourceRef: null,
    releaseOutcome: {
      status: "not_requested",
      profileCommit: null,
      profileTag: null,
      releaseReceiptRef: null,
      updatedAt: null,
    },
    blockedReason: null,
    appliedActionIds: [],
    metadata: {},
    createdAt: timestamp,
    updatedAt: timestamp,
    ...overrides,
  });
}

describe("contracts", () => {
  test("session and turn requests validate defaults", () => {
    assert.equal(CreateSessionRequestSchema.parse({}).provider, "openpond");
    assert.equal(
      AppPreferencesSchema.parse({}).openPondCommandAccessMode,
      DEFAULT_OPENPOND_COMMAND_ACCESS_MODE,
    );
    assert.equal(
      CreateSessionRequestSchema.parse({ openPondCommandAccessMode: "full-access" }).openPondCommandAccessMode,
      "full-access",
    );
    assert.equal(
      SessionSchema.parse({
        id: "session_1",
        provider: "openpond",
        title: "Legacy session",
        appId: null,
        appName: null,
        cwd: "/tmp/openpond",
        codexThreadId: null,
        createdAt: "2026-07-01T10:00:00.000Z",
        updatedAt: "2026-07-01T10:00:00.000Z",
        status: "idle",
        pinned: false,
        archived: false,
        order: 0,
      }).openPondCommandAccessMode,
      DEFAULT_OPENPOND_COMMAND_ACCESS_MODE,
    );
    const turn = SendTurnRequestSchema.parse({ prompt: "hello. Do not use emojis." });
    assert.equal(turn.approvalPolicy, "on-request");
    assert.equal(turn.sandbox, "workspace-write");
    assert.equal(turn.codexPermissionMode, "default");
    assert.equal(SendTurnRequestSchema.parse({ prompt: "go", codexPermissionMode: "auto-review" }).codexPermissionMode, "auto-review");
    assert.deepEqual(
      SendTurnRequestSchema.parse({
        prompt: "go",
        modelRef: { providerId: "openrouter", modelId: "anthropic/claude-sonnet-4" },
      }).modelRef,
      { providerId: "openrouter", modelId: "anthropic/claude-sonnet-4" },
    );
    assert.deepEqual(
      SendTurnRequestSchema.parse({
        prompt: "/skill summarize this thread",
        usageAttribution: {
          surface: "chat",
          workflowKind: "slash_command",
          commandName: "/skill",
          commandSource: "composer_selection",
        },
      }).usageAttribution,
      {
        surface: "chat",
        workflowKind: "slash_command",
        commandName: "/skill",
        commandSource: "composer_selection",
      },
    );
  });

  test("model usage records validate normalized token usage without raw provider payloads", () => {
    const now = new Date().toISOString();
    const record = ModelUsageRecordSchema.parse({
      id: "usage_1",
      requestId: "request_1",
      requestOrdinal: 0,
      sessionId: "session_1",
      turnId: "turn_1",
      provider: "openai",
      model: "gpt-4.1",
      route: "local_byok",
      source: "provider_usage",
      requestKind: "chat_turn",
      visibility: "user_facing",
      status: "completed",
      startedAt: now,
      completedAt: now,
      durationMs: 1200,
      firstTokenMs: 180,
      promptTokens: 1000,
      completionTokens: 250,
      totalTokens: 1250,
      errorType: null,
      errorMessage: null,
      attribution: {
        surface: "chat",
        workflowKind: "direct_chat",
        sessionId: "session_1",
        turnId: "turn_1",
        insightRunId: null,
        goalId: null,
        createImproveRunId: null,
        commandName: null,
        commandSource: null,
        appId: null,
        workspaceKind: "local_project",
        workspaceId: "project_1",
        localProjectId: "project_1",
        cloudProjectId: null,
        sourceEventSequence: null,
      },
    });
    assert.equal(record.totalTokens, 1250);
    assert.equal(record.attribution.workspaceKind, "local_project");
    assert.equal("rawUsage" in record, false);
    const started = ModelUsageRecordSchema.parse({
      ...record,
      requestId: "request_started",
      status: "started",
      completedAt: null,
      durationMs: null,
      promptTokens: null,
      completionTokens: null,
      totalTokens: null,
    });
    assert.equal(started.status, "started");
  });

  test("provider contracts validate local BYOK surface without raw bootstrap secrets", () => {
    assert.equal(ChatProviderSchema.parse("openrouter"), "openrouter");
    assert.deepEqual(ChatModelRefSchema.parse({ providerId: "anthropic", modelId: "claude-sonnet-4" }), {
      providerId: "anthropic",
      modelId: "claude-sonnet-4",
    });
    const settings = ProviderSettingsSchema.parse({});
    assert.deepEqual(settings, {
      version: 1,
      providers: {},
      statuses: {},
      modelCaches: {},
      updatedAt: null,
    });
    assert.throws(() => ProviderCredentialWriteRequestSchema.parse({ source: "local_secret" }));
    assert.throws(() => ProviderCredentialWriteRequestSchema.parse({ source: "env" }));
    assert.equal(
      ProviderCredentialWriteRequestSchema.parse({ source: "env", envVar: "OPENROUTER_API_KEY" }).envVar,
      "OPENROUTER_API_KEY",
    );
  });

  test("context usage events validate", () => {
    assert.equal(RuntimeEventNameSchema.parse("session.context.updated"), "session.context.updated");
    assert.equal(RuntimeEventNameSchema.parse("session.compaction.started"), "session.compaction.started");
    assert.equal(RuntimeEventNameSchema.parse("session.compaction.completed"), "session.compaction.completed");
    assert.equal(RuntimeEventNameSchema.parse("session.compaction.failed"), "session.compaction.failed");
    assert.equal(RuntimeEventNameSchema.parse("create_improve.updated"), "create_improve.updated");
    assert.equal(RuntimeEventNameSchema.parse("assistant.reasoning.delta"), "assistant.reasoning.delta");
    const snapshot = ContextUsageSnapshotSchema.parse({
      provider: "openpond",
      model: "openpond-chat",
      usedTokens: 2400,
      maxContextTokens: 128000,
      usableContextTokens: 117760,
      percentFull: 2,
      source: "provider_usage",
      updatedAtEventId: "event_context",
    });
    assert.equal(snapshot.usedTokens, 2400);
    assert.equal(
      ContextUsageSnapshotSchema.parse({
        provider: "codex",
        model: "codex",
        usedTokens: 64000,
        maxContextTokens: 128000,
        usableContextTokens: 128000,
        percentFull: 50,
        source: "provider_usage",
        updatedAtEventId: "event_context_codex",
      }).percentFull,
      50
    );
    assert.equal(CompactSessionRequestSchema.parse({}).reason, "manual");
  });

  test("context compaction preferences default on and preserve saved off", () => {
    assert.deepEqual(AppPreferencesSchema.parse({}).contextCompaction, {
      autoEnabled: true,
      triggerPercent: 85,
      summaryModel: "same_model",
    });
    assert.deepEqual(
      AppPreferencesSchema.parse({
        contextCompaction: {
          autoEnabled: false,
          triggerPercent: 90,
          summaryModel: "same_model",
        },
      }).contextCompaction,
      {
        autoEnabled: false,
        triggerPercent: 90,
        summaryModel: "same_model",
      },
    );
  });

  test("v1 placeholder panes cover workspace surfaces", () => {
    const panes = createPlaceholderPanes();
    assert.deepEqual(
      panes.map((pane) => pane.key),
      ["files", "diffs", "checks", "deploys", "sources", "schedules", "tool_runs", "logs", "app_config"],
    );
  });

  test("Create/Improve run validates source authority envelope", () => {
    const run = createImproveRunFixture({
      id: "create_improve_test",
      surface: "local_extend",
      command: "openpond extend",
      objective: "Create a triage agent",
      adapter: {
        kind: "local",
        sourceAuthority: "local_profile",
        activeProfile: "default",
        repoPath: "/profiles/default-repo",
        sourcePath: "/profiles/default-repo/profiles/default",
        localHead: "abc123",
        confirmationPolicy: "always_require_plan_approval",
      },
      scope: {
        profileId: "default",
        conversationId: null,
        originTurnId: null,
        workItemId: null,
        projectId: null,
        targetProject: null,
      },
      target: {
        kind: "agent",
        id: "triage-agent",
        displayName: "Triage Agent",
        defaultActionKey: "triage-agent.chat",
      },
    });
    assert.equal(run.adapter.sourceAuthority, "local_profile");
    assert.equal(run.adapter.confirmationPolicy, "always_require_plan_approval");
  });

  test("workflow capture artifacts carry side effect summaries", () => {
    const now = new Date().toISOString();
    const capture = CreateImproveWorkflowCaptureSchema.parse({
      schemaVersion: "openpond.createImprove.workflowCapture.v1",
      id: "workflow_capture_test",
      runId: "create_improve_1",
      command: "/create",
      objective: "Create release notes agent",
      conversationExcerpts: [],
      attachments: [],
      apps: [],
      tools: [],
      sideEffects: ["posted draft release notes"],
      profileActions: ["github.search_pull_requests"],
      externalProviders: ["GitHub"],
      environmentVariables: [],
      files: [],
      schedules: [],
      webhooks: [],
      channelTargets: ["openpond_chat"],
      outputArtifacts: [],
      targetRepoAssumptions: [],
      traceRefs: [],
      metadata: {},
      createdAt: now,
    });
    assert.deepEqual(capture.sideEffects, ["posted draft release notes"]);
    assert.deepEqual(
      CreateImproveWorkflowCaptureSchema.parse({
        ...capture,
        id: "workflow_capture_default_side_effects",
        sideEffects: undefined,
      }).sideEffects,
      []
    );
  });

  test("turn contracts carry one Create/Improve run", () => {
    const now = new Date().toISOString();
    const createImproveRun = createImproveRunFixture({
      id: "create_improve_turn",
      surface: "direct_prompt_create",
      command: "/create",
      objective: "Create release notes agent",
      adapter: {
        kind: "hosted",
        sourceAuthority: "hosted_profile",
        teamId: "team_1",
        projectId: "profile_project_1",
        activeProfile: "default",
        sourceRef: "main",
        baseSha: "abc123",
        workItemId: null,
        confirmationPolicy: "always_require_plan_approval",
      },
      scope: {
        profileId: "default",
        conversationId: "session_1",
        originTurnId: "turn_1",
        workItemId: null,
        projectId: "profile_project_1",
        targetProject: null,
      },
      context: {
        messageIds: ["message_1"],
        conversationExcerpts: [
          {
            messageId: "message_1",
            role: "user",
            excerpt: "Summarize merged PRs into release notes.",
            reason: "Recent conversation context",
          },
        ],
        attachments: [],
        apps: [],
        tools: [],
        signalRefs: [],
        evalRefs: [],
        targetRepoAssumptions: [],
      },
      target: {
        kind: "agent",
        id: "release-notes-agent",
        displayName: "Release Notes Agent",
        defaultActionKey: "release-notes-agent.chat",
      },
      metadata: { source: "web_composer_slash" },
      createdAt: now,
      updatedAt: now,
    });

    const sendTurn = SendTurnRequestSchema.parse({
      prompt: "/create release notes agent",
      createImproveRun,
    });
    assert.equal(sendTurn.createImproveRun.command, "/create");

    const turn = TurnSchema.parse({
      id: "turn_1",
      sessionId: "session_1",
      providerTurnId: null,
      prompt: "/create release notes agent",
      startedAt: now,
      completedAt: null,
      status: "in_progress",
      error: null,
      createImproveRun,
      metadata: { createImproveRun },
    });
    assert.equal(turn.createImproveRun.context.messageIds[0], "message_1");
  });

  test("cloud work item contracts carry one Create/Improve run", () => {
    const now = new Date().toISOString();
    const createImproveRun = createImproveRunFixture({
      id: "create_improve_cloud",
      surface: "hosted_create",
      command: "/create",
      objective: "Create a hosted triage agent",
      adapter: {
        kind: "hosted",
        sourceAuthority: "hosted_profile",
        teamId: "team_1",
        projectId: "profile_project_1",
        activeProfile: "default",
        sourceRef: "main",
        baseSha: "abc123",
        workItemId: null,
        confirmationPolicy: "always_require_plan_approval",
      },
      scope: {
        profileId: "default",
        conversationId: null,
        originTurnId: null,
        workItemId: null,
        projectId: "cloud_project_1",
        targetProject: {
          id: "cloud_project_1",
          name: "Cloud Project",
          workspacePath: null,
          sourceRef: "main",
          baseSha: null,
        },
      },
      context: {
        messageIds: [],
        conversationExcerpts: [],
        attachments: [],
        apps: [],
        tools: [],
        signalRefs: [],
        evalRefs: [],
        targetRepoAssumptions: ["cloud project: openpond/cloud-project"],
      },
      target: {
        kind: "agent",
        id: "hosted-triage-agent",
        displayName: "Hosted Triage Agent",
        defaultActionKey: "hosted-triage-agent.chat",
      },
      metadata: { source: "cloud_work_home" },
      createdAt: now,
      updatedAt: now,
    });

    const createRequest = CreateCloudWorkItemRequestSchema.parse({
      teamId: "team_1",
      projectId: "profile_project_1",
      title: "Create a hosted triage agent",
      initialMessage: "/create Create a hosted triage agent",
      sourceRef: "main",
      baseSha: "abc123",
      createImproveRun,
    });
    assert.equal(createRequest.createImproveRun.adapter.sourceAuthority, "hosted_profile");

    const detail = CloudWorkItemDetailSchema.parse({
      workItem: {
        id: "work_item_1",
        teamId: "team_1",
        projectId: "profile_project_1",
        conversationId: null,
        title: "Create a hosted triage agent",
        status: "backlog",
        sourceRef: "main",
        baseSha: "abc123",
        latestRuntimeId: null,
        latestSandboxId: null,
        latestTaskRunId: null,
        assignedAgentId: null,
        createdAt: now,
        updatedAt: now,
        archivedAt: null,
        metadata: {},
        createImproveRun,
      },
      messages: [],
      activity: [],
      runtimeSessions: [],
      createImproveRun,
    });
    assert.equal(detail.workItem.createImproveRun.objective, "Create a hosted triage agent");
    assert.equal(detail.createImproveRun.adapter.kind, "hosted");

    const message = SendCloudWorkItemMessageRequestSchema.parse({
      teamId: "team_1",
      message: "Revise plan: keep it concise",
      createImproveRun,
    });
    assert.equal(message.createImproveRun.command, "/create");
  });

  test("bootstrap contract accepts a signed-out account", () => {
    const now = new Date().toISOString();
    const payload = BootstrapPayloadSchema.parse({
      server: {
        id: "server",
        host: "127.0.0.1",
        port: 17874,
        startedAt: now,
        storePath: "/tmp/state.sqlite",
        version: "0.0.1",
        runtimeVersion: "openpond-code@0.3.3",
      },
      account: {
        state: "signed_out",
        activeProfile: null,
        label: "Signed out",
        email: null,
        avatarUrl: null,
        environment: null,
        baseUrl: null,
        apiBaseUrl: "https://api.openpond.ai",
        creditsLabel: null,
        profile: null,
        products: [],
        apiHealth: null,
        accounts: [],
        error: null,
      },
      codex: {
        available: false,
        binaryPath: null,
        version: null,
        authHealth: "unknown",
        appServer: { status: "idle", lastError: null },
      },
      apps: [],
      sidebarAppPreferences: {},
      appsError: null,
      appsMeta: {
        asOf: null,
        refreshing: false,
        lastRefreshError: null,
        source: "empty",
      },
      accountMeta: {
        asOf: null,
        refreshing: false,
        lastRefreshError: null,
        source: "empty",
      },
      sessions: [],
      events: [],
      approvals: [],
      placeholders: createPlaceholderPanes(),
      diagnostics: [],
    });
    assert.equal(payload.account.state, "signed_out");
    assert.equal(payload.preferences.defaultChatProvider, "openpond");
    assert.equal(payload.preferences.defaultChatModel, "openpond-chat");
    assert.equal(payload.preferences.codexReasoningEffort, "high");
    assert.equal(payload.preferences.codexPermissionMode, "default");
    assert.equal(payload.preferences.defaultBranchPrefix, "feat/");
    assert.equal(payload.preferences.defaultNewProjectDirectory, "");
    assert.equal(payload.preferences.goalStorageLocation, "global");
    assert.equal(payload.preferences.advancedWorkspaceControls, false);
    assert.deepEqual(payload.preferences.sidebarSectionsCollapsed, {
      pinned: false,
      projects: false,
      cloudProjects: false,
      chats: false,
      savedForLater: true,
    });
    assert.deepEqual(payload.providers, {
      version: 1,
      providers: {},
      statuses: {},
      modelCaches: {},
      updatedAt: null,
    });
  });

});
