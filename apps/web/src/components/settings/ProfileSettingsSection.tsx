import { useEffect, useMemo, useState } from "react";
import type { Approval, BootstrapPayload } from "@openpond/contracts";
import {
  Bot,
  CheckCircle2,
  FileText,
  GitCommit,
  PackageCheck,
  Plus,
  RefreshCw,
  UploadCloud,
} from "../icons";
import { api, type ClientConnection } from "../../api";
import { AccountStateBadge } from "../account/AccountBadges";

type ProfileSettingsSectionProps = {
  payload: BootstrapPayload | null;
  connection: ClientConnection | null;
  onPayload: (payload: BootstrapPayload) => void;
  onError: (message: string | null) => void;
  onToast?: (message: string, tone?: "success" | "error" | "info") => void;
};

export function ProfileSettingsSection({
  payload,
  connection,
  onPayload,
  onError,
  onToast,
}: ProfileSettingsSectionProps) {
  const [profilePath, setProfilePath] = useState("");
  const [profileName, setProfileName] = useState("default");
  const [profileCommitMessage, setProfileCommitMessage] = useState("");
  const [profileBusy, setProfileBusy] = useState<string | null>(null);
  const profile = payload?.profile ?? null;
  const selectedDefaultTeamId = payload?.preferences.defaultTeamId?.trim() || "";
  const pendingCreatePlanReviews = useMemo(
    () => profileCreatePlanReviews(payload?.approvals ?? []),
    [payload?.approvals],
  );
  const setupRequirementCount = useMemo(
    () =>
      (profile?.actionCatalog ?? []).reduce(
        (count, action) => count + (action.setupRequirements?.length ?? 0),
        0,
      ),
    [profile?.actionCatalog],
  );

  useEffect(() => {
    if (!profile) return;
    setProfilePath((current) => current || profile.repoPath || "");
    setProfileName((current) => current || profile.activeProfile || "default");
  }, [profile]);

  async function refreshBootstrapAfterProfileChange(message: string) {
    if (!connection) return;
    onPayload(await api.bootstrap(connection));
    onToast?.(message, "success");
  }

  async function runProfileControl(action: string, task: () => Promise<void>) {
    if (!connection || profileBusy) return;
    setProfileBusy(action);
    onError(null);
    try {
      await task();
    } catch (caught) {
      onError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setProfileBusy(null);
    }
  }

  function submitProfileInit() {
    void runProfileControl("init", async () => {
      await api.profileInit(connection!, {
        path: profilePath.trim() || null,
        profile: profileName.trim() || "default",
      });
      await refreshBootstrapAfterProfileChange("Profile initialized");
    });
  }

  function submitProfileLoad() {
    void runProfileControl("load", async () => {
      const path = profilePath.trim();
      if (!path) throw new Error("Profile repo path is required.");
      await api.profileLoad(connection!, {
        path,
        profile: profileName.trim() || null,
      });
      await refreshBootstrapAfterProfileChange("Profile loaded");
    });
  }

  function submitProfileCheck() {
    void runProfileControl("check", async () => {
      await api.profileCheck(connection!, { kind: "all" });
      await refreshBootstrapAfterProfileChange("Profile checks finished");
    });
  }

  function submitProfileCommit() {
    void runProfileControl("commit", async () => {
      await api.profileCommit(connection!, {
        message: profileCommitMessage.trim() || null,
      });
      setProfileCommitMessage("");
      await refreshBootstrapAfterProfileChange("Profile commit complete");
    });
  }

  function submitProfilePush() {
    void runProfileControl("push", async () => {
      if (!selectedDefaultTeamId) {
        throw new Error("Select a default team before pushing a hosted profile.");
      }
      await api.profilePush(connection!, {
        teamId: selectedDefaultTeamId,
        ensureHosted: true,
        message: profileCommitMessage.trim() || null,
      });
      setProfileCommitMessage("");
      await refreshBootstrapAfterProfileChange("Profile pushed to hosted profile repo");
    });
  }

  return (
    <section className="account-settings">
      <div className="account-settings-title">
        <h1>Profile</h1>
        <button
          className="settings-icon-button ghost"
          disabled={!connection || Boolean(profileBusy)}
          title="Refresh profile"
          aria-label="Refresh profile"
          type="button"
          onClick={() => {
            if (!connection) return;
            void runProfileControl("refresh", async () => {
              onPayload(await api.bootstrap(connection));
            });
          }}
        >
          <RefreshCw size={15} className={profileBusy === "refresh" ? "settings-spin" : undefined} />
        </button>
      </div>

      {profile?.mode === "local" ? (
        <>
          <div className="account-list">
            <div className="account-list-heading">
              <span>Summary</span>
              <small>{profile.summary.state}</small>
            </div>
            <div className="profile-summary-panel">
              <div className="profile-summary-head">
                <div className="account-details">
                  <strong>{profile.activeProfile ?? "default"}</strong>
                  <span title={profile.repoPath ?? undefined}>{profile.repoPath}</span>
                  <span title={profile.sourcePath ?? undefined}>{profile.sourcePath ?? "Source missing"}</span>
                </div>
                <div className="profile-summary-message">
                  {profile.summary?.message ?? profileSyncMessage(profile)}
                </div>
              </div>
              <div className="profile-metric-grid">
                <ProfileMetric label="Git" value={profileGitValue(profile)} />
                <ProfileMetric label="Hosted" value={profileHostedValue(profile)} />
                <ProfileMetric label="Catalog" value={profileCatalogValue(profile)} />
                <ProfileMetric label="Setup gate" value={profileSetupGateValue(profile)} />
                <ProfileMetric label="Default action" value={profile.summary.defaultAction ?? "None"} />
                <ProfileMetric label="Agents" value={`${profile.agents.length} tracked`} />
                <ProfileMetric label="Hosted invocation" value={profileHostedRunValue(profile)} />
                <ProfileMetric label="Plan review" value={profilePlanReviewValue(pendingCreatePlanReviews)} />
              </div>
              {pendingCreatePlanReviews.length ? (
                <div className="profile-plan-review-list" aria-label="Pending profile plan reviews">
                  {pendingCreatePlanReviews.map((approval) => (
                    <div className="profile-plan-review-item" key={approval.id}>
                      <FileText size={14} />
                      <span>
                        <strong>{approval.title}</strong>
                        <small>
                          {approval.detail} - session: {approval.sessionId}
                          {approval.turnId ? ` - turn: ${approval.turnId}` : ""}
                        </small>
                      </span>
                    </div>
                  ))}
                </div>
              ) : null}
              {profileHasChanges(profile) ? (
                <div className="profile-change-list">
                  {profileChangeLines(profile).map((line) => (
                    <span key={line}>{line}</span>
                  ))}
                </div>
              ) : null}
              {profile.lastCheck ? (
                <div className="profile-footline">
                  Last check: {profile.lastCheck.command} {profile.lastCheck.status}
                </div>
              ) : null}
              {profile.summary.checkStaleReason ? (
                <div className="profile-footline">{profile.summary.checkStaleReason}</div>
              ) : null}
              {profile.setupGate.blockingRequirements.length ? (
                <div className="profile-footline warning">
                  Blocking setup:{" "}
                  {profile.setupGate.blockingRequirements
                    .slice(0, 5)
                    .map((requirement) => requirement.label)
                    .join(", ")}
                  {profile.setupGate.blockingRequirements.length > 5
                    ? ` and ${profile.setupGate.blockingRequirements.length - 5} more`
                    : ""}
                </div>
              ) : null}
              {profile.error ? <div className="profile-footline warning">{profile.error}</div> : null}
            </div>
          </div>

          <ProfileControls
            connection={connection}
            profileBusy={profileBusy}
            profileCommitMessage={profileCommitMessage}
            profileName={profileName}
            profilePath={profilePath}
            pushDisabled={!selectedDefaultTeamId || Boolean(profile.git?.dirty)}
            setProfileCommitMessage={setProfileCommitMessage}
            setProfileName={setProfileName}
            setProfilePath={setProfilePath}
            submitProfileCheck={submitProfileCheck}
            submitProfileCommit={submitProfileCommit}
            submitProfileInit={submitProfileInit}
            submitProfileLoad={submitProfileLoad}
            submitProfilePush={submitProfilePush}
          />

          <div className="account-list">
            <div className="account-list-heading">
              <span>Agents</span>
              <small>{profile.agents.length} source-backed</small>
            </div>
            {profile.agents.length ? (
              profile.agents.map((agent) => (
                <ProfileAgentRow
                  actionCount={profile.actionCatalog.length}
                  agent={agent}
                  defaultAction={profile.summary.defaultAction}
                  key={agent.id}
                  profile={profile}
                  setupRequirementCount={setupRequirementCount}
                />
              ))
            ) : (
              <div className="empty-account-list">
                <strong>No profile agents found</strong>
                <span>Run profile checks after creating source-backed agents.</span>
              </div>
            )}
          </div>
        </>
      ) : (
        <div className="account-list">
          <div className="account-list-heading">
            <span>Summary</span>
            <small>Not loaded</small>
          </div>
          <div className="empty-account-list">
            <strong>No local profile loaded</strong>
            <span>Create a default profile here, or load an existing profile repo path.</span>
            <ProfileControls
              connection={connection}
              inline
              profileBusy={profileBusy}
              profileCommitMessage={profileCommitMessage}
              profileName={profileName}
              profilePath={profilePath}
              pushDisabled
              setProfileCommitMessage={setProfileCommitMessage}
              setProfileName={setProfileName}
              setProfilePath={setProfilePath}
              submitProfileCheck={submitProfileCheck}
              submitProfileCommit={submitProfileCommit}
              submitProfileInit={submitProfileInit}
              submitProfileLoad={submitProfileLoad}
              submitProfilePush={submitProfilePush}
            />
          </div>
        </div>
      )}
    </section>
  );
}

