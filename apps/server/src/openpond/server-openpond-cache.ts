import {
  AccountStateSchema,
  OpenPondAppSchema,
  type AccountState,
  type CacheMetadata,
  type OpenPondApp,
  type RuntimeEvent,
} from "@openpond/contracts";
import {
  loadOpenPondAccountState,
  loadOpenPondAccountContext,
} from "@openpond/runtime";
import type { SqliteStore } from "../store/store.js";
import type { CacheEntry, OpenPondCachedData } from "../types.js";
import { event } from "../utils.js";

type AccountRow = AccountState["accounts"][number];

function accountIdentityKey(
  account: Pick<AccountRow, "handle" | "baseUrl">
): string {
  return `${account.handle.trim().toLowerCase()}|${
    account.baseUrl?.trim().replace(/\/+$/, "").toLowerCase() ?? "default"
  }`;
}

function hasResolvedDisplayLabel(account: AccountRow): boolean {
  const label = account.displayLabel?.trim();
  return Boolean(
    label && label.toLowerCase() !== account.handle.trim().toLowerCase()
  );
}

export function preserveCachedAccountIdentities(
  account: AccountState,
  cachedAccounts: AccountState[]
): AccountState {
  const fallbackRows = new Map<string, AccountRow>();
  for (const cached of cachedAccounts) {
    for (const candidate of cached.accounts) {
      const key = accountIdentityKey(candidate);
      const existing = fallbackRows.get(key);
      if (
        !existing ||
        (!existing.email && candidate.email) ||
        (!hasResolvedDisplayLabel(existing) &&
          hasResolvedDisplayLabel(candidate))
      ) {
        fallbackRows.set(key, candidate);
      }
    }
  }

  const accounts = account.accounts.map((candidate) => {
    const fallback = fallbackRows.get(accountIdentityKey(candidate));
    if (!fallback) return candidate;
    return {
      ...candidate,
      displayLabel: hasResolvedDisplayLabel(candidate)
        ? candidate.displayLabel
        : fallback.displayLabel,
      email: candidate.email ?? fallback.email,
      avatarUrl: candidate.avatarUrl ?? fallback.avatarUrl,
    };
  });
  const activeAccount =
    accounts.find((candidate) => candidate.isActive) ?? null;
  const unresolvedActiveLabel =
    !account.label.trim() ||
    account.label.trim().toLowerCase() ===
      account.activeProfile?.handle.trim().toLowerCase();

  return {
    ...account,
    accounts,
    label:
      unresolvedActiveLabel && activeAccount?.displayLabel
        ? activeAccount.displayLabel
        : account.label,
    email: account.email ?? activeAccount?.email ?? null,
    avatarUrl: account.avatarUrl ?? activeAccount?.avatarUrl ?? null,
  };
}

export function openPondAccountCacheScope(account: AccountState): string {
  const activeProfile = account.activeProfile;
  return `${activeProfile?.handle ?? "signed_out"}|${
    activeProfile?.baseUrl ?? "default"
  }|${account.apiBaseUrl ?? "default"}|${
    account.chatApiBaseUrl ?? "default"
  }`;
}

export function openPondWorkspaceCacheScope(account: AccountState): string {
  const stableAccountId = account.profile?.id?.trim() || "unknown";
  const activeWorkspaceId =
    account.workspaces?.activeWorkspace.id.trim() || "none";
  return `${openPondAccountCacheScope(account)}|profile:${stableAccountId}|workspace:${activeWorkspaceId}`;
}

export function shouldPreserveCachedAccountOnRefresh(
  freshAccount: AccountState,
  cachedAccount: AccountState | null | undefined,
): boolean {
  return Boolean(
    cachedAccount?.state === "signed_in" &&
      cachedAccount.workspaces &&
      freshAccount.state === "signed_in" &&
      freshAccount.error &&
      !freshAccount.workspaces,
  );
}

