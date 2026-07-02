import type { Dispatch, FormEvent, SetStateAction } from "react";
import { useEffect, useMemo, useState } from "react";
import type { BootstrapPayload } from "@openpond/contracts";
import { Plus, RefreshCw } from "../icons";
import { api, type ClientConnection } from "../../api";
import { DropdownSelect } from "../DropdownSelect";
import { AccountAvatar, AccountStateBadge } from "../account/AccountBadges";
import type { DropdownOption } from "../../lib/app-models";
import { normalizeOpenPondOrganization } from "../../lib/cloud-project-utils";
import {
  openPondOrganizationRoleLabel,
  type OpenPondOrganization,
} from "../../lib/organization-types";
import {
  openPondOrganizationCacheKey,
  preloadOpenPondOrganizations,
  readOpenPondOrganizationsFromMemory,
} from "../../lib/openpond-organization-memory";
import { preloadSandboxAgents } from "../../lib/sandbox-agent-memory";

type AccountSettingsSectionProps = {
  payload: BootstrapPayload | null;
  connection: ClientConnection | null;
  apiKey: string;
  saving: boolean;
  refreshingAccounts: boolean;
  setApiKey: Dispatch<SetStateAction<string>>;
  saveAccount: (event: FormEvent<HTMLFormElement>) => Promise<void>;
  refreshAccounts: () => Promise<void>;
  switchAccount: (handleValue: string, baseUrlValue?: string | null) => Promise<void>;
  onPayload: (payload: BootstrapPayload) => void;
  onError: (message: string | null) => void;
  onToast?: (message: string, tone?: "success" | "error" | "info") => void;
};

