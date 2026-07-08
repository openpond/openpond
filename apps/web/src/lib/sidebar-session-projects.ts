import type { LocalProject, Session } from "@openpond/contracts";
import { projectSelectionKey } from "./app-models";

const CODEX_HISTORY_SESSION_PREFIX = "codex_history_";

type ProjectPathEntry = {
  projectId: string;
  path: string;
};

export function isCodexHistorySessionId(sessionId: string | null | undefined): boolean {
  return Boolean(sessionId?.startsWith(CODEX_HISTORY_SESSION_PREFIX));
}

export function buildSidebarProjectPathIndex(localProjects: LocalProject[]): ProjectPathEntry[] {
  const entries: ProjectPathEntry[] = [];
  const seen = new Set<string>();

  for (const project of localProjects) {
    for (const path of [project.workspacePath, project.path]) {
      const normalized = normalizeSidebarPath(path);
      if (!normalized) continue;
      const key = `${project.id}:${normalized}`;
      if (seen.has(key)) continue;
      seen.add(key);
      entries.push({ projectId: project.id, path: normalized });
    }
  }

  return entries.sort((left, right) => right.path.length - left.path.length);
}

export function sidebarProjectIdForSession(
  session: Session,
  localProjectIds: ReadonlySet<string>,
  projectPathIndex: ProjectPathEntry[],
  cloudProjectIds: ReadonlySet<string> = new Set(),
): string | null {
  if (isSidebarCloudWorkSession(session, cloudProjectIds)) return null;

  if (session.localProjectId && localProjectIds.has(session.localProjectId)) {
    return session.localProjectId;
  }

  if (session.workspaceKind === "local_project" && session.workspaceId && localProjectIds.has(session.workspaceId)) {
    return session.workspaceId;
  }

  if (session.metadata?.workspaceTarget === "hybrid" && session.cwd) {
    const projectId = localProjectIdForSidebarPath(session.cwd, projectPathIndex);
    if (projectId) return projectId;
  }

  if (session.cloudProjectId && cloudProjectIds.has(session.cloudProjectId)) {
    return session.cloudProjectId;
  }

  if (!session.cwd) return null;
  if (
    session.workspaceKind === "sandbox" ||
    session.workspaceKind === "sandbox_template" ||
    session.workspaceKind === "sandbox_app"
  ) {
    return null;
  }

  const cwd = normalizeSidebarPath(session.cwd);
  if (!cwd) return null;

  for (const entry of projectPathIndex) {
    if (isSameOrInsideSidebarPath(cwd, entry.path)) return entry.projectId;
  }

  return null;
}

export function sidebarProjectKeyForSession(
  session: Session,
  localProjectIds: ReadonlySet<string>,
  projectPathIndex: ProjectPathEntry[],
  cloudProjectIds: ReadonlySet<string> = new Set(),
): string | null {
  if (isSidebarCloudWorkSession(session, cloudProjectIds)) return null;

  if (session.localProjectId && localProjectIds.has(session.localProjectId)) {
    return projectSelectionKey("local", session.localProjectId);
  }

  if (session.workspaceKind === "local_project" && session.workspaceId && localProjectIds.has(session.workspaceId)) {
    return projectSelectionKey("local", session.workspaceId);
  }

  if (session.metadata?.workspaceTarget === "hybrid" && session.cwd) {
    const projectId = localProjectIdForSidebarPath(session.cwd, projectPathIndex);
    if (projectId) return projectSelectionKey("local", projectId);
  }

  if (session.cloudProjectId && cloudProjectIds.has(session.cloudProjectId)) {
    return projectSelectionKey("cloud", session.cloudProjectId);
  }

  if (!session.cwd) return null;
  if (
    session.workspaceKind === "sandbox" ||
    session.workspaceKind === "sandbox_template" ||
    session.workspaceKind === "sandbox_app"
  ) {
    return null;
  }

  const cwd = normalizeSidebarPath(session.cwd);
  if (!cwd) return null;

  for (const entry of projectPathIndex) {
    if (isSameOrInsideSidebarPath(cwd, entry.path)) return projectSelectionKey("local", entry.projectId);
  }

  return null;
}

function localProjectIdForSidebarPath(
  value: string | null | undefined,
  projectPathIndex: ProjectPathEntry[],
): string | null {
  const cwd = normalizeSidebarPath(value);
  if (!cwd) return null;

  for (const entry of projectPathIndex) {
    if (isSameOrInsideSidebarPath(cwd, entry.path)) return entry.projectId;
  }

  return null;
}

export function isSidebarCloudWorkSession(
  session: Session,
  cloudProjectIds: ReadonlySet<string>,
): boolean {
  if (session.localProjectId) return false;
  if (session.metadata?.workspaceTarget === "hybrid") return false;

  return Boolean(
    session.cloudProjectId &&
      cloudProjectIds.has(session.cloudProjectId) &&
      (session.workspaceKind === "sandbox" ||
        session.workspaceKind === "sandbox_template" ||
        session.workspaceKind === "sandbox_app"),
  );
}

function normalizeSidebarPath(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  if (!trimmed) return null;

  let normalized = trimmed.replace(/^file:\/\/+/i, "/").replace(/\\/g, "/").replace(/\/+/g, "/");
  if (/^[a-z]:/i.test(normalized)) {
    normalized = normalized[0]!.toUpperCase() + normalized.slice(1);
  }
  normalized = normalized.replace(/\/+$/g, "");

  return normalized || "/";
}

function isSameOrInsideSidebarPath(childPath: string, parentPath: string): boolean {
  const child = comparisonPath(childPath);
  const parent = comparisonPath(parentPath);
  return child === parent || child.startsWith(`${parent}/`);
}

function comparisonPath(path: string): string {
  return /^[A-Z]:\//.test(path) ? path.toLowerCase() : path;
}
