import type { ClientConnection } from "../api";

const DEFAULT_MAX_ENTRIES = 256;
const DEFAULT_EXPIRY_SKEW_MS = 15_000;
const DEFAULT_FAILURE_TTL_MS = 5_000;
const DEFAULT_LOADING_TTL_MS = 30_000;

type ReadyEntry = {
  state: "ready";
  expiresAt: number;
  lastAccessedAt: number;
  url: string;
};

type LoadingEntry = {
  state: "loading";
  expiresAt: number;
  lastAccessedAt: number;
  promise: Promise<string | null>;
};

type FailedEntry = {
  state: "failed";
  expiresAt: number;
  lastAccessedAt: number;
};

type CacheEntry = ReadyEntry | LoadingEntry | FailedEntry;

export type SignedResourceState = { url: string | null; status: "loading" | "ready" | "error" };

export class SignedResourceUrlCache {
  private readonly entries = new Map<string, CacheEntry>();
  private connection: ClientConnection | null = null;
  private accountScope: string | null = null;
  private generation = 0;

  constructor(private readonly options: {
    expirySkewMs?: number;
    failureTtlMs?: number;
    loadingTtlMs?: number;
    maxEntries?: number;
    now?: () => number;
  } = {}) {}

  activateConnection(connection: ClientConnection | null): void {
    if (sameConnection(this.connection, connection)) return;
    this.connection = connection;
    this.clear();
  }

  activateAccountScope(scope: string | null): void {
    if (scope === this.accountScope) return;
    this.accountScope = scope;
    this.clear();
  }

  get(key: string): string | null {
    const now = this.now();
    const entry = this.entries.get(key);
    if (!entry) return null;
    if (this.expired(entry, now)) {
      this.entries.delete(key);
      return null;
    }
    entry.lastAccessedAt = now;
    touch(this.entries, key, entry);
    return entry.state === "ready" ? entry.url : null;
  }

  load(
    key: string,
    loader: () => Promise<{ expiresAt: number; url: string }>,
  ): Promise<string | null> {
    const cached = this.get(key);
    if (cached) return Promise.resolve(cached);
    const now = this.now();
    const existing = this.entries.get(key);
    if (existing?.state === "loading" && !this.expired(existing, now)) {
      return existing.promise;
    }
    if (existing?.state === "failed" && !this.expired(existing, now)) {
      return Promise.resolve(null);
    }

    const generation = this.generation;
    const promise = loader()
      .then((result) => {
        if (this.generation !== generation) return null;
        this.entries.set(key, {
          state: "ready",
          url: result.url,
          expiresAt: result.expiresAt,
          lastAccessedAt: this.now(),
        });
        this.prune();
        return result.url;
      })
      .catch(() => {
        if (this.generation !== generation) return null;
        const failedAt = this.now();
        this.entries.set(key, {
          state: "failed",
          expiresAt: failedAt + (this.options.failureTtlMs ?? DEFAULT_FAILURE_TTL_MS),
          lastAccessedAt: failedAt,
        });
        this.prune();
        return null;
      });
    this.entries.set(key, {
      state: "loading",
      promise,
      expiresAt: now + (this.options.loadingTtlMs ?? DEFAULT_LOADING_TTL_MS),
      lastAccessedAt: now,
    });
    this.prune();
    return promise;
  }

  clear(): void {
    this.generation += 1;
    this.entries.clear();
  }

  /** Keep mounted previews fresh, including after a transient signing failure. */
  watch(
    key: string,
    loader: () => Promise<{ expiresAt: number; url: string }>,
    publish: (state: SignedResourceState) => void,
  ): { refresh: (force?: boolean) => void; close: () => void } {
    let closed = false;
    let revision = 0;
    let failures = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const run = async (force = false) => {
      if (closed) return;
      const currentRevision = ++revision;
      clearTimeout(timer);
      if (force && this.entries.get(key)?.state !== "loading") this.entries.delete(key);
      const cached = this.get(key);
      publish({ url: cached, status: cached ? "ready" : "loading" });
      const url = await this.load(key, loader);
      if (closed || currentRevision !== revision) return;
      publish({ url, status: url ? "ready" : "error" });
      if (!url) {
        if (++failures <= 3) timer = setTimeout(() => void run(), [5_000, 15_000, 30_000][failures - 1]);
        return;
      }
      failures = 0;
      const entry = this.entries.get(key);
      const refreshAfter = Math.max(1_000, (entry?.expiresAt ?? this.now() + 60_000)
        - this.now() - (this.options.expirySkewMs ?? DEFAULT_EXPIRY_SKEW_MS));
      timer = setTimeout(() => void run(), refreshAfter);
    };
    void run();
    return {
      refresh: (force = false) => { failures = 0; void run(force); },
      close: () => { closed = true; revision += 1; clearTimeout(timer); },
    };
  }

  size(): number {
    this.prune();
    return this.entries.size;
  }

  private prune(): void {
    const now = this.now();
    for (const [key, entry] of this.entries) {
      if (this.expired(entry, now)) this.entries.delete(key);
    }
    const maxEntries = this.options.maxEntries ?? DEFAULT_MAX_ENTRIES;
    while (this.entries.size > maxEntries) {
      const oldestKey = this.entries.keys().next().value as string | undefined;
      if (!oldestKey) break;
      this.entries.delete(oldestKey);
    }
  }

  private expired(entry: CacheEntry, now: number): boolean {
    const skew = entry.state === "ready"
      ? this.options.expirySkewMs ?? DEFAULT_EXPIRY_SKEW_MS
      : 0;
    return entry.expiresAt <= now + skew;
  }

  private now(): number {
    return (this.options.now ?? Date.now)();
  }
}

export const signedResourceUrlCache = new SignedResourceUrlCache();

export function signedResourceCacheKey(
  connection: ClientConnection,
  kind: string,
  ...parts: string[]
): string {
  return [kind, connection.serverUrl, ...parts].join("\0");
}

function sameConnection(
  left: ClientConnection | null,
  right: ClientConnection | null,
): boolean {
  return left?.serverUrl === right?.serverUrl &&
    left?.token === right?.token &&
    left?.platform === right?.platform;
}

function touch(entries: Map<string, CacheEntry>, key: string, entry: CacheEntry): void {
  entries.delete(key);
  entries.set(key, entry);
}
