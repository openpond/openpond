import { createHash, randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { mkdtemp, rm, writeFile, mkdir, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, it } from "vitest";
import { putLocalRecord } from "@openpond/persistence";
import {
  ponderDesktopRequestContent,
  ProviderSettingsSchema,
  LocalProjectSchema,
  AppPreferencesSchema,
  type PonderDesktopOperation,
  type TaskInputAdmission,
  type Turn,
} from "@openpond/contracts";
import {
  ponderDesktopSessionRevision,
  ponderDesktopExecutionRevision,
} from "../openpond/ponder-desktop-catalog.js";
import { ponderDesktopReservedSessionId } from "../openpond/ponder-desktop-operation-identity.js";
import { createSessionStore } from "./session-store.js";
import { SqliteStore } from "./store.js";
import { createPonderDesktopResultCapture } from "../openpond/ponder-desktop-result-capture.js";
import { createPonderDesktopExecutor } from "../openpond/ponder-desktop-executor.js";
import { createWorkOutputService } from "../work/work-output-service.js";
import { readPonderDesktopOutput } from "../openpond/ponder-desktop-output.js";
import { capturePonderDesktopStarters } from "../openpond/ponder-desktop-starters.js";
import { ponderSharedProjectWorkspaces } from "../openpond/ponder-desktop-workspaces.js";
import {
  capturePonderProjectSnapshot,
  readPonderLocalProjects,
} from "../openpond/ponder-project-snapshot.js";
import { createPonderDesktopProjectService } from "../openpond/ponder-desktop-project-service.js";

// The cloud claim may be acknowledged after a crash or logout. SQLite must
// retain one accepted input while fencing every new admission after revocation.
it("serializes desktop authority with canonical local input admission and restart recovery", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "ponder-desktop-inbox-"));
  let store = new SqliteStore(directory);
  let other: SqliteStore | null = null;
  const owner = {
    version: 1 as const,
    installationId: randomUUID(),
    profileId: "fixture-login",
    ownerUserId: "fixture-owner",
    teamId: "fixture-team",
    audience: "https://fixture.invalid",
  };
  const scope = {
    installationId: owner.installationId,
    profileId: owner.profileId,
    ownerUserId: owner.ownerUserId,
    teamId: owner.teamId,
    bindingId: "fixture-binding",
    bindingRevision: 1,
  };
  const epoch = randomUUID(),
    runtimeId = randomUUID(),
    now = new Date().toISOString();
  const hash = (endpoint: string, payload: unknown) =>
    createHash("sha256")
      .update(ponderDesktopRequestContent("POST", endpoint, payload))
      .digest("hex");
  const operation = (
    intent: PonderDesktopOperation["intent"],
    target: PonderDesktopOperation["target"],
    originChatTurnId = "fixture-human-turn",
  ): PonderDesktopOperation => {
    const origin = {
      scope,
      epoch,
      authorizationRevision: 1,
      originChatTurnId,
      originToolCallId: "fixture-tool",
    };
    const id = `ponder-desktop-op:${createHash("sha256")
      .update(
        JSON.stringify([
          scope.bindingId,
          origin.originChatTurnId,
          hash("/ponder/desktop/intent", intent),
        ]),
      )
      .digest("hex")}`;
    return {
      id,
      origin,
      intent,
      target,
      payloadHash: hash("/ponder/desktop/operation", {
        origin,
        intent,
        target,
      }),
      state: "dispatching",
      claimId: randomUUID(),
      claimedEpoch: epoch,
      expiresAt: new Date(Date.now() + 300_000).toISOString(),
      admittedAt: null,
      receipt: null,
      error: null,
      createdAt: now,
      updatedAt: now,
    };
  };
  const starter: PonderDesktopOperation["target"] = {
    id: "fixture-starter",
    kind: "starter",
    title: "Fixture Codex",
    providerId: "codex",
    modelId: null,
    experience: "work",
    workspaceId: "fixture-project",
    workspaceLabel: "Fixture project",
    profileSelectionId: null,
    revision: "a".repeat(64),
    available: true,
    unavailableReason: null,
    canMessage: false,
    canSteer: false,
    canStop: false,
    activeTurnId: null,
  };
  const create = operation(
    {
      action: "create",
      targetId: starter.id,
      targetRevision: starter.revision,
      title: "Fixture assignment",
      prompt: "Bounded original assignment",
    },
    starter,
  );
  try {
    // Existing stores must gain the authority tables before runtime startup
    // clears old authority. Fresh-store coverage missed this migration failure.
    await store.clearPonderDesktopAuthority();
    await store.close();
    const prior = new DatabaseSync(path.join(directory, "state", "state.sqlite"));
    try {
      for (const table of [
        "ponder_project_sharing",
        "ponder_desktop_observations",
        "ponder_desktop_inspections",
        "ponder_desktop_results",
        "ponder_desktop_authority",
        "ponder_desktop_stops",
      ])
        prior.exec(`DROP TABLE ${table}`);
      prior.exec("PRAGMA user_version = 66");
    } finally {
      prior.close();
    }
    store = new SqliteStore(directory);
    await store.clearPonderDesktopAuthority();
    other = new SqliteStore(directory);
    await store.setPonderDesktopAuthority({
      scope,
      epoch,
      runtimeId,
      authorizationRevision: 1,
      reauthorizationGeneration: 0,
      state: "attached",
      publicKey: "fixture-pinned-key",
      leaseExpiresAt: new Date(Date.now() + 60_000).toISOString(),
      catalog: null,
    });
    // Fresh project sharing is an explicit scoped grant. A saved project or
    // unchanged path string cannot confer access after logout or symlink changes.
    const folderA = path.join(directory, "project-a"),
      folderB = path.join(directory, "project-b");
    const folderLink = path.join(directory, "project-source");
    await mkdir(folderA);
    await mkdir(folderB);
    await symlink(folderA, folderLink);
    const project = LocalProjectSchema.parse({
      id: "fresh-project",
      name: "Fresh project",
      path: directory,
      workspacePath: directory,
      repoPath: null,
      source: "folder",
      sourceFolders: [folderLink],
      createdAt: now,
      updatedAt: now,
    });
    putLocalRecord(store.home, "saved_local_projects", project.id, project);
    const projectSnapshot = await capturePonderProjectSnapshot(project);
    const sharing = {
      owner,
      authority: { scope, authorizationRevision: 1 },
      project: projectSnapshot,
      shared: true,
      updatedAt: now,
    };
    await Promise.all(
      Array.from({ length: 8 }, (_, index) =>
        (index % 2 ? other! : store).setPonderProjectSharing(sharing),
      ),
    );
    expect(await store.readPonderProjectSharing(owner)).toHaveLength(1);
    expect(
      await store.readPonderProjectSharing({ ...owner, ownerUserId: "other-owner" }),
    ).toHaveLength(0);
    await expect(
      other.setPonderProjectSharing({
        ...sharing,
        owner: { ...owner, ownerUserId: "other-owner" },
      }),
    ).rejects.toThrow("ponder_desktop_project_authority_changed");
    await expect(
      other.setPonderProjectSharing({
        ...sharing,
        authority: { scope: { ...scope, bindingRevision: 2 }, authorizationRevision: 1 },
      }),
    ).rejects.toThrow("ponder_desktop_project_authority_changed");
    await rm(folderLink);
    await symlink(folderB, folderLink);
    const movedProject = await capturePonderProjectSnapshot(project);
    expect(movedProject.configurationHash).toBe(projectSnapshot.configurationHash);
    expect(movedProject.revision).not.toBe(projectSnapshot.revision);
    let sessions = createSessionStore({
      store,
      defaultSessionCwd: () => directory,
      appendRuntimeEvent: async (event) => {
        await store.appendRuntimeEvent(event);
      },
    });
    const session = await sessions.createReservedSession(
      { provider: "codex", title: "Fixture assignment", cwd: directory },
      {
        sessionId: ponderDesktopReservedSessionId(create.id),
        operationId: create.id,
        payloadHash: create.payloadHash,
        owner,
        desktopOperation: create,
      },
    );
    // Workspace ownership survives a missing managed connection. Fresh provider
    // choices must come from current configuration; foreign sessions grant none.
    const providers = ProviderSettingsSchema.parse({
      statuses: {
        codex: {
          id: "codex",
          displayName: "Codex",
          enabled: true,
          available: true,
          capabilities: { toolCalling: true },
          modelIds: ["fresh-model", "native-chat-only", "native-deprecated"],
        },
        anthropic: {
          id: "anthropic",
          displayName: "Anthropic",
          enabled: true,
          available: true,
          capabilities: { toolCalling: true },
          modelIds: ["agent-model", "chat-only"],
        },
        openai: {
          id: "openai",
          displayName: "Unavailable",
          enabled: true,
          available: false,
          capabilities: { toolCalling: true },
          modelIds: ["unavailable-model"],
        },
      },
      modelCaches: {
        codex: {
          providerId: "codex",
          models: [
            {
              id: "native-chat-only",
              providerId: "codex",
              displayName: "Native chat",
              source: "manual",
              capabilities: { toolCalling: false },
            },
            {
              id: "native-deprecated",
              providerId: "codex",
              displayName: "Deprecated native model",
              source: "manual",
              lifecycleStatus: "deprecated",
              capabilities: { toolCalling: true },
            },
          ],
        },
        anthropic: {
          providerId: "anthropic",
          models: [
            {
              id: "agent-model",
              providerId: "anthropic",
              displayName: "Agent",
              source: "manual",
              capabilities: { toolCalling: true },
            },
            {
              id: "chat-only",
              providerId: "anthropic",
              displayName: "Chat",
              source: "manual",
              capabilities: { toolCalling: false },
            },
          ],
        },
      },
    });
    const projectService = createPonderDesktopProjectService({
      store,
      loadProjects: async () => readPonderLocalProjects(store.home),
      preferences: async () => AppPreferencesSchema.parse({}),
      current: async () => ({
        owner,
        authority: sharing.authority,
        credentialKey: "fixture-current-credential",
      }),
    });
    const staleProject = await projectService.workspaces(owner, sharing.authority);
    expect(staleProject.workspaces).toHaveLength(0);
    expect(staleProject.blockedProjects.has(project.id)).toBe(true);
    await expect(
      projectService.change({
        projectId: project.id,
        shared: true,
        expectedRevision: projectSnapshot.revision,
        expectedAuthority: sharing.authority,
      }),
    ).rejects.toThrow("ponder_desktop_project_changed");
    await projectService.change({
      projectId: project.id,
      shared: true,
      expectedRevision: movedProject.revision,
      expectedAuthority: sharing.authority,
    });
    const sharedProject = await projectService.workspaces(owner, sharing.authority);
    const freshProjectChoices = await capturePonderDesktopStarters({
      owner,
      sessions: [],
      providers,
      profiles: [],
      projectWorkspaces: sharedProject.workspaces,
      blockedProjects: sharedProject.blockedProjects,
    });
    expect(freshProjectChoices.size).toBe(4);
    expect(
      new Set([...freshProjectChoices.values()].map((choice) => choice.target.experience)),
    ).toEqual(new Set(["chat", "work"]));
    expect(
      [...freshProjectChoices.values()].every((choice) => choice.target.workspaceId === project.id),
    ).toBe(true);
    const freshChoice = [...freshProjectChoices.values()].find(
      (choice) => choice.target.providerId === "codex" && choice.target.experience === "work",
    )!;
    const freshOperation = operation(
      {
        action: "create",
        targetId: freshChoice.target.id,
        targetRevision: freshChoice.target.revision,
        title: "Fresh shared project",
        prompt: "Work in the explicitly shared project.",
      },
      freshChoice.target,
    );
    const freshExecutor = createPonderDesktopExecutor({
      store,
      createReserved: sessions.createReservedSession,
      admit: (input) => store.admitTaskInput(input),
      interrupt: async () => {
        throw new Error("Project creation cannot stop another task");
      },
      resolveStarter: async (target) => {
        const workspace = await projectService.workspaces(owner, sharing.authority);
        const available = await capturePonderDesktopStarters({
          owner,
          sessions: [],
          providers,
          profiles: [],
          projectWorkspaces: workspace.workspaces,
          blockedProjects: workspace.blockedProjects,
        });
        const choice = available.get(target.id);
        if (!choice || choice.target.revision !== target.revision)
          throw new Error("ponder_desktop_starter_target_changed");
        return choice.payload;
      },
    });
    const freshReceipt = await freshExecutor.execute(freshOperation, owner);
    const freshSession = (await store.getSession(freshReceipt.sessionId))!;
    expect(freshSession.localProjectId).toBe(project.id);
    expect(freshSession.metadata?.ponderWorkspaceRevision).toBe(
      sharedProject.workspaces[0]!.projectRevision,
    );
    const patchedFresh = await sessions.patchSession(freshSession.id, {
      metadata: {
        ordinaryUserField: "kept",
        ponderWorkspaceRevision: "0".repeat(64),
      },
    });
    expect(patchedFresh.metadata?.ponderWorkspaceRevision).toBe(
      sharedProject.workspaces[0]!.projectRevision,
    );
    expect(freshReceipt.inputId).not.toBeNull();
    expect((await store.getTaskInput(freshReceipt.inputId!))?.senderKind).toBe("ponder");
    expect((await projectService.list()).projects[0]?.shared).toBe(true);
    await projectService.change({
      projectId: project.id,
      shared: false,
      expectedRevision: null,
      expectedAuthority: sharing.authority,
    });
    const unsharedProject = await projectService.workspaces(owner, sharing.authority);
    expect(unsharedProject.workspaces).toHaveLength(0);
    expect(unsharedProject.blockedProjects.has(project.id)).toBe(true);
    const blockedChoices = await capturePonderDesktopStarters({
      owner,
      sessions: [freshSession],
      providers,
      profiles: [],
      projectWorkspaces: [],
      blockedProjects: unsharedProject.blockedProjects,
    });
    expect(blockedChoices.size).toBe(0);
    expect(await freshExecutor.recover(freshOperation)).toEqual(freshReceipt);
    const afterUnshare = operation(
      {
        ...freshOperation.intent,
        action: "create",
        targetId: freshChoice.target.id,
        targetRevision: freshChoice.target.revision,
        title: "Must not start",
        prompt: "Another instruction after removal.",
      },
      freshChoice.target,
    );
    await expect(freshExecutor.execute(afterUnshare, owner)).rejects.toThrow(
      "ponder_desktop_starter_target_changed",
    );
    await projectService.change({
      projectId: project.id,
      shared: true,
      expectedRevision: movedProject.revision,
      expectedAuthority: sharing.authority,
    });
    const reshared = await projectService.workspaces(owner, sharing.authority);
    expect(reshared.workspaces[0]!.projectRevision).not.toBe(
      sharedProject.workspaces[0]!.projectRevision,
    );
    await expect(freshExecutor.execute(afterUnshare, owner)).rejects.toThrow(
      "ponder_desktop_starter_target_changed",
    );
    const beforeRetry = (await store.readPonderProjectSharing(owner))[0]!.revision;
    await projectService.change({
      projectId: project.id,
      shared: true,
      expectedRevision: movedProject.revision,
      expectedAuthority: sharing.authority,
    });
    expect((await store.readPonderProjectSharing(owner))[0]!.revision).toBe(beforeRetry);

    const changedAuthority = ponderSharedProjectWorkspaces({
      grants: [{ ...sharing, revision: 1, shared: true }],
      authority: { scope, authorizationRevision: 2 },
      snapshots: new Map([[project.id, projectSnapshot]]),
      commandAccessMode: AppPreferencesSchema.parse({}).openPondCommandAccessMode,
    });
    expect(changedAuthority.workspaces).toHaveLength(0);
    const choices = await capturePonderDesktopStarters({
      owner,
      sessions: [session],
      providers,
      profiles: [],
      projectWorkspaces: [],
      blockedProjects: new Set(),
    });
    expect([...choices.values()].map((choice) => choice.target.modelId).sort()).toEqual([
      "agent-model",
      "fresh-model",
    ]);
    expect([...choices.values()].every((choice) => choice.target.workspaceId === directory)).toBe(
      true,
    );
    // Installed Profiles may expand choices, but never confer workspace ownership
    // or alias another repository's Profile with the same display identifier.
    const profile = (repositoryId: string, status: "ready" | "blocked" = "ready") => ({
      ref: { source: "local" as const, repositoryId, profileId: "reviewer" },
      name: `Reviewer ${repositoryId}`,
      repoPath: directory,
      sourcePath: directory,
      state: {
        mode: "local" as const,
        error: null,
        setupGate: {
          status,
          requirementCount: 0,
          blockingCount: 0,
          optionalMissingCount: 0,
          readyCount: 0,
          requirements: [],
          blockingRequirements: [],
        },
      },
    });
    const installedProfiles = [
      profile("repository-a"),
      profile("repository-b"),
      profile("blocked", "blocked"),
      { ...profile("missing"), sourcePath: path.join(directory, "missing-profile") },
    ];
    const profileChoices = await capturePonderDesktopStarters({
      owner,
      sessions: [session],
      providers,
      profiles: installedProfiles,
      projectWorkspaces: [],
      blockedProjects: new Set(),
    });
    const selectedProfiles = [...profileChoices.values()].filter(
      (choice) => choice.target.profileSelectionId !== null,
    );
    expect(selectedProfiles).toHaveLength(4);
    expect(new Set(selectedProfiles.map((choice) => choice.target.profileSelectionId)).size).toBe(
      2,
    );
    expect(
      selectedProfiles.every((choice) => choice.target.title.includes("Reviewer repository-")),
    ).toBe(true);
    expect(
      selectedProfiles
        .map(
          (choice) =>
            (choice.payload as { currentProfile: { repositoryId: string } }).currentProfile
              .repositoryId,
        )
        .sort(),
    ).toEqual(["repository-a", "repository-a", "repository-b", "repository-b"]);
    expect(
      (
        await capturePonderDesktopStarters({
          owner: { ...owner, ownerUserId: "other-owner" },
          sessions: [session],
          providers,
          profiles: installedProfiles,
          projectWorkspaces: [],
          blockedProjects: new Set(),
        })
      ).size,
    ).toBe(0);
    expect(
      (
        await capturePonderDesktopStarters({
          owner,
          sessions: [{ ...session, cwd: path.join(directory, "missing") }],
          providers,
          profiles: [],
          projectWorkspaces: [],
          blockedProjects: new Set(),
        })
      ).size,
    ).toBe(0);
    const admission = (op: PonderDesktopOperation, revision: string): TaskInputAdmission => ({
      id: `ponder-input:${op.id}`,
      sessionId: session.id,
      senderSessionId: null,
      senderKind: "ponder",
      kind: "queued",
      body: "prompt" in op.intent ? op.intent.prompt : "invalid",
      payload: {
        ponderDesktop: {
          operation: op,
          sessionRevision: revision,
          executionRevision: ponderDesktopExecutionRevision(session),
          managedSessionId: null,
        },
      },
      idempotencyKey: op.id,
      replyTo: null,
      expectedTurnId: null,
    });
    const reservation = await store.getPonderDesktopReservationResume(create, owner);
    expect(reservation?.sessionId).toBe(session.id);
    await store.close();
    await other.close();
    store = new SqliteStore(directory);
    other = new SqliteStore(directory);
    sessions = createSessionStore({
      store,
      defaultSessionCwd: () => directory,
      appendRuntimeEvent: async (event) => {
        await store.appendRuntimeEvent(event);
      },
    });
    const resumedEpoch = randomUUID();
    await store.setPonderDesktopAuthority({
      scope,
      epoch: resumedEpoch,
      runtimeId,
      authorizationRevision: 1,
      reauthorizationGeneration: 0,
      state: "attached",
      publicKey: "fixture-pinned-key",
      leaseExpiresAt: new Date(Date.now() + 60_000).toISOString(),
      catalog: null,
    });
    expect(await store.getPonderDesktopReservationResume(create, owner)).toEqual(reservation);
    await store.setPonderDesktopAuthority({
      scope,
      epoch: resumedEpoch,
      runtimeId,
      authorizationRevision: 2,
      reauthorizationGeneration: 0,
      state: "attached",
      publicKey: "fixture-pinned-key",
      leaseExpiresAt: new Date(Date.now() + 60_000).toISOString(),
      catalog: null,
    });
    expect(await store.getPonderDesktopReservationResume(create, owner)).toBeNull();
    await store.setPonderDesktopAuthority({
      scope,
      epoch: resumedEpoch,
      runtimeId,
      authorizationRevision: 1,
      reauthorizationGeneration: 0,
      state: "attached",
      publicKey: "fixture-pinned-key",
      leaseExpiresAt: new Date(Date.now() + 60_000).toISOString(),
      catalog: null,
    });
    expect(
      await store.getPonderDesktopReservationResume(create, {
        ...owner,
        ownerUserId: "foreign",
      }),
    ).toBeNull();
    await store.updateSession(session.id, (value) => ({
      ...value,
      cwd: `${directory}/changed`,
    }));
    expect(await store.getPonderDesktopReservationResume(create, owner)).toBeNull();
    await store.updateSession(session.id, () => session);
    const resumed = { ...create, claimedEpoch: resumedEpoch };
    const executor = createPonderDesktopExecutor({
      store,
      admit: (value) => store.admitTaskInput(value),
      interrupt: async () => {
        throw new Error("Reservation recovery must not interrupt a task");
      },
      resolveStarter: async () => {
        throw new Error("Reservation recovery must not reselect a starter");
      },
      createReserved: async () => {
        throw new Error("Reservation recovery must not recreate a session");
      },
    });
    await expect(
      store.admitTaskInput(admission(create, ponderDesktopSessionRevision(session, null))),
    ).rejects.toThrow("ponder_desktop_local_authority_changed");
    const recovered = await executor.execute(resumed, owner, reservation!);
    expect(recovered.sessionId).toBe(session.id);
    expect(await store.getPonderDesktopReservationResume(resumed, owner)).toBeNull();
    const first = admission(resumed, ponderDesktopSessionRevision(session, null));
    const receipts = await Promise.all(
      Array.from({ length: 8 }, (_, index) => (index % 2 ? other! : store).admitTaskInput(first)),
    );
    expect(new Set(receipts.map((receipt) => receipt.id)).size).toBe(1);
    expect(await store.taskInputsForSession(session.id)).toHaveLength(1);
    await store.clearPonderDesktopAuthority(runtimeId);
    await expect(other.setPonderProjectSharing({ ...sharing, shared: false })).rejects.toThrow(
      "ponder_desktop_project_authority_changed",
    );
    expect((await other.admitTaskInput(first)).id).toBe(first.id);
    const sessionTarget = {
      ...starter,
      id: session.id,
      kind: "session" as const,
      revision: ponderDesktopSessionRevision(session, null),
      canMessage: true,
    };
    const followup = operation(
      {
        action: "message",
        targetId: session.id,
        targetRevision: sessionTarget.revision,
        prompt: "A different bounded instruction",
      },
      sessionTarget,
    );
    await expect(other.admitTaskInput(admission(followup, sessionTarget.revision))).rejects.toThrow(
      "ponder_desktop_local_authority_changed",
    );
    await store.setPonderDesktopAuthority({
      scope,
      epoch,
      runtimeId,
      authorizationRevision: 1,
      reauthorizationGeneration: 0,
      state: "attached",
      publicKey: "fixture-pinned-key",
      leaseExpiresAt: new Date(Date.now() + 60_000).toISOString(),
      catalog: null,
    });
    const changedSession = {
      ...session,
      modelRef: { providerId: "openai" as const, modelId: "fixture-model" },
    };
    await store.updateSession(session.id, () => changedSession);
    await expect(other.admitTaskInput(admission(followup, sessionTarget.revision))).rejects.toThrow(
      "ponder_desktop_input_target_changed",
    );
    expect(
      (await store.reserveTaskFollowup(session.id, "must-not-start", "fixture-runtime"))?.state,
    ).toBe("rejected");
    expect((await store.getTaskInput(first.id))?.state).toBe("rejected");
    await store.updateSession(session.id, () => ({
      ...session,
      metadata: {
        ...session.metadata,
        ponderLocalOwner: { ...owner, ownerUserId: "foreign-owner" },
      },
    }));
    await expect(other.admitTaskInput(admission(followup, sessionTarget.revision))).rejects.toThrow(
      "ponder_desktop_input_owner_changed",
    );
    expect((await store.admitTaskInput(first)).id).toBe(first.id);
    // Restore the same owner and original managed agent, then exercise the
    // durable stop and result boundaries without dispatching a paid provider.
    const restored = { ...session, codexThreadId: "fixture-native-thread" };
    await store.updateSession(session.id, () => restored);
    const target = {
      ...sessionTarget,
      workspaceId: restored.localProjectId ?? restored.workspaceId ?? restored.cwd!,
      revision: ponderDesktopSessionRevision(restored, null),
    };
    const assigned = operation(
      {
        action: "message",
        targetId: session.id,
        targetRevision: target.revision,
        prompt: "Fixture terminal assignment",
      },
      target,
    );
    const request = admission(assigned, target.revision);
    (request.payload.ponderDesktop as Record<string, unknown>).managedSessionId =
      restored.codexThreadId;
    const accepted = await store.admitTaskInput(request);
    const turn: Turn = {
      id: "fixture-execution",
      sessionId: session.id,
      providerTurnId: null,
      prompt: accepted.body,
      startedAt: now,
      completedAt: null,
      status: "in_progress",
      error: null,
      metadata: { taskInputId: accepted.id },
      createImproveRun: null,
    };
    expect((await store.reserveTaskFollowup(session.id, turn.id, "fixture-runtime"))?.id).toBe(
      accepted.id,
    );
    await store.insertTurn(turn);
    await store.includeTaskInputs(
      session.id,
      turn.id,
      "fixture-runtime",
      "fixture-provider-request",
    );
    const stopTarget = {
      ...target,
      revision: ponderDesktopSessionRevision(restored, turn.id),
      canStop: true,
      activeTurnId: turn.id,
    };
    // A progress read must expose recent evidence without delivering input or subscribing.
    // The older record and private/history events must not replace current task progress.
    for (let index = 0; index < 105; index++) {
      await store.appendRuntimeEvent({
        id: `inspection-progress-${index}`, name: "assistant.delta", timestamp: now,
        sessionId: session.id, turnId: turn.id,
        output: index === 104 ? "Current progress: validating the API review" : "x".repeat(4_100),
        data: { phase: "commentary", nativeMessageId: "message", nativeMessageSnapshot: true },
      });
    }
    for (const [id, data] of [
      ["inspection-private", { phase: "reasoning" }],
      ["inspection-history", { retainedHistory: true }],
    ] as const) {
      await store.appendRuntimeEvent({ id, name: "assistant.delta", timestamp: now,
        sessionId: session.id, turnId: turn.id, output: "Must not be returned", data });
    }
    const inspectionIntent = {
      action: "inspect" as const, targetId: session.id,
      targetRevision: stopTarget.revision, expectedTurnId: turn.id,
    };
    const inspectionOperation = operation(inspectionIntent, stopTarget);
    const reads = await Promise.all(Array.from({ length: 8 }, (_, index) =>
      (index % 2 ? other! : store).admitPonderDesktopInspection(inspectionOperation)));
    expect(reads.every(value => JSON.stringify(value) === JSON.stringify(reads[0]))).toBe(true);
    const snapshot = reads[0]!.inspection;
    expect(snapshot.taskStatus).toBe("in_progress");
    expect(snapshot.taskCompletedAt).toBeNull();
    expect(snapshot.events.at(-1)?.text).toBe("Current progress: validating the API review");
    expect(snapshot.events).toHaveLength(100);
    expect(snapshot.events.some(value => value.id === "inspection-progress-0" ||
      value.id === "inspection-private" || value.id === "inspection-history")).toBe(false);
    expect(snapshot.events.reduce((total, event) => total + event.text.length, 0)).toBeLessThanOrEqual(16_000);
    expect(snapshot.coverage.olderEventsOmitted).toBe(true);
    expect(snapshot.coverage.textTruncated).toBe(true);
    expect(reads[0]!.receipt.inputId).toBeNull();
    expect(await store.getTaskInput(`ponder-input:${inspectionOperation.id}`)).toBeNull();
    expect(await store.getPonderDesktopObservation(inspectionOperation.id)).toBeNull();
    await expect(store.admitPonderDesktopInspection(operation({ ...inspectionIntent,
      expectedTurnId: "fixture-wrong-turn" }, stopTarget))).rejects.toThrow("target_changed");
    const foreign = operation(inspectionIntent, stopTarget, "fixture-foreign-inspection");
    foreign.origin.scope = { ...foreign.origin.scope, ownerUserId: "another-owner" };
    foreign.payloadHash = hash("/ponder/desktop/operation", {
      origin: foreign.origin, intent: foreign.intent, target: foreign.target,
    });
    await expect(store.admitPonderDesktopInspection(foreign)).rejects.toThrow("authority_changed");
    const stop = operation(
      {
        action: "stop",
        targetId: session.id,
        targetRevision: stopTarget.revision,
        expectedTurnId: turn.id,
      },
      stopTarget,
    );
    const stops = await Promise.all(
      Array.from({ length: 8 }, (_, index) =>
        (index % 2 ? other! : store).admitPonderDesktopStop(stop),
      ),
    );
    expect(new Set(stops.map((value) => value.receipt.turnId))).toEqual(new Set([turn.id]));
    // Completion dependencies watch the admitted turn without creating another input.
    const observation = operation(
      {
        action: "observe",
        targetId: session.id,
        targetRevision: stopTarget.revision,
        expectedTurnId: turn.id,
      },
      stopTarget,
    );
    const observations = await Promise.all(
      Array.from({ length: 8 }, (_, index) =>
        (index % 2 ? other! : store).admitPonderDesktopObservation(observation),
      ),
    );
    expect(
      observations.every(
        (value) => value.receipt.inputId === null && value.receipt.turnId === turn.id,
      ),
    ).toBe(true);
    expect(await store.getTaskInput(`ponder-input:${observation.id}`)).toBeNull();
    await store.clearPonderDesktopAuthority(runtimeId);
    expect(await other.admitPonderDesktopInspection(inspectionOperation)).toEqual(reads[0]);
    await expect(store.admitPonderDesktopInspection(operation(inspectionIntent, stopTarget,
      "fixture-revoked-inspection"))).rejects.toThrow("authority_changed");
    expect((await other.admitPonderDesktopObservation(observation)).receipt.turnId).toBe(turn.id);
    expect((await other.admitPonderDesktopStop(stop)).receipt.turnId).toBe(turn.id);
    await store.appendRuntimeEvent({
      id: "provisional",
      name: "assistant.delta",
      timestamp: now,
      sessionId: session.id,
      turnId: turn.id,
      output: "Provisional",
      data: { nativeMessageId: "message" },
    });
    await store.appendRuntimeEvent({
      id: "canonical-final",
      name: "assistant.delta",
      timestamp: now,
      sessionId: session.id,
      turnId: turn.id,
      output: "Canonical result",
      data: {
        nativeMessageId: "message",
        nativeMessageSnapshot: true,
        phase: "final_answer",
      },
    });
    await store.updateTurn(turn.id, (value) => ({
      ...value,
      status: "completed",
      completedAt: now,
    }));
    await store.settlePonderDesktopStop(stop.id, "already_finished");
    await store.settleTaskInputRequest("fixture-provider-request", "resolved");
    const outputService = createWorkOutputService({
      deviceId: owner.installationId,
      storeDir: directory,
      runtimeEventsForSession: (id) => store.runtimeEventsForSession(id),
    });
    const saved = await outputService.saveOwnedOutputBytes({
      session: (await store.getSession(session.id))!,
      sourceTurnId: turn.id,
      suggestedName: "report.txt",
      bytes: Buffer.from("Canonical file"),
      validation: [],
      validationPolicy: "preserve",
    });
    await store.appendRuntimeEvent({
      id: "canonical-file",
      name: "tool.completed",
      timestamp: now,
      sessionId: session.id,
      turnId: turn.id,
      data: { outputRef: saved.outputRef },
    });
    const capture = createPonderDesktopResultCapture({
      store,
      outputs: async () => [saved.outputRef],
    });
    const returned = await capture(assigned);
    expect(returned?.body).toBe("Canonical result");
    const observedResult = await capture(observation);
    expect(observedResult?.inputId).toBeNull();
    expect(observedResult?.turnId).toBe(turn.id);
    expect(observedResult?.body).toBe("Canonical result");
    // Downloads must use this owner's committed turn, never an arbitrary local path or changed file.
    const downloadDeps = {
      store,
      owner,
      scope,
      readOutput: outputService.readWorkOutput,
    };
    const downloadRequest = {
      operationId: assigned.id,
      turnId: turn.id,
      outputId: saved.outputRef.id,
    };
    const download = await readPonderDesktopOutput(downloadDeps, downloadRequest);
    expect(Buffer.from(download.contentsBase64, "base64").toString()).toBe("Canonical file");
    expect("location" in download).toBe(false);
    await expect(
      readPonderDesktopOutput(
        { ...downloadDeps, owner: { ...owner, ownerUserId: "foreign" } },
        downloadRequest,
      ),
    ).rejects.toThrow("ponder_desktop_output_owner_changed");
    await expect(
      readPonderDesktopOutput(
        { ...downloadDeps, scope: { ...scope, bindingRevision: 2 } },
        downloadRequest,
      ),
    ).rejects.toThrow("ponder_desktop_output_authority_changed");
    await expect(
      readPonderDesktopOutput(downloadDeps, {
        ...downloadRequest,
        outputId: "unrelated",
      }),
    ).rejects.toThrow("ponder_desktop_output_unavailable");
    if (saved.outputRef.location.kind !== "local") throw new Error("expected local fixture");
    await writeFile(saved.outputRef.location.path, "tampered");
    await expect(readPonderDesktopOutput(downloadDeps, downloadRequest)).rejects.toThrow(
      "no longer matches",
    );
    await store.appendRuntimeEvent({
      id: "late-projection",
      name: "assistant.delta",
      timestamp: now,
      sessionId: session.id,
      turnId: turn.id,
      output: "Late projection must not rewrite the committed return",
    });
    expect(await capture(assigned)).toEqual(returned);
    expect(await capture(observation)).toEqual(observedResult);
    const unknown = await sessions.createSession({
      provider: "codex",
      title: "Older local task",
      cwd: directory,
      metadata: { ponderWorkspaceRevision: movedProject.revision },
    });
    expect(unknown.metadata?.ponderLocalOwner).toBeUndefined();
    expect(unknown.metadata?.ponderWorkspaceRevision).toBeUndefined();
    const attachment = {
      sessionId: unknown.id,
      expectedRevision: ponderDesktopSessionRevision(unknown, null),
      owner,
    };
    let attachmentOwnerCurrent = true;
    const staleAttachment = store.attachLocalSessionOwner({
      ...attachment,
      assertCurrent: () => {
        if (!attachmentOwnerCurrent) throw new Error("ponder_desktop_attach_session_owner_changed");
      },
    });
    attachmentOwnerCurrent = false;
    await expect(staleAttachment).rejects.toThrow("ponder_desktop_attach_session_owner_changed");
    expect((await store.getSession(unknown.id))?.metadata?.ponderLocalOwner).toBeUndefined();
    const attached = await Promise.all([
      store.attachLocalSessionOwner(attachment),
      other.attachLocalSessionOwner(attachment),
    ]);
    expect(
      attached.every(
        (value) =>
          (value.metadata?.ponderLocalOwner as typeof owner | undefined)?.ownerUserId ===
          owner.ownerUserId,
      ),
    ).toBe(true);
    await expect(
      other.attachLocalSessionOwner({
        ...attachment,
        owner: { ...owner, ownerUserId: "foreign-owner" },
      }),
    ).rejects.toThrow("ponder_desktop_attach_session_not_eligible");
    await store.close();
    await other.close();
    other = null;
    store = new SqliteStore(directory);
    expect((await store.admitTaskInput(first)).id).toBe(first.id);
    expect(await store.taskInputsForSession(session.id)).toHaveLength(2);
    expect((await store.getPonderDesktopStop(stop.id))?.receipt.state).toBe("already_finished");
    expect(await store.getPonderDesktopResult(assigned.id, turn.id)).toEqual(returned);
    expect(await store.getPonderDesktopInspection(inspectionOperation.id)).toEqual(reads[0]);
    // A successor cannot turn a retained read into a live read of a different task turn.
    await store.insertTurn({ ...turn, id: "fixture-inspection-successor" });
    expect(await store.admitPonderDesktopInspection(inspectionOperation)).toEqual(reads[0]);
    await store.setPonderDesktopAuthority({
      scope, epoch, runtimeId, authorizationRevision: 1, reauthorizationGeneration: 0,
      state: "attached", publicKey: "fixture-pinned-key",
      leaseExpiresAt: new Date(Date.now() + 60_000).toISOString(), catalog: null,
    });
    await expect(store.admitPonderDesktopInspection(operation(inspectionIntent, stopTarget,
      "fixture-stale-inspection"))).rejects.toThrow("target_changed");
  } finally {
    await store.close();
    await other?.close();
    await rm(directory, { recursive: true, force: true });
  }
});
