import { afterEach, expect, test, vi } from "vitest";
import { createHostedModelLearningApi } from "./model-learning-api";

afterEach(() => vi.unstubAllGlobals());

test("omits unselected policy and pagination values from hosted overview requests", async () => {
  const request = vi.fn(async () => Response.json({ error: "unavailable" }, { status: 503 }));
  vi.stubGlobal("fetch", request);
  const api = createHostedModelLearningApi({ serverUrl: "http://localhost:17881", token: "local-session", platform: "web" }, "model", "profile");
  await expect(api.overview({ policyId: undefined, afterId: undefined })).rejects.toThrow();
  expect((request.mock.calls[0] as unknown as [string])[0]).toBe("http://localhost:17881/v1/training/models/model/hosted-learning?profileId=profile");
});

// The shared review UI must use the hosted Model relay, never the local Profile
// learning namespace or a hosted credential exposed to the renderer.
test("routes SDK review reads through the selected Model, policy and source", async () => {
  const request = vi.fn(async () => Response.json({ items: [], nextCursor: null }));
  vi.stubGlobal("fetch", request);
  const client = createHostedModelLearningApi({ serverUrl: "http://localhost:17881", token: "local-session", platform: "web" }, "model/a", "profile").reviewClient("policy", "source");
  const abort = new AbortController();
  await client.list("evidence", { parentId: "source", limit: 30 }, { signal: abort.signal });
  const [url, init] = request.mock.calls[0] as unknown as [string, RequestInit];
  expect(url).toBe("http://localhost:17881/v1/training/models/model%2Fa/hosted-learning/review?profileId=profile");
  expect(new Headers(init.headers).get("Authorization")).toBe("Bearer local-session");
  expect(init.signal).toBe(abort.signal);
  expect(JSON.parse(String(init.body))).toEqual({ policyId: "policy", sourceId: "source", endpoint: "read", request: { scope: "profile", action: "list", kind: "evidence", parentId: "source", limit: 30 } });
  await expect(client.sourceConfiguration("source")).rejects.toThrow("Unsupported hosted review operation");
  expect(request).toHaveBeenCalledTimes(1);
});
