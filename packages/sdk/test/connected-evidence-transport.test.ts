import { expect, it } from "vitest";
import { ConnectedEvidenceClient } from "../src/connected-evidence-client.js";
import { ConnectedSyncClient } from "../src/connected-sync.js";
// Failure story: a hostile evidence endpoint can exhaust memory or keep an aborted private-source request reading.
it("bounds chunked responses and cancels an aborted stream even with an injected fetch", async () => {
  let cancelled = false;
  const large = new ReadableStream<Uint8Array>({ pull(controller) { controller.enqueue(new Uint8Array(1024 * 1024)); }, cancel() { cancelled = true; } });
  const options = { baseUrl: "https://example.test", apiKey: "key", teamId: "team" };
  const client = new ConnectedEvidenceClient({ ...options, fetch: async () => new Response(large) });
  await expect(client.collection()).rejects.toMatchObject({ code: "connected_response_too_large" });
  expect(cancelled).toBe(true);
  let resolveStarted: () => void = () => undefined;
  const started = new Promise<void>(resolve => { resolveStarted = resolve; });
  const controller = new AbortController(); cancelled = false;
  const stalled = new ReadableStream<Uint8Array>({ pull() { resolveStarted(); return new Promise<void>(() => {}); }, cancel() { cancelled = true; } });
  const abortable = new ConnectedEvidenceClient({ ...options, fetch: async () => new Response(stalled) });
  const request = abortable.collection(controller.signal); const rejected = expect(request).rejects.toThrow("owner cancelled");
  await started; controller.abort(new Error("owner cancelled")); await rejected;
  expect(cancelled).toBe(true);
});

// Lost request responses must retry the same operation tuple; a receipt for a
// foreign connection or an impossible completed generation cannot show success.
it("fences sync request receipts to their connection and generation", async () => {
  const request = { id: "connection", operationId: "retained-request", expectedRevision: 1 };
  const connection = {
    teamId: "team", id: request.id, revision: 2, source: "pi", sourceLabel: "Pi", sourceRoot: "/selected",
    taskDatasetId: null, conversationDatasetId: null, machineId: "machine", sourceInstanceId: "instance", projectId: "project", datasetIds: [],
    since: null, keepSyncing: true, state: "active", health: "offline", lastHeartbeatAt: null, lastAdmissionAt: null,
    pendingOperations: 0, admittedTasks: 0, error: null, requestedSyncRevision: 2, completedSyncRevision: 0,
    syncRequestedAt: "2026-10-02T00:00:00Z", syncCompletedAt: null,
  };
  const bodies: unknown[] = [];
  let response = connection;
  const client = new ConnectedSyncClient({ baseUrl: "https://example.test", apiKey: "fixture", teamId: "team", fetch: async (url, init) => {
    expect(String(url)).toMatch(/\/sync\/connections\/sync-now$/u);
    bodies.push(JSON.parse(String(init?.body)));
    return Response.json(response);
  } });
  expect(await client.requestSync(request)).toMatchObject({ requestedSyncRevision: 2, completedSyncRevision: 0 });
  await client.requestSync(request);
  expect(bodies).toEqual([request, request]);
  response = { ...connection, id: "foreign" };
  await expect(client.requestSync(request)).rejects.toThrow(/identity/u);
  response = { ...connection, completedSyncRevision: 3 };
  await expect(client.requestSync(request)).rejects.toThrow(/generation/u);
});
