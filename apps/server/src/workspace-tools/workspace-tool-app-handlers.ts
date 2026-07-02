import { Buffer } from "node:buffer";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import {
  OpenPondAppSchema,
  OPENPOND_MANIFEST_FILE_NAME,
  SANDBOX_TEMPLATE_BUILD_PLAN_FILE_NAME,
  WorkspaceToolResultSchema,
  sandboxTemplateBuildPlan,
  sandboxTemplateExecutableEntries,
  validateSandboxTemplateYaml,
  type LocalProject,
  type SandboxTemplateExecutable,
  type SandboxTemplateManifest,
  type Session,
  type WorkspaceToolRequest,
  type WorkspaceToolResult,
} from "@openpond/contracts";
import {
  createOpenPondRepoApp,
  loadOpenPondAccountContext,
} from "@openpond/runtime";
import type { SandboxEnvVarInput } from "@openpond/cloud";
import { writeSandboxTemplateScaffold } from "../scaffold/sandbox-template-scaffold.js";
import { sandboxRequestPayload, type SandboxRequestAction } from "../openpond/sandboxes.js";
import { expectedRemoteUrl } from "../workspace/workspace-common.js";
import { localProjectSandboxTemplateRootPath } from "../workspace/local-projects.js";
import {
  commitWorkspaceChanges,
  ensureWorkspaceGitRepository,
  getWorkspaceDeploymentSource,
  getWorkspaceGitStatus,
  getWorkspaceOriginUrl,
  pushWorkspaceBranch,
  setWorkspaceOrigin,
  workspaceHasHead,
} from "./workspace-tools.js";
import { trimOutput } from "./workspace-tool-common.js";
import type { WorkspaceToolExecutorDeps } from "./workspace-tool-executor-types.js";

type WorkspaceActionProgress = {
  action?: string;
  status?: "started" | "completed" | "failed" | "pending";
  output?: string;
  data?: unknown;
};

type WorkspaceActionProgressReporter = (progress: WorkspaceActionProgress) => Promise<void>;

type AppActionHandlerInput = {
  input: WorkspaceToolRequest;
  session: Session;
  reportProgress?: WorkspaceActionProgressReporter;
  gitBaseUrlFromContext: WorkspaceToolExecutorDeps["gitBaseUrlFromContext"];
  findLocalWorkspace: WorkspaceToolExecutorDeps["findLocalWorkspace"];
  linkLocalProjectOpenPondApp: WorkspaceToolExecutorDeps["linkLocalProjectOpenPondApp"];
  openPondCacheScope: WorkspaceToolExecutorDeps["openPondCacheScope"];
  updateSession: WorkspaceToolExecutorDeps["updateSession"];
  upsertScaffoldApp: WorkspaceToolExecutorDeps["upsertScaffoldApp"];
};

type AppActionHandlerResult = {
  result: WorkspaceToolResult;
  session: Session;
};

