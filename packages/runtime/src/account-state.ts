import type {
  ConfiguredProfile,
  OpenPondAccountBalanceResponse,
  OpenPondAccountProduct,
  OpenPondAccountResponse,
  OpenPondApiHealth,
} from "@openpond/cloud";
import type { AccountApiHealth, AccountBalance, AccountProduct, AccountProfile, AccountState } from "@openpond/contracts";
import type { RuntimeLocalAccount, RuntimeLocalConfig } from "./types.js";
import {
  normalizeActiveProfile,
  profileKey,
  profileAuthHealth,
  profileMatchesSelector,
  selectorBaseUrl,
  selectorFromAccount,
} from "./selectors.js";
import {
  DEFAULT_OPENPOND_WEB_BASE_URL,
  deriveEnvironment,
  normalizeBaseUrl,
  resolveHostedChatApiBaseUrl,
} from "./urls.js";

function normalizeHealth(health: OpenPondApiHealth | null, apiBaseUrl: string): AccountApiHealth | null {
  if (!health) return null;
  return {
    reachable: health.reachable,
    authenticated: health.authenticated,
    apiBase: health.apiBase || apiBaseUrl,
    latencyMs: health.latencyMs,
    status: health.status,
    service: health.service,
    checkedAt: health.checkedAt,
    error: health.error ?? null,
  };
}

function normalizeProfile(response: OpenPondAccountResponse | null): AccountProfile | null {
  const account = response?.account;
  if (!account) return null;
  return {
    id: account.id ?? null,
    email: account.email ?? null,
    name: account.name ?? null,
    handle: account.handle ?? null,
    image: account.image ?? null,
    timezone: account.timezone ?? null,
    isAdmin: account.isAdmin ?? null,
    isVerified: account.isVerified ?? null,
    dailyAgentAppId: account.dailyAgentAppId ?? null,
    dailyAgentDeploymentId: account.dailyAgentDeploymentId ?? null,
    credits: account.credits ?? null,
    turnkeyWalletAddress: account.turnkeyWalletAddress ?? null,
    turnkeyOperatingWalletAddress: account.turnkeyOperatingWalletAddress ?? null,
  };
}

function normalizeProducts(products: OpenPondAccountProduct[] | undefined): AccountProduct[] {
  return (products ?? []).map((product) => ({
    ...product,
    id: product.id || product.userProductId || product.openPondProductId || product.name,
    name: product.name,
    type: product.type,
    status: product.status,
    isActive: product.isActive ?? null,
    price: product.price ?? null,
    currency: product.currency ?? null,
    credits: product.credits ?? null,
  }));
}

function normalizeBalance(
  response: OpenPondAccountBalanceResponse | null | undefined,
  error?: string | null
): AccountBalance | null {
  if (!response) return null;
  return {
    balanceKind: response.balanceKind,
    balanceUsd: response.balanceUsd ?? null,
    balanceUsdCents: response.balanceUsdCents ?? null,
    currency: response.currency,
    asOf: response.asOf,
    stale: response.stale ?? Boolean(error),
    error: error ?? null,
    breakdown: (response.breakdown ?? []).map((item: OpenPondAccountBalanceResponse["breakdown"][number]) => ({
      wallet: item.wallet,
      chain: item.chain,
      chainId: item.chainId ?? null,
      asset: item.asset,
      amount: item.amount ?? null,
      usdValue: item.usdValue ?? null,
    })),
  };
}

function isEmptyDefaultProfile(profile: ConfiguredProfile): boolean {
  return (
    profile.handle.trim().toLowerCase() === "default" &&
    !normalizeBaseUrl(profile.baseUrl) &&
    !profile.hasApiKey &&
    !profile.hasSessionToken
  );
}