export function createOpenPondCache(deps: {
  store: SqliteStore;
  appendRuntimeEvent: (runtimeEvent: RuntimeEvent) => Promise<void>;
  isClosing: () => boolean;
}) {
  const { store, appendRuntimeEvent, isClosing } = deps;
  let refreshPromise: {
    scope: string | null;
    promise: Promise<OpenPondCachedData>;
  } | null = null;

  function openPondCacheScope(account: AccountState): string {
    return openPondWorkspaceCacheScope(account);
  }

  async function loadScaffoldApps(scope: string): Promise<OpenPondApp[]> {
    const entry = await store.getCacheEntry<unknown>(
      "openpond.scaffoldApps",
      scope
    );
    const rawApps = Array.isArray(entry?.payload) ? entry.payload : [];
    return rawApps
      .map((app) => OpenPondAppSchema.safeParse(app))
      .filter((result) => result.success)
      .map((result) => result.data);
  }

  async function upsertScaffoldApp(
    scope: string,
    app: OpenPondApp
  ): Promise<void> {
    const existing = await loadScaffoldApps(scope);
    const next = [
      app,
      ...existing.filter((candidate) => candidate.id !== app.id),
    ];
    await store.setCacheEntry("openpond.scaffoldApps", scope, next);
  }

  async function mergeScaffoldApps(
    scope: string,
    apps: OpenPondApp[]
  ): Promise<OpenPondApp[]> {
    const scaffoldApps = await loadScaffoldApps(scope);
    const byId = new Map<string, OpenPondApp>();
    for (const app of scaffoldApps) byId.set(app.id, app);
    for (const app of apps) byId.set(app.id, app);
    return Array.from(byId.values());
  }

  function appendAppPage(
    existing: OpenPondApp[],
    page: OpenPondApp[]
  ): { apps: OpenPondApp[]; addedCount: number } {
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

  async function refreshOpenPondCache(
    expectedScope?: string | null
  ): Promise<OpenPondCachedData> {
    const normalizedExpectedScope = expectedScope?.trim() || null;
    if (
      refreshPromise &&
      (!normalizedExpectedScope ||
        refreshPromise.scope === normalizedExpectedScope)
    ) {
      return refreshPromise.promise;
    }

    const promise = (async () => {
      const result = await loadOpenPondAccountState();
      const cachedAccounts = Object.values(
        await store.getCacheEntriesByType<AccountState>("openpond.account")
      )
        .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
        .map((entry) => entry.payload);
      const account = preserveCachedAccountIdentities(
        AccountStateSchema.parse(result.account),
        cachedAccounts
      );
      const accountScope = openPondAccountCacheScope(account);
      const cachedAccount = cachedAccounts.find(
        (candidate) => openPondAccountCacheScope(candidate) === accountScope,
      );
      if (shouldPreserveCachedAccountOnRefresh(account, cachedAccount)) {
        throw new Error(account.error ?? "OpenPond account refresh failed.");
      }
      const workspaceScope = openPondCacheScope(account);
      const [accountEntry, appsEntry] = await Promise.all([
        store.setCacheEntry(
          "openpond.account",
          accountScope,
          account,
          account.error
        ),
        store.getCacheEntry<OpenPondApp[]>("openpond.apps", workspaceScope),
      ]);

      return {
        account: accountEntry.payload,
        apps: await mergeScaffoldApps(workspaceScope, appsEntry?.payload ?? []),
        appsError: appsEntry?.error ?? null,
        accountMeta: metaFromCache(accountEntry, "fresh", false),
        appsMeta: metaFromCache(
          appsEntry,
          appsEntry ? "cache" : "empty",
          false
        ),
      };
    })().finally(() => {
      if (refreshPromise?.promise === promise) refreshPromise = null;
    });

    refreshPromise = { scope: normalizedExpectedScope, promise };
    return promise;
  }

  function refreshOpenPondCacheInBackground(scope: string): void {
    if (refreshPromise?.scope === scope || isClosing()) return;
    void refreshOpenPondCache(scope).catch((error) => {
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

  async function loadOpenPondData(
    options: { force?: boolean } = {}
  ): Promise<OpenPondCachedData> {
    const context = await loadOpenPondAccountContext();
    const accountScope = openPondAccountCacheScope(context.accountState);
    const cachedAccount = await store.getCacheEntry<AccountState>(
      "openpond.account",
      accountScope,
    );
    const account = cachedAccount?.payload ?? context.accountState;
    const workspaceScope = openPondCacheScope(account);
    const cachedApps = await store.getCacheEntry<OpenPondApp[]>(
      "openpond.apps",
      workspaceScope,
    );
    const hasAccountCache = Boolean(cachedAccount);
    const needsFreshAccountProfile = Boolean(
      context.token &&
        (!cachedAccount ||
          (cachedAccount.payload.state === "signed_in" &&
            !cachedAccount.payload.avatarUrl &&
            !cachedAccount.payload.profile))
    );

    if (options.force) {
      return refreshOpenPondCache(accountScope);
    }

    if (context.token && (needsFreshAccountProfile || !hasAccountCache)) {
      refreshOpenPondCacheInBackground(accountScope);
    }

    const refreshingThisScope = Boolean(
      refreshPromise && refreshPromise.scope === accountScope
    );
    return {
      account,
      apps: await mergeScaffoldApps(workspaceScope, cachedApps?.payload ?? []),
      appsError: cachedApps?.error ?? null,
      accountMeta: metaFromCache(
        cachedAccount,
        cachedAccount ? "cache" : "empty",
        refreshingThisScope
      ),
      appsMeta: metaFromCache(
        cachedApps,
        cachedApps ? "cache" : "empty",
        refreshingThisScope
      ),
    };
  }

  async function waitForOpenPondRefresh(): Promise<void> {
    await refreshPromise?.promise.catch(() => undefined);
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
