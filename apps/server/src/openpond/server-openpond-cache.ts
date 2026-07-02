import {
  AccountStateSchema,
  OpenPondAppSchema,
  type AccountState,
  type CacheMetadata,
  type OpenPondApp,
  type RuntimeEvent,
} from "@openpond/contracts";
import {
  loadOpenPondAccountContext,
  loadOpenPondApps,
} from "@openpond/runtime";
import type { SqliteStore } from "../store/store.js";
import type { CacheEntry, OpenPondCachedData } from "../types.js";
import { event } from "../utils.js";

export function createOpenPondCache(deps: {
  store: SqliteStore;
  appendRuntimeEvent: (runtimeEvent: RuntimeEvent) => Promise<void>;
  isClosing: () => boolean;
}) {
  const { store, appendRuntimeEvent, isClosing } = deps;
  let refreshPromise: Promise<OpenPondCachedData> | null = null;

  function openPondCacheScope(account: AccountState): string {
    const activeProfile = account.activeProfile;
    return `${activeProfile?.handle ?? "signed_out"}|${activeProfile?.baseUrl ?? "default"}|${account.apiBaseUrl ?? "default"}|${account.chatApiBaseUrl ?? "default"}`;
  }

  async function loadScaffoldApps(scope: string): Promise<OpenPondApp[]> {
    const entry = await store.getCacheEntry<unknown>("openpond.scaffoldApps", scope);
    const rawApps = Array.isArray(entry?.payload) ? entry.payload : [];
    return rawApps
      .map((app) => OpenPondAppSchema.safeParse(app))
      .filter((result) => result.success)
      .map((result) => result.data);
  }

  async function upsertScaffoldApp(scope: string, app: OpenPondApp): Promise<void> {
    const existing = await loadScaffoldApps(scope);
    const next = [app, ...existing.filter((candidate) => candidate.id !== app.id)];
    await store.setCacheEntry("openpond.scaffoldApps", scope, next);
  }

  async function mergeScaffoldApps(scope: string, apps: OpenPondApp[]): Promise<OpenPondApp[]> {
    const scaffoldApps = await loadScaffoldApps(scope);
    const byId = new Map<string, OpenPondApp>();
    for (const app of scaffoldApps) byId.set(app.id, app);
    for (const app of apps) byId.set(app.id, app);
    return Array.from(byId.values());
  }

  function appendAppPage(existing: OpenPondApp[], page: OpenPondApp[]): { apps: OpenPondApp[]; addedCount: number } {
    const existingIds = new Set(existing.map((app) => app.id));
    const appended = page.filter((app) => !existingIds.has(app.id));
    return { apps: [...existing, ...appended], addedCount: appended.length };
  }

  function metaFromCache(
    entry: CacheEntry<unknown> | null,
    source: CacheMetadata["source"],
    refreshing: boolean,
    lastRefreshError?: string | null
  ): CacheMetadata {
    return {
      asOf: entry?.updatedAt ?? null,
      refreshing,
      lastRefreshError: lastRefreshError ?? entry?.error ?? null,
      source,
    };
  }

  async function refreshOpenPondCache(): Promise<OpenPondCachedData> {
    if (refreshPromise) return refreshPromise;

    refreshPromise = (async () => {
      const result = await loadOpenPondApps();
      const account = AccountStateSchema.parse(result.account);
      const apps = result.apps.map((app) => OpenPondAppSchema.parse(app));
      const scope = openPondCacheScope(account);
      const accountEntry = await store.setCacheEntry("openpond.account", scope, account, account.error);

      let appsEntry: CacheEntry<OpenPondApp[]>;
      if (result.error) {
        await store.setCacheError("openpond.apps", scope, apps, result.error);
        appsEntry =
          (await store.getCacheEntry<OpenPondApp[]>("openpond.apps", scope)) ??
          (await store.setCacheEntry("openpond.apps", scope, apps, result.error));
      } else {
        appsEntry = await store.setCacheEntry("openpond.apps", scope, apps, null);
      }

      return {
        account: accountEntry.payload,
        apps: await mergeScaffoldApps(scope, appsEntry.payload),
        appsError: result.error,
        accountMeta: metaFromCache(accountEntry, "fresh", false),
        appsMeta: metaFromCache(appsEntry, "fresh", false, result.error),
      };
    })().finally(() => {
      refreshPromise = null;
    });

    return refreshPromise;
  }

  function refreshOpenPondCacheInBackground(): void {
    if (refreshPromise || isClosing()) return;
    void refreshOpenPondCache().catch((error) => {
      if (isClosing()) return;
      void appendRuntimeEvent(
        event({
          name: "diagnostic",
          source: "server",
          status: "failed",
          output: error instanceof Error ? error.message : String(error),
        })
      );
    });
  }

  async function loadOpenPondData(options: { force?: boolean } = {}): Promise<OpenPondCachedData> {
    const context = await loadOpenPondAccountContext();
    const scope = openPondCacheScope(context.accountState);
    const [cachedAccount, cachedApps] = await Promise.all([
      store.getCacheEntry<AccountState>("openpond.account", scope),
      store.getCacheEntry<OpenPondApp[]>("openpond.apps", scope),
    ]);
    const hasCache = Boolean(cachedAccount || cachedApps);
    const needsFreshAccountProfile = Boolean(
      context.token &&
        (!cachedAccount ||
          (cachedAccount.payload.state === "signed_in" &&
            !cachedAccount.payload.avatarUrl &&
            !cachedAccount.payload.profile))
    );

    if (options.force) {
      return refreshOpenPondCache();
    }

    if (context.token && (needsFreshAccountProfile || !hasCache)) {
      refreshOpenPondCacheInBackground();
    }

    return {
      account: cachedAccount?.payload ?? context.accountState,
      apps: await mergeScaffoldApps(scope, cachedApps?.payload ?? []),
      appsError: cachedApps?.error ?? null,
      accountMeta: metaFromCache(cachedAccount, cachedAccount ? "cache" : "empty", Boolean(refreshPromise)),
      appsMeta: metaFromCache(cachedApps, cachedApps ? "cache" : "empty", Boolean(refreshPromise)),
    };
  }

  async function waitForOpenPondRefresh(): Promise<void> {
    await refreshPromise?.catch(() => undefined);
  }

  return {
    appendAppPage,
    loadOpenPondData,
    mergeScaffoldApps,
    metaFromCache,
    openPondCacheScope,
    upsertScaffoldApp,
    waitForOpenPondRefresh,
  };
}
