const WORKSPACE_IMAGE_EXTENSIONS = new Set([".avif", ".gif", ".jpeg", ".jpg", ".png", ".webp"]);

export function isWorkspaceImagePath(path: string | null | undefined): path is string {
  if (!path) return false;
  const cleanPath = path.split("?")[0]?.split("#")[0] ?? path;
  const dotIndex = cleanPath.lastIndexOf(".");
  if (dotIndex < 0) return false;
  return WORKSPACE_IMAGE_EXTENSIONS.has(cleanPath.slice(dotIndex).toLowerCase());
}

export function workspaceFileName(path: string): string {
  return path.split("/").filter(Boolean).pop() ?? path;
}
