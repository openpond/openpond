import type { SandboxAgent } from "./sandbox-types";

type SandboxAgentCacheEntry = {
  agents: SandboxAgent[];
  promise: Promise<SandboxAgent[]> | null;
  updatedAt: number;
};

const sandboxAgentsByTeamId = new Map<string, SandboxAgentCacheEntry>();

function sandboxTeamCacheKey(teamId: string | null | undefined, accountKey?: string | null): string | null {
  const normalizedTeamId = teamId?.trim();
  if (!normalizedTeamId) return null;
  const normalizedAccountKey = accountKey?.trim() || "global";
  return `${normalizedAccountKey}|${normalizedTeamId}`;
}

export function readSandboxAgentsFromMemory(
  teamId: string | null | undefined,
  accountKey?: string | null,
): SandboxAgent[] | null {
  const cacheKey = sandboxTeamCacheKey(teamId, accountKey);
  if (!cacheKey) return null;
  const entry = sandboxAgentsByTeamId.get(cacheKey);
  return entry?.updatedAt ? entry.agents : null;
}

export function writeSandboxAgentsToMemory(
  teamId: string | null | undefined,
  agents: SandboxAgent[],
  accountKey?: string | null,
): void {
  const cacheKey = sandboxTeamCacheKey(teamId, accountKey);
  if (!cacheKey) return;
  sandboxAgentsByTeamId.set(cacheKey, {
    agents,
    promise: null,
    updatedAt: Date.now(),
  });
}

export function preloadSandboxAgents(input: {
  teamId: string | null | undefined;
  accountKey?: string | null;
  force?: boolean;
  fetchAgents: (teamId: string) => Promise<SandboxAgent[]>;
}): Promise<SandboxAgent[]> {
  const normalizedTeamId = input.teamId?.trim();
  if (!normalizedTeamId) return Promise.resolve([]);
  const cacheKey = sandboxTeamCacheKey(normalizedTeamId, input.accountKey);
  if (!cacheKey) return Promise.resolve([]);

  const cached = sandboxAgentsByTeamId.get(cacheKey);
  if (!input.force) {
    if (cached?.updatedAt) return Promise.resolve(cached.agents);
    if (cached?.promise) return cached.promise;
  }

  const promise = input
    .fetchAgents(normalizedTeamId)
    .then((agents) => {
      writeSandboxAgentsToMemory(normalizedTeamId, agents, input.accountKey);
      return agents;
    })
    .catch((error) => {
      const current = sandboxAgentsByTeamId.get(cacheKey);
      if (current?.promise === promise) {
        sandboxAgentsByTeamId.set(cacheKey, {
          agents: current.agents,
          promise: null,
          updatedAt: current.updatedAt,
        });
      }
      throw error;
    });

  sandboxAgentsByTeamId.set(cacheKey, {
    agents: cached?.agents ?? [],
    promise,
    updatedAt: cached?.updatedAt ?? 0,
  });
  return promise;
}
