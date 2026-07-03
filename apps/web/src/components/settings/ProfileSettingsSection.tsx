import { useEffect, useMemo, useState, type FormEvent } from "react";
import type { Approval, BootstrapPayload } from "@openpond/contracts";
import {
  Bot,
  FileText,
  FolderGit2,
  GitCommit,
  Plus,
  RefreshCw,
  UploadCloud,
  X,
} from "../icons";
import { api, type ClientConnection } from "../../api";

type ProfileState = NonNullable<BootstrapPayload["profile"]>;
type ProfileAgent = ProfileState["agents"][number];
type ProfileSkill = ProfileState["skills"][number];
type ProfileSyncDifference = {
  label: string;
  detail: string;
  count: number;
  tone?: "warning";
};
type ProfileAgentRowStatus = {
  check: ProfileStatusCell;
  sync: ProfileStatusCell;
};
type ProfileStatusCell = {
  state: "ready" | "warning" | "loading" | "disabled";
  label: string;
};

type ProfileSettingsSectionProps = {
  payload: BootstrapPayload | null;
  connection: ClientConnection | null;
  onPayload: (payload: BootstrapPayload) => void;
  onError: (message: string | null) => void;
  onToast?: (message: string, tone?: "success" | "error" | "info") => void;
  onSkillCommand?: (command: string) => void;
};

