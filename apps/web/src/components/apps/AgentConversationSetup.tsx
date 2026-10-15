import { ErrorToast } from "../common/ErrorToast";
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
import { DropdownSelect } from "../DropdownSelect";
import { ConversationUploadPicker } from "./ConversationUploadPicker";

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
  const [uploadConnectionId, setUploadConnectionId] = useState<string | null>(null);
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
  async function action(action: string, connectionId?: string, sessionKeys?: string[]) {
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
            ...(sessionKeys ? { sessionKeys } : {}),
            ...(action === "connect"
              ? {
                  setup: {
                    sourceInstanceId: source?.instanceId,
                    teamId,
                    projectId: destination,
                    accountBaseUrl,
                    apiBaseUrl,
                    range: "all",
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
  const selectedConnection = connections.find(item => item.id === uploadConnectionId);
  const terminal = command && connection ? <NativeSetupTerminal
    connection={connection} command={command}
    onComplete={() => { setCommand(null); setUploadConnectionId(null); void onRefresh(); }}
    onClose={() => { setCommand(null); void onRefresh(); }} /> : null;
  if (selectedConnection && connection) return <div className="agent-conversation-setup provider-dialog-body">
    <ConversationUploadPicker key={selectedConnection.id} connection={connection} connectionId={selectedConnection.id}
      projectName={projects.find(project => project.id === selectedConnection.projectId && selectedConnection.teamId === teamId)?.content.name ?? selectedConnection.projectId}
      disabled={disabled || !!inventory?.collector.running} onClose={() => setUploadConnectionId(null)}
      onUpload={keys => action("upload", selectedConnection.id, keys)} />
    {error ? <ErrorToast error={error} /> : null}
    {terminal}
  </div>;
  return (
    <div className="agent-conversation-setup provider-dialog-body">
      <p>
        Sync saved {agent.name} conversations to an existing OpenPond project.
        Connecting authorizes the destination. Choose conversations and confirm an upload when ready.
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
          <small>{item.selectedConversations === null ? "All history approved for sync" : `${item.selectedConversations} conversations approved for sync`}</small>
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
          {item.error ? <ErrorToast error={item.error} /> : null}
          <div className="settings-button-row">
            <button type="button" className="agent-connect-button" disabled={disabled || item.state !== "active" || inventory?.collector.running}
              onClick={() => setUploadConnectionId(item.id)}>Choose conversations…</button>
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
          <DropdownSelect label="Source installation" value={source?.instanceId ?? ""} disabled={disabled} onChange={setSourceId}
            options={[{ value: "", label: "Select installation" }, ...sources.map(item => ({ value: item.instanceId, label: item.root,
              disabled: !item.available || !item.capabilities.history }))]} />
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
          <DropdownSelect label="Upload destination project" value={destination} disabled={disabled || !teamId} onChange={setDestination}
            searchable options={[{ value: "", label: "Select project" }, ...projects.map(item => ({ value: item.id, label: item.content.name }))]} />
        </label>
        <p>No conversations are uploaded during setup. Continual imports are off by default and can be scheduled after choosing conversations.</p>
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
      {error ? <ErrorToast error={error} /> : null}
      {terminal}
    </div>
  );
}
