import type { SandboxProject } from "./sandbox-types";

type SandboxProjectCacheEntry = {
  projects: SandboxProject[];
  promise: Promise<SandboxProject[]> | null;
  updatedAt: number;
};

const sandboxProjectsByTeamId = new Map<string, SandboxProjectCacheEntry>();

export function readSandboxProjectsFromMemory(teamId: string | null | undefined): SandboxProject[] | null {
  const normalizedTeamId = teamId?.trim();
  if (!normalizedTeamId) return null;
  const entry = sandboxProjectsByTeamId.get(normalizedTeamId);
  return entry?.updatedAt ? entry.projects : null;
}

export function writeSandboxProjectsToMemory(
  teamId: string | null | undefined,
  projects: SandboxProject[],
): void {
  const normalizedTeamId = teamId?.trim();
  if (!normalizedTeamId) return;
  sandboxProjectsByTeamId.set(normalizedTeamId, {
    projects,
    promise: null,
    updatedAt: Date.now(),
  });
}

export function preloadSandboxProjects(input: {
  teamId: string | null | undefined;
  force?: boolean;
  fetchProjects: (teamId: string) => Promise<SandboxProject[]>;
}): Promise<SandboxProject[]> {
  const normalizedTeamId = input.teamId?.trim();
  if (!normalizedTeamId) return Promise.resolve([]);

  const cached = sandboxProjectsByTeamId.get(normalizedTeamId);
  if (!input.force) {
    if (cached?.updatedAt) return Promise.resolve(cached.projects);
    if (cached?.promise) return cached.promise;
  }

  const promise = input
    .fetchProjects(normalizedTeamId)
    .then((projects) => {
      writeSandboxProjectsToMemory(normalizedTeamId, projects);
      return projects;
    })
    .catch((error) => {
      const current = sandboxProjectsByTeamId.get(normalizedTeamId);
      if (current?.promise === promise) {
        sandboxProjectsByTeamId.set(normalizedTeamId, {
          projects: current.projects,
          promise: null,
          updatedAt: current.updatedAt,
        });
      }
      throw error;
    });

  sandboxProjectsByTeamId.set(normalizedTeamId, {
    projects: cached?.projects ?? [],
    promise,
    updatedAt: cached?.updatedAt ?? 0,
  });
  return promise;
}
