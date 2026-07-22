import { useState, type FormEvent, type ReactNode } from "react";
import type { BootstrapPayload } from "@openpond/contracts";
import {
  FileText,
  CloudUpload,
  FolderGit2,
  GitCommit,
  Plus,
  UploadCloud,
  X,
} from "../icons";
import { api, type ClientConnection } from "../../api";
import { ProfileAgentsSection } from "../profile/ProfileAgentsSection";
import "../../styles/workspace/git-dialogs.css";

type ProfileState = NonNullable<BootstrapPayload["profile"]>;
type ProfileSkill = ProfileState["skills"][number];
type ProfileSyncDifference = {
  label: string;
  detail: string;
  count: number;
  tone?: "warning";
};
type ProfileStatusCell = {
  state: "ready" | "warning" | "loading" | "disabled";
  label: string;
};

type ProfileSettingsSectionProps = {
  section?: "all" | "profile" | "agents" | "controls";
  payload: BootstrapPayload | null;
  connection: ClientConnection | null;
  onPayload: (payload: BootstrapPayload) => void;
  onError: (message: string | null) => void;
  onToast?: (message: string, tone?: "success" | "error" | "info") => void;
  onSkillCommand?: (command: string) => void;
  overviewContent?: ReactNode;
};

export function ProfileSettingsSection({
  section = "all",
  payload,
  connection,
  onPayload,
  onError,
  onToast,
  onSkillCommand,
  overviewContent,
}: ProfileSettingsSectionProps) {
  const [profileCommitMessage, setProfileCommitMessage] = useState("");
  const [profileBusy, setProfileBusy] = useState<string | null>(null);
  const profile = payload?.profile ?? null;
  const selectedDefaultTeamId = payload?.preferences.defaultTeamId?.trim() || "";
  const showControls = section === "all" || section === "profile" || section === "controls";
  const showAgents = section === "all" || section === "agents";
  const showSkills = section === "all" || section === "profile";

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
      await api.profileInit(connection!, {});
      await refreshBootstrapAfterProfileChange("Profile initialized");
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
          {showControls ? (
            <>
              <ProfileControls
                connection={connection}
                profile={profile}
                profileBusy={profileBusy}
                profileCommitMessage={profileCommitMessage}
                selectedDefaultTeamId={selectedDefaultTeamId}
                syncDisabledReason={profileSyncDisabledReason(profile, selectedDefaultTeamId)}
                setProfileCommitMessage={setProfileCommitMessage}
                submitProfileCommit={submitProfileCommit}
                submitProfilePush={submitProfilePush}
              />

              {overviewContent}
            </>
          ) : null}

          {showAgents ? (
            <ProfileAgentsSection
              connection={connection}
              profile={profile}
              selectedDefaultTeamId={selectedDefaultTeamId}
            />
          ) : null}

          {showSkills ? (
            <ProfileSkillsSection
              onSkillCommand={onSkillCommand}
              profile={profile}
            />
          ) : null}

        </>
      ) : section === "agents" ? (
        <div className="account-list">
          <div className="account-list-heading">
            <span>Agents</span>
            <small>Profile required</small>
          </div>
          <div className="empty-account-list">
            <strong>No local Profile loaded</strong>
            <span>Open the Profile tab to create or load a Profile before managing agents.</span>
          </div>
        </div>
      ) : (
        <div className="account-list">
          <div className="account-list-heading">
            <span>Summary</span>
            <small>Not loaded</small>
          </div>
          <div className="empty-account-list">
            <strong>No local profile loaded</strong>
            <span>OpenPond uses one Git-backed Profile in the default repo.</span>
            <button
              className="settings-secondary"
              disabled={!connection || Boolean(profileBusy)}
              type="button"
              onClick={submitProfileInit}
            >
              <Plus size={14} />
              <span>{profileBusy === "init" ? "Creating" : "Create default Profile"}</span>
            </button>
          </div>
        </div>
      )}
    </section>
  );
}

type ProfileControlsProps = {
  connection: ClientConnection | null;
  profile: ProfileState | null;
  profileBusy: string | null;
  profileCommitMessage: string;
  selectedDefaultTeamId: string;
  syncDisabledReason: string | null;
  setProfileCommitMessage: (value: string) => void;
  submitProfileCommit: () => void;
  submitProfilePush: () => void;
};

