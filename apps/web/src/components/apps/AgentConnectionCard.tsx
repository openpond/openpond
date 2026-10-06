import type { ReactNode } from "react";
import type { AccountState, ProviderStatus } from "@openpond/contracts";
import type { TrainingProject } from "openpond-sdk/training-projects";
import { navigateDesktopRoute } from "../labs/lab-primary-tab-state";
import { X } from "../icons";
import type { AgentInventory, AgentSource } from "./agent-connections";
import { collectionState } from "./agent-connections";

export function AgentConnectionCard({
  agent,
  account,
  native,
  inventory,
  projects,
  teamId,
  learningControl,
  connected,
  onHide,
  onManage,
}: {
  agent: AgentSource;
  account: AccountState | null;
  native: ProviderStatus | null | undefined;
  inventory: AgentInventory | null;
  projects: TrainingProject[];
  teamId: string | null;
  learningControl: ReactNode;
  connected: boolean;
  onHide(): void;
  onManage(): void;
}) {
  const connections =
    inventory?.collector.connections.filter((item) => item.source === agent.id) ?? [];
  const readable = inventory?.sources.some(
    (item) => item.source === agent.id && item.available && item.capabilities.history,
  );
  return (
    <article className="agent-connection-card" aria-label={agent.name}>
      <div className="agent-card-title">
        <img src={agent.icon} alt="" />
        <span>{agent.name}</span>
        <button
          type="button"
          className="agent-hide"
          aria-label={`Hide ${agent.name}`}
          onClick={onHide}
        >
          <X size={14} />
        </button>
      </div>
      {agent.id === "openpond_chat" ? (
        <>
          <small>
            {account?.state === "signed_in" ? "Connected to OpenPond" : "Sign in to OpenPond"}
          </small>
          <p>Use Ponder Pal from the sidebar.</p>
          <button
            type="button"
            className="agent-account-link"
            onClick={() =>
              void navigateDesktopRoute({
                kind: "settings",
                section: "account",
              })
            }
          >
            Account setup
          </button>
        </>
      ) : (
        <>
          <small>
            {native
              ? native.available
                ? native.enabled
                  ? "Ready to chat"
                  : "Installed · chat disabled"
                : (native.lastError ?? "Check installation")
              : "Conversation import"}
          </small>
          <button
            type="button"
            className="agent-connect-button"
            disabled={!connected}
            onClick={onManage}
          >
            {native?.available || connections.length ? "Manage" : "Connect"}
          </button>
          <div className="agent-card-sync">
            {connections.length ? (
              connections.map((item) => (
                <div key={item.id}>
                  <span>{collectionState(item, inventory!.collector)}</span>
                  <small>
                    {projects.find(
                      (project) => project.id === item.projectId && item.teamId === teamId,
                    )?.content.name ?? item.projectId}{" "}
                    · {item.admitted} tasks
                  </small>
                  {item.teamId !== teamId ? <small>Team: {item.teamId}</small> : null}
                  {item.queued ? <small>{item.queued} updates queued</small> : null}
                  {item.lastAdmissionAt ? (
                    <small>Last sync: {new Date(item.lastAdmissionAt).toLocaleString()}</small>
                  ) : null}
                  {item.error ? <small role="alert">{item.error}</small> : null}
                </div>
              ))
            ) : (
              <small>
                {inventory
                  ? readable
                    ? "History available · sync not connected"
                    : "No local history found"
                  : "Reading local setup…"}
              </small>
            )}
          </div>
        </>
      )}
      {learningControl}
    </article>
  );
}