type ProfileControlsProps = {
  connection: ClientConnection | null;
  profileBusy: string | null;
  profileCommitMessage: string;
  profileName: string;
  profilePath: string;
  pushDisabled: boolean;
  inline?: boolean;
  setProfileCommitMessage: (value: string) => void;
  setProfileName: (value: string) => void;
  setProfilePath: (value: string) => void;
  submitProfileCheck: () => void;
  submitProfileCommit: () => void;
  submitProfileInit: () => void;
  submitProfileLoad: () => void;
  submitProfilePush: () => void;
};

function ProfileControls({
  connection,
  inline = false,
  profileBusy,
  profileCommitMessage,
  profileName,
  profilePath,
  pushDisabled,
  setProfileCommitMessage,
  setProfileName,
  setProfilePath,
  submitProfileCheck,
  submitProfileCommit,
  submitProfileInit,
  submitProfileLoad,
  submitProfilePush,
}: ProfileControlsProps) {
  return (
    <div className={`profile-control-panel ${inline ? "inline" : ""}`}>
      <div className="profile-control-grid">
        <label className="settings-select-field">
          <span>Profile repo path</span>
          <input
            value={profilePath}
            disabled={Boolean(profileBusy)}
            placeholder="~/.openpond/profiles/default-repo"
            onChange={(event) => setProfilePath(event.target.value)}
          />
        </label>
        <label className="settings-select-field">
          <span>Active profile</span>
          <input
            value={profileName}
            disabled={Boolean(profileBusy)}
            placeholder="default"
            onChange={(event) => setProfileName(event.target.value)}
          />
        </label>
      </div>
      {!inline ? (
        <label className="settings-select-field">
          <span>Commit message</span>
          <input
            value={profileCommitMessage}
            disabled={Boolean(profileBusy)}
            placeholder="Update OpenPond profile"
            onChange={(event) => setProfileCommitMessage(event.target.value)}
          />
        </label>
      ) : null}
      <div className="profile-control-actions">
        <button
          className="settings-secondary"
          disabled={!connection || Boolean(profileBusy)}
          type="button"
          onClick={submitProfileInit}
        >
          <Plus size={14} />
          <span>{profileBusy === "init" ? "Creating" : "Create"}</span>
        </button>
        <button
          className="settings-secondary"
          disabled={!connection || Boolean(profileBusy) || !profilePath.trim()}
          type="button"
          onClick={submitProfileLoad}
        >
          <RefreshCw size={14} className={profileBusy === "load" ? "settings-spin" : undefined} />
          <span>{profileBusy === "load" ? "Loading" : "Load"}</span>
        </button>
        {!inline ? (
          <>
            <button
              className="settings-secondary"
              disabled={!connection || Boolean(profileBusy)}
              type="button"
              onClick={submitProfileCheck}
            >
              <CheckCircle2 size={14} />
              <span>{profileBusy === "check" ? "Checking" : "Check"}</span>
            </button>
            <button
              className="settings-secondary"
              disabled={!connection || Boolean(profileBusy)}
              type="button"
              onClick={submitProfileCommit}
            >
              <GitCommit size={14} />
              <span>{profileBusy === "commit" ? "Committing" : "Commit"}</span>
            </button>
            <button
              className="settings-secondary"
              disabled={!connection || Boolean(profileBusy) || pushDisabled}
              type="button"
              onClick={submitProfilePush}
            >
              <UploadCloud size={14} />
              <span>{profileBusy === "push" ? "Pushing" : "Push hosted"}</span>
            </button>
          </>
        ) : null}
      </div>
      {!inline ? (
        <div className="profile-footline">
          Hosted push requires a clean committed profile and the selected default team.
        </div>
      ) : null}
    </div>
  );
}

