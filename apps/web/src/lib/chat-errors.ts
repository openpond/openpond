export type ChatErrorKind = "opchat_quota_exceeded";

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