export function ProfileSettingsSection({
  payload,
  connection,
  onPayload,
  onError,
  onToast,
  onSkillCommand,
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
        throw new Error("Select a default team before syncing a hosted profile.");
      }
      await api.profileCheck(connection!, { kind: "all" });
      await api.profilePush(connection!, {
        teamId: selectedDefaultTeamId,
        ensureHosted: true,
        message: null,
      });
      await refreshBootstrapAfterProfileChange("Profile synced to hosted profile repo");
    });
  }

  return (
    <section className="account-settings">
      {profile?.mode === "local" ? (
        <>
          <ProfileControls
            connection={connection}
            profile={profile}
            profileBusy={profileBusy}
            profileCommitMessage={profileCommitMessage}
            profileName={profileName}
            profilePath={profilePath}
            syncDisabledReason={profileSyncDisabledReason(profile, selectedDefaultTeamId)}
            setProfileCommitMessage={setProfileCommitMessage}
            setProfileName={setProfileName}
            setProfilePath={setProfilePath}
            submitProfileCommit={submitProfileCommit}
            submitProfileInit={submitProfileInit}
            submitProfileLoad={submitProfileLoad}
            submitProfilePush={submitProfilePush}
          />

          <div className="account-list profile-agent-list">
            <div className="account-list-heading profile-agent-list-heading">
              <span>Agents</span>
            </div>
            {profile.agents.length ? (
              <>
                <div className="profile-agent-table-head" aria-hidden="true">
                  <span>Agent</span>
                  <span>Action</span>
                  <span>Check</span>
                  <span>Sync</span>
                </div>
                {profile.agents.map((agent) => (
                  <ProfileAgentRow
                    agent={agent}
                    defaultAction={profile.summary.defaultAction}
                    key={agent.id}
                    profile={profile}
                  />
                ))}
              </>
            ) : (
              <div className="empty-account-list">
                <strong>No profile agents found</strong>
                <span>Run profile checks after creating agents.</span>
              </div>
            )}
          </div>

          <ProfileSkillsSection
            onSkillCommand={onSkillCommand}
            profile={profile}
          />

          <ProfileSummary profile={profile} pendingCreatePlanReviews={pendingCreatePlanReviews} />
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
              profile={null}
              profileBusy={profileBusy}
              profileCommitMessage={profileCommitMessage}
              profileName={profileName}
              profilePath={profilePath}
              syncDisabledReason="Load a local profile before syncing."
              setProfileCommitMessage={setProfileCommitMessage}
              setProfileName={setProfileName}
              setProfilePath={setProfilePath}
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

function ProfileSummary({
  profile,
  pendingCreatePlanReviews,
}: {
  profile: ProfileState;
  pendingCreatePlanReviews: Approval[];
}) {
  return (
    <div className="account-list">
      <div className="account-list-heading">
        <span>Summary</span>
        <small>{profile.summary.state}</small>
      </div>
      <div className="profile-summary-panel">
        <div className="profile-summary-head">
          <div className="account-details">
            <strong>{profile.activeProfile ?? "default"}</strong>
            <span>{profile.sourcePath ? "Local source configured" : "Source missing"}</span>
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
        {profile.hosted?.hostedSourceMaterialization ? (
          <div className={profile.hosted.hostedSourceMaterialization.status === "failed" ? "profile-footline warning" : "profile-footline"}>
            Hosted materialized: {profile.hosted.hostedSourceMaterialization.status}
            {profile.hosted.hostedSourceMaterialization.agentId
              ? ` - ${profile.hosted.hostedSourceMaterialization.agentId}`
              : ""}
            {profile.hosted.hostedSourceMaterialization.sourceCommitSha
              ? ` - ${profile.hosted.hostedSourceMaterialization.sourceCommitSha.slice(0, 10)}`
              : ""}
          </div>
        ) : null}
        {profile.hosted?.hostedSourceCheck ? (
          <div className={profile.hosted.hostedSourceCheck.status === "failed" ? "profile-footline warning" : "profile-footline"}>
            Hosted checks: {profile.hosted.hostedSourceCheck.status}
            {profile.hosted.hostedSourceCheck.workItemId
              ? ` - ${profile.hosted.hostedSourceCheck.workItemId}`
              : ""}
            {profile.hosted.hostedSourceCheck.sandboxId
              ? ` - sandbox ${profile.hosted.hostedSourceCheck.sandboxId}`
              : ""}
          </div>
        ) : null}
        {profile.hosted?.hostedPublish ? (
          <div className={profile.hosted.hostedPublish.status === "failed" ? "profile-footline warning" : "profile-footline"}>
            Hosted publish: {profile.hosted.hostedPublish.status}
            {profile.hosted.hostedPublish.snapshotId
              ? ` - ${profile.hosted.hostedPublish.snapshotId}`
              : ""}
            {profile.hosted.hostedPublish.manifestHash
              ? ` - ${profile.hosted.hostedPublish.manifestHash.slice(0, 10)}`
              : ""}
          </div>
        ) : null}
        {profile.hosted?.hostedRun ? (
          <div className={profile.hosted.hostedRun.status === "failed" ? "profile-footline warning" : "profile-footline"}>
            Hosted run: {profile.hosted.hostedRun.status}
            {profile.hosted.hostedRun.runId ? ` - ${profile.hosted.hostedRun.runId}` : ""}
            {profile.hosted.hostedRun.runtimeId
              ? ` - runtime ${profile.hosted.hostedRun.runtimeId}`
              : ""}
          </div>
        ) : null}
        {profile.error ? <div className="profile-footline warning">{profile.error}</div> : null}
      </div>
    </div>
  );
}

type ProfileControlsProps = {
  connection: ClientConnection | null;
  profile: ProfileState | null;
  profileBusy: string | null;
  profileCommitMessage: string;
  profileName: string;
  profilePath: string;
  syncDisabledReason: string | null;
  inline?: boolean;
  setProfileCommitMessage: (value: string) => void;
  setProfileName: (value: string) => void;
  setProfilePath: (value: string) => void;
  submitProfileCommit: () => void;
  submitProfileInit: () => void;
  submitProfileLoad: () => void;
  submitProfilePush: () => void;
};

function ProfileControls({
  connection,
  inline = false,
  profile,
  profileBusy,
  profileCommitMessage,
  profileName,
  profilePath,
  syncDisabledReason,
  setProfileCommitMessage,
  setProfileName,
  setProfilePath,
  submitProfileCommit,
  submitProfileInit,
  submitProfileLoad,
  submitProfilePush,
}: ProfileControlsProps) {
  const [pathDialogOpen, setPathDialogOpen] = useState(false);
  const [commitDialogOpen, setCommitDialogOpen] = useState(false);
  const [syncDialogOpen, setSyncDialogOpen] = useState(false);
  const disabled = !connection || Boolean(profileBusy);

  return (
    <div className={`profile-control-panel ${inline ? "inline" : ""}`}>
      <div className="profile-control-toolbar">
        <div className="profile-control-actions">
          {!inline ? (
            <>
              <button
                className="settings-secondary"
                disabled={disabled}
                type="button"
                onClick={() => setCommitDialogOpen(true)}
              >
                <GitCommit size={14} />
                <span>{profileBusy === "commit" ? "Committing" : "Commit"}</span>
              </button>
              <button
                className="settings-secondary"
                disabled={disabled || !profile}
                type="button"
                onClick={() => setSyncDialogOpen(true)}
              >
                <UploadCloud size={14} />
                <span>{profileBusy === "push" ? "Syncing" : "Sync"}</span>
              </button>
            </>
          ) : null}
          <button
            className="settings-secondary"
            disabled={Boolean(profileBusy)}
            type="button"
            onClick={() => setPathDialogOpen(true)}
          >
            <FolderGit2 size={14} />
            <span>Repo</span>
          </button>
        </div>
      </div>
      {pathDialogOpen ? (
        <ProfilePathDialog
          disabled={disabled}
          profileBusy={profileBusy}
          profileName={profileName}
          profilePath={profilePath}
          setProfileName={setProfileName}
          setProfilePath={setProfilePath}
          submitProfileInit={submitProfileInit}
          submitProfileLoad={submitProfileLoad}
          onClose={() => setPathDialogOpen(false)}
        />
      ) : null}
      {commitDialogOpen ? (
        <ProfileCommitDialog
          disabled={disabled}
          profileBusy={profileBusy}
          profileCommitMessage={profileCommitMessage}
          setProfileCommitMessage={setProfileCommitMessage}
          submitProfileCommit={submitProfileCommit}
          onClose={() => setCommitDialogOpen(false)}
        />
      ) : null}
      {syncDialogOpen && profile ? (
        <ProfileSyncDialog
          disabled={disabled}
          profile={profile}
          profileBusy={profileBusy}
          syncDisabledReason={syncDisabledReason}
          submitProfilePush={submitProfilePush}
          onClose={() => setSyncDialogOpen(false)}
        />
      ) : null}
    </div>
  );
}

function ProfileCommitDialog({
  disabled,
  profileBusy,
  profileCommitMessage,
  setProfileCommitMessage,
  submitProfileCommit,
  onClose,
}: {
  disabled: boolean;
  profileBusy: string | null;
  profileCommitMessage: string;
  setProfileCommitMessage: (value: string) => void;
  submitProfileCommit: () => void;
  onClose: () => void;
}) {
  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (disabled) return;
    submitProfileCommit();
    onClose();
  }

  return (
    <div className="git-dialog-backdrop" role="presentation" onMouseDown={onClose}>
      <form
        className="git-dialog profile-commit-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="profile-commit-dialog-title"
        onMouseDown={(event) => event.stopPropagation()}
        onSubmit={submit}
      >
        <button className="git-dialog-close" disabled={Boolean(profileBusy)} type="button" title="Close" aria-label="Close" onClick={onClose}>
          <X size={14} />
        </button>
        <div className="git-dialog-icon">
          <GitCommit size={18} />
        </div>
        <h2 id="profile-commit-dialog-title">Commit profile</h2>
        <label className="git-dialog-field">
          <span>Commit message</span>
          <input
            autoFocus
            value={profileCommitMessage}
            disabled={Boolean(profileBusy)}
            placeholder="Update OpenPond profile"
            onChange={(event) => setProfileCommitMessage(event.target.value)}
          />
        </label>
        <div className="git-dialog-footer">
          <button className="git-dialog-secondary" disabled={Boolean(profileBusy)} type="button" onClick={onClose}>
            Cancel
          </button>
          <button className="git-dialog-primary" disabled={disabled} type="submit">
            <GitCommit size={14} />
            <span>{profileBusy === "commit" ? "Committing" : "Commit"}</span>
          </button>
        </div>
      </form>
    </div>
  );
}

function ProfileSyncDialog({
  disabled,
  profile,
  profileBusy,
  syncDisabledReason,
  submitProfilePush,
  onClose,
}: {
  disabled: boolean;
  profile: ProfileState;
  profileBusy: string | null;
  syncDisabledReason: string | null;
  submitProfilePush: () => void;
  onClose: () => void;
}) {
  const differences = profileSyncDifferences(profile);
  const outOfSyncCount = differences.reduce((count, difference) => count + difference.count, 0);
  const canSync = !disabled && !syncDisabledReason;

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!canSync) return;
    submitProfilePush();
    onClose();
  }

  return (
    <div className="git-dialog-backdrop" role="presentation" onMouseDown={onClose}>
      <form
        className="git-dialog profile-sync-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="profile-sync-dialog-title"
        onMouseDown={(event) => event.stopPropagation()}
        onSubmit={submit}
      >
        <button className="git-dialog-close" disabled={Boolean(profileBusy)} type="button" title="Close" aria-label="Close" onClick={onClose}>
          <X size={14} />
        </button>
        <div className="git-dialog-icon">
          <UploadCloud size={18} />
        </div>
        <h2 id="profile-sync-dialog-title">Sync profile</h2>
        <div className="profile-dialog-summary">
          <strong>{outOfSyncCount} {outOfSyncCount === 1 ? "item" : "items"} out of sync</strong>
          <span>
            Local {shortSha(profile.summary.localHead ?? profile.git?.head)} - Last pushed{" "}
            {shortSha(profile.hosted?.lastPushedLocalHead)}
          </span>
        </div>
        {differences.length ? (
          <div className="profile-dialog-diff-list" aria-label="Profile sync differences">
            {differences.map((difference) => (
              <div className={`profile-dialog-diff-row ${difference.tone ?? ""}`} key={difference.label}>
                <strong>{difference.label}</strong>
                <span>{difference.detail}</span>
              </div>
            ))}
          </div>
        ) : (
          <div className="profile-dialog-diff-list" aria-label="Profile sync differences">
            <div className="profile-dialog-diff-row">
              <strong>Aligned</strong>
              <span>Current local profile source has already been pushed.</span>
            </div>
          </div>
        )}
        {syncDisabledReason ? <div className="profile-dialog-warning">{syncDisabledReason}</div> : null}
        <div className="git-dialog-footer">
          <button className="git-dialog-secondary" disabled={Boolean(profileBusy)} type="button" onClick={onClose}>
            Cancel
          </button>
          <button className="git-dialog-primary" disabled={!canSync} type="submit">
            <UploadCloud size={14} />
            <span>{profileBusy === "push" ? "Syncing" : "Confirm sync"}</span>
          </button>
        </div>
      </form>
    </div>
  );
}

