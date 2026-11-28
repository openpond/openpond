import { randomUUID } from "node:crypto";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, it } from "vitest";
import { createSessionStore } from "./session-store.js";
import { SqliteStore } from "./store.js";
import { createSessionResourceDraft } from "../training/session-resource-draft.js";
import { chatExperimentContext, createChatExperimentScopes } from "../training/chat-experiment-scope.js";

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
  function createDraft() {
    const { createReservedSession } = createSessionStore({
      store,
      defaultSessionCwd: () => directory,
      appendRuntimeEvent: async event => { await store.appendRuntimeEvent(event); },
    });
    return createSessionResourceDraft({ storeDir: directory, store, createReservedSession });
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
  } finally {
    await store.close();
    await rm(directory, { recursive: true, force: true });
  }
});
