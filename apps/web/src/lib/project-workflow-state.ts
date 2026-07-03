import type { CloudProject, LocalProject, WorkspaceState } from "@openpond/contracts";

export function localWorkspaceStateNote(
  state: WorkspaceState | null | undefined,
  fallback?: {
    branch?: string | null;
    path?: string | null;
    linkedCloudSourceKnown?: boolean;
  },
): string {
  if (!state) return fallback?.path ?? "Use files on this machine";
  if (state.error) return "status unavailable";
  if (!state.initialized) return "not checked out";

  const branch = state.currentBranch ?? fallback?.branch ?? state.defaultBranch ?? "no branch";
  const parts = [branch];
  const linkedSourceState = linkedSourceLocalStateNote(state);
  const linkedCloudSourceUnknown = fallback?.linkedCloudSourceKnown === false && Boolean(state.headCommit);

  if (linkedSourceState) {
    parts.push(linkedSourceState);
  } else if (linkedCloudSourceUnknown) {
    parts.push("upload required");
  } else if (state.diverged) {
    if (state.ahead > 0) parts.push(commitDeltaLabel("ahead", state.ahead));
    if (state.behind > 0) parts.push(commitDeltaLabel("behind", state.behind));
    parts.push("diverged");
  } else {
    if (state.ahead > 0) parts.push(commitDeltaLabel("ahead", state.ahead));
    if (state.behind > 0) parts.push(commitDeltaLabel("behind", state.behind));
  }

  if (state.changedFilesCount > 0) {
    parts.push(`${state.changedFilesCount} changed`);
  } else if (state.dirty) {
    parts.push("dirty");
  }

  if (state.untrackedFilesCount > 0) parts.push(`${state.untrackedFilesCount} untracked`);

  if (parts.length === 1) parts.push("synced");
  return parts.join(" / ");
}

export function cloudWorkspaceStateNote(
  localProject: LocalProject | null | undefined,
  cloudProject: CloudProject | null | undefined,
  state?: WorkspaceState | null,
): string {
  const linked = localProject?.linkedSandboxProject ?? null;
  if (!linked?.projectId && !cloudProject) return "upload required";

  const branch = linked?.defaultBranch ?? cloudProject?.defaultBranch ?? "main";
  const linkedManifestHash = linked?.manifestHash ?? null;
  const localManifestHash = localProject?.sandboxTemplate?.manifestHash ?? null;
  const syncedAt = linked?.syncedAt ?? cloudProject?.syncedAt ?? null;
  const needsSync = Boolean(linkedManifestHash && localManifestHash && linkedManifestHash !== localManifestHash);
  const linkedCloudSourceUnknown = Boolean(linked?.projectId && state?.headCommit && !linked.lastUploadedCommit);
  const sourceState = linkedSourceCloudStateNote(state);
  if (sourceState) return `${branch} / ${sourceState}`;
  if (linkedCloudSourceUnknown) return `${branch} / upload required`;

  const setupState = needsSync || !syncedAt ? "needs sync" : "setup ready";

  return `${branch} / ${setupState}`;
}

export function uploadSyncStateNote(
  localProject: LocalProject | null | undefined,
  state: WorkspaceState | null | undefined,
): string {
  if (!localProject) return "select a local project";
  if (!state) return localProject.linkedSandboxProject ? "sync source to cloud" : "push local source to cloud";
  if (state.error) return "repo status unavailable";
  if (!state.initialized) return "local repo unavailable";

  const items: string[] = [];
  const commitsToUpload = state.aheadOfLinkedSource > 0 ? state.aheadOfLinkedSource : state.ahead;
  if (localProject.linkedSandboxProject?.projectId && state.headCommit && !localProject.linkedSandboxProject.lastUploadedCommit) {
    items.push("upload required");
  }
  if (commitsToUpload > 0) items.push(commitCountLabel(commitsToUpload));
  if (
    state.linkedSourceHeadCommit &&
    state.headCommit &&
    state.linkedSourceHeadCommit !== state.headCommit &&
    state.linkedSourceComparisonError &&
    commitsToUpload === 0
  ) {
    items.push("source changed");
  }
  if (state.changedFilesCount > 0) {
    items.push(`${state.changedFilesCount} changed file${state.changedFilesCount === 1 ? "" : "s"}`);
  }
  if (state.untrackedFilesCount > 0) {
    items.push(`${state.untrackedFilesCount} untracked skipped`);
  }
  return items.length > 0 ? items.join(" / ") : "nothing to upload";
}

export function projectCapabilityNote(input: {
  kind: "local" | "cloud";
  localProject?: LocalProject | null;
  cloudProject?: CloudProject | null;
  workspaceState?: WorkspaceState | null;
}): string {
  if (input.kind === "cloud") {
    const branch = input.cloudProject?.defaultBranch ?? "main";
    const synced = input.cloudProject?.syncedAt ? "Cloud" : "Setup";
    return `${synced} / ${branch}`;
  }

  const localProject = input.localProject ?? null;
  const hasCloud = Boolean(localProject?.linkedSandboxProject?.projectId || localProject?.linkedOpenPondApp?.appId);
  if (!input.workspaceState) return hasCloud ? "Local + Cloud" : "Local";
  const local = localWorkspaceStateNote(input.workspaceState, {
    branch: localProject?.linkedSandboxProject?.defaultBranch ?? null,
    path: localProject?.workspacePath ?? null,
    linkedCloudSourceKnown: localProject?.linkedSandboxProject?.projectId
      ? Boolean(localProject.linkedSandboxProject.lastUploadedCommit) || !input.workspaceState.headCommit
      : true,
  });
  return hasCloud ? `Local + Cloud / ${local}` : `Local / ${local}`;
}

function linkedSourceLocalStateNote(state: WorkspaceState): string | null {
  if (!state.linkedSourceHeadCommit) return null;
  if (state.divergedFromLinkedSource) return "diverged";
  if (state.aheadOfLinkedSource > 0) return commitDeltaLabel("local ahead", state.aheadOfLinkedSource);
  if (state.behindLinkedSource > 0) return commitDeltaLabel("cloud ahead", state.behindLinkedSource);
  if (
    state.linkedSourceComparisonError &&
    state.headCommit &&
    state.linkedSourceHeadCommit !== state.headCommit
  ) {
    return "sync unknown";
  }
  return null;
}

function linkedSourceCloudStateNote(state: WorkspaceState | null | undefined): string | null {
  if (!state?.linkedSourceHeadCommit) return null;
  if (state.dirty) return "local dirty files not in cloud";
  if (state.divergedFromLinkedSource) return "diverged from local";
  if (state.aheadOfLinkedSource > 0) return commitDeltaLabel("cloud behind local", state.aheadOfLinkedSource);
  if (state.behindLinkedSource > 0) return commitDeltaLabel("cloud ahead local", state.behindLinkedSource);
  if (
    state.linkedSourceComparisonError &&
    state.headCommit &&
    state.linkedSourceHeadCommit !== state.headCommit
  ) {
    return "source check unavailable";
  }
  return "synced";
}

function commitDeltaLabel(prefix: string, count: number): string {
  return `${prefix} by ${commitCountLabel(count)}`;
}

function commitCountLabel(count: number): string {
  return `${count} commit${count === 1 ? "" : "s"}`;
}
