import { useCallback } from "react";
import type {
  BootstrapPayload,
  TeamChatAgentCatalogEntry,
} from "@openpond/contracts";
import { api, type ClientConnection } from "../api";
import type { SandboxActionCatalogEntry } from "../lib/sandbox-types";
import {
  hostedTeamActionForProfileAgent,
  teamProfileAgentPublicationError,
} from "../lib/team-chat-profile-agents";

const DIRECTORY_REFRESH_ATTEMPTS = 5;

export function useTeamProfileAgentPublisher(input: {
  connection: ClientConnection | null;
  teamId: string | null;
  applyBootstrapPayload: (payload: BootstrapPayload) => void;
  refreshDirectory: () => Promise<{
    members: unknown[];
    agents: TeamChatAgentCatalogEntry[];
  }>;
}) {
  return useCallback(
    async (agentId: string): Promise<SandboxActionCatalogEntry> => {
      if (!input.connection || !input.teamId) {
        throw new Error("Connect OpenPond to a Team before publishing an agent.");
      }

      const checkedProfile = await api.profileCheck(input.connection, {
        kind: "all",
      });
      const publicationError = teamProfileAgentPublicationError(
        checkedProfile,
        agentId,
      );
      if (publicationError) throw new Error(publicationError);

      const profileAgent = checkedProfile?.agents.find(
        (agent) => agent.id === agentId,
      );
      if (!profileAgent) {
        throw new Error(`Profile agent not found: ${agentId}`);
      }

      const pushed = await api.profilePush(input.connection, {
        teamId: input.teamId,
        ensureHosted: true,
        hostedSourceAgentId: agentId,
        message: null,
      });
      const materialization =
        pushed.localProfile?.hosted?.hostedSourceMaterialization;
      const runtimeAgentId =
        materialization?.agentId === agentId
          ? materialization.runtimeAgentId
          : null;

      input.applyBootstrapPayload(await api.bootstrap(input.connection));
      let publishedAction: SandboxActionCatalogEntry | null = null;
      for (let attempt = 0; attempt < DIRECTORY_REFRESH_ATTEMPTS; attempt += 1) {
        const directory = await input.refreshDirectory();
        publishedAction = hostedTeamActionForProfileAgent(directory.agents, {
          runtimeAgentId,
          profileName: checkedProfile.activeProfile,
          agentName: profileAgent.name,
        });
        if (publishedAction) break;
        if (attempt < DIRECTORY_REFRESH_ATTEMPTS - 1) {
          await waitForDirectoryRefresh(200 * (attempt + 1));
        }
      }

      if (!publishedAction) {
        throw new Error(
          `${profileAgent.name} was published, but the Team agent directory has not refreshed yet. Retry the mention in a moment.`,
        );
      }
      return publishedAction;
    },
    [
      input.applyBootstrapPayload,
      input.connection,
      input.refreshDirectory,
      input.teamId,
    ],
  );
}

function waitForDirectoryRefresh(delayMs: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, delayMs);
  });
}