export function toAccountState(input: {
  config: RuntimeLocalConfig;
  profiles: ConfiguredProfile[];
  account: RuntimeLocalAccount | null;
  token: string | null;
  apiBaseUrl: string;
  accountResponse?: OpenPondAccountResponse | null;
  balanceResponse?: OpenPondAccountBalanceResponse | null;
  accountProfiles?: Record<string, { response?: OpenPondAccountResponse | null; authFailed?: boolean }>;
  health?: OpenPondApiHealth | null;
  authFailed?: boolean;
  error?: string | null;
  balanceError?: string | null;
}): AccountState {
  const {
    config,
    profiles,
    account,
    token,
    apiBaseUrl,
    accountResponse,
    balanceResponse,
    accountProfiles,
    health,
    authFailed,
    error,
    balanceError,
  } = input;
  const chatApiBaseUrl = resolveHostedChatApiBaseUrl(account, config, apiBaseUrl);
  const profile = normalizeProfile(accountResponse ?? null);
  const balance = normalizeBalance(balanceResponse, balanceError);
  const configActiveProfile = normalizeActiveProfile(config.activeProfile);
  const accountSelector = account ? selectorFromAccount(account) : null;
  const activeSelector = accountSelector ?? configActiveProfile;
  const displayHandle = profile?.handle || account?.handle || activeSelector?.handle || null;
  const activeProfileRow =
    (activeSelector ? profiles.find((candidate) => profileMatchesSelector(candidate, activeSelector)) : null) ??
    profiles.find((candidate) => candidate.isActive) ??
    null;
  const healthState = authFailed ? "auth_error" : token ? "signed_in" : "signed_out";
  const label = profile?.name || profile?.handle || profile?.email || displayHandle || "Signed out";
  const baseUrl = normalizeBaseUrl(activeProfileRow?.baseUrl || account?.baseUrl || DEFAULT_OPENPOND_WEB_BASE_URL);
  const environment = deriveEnvironment(activeProfileRow?.environment || account?.environment);
  const activeProfile =
    normalizeActiveProfile(activeSelector) ??
    (displayHandle ? normalizeActiveProfile({ handle: displayHandle, baseUrl: activeProfileRow?.baseUrl ?? account?.baseUrl }) : null);
  const profileRows =
    profiles.length > 0
      ? profiles
      : displayHandle
        ? [
            {
              handle: displayHandle,
              baseUrl: selectorBaseUrl(activeProfile) ?? normalizeBaseUrl(account?.baseUrl),
              apiBaseUrl,
              chatApiBaseUrl,
              environment,
              isActive: true,
              hasApiKey: Boolean(token),
              hasSessionToken: false,
              sessionAppId: null,
              sessionConversationId: null,
            },
          ]
        : [];
  const visibleProfileRows = profileRows.filter((candidate) => !isEmptyDefaultProfile(candidate));

  return {
    state: healthState,
    activeProfile,
    label,
    email: profile?.email ?? null,
    avatarUrl: profile?.image ?? null,
    environment,
    baseUrl,
    apiBaseUrl,
    chatApiBaseUrl,
    balanceLabel: balanceResponse?.balanceLabel ?? "$0.00",
    balance,
    creditsLabel: profile?.credits ?? null,
    profile,
    products: normalizeProducts(accountResponse?.products),
    apiHealth: normalizeHealth(health ?? null, apiBaseUrl),
    accounts: visibleProfileRows.map((candidate) => {
      const candidateBaseUrl = normalizeBaseUrl(candidate.baseUrl);
      const profileLookup = accountProfiles?.[profileKey(candidate.handle, candidateBaseUrl)] ?? null;
      const candidateProfile = normalizeProfile(profileLookup?.response ?? null);
      return {
        handle: candidate.handle,
        baseUrl: candidateBaseUrl,
        apiBaseUrl: normalizeBaseUrl(candidate.apiBaseUrl),
        chatApiBaseUrl: normalizeBaseUrl(candidate.chatApiBaseUrl),
        environment: deriveEnvironment(candidate.environment),
        isActive: activeProfile ? profileMatchesSelector(candidate, activeProfile) : false,
        authHealth: profileLookup?.authFailed ? "auth_error" : profileAuthHealth(candidate),
        displayLabel: candidateProfile?.name || candidateProfile?.handle || candidateProfile?.email || candidate.handle,
        email: candidateProfile?.email ?? null,
        avatarUrl: candidateProfile?.image ?? null,
      };
    }),
    error: error ?? health?.error ?? null,
  };
}
