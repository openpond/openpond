import { describe, expect, test } from "vitest";
import type { RuntimeEvent } from "@openpond/contracts";
import {
  isStaleSandboxReadError,
  sandboxSourceReadbackDiffFromEvents,
  sandboxSourceReadbackFileFromEvents,
  staleSandboxReadbackMessage,
} from "../apps/web/src/components/workspace-diff/workspace-diff-file-model";
import type { SandboxRecord } from "../apps/web/src/lib/sandbox-types";

describe("workspace diff sandbox file model", () => {
  test("detects stale stopped sandbox read failures", () => {
    expect(isStaleSandboxReadError("500 sandbox_not_ready:placement_stale:sandbox_123")).toBe(true);
    expect(isStaleSandboxReadError("409 sandbox_not_running")).toBe(true);
    expect(isStaleSandboxReadError("500 sandbox_not_ready:booting:sandbox_123")).toBe(false);
  });

  test("describes preserved source checkpoint when stopped sandbox content cannot be read", () => {
    const message = staleSandboxReadbackMessage(
      "README.md",
      {
        repoRef: "openpond/runtimes/runtime_123",
        metadata: {
          sourcePreservation: {
            preservedSha: "52e2d74284738897b2ff3634be81ed896b6f6731",
            sourceRef: "openpond/runtimes/runtime_123",
          },
        },
      } as SandboxRecord,
    );

    expect(message).toContain("stopped runtime placement is stale");
    expect(message).toContain("52e2d7428473");
    expect(message).toContain("openpond/runtimes/runtime_123");
    expect(message).toContain("README.md");
  });

  test("reconstructs preserved sandbox readback files from runtime events", () => {
    const event: RuntimeEvent = {
      id: "event_readback",
      timestamp: "2026-07-06T12:00:00.000Z",
      name: "workspace_action_result",
      status: "completed",
      action: "sandbox_write_file",
      data: {
        sourcePreservation: {
          attempted: true,
          ok: true,
          sandboxId: "sandbox_1",
          sourceReadbackArtifact: {
            schemaVersion: "openpond.sandboxSourceReadback.v1",
            sandboxId: "sandbox_1",
            runtimeId: "runtime_1",
            triggerAction: "sandbox_write_file",
            preservedSha: "abc123",
            createdAt: "2026-07-06T12:00:00.000Z",
            patch: {
              text: [
                "diff --git a/README.md b/README.md",
                "index 1111111..2222222 100644",
                "--- a/README.md",
                "+++ b/README.md",
                "@@ -1 +1,2 @@",
                "-old",
                "+new",
                "+line",
              ].join("\n"),
              bytes: 140,
              fileCount: 1,
              filename: "sandbox.patch",
              sha256: "sha",
              lineCount: 8,
              empty: false,
              truncated: false,
            },
            files: [
              {
                path: "README.md",
                sizeBytes: 9,
                returnedBytes: 9,
                isBinary: false,
                truncated: false,
                content: "new\nline\n",
              },
            ],
            skippedFiles: 0,
          },
        },
      },
    };

    const diff = sandboxSourceReadbackDiffFromEvents([event], "sandbox_1");
    expect(diff?.dirty).toBe(false);
    expect(diff?.filesChanged).toBe(1);
    expect(diff?.repoFiles).toEqual(["README.md"]);
    expect(diff?.files[0]?.path).toBe("README.md");
    expect(diff?.files[0]?.additions).toBe(2);
    expect(diff?.files[0]?.deletions).toBe(1);
    expect(diff?.files[0]?.content).toBe("new\nline\n");

    const file = sandboxSourceReadbackFileFromEvents([event], "sandbox_1", "README.md");
    expect(file?.content).toBe("new\nline\n");
    expect(sandboxSourceReadbackFileFromEvents([event], "sandbox_1", "missing.txt")).toBeNull();
    expect(sandboxSourceReadbackDiffFromEvents([event], "sandbox_2")).toBeNull();
  });

  test("describes when preserved readback exists but did not capture the requested file", () => {
    const message = staleSandboxReadbackMessage(
      "dist/app.bin",
      null,
      "sandbox_not_ready:placement_stale",
      { hasReadbackArtifact: true },
    );

    expect(message).toContain("saved readback artifact");
    expect(message).toContain("dist/app.bin");
    expect(message).toContain("not captured as text");
  });
});