function ProfileAgentRow({
  actionCount,
  agent,
  defaultAction,
  profile,
  setupRequirementCount,
}: {
  actionCount: number;
  agent: NonNullable<BootstrapPayload["profile"]>["agents"][number];
  defaultAction: string | null;
  profile: NonNullable<BootstrapPayload["profile"]>;
  setupRequirementCount: number;
}) {
  const sourceState = profileAgentSourceState(profile);
  return (
    <div className="product-row profile-agent-row">
      <Bot size={18} />
      <div>
        <strong>{agent.name}</strong>
        <span title={agent.path}>{agent.path}</span>
      </div>
      <div className="profile-agent-meta">
        <span>{defaultAction ?? "No default action"}</span>
        <span>{actionCount} action{actionCount === 1 ? "" : "s"}</span>
        <span>{setupRequirementCount} setup</span>
      </div>
      <AccountStateBadge state={agent.enabled ? sourceState : "disabled"} />
      <PackageCheck size={16} aria-hidden="true" />
    </div>
  );
}

function ProfileMetric({ label, value }: { label: string; value: string }) {
  return (
    <div className="profile-metric">
      <span>{label}</span>
      <strong title={value}>{value}</strong>
    </div>
  );
}

function shortSha(value: string | null | undefined): string {
  return value ? value.slice(0, 10) : "None";
}

