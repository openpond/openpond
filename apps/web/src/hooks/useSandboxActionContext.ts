import { useEffect, useMemo, useState } from "react";
import type { CloudProject, LocalProject, OpenPondActionCatalogEntry } from "@openpond/contracts";
import { api, type ClientConnection } from "../api";
import { actionCatalogForProject } from "../lib/sandbox-action-catalog";
import { openPondActionProjectTarget } from "../lib/openpond-action-project";
import {
  buildOpenPondAgentSlashCommand,
  buildOpenPondProfileActionCommand,
} from "../lib/openpond-action-run";
import {
  preloadSandboxAgents,
  readSandboxAgentsFromMemory,
} from "../lib/sandbox-agent-memory";
import {
  preloadSandboxProjects,
  readSandboxProjectsFromMemory,
} from "../lib/sandbox-project-memory";
import type { SandboxAgent, SandboxProject } from "../lib/sandbox-types";

function uniqueActiveAgents(agents: SandboxAgent[]): SandboxAgent[] {
  const byId = new Map<string, SandboxAgent>();
  for (const agent of agents) {
    if (agent.archivedAt || agent.status !== "active") continue;
    byId.set(agent.id, agent);
  }
  return [...byId.values()].sort((left, right) => left.name.localeCompare(right.name));
}

export function useSandboxActionContext({
  cloudProjectById,
  cloudProjects,
  connection,
  defaultTeamId,
  localProjects,
  profileActionCatalogEntries,
  selectedCloudProject,
  selectedProject,
}: {
  cloudProjectById: Map<string, CloudProject>;
  cloudProjects: CloudProject[];
  connection: ClientConnection | null;
  defaultTeamId: string | null;
  localProjects: LocalProject[];
  profileActionCatalogEntries: OpenPondActionCatalogEntry[];
  selectedCloudProject: CloudProject | null;
  selectedProject: LocalProject | null;
}) {
  const [selectedSandboxProject, setSelectedSandboxProject] = useState<SandboxProject | null>(null);
  const [slashAgents, setSlashAgents] = useState<SandboxAgent[]>([]);
  const slashAgentTeamIds = useMemo(() => {
    const ids = new Set<string>();
    if (defaultTeamId) ids.add(defaultTeamId);
    for (const project of cloudProjects) ids.add(project.teamId);
    for (const project of localProjects) {
      if (project.linkedSandboxProject?.teamId) ids.add(project.linkedSandboxProject.teamId);
    }
    return [...ids].sort();
  }, [cloudProjects, defaultTeamId, localProjects]);
  const slashAgentTeamIdKey = slashAgentTeamIds.join("\0");
  const selectedActionProjectTarget = useMemo(
    () => openPondActionProjectTarget({ selectedCloudProject, selectedProject }),
    [selectedCloudProject, selectedProject],
  );

  useEffect(() => {
    if (!connection || slashAgentTeamIds.length === 0) {
      setSlashAgents([]);
      return undefined;
    }

    let cancelled = false;
    const cachedAgents = slashAgentTeamIds.flatMap((teamId) => readSandboxAgentsFromMemory(teamId) ?? []);
    setSlashAgents(uniqueActiveAgents(cachedAgents));

    void Promise.all(
      slashAgentTeamIds.map((teamId) =>
        preloadSandboxAgents({
          teamId,
          fetchAgents: async (nextTeamId) => {
            const payload = await api.listSandboxAgents(connection, { teamId: nextTeamId });
            return payload.agents;
          },
        }),
      ),
    )
      .then((groups) => {
        if (!cancelled) setSlashAgents(uniqueActiveAgents(groups.flat()));
      })
      .catch(() => {
        if (!cancelled) setSlashAgents(uniqueActiveAgents(cachedAgents));
      });

    return () => {
      cancelled = true;
    };
  }, [connection, slashAgentTeamIdKey]);

  useEffect(() => {
    if (!connection || !selectedActionProjectTarget) {
      setSelectedSandboxProject(null);
      return undefined;
    }

    const cachedProjects = readSandboxProjectsFromMemory(selectedActionProjectTarget.teamId);
    if (cachedProjects) {
      setSelectedSandboxProject(
        cachedProjects.find((project) => project.id === selectedActionProjectTarget.id) ?? null,
      );
    }

    let cancelled = false;
    void preloadSandboxProjects({
      teamId: selectedActionProjectTarget.teamId,
      fetchProjects: async (teamId) => {
        const payload = await api.listSandboxProjects(connection, { teamId });
        return payload.projects;
      },
    })
      .then((projects) => {
        if (cancelled) return;
        setSelectedSandboxProject(
          projects.find((project) => project.id === selectedActionProjectTarget.id) ?? null,
        );
      })
      .catch(() => {
        if (!cancelled) setSelectedSandboxProject(null);
      });

    return () => {
      cancelled = true;
    };
  }, [connection, selectedActionProjectTarget?.id, selectedActionProjectTarget?.teamId]);

  const selectedProjectActionCatalog = useMemo(
    () => actionCatalogForProject(selectedSandboxProject),
    [selectedSandboxProject],
  );
  const profileActionCatalog = useMemo(
    () => (profileActionCatalogEntries ?? []).map((action) => buildOpenPondProfileActionCommand(action)),
    [profileActionCatalogEntries],
  );
  const selectedActionCatalog = useMemo(
    () => [
      ...slashAgents.map((agent) =>
        buildOpenPondAgentSlashCommand(agent, cloudProjectById.get(agent.projectId)?.name ?? null),
      ),
      ...profileActionCatalog,
      ...selectedProjectActionCatalog,
    ],
    [cloudProjectById, profileActionCatalog, selectedProjectActionCatalog, slashAgents],
  );
  const openPondActionCatalog = useMemo(
    () => [...profileActionCatalog, ...selectedProjectActionCatalog],
    [profileActionCatalog, selectedProjectActionCatalog],
  );

  return {
    openPondActionCatalog,
    selectedActionCatalog,
    selectedProjectActionCatalog,
  };
}