export async function handleAppWorkspaceToolAction({
  input,
  session,
  reportProgress,
  gitBaseUrlFromContext,
  findLocalWorkspace,
  linkLocalProjectOpenPondApp,
  openPondCacheScope,
  updateSession,
  upsertScaffoldApp,
}: AppActionHandlerInput): Promise<AppActionHandlerResult | null> {
  if (input.action === "validate_sandbox_template") {
    if (session.workspaceKind !== "local_project") {
      throw new Error("Sandbox template validation is only available for local project workspaces.");
    }
    const projectId = session.workspaceId;
    if (!projectId) throw new Error("No active project workspace");
    const project = await findLocalWorkspace(projectId);
    if (!project?.sandboxTemplate?.detected) {
      throw new Error("This project does not contain openpond.yaml.");
    }
    const template = await readSandboxTemplateFromDisk(project);
    const diagnostics = template.diagnostics ?? [];
    const output = template.valid
      ? `Sandbox template ${template.manifest?.name ?? project.name} is valid.`
      : `Sandbox template is invalid:\n${diagnostics
          .map((diagnostic) => `${diagnostic.path}: ${diagnostic.message}`)
          .join("\n")}`;
    return {
      session,
      result: WorkspaceToolResultSchema.parse({
        ok: template.valid,
        action: input.action,
        appId: session.appId,
        output,
        data: {
          projectId: project.id,
          manifestPath: template.manifestPath,
          manifest: template.manifest,
          diagnostics,
        },
      }),
    };
  }

  if (input.action === "build_sandbox_template") {
    if (session.workspaceKind !== "local_project") {
      throw new Error("Sandbox template build is only available for local project workspaces.");
    }
    const projectId = session.workspaceId;
    if (!projectId) throw new Error("No active project workspace");
    const project = await findLocalWorkspace(projectId);
    if (!project?.sandboxTemplate?.detected) {
      throw new Error("This project does not contain openpond.yaml.");
    }
    const template = await readSandboxTemplateFromDisk(project);
    const manifest = validSandboxTemplateManifest(template);
    const rootPath = localProjectSandboxTemplateRootPath(project);
    const outputPath = path.join(rootPath, "dist", SANDBOX_TEMPLATE_BUILD_PLAN_FILE_NAME);
    const plan = sandboxTemplateBuildPlan({
      manifest,
      manifestFile: path.relative(rootPath, template.manifestPath) || OPENPOND_MANIFEST_FILE_NAME,
      projectRoot: path.relative(path.dirname(outputPath), rootPath) || ".",
    });
    await fs.mkdir(path.dirname(outputPath), { recursive: true });
    await fs.writeFile(outputPath, `${JSON.stringify(plan, null, 2)}\n`, "utf8");
    return {
      session,
      result: WorkspaceToolResultSchema.parse({
        ok: true,
        action: input.action,
        appId: session.appId,
        output: `Built sandbox template ${manifest.name} to ${path.relative(rootPath, outputPath)}.`,
        data: {
          projectId: project.id,
          manifestPath: template.manifestPath,
          outputPath,
          plan,
        },
      }),
    };
  }

  if (input.action === "run_sandbox_template") {
    if (session.workspaceKind !== "local_project") {
      throw new Error("Sandbox template run is only available for local project workspaces.");
    }
    const projectId = session.workspaceId;
    if (!projectId) throw new Error("No active project workspace");
    const project = await findLocalWorkspace(projectId);
    if (!project?.sandboxTemplate?.detected) {
      throw new Error("This project does not contain openpond.yaml.");
    }
    const template = await readSandboxTemplateFromDisk(project);
    const manifest = validSandboxTemplateManifest(template);
    const rootPath = localProjectSandboxTemplateRootPath(project);
    const target =
      typeof input.args.target === "string" && input.args.target.trim()
        ? input.args.target.trim()
        : "start";
    const executable = resolveSandboxTemplateRunTarget(manifest, target);
    if (executable.kind === "service") {
      throw new Error("Use the terminal dev action for service targets; local run is for start/actions.");
    }
    const params =
      input.args.params && typeof input.args.params === "object" && !Array.isArray(input.args.params)
        ? (input.args.params as Record<string, unknown>)
        : {};
    const uploads = localSandboxTemplateUploadsArg(input.args.uploads);
    const env = sandboxTemplateEnvArg(input.args.env);
    const mode = sandboxTemplateRunModeArg(input.args.mode);
    if (mode === "local" && env.length > 0) {
      throw new Error("Sandbox template env refs are supported for hosted sandbox runs only.");
    }
    if (mode === "sandbox") {
      const run = await runSandboxTemplateExecutableInLinkedSandbox({
        project,
        manifest,
        executable,
        params,
        env,
        uploads,
        sandboxId: typeof input.args.sandboxId === "string" ? input.args.sandboxId.trim() : "",
        reportProgress,
      });
      const artifactSummary = run.artifacts
        .map((artifact) => `${artifact.path}: ${artifact.exists ? `${artifact.sizeBytes ?? 0} bytes` : "missing"}`)
        .join(", ");
      return {
        session,
        result: WorkspaceToolResultSchema.parse({
          ok: run.execution.status === "succeeded",
          action: input.action,
          appId: session.appId,
          output:
            run.execution.status === "succeeded"
              ? `${run.sandboxCreated ? `Started sandbox ${run.sandbox.id} and ran` : "Ran"} sandbox template ${manifest.name} target ${executable.name} on sandbox ${run.sandbox.id}. ${artifactSummary ? `Artifacts: ${artifactSummary}.` : ""}`
              : `Sandbox template target ${executable.name} failed on sandbox ${run.sandbox.id}:\n${run.execution.output}`,
          data: {
            projectId: project.id,
            template: manifest.name,
            mode,
            executable,
            ...run,
          },
        }),
      };
    }
    const run = await runSandboxTemplateExecutableLocally({
      rootPath,
      manifest,
      executable,
      params,
      uploads,
      reportProgress,
    });
    const artifactSummary = run.artifacts
      .map((artifact) => `${artifact.path}: ${artifact.exists ? `${artifact.sizeBytes ?? 0} bytes` : "missing"}`)
      .join(", ");
    return {
      session,
      result: WorkspaceToolResultSchema.parse({
        ok: run.execution.status === "succeeded",
        action: input.action,
        appId: session.appId,
        output:
          run.execution.status === "succeeded"
            ? `Ran sandbox template ${manifest.name} target ${executable.name}. ${artifactSummary ? `Artifacts: ${artifactSummary}.` : ""}`
            : `Sandbox template target ${executable.name} failed:\n${run.execution.output}`,
        data: {
          projectId: project.id,
          template: manifest.name,
          mode,
          executable,
          ...run,
        },
      }),
    };
  }

  if (input.action === "create_sandbox_template_scaffold") {
    if (session.workspaceKind !== "local_project") {
      throw new Error("Sandbox template scaffolding is only available for local project workspaces.");
    }
    const projectId = session.workspaceId;
    if (!projectId) throw new Error("No active project workspace");
    const project = await findLocalWorkspace(projectId);
    if (!project) throw new Error("Project workspace not found");
    const repoPath = localProjectSandboxTemplateRootPath(project);
    const scaffold = await writeSandboxTemplateScaffold(repoPath, {
      manifestOnly: input.args.manifestOnly === true,
      manifestContent:
        typeof input.args.manifestContent === "string" ? input.args.manifestContent : null,
      manifestPath:
        typeof input.args.manifestPath === "string" ? input.args.manifestPath : null,
      projectName:
        typeof input.args.name === "string" && input.args.name.trim()
          ? input.args.name.trim()
          : project.name,
    });
    const updatedProject = (await findLocalWorkspace(project.id)) ?? project;
    const updatedSession = await updateSession(session.id, {
      workspaceKind: "local_project",
      workspaceId: updatedProject.id,
      workspaceName: updatedProject.name,
      cwd: localProjectSandboxTemplateRootPath(updatedProject),
      title: session.title === "New chat" ? updatedProject.name : session.title,
    });
    return {
      session: updatedSession,
      result: WorkspaceToolResultSchema.parse({
        ok: true,
        action: input.action,
        appId: session.appId,
        output: `Created sandbox template scaffold with ${scaffold.files.length} files.`,
        data: {
          project: updatedProject,
          files: scaffold.files,
        },
      }),
    };
  }

  if (input.action === "publish_openpond_repo") {
    if (session.workspaceKind !== "local_project") {
      throw new Error("Publish to OpenPond is only available for local project workspaces.");
    }
    const projectId = session.workspaceId;
    if (!projectId) throw new Error("No active project workspace");
    const project = await findLocalWorkspace(projectId);
    if (!project) throw new Error("Project workspace not found");
    const isSandboxTemplateProject = Boolean(project.sandboxTemplate?.detected);
    if (!isSandboxTemplateProject) {
      throw new Error("This project must contain openpond.yaml.");
    }
    if (project.linkedOpenPondApp?.appId) {
      throw new Error(`Project is already linked to ${project.linkedOpenPondApp.appName}.`);
    }

    const repoPath = localProjectSandboxTemplateRootPath(project);
    await ensureWorkspaceGitRepository(repoPath);
    const existingOrigin = await getWorkspaceOriginUrl(repoPath);
    const replaceOrigin = input.args.replaceOrigin === true;
    if (existingOrigin && !replaceOrigin) {
      throw new Error("Origin remote already exists. Confirm replacing origin before publishing to OpenPond.");
    }

    const hasHead = await workspaceHasHead(repoPath);
    const status = await getWorkspaceGitStatus(repoPath);

    let initialCommit: Awaited<ReturnType<typeof commitWorkspaceChanges>> | null = null;
    const defaultCommitMessage = "Update sandbox template";
    const commitMessage =
      typeof input.args.commitMessage === "string" && input.args.commitMessage.trim()
        ? input.args.commitMessage.trim()
        : defaultCommitMessage;
    if (hasHead && status.dirty) {
      if (input.args.commitDirty !== true) {
        throw new Error("Commit project changes before publishing to OpenPond.");
      }
      initialCommit = await commitWorkspaceChanges(repoPath, commitMessage, { includeUnstaged: true });
    }
    if (!hasHead) {
      if (!status.dirty) throw new Error("Project has no files to publish.");
      initialCommit = await commitWorkspaceChanges(
        repoPath,
        typeof input.args.commitMessage === "string" && input.args.commitMessage.trim()
          ? input.args.commitMessage.trim()
          : "Initial sandbox template import",
        { includeUnstaged: true }
      );
    }

    const context = await loadOpenPondAccountContext();
    const name =
      typeof input.args.name === "string" && input.args.name.trim()
        ? input.args.name.trim()
        : project.name;
    const description =
      typeof input.args.description === "string" && input.args.description.trim()
        ? input.args.description.trim()
        : undefined;
    const response = await createOpenPondRepoApp({
      name,
      ...(description ? { description } : {}),
      repoInit: "empty",
    });
    const app = OpenPondAppSchema.parse({
      id: response.response.appId,
      name,
      description: description ?? null,
      visibility: "private",
      gitOwner: response.response.gitOwner ?? null,
      gitRepo: response.response.gitRepo ?? null,
      gitHost: response.response.gitHost ?? null,
      defaultBranch: response.response.defaultBranch ?? status.branch ?? "main",
      updatedAt: new Date().toISOString(),
      latestDeployment: null,
    });
    const remoteUrl = response.response.repoUrl?.trim() || expectedRemoteUrl(app, gitBaseUrlFromContext(context));
    if (!remoteUrl) throw new Error("OpenPond did not return a git remote for the new repo.");

    const remote = await setWorkspaceOrigin(repoPath, remoteUrl, { replaceExisting: replaceOrigin });
    const pushed = await pushWorkspaceBranch(repoPath, context.token);
    const scope = openPondCacheScope(context.accountState);
    await upsertScaffoldApp(scope, app);
    const linkedProject = await linkLocalProjectOpenPondApp(project.id, app, { repoPath });
    const updatedSession = await updateSession(session.id, {
      appId: app.id,
      appName: app.name,
      workspaceKind: "local_project",
      workspaceId: linkedProject.id,
      workspaceName: linkedProject.name,
      cwd: repoPath,
      title: session.title === "New chat" ? linkedProject.name : session.title,
    });

    return {
      session: updatedSession,
      result: WorkspaceToolResultSchema.parse({
        ok: true,
        action: input.action,
        appId: app.id,
        output: `Uploaded sandbox template ${project.name} to OpenPond and pushed ${pushed.branch}.`,
        data: {
          app,
          project: linkedProject,
          remote,
          pushed,
          initialCommit,
        },
      }),
    };
  }

  return null;
}

