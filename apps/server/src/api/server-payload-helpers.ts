import {
  CloudWorkItemActivitySchema,
  CloudWorkItemMessageSchema,
  CloudWorkItemRuntimeSessionSchema,
  CloudWorkItemSchema,
  CreateImproveRunSchema,
  type CloudProject,
  type CloudProjectSourceType,
  type CloudWorkItem,
  type CloudWorkItemActivity,
  type CloudWorkItemMessage,
  type CloudWorkItemRuntimeSession,
  type CreateImproveRun,
  type LocalProject,
  type RuntimeEvent,
  type Session,
  type UsageRequestAttribution,
  type WorkspaceState,
} from "@openpond/contracts";
import type { CodexAppServerClient } from "@openpond/codex-provider";
import { assertCreateImproveMutationApproved } from "../create-pipeline-guards.js";
import { organizationRequestPayload } from "../openpond/organizations.js";
import { sandboxRequestPayload } from "../openpond/sandboxes.js";
import {
  collectLocalProjectSourceUploadBundle,
  pushLocalProjectSourceToGit,
} from "../workspace/local-project-source-upload.js";
import { runWorkspaceCommand } from "../workspace/workspaces.js";

type OpenPondOrganizationSummary = {
  teamId: string;
  slug: string | null;
  displayName: string | null;
};

const CLOUD_PROJECT_SOURCE_TYPES: ReadonlySet<CloudProjectSourceType> = new Set([
  "github_repo",
  "internal_repo",
  "template",
  "manual",
]);
export type ActiveCodexHistoryTurn = {
  client: CodexAppServerClient;
  completion: Promise<unknown> | null;
  interrupted: boolean;
  ready: Promise<void>;
  resolveReady: () => void;
  settled: boolean;
  threadId: string;
  turnId: string | null;
};

export function codexHistorySessionWithLiveStatus(session: Session, live: boolean): Session {
  return live && session.status !== "active" ? { ...session, status: "active" } : session;
}

export type CodexHistoryTurnInterruptResponse =
  | { interrupted: true }
  | { interrupted: false; reason: "no_active_openpond_turn" | "turn_not_ready" };

export function hasObjectKey(value: unknown, key: string): boolean {
  return Boolean(value && typeof value === "object" && Object.prototype.hasOwnProperty.call(value, key));
}

export function latestRuntimeSessionSandboxId(detail: { runtimeSessions: CloudWorkItemRuntimeSession[] }): string | null {
  return detail.runtimeSessions.find((session) => session.sandboxId)?.sandboxId ?? null;
}

export async function assertApplyableLocalWorkspace(workspaceState: WorkspaceState): Promise<void> {
  if (!workspaceState.initialized) {
    throw new Error(workspaceState.error || "Local checkout is not initialized.");
  }
  const repoCheck = await runWorkspaceCommand(
    "git",
    ["rev-parse", "--is-inside-work-tree"],
    workspaceState.repoPath,
  );
  if (repoCheck.code !== 0 || repoCheck.stdout.trim() !== "true") {
    throw new Error("Local checkout must be a Git repository before applying a Cloud patch.");
  }
  if (workspaceState.dirty) {
    throw new Error("Commit or discard local changes before applying a Cloud patch.");
  }
}

export function countPatchFiles(patchText: string): number {
  const paths = new Set<string>();
  for (const line of patchText.split("\n")) {
    const match = /^diff --git a\/(.+?) b\/(.+)$/.exec(line.trim());
    if (match?.[2]) paths.add(match[2]);
  }
  return paths.size;
}

export function assertCreateImproveBackgroundApproved(input: {
  run?: CreateImproveRun | null;
}): void {
  if (!input.run) return;
  assertCreateImproveMutationApproved({
    actionLabel: "Create/Improve background work",
    run: input.run,
  });
}

