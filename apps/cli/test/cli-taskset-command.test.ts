import path from "node:path";

import { describe, expect, it, vi } from "vitest";

import { runTasksetCommand } from "../src/cli/taskset";

describe("taskset CLI", () => {
  it("imports a portable package through the normal local API", async () => {
    const request = vi.fn<typeof fetch>(async (_input, init) => {
      expect(init?.method).toBe("POST");
      expect(JSON.parse(String(init?.body))).toEqual({
        packagePath: path.resolve("fixtures/legal-taskset"),
        profileId: "profile-a",
      });
      return Response.json({ id: "legal-draft", name: "Legal draft" });
    });
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    try {
      await runTasksetCommand(
        { apiBaseUrl: "http://127.0.0.1:17874", profile: "profile-a", json: true },
        ["import", "fixtures/legal-taskset"],
        { request },
      );
    } finally {
      log.mockRestore();
    }
    expect(request).toHaveBeenCalledWith(
      "http://127.0.0.1:17874/v1/training/taskset-drafts/import",
      expect.objectContaining({ method: "POST" }),
    );
  });
});
