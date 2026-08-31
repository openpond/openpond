import { describe, expect, test } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { AccountState, BootstrapPayload } from "@openpond/contracts";

import {
  AccountEndpointDialog,
  accountEndpointConfigForMode,
  accountEndpointSelectorForMode,
} from "../apps/web/src/components/settings/AccountEndpointDialog";
import {
  AccountSettingsSection,
  conciseAccountError,
} from "../apps/web/src/components/settings/AccountSettingsSection";

const NOW = "2026-07-02T12:00:00.000Z";

function accountState(overrides: Partial<AccountState> = {}): AccountState {
  return {
    state: "signed_out",
    activeProfile: null,
    label: "Signed out",
    email: null,
    avatarUrl: null,
    environment: null,
    baseUrl: null,
    apiBaseUrl: "https://api.openpond.ai",
    chatApiBaseUrl: "https://opchat.openpond.ai",
    creditsLabel: null,
    profile: null,
    products: [],
    apiHealth: null,
    accounts: [],
    error: null,
    ...overrides,
  };
}

function payload(account: AccountState): BootstrapPayload {
  return {
    account,
    accountMeta: {
      asOf: NOW,
      refreshing: false,
      lastRefreshError: null,
      source: "fresh",
    },
    preferences: {
      defaultTeamId: null,
    },
    server: {
      id: "server",
      host: "127.0.0.1",
      port: 17874,
      startedAt: NOW,
      storePath: "/tmp/openpond.sqlite",
      version: "0.0.1",
      runtimeVersion: "openpond-code@0.0.1",
    },
    appsMeta: {
      asOf: null,
      refreshing: false,
      lastRefreshError: null,
      source: "empty",
    },
    apps: [],
    appsError: null,
    sidebarAppPreferences: {},
    sessions: [],
    events: [],
    approvals: [],
  } as unknown as BootstrapPayload;
}

function renderAccountSettings(
  account: AccountState,
  profile: BootstrapPayload["profile"] | null = null
): string {
  const bootstrap = payload(account);
  bootstrap.profile = profile ?? bootstrap.profile;
  return renderToStaticMarkup(
    createElement(AccountSettingsSection, {
      payload: bootstrap,
      connection: null,
      saving: false,
      refreshingAccounts: false,
      saveAccount: async () => undefined,
      refreshAccounts: async () => undefined,
      switchAccount: async () => undefined,
      removeAccount: async () => true,
      onPayload: () => undefined,
      onError: () => undefined,
    })
  );
}