export async function fetchCloudProjects(): Promise<CloudProject[]> {
  try {
    const organizationPayload = asRecord(await organizationRequestPayload({ type: "list" }));
    const organizationRows = asRecordArray(organizationPayload.organizations);
    const organizations = (organizationRows.length > 0 ? organizationRows : asRecordArray(organizationPayload.teams))
      .map(normalizeOpenPondOrganization)
      .filter((organization): organization is OpenPondOrganizationSummary => Boolean(organization?.teamId));
    const projectLists = await Promise.all(
      organizations.map(async (organization) => {
        try {
          const payload = asRecord(
            await sandboxRequestPayload({
              type: "project_list",
              payload: { teamId: organization.teamId },
            }),
          );
          return asRecordArray(payload.projects)
            .map((project) => normalizeCloudProject(project, organization))
            .filter((project): project is CloudProject => Boolean(project));
        } catch {
          return [];
        }
      }),
    );
    const byKey = new Map<string, CloudProject>();
    for (const project of projectLists.flat()) {
      byKey.set(`${project.teamId}:${project.id}`, project);
    }
    return Array.from(byKey.values()).sort((left, right) => {
      const leftUpdated = Date.parse(left.updatedAt ?? "") || 0;
      const rightUpdated = Date.parse(right.updatedAt ?? "") || 0;
      if (leftUpdated !== rightUpdated) return rightUpdated - leftUpdated;
      return left.name.localeCompare(right.name);
    });
  } catch {
    return [];
  }
}

export function normalizeOpenPondOrganization(value: Record<string, unknown>): OpenPondOrganizationSummary | null {
  const teamId = stringValue(value.teamId) ?? stringValue(value.id);
  if (!teamId) return null;
  return {
    teamId,
    slug: stringValue(value.slug),
    displayName: stringValue(value.displayName) ?? stringValue(value.name),
  };
}

export function normalizeCloudProject(
  value: Record<string, unknown>,
  organization: OpenPondOrganizationSummary,
): CloudProject | null {
  const id = stringValue(value.id);
  const teamId = stringValue(value.teamId) ?? organization.teamId;
  if (!id || !teamId) return null;
  const status = stringValue(value.status);
  if (status === "archived" || stringValue(value.archivedAt)) return null;
  const name = stringValue(value.name) ?? stringValue(value.slug) ?? id;
  const sourceType = normalizeCloudProjectSourceType(value.sourceType);
  return {
    id,
    teamId,
    name,
    slug: stringValue(value.slug),
    sourceType,
    sourceLabel: cloudProjectSourceLabel(value, sourceType),
    defaultBranch: stringValue(value.defaultBranch) ?? stringValue(value.gitBranch),
    internalRepoPath: stringValue(value.internalRepoPath),
    manifestPath: stringValue(value.sandboxManifestPath),
    manifestHash: stringValue(value.sandboxManifestHash),
    syncedAt: stringValue(value.sandboxManifestSyncedAt),
    organizationName: organization.displayName,
    organizationSlug: organization.slug,
    createdAt: stringValue(value.createdAt),
    updatedAt: stringValue(value.updatedAt),
  };
}

export function normalizeCloudProjectSourceType(value: unknown): CloudProjectSourceType {
  return typeof value === "string" && CLOUD_PROJECT_SOURCE_TYPES.has(value as CloudProjectSourceType)
    ? (value as CloudProjectSourceType)
    : "manual";
}

export function cloudProjectSourceLabel(
  value: Record<string, unknown>,
  sourceType: CloudProjectSourceType,
): string | null {
  if (sourceType === "github_repo") {
    const owner = stringValue(value.gitOwner);
    const repo = stringValue(value.gitRepo);
    if (owner && repo) return `${owner}/${repo}`;
  }
  if (sourceType === "internal_repo") {
    return stringValue(value.internalRepoPath) ?? "Internal repo";
  }
  if (sourceType === "template") {
    return stringValue(value.templateRepoUrl) ?? stringValue(value.templateSourceProjectId) ?? "Template";
  }
  return stringValue(value.normalizedSourceIdentity);
}

export function booleanValue(value: unknown): boolean | null {
  return typeof value === "boolean" ? value : null;
}

