import { describe, expect, test } from "bun:test";

import { createCodexStatusService } from "../apps/server/src/codex-status-service";

describe("Codex status service", () => {
  test("deduplicates probes, observes TTL, and preserves app-server state", async () => {
    let now = 1_000;
    let probes = 0;
    let release: (() => void) | null = null;
    const service = createCodexStatusService({
      now: () => now,
      ttlMs: 500,
      detect: async () => {
        probes += 1;
        await new Promise<void>((resolve) => { release = resolve; });
        return {
          available: true,
          binaryPath: "/usr/bin/codex",
          version: "1.2.3",
          authHealth: "signed_in" as const,
          account: null,
          error: null,
        };
      },
    });
    service.set({ ...service.get(), appServer: { status: "ready", lastError: null } });

    const first = service.refresh();
    const second = service.refresh();
    expect(probes).toBe(1);
    release!();
    expect(await first).toBe(await second);
    expect(service.get()).toMatchObject({ available: true, appServer: { status: "ready" } });

    await service.refresh();
    expect(probes).toBe(1);
    now += 501;
    const expired = service.refresh();
    expect(probes).toBe(2);
    release!();
    await expired;
  });
});
