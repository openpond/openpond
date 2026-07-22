const LOCAL_VIDEO_EXTENSION = /\.(?:m4v|mov|mp4|webm)$/i;

export function isLocalVideoPath(path: string): boolean {
  return LOCAL_VIDEO_EXTENSION.test(path.trim().split(/[?#]/, 1)[0] ?? "");
}

export function absoluteLocalVideoPath(path: string, workspaceRootPath?: string | null): string | null {
  let normalized = path.trim();
  if (!normalized || !isLocalVideoPath(normalized)) return null;
  if (/^file:\/\//i.test(normalized)) {
    try {
      normalized = decodeURIComponent(new URL(normalized).pathname);
    } catch {
      normalized = normalized.replace(/^file:\/\//i, "");
    }
  }
  if (/^\//.test(normalized) || /^[A-Za-z]:[\\/]/.test(normalized)) return normalized;
  const root = workspaceRootPath?.trim().replace(/[\\/]+$/, "");
  return root ? `${root}/${normalized.replace(/^\.\//, "")}` : null;
}