export function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

export function nonEmptyRecord(value: unknown): Record<string, unknown> | null {
  const record = asRecord(value);
  return Object.keys(record).length > 0 ? record : null;
}

export function asRecordArray(value: unknown): Array<Record<string, unknown>> {
  return Array.isArray(value) ? value.map(asRecord).filter((item) => Object.keys(item).length > 0) : [];
}

export function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

export function parseHostedSourceDispatch(value: string | null): "request_only" | "coding_core" | null {
  if (!value) return null;
  if (value === "request_only" || value === "coding_core") return value;
  throw new Error("hostedSourceDispatch must be one of request_only, coding_core.");
}

export function stringArrayValue(value: unknown): string[] {
  return Array.isArray(value)
    ? value
        .filter((item): item is string => typeof item === "string" && item.trim().length > 0)
        .map((item) => item.trim())
    : [];
}

export function profileActionRunSummary(input: {
  action: string;
  code: number | null;
  stdout: string;
  stderr: string;
}): {
  artifactRefs: string[];
  output: string;
  responseSummary: Record<string, unknown>;
  status: "completed" | "failed";
  traceArtifactRefs: string[];
} {
  const status = input.code === 0 || input.code === null ? "completed" : "failed";
  let output = input.stdout.trim() || input.stderr.trim() || `Ran profile action ${input.action}.`;
  let artifactRefs: string[] = [];
  let traceArtifactRefs: string[] = [];
  try {
    const parsed = JSON.parse(input.stdout) as unknown;
    const parsedRecord = asRecord(parsed);
    const result = asRecord(parsedRecord.result);
    const resultText =
      stringValue(result.text) ??
      stringValue(result.summary) ??
      stringValue(result.message);
    if (resultText) output = resultText;
    artifactRefs = stringArrayValue(result.artifactRefs);
    const traceArtifactRef = stringValue(parsedRecord.traceArtifactRef);
    traceArtifactRefs = traceArtifactRef ? [traceArtifactRef] : [];
  } catch {
    // Plain stdout/stderr from an SDK command is still useful as the action response.
  }
  return {
    artifactRefs,
    output,
    responseSummary: {
      status: status === "completed" ? "available" : "failed",
      text: output,
    },
    status,
    traceArtifactRefs,
  };
}


export function internalRepoPathForLocalProject(project: LocalProject): string {
  const slug = slugifyInternalRepoSegment(project.name);
  const suffix = project.id.replace(/^local_/, "").replace(/[^a-z0-9]/gi, "").slice(0, 16);
  return `desktop-${slug}-${suffix || "project"}`;
}

export function slugifyInternalRepoSegment(value: string): string {
  const slug = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
  return slug || "project";
}

type LocalProjectCloudSourceUploadResult = {
  rootPath: string;
  branch: string;
  headCommit: string | null;
  fileCount: number;
  byteCount: number;
  skippedCount: number;
  initializedEmptyProject: boolean;
  transport: "git_head" | "snapshot" | "api_source_upload";
  syncPayload: Record<string, unknown>;
};