type FreshSandboxTemplate = {
  rootPath: string;
  manifestPath: string;
  valid: boolean;
  manifest: SandboxTemplateManifest | null;
  diagnostics: Array<{ path: string; message: string; code: string }>;
};

async function readSandboxTemplateFromDisk(project: LocalProject): Promise<FreshSandboxTemplate> {
  const template = project.sandboxTemplate;
  if (!template?.detected) throw new Error("This project does not contain openpond.yaml.");
  const validation = validateSandboxTemplateYaml(await fs.readFile(template.manifestPath, "utf8"));
  return {
    rootPath: template.rootPath,
    manifestPath: template.manifestPath,
    valid: validation.ok,
    manifest: validation.ok ? validation.manifest : null,
    diagnostics: validation.diagnostics,
  };
}

function validSandboxTemplateManifest(template: FreshSandboxTemplate): SandboxTemplateManifest {
  if (!template.valid || !template.manifest) {
    const diagnostics = template.diagnostics ?? [];
    const detail = diagnostics.length
      ? diagnostics.map((diagnostic) => `${diagnostic.path}: ${diagnostic.message}`).join("\n")
      : "openpond.yaml is invalid.";
    throw new Error(`Validate openpond.yaml before running this action.\n${detail}`);
  }
  return template.manifest;
}

function resolveSandboxTemplateRunTarget(
  manifest: SandboxTemplateManifest,
  target: string,
): SandboxTemplateExecutable {
  const executables = sandboxTemplateExecutableEntries(manifest);
  const match = executables.find((candidate) => candidate.name === target);
  if (!match) {
    throw new Error(
      `Sandbox template target not found: ${target}. Available: ${executables
        .map((candidate) => `${candidate.kind}:${candidate.name}`)
        .join(", ")}`,
    );
  }
  return match;
}

type LocalSandboxTemplateCommandResult = {
  command: string;
  cwd: string;
  status: "succeeded" | "failed" | "timed_out";
  output: string;
  exitCode: number | null;
};

type LocalSandboxTemplateUpload = {
  path: string;
  contentsBase64: string;
};

type SandboxTemplateRunMode = "local" | "sandbox";

type LinkedSandboxRecord = {
  id: string;
  state: string;
  repo: string | null;
  metadata: Record<string, unknown>;
  createdAt: string | null;
  updatedAt: string | null;
};

type HostedSandboxTemplateCommandResult = {
  processId?: string;
  command: string;
  status: "queued" | "running" | "succeeded" | "failed" | "skipped" | "timed_out" | "stopped";
  output: string;
  exitCode: number | null;
};

type SandboxTemplateSource = {
  branch: string;
  commitSha: string;
  remoteUrl: string;
};

const HOSTED_SANDBOX_DIRECT_UPLOAD_BASE64_LIMIT = 6 * 1024 * 1024;
const HOSTED_SANDBOX_UPLOAD_CHUNK_BASE64_SIZE = 4 * 1024 * 1024;
const HOSTED_SANDBOX_COMMAND_MAX_LENGTH = 1000;
const HOSTED_SANDBOX_DIRECT_EXEC_TIMEOUT_SECONDS_MAX = 20;
const HOSTED_SANDBOX_PROCESS_POLL_MS = 3_000;
const HOSTED_SANDBOX_RUNNER_RETRY_ATTEMPTS = 8;
const HOSTED_SANDBOX_RUNNER_READY_TIMEOUT_MS = 120_000;
const HOSTED_SANDBOX_PROCESS_IDLE_PROGRESS_MS = 15_000;
const SANDBOX_TEMPLATE_PROGRESS_OUTPUT_CHARS = 4_000;

function localSandboxTemplateUploadsArg(value: unknown): LocalSandboxTemplateUpload[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) return [];
    const record = item as Record<string, unknown>;
    const uploadPath = typeof record.path === "string" ? record.path.trim() : "";
    const contentsBase64 = typeof record.contentsBase64 === "string" ? record.contentsBase64 : "";
    return uploadPath && contentsBase64 ? [{ path: uploadPath, contentsBase64 }] : [];
  });
}

function sandboxTemplateEnvArg(value: unknown): SandboxEnvVarInput[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) {
    throw new Error("Sandbox template env must be an array.");
  }
  return value.map((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      throw new Error("Sandbox template env entries must be objects.");
    }
    const record = item as Record<string, unknown>;
    if ("value" in record) {
      throw new Error("Sandbox template env entries must use secretRef, not inline values.");
    }
    const name = typeof record.name === "string" ? record.name.trim() : "";
    const secretRef = typeof record.secretRef === "string" ? record.secretRef.trim() : "";
    if (!name || !secretRef) {
      throw new Error("Sandbox template env entries require name and secretRef.");
    }
    return { name, secretRef };
  });
}

function sandboxTemplateRunModeArg(value: unknown): SandboxTemplateRunMode {
  if (value === "sandbox") return "sandbox";
  return "local";
}

