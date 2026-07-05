import { describe, expect, test } from "bun:test";

import type { OpenPondSandboxClient } from "./client.js";
import { runSandboxSmoke } from "./smoke.js";
import type { SandboxRecord } from "./types/index.js";

describe("runSandboxSmoke", () => {
  test("falls back to async lifecycle cleanup when synchronous stop and delete fail", async () => {
    let state: SandboxRecord["state"] = "running";
    const files = new Map<string, string>();
    const stopOptions: unknown[] = [];
    const deleteOptions: unknown[] = [];

    const sandbox = (): SandboxRecord =>
      ({
        id: "sandbox_smoke",
        state,
        logs: [],
        runtimeDriver: "remote-firecracker",
        reservation: {
          mpp: {
            mode: "simulated_poc",
            reservationRef: "reserve_smoke",
          },
        },
      }) as unknown as SandboxRecord;

    const client = {
      create: async () => sandbox(),
      get: async () => sandbox(),
      exec: async (_sandboxId: string, input: { command: string }) => ({
        command: {
          status: "succeeded",
          output: input.command,
        },
      }),
      uploadFile: async (_sandboxId: string, path: string, content: string) => {
        files.set(path, content);
      },
      downloadFile: async (_sandboxId: string, path: string) =>
        files.get(path) ?? "",
      stop: async (_sandboxId: string, options?: unknown) => {
        stopOptions.push(options ?? null);
        if (options && typeof options === "object" && "async" in options) {
          state = "stopped";
          return { accepted: true, sandbox: sandbox() };
        }
        throw new Error("fetch failed");
      },
      receipts: async () =>
        state === "stopped" || state === "deleted"
          ? [
              {
                mpp: {
                  receiptRef: "receipt_smoke",
                },
              },
            ]
          : [],
      delete: async (_sandboxId: string, options?: unknown) => {
        deleteOptions.push(options ?? null);
        if (options && typeof options === "object" && "async" in options) {
          state = "deleted";
          return sandbox();
        }
        throw new Error("fetch failed");
      },
    } as unknown as OpenPondSandboxClient;

    const summary = await runSandboxSmoke(client, {
      preview: false,
    });

    expect(summary).toMatchObject({
      deleted: true,
      fileRoundtrip: true,
      receiptRefs: ["receipt_smoke"],
      reservationRef: "reserve_smoke",
      sandboxId: "sandbox_smoke",
      state: "stopped",
    });
    expect(summary.execOutput).toContain("openpond-code-exec-ok:");
    expect(stopOptions).toEqual([null, { async: true }]);
    expect(deleteOptions).toEqual([null, { async: true }]);
  });
});
