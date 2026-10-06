import { expect, test, vi } from "vitest";
import type { ClientConnection } from "../../api/api-client";
import { ProviderConfigSchema, ProviderSettingsSchema } from "@openpond/contracts";
import { acquireNativeAgentCatalog, cachedNativeAgentCatalog, type NativeAgentCatalog } from "./native-agent-catalog";

const requests = vi.hoisted(() => ({ fetch: vi.fn() }));
vi.mock("../../api/api-client", () => ({ apiFetch: requests.fetch }));

// Failure story: multiple composers launch duplicate native probes, one closed
// composer cancels another's discovery, or account changes inherit the old probe.
test("shares in-flight discovery only within one connection and cancels after the last reader leaves", async () => {
  requests.fetch.mockClear();
  const connection: ClientConnection = { serverUrl: "https://fixture.invalid", token: "fixture", platform: "test" };
  const signals: AbortSignal[] = [];
  requests.fetch.mockImplementation((_connection, _path, init: RequestInit) => new Promise((_, reject) => {
    const signal = init.signal!;
    signals.push(signal);
    signal.addEventListener("abort", () => reject(new Error("Cancelled fixture probe")), { once: true });
  }));
  const first = acquireNativeAgentCatalog(connection, "claude-code");
  const second = acquireNativeAgentCatalog(connection, "claude-code");
  expect(requests.fetch).toHaveBeenCalledTimes(1);
  expect(first.promise).toBe(second.promise);
  expect(requests.fetch.mock.calls[0]?.[1]).toBe("/v1/providers/claude-code/native-setup");
  expect(JSON.parse(requests.fetch.mock.calls[0]?.[2].body)).toEqual({ action: "capabilities" });
  first.release();
  expect(signals[0]?.aborted).toBe(false);
  second.release();
  expect(signals[0]?.aborted).toBe(true);
  await expect(first.promise).rejects.toThrow("Cancelled");
  const replacement = acquireNativeAgentCatalog(connection, "claude-code");
  const otherAccount = acquireNativeAgentCatalog({ ...connection, token: "other-fixture" }, "claude-code");
  expect(requests.fetch).toHaveBeenCalledTimes(3);
  expect(replacement.promise).not.toBe(first.promise);
  expect(otherAccount.promise).not.toBe(replacement.promise);
  replacement.release(); replacement.release(); otherAccount.release();
  await expect(replacement.promise).rejects.toThrow("Cancelled");
  await expect(otherAccount.promise).rejects.toThrow("Cancelled");
});

// Failure story: changing threads loses completed discovery, a failed refresh
// erases the retained catalog, or changing installations reuses another login's data.
test("retains completed catalogs across remounts and refresh failures with connection and installation isolation", async () => {
  requests.fetch.mockReset();
  const connection: ClientConnection = { serverUrl: "https://fixture.invalid", token: "catalog-fixture", platform: "test" };
  const config = ProviderConfigSchema.parse({ sourceHome: "/fixture/claude" });
  const value: NativeAgentCatalog = { error: null, settings: ProviderSettingsSchema.parse({}), session: {
    modes: { currentModeId: "manual", availableModes: [{ id: "manual", name: "Ask" }] },
  } };
  let time = 100_000;
  const clock = vi.spyOn(Date, "now").mockImplementation(() => time);
  try {
    requests.fetch.mockResolvedValueOnce(value);
    const first = acquireNativeAgentCatalog(connection, "claude-code", config);
    expect(await first.promise).toBe(value);
    first.release();
    expect(cachedNativeAgentCatalog(connection, "claude-code", config)).toBe(value);
    const remounted = acquireNativeAgentCatalog(connection, "claude-code", config);
    expect(await remounted.promise).toBe(value);
    remounted.release();
    expect(requests.fetch).toHaveBeenCalledTimes(1);
    time += 31_000;
    requests.fetch.mockRejectedValueOnce(new Error("Fixture unavailable"));
    const refresh = acquireNativeAgentCatalog(connection, "claude-code", config);
    await expect(refresh.promise).rejects.toThrow("Fixture unavailable");
    refresh.release();
    expect(cachedNativeAgentCatalog(connection, "claude-code", config)).toBe(value);
    requests.fetch.mockResolvedValueOnce({ ...value, error: "Fixture needs login", session: null });
    const unavailable = acquireNativeAgentCatalog(connection, "claude-code", config);
    await unavailable.promise;
    unavailable.release();
    expect(cachedNativeAgentCatalog(connection, "claude-code", config)).toBe(value);
    const otherHome = { ...config, sourceHome: "/fixture/another-login" };
    expect(cachedNativeAgentCatalog(connection, "claude-code", otherHome)).toBeNull();
    expect(cachedNativeAgentCatalog({ ...connection, token: "another-account" }, "claude-code", config)).toBeNull();
    requests.fetch.mockResolvedValueOnce(value);
    const otherInstallation = acquireNativeAgentCatalog(connection, "claude-code", otherHome);
    await otherInstallation.promise;
    otherInstallation.release();
    expect(requests.fetch).toHaveBeenCalledTimes(4);
  } finally { clock.mockRestore(); }
});