describe("AccountSettingsSection", () => {
  test("derives a new account identity when connecting another key to the same environment", () => {
    const activeAccount = {
      handle: "qa-user-3",
      baseUrl: "https://openpond.ai",
    };

    expect(accountEndpointSelectorForMode("connect", activeAccount)).toEqual({
      handle: undefined,
      currentBaseUrl: null,
    });
    expect(accountEndpointSelectorForMode("update", activeAccount)).toEqual({
      handle: "qa-user-3",
      currentBaseUrl: "https://openpond.ai",
    });
  });

  test("preserves an existing account's endpoint configuration when updating it", () => {
    const stagingAccount = {
      handle: "qa-user-3",
      baseUrl: "https://staging.openpond.ai",
      apiBaseUrl: "https://staging-api.openpond.ai",
      chatApiBaseUrl: "https://staging-api.openpond.ai/opchat/v1",
      environment: "staging",
    };

    expect(accountEndpointConfigForMode("update", stagingAccount)).toEqual({
      baseUrl: "https://staging.openpond.ai",
      apiBaseUrl: "https://staging-api.openpond.ai",
      chatApiBaseUrl: "https://staging-api.openpond.ai/opchat/v1",
      environment: "staging",
    });
    expect(accountEndpointConfigForMode("connect", stagingAccount)).toEqual({
      baseUrl: "https://openpond.ai",
      apiBaseUrl: "https://api.openpond.ai",
      environment: "production",
    });
  });

  test("renders a first-run sign-in state for signed-out users", () => {
    const html = renderAccountSettings(accountState());

    expect(html).toContain("No account connected");
    expect(html).toContain("not signed in");
    expect(html).toContain(
      "Cloud projects, hosted agents, and team defaults are disabled until you sign in."
    );
    expect(html).toContain(">Add account<");
    expect(html).not.toContain("account-login-form");
    expect(html).not.toContain("Configure environment account");
    expect(html).not.toContain("No accounts found");
    expect(html).not.toContain(">Production<");
    expect(html).not.toContain(">Staging<");
  });

  test("keeps the update-account flow for signed-in users", () => {
    const html = renderAccountSettings(
      accountState({
        state: "signed_in",
        activeProfile: { handle: "ada", baseUrl: "https://openpond.ai" },
        label: "Ada Lovelace",
        email: "ada@example.com",
        environment: "production",
        accounts: [
          {
            handle: "ada",
            baseUrl: "https://openpond.ai",
            apiBaseUrl: "https://api.openpond.ai",
            chatApiBaseUrl: "https://opchat.openpond.ai",
            environment: "production",
            isActive: true,
            authHealth: "signed_in",
            displayLabel: "Ada Lovelace",
            email: "ada@example.com",
            avatarUrl: null,
          },
        ],
      })
    );

    expect(html).toContain("Ada Lovelace");
    expect(html).toContain("OpenPond accounts");
    expect(html).toContain(">Add account<");
    expect(html).not.toContain("Add or update account");
    expect(html).not.toContain(">Save account<");
    expect(html).not.toContain("Connect this app to your OpenPond account");
  });

  test("shows one concise wrapped account error at the bottom", () => {
    const rawError = "Apps list failed: 401 protected deployment";
    const html = renderAccountSettings(
      accountState({
        state: "auth_error",
        activeProfile: {
          handle: "qa",
          baseUrl: "https://openpond.ai",
        },
        label: "qa",
        environment: "production",
        error: rawError,
      })
    );

    expect(html).not.toContain("Refresh the saved OpenPond credential");
    expect(html).not.toContain(
      "The saved credential could not authenticate."
    );
    expect(html).not.toContain(
      "Paste a fresh OpenPond API key for the active account."
    );
    expect(html).toContain("account-error-footnote");
    expect(html).toContain("Restart and try again.");
    expect(html.indexOf("account-error-footnote")).toBeGreaterThan(
      html.indexOf("Runtime loading")
    );
  });

  test("caps unknown account errors", () => {
    expect(conciseAccountError("x".repeat(400))).toHaveLength(220);
  });

  test("offers removal for saved inactive accounts but protects the active account", () => {
    const html = renderAccountSettings(
      accountState({
        state: "signed_in",
        activeProfile: {
          handle: "active",
          baseUrl: "https://openpond.ai",
        },
        label: "Active user",
        environment: "production",
        accounts: [
          {
            handle: "active",
            baseUrl: "https://openpond.ai",
            apiBaseUrl: "https://api.openpond.ai",
            chatApiBaseUrl: null,
            environment: "production",
            isActive: true,
            authHealth: "signed_in",
            displayLabel: "Active user",
            email: "active@example.com",
            avatarUrl: null,
          },
          {
            handle: "stale-qa",
            baseUrl: "https://openpond.ai",
            apiBaseUrl: "https://api.openpond.ai",
            chatApiBaseUrl: null,
            environment: "production",
            isActive: false,
            authHealth: "auth_error",
            displayLabel: "Stale QA",
            email: "stale@example.com",
            avatarUrl: null,
          },
        ],
      })
    );

    expect(html).toContain(
      "Switch to another account before removing the active account."
    );
    expect(html).toContain('aria-label="Remove Stale QA"');
    expect(html).toContain(
      'aria-label="Configure Stale QA environment"'
    );
    expect(html).not.toContain('aria-label="Remove Active user"');
    expect(html).not.toContain(">Remove<");

    const staleRow = html.slice(html.indexOf("Stale QA"));
    expect(staleRow.indexOf("account-state auth_error")).toBeLessThan(
      staleRow.indexOf("account-endpoint-action")
    );
  });

  test("labels account refresh as a team data refresh", () => {
    const html = renderAccountSettings(accountState());

    expect(html).toContain('aria-label="Refresh accounts and team data"');
  });

  test("keeps the account summary focused on account and team selection", () => {
    const html = renderAccountSettings(accountState());

    expect(html).not.toContain("account-profile-status");
    expect(html).not.toContain("No local Profile loaded");
  });

  test("does not render endpoint URLs in the account row", () => {
    const html = renderAccountSettings(
      accountState({
        state: "signed_in",
        activeProfile: { handle: "qa", baseUrl: "https://qa.openpond.example" },
        label: "QA User",
        environment: "qa",
        accounts: [
          {
            handle: "qa",
            baseUrl: "https://qa.openpond.example",
            apiBaseUrl: "https://api.qa.openpond.example",
            chatApiBaseUrl: null,
            environment: "qa",
            isActive: true,
            authHealth: "signed_in",
            displayLabel: "QA User",
            email: null,
            avatarUrl: null,
          },
        ],
      })
    );

    expect(html).toContain("QA User");
    expect(html).toContain("Environment");
    expect(html).not.toContain(">qa<");
    expect(html).not.toContain("https://qa.openpond.example");
    expect(html).not.toContain("https://api.qa.openpond.example");
  });

  test("uses production endpoints when adding an account", () => {
    const html = renderToStaticMarkup(
      createElement(AccountEndpointDialog, {
        account: {
          handle: "qa",
          baseUrl: "https://qa.openpond.example",
          apiBaseUrl: "https://api.qa.openpond.example",
          chatApiBaseUrl: null,
          environment: "qa",
          isActive: true,
          authHealth: "auth_error",
          displayLabel: "QA User",
          email: null,
          avatarUrl: null,
        },
        busy: false,
        initialApiKey: "opk_test",
        mode: "connect",
        onClose: () => undefined,
        onSave: async () => undefined,
      })
    );

    expect(html).toContain("Add account");
    expect(html).toContain("API key");
    expect(html).toContain('value="opk_test"');
    expect(html).not.toContain("Advanced");
    expect(html).not.toContain("Base URL");
    expect(html).not.toContain("API base URL");
    expect(html).not.toContain("https://qa.openpond.example");
    expect(html).not.toContain("https://api.qa.openpond.example");
    expect(html).toContain("Connect account");
  });

  test("does not expose endpoint fields when updating an account", () => {
    const html = renderToStaticMarkup(
      createElement(AccountEndpointDialog, {
        account: {
          handle: "qa",
          baseUrl: "https://qa.openpond.example",
          apiBaseUrl: "https://api.qa.openpond.example",
          chatApiBaseUrl: null,
          environment: "qa",
          isActive: true,
          authHealth: "signed_in",
          displayLabel: "QA User",
          email: null,
          avatarUrl: null,
        },
        busy: false,
        onClose: () => undefined,
        onSave: async () => undefined,
      })
    );

    expect(html).toContain("Account environment");
    expect(html).toContain("Update account");
    expect(html).not.toContain("API key");
    expect(html).not.toContain("Base URL");
    expect(html).not.toContain("API base URL");
    expect(html).not.toContain("https://qa.openpond.example");
    expect(html).not.toContain("https://api.qa.openpond.example");
  });
});
