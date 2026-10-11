import { afterEach, expect, test, vi } from "vitest";
import { contentHash } from "@openpond/harness";
import type { CollectorAdmission, CollectorConnection } from "@openpond/evals/native-conversations";
import { collectorTransport } from "../src/importer/transport";

vi.mock("../src/config", () => ({ loadConfig: async () => ({ apiKey: "test-import-key" }) }));

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); vi.useRealTimers(); });

// Failure story: several individually healthy uploads exceed one minute in
// aggregate, so the importer repeatedly times out without committing its source.
test("multipart admission survives aggregate duration and still honors cancellation", async () => {
  vi.useFakeTimers();
  vi.spyOn(AbortSignal, "timeout").mockImplementation(milliseconds => {
    const controller = new AbortController();
    setTimeout(() => controller.abort(new DOMException("Request timed out", "TimeoutError")), milliseconds);
    return controller.signal;
  });
  const source = { source: "codex" as const, machineId: "machine", instanceId: "native", root: "/selected", acquisition: "files" as const,
    available: true, capabilities: { history: true, live: true, nativeResume: false } };
  const connection: CollectorConnection = { id: "connection", teamId: "team", apiBaseUrl: "https://import.example.test", account: "test",
    source, projectId: "project", revision: 1, since: null, keepSyncing: false, state: "active" };
  const entry: CollectorAdmission = { operationId: "stable-operation", connectionId: connection.id, sessionKey: "session", contentHash: "a".repeat(64),
    files: [{ path: "source.jsonl", text: "evidence".repeat(40_000) }], boundaryIds: ["boundary"] };
  const committed: string[] = [];
  let interrupt: AbortController | undefined;
  vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
    vi.advanceTimersByTime(31_000);
    init.signal?.throwIfAborted();
    const body = JSON.parse(String(init.body));
    if (url.endsWith("/imports/upload")) {
      interrupt?.abort(new Error("Stopped by user"));
      return Response.json({ teamId: "team", hash: body.hash, parts: body.parts, index: body.index });
    }
    if (url.endsWith("/imports/preview")) return Response.json({ teamId: "team", source: "codex", sourceHash: "b".repeat(64), previewHash: "c".repeat(64),
      destination: body.destination, issues: [], sessions: [{ sessionHash: entry.contentHash, sessionId: "session", origin: "codex", exporterVersion: null,
        eventCount: 2, boundaries: [{ id: "boundary", projection: "turn", answer: true, process: "retained", terminal: "completed" }], warnings: [], sample: [] }] });
    if (url.endsWith("/commit")) {
      committed.push(body.request.operationId);
      return Response.json({ teamId: "team", operationId: body.request.operationId, requestHash: contentHash(body.request),
        previewHash: body.request.previewHash, projectId: "project", state: "completed", outcomes: [] });
    }
    throw new Error(`Unexpected transport route: ${url}`);
  });
  const started = Date.now();
  await collectorTransport.admit(connection, entry);
  expect(Date.now() - started).toBeGreaterThan(60_000);
  expect(committed).toEqual([entry.operationId]);
  interrupt = new AbortController();
  await expect(collectorTransport.admit(connection, { ...entry, operationId: "cancelled-operation", files: [{ ...entry.files[0]!, text: "changed" }] }, interrupt.signal))
    .rejects.toThrow(/upload part.*Stopped by user/);
  expect(committed).toEqual([entry.operationId]);
});