export async function uploadLocalProjectCloudSource(input: {
  localProject: LocalProject;
  targetProjectId: string;
  teamId: string;
  repoUrl: string;
  apiKey: string;
  branch: string;
  commitMessage: string;
  fallbackReadme: string;
}): Promise<LocalProjectCloudSourceUploadResult> {
  try {
    const gitPush = await pushLocalProjectSourceToGit(input.localProject, {
      repoUrl: input.repoUrl,
      apiKey: input.apiKey,
      branch: input.branch,
      commitMessage: input.commitMessage,
      fallbackReadme: input.fallbackReadme,
    });
    const syncPayload = asRecord(
      await sandboxRequestPayload({
        type: "project_sync",
        projectId: input.targetProjectId,
        payload: { teamId: input.teamId },
      }).catch(() => ({})),
    );
    return {
      rootPath: gitPush.rootPath,
      branch: gitPush.branch,
      headCommit: gitPush.headCommit,
      fileCount: gitPush.fileCount,
      byteCount: gitPush.byteCount,
      skippedCount: gitPush.skipped.length,
      initializedEmptyProject: gitPush.initializedEmptyProject,
      transport: gitPush.transport,
      syncPayload,
    };
  } catch {
    const bundle = await collectLocalProjectSourceUploadBundle(input.localProject);
    const initializedEmptyProject = bundle.entries.length === 0;
    const entries = initializedEmptyProject
      ? [
          {
            path: "README.md",
            type: "file" as const,
            contentsBase64: Buffer.from(input.fallbackReadme, "utf8").toString("base64"),
          },
        ]
      : bundle.entries;
    const byteCount = initializedEmptyProject
      ? Buffer.byteLength(input.fallbackReadme, "utf8")
      : bundle.totalBytes;
    const uploadPayload = asRecord(
      await sandboxRequestPayload({
        type: "project_source_upload",
        projectId: input.targetProjectId,
        payload: {
          teamId: input.teamId,
          entries,
          branch: input.branch,
          commitMessage: input.commitMessage,
          metadata: {
            source: "openpond-app-local-project-cloud-setup",
            transport: "api_source_upload",
          },
        },
      }),
    );
    return {
      rootPath: bundle.rootPath,
      branch: input.branch,
      headCommit: bundle.headCommit,
      fileCount: entries.length,
      byteCount,
      skippedCount: bundle.skipped.length,
      initializedEmptyProject,
      transport: "api_source_upload",
      syncPayload: uploadPayload,
    };
  }
}

export async function sandboxProjectRecordOrFallback(input: {
  projectId: string;
  teamId: string;
  fallback: Record<string, unknown>;
}): Promise<Record<string, unknown>> {
  try {
    const payload = asRecord(
      await sandboxRequestPayload({
        type: "project_get",
        projectId: input.projectId,
        payload: { teamId: input.teamId },
      }),
    );
    const project = asRecord(payload.project);
    return Object.keys(project).length > 0 ? project : input.fallback;
  } catch {
    return input.fallback;
  }
}

export async function upsertInternalSandboxProject(input: {
  teamId: string;
  projectName: string;
  branch: string;
  internalRepoPath: string;
  localProjectId: string;
}): Promise<Record<string, unknown>> {
  const payload = asRecord(
    await sandboxRequestPayload({
      type: "project_upsert",
      payload: {
        teamId: input.teamId,
        name: input.projectName,
        sourceType: "internal_repo",
        normalizedSourceIdentity: input.internalRepoPath,
        defaultBranch: input.branch,
        sourceConfig: {
          sourceType: "internal_repo",
          sourceValue: input.internalRepoPath,
        },
        metadata: {
          source: "openpond-app-local-project-cloud-setup",
          localProjectId: input.localProjectId,
        },
      },
    }),
  );
  const project = asRecord(payload.project);
  if (Object.keys(project).length === 0) {
    throw new Error("OpenPond Cloud Project response did not include a project.");
  }
  return project;
}

export function cloudProjectFromSandboxRecord(
  value: Record<string, unknown>,
  teamId: string,
  fallbackName: string,
  fallbackBranch: string,
): CloudProject {
  const normalized = normalizeCloudProject(
    { ...value, teamId },
    { teamId, slug: null, displayName: null },
  );
  if (normalized) return normalized;
  const id = stringValue(value.id);
  if (!id) throw new Error("OpenPond Cloud Project response did not include a project id.");
  return {
    id,
    teamId,
    name: stringValue(value.name) ?? fallbackName,
    slug: stringValue(value.slug),
    sourceType: normalizeCloudProjectSourceType(value.sourceType),
    sourceLabel: cloudProjectSourceLabel(value, normalizeCloudProjectSourceType(value.sourceType)),
    defaultBranch: stringValue(value.defaultBranch) ?? stringValue(value.gitBranch) ?? fallbackBranch,
    internalRepoPath: stringValue(value.internalRepoPath),
    manifestPath: stringValue(value.sandboxManifestPath),
    manifestHash: stringValue(value.sandboxManifestHash),
    syncedAt: stringValue(value.sandboxManifestSyncedAt),
    organizationName: null,
    organizationSlug: null,
    createdAt: stringValue(value.createdAt),
    updatedAt: stringValue(value.updatedAt),
  };
}

