export type BrowserUrlOptions = {
  explicitFile?: boolean;
};

const LOCALHOST_PATTERN = /^(localhost|\[::1\]|127(?:\.\d{1,3}){3})(?::\d+)?(?:[/?#].*)?$/i;
const DOMAIN_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+(?:[:/?#].*)?$/i;

export function normalizeBrowserUrl(rawValue: string, options: BrowserUrlOptions = {}): string | null {
  const value = rawValue.trim().replace(/^['"`]+|['"`]+$/g, "");
  if (!value || /\s/.test(value)) return null;

  const lowerValue = value.toLowerCase();
  if (lowerValue.startsWith("javascript:") || lowerValue.startsWith("data:")) return null;

  if (/^https?:\/\//i.test(value)) return parseAllowedUrl(value, new Set(["http:", "https:"]));
  if (/^file:\/\//i.test(value)) {
    return options.explicitFile ? parseAllowedUrl(value, new Set(["file:"])) : null;
  }
  if (LOCALHOST_PATTERN.test(value)) return parseAllowedUrl(`http://${value}`, new Set(["http:"]));
  if (DOMAIN_PATTERN.test(value)) return parseAllowedUrl(`https://${value}`, new Set(["https:"]));
  return null;
}

function parseAllowedUrl(value: string, protocols: ReadonlySet<string>): string | null {
  try {
    const url = new URL(value);
    if (!protocols.has(url.protocol)) return null;
    return url.toString();
  } catch {
    return null;
  }
}
