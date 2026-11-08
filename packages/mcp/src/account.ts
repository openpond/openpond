import { z } from "zod";
import { OpenPondProtocolError } from "openpond-sdk/training";
import type { Clients } from "./clients.js";
import type { AddTool, OpenPondMcpContext } from "./types.js";
import { Empty, Id } from "./common.js";

const AccountBalance = z.object({
  workspace: z.object({ id: Id, type: z.enum(["personal", "team"]) }),
  balanceKind: z.literal("prepaid_credits"),
  balanceUsd: z.string().regex(/^-?\d+(?:\.\d{1,6})?$/),
  balanceUsdCents: z.number().int().safe(),
  currency: z.literal("USD"),
  asOf: z.iso.datetime(),
});

/** The public SDK has no account-balance client. This bounded adapter uses the
 * same guarded, host-authenticated transport and strips billing/account fields. */
export async function readAccountBalance(
  request: Request,
  transport: typeof fetch,
  context: OpenPondMcpContext,
) {
  const response = await transport(request);
  if (!response.ok) {
    await response.body?.cancel().catch(() => {});
    throw Object.assign(new Error("Account balance is unavailable."), {
      code:
        response.status === 403
          ? "workspace_billing_access_required"
          : "account_balance_unavailable",
      status: response.status,
    });
  }
  const reader = response.body?.getReader();
  if (!reader)
    throw new OpenPondProtocolError("invalid_balance_response", "Missing account balance.");
  const decoder = new TextDecoder();
  let text = "";
  let bytes = 0;
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      bytes += chunk.value.byteLength;
      if (bytes > 65_536)
        throw new OpenPondProtocolError(
          "response_too_large",
          "Account balance exceeds its response budget.",
        );
      text += decoder.decode(chunk.value, { stream: true });
    }
    text += decoder.decode();
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
  const value = AccountBalance.parse(JSON.parse(text));
  if (value.workspace.id !== context.teamId)
    throw new OpenPondProtocolError(
      "response_scope_mismatch",
      "Account balance belongs to another workspace.",
    );
  return value;
}

export function addAccount(add: AddTool, clients: Clients) {
  add(
    "account_credit_balance",
    "Read prepaid USD credit in this connected workspace when your current billing role permits it. This observation reserves no credit and authorizes no spending.",
    Empty,
    "read",
    () => clients.accountBalance(),
    { output: AccountBalance },
  );
}
