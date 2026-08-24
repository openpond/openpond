import { isTrustedDesktopIpcFrameUrl } from "./desktop-ipc-trust.js";

const ALLOWED_EXTERNAL_PROTOCOLS = new Set(["http:", "https:", "mailto:"]);

export function isAllowedExternalDesktopUrl(value: string): boolean {
  try {
    const url = new URL(value);
    if (!ALLOWED_EXTERNAL_PROTOCOLS.has(url.protocol)) return false;
    if (url.protocol === "mailto:") return Boolean(url.pathname.trim());
    return Boolean(url.hostname) && !url.username && !url.password;
  } catch {
    return false;
  }
}

export function isTrustedDesktopNavigationUrl(input: {
  navigationUrl: string;
  packaged: boolean;
  trustedRendererUrl: string | null;
}): boolean {
  return isTrustedDesktopIpcFrameUrl({
    frameUrl: input.navigationUrl,
    packaged: input.packaged,
    trustedRendererUrl: input.trustedRendererUrl,
  });
}