async function runSandboxTemplateExecutableInLinkedSandbox(input: {
  project: LocalProject;
  manifest: SandboxTemplateManifest;
  executable: SandboxTemplateExecutable;
  params: Record<string, unknown>;
  env: SandboxEnvVarInput[];
  uploads: LocalSandboxTemplateUpload[];
  sandboxId?: string;
  reportProgress?: WorkspaceActionProgressReporter;
}): Promise<{
  sandbox: LinkedSandboxRecord;
  sandboxCreated: boolean;
  source: SandboxTemplateSource;
  setupCommands: HostedSandboxTemplateCommandResult[];
  execution: HostedSandboxTemplateCommandResult;
  uploadedFiles: Array<{ path: string; sizeBytes: number }>;
  artifacts: Array<{ path: string; exists: boolean; sizeBytes: number | null }>;
}> {
  await reportSandboxTemplateProgress(input.reportProgress, `Preparing sandbox source for ${input.manifest.name}.`, {
    phase: "source",
  });
  const source = await resolveSandboxTemplateSource(input.project);
  await reportSandboxTemplateProgress(
    input.reportProgress,
    `Using ${source.branch}@${shortCommitSha(source.commitSha)} from ${source.remoteUrl}.`,
    { phase: "source", branch: source.branch, commitSha: source.commitSha, remoteUrl: source.remoteUrl },
  );
  const sandboxMatch = await findOrCreateLinkedSandboxForTemplate({
    project: input.project,
    manifest: input.manifest,
    source,
    env: input.env,
    sandboxId: input.sandboxId,
    reportProgress: input.reportProgress,
  });
  const sandbox = sandboxMatch.sandbox;
  await reportSandboxTemplateProgress(
    input.reportProgress,
    `${sandboxMatch.created ? "Started" : "Using"} sandbox ${sandbox.id}; waiting for the runner.`,
    { phase: "runner", sandboxId: sandbox.id, sandboxCreated: sandboxMatch.created },
  );
  await waitForSandboxRunnerReady(sandbox.id, HOSTED_SANDBOX_RUNNER_READY_TIMEOUT_MS, input.reportProgress);
  await reportSandboxTemplateProgress(input.reportProgress, `Sandbox runner is ready on ${sandbox.id}.`, {
    phase: "runner",
    sandboxId: sandbox.id,
  });
  const setupCommands: HostedSandboxTemplateCommandResult[] = [];
  for (const command of input.manifest.setup.commands) {
    await reportSandboxTemplateProgress(input.reportProgress, `Running setup: ${command}`, {
      phase: "setup",
      sandboxId: sandbox.id,
      command,
    });
    const result = await execSandboxCommand(sandbox.id, command, 900, {
      reportProgress: input.reportProgress,
      phase: "setup",
      target: "setup",
    });
    setupCommands.push(result);
    if (result.status !== "succeeded") {
      await reportSandboxTemplateProgress(
        input.reportProgress,
        formatSandboxCommandProgress(`Setup failed: ${command}`, result),
        { phase: "setup", sandboxId: sandbox.id, command, status: result.status },
      );
      throw new Error(`Sandbox setup command failed on ${sandbox.id}: ${command}\n${result.output}`);
    }
    await reportSandboxTemplateProgress(
      input.reportProgress,
      formatSandboxCommandProgress(`Setup completed: ${command}`, result),
      { phase: "setup", sandboxId: sandbox.id, command, status: result.status },
    );
  }
  const uploadedFiles = await uploadFilesToSandbox(sandbox.id, input.uploads, input.reportProgress);
  await uploadSandboxTemplateReplayParams(sandbox.id, input.params, input.reportProgress);
  const runCommand = hostedSandboxTemplateCommand(input.executable);
  await reportSandboxTemplateProgress(input.reportProgress, `Running ${input.executable.kind} ${input.executable.name}.`, {
    phase: "execute",
    sandboxId: sandbox.id,
    target: input.executable.name,
    command: runCommand,
  });
  const execution = await execSandboxCommand(
    sandbox.id,
    runCommand,
    input.executable.timeoutSeconds ?? 900,
    {
      reportProgress: input.reportProgress,
      phase: "execute",
      target: input.executable.name,
    },
  );
  await reportSandboxTemplateProgress(
    input.reportProgress,
    formatSandboxCommandProgress(
      execution.status === "succeeded"
        ? `${input.executable.name} completed.`
        : `${input.executable.name} ${execution.status}.`,
      execution,
    ),
    {
      phase: "execute",
      sandboxId: sandbox.id,
      target: input.executable.name,
      status: execution.status,
      exitCode: execution.exitCode,
    },
  );
  await reportSandboxTemplateProgress(input.reportProgress, "Checking artifact paths.", {
    phase: "artifacts",
    sandboxId: sandbox.id,
    artifacts: input.executable.artifactPaths,
  });
  return {
    sandbox,
    sandboxCreated: sandboxMatch.created,
    source,
    setupCommands,
    execution,
    uploadedFiles,
    artifacts: await collectHostedSandboxTemplateArtifacts(sandbox.id, input.executable.artifactPaths),
  };
}

async function resolveSandboxTemplateSource(project: LocalProject): Promise<SandboxTemplateSource> {
  const repoPath = localProjectSandboxTemplateRootPath(project);
  const source = await getWorkspaceDeploymentSource(repoPath);
  return {
    branch: source.branch,
    commitSha: source.commitSha,
    remoteUrl: source.remoteUrl,
  };
}

async function findOrCreateLinkedSandboxForTemplate(input: {
  project: LocalProject;
  manifest: SandboxTemplateManifest;
  source: SandboxTemplateSource;
  env: SandboxEnvVarInput[];
  sandboxId?: string;
  reportProgress?: WorkspaceActionProgressReporter;
}): Promise<{ sandbox: LinkedSandboxRecord; created: boolean }> {
  const explicitSandboxId = input.sandboxId?.trim();
  if (explicitSandboxId) {
    await reportSandboxTemplateProgress(input.reportProgress, `Loading sandbox ${explicitSandboxId}.`, {
      phase: "sandbox",
      sandboxId: explicitSandboxId,
    });
    const sandbox = sandboxRecordFromPayload(await sandboxRequestPayload({ type: "get", sandboxId: explicitSandboxId }));
    if (!sandbox) throw new Error(`Sandbox not found: ${explicitSandboxId}`);
    if (sandbox.state !== "running") {
      throw new Error(`Sandbox ${sandbox.id} is ${sandbox.state}; start it before running template actions.`);
    }
    await reportSandboxTemplateProgress(input.reportProgress, `Using selected sandbox ${sandbox.id}.`, {
      phase: "sandbox",
      sandboxId: sandbox.id,
    });
    return { sandbox, created: false };
  }

  if (input.env.length > 0) {
    const created = await createLinkedSandboxForTemplate(input.project, input.manifest, input.source, input.env, input.reportProgress);
    return { sandbox: created, created: true };
  }

  await reportSandboxTemplateProgress(input.reportProgress, `Looking for a running sandbox for ${input.project.name}.`, {
    phase: "sandbox",
    projectId: input.project.id,
  });
  const payload = await sandboxRequestPayload({ type: "list", payload: {} });
  const matches = sandboxRecordsFromPayload(payload)
    .filter((sandbox) => sandbox.state === "running")
    .filter((sandbox) => sandboxMatchesTemplateProject(sandbox, input.project, input.manifest))
    .sort(compareLinkedSandboxesByFreshness);
  const match = matches.find((sandbox) => sandboxMatchesTemplateSource(sandbox, input.source));
  if (match) {
    await reportSandboxTemplateProgress(input.reportProgress, `Reusing sandbox ${match.id} for this commit.`, {
      phase: "sandbox",
      sandboxId: match.id,
      commitSha: input.source.commitSha,
    });
    return { sandbox: match, created: false };
  }

  const created = await createLinkedSandboxForTemplate(input.project, input.manifest, input.source, [], input.reportProgress);
  return { sandbox: created, created: true };
}

async function createLinkedSandboxForTemplate(
  project: LocalProject,
  manifest: SandboxTemplateManifest,
  source: SandboxTemplateSource,
  env: SandboxEnvVarInput[],
  reportProgress?: WorkspaceActionProgressReporter,
): Promise<LinkedSandboxRecord> {
  let payload: unknown;
  try {
    await reportSandboxTemplateProgress(
      reportProgress,
      `Creating sandbox for ${project.name} at ${source.branch}@${shortCommitSha(source.commitSha)}.`,
      { phase: "sandbox", projectId: project.id, branch: source.branch, commitSha: source.commitSha },
    );
    const runtimePayload = await sandboxRequestPayload({
      type: "sandbox_runtime_create",
      payload: {
        mode: "template_build",
        baseBranch: source.branch || "master",
        baseSha: source.commitSha,
        promotionPolicy: "none",
        metadata: sandboxTemplateMetadata(project, manifest, source),
      },
    });
    const runtimeId = runtimeIdFromPayload(runtimePayload);
    if (!runtimeId) {
      throw new Error(`Created sandbox runtime for ${project.name}, but the response did not include a runtime id.`);
    }
    const sandboxPayload = await sandboxRequestPayload({
      type: "sandbox_runtime_sandbox_create",
      runtimeId,
      payload: {
        repo: source.remoteUrl,
        visibility: "team",
        resources: manifest.resources ?? {},
        budget: { maxUsd: "0.05" },
        quotas: { maxSpendUsd: "0.05" },
        ...(env.length > 0 ? { env } : {}),
        volumes: manifest.volumes,
        metadata: sandboxTemplateMetadata(project, manifest, source),
      },
    });
    payload = mergeSandboxRuntimeSandboxPayload(runtimePayload, sandboxPayload);
  } catch (error) {
    if (!isSandboxCreateGatewayTimeout(error)) throw error;
    await reportSandboxTemplateProgress(
      reportProgress,
      "Sandbox create request timed out; waiting for the sandbox to appear.",
      { phase: "sandbox", projectId: project.id, commitSha: source.commitSha },
    );
    const recovered = await waitForLinkedSandboxForTemplate(project, manifest, source, 180_000, reportProgress);
    if (recovered) return recovered;
    throw new Error(
      `Sandbox create timed out and no running sandbox appeared for ${project.name}. Check sandbox status before retrying.`,
    );
  }
  const sandbox = sandboxRecordFromPayload(payload);
  if (!sandbox) {
    throw new Error(`Created sandbox for ${project.name}, but the response did not include a sandbox id.`);
  }
  if (sandbox.state === "running") return sandbox;
  const running = await waitForSandboxRunning(sandbox.id, 180_000, reportProgress);
  if (running) return running;
  throw new Error(`Sandbox ${sandbox.id} did not reach running state after create. Current state: ${sandbox.state}.`);
}