export function AccountSettingsSection({
  payload,
  connection,
  apiKey,
  saving,
  refreshingAccounts,
  setApiKey,
  saveAccount,
  refreshAccounts,
  switchAccount,
  onPayload,
  onError,
  onToast,
}: AccountSettingsSectionProps) {
  const account = payload?.account;
  const accountEmail = account?.email?.trim() || null;
  const accounts = account?.accounts ?? [];
  const [organizations, setOrganizations] = useState<OpenPondOrganization[]>([]);
  const [organizationsLoading, setOrganizationsLoading] = useState(false);
  const [organizationsError, setOrganizationsError] = useState<string | null>(null);
  const [savingDefaultTeamId, setSavingDefaultTeamId] = useState<string | null>(null);
  const [pendingDefaultTeamId, setPendingDefaultTeamId] = useState<string | null>(null);
  const activeCandidate = accounts.find((candidate) => candidate.isActive) ?? accounts[0] ?? null;
  const defaultTeamId = payload?.preferences.defaultTeamId?.trim() || null;
  const visibleDefaultTeamId = pendingDefaultTeamId ?? defaultTeamId;
  const organizationCacheKey = openPondOrganizationCacheKey(account);
  const accountRefreshKey = payload?.accountMeta.asOf ?? "";
  const activeLabel = firstPresentText(
    activeCandidate?.displayLabel,
    activeCandidate?.handle,
    account?.label,
    account?.activeProfile?.handle,
    "Signed out",
  );
  const showAccountList = accounts.length !== 1;
  const activeOrganizations = useMemo(
    () => organizations.filter((organization) => organization.status === "active"),
    [organizations],
  );
  const persistedDefaultOrganization = useMemo(
    () =>
      visibleDefaultTeamId
        ? activeOrganizations.find((organization) => organization.teamId === visibleDefaultTeamId) ?? null
        : null,
    [activeOrganizations, visibleDefaultTeamId],
  );
  const selectedDefaultOrganization = persistedDefaultOrganization ?? activeOrganizations[0] ?? null;
  const selectedDefaultTeamId = selectedDefaultOrganization?.teamId ?? "";
  const teamOptions = useMemo<DropdownOption[]>(
    () => {
      return activeOrganizations.map((organization) => ({
        value: organization.teamId,
        label: firstPresentText(organization.displayName, organization.name, organization.slug, "Team"),
        description: openPondOrganizationRoleLabel(organization.role),
      }));
    },
    [activeOrganizations],
  );
  const teamDropdownValue = selectedDefaultTeamId || teamOptions[0]?.value || "";
  const showTeamControl = teamOptions.length > 0;
  const teamDropdownDisabled =
    !connection ||
    Boolean(savingDefaultTeamId) ||
    Boolean(organizationsError) ||
    activeOrganizations.length === 0;

  useEffect(() => {
    if (!connection || !organizationCacheKey) {
      setOrganizations([]);
      setOrganizationsError(null);
      setOrganizationsLoading(false);
      return;
    }
    let cancelled = false;
    const cachedOrganizations = readOpenPondOrganizationsFromMemory(organizationCacheKey);
    if (cachedOrganizations) {
      setOrganizations(cachedOrganizations);
      setOrganizationsLoading(false);
    } else {
      setOrganizations([]);
      setOrganizationsLoading(true);
    }
    setOrganizationsError(null);
    preloadOpenPondOrganizations({
      accountKey: organizationCacheKey,
      force: Boolean(accountRefreshKey),
      fetchOrganizations: async () => {
        const payload = await api.organizations(connection);
        return payload.organizations
          .map(normalizeOpenPondOrganization)
          .filter((organization): organization is OpenPondOrganization => Boolean(organization))
          .filter((organization) => organization.status === "active");
      },
    })
      .then((nextOrganizations) => {
        if (cancelled) return;
        setOrganizations(nextOrganizations);
      })
      .catch((caught) => {
        if (cancelled) return;
        if (!cachedOrganizations) setOrganizations([]);
        setOrganizationsError(caught instanceof Error ? caught.message : String(caught));
      })
      .finally(() => {
        if (!cancelled) setOrganizationsLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [accountRefreshKey, connection, organizationCacheKey]);

  useEffect(() => {
    if (pendingDefaultTeamId && defaultTeamId === pendingDefaultTeamId) {
      setPendingDefaultTeamId(null);
    }
  }, [defaultTeamId, pendingDefaultTeamId]);

  async function setDefaultTeamId(teamId: string, options: { notify: boolean } = { notify: true }) {
    const organization = activeOrganizations.find((candidate) => candidate.teamId === teamId) ?? null;
    if (
      !connection ||
      !organization ||
      savingDefaultTeamId ||
      (pendingDefaultTeamId ?? defaultTeamId) === organization.teamId
    )
      return;
    setPendingDefaultTeamId(organization.teamId);
    setSavingDefaultTeamId(organization.teamId);
    onError(null);
    void preloadSandboxAgents({
      teamId: organization.teamId,
      force: true,
      fetchAgents: async (nextTeamId) => {
        const agentsPayload = await api.listSandboxAgents(connection, { teamId: nextTeamId });
        return agentsPayload.agents;
      },
    }).catch(() => undefined);
    try {
      onPayload(
        await api.savePreferences(connection, {
          defaultTeamId: organization.teamId,
        })
      );
      if (options.notify) onToast?.("Default team updated", "success");
    } catch (caught) {
      setPendingDefaultTeamId(null);
      onError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setSavingDefaultTeamId(null);
    }
  }

  return (
  <section className="account-settings">
    <div className="account-settings-title">
      <h1>Account</h1>
      <button
        className="settings-icon-button ghost"
        disabled={!connection || saving || refreshingAccounts}
        title="Full OpenPond refresh"
        aria-label="Full OpenPond refresh"
        type="button"
        onClick={() => void refreshAccounts()}
      >
        <RefreshCw size={15} className={refreshingAccounts ? "settings-spin" : undefined} />
      </button>
    </div>
    <div className="account-summary">
      <div className="account-summary-main">
        <AccountAvatar handle={activeLabel} image={account?.avatarUrl ?? activeCandidate?.avatarUrl ?? null} />
        <div>
          <span>Active account</span>
          <strong>{activeLabel}</strong>
          <div className="account-summary-meta">
            <small className={accountEmail ? "private-account-email" : undefined} tabIndex={accountEmail ? 0 : undefined}>
              {accountEmail ?? "Production"}
            </small>
            {showTeamControl ? (
            <DropdownSelect
              className="account-team-dropdown"
              compact
              disabled={teamDropdownDisabled}
              label="Default team"
              options={teamOptions}
              value={teamDropdownValue}
              onChange={(teamId) => void setDefaultTeamId(teamId)}
            />
            ) : null}
          </div>
        </div>
      </div>
      <div className="account-summary-actions">
        <AccountStateBadge state={account?.state ?? "loading"} />
      </div>
    </div>

    <form className="account-login-form" onSubmit={(event) => void saveAccount(event)}>
      <div className="account-list-heading">
        <span>Add or update account</span>
        <small>Saved to OpenPond CLI config</small>
      </div>
      <div className="account-form-grid">
        <label>
          <span>API key</span>
          <input
            value={apiKey}
            onChange={(event) => setApiKey(event.target.value)}
            placeholder="opk_..."
            type="password"
          />
        </label>
      </div>
      <button className="settings-primary" disabled={saving || !apiKey.trim()}>
        <Plus size={15} />
        <span>{saving ? "Saving" : "Save account"}</span>
      </button>
    </form>

    {showAccountList ? (
    <div className="account-list">
      <div className="account-list-heading">
        <span>OpenPond accounts</span>
        <small>{accounts.length} account{accounts.length === 1 ? "" : "s"}</small>
      </div>
      {accounts.map((candidate) => {
        const candidateHandle = candidate.handle?.trim() || "";
        const candidateLabel = firstPresentText(candidate.displayLabel, candidate.handle, "Unknown account");
        const candidateEmail = candidate.email?.trim() || null;
        return (
          <div className="account-row" key={`${candidateHandle || candidateLabel}-${candidate.baseUrl ?? "default"}`}>
            <AccountAvatar handle={candidateLabel} image={candidate.avatarUrl ?? null} />
            <div className="account-details">
              <strong>{candidateLabel}</strong>
              {candidateEmail ? (
                <span className="private-account-email" tabIndex={0}>
                  {candidateEmail}
                </span>
              ) : null}
              <span>{candidate.environment ?? "production"}</span>
            </div>
            <div className="account-row-actions">
              {candidate.isActive ? (
                <span className="active-pill">Active</span>
              ) : (
                <button
                  className="inline-action"
                  disabled={saving || !candidateHandle}
                  type="button"
                  onClick={() => void switchAccount(candidateHandle, candidate.baseUrl)}
                >
                  Use
                </button>
              )}
            </div>
            <AccountStateBadge state={candidate.authHealth} />
          </div>
        );
      })}
      {accounts.length === 0 && (
        <div className="empty-account-list">
          <strong>No accounts found</strong>
          <span>Add an API key above to create the first OpenPond account.</span>
        </div>
      )}
    </div>
    ) : null}

    {account?.products && account.products.length > 0 && (
      <div className="account-list">
        <div className="account-list-heading">
          <span>Products</span>
          <small>{account.products.length} active</small>
        </div>
        {account.products.map((product) => (
          <div className="product-row" key={product.id}>
            <div>
              <strong>{product.name}</strong>
              <span>{product.type}</span>
            </div>
            <AccountStateBadge state={product.status} />
          </div>
        ))}
      </div>
    )}

    <div className="settings-footnote">
      <span>{payload?.server.runtimeVersion ?? "Runtime loading"}</span>
      <strong>{connection?.serverUrl ?? "loading"}</strong>
    </div>
    {payload?.appsMeta.lastRefreshError && (
      <div className="settings-footnote warning">
        <span>Last refresh error</span>
        <strong>{payload.appsMeta.lastRefreshError}</strong>
      </div>
    )}
  </section>
  );
}

function firstPresentText(...values: Array<string | null | undefined>): string {
  for (const value of values) {
    const text = value?.trim();
    if (text) return text;
  }
  return "";
}
