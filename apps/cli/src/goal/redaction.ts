const SECRET_PATTERNS: RegExp[] = [
  /\bopk_[A-Za-z0-9_-]{12,}\b/g,
  /\bsk-[A-Za-z0-9_-]{12,}\b/g,
  /\bghp_[A-Za-z0-9_]{12,}\b/g,
  /\bgithub_pat_[A-Za-z0-9_]{12,}\b/g,
  /\bOPENPOND_[A-Z0-9_]*(?:API_KEY|TOKEN|SECRET)\s*=\s*[^\s]+/g,
  /\b(?:API_KEY|TOKEN|SECRET|PASSWORD)\s*=\s*[^\s]+/gi,
];

const REDACTED = "[redacted]";

export function redactString(value: string): string {
  return SECRET_PATTERNS.reduce(
    (current, pattern) => current.replace(pattern, REDACTED),
    value
  );
}

export function truncateForEvent(value: string, maxLength = 4000): string {
  const redacted = redactString(value);
  if (redacted.length <= maxLength) return redacted;
  return `${redacted.slice(0, maxLength)}\n[truncated ${redacted.length - maxLength} chars]`;
}

export function redactJson(value: unknown): unknown {
  if (typeof value === "string") return redactString(value);
  if (Array.isArray(value)) return value.map((entry) => redactJson(entry));
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).map(([key, entry]) => [
      key,
      redactJson(entry),
    ])
  );
}
