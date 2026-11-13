import { afterEach, expect, test, vi } from "vitest";
import { createClaudeReleaseReader } from "../apps/server/src/runtime/native-agents/claude-installation-status.js";

afterEach(() => vi.useRealTimers());

// General status reads must share public metadata requests without forwarding
// credentials, and release outages must not make an authenticated agent unavailable.
test("shares bounded anonymous release reads and recovers after an invalid response", async () => {
  vi.useFakeTimers();
  const fetchImpl = vi.fn<typeof fetch>().mockImplementation(async url => new Response(String(url).endsWith("stable") ? "2.1.311" : "2.1.323"));
  const read = createClaudeReleaseReader(fetchImpl);
  const first = read();
  expect(read()).toBe(first);
  expect(await first).toMatchObject({ stableVersion: "2.1.311", latestVersion: "2.1.323", updateError: null });
  expect(fetchImpl).toHaveBeenCalledTimes(2);
  for (const [url, options] of fetchImpl.mock.calls) {
    expect(String(url)).toMatch(/^https:\/\/downloads\.claude\.ai\/claude-code-releases\/(stable|latest)$/);
    expect(options).toMatchObject({ credentials: "omit", redirect: "error" });
    expect(options?.headers).toBeUndefined();
    expect(options?.signal).toBeInstanceOf(AbortSignal);
  }
  vi.advanceTimersByTime(60 * 60_000);
  fetchImpl.mockResolvedValue(new Response("not a release"));
  expect(await read()).toMatchObject({ latestVersion: null, updateError: expect.any(String) });
  const calls = fetchImpl.mock.calls.length;
  await read();
  expect(fetchImpl).toHaveBeenCalledTimes(calls);
  vi.advanceTimersByTime(60_001);
  fetchImpl.mockImplementation(async () => new Response("2.1.324"));
  expect(await read()).toMatchObject({ latestVersion: "2.1.324", updateError: null });
});
