export function hostedConsoleUrl(accountBaseUrl?: string | null): string {
  const baseUrl = accountBaseUrl?.trim() || "https://openpond.ai";
  return new URL("/console", baseUrl).toString();
}

export async function openHostedConsole(accountBaseUrl?: string | null): Promise<void> {
  const url = hostedConsoleUrl(accountBaseUrl);
  const browser = window.openpond?.browser;
  if (browser?.openExternal) {
    const result = await browser.openExternal({ conversationId: "openpond-console", url });
    if (result.ok) return;
  }
  window.location.assign(url);
}
