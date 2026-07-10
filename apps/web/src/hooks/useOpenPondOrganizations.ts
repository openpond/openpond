import { useCallback, useSyncExternalStore } from "react";

import {
  readOpenPondOrganizationsFromMemory,
  subscribeOpenPondOrganizations,
} from "../lib/openpond-organization-memory";
import type { OpenPondOrganization } from "../lib/organization-types";

const EMPTY_ORGANIZATIONS: OpenPondOrganization[] = [];

export function useOpenPondOrganizations(
  accountKey: string | null,
): OpenPondOrganization[] {
  const subscribe = useCallback(
    (listener: () => void) => subscribeOpenPondOrganizations(accountKey, listener),
    [accountKey],
  );
  const getSnapshot = useCallback(
    () => readOpenPondOrganizationsFromMemory(accountKey) ?? EMPTY_ORGANIZATIONS,
    [accountKey],
  );
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}