function profileGitValue(profile: NonNullable<BootstrapPayload["profile"]>): string {
  const git = profile.git;
  if (!git) return "Not initialized";
  const branch = git.branch ?? "detached";
  const head = shortSha(git.head);
  return git.dirty ? `${branch} ${head} dirty` : `${branch} ${head}`;
}

function profileHostedValue(profile: NonNullable<BootstrapPayload["profile"]>): string {
  if (!profile.hosted?.sourceCommitSha) return "Not pushed";
  const promotion = profile.hosted.promotionStatus ?? "uploaded";
  return `${promotion} ${shortSha(profile.hosted.sourceCommitSha)}`;
}

function profileHostedRunValue(profile: NonNullable<BootstrapPayload["profile"]>): string {
  if (!profile.hosted?.sourceCommitSha) return "Not pushed";
  const status = profile.hosted.hostedRunStatus ?? "not_started";
  return profile.hosted.hostedRunId
    ? `${status} ${profile.hosted.hostedRunId.slice(0, 8)}`
    : status;
}

function profileCreatePlanReviews(approvals: Approval[]): Approval[] {
  return approvals
    .filter((approval) => approval.kind === "create_plan" && approval.status === "pending")
    .sort((left, right) => Date.parse(right.createdAt) - Date.parse(left.createdAt));
}