function sandboxTemplateMetadata(
  project: LocalProject,
  manifest: SandboxTemplateManifest,
  source: SandboxTemplateSource,
): Record<string, unknown> {
  return {
    source: "openpond-app-local-sandbox-template-start",
    projectId: project.id,
    projectName: project.name,
    templateName: manifest.name,
    templateVersion: manifest.version,
    templateUseCase: manifest.useCase,
    repoUrl: source.remoteUrl,
    branch: source.branch,
    commitSha: source.commitSha,
    templateTargets: sandboxTemplateExecutableEntries(manifest).map((target) => ({
      name: target.name,
      kind: target.kind,
    })),
  };
}

function sandboxMatchesTemplateProject(
  sandbox: LinkedSandboxRecord,
  project: LocalProject,
  manifest: SandboxTemplateManifest,
): boolean {
  const metadata = sandbox.metadata;
  if (metadata.source !== "openpond-app-local-sandbox-template-start") return false;
  if (metadata.projectId === project.id) return true;
  return metadata.projectName === project.name && metadata.templateName === manifest.name;
}

function sandboxMatchesTemplateSource(
  sandbox: LinkedSandboxRecord,
  source: SandboxTemplateSource,
): boolean {
  return sandbox.metadata.commitSha === source.commitSha;
}

async function waitForLinkedSandboxForTemplate(
  project: LocalProject,
  manifest: SandboxTemplateManifest,
  source: SandboxTemplateSource,
  timeoutMs: number,
  reportProgress?: WorkspaceActionProgressReporter,
): Promise<LinkedSandboxRecord | null> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const payload = await sandboxRequestPayload({ type: "list", payload: {} });
    const match = sandboxRecordsFromPayload(payload)
      .filter((sandbox) => sandbox.state === "running")
      .filter((sandbox) => sandboxMatchesTemplateProject(sandbox, project, manifest))
      .find((sandbox) => sandboxMatchesTemplateSource(sandbox, source));
    if (match) {
      await reportSandboxTemplateProgress(reportProgress, `Found sandbox ${match.id}.`, {
        phase: "sandbox",
        sandboxId: match.id,
        commitSha: source.commitSha,
      });
      return match;
    }
    await reportSandboxTemplateProgress(reportProgress, `Waiting for sandbox for ${project.name}.`, {
      phase: "sandbox",
      projectId: project.id,
      commitSha: source.commitSha,
    });
    await sleep(4_000);
  }
  return null;
}

async function waitForSandboxRunning(
  sandboxId: string,
  timeoutMs: number,
  reportProgress?: WorkspaceActionProgressReporter,
): Promise<LinkedSandboxRecord | null> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const sandbox = sandboxRecordFromPayload(await sandboxRequestPayload({ type: "get", sandboxId }));
    if (sandbox?.state === "running") return sandbox;
    await reportSandboxTemplateProgress(
      reportProgress,
      `Sandbox ${sandboxId} is ${sandbox?.state ?? "not ready"}; waiting for running.`,
      { phase: "sandbox", sandboxId, state: sandbox?.state ?? null },
    );
    await sleep(4_000);
  }
  return null;
}

function isSandboxCreateGatewayTimeout(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return message.includes("504") || /endpoint request timed out/i.test(message);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function reportSandboxTemplateProgress(
  reportProgress: WorkspaceActionProgressReporter | undefined,
  output: string,
  data?: Record<string, unknown>,
): Promise<void> {
  if (!reportProgress) return;
  await reportProgress({
    action: "run_sandbox_template",
    status: "pending",
    output,
    data,
  });
}

function shortCommitSha(value: string): string {
  return value.length > 12 ? value.slice(0, 12) : value;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const kib = bytes / 1024;
  if (kib < 1024) return `${kib.toFixed(kib >= 10 ? 0 : 1)} KiB`;
  const mib = kib / 1024;
  if (mib < 1024) return `${mib.toFixed(mib >= 10 ? 0 : 1)} MiB`;
  return `${(mib / 1024).toFixed(1)} GiB`;
}

function formatSandboxCommandProgress(prefix: string, result: HostedSandboxTemplateCommandResult): string {
  const lines = [`${prefix} (${result.status}${typeof result.exitCode === "number" ? `, exit ${result.exitCode}` : ""}).`];
  const output = trimSandboxProgressOutput(result.output);
  if (output) lines.push(output);
  return lines.join("\n");
}

function formatLocalCommandProgress(prefix: string, result: LocalSandboxTemplateCommandResult): string {
  const lines = [`${prefix} (${result.status}${typeof result.exitCode === "number" ? `, exit ${result.exitCode}` : ""}).`];
  const output = trimSandboxProgressOutput(result.output);
  if (output) lines.push(output);
  return lines.join("\n");
}

function trimSandboxProgressOutput(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length <= SANDBOX_TEMPLATE_PROGRESS_OUTPUT_CHARS) return trimmed;
  return `[last ${SANDBOX_TEMPLATE_PROGRESS_OUTPUT_CHARS} chars]\n${trimmed.slice(-SANDBOX_TEMPLATE_PROGRESS_OUTPUT_CHARS)}`;
}

async function sandboxRequestPayloadWithRunnerRetry(action: SandboxRequestAction): Promise<unknown> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= HOSTED_SANDBOX_RUNNER_RETRY_ATTEMPTS; attempt += 1) {
    try {
      return await sandboxRequestPayload(action);
    } catch (error) {
      lastError = error;
      if (!isSandboxRunnerMaterializationRace(error) || attempt === HOSTED_SANDBOX_RUNNER_RETRY_ATTEMPTS) {
        throw error;
      }
      await sleep(Math.min(10_000, attempt * 2_000));
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

async function waitForSandboxRunnerReady(
  sandboxId: string,
  timeoutMs: number,
  reportProgress?: WorkspaceActionProgressReporter,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      await sandboxRequestPayloadWithRunnerRetry({
        type: "stat_file",
        sandboxId,
        payload: { path: "openpond.yaml" },
      });
      return;
    } catch (error) {
      lastError = error;
      if (!isSandboxRunnerMaterializationRace(error)) throw error;
      await reportSandboxTemplateProgress(reportProgress, `Sandbox runner ${sandboxId} is still materializing.`, {
        phase: "runner",
        sandboxId,
      });
      await sleep(3_000);
    }
  }
  throw lastError instanceof Error
    ? lastError
    : new Error(`Sandbox runner did not become ready for ${sandboxId}.`);
}

