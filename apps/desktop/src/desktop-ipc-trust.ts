import path from "node:path";
import { fileURLToPath } from "node:url";

export function isTrustedDesktopIpcFrameUrl(input: {
  frameUrl: string;
  packaged: boolean;
  resourcesPath: string;
  trustedRendererUrl: string | null;
}): boolean {
  if (!input.frameUrl || !input.trustedRendererUrl) return false;
  try {
    const frame = new URL(input.frameUrl);
    const trusted = new URL(input.trustedRendererUrl);
    if (input.packaged) {
      if (frame.protocol !== "file:" || trusted.protocol !== "file:") return false;
      const expected = path.resolve(input.resourcesPath, "web", "index.html");
      return path.resolve(fileURLToPath(frame)) === expected && path.resolve(fileURLToPath(trusted)) === expected;
    }
    return frame.origin === trusted.origin;
  } catch {
    return false;
  }
}