export function cloudWorkItemTeamInput(payload: unknown): { teamId: string } {
  const teamId = stringValue(asRecord(payload).teamId);
  if (!teamId) throw new Error("OpenPond team id is required.");
  return { teamId };
}

export function parseCreateImproveRun(value: unknown): CreateImproveRun | null {
  const parsed = CreateImproveRunSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

export function createImproveMetadata(
  run: CreateImproveRun | null | undefined,
): Record<string, unknown> {
  return run ? { createImproveRun: run } : {};
}

export function usageAttributionMetadata(
  usageAttribution: UsageRequestAttribution | null,
): Record<string, unknown> {
  return usageAttribution ? { usageAttribution } : {};
}

export function linkCreateImproveRunToWorkItem(input: {
  workItem: CloudWorkItem;
  run: CreateImproveRun | null;
}): CreateImproveRun | null {
  return input.run
    ? CreateImproveRunSchema.parse({
        ...input.run,
        adapter:
          input.run.adapter.kind === "hosted"
            ? {
                ...input.run.adapter,
                projectId: input.workItem.projectId,
                workItemId: input.workItem.id,
              }
            : input.run.adapter,
        scope: {
          ...input.run.scope,
          conversationId: input.workItem.conversationId ?? input.run.scope.conversationId,
          workItemId: input.workItem.id,
          projectId: input.workItem.projectId,
        },
        plan: input.run.plan
          ? {
              ...input.run.plan,
              metadata: {
                ...input.run.plan.metadata,
                workItemId: input.workItem.id,
                conversationId: input.workItem.conversationId,
                projectId: input.workItem.projectId,
              },
            }
          : null,
        workflowCapture: input.run.workflowCapture
          ? {
              ...input.run.workflowCapture,
              metadata: {
                ...input.run.workflowCapture.metadata,
                workItemId: input.workItem.id,
                conversationId: input.workItem.conversationId,
                projectId: input.workItem.projectId,
              },
            }
          : null,
        metadata: {
          ...input.run.metadata,
          workItemId: input.workItem.id,
          conversationId: input.workItem.conversationId,
          projectId: input.workItem.projectId,
        },
      })
    : null;
}

export function extractCreateImproveRun(record: Record<string, unknown>): CreateImproveRun | null {
  const metadata = asRecord(record.metadata);
  const payload = asRecord(record.payload);
  return (
    parseCreateImproveRun(record.createImproveRun) ??
    parseCreateImproveRun(metadata.createImproveRun) ??
    parseCreateImproveRun(payload.createImproveRun)
  );
}

export function attachCreateImproveRunToWorkItem(
  workItem: CloudWorkItem,
  run: CreateImproveRun | null,
): CloudWorkItem {
  return {
    ...workItem,
    createImproveRun: run ?? workItem.createImproveRun ?? null,
  };
}

export function latestCreateImproveRunFromTimeline(
  workItem: CloudWorkItem,
  messages: CloudWorkItemMessage[],
  activity: CloudWorkItemActivity[],
): CreateImproveRun | null {
  let latest = workItem.createImproveRun ?? null;
  for (const item of [...messages, ...activity]) {
    const run = parseCreateImproveRun(asRecord(item.metadata).createImproveRun);
    if (run) latest = run;
  }
  return latest;
}

export function normalizeCloudWorkItem(value: unknown): CloudWorkItem | null {
  const record = asRecord(value);
  if (!stringValue(record.id)) return null;
  const createImproveRun = extractCreateImproveRun(record);
  const parsed = CloudWorkItemSchema.safeParse({
    ...record,
    conversationId: stringValue(record.conversationId),
    sourceRef: stringValue(record.sourceRef),
    baseSha: stringValue(record.baseSha),
    latestRuntimeId: stringValue(record.latestRuntimeId),
    latestSandboxId: stringValue(record.latestSandboxId),
    latestTaskRunId: stringValue(record.latestTaskRunId),
    assignedAgentId: stringValue(record.assignedAgentId),
    archivedAt: stringValue(record.archivedAt),
    metadata: asRecord(record.metadata),
    createImproveRun,
  });
  return parsed.success ? parsed.data : null;
}

export function normalizeRequiredCloudWorkItem(value: unknown): CloudWorkItem {
  const workItem = normalizeCloudWorkItem(value);
  if (!workItem) throw new Error("OpenPond Cloud work item response did not include a work item.");
  return workItem;
}

export function normalizeCloudWorkItemMessage(value: unknown): CloudWorkItemMessage | null {
  const record = asRecord(value);
  if (!stringValue(record.id)) return null;
  const parsed = CloudWorkItemMessageSchema.safeParse({
    ...record,
    metadata: Object.keys(asRecord(record.metadata)).length > 0
      ? asRecord(record.metadata)
      : asRecord(record.payload),
  });
  return parsed.success ? parsed.data : null;
}

export function normalizeRequiredCloudWorkItemMessage(value: unknown): CloudWorkItemMessage {
  const message = normalizeCloudWorkItemMessage(value);
  if (!message) throw new Error("OpenPond Cloud work item response did not include a message.");
  return message;
}

export function normalizeCloudWorkItemActivity(value: unknown): CloudWorkItemActivity | null {
  const record = asRecord(value);
  if (!stringValue(record.id)) return null;
  const parsed = CloudWorkItemActivitySchema.safeParse({
    ...record,
    metadata: Object.keys(asRecord(record.metadata)).length > 0
      ? asRecord(record.metadata)
      : asRecord(record.payload),
  });
  return parsed.success ? parsed.data : null;
}

export function normalizeCloudWorkItemRuntimeSession(value: unknown): CloudWorkItemRuntimeSession | null {
  const record = asRecord(value);
  if (!stringValue(record.id)) return null;
  const parsed = CloudWorkItemRuntimeSessionSchema.safeParse({
    ...record,
    kind: stringValue(record.kind) ?? stringValue(record.sessionKind),
    metadata: asRecord(record.metadata),
  });
  return parsed.success ? parsed.data : null;
}

export function codexHistoryThreadReadOptions(requestUrl: URL | undefined): {
  maxEvents?: number;
  tail?: boolean;
} {
  if (!requestUrl) return {};
  const maxEvents = positiveIntegerParam(requestUrl.searchParams.get("limit"));
  return {
    ...(maxEvents ? { maxEvents } : {}),
    tail: requestUrl.searchParams.get("tail") === "1",
  };
}

export function nextCodexHistoryTurnId(events: RuntimeEvent[], sessionId: string): string {
  const prefix = `${sessionId}_turn_`;
  let maxTurnIndex = 0;
  for (const event of events) {
    const turnId = event.turnId;
    if (!turnId?.startsWith(prefix)) continue;
    const value = turnId.slice(prefix.length);
    if (!/^\d+$/.test(value)) continue;
    maxTurnIndex = Math.max(maxTurnIndex, Number.parseInt(value, 10));
  }
  return `${prefix}${maxTurnIndex + 1}`;
}

export function positiveIntegerParam(value: string | null): number | undefined {
  if (!value) return undefined;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return undefined;
  return Math.min(50_000, parsed);
}

const CODEX_HISTORY_BASE_SESSION_CONFIG = {
  "tools.web_search": true,
  "tools.view_image": true,
  "features.web_search_request": true,
};

export function codexHistorySessionConfig(permissionMode: "default" | "auto-review" | "full-access"): Record<string, unknown> {
  return {
    ...CODEX_HISTORY_BASE_SESSION_CONFIG,
    approvals_reviewer: permissionMode === "auto-review" ? "auto_review" : "user",
  };
}
