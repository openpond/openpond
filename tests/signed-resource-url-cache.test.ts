import { describe, expect, test, vi } from "vitest";
import type { ClientConnection } from "../apps/web/src/api";
import {
  SignedResourceUrlCache,
  signedResourceCacheKey,
} from "../apps/web/src/lib/signed-resource-url-cache";

describe("SignedResourceUrlCache", () => {
  test("bounds entries with least-recently-used eviction", async () => {
    let now = 1_000;
    const cache = new SignedResourceUrlCache({ maxEntries: 2, now: () => now });
    await cache.load("a", async () => ({ url: "a-url", expiresAt: 20_000 }));
    now += 1;
    await cache.load("b", async () => ({ url: "b-url", expiresAt: 20_000 }));
    expect(cache.get("a")).toBe("a-url");
    now += 1;
    await cache.load("c", async () => ({ url: "c-url", expiresAt: 20_000 }));

    expect(cache.get("a")).toBe("a-url");
    expect(cache.get("b")).toBeNull();
    expect(cache.get("c")).toBe("c-url");
    expect(cache.size()).toBe(2);
  });

  test("deduplicates loads and briefly caches failures", async () => {
    let now = 1_000;
    const cache = new SignedResourceUrlCache({ failureTtlMs: 50, now: () => now });
    const loader = vi.fn(async () => {
      throw new Error("offline");
    });

    const first = cache.load("failed", loader);
    const second = cache.load("failed", loader);
    expect(await first).toBeNull();
    expect(await second).toBeNull();
    expect(loader).toHaveBeenCalledTimes(1);
    expect(await cache.load("failed", loader)).toBeNull();
    expect(loader).toHaveBeenCalledTimes(1);

    now += 51;
    expect(await cache.load("failed", loader)).toBeNull();
    expect(loader).toHaveBeenCalledTimes(2);
  });

  test("purges on connection and account changes", async () => {
    const cache = new SignedResourceUrlCache({ expirySkewMs: 0 });
    const first = connection("token-a");
    cache.activateConnection(first);
    await cache.load("item", async () => ({ url: "signed", expiresAt: Date.now() + 60_000 }));
    expect(cache.get("item")).toBe("signed");

    cache.activateConnection(connection("token-b"));
    expect(cache.get("item")).toBeNull();
    await cache.load("item", async () => ({ url: "signed-b", expiresAt: Date.now() + 60_000 }));
    cache.activateAccountScope("account-b");
    expect(cache.get("item")).toBeNull();
  });

  test("does not repopulate a new account scope from an old in-flight request", async () => {
    const cache = new SignedResourceUrlCache({ expirySkewMs: 0 });
    let resolveLoad: ((value: { url: string; expiresAt: number }) => void) | null = null;
    const pending = cache.load(
      "shared-key",
      () => new Promise((resolve) => {
        resolveLoad = resolve;
      }),
    );

    cache.activateAccountScope("next-account");
    resolveLoad?.({ url: "old-account-url", expiresAt: Date.now() + 60_000 });

    expect(await pending).toBeNull();
    expect(cache.get("shared-key")).toBeNull();
    expect(cache.size()).toBe(0);
  });

  test("never includes the raw connection token in cache keys", () => {
    const value = signedResourceCacheKey(connection("secret-token"), "local-image", "/tmp/a.png");
    expect(value).not.toContain("secret-token");
    expect(value).toContain("local-image");
  });
});

function connection(token: string): ClientConnection {
  return {
    serverUrl: "http://127.0.0.1:3000",
    token,
    platform: "linux",
  };
}
