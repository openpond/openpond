const SECRET_PATTERNS: Array<{ label: string; pattern: RegExp }> = [
  { label: "OpenAI-style API key", pattern: /\bsk-[A-Za-z0-9_-]{16,}\b/g },
  { label: "OpenPond API key", pattern: /\bopk_[A-Za-z0-9_-]{12,}\b/g },
  { label: "private key", pattern: /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/g },
  { label: "credential assignment", pattern: /\b(?:api[_-]?key|password|secret|token)\s*[:=]\s*["']?[^\s"']{8,}/gi },
];
const EMAIL_PATTERN = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi;
const PHONE_PATTERN = /\b(?:\+?1[-.\s]?)?\(?\d{3}\)?[-.\s]\d{3}[-.\s]\d{4}\b/g;

export type EvidencePrivacyScan = {
  secretStatus: "passed" | "blocked";
  piiStatus: "passed" | "review";
  findings: string[];
  redacted: string;
};

export function scanAndRedactEvidence(text: string): EvidencePrivacyScan {
  const findings: string[] = [];
  let redacted = text;
  for (const item of SECRET_PATTERNS) {
    item.pattern.lastIndex = 0;
    if (item.pattern.test(redacted)) findings.push(item.label);
    item.pattern.lastIndex = 0;
    redacted = redacted.replace(item.pattern, `[REDACTED ${item.label}]`);
  }
  EMAIL_PATTERN.lastIndex = 0;
  const hasEmail = EMAIL_PATTERN.test(redacted);
  EMAIL_PATTERN.lastIndex = 0;
  if (hasEmail) findings.push("email address");
  redacted = redacted.replace(EMAIL_PATTERN, "[REDACTED email]");
  PHONE_PATTERN.lastIndex = 0;
  const hasPhone = PHONE_PATTERN.test(redacted);
  PHONE_PATTERN.lastIndex = 0;
  if (hasPhone) findings.push("phone number");
  redacted = redacted.replace(PHONE_PATTERN, "[REDACTED phone]");
  return {
    secretStatus: findings.some((finding) => !finding.includes("email") && !finding.includes("phone")) ? "blocked" : "passed",
    piiStatus: hasEmail || hasPhone ? "review" : "passed",
    findings,
    redacted,
  };
}
