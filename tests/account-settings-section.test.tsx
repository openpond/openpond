import { describe, expect, test } from "bun:test";
import { createElement, type FormEvent, type SetStateAction } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { AccountState, BootstrapPayload } from "@openpond/contracts";

import { AccountEndpointDialog } from "../apps/web/src/components/settings/AccountEndpointDialog";
import { AccountSettingsSection } from "../apps/web/src/components/settings/AccountSettingsSection";

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
    balanceLabel: "$0.00",
    balance: null,
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

function renderAccountSettings(account: AccountState): string {
  return renderToStaticMarkup(
    createElement(AccountSettingsSection, {
      payload: payload(account),
      connection: null,
      apiKey: "",
      saving: false,
      refreshingAccounts: false,
      setApiKey: (_value: SetStateAction<string>) => undefined,
      saveAccount: async (_event: FormEvent<HTMLFormElement>) => undefined,
      saveEnvironmentAccount: async () => undefined,
      refreshAccounts: async () => undefined,
      switchAccount: async () => undefined,
      onPayload: () => undefined,
      onError: () => undefined,
    }),
  );
}

describe("AccountSettingsSection", () => {
  test("renders a first-run sign-in state for signed-out users", () => {
    const html = renderAccountSettings(accountState());

    expect(html).toContain("No account connected");
    expect(html).toContain("not signed in");
    expect(html).toContain("Sign in to OpenPond");
    expect(html).toContain("Connect this app to your OpenPond account");
    expect(html).toContain("Cloud projects, hosted agents, wallet, and team defaults are disabled until you sign in.");
    expect(html).toContain("https://openpond.ai/settings/api-keys");
    expect(html).toContain(">Create key<");
    expect(html).toContain("Environment");
    expect(html).toContain('aria-pressed="false"');
    expect(html).toContain(">Sign in<");
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
      }),
    );

    expect(html).toContain("Ada Lovelace");
    expect(html).toContain("OpenPond accounts");
    expect(html).toContain("Environment");
    expect(html).toContain("Add or update account");
    expect(html).toContain(">Save account<");
    expect(html).not.toContain("Connect this app to your OpenPond account");
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
      }),
    );

    expect(html).toContain("QA User");
    expect(html).toContain("Environment");
    expect(html).not.toContain(">qa<");
    expect(html).not.toContain("https://qa.openpond.example");
    expect(html).not.toContain("https://api.qa.openpond.example");
  });

  test("renders the environment connect dialog with api key and account endpoints", () => {
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
      }),
    );

    expect(html).toContain("Environment account");
    expect(html).toContain("API key");
    expect(html).toContain('value="opk_test"');
    expect(html).toContain('value="https://qa.openpond.example"');
    expect(html).toContain('value="https://api.qa.openpond.example"');
    expect(html).toContain("Connect account");
  });

  test("keeps the endpoint update dialog focused on endpoints only", () => {
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
      }),
    );

    expect(html).toContain("Environment endpoints");
    expect(html).toContain("Base URL");
    expect(html).toContain("API base URL");
    expect(html).toContain("Update account");
    expect(html).not.toContain("API key");
  });
});
