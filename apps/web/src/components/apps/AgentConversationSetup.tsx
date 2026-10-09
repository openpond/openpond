import { useState } from "react";
import { navigateDesktopRoute } from "../labs/lab-primary-tab-state";
import dayjs from "dayjs";
import relativeTime from "dayjs/plugin/relativeTime";
dayjs.extend(relativeTime);
import type { TrainingProject } from "openpond-sdk/training-projects";
import type { AccountState } from "@openpond/contracts";
import { apiFetch, type ClientConnection } from "../../api/api-client";
import { NativeSetupTerminal } from "../terminal/NativeSetupTerminal";
import type { AgentInventory, AgentSource } from "./agent-connections";
import { collectionState } from "./agent-connections";

export function AgentConversationSetup({
  agent,
  inventory,
  connection,
  account,
  teamId,
  projects,
  projectId,
  onRefresh,
  learningUrl,
}: {
  agent: AgentSource;
  inventory: AgentInventory | null;
  connection: ClientConnection | null;
  account: AccountState | null;
  teamId: string | null;
  projects: TrainingProject[];
  projectId: string;
  onRefresh(): Promise<void>;
  learningUrl: string | null;
}) {
  const sources =
    inventory?.sources.filter((item) => item.source === agent.id) ?? [];
  const [sourceId, setSourceId] = useState(
    sources.length === 1 ? sources[0]!.instanceId : "",
  );
  const [destination, setDestination] = useState(projectId);
  const [range, setRange] = useState("week");
  const [command, setCommand] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const source =
    sources.find((item) => item.instanceId === sourceId) ??
    (!sourceId && sources.length === 1 ? sources[0] : undefined);
  const connections =
    inventory?.collector.connections.filter(
      (item) => item.source === agent.id,
    ) ?? [];
  const accountBaseUrl = account?.baseUrl ?? account?.activeProfile?.baseUrl;
  const apiBaseUrl = account?.apiBaseUrl;
  async function action(action: string, connectionId?: string) {
    if (!connection || busy || command) return;
    setBusy(true);
    setError(null);
    try {
      const result = await apiFetch<{ command?: string }>(
        connection,
        "/v1/native-history/collector",
        {
          method: "POST",
          body: JSON.stringify({
            command: action,
            ...(connectionId ? { connectionId } : {}),
            ...(action === "connect"
              ? {
                  setup: {
                    sourceInstanceId: source?.instanceId,
                    teamId,
                    projectId: destination,
                    accountBaseUrl,
                    apiBaseUrl,
                    range,
                  },
                }
              : {}),
          }),
        },
      );
      if (result.command) setCommand(result.command);
      else await onRefresh();
    } catch (failure) {
      setError(
        failure instanceof Error
          ? failure.message
          : "Unable to update this connection.",
      );
    } finally {
      setBusy(false);
    }
  }
  const disabled = busy || command !== null;
  return (
    <div className="agent-conversation-setup provider-dialog-body">
      <p>
        Sync saved {agent.name} conversations to an existing OpenPond project.
        Setup uses the OpenPond CLI and browser authorization.
      </p>
      {connections.map((item) => (
        <section
          className="agent-retained-connection"
          key={item.id}
          aria-label={`${agent.name} sync connection`}
        >
          <strong>{collectionState(item, inventory!.collector)}</strong>
          <span>
            Project:{" "}
            {item.teamId === teamId
              ? (projects.find((project) => project.id === item.projectId)
                  ?.content.name ?? item.projectId)
              : item.projectId}{" "}
            · Team: {item.teamId}
          </span>
          <small>{item.accountBaseUrl ?? "Hosted destination"}</small>
          <small className="agent-source-path">{item.sourceRoot}</small>
          <span>
            {item.admitted} tasks imported · {item.queued} updates queued
          </span>
          {item.backfill.total > 0 && item.backfill.stage !== "complete" ? (
            <>
              <progress
                aria-label="History import progress"
                value={item.backfill.admitted + item.backfill.skipped}
                max={item.backfill.total}
              />
              <small>
                {item.backfill.admitted + item.backfill.skipped} of{" "}
                {item.backfill.total} conversations processed
              </small>
            </>
          ) : null}
          <small>
            {item.lastAdmissionAt
              ? `Last synced ${dayjs(item.lastAdmissionAt).fromNow()}`
              : "No uploads acknowledged yet"}
          </small>
          {item.error ? <p role="alert">{item.error}</p> : null}
          <div className="settings-button-row">
            {item.state === "disconnected" ? (
              <button
                type="button"
                disabled={disabled}
                onClick={() => void action("reconnect", item.id)}
              >
                Reconnect
              </button>
            ) : (
              <>
                <button
                  type="button"
                  disabled={disabled}
                  onClick={() =>
                    void action(
                      item.state === "paused" ? "resume" : "pause",
                      item.id,
                    )
                  }
                >
                  {item.state === "paused" ? "Resume" : "Pause"}
                </button>
                <button
                  type="button"
                  disabled={disabled}
                  onClick={() => {
                    if (
                      window.confirm(
                        "Disconnect this conversation source? Imported data stays in its project.",
                      )
                    )
                      void action("disconnect", item.id);
                  }}
                >
                  Disconnect
                </button>
              </>
            )}
            {item.destinationLinks.tasks ? (
              <a
                href={item.destinationLinks.tasks}
                target="_blank"
                rel="noreferrer"
              >
                View tasks
              </a>
            ) : null}
            {item.destinationLinks.conversations ? (
              <a
                href={item.destinationLinks.conversations}
                target="_blank"
                rel="noreferrer"
              >
                View conversations
              </a>
            ) : null}
          </div>
        </section>
      ))}
      <form
        onSubmit={(event) => {
          event.preventDefault();
          void action("connect");
        }}
        className="agent-sync-form"
      >
        <h3>
          {connections.length
            ? "Add another connection"
            : "Connect conversations"}
        </h3>
        <label className="agent-source-field">
          Source installation
          <select
            aria-label="Source installation"
            value={source?.instanceId ?? ""}
            disabled={disabled}
            onChange={(event) => setSourceId(event.target.value)}
          >
            <option value="">Select installation</option>
            {sources.map((item) => (
              <option
                key={item.instanceId}
                value={item.instanceId}
                disabled={!item.available || !item.capabilities.history}
              >
                {item.root}
                {item.available && item.capabilities.history
                  ? ""
                  : " (unavailable)"}
              </option>
            ))}
          </select>
        </label>
        {source?.reason ? <small>{source.reason}</small> : null}
        {!sources.some(
          (item) => item.available && item.capabilities.history,
        ) ? (
          <small>
            No readable conversation history found.{" "}
            {agent.provider
              ? "Use Agent setup to check the installation, or create a conversation in this agent first."
              : "Open this agent and create a conversation, then refresh connections."}
          </small>
        ) : null}
        <label>
          Project
          <select
            aria-label="Project"
            value={destination}
            disabled={disabled || !teamId}
            onChange={(event) => setDestination(event.target.value)}
          >
            <option value="">Select project</option>
            {projects.map((item) => (
              <option value={item.id} key={item.id}>
                {item.content.name}
              </option>
            ))}
          </select>
        </label>
        <label>
          Import history
          <select
            aria-label="Import history"
            value={range}
            disabled={disabled}
            onChange={(event) => setRange(event.target.value)}
          >
            <option value="day">Last day</option>
            <option value="week">Last week</option>
            <option value="all">All history</option>
          </select>
        </label>
        <p>This imports the selected history once and shows progress in the CLI. Continual imports are off by default and can be scheduled in Settings.</p>
        <button type="button" onClick={() => navigateDesktopRoute({ kind: "settings", section: "conversation-imports" })}>Manage continual imports in Settings</button>
        {account?.state !== "signed_in" || !teamId ? (
          <small>
            Sign in and select a default team in Account settings to choose a
            hosted project.
          </small>
        ) : null}
        <button
          type="submit"
          className="agent-connect-button"
          disabled={
            disabled ||
            !source?.available ||
            !source.capabilities.history ||
            !projects.some((item) => item.id === destination) ||
            !teamId ||
            !accountBaseUrl ||
            !apiBaseUrl ||
            account?.state !== "signed_in"
          }
        >
          {busy ? "Opening setup…" : "Connect conversations"}
        </button>
      </form>
      {learningUrl ? (
        <a
          className="agent-learning-link"
          href={learningUrl}
          target="_blank"
          rel="noreferrer"
        >
          Configure continual learning in Console
        </a>
      ) : null}
      {inventory ? (
        <details>
          <summary>CLI setup</summary>
          <small className="agent-source-path">
            Importer directory: {inventory.directory}
          </small>
          <code>{inventory.statusCommand}</code>
        </details>
      ) : null}
      {error ? <p role="alert">{error}</p> : null}
      {command && connection ? (
        <NativeSetupTerminal
          connection={connection}
          command={command}
          onComplete={() => {
            setCommand(null);
            void onRefresh();
          }}
          onClose={() => {
            setCommand(null);
            void onRefresh();
          }}
        />
      ) : null}
    </div>
  );
}
