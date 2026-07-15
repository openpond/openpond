export function isTrustedDesktopIpcFrameUrl(input: {
  frameUrl: string;
  packaged: boolean;
  trustedRendererUrl: string | null;
}): boolean {
  if (!input.frameUrl || !input.trustedRendererUrl) return false;
  try {
    const frame = new URL(input.frameUrl);
    const trusted = new URL(input.trustedRendererUrl);
    if (input.packaged && !isLoopbackHttpUrl(trusted)) return false;
    return frame.origin === trusted.origin;
  } catch {
    return false;
  }
}

function isLoopbackHttpUrl(url: URL): boolean {
  return (
    url.protocol === "http:" &&
    (url.hostname === "127.0.0.1" ||
      url.hostname === "localhost" ||
      url.hostname === "[::1]")
  );
}
