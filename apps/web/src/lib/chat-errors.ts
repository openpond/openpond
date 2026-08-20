export type ChatErrorKind = "opchat_quota_exceeded";

const OPCHAT_GATEWAY_FAILURE = /\bopenpond\s+opchat\b/i;
const TRANSIENT_GATEWAY_FAILURE =
  /\b(?:50[0-9]|52[0-9]|53[0-9])\b|bad\s+gateway|gateway\s+timeout|service\s+unavailable/i;

export function displayChatErrorMessage(message?: string | null): string {
  const raw = message?.trim() || "Turn failed";
  if (OPCHAT_GATEWAY_FAILURE.test(raw) && TRANSIENT_GATEWAY_FAILURE.test(raw)) {
    return "Server connection lost. Retry your message.";
  }
  return raw;
}

export function classifyChatError(message?: string | null, data?: unknown): ChatErrorKind | null {
  const code = stringFromRecord(data, "code") ?? stringFromRecord(data, "errorCode");
  if (code === "opchat_quota_exceeded") return "opchat_quota_exceeded";

  const error = data && typeof data === "object" ? (data as Record<string, unknown>).error : null;
  if (error && typeof error === "object") {
    const nestedCode = stringFromRecord(error, "code") ?? stringFromRecord(error, "errorCode");
    if (nestedCode === "opchat_quota_exceeded") return "opchat_quota_exceeded";
  }

  const text = message ?? "";
  if (/\bopchat_quota_exceeded\b/i.test(text)) return "opchat_quota_exceeded";
  if (/OpChat token allowance is exhausted/i.test(text)) return "opchat_quota_exceeded";
  return null;
}

function stringFromRecord(value: unknown, key: string): string | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  const raw = record[key];
  return typeof raw === "string" && raw.trim() ? raw.trim() : null;
}
