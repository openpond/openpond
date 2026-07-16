import { describe, expect, test } from "vitest";
import {
  createWorkspaceRefreshCoordinator,
  workspaceDiffRefreshKey,
  workspaceStatusRefreshKey,
} from "../apps/web/src/lib/workspace-refresh-coordinator";
import type { ClientConnection } from "../apps/web/src/api";

describe("workspace refresh coordinator", () => {
  test("deduplicates concurrent requests with the same workspace key", async () => {
    const coordinator = createWorkspaceRefreshCoordinator();
    let calls = 0;
    let resolveRequest: ((value: string) => void) | null = null;

    const first = coordinator.request("workspace-diff:app-1", async () => {
      calls += 1;
      return await new Promise<string>((resolve) => {
        resolveRequest = resolve;
      });
    });
    const second = coordinator.request("workspace-diff:app-1", async () => {
      calls += 1;
      return "unexpected duplicate";
    });

    expect(second.shared).toBe(true);
    expect(calls).toBe(0);
    await Promise.resolve();
    expect(calls).toBe(1);
    expect(coordinator.inFlightCount()).toBe(1);

    resolveRequest?.("diff-ready");
    await expect(Promise.all([first.promise, second.promise])).resolves.toEqual([
      "diff-ready",
      "diff-ready",
    ]);
    first.release();
    second.release();
    expect(coordinator.inFlightCount()).toBe(0);
  });

  test("aborts an in-flight request when the final consumer releases it", async () => {
    const coordinator = createWorkspaceRefreshCoordinator();
    let capturedSignal: AbortSignal | null = null;
    const request = coordinator.request("workspace-status:app-1", async (signal) => {
      capturedSignal = signal;
      return await new Promise<string>((_resolve, reject) => {
        signal.addEventListener("abort", () => reject(abortError()), { once: true });
      });
    });

    await Promise.resolve();
    expect(capturedSignal?.aborted).toBe(false);
    request.release();

    await expect(request.promise).rejects.toThrow("Aborted");
    expect(capturedSignal?.aborted).toBe(true);
    expect(coordinator.inFlightCount()).toBe(0);
  });

  test("keeps a shared request alive until every consumer releases it", async () => {
    const coordinator = createWorkspaceRefreshCoordinator();
    let capturedSignal: AbortSignal | null = null;
    const first = coordinator.request("workspace-status:app-1", async (signal) => {
      capturedSignal = signal;
      return await new Promise<string>((_resolve, reject) => {
        signal.addEventListener("abort", () => reject(abortError()), { once: true });
      });
    });
    const second = coordinator.request("workspace-status:app-1", async () => "unexpected duplicate");

    await Promise.resolve();
    first.release();
    expect(capturedSignal?.aborted).toBe(false);

    second.release();
    await expect(second.promise).rejects.toThrow("Aborted");
    expect(capturedSignal?.aborted).toBe(true);
  });

  test("builds stable status and diff keys without embedding capability tokens", () => {
    const connection: ClientConnection = {
      serverUrl: "http://127.0.0.1:17874",
      token: "secret-token",
      platform: "linux",
    };

    expect(workspaceStatusRefreshKey(connection, "app-1", false)).toBe(
      "workspace-status:http://127.0.0.1:17874:app-1:read",
    );
    expect(workspaceStatusRefreshKey(connection, "app-1", true)).toBe(
      "workspace-status:http://127.0.0.1:17874:app-1:ensure",
    );
    expect(workspaceDiffRefreshKey(connection, "app-1")).toBe(
      "workspace-diff:http://127.0.0.1:17874:app-1",
    );
    expect(workspaceDiffRefreshKey(connection, "app-1")).not.toContain(connection.token);
  });
});

function abortError(): Error {
  const error = new Error("Aborted");
  error.name = "AbortError";
  return error;
}
