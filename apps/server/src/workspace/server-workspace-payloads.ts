import { sandboxRequestPayload } from "../openpond/sandboxes.js";
import { createHtmlPreviewService } from "./html-preview.js";
import { promises as fs } from "node:fs";
import path from "node:path";
import { loadLocalOutputFile, loadLocalOutputImage } from "./local-output-files.js";
import { resolveChatFile } from "./resolve-chat-file.js";
import {
  CreateLocalProjectRequestSchema,
  SaveWorkspaceFileRequestSchema,
  WorkspaceBranchRequestSchema,
  WorkspaceDiffFileSchema,
  WorkspaceDiffSummarySchema,
  WorkspaceLspActionRequestSchema,
  WorkspaceLspActionResponseSchema,
  WorkspaceLspDiagnosticsResponseSchema,
  WorkspaceLspRuntimeStatusResponseSchema,
  WorkspaceLspSettingsStatusResponseSchema,
  WorkspaceLspTouchRequestSchema,
  WorkspaceStateSchema,
  WorkspaceTemplateConfigViewSchema,
  workspacePathFromLocalPathWorkspaceId,
  type AccountState,
  type AppPreferences,
  type BootstrapPayload,
  type LocalProject,
  type OpenPondApp,
  type Session,
  type WorkspaceDiffFile,
  type WorkspaceDiffSummary,
  type WorkspaceState,
} from "@openpond/contracts";
import {
  getOpenPondAppEnvironment,
  loadOpenPondAccountContext,
} from "@openpond/runtime";
import {
  WORKSPACE_TEMPLATE_CONFIG_PATH,
  loadWorkspaceTemplateConfig,
  parseConfigEnvValue,
} from "./workspace-config.js";
import {
  checkoutBranchAtPath,
  checkoutBranch as checkoutWorkspaceBranch,
  appWorkspacePaths,
  createAndCheckoutBranch,
  createAndCheckoutBranchAtPath,
  loadWorkspaceDiff,
  loadWorkspaceDiffAtPath,
  loadWorkspaceFile,
  loadWorkspaceFileAtPath,
  loadWorkspaceImageFile,
  loadWorkspaceState,
  loadWorkspaceStateAtPath,
  pathExists,
  type WorkspaceImageFile,
  type WorkspacePaths,
} from "./workspaces.js";
import {
  deleteLocalProject,
  findLocalProject,
  linkLocalProjectOpenPondApp,
  localProjectStateWorkspace,
  localProjectWorkspacePaths,
  refreshLocalProjectGitMetadata,
  updateLocalProjectAgentSetup,
  upsertLocalProject,
} from "./local-projects.js";
import { subagentIsolatedWorkspaceRepoPath } from "./subagent-workspace.js";
import { writeWorkspaceFile } from "../workspace-tools/workspace-tool-file-system.js";
import type { SqliteStore } from "../store/store.js";
import { now, textFromUnknown } from "../utils.js";
import { WorkspaceLspManager } from "./workspace-lsp.js";

export type ServerWorkspacePayloads = ReturnType<typeof createServerWorkspacePayloads>;

