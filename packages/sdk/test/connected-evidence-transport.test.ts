import { expect, it } from "vitest";
import { ConnectedEvidenceClient } from "../src/connected-evidence-client.js";
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