function ProfilePathDialog({
  disabled,
  profileBusy,
  profileName,
  profilePath,
  setProfileName,
  setProfilePath,
  submitProfileInit,
  submitProfileLoad,
  onClose,
}: {
  disabled: boolean;
  profileBusy: string | null;
  profileName: string;
  profilePath: string;
  setProfileName: (value: string) => void;
  setProfilePath: (value: string) => void;
  submitProfileInit: () => void;
  submitProfileLoad: () => void;
  onClose: () => void;
}) {
  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (disabled || !profilePath.trim()) return;
    submitProfileLoad();
    onClose();
  }

  function createProfile() {
    if (disabled) return;
    submitProfileInit();
    onClose();
  }

  return (
    <div className="git-dialog-backdrop" role="presentation" onMouseDown={onClose}>
      <form
        className="git-dialog profile-path-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="profile-path-dialog-title"
        onMouseDown={(event) => event.stopPropagation()}
        onSubmit={submit}
      >
        <button className="git-dialog-close" disabled={Boolean(profileBusy)} type="button" title="Close" aria-label="Close" onClick={onClose}>
          <X size={14} />
        </button>
        <div className="git-dialog-icon">
          <FolderGit2 size={18} />
        </div>
        <h2 id="profile-path-dialog-title">Profile repo</h2>
        <label className="git-dialog-field">
          <span>Profile repo path</span>
          <input
            value={profilePath}
            disabled={Boolean(profileBusy)}
            placeholder="~/.openpond/profiles/default-repo"
            onChange={(event) => setProfilePath(event.target.value)}
          />
        </label>
        <label className="git-dialog-field">
          <span>Active profile</span>
          <input
            value={profileName}
            disabled={Boolean(profileBusy)}
            placeholder="default"
            onChange={(event) => setProfileName(event.target.value)}
          />
        </label>
        <div className="git-dialog-footer">
          <button className="git-dialog-secondary" disabled={Boolean(profileBusy)} type="button" onClick={onClose}>
            Close
          </button>
          <button className="git-dialog-secondary" disabled={disabled} type="button" onClick={createProfile}>
            <Plus size={14} />
            <span>{profileBusy === "init" ? "Creating" : "Create"}</span>
          </button>
          <button className="git-dialog-primary" disabled={disabled || !profilePath.trim()} type="submit">
            <RefreshCw size={14} className={profileBusy === "load" ? "settings-spin" : undefined} />
            <span>{profileBusy === "load" ? "Loading" : "Load"}</span>
          </button>
        </div>
      </form>
    </div>
  );
}

