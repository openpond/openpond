import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";
import { createPlanUsageService } from "../apps/server/src/providers/plan-usage-service";
import { claudeUsageWindows, codexUsageWindows } from "../apps/server/src/providers/plan-usage-normalization";

afterEach(() => vi.unstubAllGlobals());

describe("provider plan usage boundary", () => {
  // A missing window must never appear as a full allowance, and model-specific
  // limits must not replace the shared plan limit in the compact summary.
  test("normalizes provider percentages and preserves multiple quota scopes", () => {
    const windows = codexUsageWindows({
      rateLimits: { primary: { usedPercent: 99 } },
      rateLimitsByLimitId: {
        codex: { primary: { usedPercent: 25, windowDurationMins: 300, resetsAt: 1800000000 }, secondary: { usedPercent: 101, windowDurationMins: 10080 } },
        spark: { primary: { usedPercent: 50, windowDurationMins: 300 } },
        unknown: { primary: { usedPercent: null }, secondary: { usedPercent: "20" } },
      },
    });
    expect(windows.map(window => [window.remainingPercent, window.shared])).toEqual([[75, true], [0, true], [50, false]]);
    expect(windows[0]?.resetsAt).toBe(new Date(1800000000000).toISOString());
    expect(codexUsageWindows({ rateLimits: { primary: null } })).toEqual([]);
    expect(claudeUsageWindows({ five_hour: { utilization: 0 }, seven_day: { utilization: 63, resets_at: "2027-01-01T00:00:00Z" }, seven_day_sonnet: { utilization: 12 }, seven_day_opus: { utilization: null } }).map(window => [window.remainingPercent, window.shared])).toEqual([[100, true], [37, true], [88, false]]);
  });

  // Multiple surfaces/windows must share one external request; switching native
  // accounts must not return a still-fresh result from the previous account.
  test("deduplicates refreshes, caches briefly, and isolates account changes", async () => {
    let now = 1800000000000;
    let identity = "first";
    let finish!: () => void;
    const read = vi.fn(async () => {
      await new Promise<void>(resolve => { finish = resolve; });
      return { status: "ready" as const, windows: [], message: null };
    });
    const service = createPlanUsageService({ now: () => now, prepare: async () => ({ key: identity, read }) });
    const first = service("codex");
    const second = service("codex");
    await vi.waitFor(() => expect(read).toHaveBeenCalledTimes(1));
    finish();
    expect(await first).toEqual(await second);
    await service("codex");
    expect(read).toHaveBeenCalledTimes(1);
    identity = "second";
    const changed = service("codex");
    await vi.waitFor(() => expect(read).toHaveBeenCalledTimes(2));
    finish();
    await changed;
    now += 61_000;
    const expired = service("codex");
    await vi.waitFor(() => expect(read).toHaveBeenCalledTimes(3));
    finish();
    await expired;
  });

  // External failures can contain headers/tokens. No raw error or old numeric
  // allowance may reach the renderer when the current fetch fails.
  test("sanitizes failures and throttles retrying unavailable providers", async () => {
    const read = vi.fn(async () => { throw new Error("Bearer private-token"); });
    const service = createPlanUsageService({ prepare: async () => ({ key: "account", read }) });
    const result = await service("claude-code");
    expect(result.status).toBe("unavailable");
    expect(result.windows).toEqual([]);
    expect(JSON.stringify(result)).not.toContain("private-token");
    await service("claude-code");
    expect(read).toHaveBeenCalledTimes(1);
  });

  // Exercises credential → provider request → renderer-safe result, including
  // a native account switch and sign-out rather than just mocking the adapter.
  test.skipIf(process.platform === "darwin")("reads the configured Claude login without leaking or persisting credentials", async () => {
    const home = await mkdtemp(join(tmpdir(), "openpond-plan-usage-"));
    const credentialPath = join(home, ".credentials.json");
    const credentials = (token: string) => JSON.stringify({ claudeAiOauth: { accessToken: token, expiresAt: Date.now() + 3600000 } });
    const fetcher = vi.fn(async () => Response.json({ five_hour: { utilization: 28 }, seven_day: { utilization: 5 } }));
    vi.stubGlobal("fetch", fetcher);
    try {
      await writeFile(credentialPath, credentials("first-secret"));
      const service = createPlanUsageService();
      const result = await service("claude-code", { sourceHome: home });
      expect(result.windows.map(window => window.remainingPercent)).toEqual([72, 95]);
      expect(fetcher).toHaveBeenCalledWith("https://api.anthropic.com/api/oauth/usage", expect.objectContaining({ headers: expect.objectContaining({ Authorization: "Bearer first-secret" }), redirect: "error" }));
      expect(JSON.stringify(result)).not.toContain("secret");
      await writeFile(credentialPath, credentials("second-secret"));
      fetcher.mockImplementationOnce(async () => new Response("private upstream detail", { status: 429 }));
      const limited = await service("claude-code", { sourceHome: home });
      expect(limited.status).toBe("unavailable");
      expect(limited.windows).toEqual([]);
      await service("claude-code", { sourceHome: home });
      expect(fetcher).toHaveBeenCalledTimes(2);
      await rm(credentialPath);
      expect((await service("claude-code", { sourceHome: home })).status).toBe("signed_out");
      expect(fetcher).toHaveBeenCalledTimes(2);
    } finally { await rm(home, { recursive: true, force: true }); }
  });
});
