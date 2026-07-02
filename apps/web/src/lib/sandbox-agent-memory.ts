import type { SandboxAgent } from "./sandbox-types";

type SandboxAgentCacheEntry = {
  agents: SandboxAgent[];
  promise: Promise<SandboxAgent[]> | null;
  updatedAt: number;
};

const sandboxAgentsByTeamId = new Map<string, SandboxAgentCacheEntry>();

export function readSandboxAgentsFromMemory(teamId: string | null | undefined): SandboxAgent[] | null {
  const normalizedTeamId = teamId?.trim();
  if (!normalizedTeamId) return null;
  const entry = sandboxAgentsByTeamId.get(normalizedTeamId);
  return entry?.updatedAt ? entry.agents : null;
}

export function writeSandboxAgentsToMemory(
  teamId: string | null | undefined,
  agents: SandboxAgent[],
): void {
  const normalizedTeamId = teamId?.trim();
  if (!normalizedTeamId) return;
  sandboxAgentsByTeamId.set(normalizedTeamId, {
    agents,
    promise: null,
    updatedAt: Date.now(),
  });
}

export function preloadSandboxAgents(input: {
  teamId: string | null | undefined;
  force?: boolean;
  fetchAgents: (teamId: string) => Promise<SandboxAgent[]>;
}): Promise<SandboxAgent[]> {
  const normalizedTeamId = input.teamId?.trim();
  if (!normalizedTeamId) return Promise.resolve([]);

  const cached = sandboxAgentsByTeamId.get(normalizedTeamId);
  if (!input.force) {
    if (cached?.updatedAt) return Promise.resolve(cached.agents);
    if (cached?.promise) return cached.promise;
  }

  const promise = input
    .fetchAgents(normalizedTeamId)
    .then((agents) => {
      writeSandboxAgentsToMemory(normalizedTeamId, agents);
      return agents;
    })
    .catch((error) => {
      const current = sandboxAgentsByTeamId.get(normalizedTeamId);
      if (current?.promise === promise) {
        sandboxAgentsByTeamId.set(normalizedTeamId, {
          agents: current.agents,
          promise: null,
          updatedAt: current.updatedAt,
        });
      }
      throw error;
    });

  sandboxAgentsByTeamId.set(normalizedTeamId, {
    agents: cached?.agents ?? [],
    promise,
    updatedAt: cached?.updatedAt ?? 0,
  });
  return promise;
}