function ProfileAgentRow({
  agent,
  defaultAction,
  profile,
}: {
  agent: ProfileAgent;
  defaultAction: string | null;
  profile: ProfileState;
}) {
  const rowStatus = profileAgentRowStatus(profile, agent);
  return (
    <div className="product-row profile-agent-row">
      <div className="profile-agent-identity">
        <Bot size={18} />
        <div>
          <strong>{agent.name}</strong>
          <span title={agent.path}>{agent.path}</span>
        </div>
      </div>
      <div className="profile-agent-action">
        <span>{defaultAction ?? "None"}</span>
      </div>
      <ProfileStatusText status={rowStatus.check} />
      <ProfileStatusText status={rowStatus.sync} />
    </div>
  );
}

function ProfileSkillsSection({
  onSkillCommand,
  profile,
}: {
  onSkillCommand?: (command: string) => void;
  profile: ProfileState;
}) {
  const skills = profile.skills.slice().sort((left, right) => left.name.localeCompare(right.name));
  const commandDisabled = !onSkillCommand;

  function runCommand(command: string) {
    onSkillCommand?.(command);
  }

  return (
    <div className="account-list profile-skill-list">
      <div className="account-list-heading profile-agent-list-heading">
        <span>Skills</span>
        <div className="profile-skill-heading-actions">
          <small>{profile.skillCatalog.skillCount} tracked</small>
          <button
            className="settings-secondary"
            disabled={commandDisabled}
            type="button"
            title="Create profile skill"
            onClick={() => runCommand("/skill create ")}
          >
            <Plus size={14} />
            <span>Create</span>
          </button>
        </div>
      </div>
      {skills.length ? (
        <>
          <div className="profile-skill-table-head" aria-hidden="true">
            <span>Skill</span>
            <span>Trigger</span>
            <span>Status</span>
            <span>Source</span>
            <span>Actions</span>
          </div>
          {skills.map((skill) => (
            <ProfileSkillRow
              commandDisabled={commandDisabled}
              key={skill.name}
              onSkillCommand={runCommand}
              skill={skill}
            />
          ))}
        </>
      ) : (
        <div className="empty-account-list">
          <strong>No profile skills found</strong>
          <span>Use /skill create to add reusable profile instructions.</span>
        </div>
      )}
    </div>
  );
}