function ProfileControls({
  connection,
  profile,
  profileBusy,
  profileCommitMessage,
  selectedDefaultTeamId,
  syncDisabledReason,
  setProfileCommitMessage,
  submitProfileCommit,
  submitProfilePush,
}: ProfileControlsProps) {
  const [repoDialogOpen, setRepoDialogOpen] = useState(false);
  const [commitDialogOpen, setCommitDialogOpen] = useState(false);
  const [syncDialogOpen, setSyncDialogOpen] = useState(false);
  const disabled = !connection || Boolean(profileBusy);

  return (
    <div className="profile-control-panel">
      <div className="profile-control-toolbar">
        <div className="profile-control-actions">
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
          <button
            className="settings-secondary"
            disabled={Boolean(profileBusy) || !profile}
            type="button"
            onClick={() => setRepoDialogOpen(true)}
          >
            <FolderGit2 size={14} />
            <span>Repo</span>
          </button>
          {profile ? (
            <span
              className="profile-hosted-status"
              title={`Profile sync status: ${profileHostedValue(profile, selectedDefaultTeamId)}`}
            >
              <CloudUpload size={14} />
              <span>Profile sync</span>
              <strong>{profileHostedValue(profile, selectedDefaultTeamId)}</strong>
            </span>
          ) : null}
        </div>
        {profile ? (
          <span
            className={`profile-local-status ${profile.summary.state}`}
            title={profile.summary.message}
          >
            {profile.summary.message}
          </span>
        ) : null}
      </div>
      {repoDialogOpen && profile ? (
        <ProfileRepoDialog
          profile={profile}
          profileBusy={profileBusy}
          onClose={() => setRepoDialogOpen(false)}
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
          selectedDefaultTeamId={selectedDefaultTeamId}
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
  selectedDefaultTeamId,
  syncDisabledReason,
  submitProfilePush,
  onClose,
}: {
  disabled: boolean;
  profile: ProfileState;
  profileBusy: string | null;
  selectedDefaultTeamId: string;
  syncDisabledReason: string | null;
  submitProfilePush: () => void;
  onClose: () => void;
}) {
  const differences = profileSyncDifferences(profile, selectedDefaultTeamId);
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
        <p className="profile-sync-explainer">
          Sync publishes this committed Profile source for your team, so its Agents can be shared in team chat and attached to hosted sandboxes.
        </p>
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

function ProfileRepoDialog({
  profile,
  profileBusy,
  onClose,
}: {
  profile: ProfileState;
  profileBusy: string | null;
  onClose: () => void;
}) {
  return (
    <div className="git-dialog-backdrop" role="presentation" onMouseDown={onClose}>
      <div
        className="git-dialog profile-path-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="profile-path-dialog-title"
        onMouseDown={(event) => event.stopPropagation()}
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
            aria-label="Profile repo path"
            readOnly
            value={profile.repoPath ?? ""}
          />
        </label>
        <div className="profile-dialog-summary">
          <strong>{profile.git?.isRepo ? "Git-backed" : "Git setup required"}</strong>
          <span>
            {profile.git?.branch ?? "No branch"} · {shortSha(profile.git?.head)}
          </span>
        </div>
        <div className="git-dialog-footer">
          <button className="git-dialog-secondary" disabled={Boolean(profileBusy)} type="button" onClick={onClose}>
            Close
          </button>
        </div>
      </div>
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

function shortSha(value: string | null | undefined): string {
  return value ? value.slice(0, 10) : "None";
}

function profileHostedValue(
  profile: NonNullable<BootstrapPayload["profile"]>,
  selectedDefaultTeamId: string,
): string {
  if (profileHostedTeamMismatch(profile, selectedDefaultTeamId)) return "Sync this account";
  if (!profile.hosted?.sourceCommitSha) return "Not pushed";
  const promotion = profile.hosted.promotionStatus ?? "uploaded";
  return `${promotion} ${shortSha(profile.hosted.sourceCommitSha)}`;
}

function profileSyncDisabledReason(profile: ProfileState, selectedDefaultTeamId: string): string | null {
  if (!selectedDefaultTeamId) return "Select a default team before syncing.";
  if (!profile.git?.head) return "Commit the profile before syncing.";
  if (profile.git.dirty) return "Commit local profile changes before syncing.";
  return null;
}

function profileSyncDifferences(profile: ProfileState, selectedDefaultTeamId: string): ProfileSyncDifference[] {
  const differences: ProfileSyncDifference[] = [];
  const localHead = profile.summary.localHead ?? profile.git?.head ?? null;
  const pushedLocalHead = profile.hosted?.lastPushedLocalHead ?? null;
  const hostedUploadHead = profile.summary.hostedHead ?? profile.hosted?.sourceCommitSha ?? null;

  if (profileHostedTeamMismatch(profile, selectedDefaultTeamId)) {
    differences.push({
      label: "Account",
      detail: "Hosted profile metadata was synced under a different default team.",
      count: 1,
      tone: "warning",
    });
  }

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

function profileHostedTeamMismatch(profile: ProfileState, selectedDefaultTeamId: string): boolean {
  const hostedTeamId = profile.hosted?.teamId?.trim() ?? "";
  return Boolean(hostedTeamId && selectedDefaultTeamId && hostedTeamId !== selectedDefaultTeamId);
}