function isSandboxRunnerMaterializationRace(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /502\b/.test(message) && /sandbox_runner_failed:sandbox_not_found/.test(message);
}

function compareLinkedSandboxesByFreshness(a: LinkedSandboxRecord, b: LinkedSandboxRecord): number {
  return timestampMs(b.updatedAt ?? b.createdAt) - timestampMs(a.updatedAt ?? a.createdAt);
}

function timestampMs(value: string | null): number {
  if (!value) return 0;
  const time = Date.parse(value);
  return Number.isFinite(time) ? time : 0;
}

async function uploadFilesToSandbox(
  sandboxId: string,
  uploads: LocalSandboxTemplateUpload[],
  reportProgress?: WorkspaceActionProgressReporter,
): Promise<Array<{ path: string; sizeBytes: number }>> {
  const uploaded: Array<{ path: string; sizeBytes: number }> = [];
  if (uploads.length === 0) {
    await reportSandboxTemplateProgress(reportProgress, "No input files to upload.", {
      phase: "upload",
      sandboxId,
    });
    return uploaded;
  }
  for (const upload of uploads) {
    const uploadPath = normalizeLocalWorkspacePath(upload.path);
    const sizeBytes = Buffer.byteLength(upload.contentsBase64, "base64");
    await reportSandboxTemplateProgress(reportProgress, `Uploading ${uploadPath} (${formatBytes(sizeBytes)}).`, {
      phase: "upload",
      sandboxId,
      path: uploadPath,
      sizeBytes,
    });
    if (upload.contentsBase64.length <= HOSTED_SANDBOX_DIRECT_UPLOAD_BASE64_LIMIT) {
      await sandboxRequestPayloadWithRunnerRetry({
        type: "upload_file",
        sandboxId,
        payload: {
          path: uploadPath,
          contentsBase64: upload.contentsBase64,
        },
      });
    } else {
      await uploadLargeFileToSandbox(sandboxId, uploadPath, upload.contentsBase64, sizeBytes, reportProgress);
    }
    uploaded.push({
      path: uploadPath,
      sizeBytes,
    });
    await reportSandboxTemplateProgress(reportProgress, `Uploaded ${uploadPath} (${formatBytes(sizeBytes)}).`, {
      phase: "upload",
      sandboxId,
      path: uploadPath,
      sizeBytes,
    });
  }
  return uploaded;
}

async function uploadLargeFileToSandbox(
  sandboxId: string,
  uploadPath: string,
  contentsBase64: string,
  sizeBytes: number,
  reportProgress?: WorkspaceActionProgressReporter,
): Promise<void> {
  const uploadDir = path.posix.dirname(uploadPath);
  const uploadId = randomUUID();
  const chunkDir = `.openpond-upload/${uploadId}`;
  await reportSandboxTemplateProgress(
    reportProgress,
    `Splitting ${uploadPath} into chunks for upload (${formatBytes(sizeBytes)}).`,
    { phase: "upload", sandboxId, path: uploadPath, sizeBytes },
  );
  const initResult = await execSandboxCommand(
    sandboxId,
    `mkdir -p ${quoteShellArg(uploadDir)} ${quoteShellArg(chunkDir)}`,
    120,
    { reportProgress, phase: "upload", target: uploadPath },
  );
  assertSandboxUploadCommand(initResult, uploadPath);

  const chunkCount = Math.ceil(contentsBase64.length / HOSTED_SANDBOX_UPLOAD_CHUNK_BASE64_SIZE);
  const chunkWidth = Math.max(6, String(chunkCount - 1).length);
  for (
    let offset = 0, chunkIndex = 0;
    offset < contentsBase64.length;
    offset += HOSTED_SANDBOX_UPLOAD_CHUNK_BASE64_SIZE, chunkIndex += 1
  ) {
    const chunk = contentsBase64.slice(offset, offset + HOSTED_SANDBOX_UPLOAD_CHUNK_BASE64_SIZE);
    const chunkPath = `${chunkDir}/${String(chunkIndex).padStart(chunkWidth, "0")}.b64`;
    await uploadTextFileToSandbox(sandboxId, chunkPath, chunk);
    await reportSandboxTemplateProgress(
      reportProgress,
      `Uploaded chunk ${chunkIndex + 1}/${chunkCount} for ${uploadPath}.`,
      { phase: "upload", sandboxId, path: uploadPath, chunk: chunkIndex + 1, chunks: chunkCount },
    );
  }

  await reportSandboxTemplateProgress(reportProgress, `Reassembling ${uploadPath} inside sandbox ${sandboxId}.`, {
    phase: "upload",
    sandboxId,
    path: uploadPath,
  });
  const decodeResult = await execSandboxCommand(
    sandboxId,
    `cat ${quoteShellArg(chunkDir)}/*.b64 | base64 -d > ${quoteShellArg(uploadPath)} && rm -rf ${quoteShellArg(chunkDir)}`,
    120,
    { reportProgress, phase: "upload", target: uploadPath },
  );
  assertSandboxUploadCommand(decodeResult, uploadPath);
}

async function uploadTextFileToSandbox(
  sandboxId: string,
  filePath: string,
  contents: string,
): Promise<void> {
  await sandboxRequestPayloadWithRunnerRetry({
    type: "upload_file",
    sandboxId,
    payload: {
      path: filePath,
      contentsBase64: Buffer.from(contents, "utf8").toString("base64"),
    },
  });
}

function assertSandboxUploadCommand(
  result: HostedSandboxTemplateCommandResult,
  uploadPath: string,
): void {
  if (result.status === "succeeded") return;
  throw new Error(`Sandbox upload failed for ${uploadPath}:\n${result.output}`);
}

async function execSandboxCommand(
  sandboxId: string,
  command: string,
  timeoutSeconds: number,
  options: {
    reportProgress?: WorkspaceActionProgressReporter;
    phase?: string;
    target?: string;
  } = {},
): Promise<HostedSandboxTemplateCommandResult> {
  if (command.length > HOSTED_SANDBOX_COMMAND_MAX_LENGTH) {
    throw new Error(
      `Sandbox command is too long for the current exec API (${command.length}/${HOSTED_SANDBOX_COMMAND_MAX_LENGTH} characters).`,
    );
  }
  if (timeoutSeconds > HOSTED_SANDBOX_DIRECT_EXEC_TIMEOUT_SECONDS_MAX) {
    return runSandboxProcessToCompletion(sandboxId, command, timeoutSeconds, options);
  }
  const payload = await sandboxRequestPayloadWithRunnerRetry({
    type: "exec",
    sandboxId,
    payload: { command, timeoutSeconds },
  });
  const result = sandboxCommandFromPayload(payload);
  if (!result) throw new Error(`Sandbox command did not return command status for ${sandboxId}.`);
  return result;
}

