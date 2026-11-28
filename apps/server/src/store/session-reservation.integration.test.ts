import { randomUUID } from "node:crypto";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, it } from "vitest";
import { createSessionStore } from "./session-store.js";
import { SqliteStore } from "./store.js";
import { createChatContextBrowser } from "../training/chat-context-browser.js";
import { createSessionResourceDraft } from "../training/session-resource-draft.js";
import { chatExperimentContext, createChatExperimentScopes } from "../training/chat-experiment-scope.js";
import { canonicalSha256 } from "openpond-sdk/training";
import { HostedModelProjectTrainingSetupSchema } from "openpond-sdk/model-projects";

// A crash after session admission but before the cloud acknowledgement must
// recover the original session, even when concurrent local owners retry it.
it("recovers one reserved session across SQLite owners and process restart", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "ponder-reserved-session-"));
  let store = new SqliteStore(directory);
  let second: SqliteStore | null = new SqliteStore(directory);
  const service = (database: SqliteStore) => createSessionStore({ store: database,
    defaultSessionCwd: () => directory, appendRuntimeEvent: async event => { await database.appendRuntimeEvent(event); } });
  const owner = { version: 1 as const, installationId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", profileId: "fixture-profile",
    ownerUserId: "fixture-owner", teamId: "fixture-team", audience: "https://fixture.invalid" };
  const reservation = { sessionId: "reserved-session", operationId: "cloud-operation", payloadHash: "a".repeat(64), owner };
  const payload = { provider: "codex", title: "Reserved task", cwd: directory };
  try {
    const firstService = service(store), secondService = service(second);
    const sessions = await Promise.all(Array.from({ length: 8 }, (_, index) =>
      (index % 2 ? firstService : secondService).createReservedSession(payload, reservation)));
    expect(new Set(sessions.map(session => session.id)).size).toBe(1);
    expect(await store.sessionCount()).toBe(1);
    await store.close(); await second.close(); second = null;
    store = new SqliteStore(directory);
    const restarted = service(store);
    const recovered = await restarted.createReservedSession(payload, reservation);
    expect(recovered.id).toBe(reservation.sessionId);
    expect(await store.sessionCount()).toBe(1);
    expect(recovered.metadata?.ponderLocalOwner).toEqual(owner);
    await expect(restarted.createReservedSession({ ...payload, provider: "claude-code" }, reservation))
      .rejects.toThrow("reserved_session_identity_mismatch");
    const edited = await restarted.patchSession(recovered.id, { metadata: {
      ponderLocalOwner: { ...owner, ownerUserId: "other-owner" }, ponderDesktopReservation: {}, note: "ordinary metadata" } });
    expect(edited.metadata?.ponderLocalOwner).toEqual(owner);
    expect(edited.metadata?.ponderDesktopReservation).toEqual(recovered.metadata?.ponderDesktopReservation);
    expect(edited.metadata?.note).toBe("ordinary metadata");
    await expect(restarted.createReservedSession(payload, { ...reservation, payloadHash: "b".repeat(64) }))
      .rejects.toThrow("reserved_session_identity_mismatch");
    await expect(restarted.createReservedSession(payload, { ...reservation, operationId: "changed-operation" }))
      .rejects.toThrow("reserved_session_identity_mismatch");
  } finally { await store.close(); await second?.close(); await rm(directory, { recursive: true, force: true }); }
});

