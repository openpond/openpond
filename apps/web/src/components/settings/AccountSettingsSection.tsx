import { useState } from "react";
import type { AccountState, BootstrapPayload } from "@openpond/contracts";
import { Plus, RefreshCw, Trash2 } from "../icons";
import { api, type ClientConnection } from "../../api";
import { AccountAvatar, AccountStateBadge } from "../account/AccountBadges";
import { ConfirmDialog, useConfirmDialog } from "../common/ConfirmDialog";
import {
  AccountEndpointDialog,
  type AccountEndpointUpdate,
} from "./AccountEndpointDialog";
import type { SaveOpenPondAccountInput } from "./useAccountSettings";

type AccountSettingsSectionProps = {
  payload: BootstrapPayload | null;
  connection: ClientConnection | null;
  saving: boolean;
  refreshingAccounts: boolean;
  saveAccount: (input: SaveOpenPondAccountInput) => Promise<void>;
  refreshAccounts: () => Promise<void>;
  switchAccount: (
    handleValue: string,
    baseUrlValue?: string | null
  ) => Promise<void>;
  removeAccount: (
    handleValue: string,
    baseUrlValue?: string | null
  ) => Promise<boolean>;
  onPayload: (payload: BootstrapPayload) => void;
  onError: (message: string | null) => void;
  onToast?: (message: string, tone?: "success" | "error" | "info") => void;
};

type AccountRow = AccountState["accounts"][number];
const ACCOUNT_SCOPE_CHANGE_BODY =
  "Changing the active OpenPond account rechecks its active workspace, cloud projects, hosted agents, and profile sync. Local projects stay on this machine; projects uploaded from another account will need to be synced again for this account.";

