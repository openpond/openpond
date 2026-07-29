const VERCEL_PROTECTION_BYPASS_HEADER = "x-vercel-protection-bypass";

export function withVercelProtectionBypass(
  requestUrl: string,
  inputHeaders?: HeadersInit,
  env: Record<string, string | undefined> =
    typeof process === "undefined" ? {} : process.env,
): Headers {
  const headers = new Headers(inputHeaders);
  const secret = env.VERCEL_AUTOMATION_BYPASS_SECRET?.trim();
  if (!secret || !isOpenPondStagingUrl(requestUrl)) return headers;
  headers.set(VERCEL_PROTECTION_BYPASS_HEADER, secret);
  return headers;
}

function isOpenPondStagingUrl(requestUrl: string): boolean {
  try {
    const hostname = new URL(requestUrl).hostname.toLowerCase();
    return (
      hostname === "staging.openpond.ai" ||
      hostname === "staging-api.openpond.ai" ||
      hostname.endsWith(".staging-api.openpond.ai")
    );
  } catch {
    return false;
  }
}
