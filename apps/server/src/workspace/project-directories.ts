import os from "node:os";
import path from "node:path";

const DEFAULT_NEW_PROJECTS_FOLDER = "OpenPond Projects";

function expandHomeDirectory(inputPath: string): string {
  if (inputPath === "~") return os.homedir();
  if (inputPath.startsWith("~/") || inputPath.startsWith("~\\")) {
    return path.join(os.homedir(), inputPath.slice(2));
  }
  return inputPath;
}

export function defaultNewProjectDirectory(): string {
  const documentsDir = process.env.OPENPOND_APP_DOCUMENTS_DIR?.trim() || path.join(os.homedir(), "Documents");
  return path.join(documentsDir, DEFAULT_NEW_PROJECTS_FOLDER);
}

export function normalizeProjectDirectory(inputPath?: string | null): string {
  const trimmed = inputPath?.trim();
  if (!trimmed) return defaultNewProjectDirectory();
  return path.resolve(expandHomeDirectory(trimmed));
}
