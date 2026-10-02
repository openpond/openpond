import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { CollectorStore, collectorMachineId, type CollectorConnection } from "@openpond/evals/native-conversations";
import { retainedReconnect, assertReconnectSource, assertReconnectUnchanged } from "../apps/cli/src/importer/reconnect";

// Reauthorization must not replace an old profile/cutoff with today's discovery
// defaults, or revive a scope changed while its browser approval was open.
it("retains reconnect scope and rejects changed machine, source and concurrent controls", async () => {
  const directory = await mkdtemp(join(tmpdir(), "importer-reconnect-"));
  const machineId = await collectorMachineId(directory);
  const store = await CollectorStore.open(directory);
  const connection: CollectorConnection = {
    id: "retained", teamId: "team", apiBaseUrl: "https://staging-api.openpond.ai",
    accountBaseUrl: "https://staging.openpond.ai", projectId: "original-project", revision: 7,
    since: "2026-09-26T12:00:00.000Z", keepSyncing: false, state: "disconnected",
    source: { source: "pi", machineId, instanceId: "original-profile", root: join(directory, "selected-profile"), acquisition: "files", available: true, capabilities: { history: true, live: true, nativeResume: false } },
  };
  try {
    store.put(connection);
    const retained = await retainedReconnect(directory, connection.id);
    expect(retained).toEqual(connection);
    expect(() => assertReconnectSource(retained, retained.source)).not.toThrow();
    expect(() => assertReconnectSource(retained, { ...retained.source, root: join(directory, "another-profile") })).toThrow(/identity changed/);
    await assertReconnectUnchanged(directory, retained);
    store.put({ ...connection, revision: 8, since: null });
    await expect(assertReconnectUnchanged(directory, retained)).rejects.toThrow(/changed during sign-in/);
    store.put({ ...connection, revision: 9, source: { ...connection.source, machineId: "another-machine" } });
    await expect(retainedReconnect(directory, connection.id)).rejects.toThrow(/another machine/);
  } finally { store.close(); await rm(directory, { recursive: true, force: true }); }
});