export function AccountSettingsSection({
  payload,
  connection,
  saving,
  refreshingAccounts,
  saveAccount,
  refreshAccounts,
  switchAccount,
  removeAccount,
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
  const [endpointDialogAccount, setEndpointDialogAccount] =
    useState<AccountRow | null>(null);
  const [addAccountDialogOpen, setAddAccountDialogOpen] =
    useState(false);
  const [savingEndpointKey, setSavingEndpointKey] = useState<string | null>(
    null
  );
  const {
    confirmAction: confirmAccountAction,
    confirmDialog: accountConfirmDialog,
    resolveConfirmDialog: resolveAccountConfirmDialog,
  } = useConfirmDialog();
  const activeCandidate =
    accounts.find((candidate) => candidate.isActive) ?? accounts[0] ?? null;
  const activeEnvironment = firstPresentText(
    account?.environment,
    activeCandidate?.environment
  );
  const activeLabel = signedIn
    ? firstPresentText(
        activeCandidate?.displayLabel,
        activeCandidate?.handle,
        account?.label,
        account?.activeProfile?.handle,
        "Signed in"
      )
    : authError
    ? "Account needs attention"
    : signedOut
    ? "No account connected"
    : "Loading account";
  const activeMetaLabel = signedIn
    ? accountEmail ?? accountEnvironmentLabel(activeEnvironment)
    : authError
    ? "Not connected"
    : signedOut
    ? "Workspace-scoped cloud projects and hosted agents are disabled until you sign in."
    : "Checking account status.";
  const showAccountList = accounts.length > 0;
  const activeWorkspace = account?.workspaces
    ? account.workspaces.activeWorkspace.type === "team"
      ? account.workspaces.team
      : account.workspaces.personal
    : null;
  const accountError = authError
    ? conciseAccountError(account?.error)
    : null;
  const endpointDialogKey = endpointDialogAccount
    ? accountListKey(endpointDialogAccount)
    : null;
  const endpointDialogBusy = Boolean(
    endpointDialogKey && savingEndpointKey === endpointDialogKey
  );
  const shouldWarnAccountScopeChange = signedIn || authError;

  async function confirmAccountScopeChange(
    confirmLabel = "Continue"
  ): Promise<boolean> {
    if (!shouldWarnAccountScopeChange) return true;
    return confirmAccountAction({
      title: "Change active OpenPond account?",
      body: ACCOUNT_SCOPE_CHANGE_BODY,
      confirmLabel,
      cancelLabel: "Cancel",
    });
  }

  async function saveAddedAccount(input: AccountEndpointUpdate) {
    if (!(await confirmAccountScopeChange("Save account"))) return;
    await saveAccount({
      apiKey: input.apiKey ?? "",
      handle: input.handle,
      baseUrl: input.baseUrl,
      apiBaseUrl: input.apiBaseUrl,
      environment: input.environment,
    });
    setAddAccountDialogOpen(false);
  }

  async function updateAccountEndpoints(input: AccountEndpointUpdate) {
    if (!connection || !endpointDialogAccount)
      throw new Error("OpenPond server connection is not ready.");
    if (
      endpointDialogAccount.isActive &&
      !(await confirmAccountScopeChange("Save endpoints"))
    )
      return;
    const endpointKey = accountListKey(endpointDialogAccount);
    setSavingEndpointKey(endpointKey);
    onError(null);
    try {
      const nextPayload = await api.updateOpenPondAccountConfig(connection, {
        handle: input.handle ?? endpointDialogAccount.handle,
        currentBaseUrl: input.currentBaseUrl,
        baseUrl: input.baseUrl,
        apiBaseUrl: input.apiBaseUrl,
        chatApiBaseUrl: null,
        environment: customEnvironmentName(input.environment),
        setActive: endpointDialogAccount.isActive,
      });
      onPayload(nextPayload);
      onToast?.("Account endpoints updated", "success");
      setEndpointDialogAccount(null);
    } catch (caught) {
      onError(caught instanceof Error ? caught.message : String(caught));
      throw caught;
    } finally {
      setSavingEndpointKey(null);
    }
  }

  async function useSavedAccount(candidate: AccountRow) {
    const candidateHandle = candidate.handle?.trim() || "";
    if (!candidateHandle) return;
    if (!(await confirmAccountScopeChange("Switch account"))) return;
    await switchAccount(candidateHandle, candidate.baseUrl);
  }

  async function removeSavedAccount(candidate: AccountRow) {
    const candidateHandle = candidate.handle?.trim() || "";
    if (!candidateHandle || candidate.isActive) return;
    const candidateLabel = firstPresentText(
      candidate.displayLabel,
      candidate.email,
      candidate.handle,
      "this account"
    );
    const confirmed = await confirmAccountAction({
      title: "Remove saved account?",
      body: `Remove ${candidateLabel} from this device? Its saved credential and endpoint settings will be deleted. This does not delete any OpenPond cloud data.`,
      confirmLabel: "Remove account",
      cancelLabel: "Cancel",
      tone: "danger",
    });
    if (!confirmed) return;
    if (await removeAccount(candidateHandle, candidate.baseUrl)) {
      onToast?.("Account removed", "success");
    }
  }

  return (
    <section className="account-settings">
      <div className="account-settings-title">
        <h1>Account</h1>
        <div className="account-settings-title-actions">
          <button
            className="settings-secondary compact account-add-action"
            disabled={!connection || saving}
            type="button"
            onClick={() => setAddAccountDialogOpen(true)}
          >
            <Plus size={14} />
            <span>Add account</span>
          </button>
          <button
            className="settings-icon-button ghost"
            disabled={!connection || saving || refreshingAccounts}
            title="Refresh accounts and team data"
            aria-label="Refresh accounts and team data"
            type="button"
            onClick={() => void refreshAccounts()}
          >
            <RefreshCw
              size={15}
              className={refreshingAccounts ? "settings-spin" : undefined}
            />
          </button>
        </div>
      </div>
      <div className="account-summary">
        <div className="account-summary-main">
          <AccountAvatar
            handle={activeLabel}
            image={
              signedIn
                ? account?.avatarUrl ?? activeCandidate?.avatarUrl ?? null
                : null
            }
          />
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
            </div>
          </div>
        </div>
        <div className="account-summary-actions">
          <AccountStateBadge
            state={accountState}
            label={signedOut ? "not signed in" : undefined}
          />
        </div>
      </div>

      {showAccountList ? (
        <div className="account-list">
          <div className="account-list-heading">
            <span>OpenPond accounts</span>
            <small>
              {accounts.length} account{accounts.length === 1 ? "" : "s"}
            </small>
          </div>
          <p className="account-list-note">
            Switch to another account before removing the active account.
          </p>
          {accounts.map((candidate) => {
            const candidateHandle = candidate.handle?.trim() || "";
            const candidateLabel = firstPresentText(
              candidate.displayLabel,
              candidate.handle,
              "Unknown account"
            );
            const candidateEmail = candidate.email?.trim() || null;
            const candidateHasEnvironment = isCustomAccountEnvironment(
              candidate.environment
            );
            const candidateKey = accountListKey(candidate);
            return (
              <div className="account-row" key={candidateKey}>
                <AccountAvatar
                  handle={candidateLabel}
                  image={candidate.avatarUrl ?? null}
                />
                <div className="account-details">
                  <strong>{candidateLabel}</strong>
                  {candidateEmail ? (
                    <span className="private-account-email" tabIndex={0}>
                      {candidateEmail}
                    </span>
                  ) : null}
                  <span>
                    {accountEnvironmentLabel(
                      candidate.environment ?? "production"
                    )}
                  </span>
                </div>
                <div className="account-row-actions">
                  <AccountStateBadge state={candidate.authHealth} />
                  {candidate.isActive ? (
                    <span className="active-pill">Active</span>
                  ) : null}
                  <button
                    className={`account-env-toggle ${
                      candidateHasEnvironment ? "active" : ""
                    }`}
                    disabled={
                      !connection ||
                      saving ||
                      Boolean(savingEndpointKey) ||
                      !candidateHandle
                    }
                    type="button"
                    aria-label={`Configure ${candidateLabel} environment endpoints`}
                    aria-pressed={candidateHasEnvironment}
                    title="Configure environment endpoints"
                    onClick={() => setEndpointDialogAccount(candidate)}
                  >
                    <span
                      className="account-env-toggle-switch"
                      aria-hidden="true"
                    />
                  </button>
                  {!candidate.isActive ? (
                    <>
                      <button
                        className="inline-action"
                        disabled={saving || !candidateHandle}
                        type="button"
                        onClick={() => void useSavedAccount(candidate)}
                      >
                        Use
                      </button>
                      <button
                        className="inline-action danger account-remove-action"
                        disabled={saving || !candidateHandle}
                        type="button"
                        aria-label={`Remove ${candidateLabel}`}
                        title={`Remove ${candidateLabel}`}
                        onClick={() => void removeSavedAccount(candidate)}
                      >
                        <Trash2 size={13} />
                      </button>
                    </>
                  ) : null}
                </div>
              </div>
            );
          })}
        </div>
      ) : null}

      {activeWorkspace ? (
        <div className="account-list">
          <div className="account-list-heading">
            <span>Active workspace</span>
            <small>
              {activeWorkspace.type === "team" ? "Team" : "Personal"}
            </small>
          </div>
          <div className="product-row">
            <div>
              <strong>{activeWorkspace.displayName}</strong>
              <span>{workspacePlanLabel(activeWorkspace.planKey)}</span>
            </div>
            <AccountStateBadge state={activeWorkspace.accessState} />
          </div>
        </div>
      ) : null}

      <div className="settings-footnote">
        <span>{payload?.server.runtimeVersion ?? "Runtime loading"}</span>
        <strong>{connection?.serverUrl ?? "loading"}</strong>
      </div>
      {accountError ? (
        <div className="settings-footnote warning account-error-footnote">
          <span>Account error</span>
          <strong>{accountError}</strong>
        </div>
      ) : null}
      {endpointDialogAccount ? (
        <AccountEndpointDialog
          account={endpointDialogAccount}
          busy={endpointDialogBusy}
          onClose={() => {
            if (!endpointDialogBusy) setEndpointDialogAccount(null);
          }}
          onSave={updateAccountEndpoints}
        />
      ) : null}
      {addAccountDialogOpen ? (
        <AccountEndpointDialog
          busy={saving}
          mode="connect"
          onClose={() => {
            if (!saving) setAddAccountDialogOpen(false);
          }}
          onSave={saveAddedAccount}
        />
      ) : null}
      <ConfirmDialog
        state={accountConfirmDialog}
        onResolve={resolveAccountConfirmDialog}
      />
    </section>
  );
}

function accountListKey(account: AccountRow): string {
  return `${account.handle.trim().toLowerCase()}|${
    account.baseUrl ?? "default"
  }`;
}

function firstPresentText(...values: Array<string | null | undefined>): string {
  for (const value of values) {
    const text = value?.trim();
    if (text) return text;
  }
  return "";
}

export function conciseAccountError(
  value?: string | null
): string | null {
  const error = value?.trim();
  if (!error) return null;
  const normalized = error.toLowerCase();
  if (
    normalized.includes("protected deployment") ||
    normalized.includes("vercel_auth_enabled")
  ) {
    return "Staging is protected by Vercel. Restart OpenPond after signing in to Vercel, then try again.";
  }
  if (
    normalized.includes("unexpected token '<'") ||
    normalized.includes("<!doctype") ||
    normalized.includes("vercel.com/sso-api")
  ) {
    return "OpenPond received a web login page instead of account data. Restart after signing in to Vercel, then try again.";
  }
  if (
    normalized.includes("401") ||
    normalized.includes("unauthorized") ||
    normalized.includes("could not authenticate")
  ) {
    return "The API key could not authenticate. Check the key and account environment, then try again.";
  }
  return error.length > 220 ? `${error.slice(0, 217)}...` : error;
}

function accountEnvironmentLabel(value: string): string {
  const normalized = value.trim().toLowerCase();
  if (!normalized || normalized === "production") return "Production";
  return "Environment";
}

function customEnvironmentName(value?: string | null): string {
  const trimmed = value?.trim();
  if (!trimmed || trimmed.toLowerCase() === "production") return "custom";
  return trimmed;
}

function isCustomAccountEnvironment(value?: string | null): boolean {
  const normalized = value?.trim().toLowerCase();
  return Boolean(normalized && normalized !== "production");
}

function workspacePlanLabel(planKey: string): string {
  const normalized = planKey.trim();
  if (!normalized) return "Plan unavailable";
  return `${normalized.charAt(0).toUpperCase()}${normalized.slice(1)} plan`;
}
