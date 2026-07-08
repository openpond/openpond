import type { SandboxProject } from "./sandbox-types";

type SandboxProjectCacheEntry = {
  projects: SandboxProject[];
  promise: Promise<SandboxProject[]> | null;
  updatedAt: number;
};

const sandboxProjectsByTeamId = new Map<string, SandboxProjectCacheEntry>();

function sandboxTeamCacheKey(teamId: string | null | undefined, accountKey?: string | null): string | null {
  const normalizedTeamId = teamId?.trim();
  if (!normalizedTeamId) return null;
  const normalizedAccountKey = accountKey?.trim() || "global";
  return `${normalizedAccountKey}|${normalizedTeamId}`;
}

export function readSandboxProjectsFromMemory(
  teamId: string | null | undefined,
  accountKey?: string | null,
): SandboxProject[] | null {
  const cacheKey = sandboxTeamCacheKey(teamId, accountKey);
  if (!cacheKey) return null;
  const entry = sandboxProjectsByTeamId.get(cacheKey);
  return entry?.updatedAt ? entry.projects : null;
}

export function writeSandboxProjectsToMemory(
  teamId: string | null | undefined,
  projects: SandboxProject[],
  accountKey?: string | null,
): void {
  const cacheKey = sandboxTeamCacheKey(teamId, accountKey);
  if (!cacheKey) return;
  sandboxProjectsByTeamId.set(cacheKey, {
    projects,
    promise: null,
    updatedAt: Date.now(),
  });
}

export function preloadSandboxProjects(input: {
  teamId: string | null | undefined;
  accountKey?: string | null;
  force?: boolean;
  fetchProjects: (teamId: string) => Promise<SandboxProject[]>;
}): Promise<SandboxProject[]> {
  const normalizedTeamId = input.teamId?.trim();
  if (!normalizedTeamId) return Promise.resolve([]);
  const cacheKey = sandboxTeamCacheKey(normalizedTeamId, input.accountKey);
  if (!cacheKey) return Promise.resolve([]);

  const cached = sandboxProjectsByTeamId.get(cacheKey);
  if (!input.force) {
    if (cached?.updatedAt) return Promise.resolve(cached.projects);
    if (cached?.promise) return cached.promise;
  }

  const promise = input
    .fetchProjects(normalizedTeamId)
    .then((projects) => {
      writeSandboxProjectsToMemory(normalizedTeamId, projects, input.accountKey);
      return projects;
    })
    .catch((error) => {
      const current = sandboxProjectsByTeamId.get(cacheKey);
      if (current?.promise === promise) {
        sandboxProjectsByTeamId.set(cacheKey, {
          projects: current.projects,
          promise: null,
          updatedAt: current.updatedAt,
        });
      }
      throw error;
    });

  sandboxProjectsByTeamId.set(cacheKey, {
    projects: cached?.projects ?? [],
    promise,
    updatedAt: cached?.updatedAt ?? 0,
  });
  return promise;
}
