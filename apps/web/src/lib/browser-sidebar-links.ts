import { normalizeBrowserUrl } from "./browser-url";

export type OpenBrowserLinkOptions = {
  conversationId: string;
  href: string;
  explicitFile?: boolean;
  newTab?: boolean;
};

export async function openBrowserLink(options: OpenBrowserLinkOptions): Promise<boolean> {
  const url = normalizeBrowserUrl(options.href, { explicitFile: options.explicitFile });
  if (!url) return false;
  const browser = window.openpond?.browser;
  if (!browser) {
    window.open(url, "_blank", "noopener,noreferrer");
    return true;
  }

  if (options.newTab) {
    await browser.newTab({ conversationId: options.conversationId, url, explicitFile: options.explicitFile });
  } else {
    await browser.open({ conversationId: options.conversationId, url, explicitFile: options.explicitFile });
  }
  return true;
}