function ProfileSkillRow({
  commandDisabled,
  onSkillCommand,
  skill,
}: {
  commandDisabled: boolean;
  onSkillCommand: (command: string) => void;
  skill: ProfileSkill;
}) {
  const status: ProfileStatusCell =
    skill.validationStatus === "valid"
      ? { state: "ready", label: "valid" }
      : { state: "warning", label: skill.validationStatus };
  return (
    <div className="product-row profile-skill-row">
      <div className="profile-agent-identity">
        <FileText size={18} />
        <div>
          <strong>{skill.name}</strong>
          <span title={skill.path}>{skill.path}</span>
        </div>
      </div>
      <div className="profile-skill-description" title={skill.description}>
        {skill.description || "No description"}
      </div>
      <ProfileStatusText status={status} />
      <div className="profile-agent-action">
        <span title={skill.sourcePath}>{skill.sourcePath}</span>
      </div>
      <div className="profile-skill-actions">
        <button
          className="settings-secondary compact"
          disabled={commandDisabled || !skill.enabled}
          type="button"
          title={`Use ${skill.name}`}
          onClick={() => onSkillCommand(`$${skill.name} `)}
        >
          <span>Use</span>
        </button>
        <button
          className="settings-secondary compact"
          disabled={commandDisabled}
          type="button"
          title={`Edit ${skill.name}`}
          onClick={() => onSkillCommand(`/skill edit ${skill.name} `)}
        >
          <span>Edit</span>
        </button>
      </div>
    </div>
  );
}