function profilePlanReviewValue(approvals: Approval[]): string {
  if (approvals.length === 0) return "None pending";
  return `${approvals.length} pending`;
}

function profileCatalogValue(profile: NonNullable<BootstrapPayload["profile"]>): string {
  const catalog = profile.catalog;
  if (!catalog) return `${profile.actionCatalog?.length ?? 0} actions`;
  const stale = catalog.stale ? " stale" : "";
  return `${catalog.actionCount} actions${stale}`;
}

function profileSetupGateValue(profile: NonNullable<BootstrapPayload["profile"]>): string {
  const gate = profile.setupGate;
  if (!gate || gate.requirementCount === 0) return "Ready";
  if (gate.blockingCount > 0) return `${gate.status} (${gate.blockingCount} blocking)`;
  if (gate.optionalMissingCount > 0) return `ready (${gate.optionalMissingCount} optional missing)`;
  return "Ready";
}

function profileSyncMessage(profile: NonNullable<BootstrapPayload["profile"]>): string {
  if (profile.mode !== "local") return "No local profile loaded";
  if (profile.git?.dirty) return "Local profile source has uncommitted changes.";
  if (profile.hosted?.sourceCommitSha && profile.git?.head === profile.hosted.sourceCommitSha) {
    return "Local profile matches hosted source.";
  }
  return "Local profile source is ready.";
}

function profileAgentSourceState(
  profile: NonNullable<BootstrapPayload["profile"]>,
): "ready" | "warning" | "loading" {
  if (profile.setupGate.blockingCount > 0) return "warning";
  if (profile.summary.checkFresh && !profile.git?.dirty) return "ready";
  if (profile.hosted?.sourceCommitSha && profile.git?.head === profile.hosted.sourceCommitSha) {
    return "ready";
  }
  return profile.git?.dirty ? "warning" : "loading";
}

function profileChangeLines(profile: NonNullable<BootstrapPayload["profile"]>): string[] {
  const diff = profile.diff;
  if (!profileHasChanges(profile)) return [];
  const lines: string[] = [];
  for (const agent of diff.newAgents.slice(0, 3)) lines.push(`new agent: ${agent}`);
  for (const agent of diff.changedAgents.slice(0, 3)) lines.push(`agent changed: ${agent}`);
  for (const agent of diff.deletedAgents.slice(0, 3)) lines.push(`agent removed: ${agent}`);
  for (const action of diff.changedActions.slice(0, 3)) lines.push(`action: ${action}`);
  for (const extension of diff.changedExtensions.slice(0, 3)) lines.push(`extension: ${extension}`);
  for (const setup of diff.setupChanges.slice(0, 2)) lines.push(`setup: ${setup}`);
  for (const env of diff.envRequirementChanges.slice(0, 2)) lines.push(`env: ${env}`);
  return lines.slice(0, 8);
}

function profileHasChanges(profile: NonNullable<BootstrapPayload["profile"]>): boolean {
  const diff = profile.diff;
  return (
    diff.files.length > 0 ||
    diff.changedAgents.length > 0 ||
    diff.newAgents.length > 0 ||
    diff.deletedAgents.length > 0 ||
    diff.changedActions.length > 0 ||
    diff.changedExtensions.length > 0 ||
    diff.setupChanges.length > 0 ||
    diff.envRequirementChanges.length > 0
  );
}
