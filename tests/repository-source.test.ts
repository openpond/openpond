import { describe, expect, it, vi } from "vitest";

import {
  createPinnedGitHubRepositoryClient,
  mediaTypeForRepositoryFile,
  safeRepositoryPath,
} from "../packages/taskset-sdk/src";

describe("pinned repository Taskset sources", () => {
  it("reads only an explicitly pinned GitHub revision", async () => {
    const fetcher = vi.fn<typeof fetch>(async (input) => {
      const url = String(input);
      if (url.includes("api.github.com")) {
        return Response.json([
          { path: "tasks/example/task.json", type: "file", size: 4, sha: "blob" },
          { path: "tasks/example/assets", type: "dir", size: 0, sha: "tree" },
        ]);
      }
      return new Response(new Uint8Array([1, 2, 3, 4]));
    });
    const client = createPinnedGitHubRepositoryClient({
      repository: "example/benchmark",
      revision: "0123456789abcdef",
    }, fetcher);

    await expect(client.listFiles("tasks/example")).resolves.toEqual([
      { path: "tasks/example/task.json", size: 4, sha: "blob" },
    ]);
    await expect(client.readBytes("tasks/example/task.json")).resolves.toEqual(
      new Uint8Array([1, 2, 3, 4]),
    );
    expect(fetcher.mock.calls.map(([input]) => String(input))).toEqual([
      "https://api.github.com/repos/example/benchmark/contents/tasks/example?ref=0123456789abcdef",
      "https://raw.githubusercontent.com/example/benchmark/0123456789abcdef/tasks/example/task.json",
    ]);
  });

  it("rejects repository path traversal and maps common document media types", () => {
    expect(() => safeRepositoryPath("../secret")).toThrow("Unsafe repository path");
    expect(() => safeRepositoryPath("tasks//file.json")).toThrow("Unsafe repository path");
    expect(mediaTypeForRepositoryFile("agreement.docx")).toBe(
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    );
    expect(mediaTypeForRepositoryFile("unknown.bin")).toBe("application/octet-stream");
  });
});
