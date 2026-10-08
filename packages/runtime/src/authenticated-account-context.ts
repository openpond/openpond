import { createHash } from "node:crypto";
import { getOpenPondAccount } from "@openpond/cloud";
import { loadOpenPondAccountContext } from "./account-context.js";
import { toAccountState } from "./account-state.js";
import type { RuntimeAccountContext } from "./types.js";

function authorityKey(context: RuntimeAccountContext): string {
  return createHash("sha256")
    .update(
      JSON.stringify([
        context.accountState.activeProfile,
        context.apiBaseUrl,
        context.chatApiBaseUrl,
        context.token,
      ]),
    )
    .digest("hex");
}

// Cache only the authenticated principal briefly; hosted operations still authorize
// every request. Re-read credentials before returning, including on cache hits.
let principal: {
  key: string;
  expiresAt: number;
  response: Awaited<ReturnType<typeof getOpenPondAccount>>;
} | null = null;
let lookup: {
  key: string;
  promise: ReturnType<typeof getOpenPondAccount>;
} | null = null;

async function authenticate(context: RuntimeAccountContext) {
  const key = authorityKey(context);
  if (principal?.key === key && principal.expiresAt > Date.now()) return principal.response;
  if (lookup?.key === key) return lookup.promise;
  principal = null;
  const pending = {
    key,
    promise: getOpenPondAccount(context.apiBaseUrl, context.token!),
  };
  lookup = pending;
  try {
    const response = await pending.promise;
    if (lookup === pending && response.account?.id)
      principal = { key, response, expiresAt: Date.now() + 5_000 };
    return response;
  } finally {
    if (lookup === pending) lookup = null;
  }
}

/** Local ownership requires the authenticated user, not just a saved key. */
export async function loadAuthenticatedOpenPondAccountContext(): Promise<RuntimeAccountContext> {
  const captured = await loadOpenPondAccountContext();
  if (!captured.token) return captured;
  const response = await authenticate(captured);
  const current = await loadOpenPondAccountContext();
  if (authorityKey(current) !== authorityKey(captured)) {
    throw new Error("openpond_account_authority_changed");
  }
  if (!response.account?.id) throw new Error("openpond_authenticated_owner_unavailable");
  return {
    ...current,
    accountState: toAccountState({
      ...current,
      accountResponse: response,
    }),
  };
}
