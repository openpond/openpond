import { useMemo, useState } from "react";
import type { ClientConnection } from "../../../api/api-client";
import type { AgentInventory, AgentSource } from "../agent-connections";
import {
  sourceKey,
  type ConversationPolicy,
  type SourceBinding,
  type ServingTarget,
} from "./contracts";
import { learningRequest, saveLearningPolicy, type useLearningOptions } from "./client";
import { AgentLearningDialog } from "./AgentLearningDialog";
import { useAgentDialogFocus } from "../useAgentDialogFocus";
import { X } from "../../icons";

export function AgentLearningControl({
  agent,
  inventory,
  connection,
  teamId,
  projectId,
  projectName,
  query,
  signedIn,
}: {
  agent: AgentSource;
  inventory: AgentInventory | null;
  connection: ClientConnection | null;
  teamId: string | null;
  projectId: string;
  projectName: string;
  query: ReturnType<typeof useLearningOptions>;
  signedIn: boolean;
}) {
  const [open, setOpen] = useState(false),
    [joinId, setJoinId] = useState<string | null>(null),
    [busy, setBusy] = useState(false),
    [error, setError] = useState<string | null>(null),
    [instance, setInstance] = useState("");
  const localIds = useMemo(
    () =>
      new Set(
        inventory?.collector.connections
          .filter(
            (item) =>
              item.source === agent.id &&
              item.teamId === teamId &&
              item.projectId === projectId &&
              item.state !== "disconnected",
          )
          .map((item) => item.sourceInstanceId) ?? [],
      ),
    [inventory, agent.id, teamId, projectId],
  );
  const sources =
    query.data?.sources.filter(
      (source) =>
        source.projectId === projectId &&
        (agent.id === "openpond_chat"
          ? ["native_chat", "native_work"].includes(source.origin) &&
            source.sourceInstanceId === null
          : source.origin === agent.id &&
            source.sourceInstanceId !== null &&
            localIds.has(source.sourceInstanceId)),
    ) ?? [];
  const instanceIds = [
    ...new Set(
      sources.flatMap((source) => (source.sourceInstanceId ? [source.sourceInstanceId] : [])),
    ),
  ];
  const selectedInstance = instanceIds.includes(instance) ? instance : instanceIds[0];
  const bindings: SourceBinding[] = sources
    .filter(
      (source) => source.sourceInstanceId === null || source.sourceInstanceId === selectedInstance,
    )
    .map((source) => ({
      origin: source.origin,
      sourceInstanceId: source.sourceInstanceId,
      enabled: true,
    }));
  const policies =
    query.data?.policies.filter((policy) => policy.configuration.projectId === projectId) ?? [];
  const enabled = policies.filter(
    (policy) =>
      policy.status === "enabled" &&
      policy.configuration.sources.some(
        (source) =>
          source.enabled && bindings.some((binding) => sourceKey(binding) === sourceKey(source)),
      ),
  );
  const existing =
    enabled[0] ?? policies.find((policy) => policy.status === "enabled") ?? policies[0];
  const available = Boolean(
    connection &&
    teamId &&
    projectId &&
    signedIn &&
    query.data?.projects.some((project) => project.id === projectId),
  );
  async function saveBindings(policy: ConversationPolicy, turnOn: boolean) {
    if (!connection || !teamId || !query.data) return;
    let configuration = {
      ...policy.configuration,
      sources: policy.configuration.sources.map((source) =>
        bindings.some((binding) => sourceKey(binding) === sourceKey(source))
          ? { ...source, enabled: turnOn }
          : source,
      ),
    };
    if (turnOn)
      for (const binding of bindings)
        if (!configuration.sources.some((source) => sourceKey(source) === sourceKey(binding)))
          configuration.sources.push(binding);
    const selectedTarget = query.data.servingTargets.find((target) => target.id === configuration.serving?.targetId);
    if (turnOn && configuration.mode === "activate" && configuration.serving?.targetId && (!selectedTarget || !selectedTarget.enabled || selectedTarget.projectId !== projectId))
      throw new Error("Review the policy's serving target before adding a source.");
    if (
      turnOn &&
      configuration.mode === "activate" &&
      (!configuration.serving?.targetId || selectedTarget?.hostedPonder)
    ) {
      const target = await learningRequest<ServingTarget>(connection, teamId, "serving-targets", {
        action: "ensure_hosted_ponder",
        projectId,
        bindingId: query.data.ponderBindingId,
      });
      configuration = {
        ...configuration,
        serving: {
          targetId: target.id,
          canarySeconds: configuration.serving?.canarySeconds ?? 120,
          rollbackOnRuntimeFailure: true,
        },
      };
    }
    return saveLearningPolicy(
      connection,
      teamId,
      policy,
      configuration,
      configuration.sources.some((source) => source.enabled),
    );
  }
  async function mutate(turnOn: boolean) {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      if (turnOn) {
        const policy = policies.find((item) => item.id === joinId);
        if (!policy) throw new Error("Refresh the learning policy before joining.");
        await saveBindings(policy, true);
        setJoinId(null);
      } else for (const policy of enabled) await saveBindings(policy, false);
      await query.refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Unable to update this learning source.");
      await query.refresh();
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="agent-learning-control">
      {instanceIds.length > 1 ? (
        <label>
          Learning connection
          <select
            aria-label={`${agent.name} learning connection`}
            value={selectedInstance}
            disabled={busy}
            onChange={(event) => setInstance(event.target.value)}
          >
            {instanceIds.map((id) => (
              <option key={id} value={id}>
                {sources.find((source) => source.sourceInstanceId === id)?.name ??
                  "Local connection"}
              </option>
            ))}
          </select>
        </label>
      ) : null}
      <div className="agent-learning-control-row">
        <label className="provider-toggle">
          <input
            type="checkbox"
            aria-label={`${agent.name} continual learning`}
            checked={enabled.length > 0}
            disabled={!available || !bindings.length || query.isPending || query.isError || busy}
            onChange={(event) => {
              if (event.target.checked) {
                const active = policies.find((policy) => policy.status === "enabled");
                if (active) setJoinId(active.id);
                else setOpen(true);
              } else void mutate(false);
            }}
          />
          <span aria-hidden="true" />
        </label>
        <button
          type="button"
          className="agent-learning-settings"
          disabled={!connection || !teamId || !projectId || !signedIn || busy}
          onClick={() => setOpen(true)}
        >
          Continual learning
        </button>
        <small>
          {query.isError
            ? "Needs attention"
            : query.isPending
              ? "Loading…"
              : enabled.length
                ? "On schedule"
                : policies.length
                  ? "Paused"
                  : "Off"}
        </small>
      </div>
      {!projectId ? (
        <small>Select a hosted Project for continual learning.</small>
      ) : !bindings.length && query.data ? (
        <small>Sync this agent to the selected Project to use its local connection.</small>
      ) : null}
      {error ? <small role="alert">{error}</small> : null}
      {open && connection && teamId ? (
        <AgentLearningDialog
          key={projectId}
          connection={connection}
          teamId={teamId}
          projectId={projectId}
          projectName={projectName}
          initialPolicy={existing}
          bindings={bindings}
          query={query}
          onClose={() => setOpen(false)}
        />
      ) : null}
      {joinId ? (
        <LearningJoinDialog
          policies={policies.filter((policy) => policy.status === "enabled")}
          policyId={joinId}
          agentName={agent.name}
          busy={busy}
          error={error}
          onChoose={setJoinId}
          onClose={() => {
            if (!busy) setJoinId(null);
          }}
          onJoin={() => void mutate(true)}
        />
      ) : null}
    </div>
  );
}
function LearningJoinDialog({
  policies,
  policyId,
  agentName,
  busy,
  error,
  onChoose,
  onClose,
  onJoin,
}: {
  policies: ConversationPolicy[];
  policyId: string;
  agentName: string;
  busy: boolean;
  error: string | null;
  onChoose(value: string): void;
  onClose(): void;
  onJoin(): void;
}) {
  const ref = useAgentDialogFocus(onClose),
    policy = policies.find((item) => item.id === policyId);
  return (
    <div className="git-dialog-backdrop provider-dialog-backdrop" onMouseDown={onClose}>
      <section
        ref={ref}
        className="git-dialog agent-learning-join"
        role="dialog"
        aria-modal="true"
        aria-label="Add learning source"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <button
          type="button"
          className="git-dialog-close"
          disabled={busy}
          aria-label="Cancel"
          onClick={onClose}
        >
          <X size={16} />
        </button>
        <h2>
          Add {agentName} to {policy?.configuration.name ?? "continual learning"}?
        </h2>
        <p>
          This agent will contribute conversations to the existing model, schedule and spending
          limits. Collection settings stay unchanged.
        </p>
        {policies.length > 1 ? (
          <label>
            Existing policy
            <select
              value={policyId}
              disabled={busy}
              onChange={(event) => onChoose(event.target.value)}
            >
              {policies.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.configuration.name}
                </option>
              ))}
            </select>
          </label>
        ) : null}
        {error ? <p role="alert">{error}</p> : null}
        <div className="settings-button-row">
          <button type="button" disabled={busy} onClick={onClose}>
            Cancel
          </button>
          <button type="button" className="primary" disabled={busy || !policy} onClick={onJoin}>
            {busy ? "Adding…" : "Add agent"}
          </button>
        </div>
      </section>
    </div>
  );
}
