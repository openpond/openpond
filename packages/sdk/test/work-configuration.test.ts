import { afterEach, describe, expect, test, vi } from "vitest";
import { createOpenPondClient } from "../src/index.js";

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });

describe("Work destination and credential boundaries", () => {
  // A generic endpoint must not be rewritten to OpChat or receive another
  // service's key. This exercises the public client through actual HTTP calls.
  test("custom Work uses only its configured destinations and keys", async () => {
    vi.stubEnv("OPENPOND_API_KEY", "opk_hosted_secret_must_not_escape");
    const calls: Array<{ url: string; key: string | null; body: any }> = [];
    let turns = 0;
    const sandbox = { id: "sb_custom", state: "running", logs: [] };
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const url = String(input);
      const body = init?.body ? JSON.parse(String(init.body)) : null;
      const key = new Headers(init?.headers).get("authorization");
      expect(new Headers(init?.headers).get("openpond-api-key")).toBeNull();
      expect(init?.redirect).toBe("error");
      calls.push({ url, key, body });
      if (url.startsWith("https://model.example/v1/")) {
        expect(url).toBe("https://model.example/v1/chat/completions");
        expect(key).toBe("Bearer model-key");
        expect(body.model).toBe("customer-model");
        expect(body.metadata).toBeUndefined();
        return Response.json({ choices: [{ message: ++turns === 1 ? {
          content: null, tool_calls: [{ id: "call_1", type: "function", function: { name: "run_command", arguments: '{"command":"printf proof"}' } }],
        } : { content: "Done" } }] });
      }
      expect(url.startsWith("https://runtime.example/api/sandboxes")).toBe(true);
      expect(key).toBe("Bearer runtime-key");
      if (url.endsWith("/exec")) return Response.json({ sandbox, command: { status: "succeeded", output: "proof", exitCode: 0 } });
      if (url.includes("list=1")) return Response.json({ sandbox, files: [] });
      return Response.json({ sandbox: { ...sandbox, ...(init?.method === "DELETE" ? { state: "deleted" } : {}) } });
    });
    const client = createOpenPondClient({
      sandbox: { endpoint: "https://runtime.example", apiKey: "runtime-key" },
      model: { endpoint: "https://model.example/v1", apiKey: "model-key", model: "customer-model" },
    });
    await expect(client.work.run({ prompt: "Make proof", cleanup: "delete" })).resolves.toMatchObject({ text: "Done", lifecycle: { cleanup: { status: "complete" } } });
    const creation = calls.find(c => c.url.endsWith("/sandboxes") && c.body)!;
    expect(creation.body).toEqual({ resources: { cpu: 1, memoryGb: 2, diskGb: 10 } });
    expect(calls.find(c => c.url.endsWith("/exec"))?.body.timeoutSeconds).toBe(60);
  });

  test("omitted overrides preserve hosted defaults", () => {
    const client = createOpenPondClient({ apiKey: "hosted-key" });
    expect(client.sandboxes.apiKey).toBe("hosted-key");
    expect(client.sandboxes.sandboxApiUrl).toBe("https://api.openpond.ai/v1/sandboxes");
  });

  test("partial custom configuration never borrows a hosted credential", () => {
    expect(() => createOpenPondClient({ apiKey: "hosted-key", sandbox: { endpoint: "https://runtime.example", apiKey: "" } })).toThrow("Sandbox API key");
    expect(() => createOpenPondClient({ sandbox: { endpoint: "https://runtime.example", apiKey: "runtime-key" } })).toThrow("OpenPond API key");
    expect(() => createOpenPondClient({ apiKey: "hosted-key", model: { endpoint: "https://model.example/v1", apiKey: "", model: "x" } })).toThrow("Model API key");
  });
});