async function runSandboxProcessToCompletion(
  sandboxId: string,
  command: string,
  timeoutSeconds: number,
  options: {
    reportProgress?: WorkspaceActionProgressReporter;
    phase?: string;
    target?: string;
  } = {},
): Promise<HostedSandboxTemplateCommandResult> {
  const startedPayload = await sandboxRequestPayloadWithRunnerRetry({
    type: "process_start",
    sandboxId,
    payload: { command, timeoutSeconds },
  });
  let process = sandboxProcessFromPayload(startedPayload);
  if (!process) throw new Error(`Sandbox process did not return process status for ${sandboxId}.`);
  await reportSandboxTemplateProgress(
    options.reportProgress,
    `Started sandbox process ${process.processId ?? ""} for ${options.target ?? "template target"}.`.trim(),
    {
      phase: options.phase ?? "process",
      sandboxId,
      target: options.target,
      processId: process.processId,
      status: process.status,
    },
  );
  const deadline = Date.now() + timeoutSeconds * 1000 + 30_000;
  let emittedOutputLength = 0;
  let lastIdleProgressAt = Date.now();
  while (process.status === "running" && Date.now() < deadline) {
    if (!process.processId) throw new Error(`Sandbox process did not return a process id for ${sandboxId}.`);
    await sleep(HOSTED_SANDBOX_PROCESS_POLL_MS);
    const payload = await sandboxRequestPayloadWithRunnerRetry({
      type: "process_get",
      sandboxId,
      processId: process.processId,
      payload: {},
    });
    process = sandboxProcessFromPayload(payload) ?? process;
    const output = process.output ?? "";
    if (output.length > emittedOutputLength) {
      const delta = output.slice(emittedOutputLength);
      emittedOutputLength = output.length;
      const progressOutput = trimSandboxProgressOutput(delta);
      if (progressOutput) {
        await reportSandboxTemplateProgress(options.reportProgress, progressOutput, {
          phase: "process_output",
          sandboxId,
          target: options.target,
          processId: process.processId,
          status: process.status,
        });
      }
      lastIdleProgressAt = Date.now();
    } else if (Date.now() - lastIdleProgressAt >= HOSTED_SANDBOX_PROCESS_IDLE_PROGRESS_MS) {
      await reportSandboxTemplateProgress(
        options.reportProgress,
        `Sandbox process ${process.processId} is still running.`,
        {
          phase: options.phase ?? "process",
          sandboxId,
          target: options.target,
          processId: process.processId,
          status: process.status,
        },
      );
      lastIdleProgressAt = Date.now();
    }
  }
  return process;
}

async function uploadSandboxTemplateReplayParams(
  sandboxId: string,
  params: Record<string, unknown>,
  reportProgress?: WorkspaceActionProgressReporter,
): Promise<void> {
  await reportSandboxTemplateProgress(reportProgress, "Uploading replay parameters.", {
    phase: "params",
    sandboxId,
  });
  await uploadTextFileToSandbox(
    sandboxId,
    "openpond-replay-params.json",
    `${JSON.stringify({ input: params }, null, 2)}\n`,
  );
  await reportSandboxTemplateProgress(reportProgress, "Uploaded replay parameters.", {
    phase: "params",
    sandboxId,
  });
}

async function collectHostedSandboxTemplateArtifacts(
  sandboxId: string,
  artifactPaths: string[],
): Promise<Array<{ path: string; exists: boolean; sizeBytes: number | null }>> {
  const artifacts: Array<{ path: string; exists: boolean; sizeBytes: number | null }> = [];
  for (const artifactPath of artifactPaths) {
    try {
      const payload = await sandboxRequestPayloadWithRunnerRetry({
        type: "stat_file",
        sandboxId,
        payload: { path: artifactPath },
      });
      const file = asRecord(asRecord(payload).file);
      const sizeBytes = typeof file.sizeBytes === "number" ? file.sizeBytes : null;
      artifacts.push({ path: artifactPath, exists: true, sizeBytes });
    } catch {
      artifacts.push({ path: artifactPath, exists: false, sizeBytes: null });
    }
  }
  return artifacts;
}

function hostedSandboxTemplateCommand(executable: SandboxTemplateExecutable): string {
  const paramsPath = quoteShellArg("openpond-replay-params.json");
  const envCommand = [
    `OPENPOND_REPLAY_PARAMS_BASE64="$(base64 -w0 ${paramsPath} 2>/dev/null || base64 ${paramsPath} | tr -d '\\n')"`,
    "export OPENPOND_REPLAY_PARAMS_BASE64",
  ].join(" && ");
  const cwd = executable.cwd?.trim();
  return cwd
    ? `${envCommand} && cd ${quoteShellArg(cwd)} && ${executable.command}`
    : `${envCommand} && ${executable.command}`;
}

async function runSandboxTemplateExecutableLocally(input: {
  rootPath: string;
  manifest: SandboxTemplateManifest;
  executable: SandboxTemplateExecutable;
  params: Record<string, unknown>;
  uploads?: LocalSandboxTemplateUpload[];
  reportProgress?: WorkspaceActionProgressReporter;
}): Promise<{
  setupCommands: LocalSandboxTemplateCommandResult[];
  execution: LocalSandboxTemplateCommandResult;
  replayParamsPath: string;
  uploadedFiles: Array<{ path: string; sizeBytes: number }>;
  artifacts: Array<{ path: string; exists: boolean; sizeBytes: number | null }>;
}> {
  await reportSandboxTemplateProgress(input.reportProgress, `Preparing local run for ${input.manifest.name}.`, {
    phase: "local",
  });
  await prepareLocalSandboxTemplateVolumes(input.rootPath, input.manifest);
  const setupCommands: LocalSandboxTemplateCommandResult[] = [];
  for (const command of input.manifest.setup.commands) {
    await reportSandboxTemplateProgress(input.reportProgress, `Running local setup: ${command}`, {
      phase: "local_setup",
      command,
    });
    const result = await runLocalShellCommand(command, input.rootPath, { timeoutSeconds: 900 });
    setupCommands.push(result);
    if (result.status !== "succeeded") {
      await reportSandboxTemplateProgress(
        input.reportProgress,
        formatLocalCommandProgress(`Local setup failed: ${command}`, result),
        { phase: "local_setup", command, status: result.status },
      );
      throw new Error(`Local setup command failed: ${command}\n${result.output}`);
    }
    await reportSandboxTemplateProgress(
      input.reportProgress,
      formatLocalCommandProgress(`Local setup completed: ${command}`, result),
      { phase: "local_setup", command, status: result.status },
    );
  }
  const uploadedFiles = await writeLocalSandboxTemplateUploads(input.rootPath, input.uploads ?? []);
  await reportSandboxTemplateProgress(
    input.reportProgress,
    uploadedFiles.length
      ? `Prepared ${uploadedFiles.length} local input file${uploadedFiles.length === 1 ? "" : "s"}.`
      : "No local input files to prepare.",
    { phase: "local_upload", files: uploadedFiles },
  );
  const replayParamsPath = path.join(input.rootPath, "openpond-replay-params.json");
  const replayJson = `${JSON.stringify({ input: input.params }, null, 2)}\n`;
  await fs.writeFile(replayParamsPath, replayJson, "utf8");
  await reportSandboxTemplateProgress(input.reportProgress, `Wrote replay parameters to ${path.relative(input.rootPath, replayParamsPath)}.`, {
    phase: "local_params",
    path: replayParamsPath,
  });
  await reportSandboxTemplateProgress(input.reportProgress, `Running local ${input.executable.kind} ${input.executable.name}.`, {
    phase: "local_execute",
    target: input.executable.name,
    command: input.executable.command,
  });
  const execution = await runLocalShellCommand(
    input.executable.command,
    input.executable.cwd ? path.resolve(input.rootPath, input.executable.cwd) : input.rootPath,
    {
      timeoutSeconds: input.executable.timeoutSeconds ?? 900,
      env: {
        OPENPOND_REPLAY_PARAMS_BASE64: Buffer.from(replayJson, "utf8").toString("base64"),
      },
    },
  );
  await reportSandboxTemplateProgress(
    input.reportProgress,
    formatLocalCommandProgress(
      execution.status === "succeeded"
        ? `${input.executable.name} completed locally.`
        : `${input.executable.name} ${execution.status} locally.`,
      execution,
    ),
    {
      phase: "local_execute",
      target: input.executable.name,
      status: execution.status,
      exitCode: execution.exitCode,
    },
  );
  return {
    setupCommands,
    execution,
    replayParamsPath,
    uploadedFiles,
    artifacts: await collectLocalSandboxTemplateArtifacts(input.rootPath, input.executable.artifactPaths),
  };
}

