import type { BootstrapPayload, LocalAgentSchedule } from "@openpond/contracts";
import type { ClientConnection } from "../../api";
import { useLocalAgentSchedules } from "../agents/LocalAgentSchedulesPanel";
import { Bot, Pause, Play, RefreshCw, RotateCcw } from "../icons";
import { useErrorToast } from "../../app/AppToastContext";

type ProfileState = NonNullable<BootstrapPayload["profile"]>;
type ProfileAgent = ProfileState["agents"][number];
type ProfileStatusCell = {
  state: "ready" | "warning" | "loading" | "disabled";
  label: string;
};

export function ProfileAgentsSection({
  connection,
  profile,
  selectedDefaultTeamId,
}: {
  connection: ClientConnection | null;
  profile: ProfileState;
  selectedDefaultTeamId: string;
}) {
  const schedules = useLocalAgentSchedules(connection);
  useErrorToast(schedules.error, { prefix: "Local schedules" });

  return (
    <div className="account-list profile-agent-list" aria-label="Profile agents">
      <div className="account-list-heading profile-agent-list-heading">
        <span>Agents</span>
        <div className="profile-skill-heading-actions">
          <small>{scheduleHeadingLabel(schedules.schedules.length, schedules.loading)}</small>
        </div>
      </div>
      {profile.agents.length || schedules.schedules.length ? (
        <div className="profile-agent-table-frame">
          <table className="profile-agent-table" aria-label="Profile agents table">
            <colgroup>
              <col className="profile-agent-column" />
              <col className="profile-action-column" />
              <col className="profile-check-column" />
              <col className="profile-sync-column" />
            </colgroup>
            <thead>
              <tr>
                <th scope="col">Agent</th>
                <th scope="col">Action</th>
                <th scope="col">Check</th>
                <th scope="col">Sync</th>
              </tr>
            </thead>
            <tbody>
              {profile.agents.map((agent) => (
                <ProfileAgentRow
                  agent={agent}
                  defaultAction={profile.summary.defaultAction}
                  key={agent.id}
                  profile={profile}
                  selectedDefaultTeamId={selectedDefaultTeamId}
                />
              ))}
              {schedules.schedules.map((schedule) => (
                <ProfileScheduleAgentRow
                  key={schedule.id}
                  pending={schedules.pendingScheduleIds.has(schedule.id)}
                  schedule={schedule}
                  refreshing={schedules.loading}
                  onRefresh={() => void schedules.refresh()}
                  onRun={() => void schedules.run(schedule)}
                  onToggle={() => void schedules.toggle(schedule)}
                />
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <div className="empty-account-list">
          <strong>No profile agents found</strong>
          <span>Create an agent, then run Profile checks to add it to the catalog.</span>
        </div>
      )}
    </div>
  );
}

function ProfileAgentRow({
  agent,
  defaultAction,
  profile,
  selectedDefaultTeamId,
}: {
  agent: ProfileAgent;
  defaultAction: string | null;
  profile: ProfileState;
  selectedDefaultTeamId: string;
}) {
  const rowStatus = profileAgentRowStatus(profile, agent, selectedDefaultTeamId);
  return (
    <tr className="profile-agent-row">
      <td>
        <div className="profile-agent-identity">
          <Bot size={18} />
          <div>
            <strong>{agent.name}</strong>
            <span title={agent.path}>{agent.path}</span>
          </div>
        </div>
      </td>
      <td><div className="profile-agent-action"><span>{defaultAction ?? "None"}</span></div></td>
      <td><ProfileStatusText status={rowStatus.check} /></td>
      <td><ProfileStatusText status={rowStatus.sync} /></td>
    </tr>
  );
}

function ProfileScheduleAgentRow({
  pending,
  refreshing,
  schedule,
  onRefresh,
  onRun,
  onToggle,
}: {
  pending: boolean;
  refreshing: boolean;
  schedule: LocalAgentSchedule;
  onRefresh: () => void;
  onRun: () => void;
  onToggle: () => void;
}) {
  const status = localScheduleStatus(schedule);
  const toggleLabel = schedule.enabled ? "Pause schedule" : "Resume schedule";
  return (
    <tr className="profile-agent-row profile-schedule-agent-row">
      <td>
        <div className="profile-agent-identity">
          <Bot size={18} />
          <div>
            <strong>{schedule.localProjectName}</strong>
            <span title={schedule.scheduleName}>schedule: {schedule.scheduleName}</span>
          </div>
        </div>
      </td>
      <td><div className="profile-agent-action"><span title={schedule.targetAction}>{schedule.targetAction}</span></div></td>
      <td><ProfileStatusText status={status} /></td>
      <td>
        <div className="profile-schedule-actions">
          <span className="profile-schedule-expression" title={localScheduleTitle(schedule)}>
            {schedule.enabled ? schedule.scheduleExpression : "Paused"}
          </span>
          <div className="profile-schedule-controls" aria-label={`${schedule.scheduleName} schedule controls`}>
            <button
              className="settings-icon-button profile-schedule-button"
              disabled={refreshing}
              type="button"
              title="Refresh local schedules"
              aria-label="Refresh local schedules"
              onClick={onRefresh}
            >
              <RefreshCw size={14} className={refreshing ? "settings-spin" : undefined} />
            </button>
            <button
              className="settings-icon-button profile-schedule-button"
              disabled={pending}
              type="button"
              title="Run now"
              aria-label={`Run ${schedule.scheduleName} now`}
              onClick={onRun}
            >
              <RotateCcw size={14} />
            </button>
            <button
              className="settings-icon-button profile-schedule-button"
              disabled={pending}
              type="button"
              title={toggleLabel}
              aria-label={`${toggleLabel}: ${schedule.scheduleName}`}
              onClick={onToggle}
            >
              {schedule.enabled ? <Pause size={14} /> : <Play size={14} />}
            </button>
          </div>
        </div>
      </td>
    </tr>
  );
}

function ProfileStatusText({ status }: { status: ProfileStatusCell }) {
  return <span className={`profile-status-text ${status.state}`}>{status.label}</span>;
}

function scheduleHeadingLabel(count: number, loading: boolean): string {
  if (loading && count === 0) return "Loading schedules";
  if (loading) return `${count} scheduled, refreshing`;
  if (count === 1) return "1 scheduled";
  if (count > 1) return `${count} scheduled`;
  return "No schedules";
}

function localScheduleStatus(schedule: LocalAgentSchedule): ProfileStatusCell {
  if (!schedule.enabled) return { state: "disabled", label: "Paused" };
  if (schedule.lastError || schedule.lastRunStatus === "failed") return { state: "warning", label: "Failed" };
  if (schedule.lastRunStatus === "running") return { state: "loading", label: "Running" };
  if (schedule.lastRunStatus === "queued") return { state: "loading", label: "Queued" };
  if (schedule.lastRunStatus === "skipped") return { state: "warning", label: "Skipped" };
  if (schedule.lastRunStatus === "succeeded") return { state: "ready", label: "Succeeded" };
  return { state: "loading", label: "Scheduled" };
}

function localScheduleTitle(schedule: LocalAgentSchedule): string {
  const parts = [`${schedule.scheduleType}: ${schedule.scheduleExpression}`];
  if (schedule.nextRunAt) parts.push(`next ${formatScheduleDate(schedule.nextRunAt)}`);
  if (schedule.lastRunAt) parts.push(`last ${formatScheduleDate(schedule.lastRunAt)}`);
  return parts.join(" - ");
}

function formatScheduleDate(value: string): string {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return value;
  return date.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

function profileAgentRowStatus(
  profile: ProfileState,
  agent: ProfileAgent,
  selectedDefaultTeamId: string,
): { check: ProfileStatusCell; sync: ProfileStatusCell } {
  if (!agent.enabled) {
    return {
      check: { state: "disabled", label: "Disabled" },
      sync: { state: "disabled", label: "Disabled" },
    };
  }
  if (profile.error) {
    return {
      check: { state: "warning", label: "Error" },
      sync: { state: "warning", label: "Blocked" },
    };
  }
  if (profile.setupGate.blockingCount > 0) {
    return {
      check: { state: "warning", label: "Setup" },
      sync: { state: "warning", label: "Blocked" },
    };
  }

  if (profile.git?.dirty || profileAgentChangeCount(profile, agent) > 0) {
    return {
      check: { state: "loading", label: "Pending" },
      sync: { state: "warning", label: "Changed" },
    };
  }
  if (profile.catalog.stale) {
    return {
      check: { state: "loading", label: "Stale" },
      sync: { state: "loading", label: "Waiting" },
    };
  }
  if (!profile.lastCheck) {
    return {
      check: { state: "loading", label: "Unchecked" },
      sync: { state: "loading", label: "Waiting" },
    };
  }
  if (profile.lastCheck.status === "failed") {
    return {
      check: { state: "warning", label: "Failed" },
      sync: { state: "warning", label: "Blocked" },
    };
  }
  if (!profile.summary.checkFresh) {
    return {
      check: { state: "loading", label: "Stale" },
      sync: { state: "loading", label: "Waiting" },
    };
  }
  if (profileHostedTeamMismatch(profile, selectedDefaultTeamId)) {
    return {
      check: { state: "ready", label: "Passed" },
      sync: { state: "warning", label: "Sync acct" },
    };
  }

  const localHead = profile.summary.localHead ?? profile.git?.head ?? null;
  const pushedLocalHead = profile.hosted?.lastPushedLocalHead ?? null;
  const hostedUploadHead = profile.summary.hostedHead ?? profile.hosted?.sourceCommitSha ?? null;
  if (!hostedUploadHead && !pushedLocalHead) {
    return {
      check: { state: "ready", label: "Passed" },
      sync: { state: "loading", label: "Not synced" },
    };
  }
  if (localHead && pushedLocalHead && localHead !== pushedLocalHead) {
    return {
      check: { state: "ready", label: "Passed" },
      sync: { state: "loading", label: "Needed" },
    };
  }
  return {
    check: { state: "ready", label: "Passed" },
    sync: { state: "ready", label: "Synced" },
  };
}

function profileHostedTeamMismatch(profile: ProfileState, selectedDefaultTeamId: string): boolean {
  const hostedTeamId = profile.hosted?.teamId?.trim() ?? "";
  return Boolean(hostedTeamId && selectedDefaultTeamId && hostedTeamId !== selectedDefaultTeamId);
}

function profileAgentChangeCount(profile: ProfileState, agent: ProfileAgent): number {
  let count = 0;
  if (profile.diff.changedAgents.includes(agent.id)) count += 1;
  if (profile.diff.newAgents.includes(agent.id)) count += 1;
  if (profile.diff.deletedAgents.includes(agent.id)) count += 1;
  const normalizedAgentPath = agent.path.replace(/^profiles\/[^/]+\//, "");
  for (const file of profile.diff.files) {
    const normalizedFilePath = file.path.replace(/^profiles\/[^/]+\//, "");
    if (
      normalizedFilePath === normalizedAgentPath ||
      normalizedFilePath.startsWith(`${normalizedAgentPath}/`) ||
      normalizedFilePath.startsWith(`agents/${agent.id}/`)
    ) {
      count += 1;
    }
  }
  return count;
}
