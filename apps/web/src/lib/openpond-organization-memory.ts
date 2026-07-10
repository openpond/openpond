import type { BootstrapPayload } from "@openpond/contracts";
import type { OpenPondOrganization } from "./organization-types";

type OpenPondOrganizationCacheEntry = {
  organizations: OpenPondOrganization[];
  promise: Promise<OpenPondOrganization[]> | null;
  updatedAt: number;
};

const organizationsByAccountKey = new Map<string, OpenPondOrganizationCacheEntry>();
const listenersByAccountKey = new Map<string, Set<() => void>>();

export function openPondOrganizationCacheKey(
  account: BootstrapPayload["account"] | null | undefined,
): string | null {
  if (!account || account.state !== "signed_in") return null;
  const activeAccount = account.accounts.find((candidate) => candidate.isActive) ?? null;
  const handle =
    account.activeProfile?.handle?.trim() ||
    activeAccount?.handle?.trim() ||
    account.label.trim() ||
    "signed_in";
  const baseUrl = account.activeProfile?.baseUrl ?? activeAccount?.baseUrl ?? account.baseUrl ?? "";
  return [handle, baseUrl, account.apiBaseUrl ?? "", account.chatApiBaseUrl ?? ""].join("|");
}

export function readOpenPondOrganizationsFromMemory(
  accountKey: string | null | undefined,
): OpenPondOrganization[] | null {
  const normalizedAccountKey = accountKey?.trim();
  if (!normalizedAccountKey) return null;
  const entry = organizationsByAccountKey.get(normalizedAccountKey);
  return entry?.updatedAt ? entry.organizations : null;
}

export function writeOpenPondOrganizationsToMemory(
  accountKey: string | null | undefined,
  organizations: OpenPondOrganization[],
): void {
  const normalizedAccountKey = accountKey?.trim();
  if (!normalizedAccountKey) return;
  organizationsByAccountKey.set(normalizedAccountKey, {
    organizations,
    promise: null,
    updatedAt: Date.now(),
  });
  for (const listener of listenersByAccountKey.get(normalizedAccountKey) ?? []) {
    listener();
  }
}

export function subscribeOpenPondOrganizations(
  accountKey: string | null | undefined,
  listener: () => void,
): () => void {
  const normalizedAccountKey = accountKey?.trim();
  if (!normalizedAccountKey) return () => undefined;
  const listeners = listenersByAccountKey.get(normalizedAccountKey) ?? new Set();
  listeners.add(listener);
  listenersByAccountKey.set(normalizedAccountKey, listeners);
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0) listenersByAccountKey.delete(normalizedAccountKey);
  };
}

export function preloadOpenPondOrganizations(input: {
  accountKey: string | null | undefined;
  force?: boolean;
  fetchOrganizations: () => Promise<OpenPondOrganization[]>;
}): Promise<OpenPondOrganization[]> {
  const normalizedAccountKey = input.accountKey?.trim();
  if (!normalizedAccountKey) return Promise.resolve([]);

  const cached = organizationsByAccountKey.get(normalizedAccountKey);
  if (!input.force) {
    if (cached?.updatedAt) return Promise.resolve(cached.organizations);
    if (cached?.promise) return cached.promise;
  }

  const promise = input
    .fetchOrganizations()
    .then((organizations) => {
      writeOpenPondOrganizationsToMemory(normalizedAccountKey, organizations);
      return organizations;
    })
    .catch((error) => {
      const current = organizationsByAccountKey.get(normalizedAccountKey);
      if (current?.promise === promise) {
        organizationsByAccountKey.set(normalizedAccountKey, {
          organizations: current.organizations,
          promise: null,
          updatedAt: current.updatedAt,
        });
      }
      throw error;
    });

  organizationsByAccountKey.set(normalizedAccountKey, {
    organizations: cached?.organizations ?? [],
    promise,
    updatedAt: cached?.updatedAt ?? 0,
  });
  return promise;
}