export function createServerWorkspacePayloads(deps: {
  store: SqliteStore;
  storeDir: string;
  openPondCacheScope: (account: AccountState) => string;
  findOpenPondApp: (appId: string) => Promise<OpenPondApp>;
  loadAppPreferences: () => Promise<AppPreferences>;
  bootstrapPayload: (bootstrapOptions?: { forceOpenPond?: boolean; ensureProfile?: boolean }) => Promise<BootstrapPayload>;
}) {
  const { store, storeDir, findOpenPondApp, loadAppPreferences, bootstrapPayload } = deps;
  const workspaceLspManager = new WorkspaceLspManager();

  async function findLocalWorkspace(projectId: string): Promise<LocalProject | null> {
    return findLocalProject(store, projectId);
  }

  async function localPathWorkspaceForId(appId: string): Promise<{ paths: WorkspacePaths; workspace: OpenPondApp } | null> {
    const workspacePath = workspacePathFromLocalPathWorkspaceId(appId);
    if (!workspacePath) return null;
    if (!path.isAbsolute(workspacePath)) throw new Error("Workspace path must be absolute");
    if (!(await pathExists(workspacePath))) throw new Error("Workspace path not found");
    const stats = await fs.stat(workspacePath);
    if (!stats.isDirectory()) throw new Error("Workspace path must be a directory");
    return {
      paths: {
        workspacePath,
        repoPath: workspacePath,
      },
      workspace: {
        id: appId,
        name: path.basename(workspacePath) || workspacePath,
        description: null,
        visibility: "private",
        gitOwner: null,
        gitRepo: null,
        gitHost: null,
        defaultBranch: null,
        sandbox: false,
        updatedAt: now(),
        latestDeployment: null,
      },
    };
  }

  async function refreshLocalProjectWorkspace(projectId: string): Promise<LocalProject> {
    return refreshLocalProjectGitMetadata(store, projectId);
  }

  function gitBaseUrlFromContext(context: Awaited<ReturnType<typeof loadOpenPondAccountContext>>): string | null {
    return (
      context.account?.baseUrl ??
      context.accountState.activeProfile?.baseUrl ??
      context.accountState.baseUrl ??
      context.config.baseUrl ??
      null
    );
  }

  async function workspaceStatePayload(appId: string, ensureWorkspace: boolean): Promise<WorkspaceState> {
    const localPathWorkspace = await localPathWorkspaceForId(appId);
    if (localPathWorkspace) {
      return WorkspaceStateSchema.parse(
        await loadWorkspaceStateAtPath(localPathWorkspace.paths, localPathWorkspace.workspace, {
          clone: false,
          allowPlainFolder: true,
        })
      );
    }
    const localProject = await findLocalWorkspace(appId);
    if (localProject) {
      return WorkspaceStateSchema.parse(
        await loadWorkspaceStateAtPath(
          localProjectWorkspacePaths(localProject),
          localProjectStateWorkspace(localProject),
          {
            clone: false,
            allowPlainFolder: true,
            linkedSourceHeadCommit: localProject.linkedSandboxProject?.lastUploadedCommit ?? null,
          }
        )
      );
    }
    const app = await findOpenPondApp(appId);
    const context = await loadOpenPondAccountContext();
    return WorkspaceStateSchema.parse(
      await loadWorkspaceState(storeDir, app, {
        clone: ensureWorkspace,
        gitBaseUrl: gitBaseUrlFromContext(context),
        token: context.token,
      })
    );
  }

  async function workspaceTemplateConfigPayload(appId: string): Promise<unknown> {
    if ((await localPathWorkspaceForId(appId)) || (await findLocalWorkspace(appId))) {
      return WorkspaceTemplateConfigViewSchema.parse({
        appId,
        exists: false,
        configPath: WORKSPACE_TEMPLATE_CONFIG_PATH,
        envVar: null,
        toolName: null,
        version: null,
        source: "missing",
        currentConfig: null,
        defaults: null,
        schema: null,
        error: null,
        updatedAt: now(),
      });
    }
    const app = await findOpenPondApp(appId);
    const { repoPath } = appWorkspacePaths(storeDir, app.id);
    let contract: Awaited<ReturnType<typeof loadWorkspaceTemplateConfig>>;
    try {
      contract = await loadWorkspaceTemplateConfig(repoPath);
    } catch (error) {
      const message = textFromUnknown(error);
      const missing = /ENOENT|no such file|cannot find/i.test(message);
      return WorkspaceTemplateConfigViewSchema.parse({
        appId: app.id,
        exists: false,
        configPath: WORKSPACE_TEMPLATE_CONFIG_PATH,
        envVar: null,
        toolName: null,
        version: null,
        source: "missing",
        currentConfig: null,
        defaults: null,
        schema: null,
        error: missing ? null : message,
        updatedAt: now(),
      });
    }

    let currentConfig = contract.defaults;
    let source: "hosted_env" | "local_file" | "defaults" = "defaults";
    let error: string | null = null;
    try {
      const environment = await getOpenPondAppEnvironment({ appId: app.id });
      const configured = parseConfigEnvValue(environment.environment?.[contract.envVar]);
      if (configured) {
        currentConfig = configured;
        source = "hosted_env";
      }
    } catch (environmentError) {
      error = textFromUnknown(environmentError);
      source = "local_file";
    }

    return WorkspaceTemplateConfigViewSchema.parse({
      appId: app.id,
      exists: true,
      configPath: WORKSPACE_TEMPLATE_CONFIG_PATH,
      envVar: contract.envVar,
      toolName: contract.toolName,
      version: contract.version,
      source,
      currentConfig,
      defaults: contract.defaults,
      schema: contract.schema,
      error,
      updatedAt: now(),
    });
  }

  async function ensureSessionWorkspace(appId: string): Promise<string> {
    const state = await workspaceStatePayload(appId, true);
    if (!state.initialized) {
      throw new Error(state.error ? `Workspace unavailable: ${state.error}` : "Workspace unavailable");
    }
    return state.repoPath;
  }

  function defaultSessionCwd(appId?: string | null): string {
    return appId ? appWorkspacePaths(storeDir, appId).repoPath : process.cwd();
  }

  async function resolveSessionWorkspaceCwd(
    session: Pick<Session, "appId" | "cwd" | "metadata" | "subagentRunId" | "workspaceId" | "workspaceKind">,
    options: { ensureOpenPond?: boolean } = {}
  ): Promise<string | null> {
    const subagentRepoPath = subagentIsolatedWorkspaceRepoPath(session);
    if (subagentRepoPath) return subagentRepoPath;
    if (session.workspaceKind === "local_project" && session.workspaceId) {
      const project = await findLocalWorkspace(session.workspaceId);
      if (project) return localProjectWorkspacePaths(project).repoPath;
    }
    if (session.appId) {
      return options.ensureOpenPond ? await ensureSessionWorkspace(session.appId) : defaultSessionCwd(session.appId);
    }
    return session.cwd ?? null;
  }

  async function createWorkspaceBranchPayload(appId: string, payload: unknown): Promise<WorkspaceState> {
    const input = WorkspaceBranchRequestSchema.parse(payload);
    const localPathWorkspace = await localPathWorkspaceForId(appId);
    if (localPathWorkspace) {
      return WorkspaceStateSchema.parse(
        await createAndCheckoutBranchAtPath(localPathWorkspace.paths, localPathWorkspace.workspace, input.branch)
      );
    }
    const localProject = await findLocalWorkspace(appId);
    if (localProject) {
      return WorkspaceStateSchema.parse(
        await createAndCheckoutBranchAtPath(
          localProjectWorkspacePaths(localProject),
          localProjectStateWorkspace(localProject),
          input.branch,
          { linkedSourceHeadCommit: localProject.linkedSandboxProject?.lastUploadedCommit ?? null }
        )
      );
    }
    const app = await findOpenPondApp(appId);
    return WorkspaceStateSchema.parse(await createAndCheckoutBranch(storeDir, app, input.branch));
  }

  async function checkoutWorkspaceBranchPayload(appId: string, payload: unknown): Promise<WorkspaceState> {
    const input = WorkspaceBranchRequestSchema.parse(payload);
    const localPathWorkspace = await localPathWorkspaceForId(appId);
    if (localPathWorkspace) {
      return WorkspaceStateSchema.parse(
        await checkoutBranchAtPath(localPathWorkspace.paths, localPathWorkspace.workspace, input.branch)
      );
    }
    const localProject = await findLocalWorkspace(appId);
    if (localProject) {
      return WorkspaceStateSchema.parse(
        await checkoutBranchAtPath(
          localProjectWorkspacePaths(localProject),
          localProjectStateWorkspace(localProject),
          input.branch,
          { linkedSourceHeadCommit: localProject.linkedSandboxProject?.lastUploadedCommit ?? null }
        )
      );
    }
    const app = await findOpenPondApp(appId);
    return WorkspaceStateSchema.parse(await checkoutWorkspaceBranch(storeDir, app, input.branch));
  }

  async function workspaceDiffPayload(
    appId: string,
    options: { includeFileDetails?: boolean } = {}
  ): Promise<WorkspaceDiffSummary> {
    const localPathWorkspace = await localPathWorkspaceForId(appId);
    if (localPathWorkspace) {
      return WorkspaceDiffSummarySchema.parse(
        await loadWorkspaceDiffAtPath(localPathWorkspace.paths.repoPath, appId, options)
      );
    }
    const localProject = await findLocalWorkspace(appId);
    if (localProject) {
      return WorkspaceDiffSummarySchema.parse(
        await loadWorkspaceDiffAtPath(localProjectWorkspacePaths(localProject).repoPath, localProject.id, options)
      );
    }
    const app = await findOpenPondApp(appId);
    return WorkspaceDiffSummarySchema.parse(await loadWorkspaceDiff(storeDir, app, options));
  }

  const htmlPreviews = createHtmlPreviewService();
  async function resolveWorkspaceFilePayload(appId: string, filePath: string | null) {
    if (!filePath?.trim()) throw new Error("File path is required");
    const localPath = await localPathWorkspaceForId(appId);
    if (localPath) return resolveChatFile({ roots: [localPath.paths.repoPath], requestedPath: filePath, allowExternalPaths: true });
    const project = await findLocalWorkspace(appId);
    if (project) return resolveChatFile({
      roots: project.sourceFolders?.length ? project.sourceFolders : [localProjectWorkspacePaths(project).repoPath],
      requestedPath: filePath,
      allowExternalPaths: true,
    });
    return resolveChatFile({ roots: [await workspaceRepoPathPayload(appId)], requestedPath: filePath, allowExternalPaths: false });
  }
  async function htmlContentPreviewPayload(payload: unknown) {
    const input = payload as { name?: unknown; content?: unknown } | null;
    if (typeof input?.name !== "string" || typeof input.content !== "string") throw new Error("HTML name and content are required");
    return htmlPreviews.openContent(input.name, input.content);
  }
  async function sandboxHtmlPreviewPayload(sandboxId: string, filePath: string | null) {
    if (!filePath?.trim()) throw new Error("File path is required");
    const root = filePath.startsWith("/workspace/") ? "/workspace" : path.posix.isAbsolute(filePath) ? path.posix.dirname(filePath) : ".";
    return htmlPreviews.openRemote(path.posix.relative(root, filePath), async (assetPath) => {
      const payload = await sandboxRequestPayload({ type: "download_file", sandboxId, payload: { path: path.posix.join(root, assetPath), maxBytes: 20 * 1024 * 1024 } }) as { file?: { contentsBase64?: string; truncated?: boolean } };
      if (payload.file?.truncated || typeof payload.file?.contentsBase64 !== "string") throw new Error("Preview asset is unavailable or too large");
      return Buffer.from(payload.file.contentsBase64, "base64");
    });
  }
  async function workspaceHtmlPreviewPayload(appId: string, filePath: string | null) {
    if (!filePath?.trim()) throw new Error("File path is required");
    const local = await localPathWorkspaceForId(appId) ?? await findLocalWorkspace(appId);
    return htmlPreviews.open(await workspaceRepoPathPayload(appId), filePath.trim(), Boolean(local));
  }

  async function workspaceFilePayload(appId: string, filePath: string | null): Promise<WorkspaceDiffFile> {
    if (!filePath?.trim()) throw new Error("File path is required");
    const localPathWorkspace = await localPathWorkspaceForId(appId);
    if (localPathWorkspace) {
      return WorkspaceDiffFileSchema.parse(
        await loadLocalOutputFile(localPathWorkspace.paths.repoPath, filePath)
      );
    }
    const localProject = await findLocalWorkspace(appId);
    if (localProject) {
      return WorkspaceDiffFileSchema.parse(
        await loadLocalOutputFile(localProjectWorkspacePaths(localProject).repoPath, filePath)
      );
    }
    const app = await findOpenPondApp(appId);
    return WorkspaceDiffFileSchema.parse(await loadWorkspaceFile(storeDir, app, filePath));
  }

  async function workspaceRepoPathPayload(appId: string): Promise<string> {
    const localPathWorkspace = await localPathWorkspaceForId(appId);
    if (localPathWorkspace) return localPathWorkspace.paths.repoPath;
    const localProject = await findLocalWorkspace(appId);
    if (localProject) return localProjectWorkspacePaths(localProject).repoPath;
    const state = await workspaceStatePayload(appId, true);
    if (!state.initialized) {
      throw new Error(state.error ? `Workspace unavailable: ${state.error}` : "Workspace unavailable");
    }
    return state.repoPath;
  }

  async function saveWorkspaceFilePayload(appId: string, payload: unknown): Promise<WorkspaceDiffFile> {
    const input = SaveWorkspaceFileRequestSchema.parse(payload);
    const localPathWorkspace = await localPathWorkspaceForId(appId);
    if (localPathWorkspace) {
      const saved = await writeWorkspaceFile(localPathWorkspace.paths.repoPath, input.path, input.content);
      return WorkspaceDiffFileSchema.parse(await loadWorkspaceFileAtPath(localPathWorkspace.paths.repoPath, saved.path));
    }
    const localProject = await findLocalWorkspace(appId);
    if (localProject) {
      const { repoPath } = localProjectWorkspacePaths(localProject);
      const saved = await writeWorkspaceFile(repoPath, input.path, input.content);
      return WorkspaceDiffFileSchema.parse(await loadWorkspaceFileAtPath(repoPath, saved.path));
    }
    const app = await findOpenPondApp(appId);
    const { repoPath } = appWorkspacePaths(storeDir, app.id);
    const saved = await writeWorkspaceFile(repoPath, input.path, input.content);
    return WorkspaceDiffFileSchema.parse(await loadWorkspaceFileAtPath(repoPath, saved.path));
  }

  async function workspaceImagePayload(appId: string, filePath: string | null): Promise<WorkspaceImageFile> {
    if (!filePath?.trim()) throw new Error("Image path is required");
    const localPathWorkspace = await localPathWorkspaceForId(appId);
    if (localPathWorkspace) {
      const resolved = await resolveWorkspaceFilePayload(appId, filePath);
      if (resolved.status !== "resolved" || resolved.kind !== "file") throw new Error("Image not found or ambiguous. Open the link to choose a file.");
      return loadLocalOutputImage(localPathWorkspace.paths.repoPath, resolved.path);
    }
    const localProject = await findLocalWorkspace(appId);
    if (localProject) {
      const resolved = await resolveWorkspaceFilePayload(appId, filePath);
      if (resolved.status !== "resolved" || resolved.kind !== "file") throw new Error("Image not found or ambiguous. Open the link to choose a file.");
      return loadLocalOutputImage(localProjectWorkspacePaths(localProject).repoPath, resolved.path);
    }
    const app = await findOpenPondApp(appId);
    return loadWorkspaceImageFile(storeDir, app, filePath);
  }

  async function workspaceLspTouchPayload(appId: string, payload: unknown): Promise<unknown> {
    const input = WorkspaceLspTouchRequestSchema.parse(payload);
    const [repoPath, preferences] = await Promise.all([workspaceRepoPathPayload(appId), loadAppPreferences()]);
    return WorkspaceLspDiagnosticsResponseSchema.parse(
      await workspaceLspManager.touchFile({
        appId,
        repoPath,
        path: input.path,
        content: input.content,
        preferences,
        waitForDiagnostics: input.waitForDiagnostics,
      }),
    );
  }

  async function workspaceLspActionPayload(appId: string, payload: unknown): Promise<unknown> {
    const input = WorkspaceLspActionRequestSchema.parse(payload);
    const [repoPath, preferences] = await Promise.all([workspaceRepoPathPayload(appId), loadAppPreferences()]);
    return WorkspaceLspActionResponseSchema.parse(
      await workspaceLspManager.runAction({
        appId,
        repoPath,
        path: input.path,
        operation: input.operation,
        content: input.content,
        preferences,
        line: input.line,
        character: input.character,
      }),
    );
  }

  async function workspaceLspSettingsStatusPayload(): Promise<unknown> {
    return WorkspaceLspSettingsStatusResponseSchema.parse(
      await workspaceLspManager.settingsStatus({ preferences: await loadAppPreferences() }),
    );
  }

  async function workspaceLspRuntimeStatusPayload(): Promise<unknown> {
    return WorkspaceLspRuntimeStatusResponseSchema.parse(workspaceLspManager.runtimeStatus());
  }

  async function restartWorkspaceLspPayload(): Promise<unknown> {
    const result = workspaceLspManager.shutdown();
    return {
      ok: true,
      ...result,
    };
  }

  async function createLocalProjectPayload(payload: unknown): Promise<{ project: LocalProject; bootstrap: BootstrapPayload; created: boolean }> {
    CreateLocalProjectRequestSchema.parse(payload);
    const preferences = await loadAppPreferences();
    const { project, created } = await upsertLocalProject(store, payload, {
      defaultNewProjectDirectory: preferences.defaultNewProjectDirectory,
    });
    return {
      project,
      created,
      bootstrap: await bootstrapPayload(),
    };
  }

  async function deleteLocalProjectPayload(projectId: string): Promise<BootstrapPayload> {
    await deleteLocalProject(store, projectId);
    await store.updateSessionsWhere((session) => {
      return session.workspaceKind === "local_project" && session.workspaceId === projectId;
    }, (session) => {
      const { workspaceKind: _workspaceKind, ...chatSession } = session;
      return {
        ...chatSession,
        appId: null,
        appName: null,
        workspaceId: null,
        workspaceName: null,
        updatedAt: now(),
      };
    });
    return bootstrapPayload();
  }

  async function updateLocalProjectAgentSetupPayload(
    projectId: string,
    payload: unknown,
  ): Promise<{ project: LocalProject; bootstrap: BootstrapPayload }> {
    const project = await updateLocalProjectAgentSetup(store, projectId, payload);
    return {
      project,
      bootstrap: await bootstrapPayload(),
    };
  }

  return {
    gitBaseUrlFromContext,
    findLocalWorkspace,
    refreshLocalProjectWorkspace,
    linkLocalProjectOpenPondApp: (projectId: string, app: OpenPondApp, options?: { repoPath?: string | null }) =>
      linkLocalProjectOpenPondApp(store, projectId, app, options),
    workspaceStatePayload,
    workspaceTemplateConfigPayload,
    ensureSessionWorkspace,
    resolveSessionWorkspaceCwd,
    defaultSessionCwd,
    createWorkspaceBranchPayload,
    checkoutWorkspaceBranchPayload,
    workspaceDiffPayload,
    workspaceFilePayload,
    resolveWorkspaceFilePayload,
    workspaceHtmlPreviewPayload,
    htmlContentPreviewPayload,
    sandboxHtmlPreviewPayload,
    saveWorkspaceFilePayload,
    workspaceImagePayload,
    workspaceLspTouchPayload,
    workspaceLspActionPayload,
    workspaceLspSettingsStatusPayload,
    workspaceLspRuntimeStatusPayload,
    restartWorkspaceLspPayload,
    closeWorkspaceLsp: async () => { await Promise.all([workspaceLspManager.shutdown(), htmlPreviews.close()]); },
    createLocalProjectPayload,
    deleteLocalProjectPayload,
    updateLocalProjectAgentSetupPayload,
  };
}