async function writeLocalSandboxTemplateUploads(
  rootPath: string,
  uploads: LocalSandboxTemplateUpload[],
): Promise<Array<{ path: string; sizeBytes: number }>> {
  const written: Array<{ path: string; sizeBytes: number }> = [];
  for (const upload of uploads) {
    const relativePath = normalizeLocalWorkspacePath(upload.path);
    const targetPath = path.resolve(rootPath, relativePath);
    await fs.mkdir(path.dirname(targetPath), { recursive: true });
    const contents = Buffer.from(upload.contentsBase64, "base64");
    await fs.writeFile(targetPath, contents);
    written.push({ path: relativePath, sizeBytes: contents.length });
  }
  return written;
}

async function prepareLocalSandboxTemplateVolumes(
  rootPath: string,
  manifest: SandboxTemplateManifest,
): Promise<void> {
  for (const volume of manifest.volumes) {
    const mountPath =
      typeof volume.mountPath === "string" && volume.mountPath.trim()
        ? volume.mountPath.trim()
        : volume.name
          ? `/workspace/volumes/${volume.name}`
          : "";
    if (!mountPath) continue;
    await fs.mkdir(path.resolve(rootPath, normalizeLocalWorkspacePath(mountPath)), { recursive: true });
  }
}

async function collectLocalSandboxTemplateArtifacts(
  rootPath: string,
  artifactPaths: string[],
): Promise<Array<{ path: string; exists: boolean; sizeBytes: number | null }>> {
  const artifacts: Array<{ path: string; exists: boolean; sizeBytes: number | null }> = [];
  for (const artifactPath of artifactPaths) {
    const localPath = path.resolve(rootPath, normalizeLocalWorkspacePath(artifactPath));
    try {
      const stat = await fs.stat(localPath);
      artifacts.push({ path: artifactPath, exists: stat.isFile(), sizeBytes: stat.size });
    } catch {
      artifacts.push({ path: artifactPath, exists: false, sizeBytes: null });
    }
  }
  return artifacts;
}

function normalizeLocalWorkspacePath(value: string): string {
  const normalized = value
    .trim()
    .replace(/\\/g, "/")
    .replace(/^\/workspace\//, "")
    .replace(/^workspace\//, "")
    .replace(/^\.\//, "")
    .replace(/^\/+/, "");
  if (!normalized || normalized.split("/").some((segment) => segment === ".." || segment === "")) {
    throw new Error(`Invalid workspace path: ${value}`);
  }
  return normalized;
}

async function runLocalShellCommand(
  command: string,
  cwd: string,
  options: { timeoutSeconds?: number; env?: Record<string, string> } = {},
): Promise<LocalSandboxTemplateCommandResult> {
  return new Promise((resolve) => {
    const child = spawn(command, {
      cwd,
      env: {
        ...process.env,
        ...(options.env ?? {}),
      },
      shell: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let timedOut = false;
    const timer = options.timeoutSeconds
      ? setTimeout(() => {
          timedOut = true;
          child.kill("SIGTERM");
        }, options.timeoutSeconds * 1000)
      : null;
    child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
    child.on("error", (error) => {
      if (timer) clearTimeout(timer);
      resolve({
        command,
        cwd,
        status: "failed",
        output: error.message,
        exitCode: 1,
      });
    });
    child.on("close", (code) => {
      if (timer) clearTimeout(timer);
      const output = trimOutput(`${Buffer.concat(stdout).toString("utf8")}${Buffer.concat(stderr).toString("utf8")}`);
      resolve({
        command,
        cwd,
        status: timedOut ? "timed_out" : code === 0 ? "succeeded" : "failed",
        output,
        exitCode: code,
      });
    });
  });
}

function sandboxRecordsFromPayload(payload: unknown): LinkedSandboxRecord[] {
  const sandboxes = asRecord(payload).sandboxes;
  if (!Array.isArray(sandboxes)) return [];
  return sandboxes.flatMap((sandbox) => {
    const record = linkedSandboxRecord(sandbox);
    return record ? [record] : [];
  });
}

function sandboxRecordFromPayload(payload: unknown): LinkedSandboxRecord | null {
  return linkedSandboxRecord(asRecord(payload).sandbox);
}

function runtimeIdFromPayload(payload: unknown): string {
  const runtime = asRecord(asRecord(payload).runtime);
  return typeof runtime.id === "string" ? runtime.id : "";
}

function mergeSandboxRuntimeSandboxPayload(
  runtimePayload: unknown,
  sandboxPayload: unknown,
): Record<string, unknown> {
  const runtimeRecord = asRecord(runtimePayload);
  const sandboxRecord = asRecord(sandboxPayload);
  return {
    ...runtimeRecord,
    ...sandboxRecord,
    runtime: sandboxRecord.runtime ?? runtimeRecord.runtime,
    account: sandboxRecord.account ?? runtimeRecord.account,
  };
}

function linkedSandboxRecord(value: unknown): LinkedSandboxRecord | null {
  const record = asRecord(value);
  const id = typeof record.id === "string" ? record.id.trim() : "";
  const state = typeof record.state === "string" ? record.state.trim() : "";
  if (!id || !state) return null;
  return {
    id,
    state,
    repo: typeof record.repo === "string" ? record.repo : null,
    metadata: asRecord(record.metadata),
    createdAt: typeof record.createdAt === "string" ? record.createdAt : null,
    updatedAt: typeof record.updatedAt === "string" ? record.updatedAt : null,
  };
}

function sandboxCommandFromPayload(payload: unknown): HostedSandboxTemplateCommandResult | null {
  const command = asRecord(asRecord(payload).command);
  const commandText = typeof command.command === "string" ? command.command : "";
  const status = hostedCommandStatus(command.status);
  if (!status) return null;
  return {
    command: commandText,
    status,
    output: typeof command.output === "string" ? command.output : "",
    exitCode: typeof command.exitCode === "number" ? command.exitCode : null,
  };
}

function sandboxProcessFromPayload(payload: unknown): HostedSandboxTemplateCommandResult | null {
  const process = asRecord(asRecord(payload).process);
  const processId = typeof process.id === "string" ? process.id.trim() : "";
  const commandText = typeof process.command === "string" ? process.command : "";
  const status = hostedCommandStatus(process.status);
  if (!processId || !status) return null;
  return {
    processId,
    command: commandText,
    status,
    output: typeof process.output === "string" ? process.output : "",
    exitCode: typeof process.exitCode === "number" ? process.exitCode : null,
  };
}

function hostedCommandStatus(value: unknown): HostedSandboxTemplateCommandResult["status"] | null {
  return value === "queued" ||
    value === "running" ||
    value === "succeeded" ||
    value === "failed" ||
    value === "skipped" ||
    value === "timed_out" ||
    value === "stopped"
    ? value
    : null;
}

function quoteShellArg(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}