function ProfileStatusText({ status }: { status: ProfileStatusCell }) {
  return <span className={`profile-status-text ${status.state}`}>{status.label}</span>;
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
  const status = profile.hosted.hostedRun?.status ?? profile.hosted.hostedRunStatus ?? "not_started";
  const runId = profile.hosted.hostedRun?.runId ?? profile.hosted.hostedRunId;
  return runId
    ? `${status} ${runId.slice(0, 8)}`
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

function profileSyncDisabledReason(profile: ProfileState, selectedDefaultTeamId: string): string | null {
  if (!selectedDefaultTeamId) return "Select a default team before syncing.";
  if (!profile.git?.head) return "Commit the profile before syncing.";
  if (profile.git.dirty) return "Commit local profile changes before syncing.";
  return null;
}

function profileSyncDifferences(profile: ProfileState): ProfileSyncDifference[] {
  const differences: ProfileSyncDifference[] = [];
  const localHead = profile.summary.localHead ?? profile.git?.head ?? null;
  const pushedLocalHead = profile.hosted?.lastPushedLocalHead ?? null;
  const hostedUploadHead = profile.summary.hostedHead ?? profile.hosted?.sourceCommitSha ?? null;

  if (!hostedUploadHead && !pushedLocalHead) {
    differences.push({
      label: "Hosted source",
      detail: "No hosted profile commit has been recorded.",
      count: 1,
    });
  } else if (localHead && pushedLocalHead && localHead !== pushedLocalHead) {
    differences.push({
      label: "Commit",
      detail: `Local ${shortSha(localHead)} has not been pushed since ${shortSha(pushedLocalHead)}.`,
      count: 1,
    });
  }

  if (profile.git?.dirty) {
    const fileCount = profile.git.files.length || profile.diff.files.length || 1;
    differences.push({
      label: "Uncommitted files",
      detail: `${fileCount} local ${fileCount === 1 ? "file" : "files"} changed.`,
      count: fileCount,
      tone: "warning",
    });
  }

  const profileDiffCount =
    profile.diff.changedAgents.length +
    profile.diff.newAgents.length +
    profile.diff.deletedAgents.length +
    profile.diff.changedSkills.length +
    profile.diff.changedActions.length +
    profile.diff.changedExtensions.length +
    profile.diff.setupChanges.length +
    profile.diff.envRequirementChanges.length;
  if (profileDiffCount > 0) {
    differences.push({
      label: "Profile changes",
      detail: profileDiffSummary(profile),
      count: profileDiffCount,
      tone: profile.git?.dirty ? "warning" : undefined,
    });
  }

  if (profile.catalog.stale) {
    differences.push({
      label: "Catalog",
      detail: "Action catalog artifacts are stale or missing.",
      count: 1,
      tone: "warning",
    });
  }

  if (profile.setupGate.blockingCount > 0) {
    differences.push({
      label: "Setup",
      detail: `${profile.setupGate.blockingCount} blocking setup ${profile.setupGate.blockingCount === 1 ? "requirement" : "requirements"}.`,
      count: profile.setupGate.blockingCount,
      tone: "warning",
    });
  }

  return differences;
}

function profileDiffSummary(profile: ProfileState): string {
  const parts: string[] = [];
  const agentCount =
    profile.diff.changedAgents.length +
    profile.diff.newAgents.length +
    profile.diff.deletedAgents.length;
  if (agentCount) parts.push(`${agentCount} agent ${agentCount === 1 ? "change" : "changes"}`);
  if (profile.diff.changedActions.length) {
    parts.push(`${profile.diff.changedActions.length} action ${profile.diff.changedActions.length === 1 ? "change" : "changes"}`);
  }
  if (profile.diff.changedSkills.length) {
    parts.push(`${profile.diff.changedSkills.length} skill ${profile.diff.changedSkills.length === 1 ? "change" : "changes"}`);
  }
  if (profile.diff.changedExtensions.length) {
    parts.push(`${profile.diff.changedExtensions.length} extension ${profile.diff.changedExtensions.length === 1 ? "change" : "changes"}`);
  }
  if (profile.diff.setupChanges.length) {
    parts.push(`${profile.diff.setupChanges.length} setup ${profile.diff.setupChanges.length === 1 ? "change" : "changes"}`);
  }
  if (profile.diff.envRequirementChanges.length) {
    parts.push(`${profile.diff.envRequirementChanges.length} env ${profile.diff.envRequirementChanges.length === 1 ? "change" : "changes"}`);
  }
  return parts.join(", ") || "Profile source has local changes.";
}

function profileSyncMessage(profile: NonNullable<BootstrapPayload["profile"]>): string {
  if (profile.mode !== "local") return "No local profile loaded";
  if (profile.git?.dirty) return "Local profile source has uncommitted changes.";
  if (profile.hosted?.sourceCommitSha && profile.git?.head === profile.hosted.sourceCommitSha) {
    return "Local profile matches hosted source.";
  }
  return "Local profile source is ready.";
}

function profileAgentRowStatus(profile: ProfileState, agent: ProfileAgent): ProfileAgentRowStatus {
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

  const changeCount = profileAgentChangeCount(profile, agent);
  if (profile.git?.dirty || changeCount > 0) {
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

function profileChangeLines(profile: NonNullable<BootstrapPayload["profile"]>): string[] {
  const diff = profile.diff;
  if (!profileHasChanges(profile)) return [];
  const lines: string[] = [];
  for (const agent of diff.newAgents.slice(0, 3)) lines.push(`new agent: ${agent}`);
  for (const agent of diff.changedAgents.slice(0, 3)) lines.push(`agent changed: ${agent}`);
  for (const agent of diff.deletedAgents.slice(0, 3)) lines.push(`agent removed: ${agent}`);
  for (const skill of diff.changedSkills.slice(0, 3)) lines.push(`skill: ${skill}`);
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
    diff.changedSkills.length > 0 ||
    diff.changedActions.length > 0 ||
    diff.changedExtensions.length > 0 ||
    diff.setupChanges.length > 0 ||
    diff.envRequirementChanges.length > 0
  );
}
