import type { Dispatch, FormEvent, SetStateAction } from "react";
import { useEffect, useMemo, useState } from "react";
import type { BootstrapPayload } from "@openpond/contracts";
import { ExternalLink, KeyRound, Plus, RefreshCw } from "../icons";
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

const OPENPOND_API_KEYS_URL = "https://openpond.ai/settings/api-keys";

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
  const accountState = account?.state ?? "loading";
  const signedIn = accountState === "signed_in";
  const signedOut = accountState === "signed_out";
  const authError = accountState === "auth_error";
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
  const activeEnvironment = firstPresentText(account?.environment, activeCandidate?.environment);
  const activeLabel = signedIn
    ? firstPresentText(
        activeCandidate?.displayLabel,
        activeCandidate?.handle,
        account?.label,
        account?.activeProfile?.handle,
        "Signed in",
      )
    : authError
      ? "Account needs attention"
      : signedOut
        ? "No account connected"
        : "Loading account";
  const activeMetaLabel = signedIn
    ? accountEmail ?? accountEnvironmentLabel(activeEnvironment)
    : authError
      ? account?.error ?? "Reconnect this account to restore OpenPond cloud features."
      : signedOut
        ? "Cloud projects, hosted agents, wallet, and team defaults are disabled until you sign in."
        : "Checking account status.";
  const showAccountList = accounts.length > 1;
  const formTitle = signedOut ? "Sign in to OpenPond" : authError ? "Reconnect account" : "Add or update account";
  const formDescription = signedOut
    ? "Paste an OpenPond API key to connect this desktop app."
    : authError
      ? "Paste a fresh OpenPond API key for the active account."
      : "Saved to OpenPond CLI config.";
  const submitLabel = signedOut ? "Sign in" : authError ? "Reconnect" : "Save account";
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
        <AccountAvatar handle={activeLabel} image={signedIn ? account?.avatarUrl ?? activeCandidate?.avatarUrl ?? null : null} />
        <div>
          <span>Active account</span>
          <strong>{activeLabel}</strong>
          <div className="account-summary-meta">
            <small
              className={
                signedIn && accountEmail
                  ? "private-account-email"
                  : signedIn
                    ? undefined
                    : "account-summary-copy"
              }
              tabIndex={signedIn && accountEmail ? 0 : undefined}
            >
              {activeMetaLabel}
            </small>
            {signedIn && showTeamControl ? (
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
        <AccountStateBadge state={accountState} label={signedOut ? "not signed in" : undefined} />
      </div>
    </div>

    <form className="account-login-form" onSubmit={(event) => void saveAccount(event)}>
      {(signedOut || authError) ? (
        <div className="account-signin-panel">
          <KeyRound size={18} />
          <div>
            <strong>{signedOut ? "Connect this app to your OpenPond account" : "Refresh the saved OpenPond credential"}</strong>
            <span>
              {signedOut
                ? "Local projects stay available without sign-in; cloud agents, wallet, teams, and hosted runs need an account."
                : "The saved credential could not authenticate. Replace it to resume cloud features."}
            </span>
          </div>
          <a
            className="settings-secondary account-api-key-link"
            href={OPENPOND_API_KEYS_URL}
            rel="noreferrer"
            target="_blank"
          >
            <ExternalLink size={14} />
            <span>Create key</span>
          </a>
        </div>
      ) : null}
      <div className="account-list-heading">
        <span>{formTitle}</span>
        <small>{formDescription}</small>
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
        <span>{saving ? "Saving" : submitLabel}</span>
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

function accountEnvironmentLabel(value: string): string {
  if (!value) return "Production";
  return value.slice(0, 1).toUpperCase() + value.slice(1);
}
