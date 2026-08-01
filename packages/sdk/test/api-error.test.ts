import { describe, expect, test, vi } from "vitest";

import { createOpenPondClient, OpenPondApiError } from "../src/index.js";

describe("OpenPondApiError", () => {
  test("preserves stable API error codes and HTTP status", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      Response.json(
        { error: "sandbox_runner_unavailable" },
        { status: 503 },
      ),
    );
    const client = createOpenPondClient({
      apiKey: "opk_test",
      baseUrl: "https://api.example.com",
    });

    const request = client.sandboxes.create({
      budget: { maxUsd: "0.10" },
    });

    await expect(request).rejects.toEqual(
      expect.objectContaining({
        name: "OpenPondApiError",
        code: "sandbox_runner_unavailable",
        status: 503,
      }),
    );
    await request.catch((error: unknown) => {
      expect(error).toBeInstanceOf(OpenPondApiError);
    });
    fetchMock.mockRestore();
  });
});