it("recovers the same local Model, folder, and chat if creating the draft is retried", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "desktop-resource-draft-"));
  let store = new SqliteStore(directory);
  const originalAccess = { actorId: "original-user", teamId: "team", token: "fixture", apiBaseUrl: "https://fixture.invalid/" };
  let access = { ...originalAccess };
  const loadAccess = async () => {
    if (!access.token) throw new Error("Signed out");
    return access;
  };
  function createDraft(readHostedVersion?: NonNullable<Parameters<typeof createSessionResourceDraft>[0]["readHostedVersion"]>) {
    const { createReservedSession } = createSessionStore({
      store,
      defaultSessionCwd: () => directory,
      appendRuntimeEvent: async event => { await store.appendRuntimeEvent(event); },
    });
    return createSessionResourceDraft({ storeDir: directory, store, createReservedSession, readHostedVersion, access: loadAccess });
  }
  const request = { operationId: randomUUID(), kind: "model", provider: "codex", modelRef: null, profileId: "default" };
  try {
    const first = await createDraft()(request);
    await store.close();
    store = new SqliteStore(directory);
    const create = createDraft();
    const recovered = await create(request);
    expect(recovered.id).toBe(first.id);
    expect(await store.sessionCount()).toBe(1);
    expect(recovered.cwd).toBe(first.cwd);
    expect((await stat(first.cwd!)).isDirectory()).toBe(true);
    expect(await store.getModelProject(request.operationId)).toMatchObject({ id: request.operationId, revision: 1 });
    await expect(create({ ...request, kind: "benchmark" })).rejects.toThrow("reserved_session_identity_mismatch");
    const benchmarkRequest = { ...request, kind: "benchmark", operationId: randomUUID() };
    const benchmark = await create(benchmarkRequest);
    const retriedBenchmark = await create(benchmarkRequest);
    expect(retriedBenchmark.id).toBe(benchmark.id);
    expect(chatExperimentContext(retriedBenchmark.metadata).scopes).toMatchObject([
      { draft: { id: benchmarkRequest.operationId, operationType: "evaluate" }, draftRevision: 1 },
    ]);
    expect((await stat(benchmark.cwd!)).isDirectory()).toBe(true);
    const scope = chatExperimentContext(benchmark.metadata).scopes[0]!;
    const update = { draft: { ...scope.draft!, name: "Updated local Benchmark" }, expectedRevision: 1, operationId: randomUUID() };
    const scopes = createChatExperimentScopes(store);
    await scopes.saveLocalDraft(benchmark.id, scope.id, update);
    await scopes.saveLocalDraft(benchmark.id, scope.id, update);
    await expect(scopes.saveLocalDraft(benchmark.id, scope.id, { ...update, operationId: randomUUID() }))
      .rejects.toThrow("The Benchmark changed.");
    const reopened = await create(benchmarkRequest);
    expect(chatExperimentContext(reopened.metadata).scopes[0]).toMatchObject({ name: update.draft.name, draftRevision: 2 });
    const contentHash = "a".repeat(64), at = "2026-01-01T00:00:00.000Z";
    const modelProject = { id: "managed-model", portableProjectId: request.operationId, revision: 1, contentHash };
    const immutable = { id: "fixture-release", contentHash };
    const versionContent = {
      schemaVersion: "openpond.trainingModelVersion.v1", teamId: "team", modelProjectId: modelProject.id,
      portableProjectId: modelProject.portableProjectId, jobId: "producing-job", createdAt: at,
      request: { submissionHash: contentHash, baseModel: { schemaVersion: "openpond.baseModelPreference.v1",
        modelId: "example/model", revision: "model-pin", tokenizerRevision: "tokenizer-pin", chatTemplateHash: contentHash,
        modelAssetId: null, source: "managed" }, recipe: { method: "sft" },
        source: { modelProject, harnessRunManifest: immutable, harnessRelease: immutable, taskset: { ...immutable, revision: 1 },
          tasksetRelease: immutable, dataset: immutable, evidenceSets: [] } },
      candidate: { artifact: { id: "exact-adapter", contentHash }, checkpointId: "checkpoint", composition: "base", parent: null },
      executionReceipt: immutable,
    };
    const version = { ...versionContent, contentHash: await canonicalSha256(versionContent) };
    const receipt = { schemaVersion: "openpond.savedModelVersionRead.v1", teamId: "team", version, model: {
      id: modelProject.id, teamId: "team", portableProjectId: modelProject.portableProjectId, name: "Model",
      objective: null, defaultBaseModel: null, defaultDestinationId: null, trainingSetup: HostedModelProjectTrainingSetupSchema.parse({}),
      sourceRevision: 1, sourceUpdatedAt: at, revision: 1, etag: contentHash, createdAt: at, updatedAt: at,
    } };
    const exactRequest = { ...benchmarkRequest, operationId: randomUUID(), benchmarkVersion: { location: "cloud", teamId: "team",
      modelProjectId: modelProject.id, jobId: version.jobId, versionHash: version.contentHash } };
    await expect(createDraft(async () => receipt)({ ...exactRequest, benchmarkVersion: { ...exactRequest.benchmarkVersion, versionHash: contentHash } }))
      .rejects.toThrow("exact saved Model version");
    const exact = await createDraft(async () => receipt)(exactRequest);
    const replay = await createDraft(async () => { throw new Error("Replay must keep the saved version offline."); })(exactRequest);
    const pinned = chatExperimentContext(replay.metadata).scopes[0]!;
    expect(replay.cwd).toBe(exact.cwd);
    expect(pinned.draft?.startingModel).toMatchObject({ source: "trained", trainedVersion: version });
    const browser = createChatContextBrowser({
      store, access: loadAccess, resources: async () => [],
      resource: async () => { throw new Error("Unexpected resource"); },
      selectResource: async () => { throw new Error("Unexpected selection"); },
      createExperiment: async () => { throw new Error("Unexpected experiment"); },
    });
    const catalogIncludes = async (sessionId: string) =>
      (await browser.catalog(true, undefined, undefined, "local")).options.some(option => option.target.sessionId === sessionId);
    const title = (await browser.current(exact.id))?.label;
    expect(await catalogIncludes(exact.id)).toBe(true);
    for (const switched of [
      { actorId: "other-user" },
      { apiBaseUrl: "https://other-fixture.invalid" },
      { teamId: "other-team" },
      { token: "" },
    ]) {
      access = { ...originalAccess, ...switched };
      await expect(browser.current(exact.id)).rejects.toThrow("owns this Benchmark");
      await expect(createDraft()(exactRequest)).rejects.toThrow("owns this Benchmark");
      expect(await catalogIncludes(exact.id)).toBe(false);
      expect(await catalogIncludes(benchmark.id)).toBe(true);
    }
    access = { ...originalAccess };
    expect(await browser.current(exact.id)).toMatchObject({ label: title, benchmarkVersion: {
      versionHash: version.contentHash, owner: { actorId: originalAccess.actorId, apiOrigin: "https://fixture.invalid" },
    } });
    const { startingModel: _source, ...substitution } = pinned.draft!;
    await expect(scopes.saveLocalDraft(exact.id, pinned.id, { draft: substitution, operationId: randomUUID(), expectedRevision: 1 }))
      .rejects.toThrow("Keep the exact saved Model version");
  } finally {
    await store.close();
    await rm(directory, { recursive: true, force: true });
  }
});
