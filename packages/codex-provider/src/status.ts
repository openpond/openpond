import { resolveCodexBinary } from "./binary.js";
import { CodexAppServerClient } from "./client.js";
import type { CodexAccountStatus, CodexProbeStatus } from "./types.js";

export async function detectCodexStatus(binaryPath = "codex"): Promise<CodexProbeStatus> {
  try {
    const resolved = await resolveCodexBinary(binaryPath);
    const authHealth = await probeCodexAppServer(resolved.command);
    return {
      available: true,
      binaryPath: resolved.command,
      version: resolved.version,
      authHealth: authHealth.authHealth,
      account: authHealth.account,
      error: null,
    };
  } catch (error) {
    return {
      available: false,
      binaryPath: null,
      version: null,
      authHealth: "unknown",
      account: null,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

async function probeCodexAppServer(
  binaryPath: string
): Promise<{ authHealth: CodexProbeStatus["authHealth"]; account: CodexAccountStatus | null }> {
  const client = new CodexAppServerClient({
    binaryPath,
    clientName: "openpond-app-probe",
    clientTitle: "OpenPond App Probe",
    clientVersion: "0.1.0",
  });
  try {
    await client.start();
    await client.initialize();
    const accountResponse = normalizeAccountResponse(await client.readAccount());
    if (accountResponse.account) {
      return {
        authHealth: "signed_in",
        account: {
          type: accountResponse.account.type,
          email: accountResponse.account.email,
          planType: accountResponse.account.planType,
          label: accountLabel(accountResponse.account),
        },
      };
    }
    return { authHealth: accountResponse.requiresOpenaiAuth ? "signed_out" : "unknown", account: null };
  } catch (error) {
    const message = error instanceof Error ? error.message.toLowerCase() : String(error).toLowerCase();
    if (message.includes("login") || message.includes("auth")) return { authHealth: "signed_out", account: null };
    return { authHealth: "auth_error", account: null };
  } finally {
    client.stop();
  }
}

function normalizeAccountResponse(input: unknown): {
  account: { type: string; email: string | null; planType: string | null } | null;
  requiresOpenaiAuth: boolean;
} {
  const response = input && typeof input === "object" ? (input as Record<string, unknown>) : {};
  const account = response.account && typeof response.account === "object" ? (response.account as Record<string, unknown>) : null;
  return {
    account:
      typeof account?.type === "string"
        ? {
            type: account.type,
            email: typeof account.email === "string" ? account.email : null,
            planType: typeof account.planType === "string" ? account.planType : null,
          }
        : null,
    requiresOpenaiAuth: response.requiresOpenaiAuth === true,
  };
}

function accountLabel(account: { type: string; planType: string | null }): string {
  if (account.type === "apiKey") return "OpenAI API Key";
  if (account.type !== "chatgpt") return account.type;
  switch (account.planType) {
    case "free":
      return "ChatGPT Free";
    case "go":
      return "ChatGPT Go";
    case "plus":
      return "ChatGPT Plus";
    case "pro":
      return "ChatGPT Pro";
    case "prolite":
      return "ChatGPT Pro 5x";
    case "team":
      return "ChatGPT Team";
    case "business":
    case "self_serve_business_usage_based":
      return "ChatGPT Business";
    case "enterprise":
    case "enterprise_cbp_usage_based":
      return "ChatGPT Enterprise";
    case "edu":
      return "ChatGPT Edu";
    default:
      return "ChatGPT";
  }
}
