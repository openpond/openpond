import { localPathWorkspaceId } from "@openpond/contracts";

/** A standalone file can be previewed without assigning its chat a project. */
export function localFileWorkspaceId(filePath: string): string | null {
  const normalized = filePath.replace(/\\/g, "/");
  if (!/^(?:\/|[A-Za-z]:\/)/.test(normalized)) return null;
  const separator = normalized.lastIndexOf("/");
  const parent = separator === 2 && /^[A-Za-z]:/.test(normalized)
    ? normalized.slice(0, 3)
    : normalized.slice(0, separator) || "/";
  return localPathWorkspaceId(parent);
}
