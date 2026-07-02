import { useEffect, useState } from "react";
import type { BootstrapPayload } from "@openpond/contracts";
import type { ClientConnection } from "../../api";
import { api } from "../../api";
import { normalizeOpenPondOrganization } from "../../lib/cloud-project-utils";
import type { OpenPondOrganization } from "../../lib/organization-types";
import {
  openPondOrganizationCacheKey,
  preloadOpenPondOrganizations,
  readOpenPondOrganizationsFromMemory,
} from "../../lib/openpond-organization-memory";
import {
  preloadSandboxAgents,
  readSandboxAgentsFromMemory,
} from "../../lib/sandbox-agent-memory";
import type { SandboxAgent } from "../../lib/sandbox-types";

const AGENT_REFRESH_INTERVAL_MS = 5000;

export function SandboxAgentCreatorView({
  account,
  connection,
  defaultTeamId,
  onOpenSettings,
}: {
  account: BootstrapPayload["account"] | null;
  connection: ClientConnection | null;
  defaultTeamId?: string | null;
  onOpenSettings: () => void;
}) {
  const [organizations, setOrganizations] = useState<OpenPondOrganization[]>([]);
  const [agents, setAgents] = useState<SandboxAgent[]>([]);
  const [organizationsLoaded, setOrganizationsLoaded] = useState(false);
  const [organizationsLoading, setOrganizationsLoading] = useState(false);
  const [agentsLoading, setAgentsLoading] = useState(false);
  const [loadedAgentsTeamId, setLoadedAgentsTeamId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const organizationCacheKey = openPondOrganizationCacheKey(account);
  const normalizedDefaultTeamId = defaultTeamId?.trim() ?? "";
  const firstOrganization = organizations[0] ?? null;
  const selectedTeamId = normalizedDefaultTeamId || firstOrganization?.teamId || "";
  const cachedAgentsLoaded = Boolean(selectedTeamId && readSandboxAgentsFromMemory(selectedTeamId) !== null);
  const agentsLoadedForSelectedTeam = cachedAgentsLoaded || loadedAgentsTeamId === selectedTeamId;
  const loadingInitialAgents =
    (!normalizedDefaultTeamId && (!organizationsLoaded || organizationsLoading)) ||
    (Boolean(selectedTeamId) && !agentsLoadedForSelectedTeam);

  useEffect(() => {
    if (!connection || !organizationCacheKey) {
      setOrganizations([]);
      setAgents([]);
      setError(null);
      setOrganizationsLoaded(false);
      setOrganizationsLoading(false);
      return;
    }

    let cancelled = false;
    const cachedOrganizations = readOpenPondOrganizationsFromMemory(organizationCacheKey);
    if (cachedOrganizations) {
      setOrganizations(cachedOrganizations);
      setOrganizationsLoaded(true);
      setOrganizationsLoading(false);
    } else {
      setOrganizations([]);
      setOrganizationsLoaded(false);
      setOrganizationsLoading(true);
    }
    setError(null);
    preloadOpenPondOrganizations({
      accountKey: organizationCacheKey,
      fetchOrganizations: async () => {
        const payload = await api.organizations(connection);
        return payload.organizations
          .map(normalizeOpenPondOrganization)
          .filter((organization): organization is OpenPondOrganization => Boolean(organization))
          .filter((organization) => organization.status === "active");
      },
    })
      .then((nextOrganizations) => {
        if (cancelled) return;
        setOrganizations(nextOrganizations);
        setOrganizationsLoaded(true);
      })
      .catch((caught) => {
        if (cancelled) return;
        if (!cachedOrganizations) {
          setOrganizations([]);
          setOrganizationsLoaded(true);
        }
        setAgents([]);
        setError(errorMessage(caught));
      })
      .finally(() => {
        if (!cancelled) setOrganizationsLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [connection, organizationCacheKey]);

  useEffect(() => {
    if (!connection || !selectedTeamId) {
      setAgents([]);
      setAgentsLoading(false);
      setLoadedAgentsTeamId(null);
      return;
    }

    let cancelled = false;
    let intervalId: number | null = null;
    const cachedAgents = readSandboxAgentsFromMemory(selectedTeamId);
    if (cachedAgents) {
      setAgents(cachedAgents);
      setLoadedAgentsTeamId(selectedTeamId);
    } else {
      setAgents([]);
      setLoadedAgentsTeamId(null);
    }

    async function loadAgents(showLoading: boolean, force: boolean) {
      if (!connection || !selectedTeamId || cancelled) return;
      if (showLoading && !cachedAgents) setAgentsLoading(true);
      try {
        const nextAgents = await preloadSandboxAgents({
          teamId: selectedTeamId,
          force,
          fetchAgents: async (teamId) => {
            const payload = await api.listSandboxAgents(connection, { teamId });
            return payload.agents;
          },
        });
        if (cancelled) return;
        setAgents(nextAgents);
        setLoadedAgentsTeamId(selectedTeamId);
        setError(null);
      } catch (caught) {
        if (!cancelled) {
          setLoadedAgentsTeamId(selectedTeamId);
          setError(errorMessage(caught));
        }
      } finally {
        if (!cancelled && showLoading && !cachedAgents) setAgentsLoading(false);
      }
    }

    void loadAgents(true, Boolean(cachedAgents));
    intervalId = window.setInterval(() => void loadAgents(false, true), AGENT_REFRESH_INTERVAL_MS);

    return () => {
      cancelled = true;
      if (intervalId !== null) window.clearInterval(intervalId);
    };
  }, [connection, selectedTeamId]);

  if (!connection || !organizationCacheKey) {
    return (
      <section className="agent-create-view">
        <div className="agent-create-empty">
          <p>Connect an OpenPond account before viewing agents.</p>
          <button type="button" onClick={onOpenSettings}>
            Open account
          </button>
        </div>
      </section>
    );
  }

  return (
    <section className="agent-create-view" aria-label="Agents">
      {error ? <div className="agent-create-error">{error}</div> : null}

      {loadingInitialAgents ? (
        <div className="agent-create-loading" aria-label="Loading agents" role="status">
          <span />
        </div>
      ) : !selectedTeamId || (agents.length === 0 && !agentsLoading) ? (
        <div className="agent-create-empty">
          <p>No agents yet.</p>
        </div>
      ) : (
        <div className="agent-card-grid" aria-busy={agentsLoading}>
          {agents.map((agent) => (
            <AgentCard agent={agent} key={agent.id} />
          ))}
        </div>
      )}
    </section>
  );
}

function AgentCard({ agent }: { agent: SandboxAgent }) {
  const description = agent.description?.trim() || "No description";
  return (
    <article className="agent-card">
      <div className="agent-card-topline">
        <span>{agent.status}</span>
        <span>{agent.triggerType}</span>
      </div>
      <strong>{agent.name}</strong>
      <p>{description}</p>
      <div className="agent-card-footer">
        <span>{agent.defaultWorkflowMode}</span>
        <span>{formatAgentDate(agent.updatedAt)}</span>
      </div>
    </article>
  );
}

function formatAgentDate(value: string | null | undefined): string {
  if (!value) return "Updated";
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return "Updated";
  return date.toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
  });
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
