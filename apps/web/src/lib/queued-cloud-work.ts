export type QueuedCloudWorkSubmissionInput = {
  pendingWorkspaceTarget: "queue_cloud" | "hybrid" | null;
  actionSelected: boolean;
  promptOverrideProvided: boolean;
  attachmentCount: number;
  selectedCloudProjectId?: string | null;
  selectedProjectCloudProjectId?: string | null;
  selectedLocalProjectId?: string | null;
  selectedLocalProjectName?: string | null;
  selectedLocalWorkspacePath?: string | null;
  selectedProjectCloudSourceRef?: string | null;
  selectedProjectCloudBaseSha?: string | null;
  prompt: string;
};

export type QueuedCloudWorkSubmissionResult =
  | { kind: "not_queued" }
  | { kind: "attachments_unsupported"; message: string }
  | { kind: "missing_cloud_project"; message: string }
  | { kind: "empty_prompt" }
  | {
      kind: "ready";
      request: {
        projectId: string;
        prompt: string;
        select: false;
        localProjectId?: string;
        localProjectName?: string;
        localWorkspacePath?: string;
        sourceRef?: string;
        baseSha?: string;
        requestedExecutionTarget: "queue_cloud";
      };
    };

export function queuedCloudWorkSubmission(
  input: QueuedCloudWorkSubmissionInput,
): QueuedCloudWorkSubmissionResult {
  if (
    input.pendingWorkspaceTarget !== "queue_cloud" ||
    input.actionSelected ||
    input.promptOverrideProvided
  ) {
    return { kind: "not_queued" };
  }
  if (input.attachmentCount > 0) {
    return {
      kind: "attachments_unsupported",
      message: "Queued Cloud work does not accept attachments yet. Add file context in the Cloud task thread.",
    };
  }
  const projectId = input.selectedCloudProjectId ?? input.selectedProjectCloudProjectId ?? null;
  if (!projectId) {
    return {
      kind: "missing_cloud_project",
      message: "Upload/sync this Project to Cloud before queueing work.",
    };
  }
  const prompt = input.prompt.trim();
  if (!prompt) return { kind: "empty_prompt" };
  return {
    kind: "ready",
    request: {
      projectId,
      prompt,
      select: false,
      ...(input.selectedLocalProjectId ? { localProjectId: input.selectedLocalProjectId } : {}),
      ...(input.selectedLocalProjectName ? { localProjectName: input.selectedLocalProjectName } : {}),
      ...(input.selectedLocalWorkspacePath ? { localWorkspacePath: input.selectedLocalWorkspacePath } : {}),
      ...(input.selectedProjectCloudSourceRef ? { sourceRef: input.selectedProjectCloudSourceRef } : {}),
      ...(input.selectedProjectCloudBaseSha ? { baseSha: input.selectedProjectCloudBaseSha } : {}),
      requestedExecutionTarget: "queue_cloud",
    },
  };
}
