import { afterEach, expect, test, vi } from "vitest";
import { contentHash, sha256 } from "@openpond/harness";
import { randomBytes } from "node:crypto";
import { zstdDecompressSync } from "node:zlib";
import { previewAgentImport } from "@openpond/evals/connected-evidence";
import type { CollectorAdmission, CollectorConnection } from "@openpond/evals/native-conversations";
import { collectorTransport } from "../src/importer/transport";

vi.mock("../src/config", () => ({ loadConfig: async () => ({ apiKey: "test-import-key" }) }));

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); vi.useRealTimers(); });

// Failure story: several individually healthy uploads exceed one minute in
// aggregate, so the importer repeatedly times out without committing its source.
// The server must also recover exact bytes after concurrent parts fail or stop.
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
  const files = [{ path: "source.jsonl", text: [
    { type: "session_meta", payload: { id: "session" } },
    { type: "response_item", timestamp: "2026-10-01T00:00:00Z", payload: { type: "message", role: "user", content: "Selected request" } },
    { type: "response_item", timestamp: "2026-10-01T00:00:01Z", payload: { type: "message", role: "assistant", content: randomBytes(1_200_000).toString("base64") } },
    { type: "event_msg", timestamp: "2026-10-01T00:00:02Z", payload: { type: "task_complete" } },
  ].map(row => JSON.stringify(row)).join("\n") }];
  const session = previewAgentImport({ source: "codex", files,
    acquisition: { machineId: source.machineId, sourceInstanceId: source.instanceId } }).sessions[0]!;
  const boundary = session.boundaries.find(item => item.projection === "turn" && item.terminal === "completed")!;
  const entry: CollectorAdmission = { operationId: "stable-operation", connectionId: connection.id,
    sessionKey: JSON.stringify([source.instanceId, session.sessionId, session.branchId]), contentHash: session.contentHash,
    files, boundaryIds: [boundary.id] };
  const committed: string[] = [];
  const uploaded = new Map<number, Buffer>();
  const attempts = new Map<number, number>();
  let expectedText = files[0]!.text;
  let activeUploads = 0, peakUploads = 0, failPart: number | undefined;
  let interrupt: AbortController | undefined;
  vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body));
    if (url.endsWith("/imports/upload")) {
      activeUploads++; peakUploads = Math.max(peakUploads, activeUploads);
      attempts.set(body.index, (attempts.get(body.index) ?? 0) + 1);
      try {
        await new Promise(resolve => setTimeout(resolve, 31_000));
        init.signal?.throwIfAborted();
        if (body.index === failPart) {
          failPart = undefined;
          return Response.json({ error: "Temporary upload failure" }, { status: 503 });
        }
        uploaded.set(body.index, Buffer.from(body.base64, "base64"));
        interrupt?.abort(new Error("Stopped by user"));
        return Response.json({ teamId: "team", hash: body.hash, parts: body.parts, index: body.index });
      } finally { activeUploads--; }
    }
    expect(activeUploads).toBe(0);
    await new Promise(resolve => setTimeout(resolve, 31_000));
    init.signal?.throwIfAborted();
    if (url.endsWith("/imports/preview")) {
      expect(body.upload.parts).toBeGreaterThan(1);
      const envelope = Buffer.concat(Array.from({ length: body.upload.parts }, (_, index) => uploaded.get(index)!));
      expect(sha256(envelope)).toBe(body.upload.hash);
      const files = JSON.parse(envelope.toString("utf8"));
      expect(files).toHaveLength(1);
      expect(files[0].encoding).toBe("zstd");
      const decoded = zstdDecompressSync(Buffer.from(files[0].base64, "base64")).toString("utf8");
      expect(decoded).toBe(expectedText);
      const actualSession = previewAgentImport({ source: "codex", files: [{ path: files[0].path, text: decoded }],
        acquisition: { machineId: source.machineId, sourceInstanceId: source.instanceId } }).sessions[0]!;
      return Response.json({ teamId: "team", source: "codex", sourceHash: "b".repeat(64), previewHash: "c".repeat(64),
      destination: body.destination, issues: [], sessions: [{ sessionHash: actualSession.contentHash, sessionId: "session", origin: "codex", exporterVersion: null,
        eventCount: session.events.length, boundaries: [{ id: boundary.id, projection: "turn", answer: true, process: "retained", terminal: "completed" }], warnings: [], sample: [] }] });
    }
    if (url.endsWith("/commit")) {
      committed.push(body.request.operationId);
      return Response.json({ teamId: "team", operationId: body.request.operationId, requestHash: contentHash(body.request),
        previewHash: body.request.previewHash, projectId: "project", state: "completed", outcomes: [] });
    }
    throw new Error(`Unexpected transport route: ${url}`);
  });
  const started = Date.now();
  let finishedAt = 0;
  const initial = collectorTransport.admit(connection, entry).then(() => { finishedAt = Date.now(); });
  await vi.advanceTimersByTimeAsync(500_000);
  await initial;
  expect(finishedAt - started).toBeGreaterThan(60_000);
  expect(peakUploads).toBe(4);
  expect(committed).toEqual([entry.operationId]);
  attempts.clear(); failPart = 1;
  const retryEntry = { ...entry, operationId: "retry-operation", files: [{ ...files[0]!, text: files[0]!.text + "\n" }] };
  expectedText = retryEntry.files[0]!.text;
  const failedWave = collectorTransport.admit(connection, retryEntry).catch(error => error);
  await vi.advanceTimersByTimeAsync(500_000);
  const failure = await failedWave;
  expect(failure).toMatchObject({ status: 503 });
  expect(failure.message).toMatch(/upload part 2\//);
  expect(activeUploads).toBe(0);
  expect(committed).toEqual([entry.operationId]);
  const retried = collectorTransport.admit(connection, retryEntry);
  await vi.advanceTimersByTimeAsync(500_000); await retried;
  expect(attempts.get(0)).toBe(1);
  expect(attempts.get(1)).toBe(2);
  expect(committed).toHaveLength(2);
  const acknowledged = [...committed];
  interrupt = new AbortController();
  const cancelled = collectorTransport.admit(connection, { ...entry, operationId: "cancelled-operation", files: [{ ...entry.files[0]!, text: entry.files[0]!.text + "\n\n" }] }, interrupt.signal)
    .catch(error => error);
  await vi.advanceTimersByTimeAsync(500_000);
  expect((await cancelled).message).toMatch(/upload part.*Stopped by user/);
  expect(activeUploads).toBe(0);
  expect(committed).toEqual(acknowledged);
});
