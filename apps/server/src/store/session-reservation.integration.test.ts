import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, it } from "vitest";
import { createSessionStore } from "./session-store.js";
import { SqliteStore } from "./store.js";

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
