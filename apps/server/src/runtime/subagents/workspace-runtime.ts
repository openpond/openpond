import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  SubagentRunSchema,
  type RuntimeEvent,
  type SendTurnRequest,
  type Session,
  type SubagentRoleSettings,
  type SubagentRun,
} from "@openpond/contracts";
import { resolveWorkspaceExecutionTarget } from "../../workspace/workspace-execution-target.js";
import { runWorkspaceCommand, truncatePatch } from "../../workspace/workspaces.js";
import { now, textFromUnknown } from "../../utils.js";
import type { TurnRunnerDependencies } from "../turns/ports.js";
import {
  recordFromUnknown,
  stringFromRecord,
  uniqueNonEmptyStrings,
} from "../turns/value-utils.js";
import {
  subagentCleanupOutput,
  subagentCleanupRetainReason,
  subagentRetainedWorkspaceState,
  subagentWorkspaceCleanupAlreadyDone,
  subagentWorkspaceRetentionTriggerForCleanupPolicy,
  type SubagentCleanupPolicy,
} from "./workspace-state.js";

type AppendSubagentReceipt = (input: {
  parentSession: Session;
  parentTurnId?: string | null;
  run: SubagentRun;
  childSession?: Session | null;
  eventName: Extract<RuntimeEvent["name"], `subagent.${string}`>;
  status: RuntimeEvent["status"];
  output: string;
}) => Promise<void>;

export function createSubagentWorkspaceRuntime(deps: {
  attachmentRootDir: string;
  resolveSessionWorkspaceCwd: TurnRunnerDependencies["resolveSessionWorkspaceCwd"];
  forkSandboxForSubagent: TurnRunnerDependencies["forkSandboxForSubagent"];
  cleanupSandboxForSubagent: TurnRunnerDependencies["cleanupSandboxForSubagent"];
  appendSubagentReceipt: AppendSubagentReceipt;
  requireSubagentPersistence(): {
    upsertRun(run: SubagentRun): Promise<unknown>;
  };
}) {
  const {
    attachmentRootDir,
    resolveSessionWorkspaceCwd,
    forkSandboxForSubagent,
    cleanupSandboxForSubagent,
    appendSubagentReceipt,
  } = deps;
  const requireSubagentDeps = deps.requireSubagentPersistence;
  function subagentIsolationBlocker(role: SubagentRoleSettings): string | null {
    if (role.toolPolicy === "read_only") return null;
    if (role.isolationMode === "none") {
      return "write-capable subagents require an isolated workspace target.";
    }
    return `${role.isolationMode} isolation is not available for this workspace target.`;
  }

  async function subagentWorkspaceTargetKeyForSession(session: Session): Promise<string> {
    const target = resolveWorkspaceExecutionTarget({ session });
    if (target.target === "sandbox") {
      const sandboxId = session.cloudProjectId ?? session.workspaceId ?? session.cloudTeamId ?? session.id;
      return `sandbox:${sandboxId}`;
    }
    const cwd =
      session.cwd ??
      (await resolveSessionWorkspaceCwd(session, { ensureOpenPond: false }).catch(() => null)) ??
      null;
    if (!cwd) return `session:${session.id}`;
    const rootResult = await runWorkspaceCommand("git", ["rev-parse", "--show-toplevel"], cwd).catch(() => null);
    const repoRoot = rootResult?.code === 0 ? rootResult.stdout.trim() : "";
    return `local:${repoRoot || cwd}`;
  }

  function subagentWorkspaceTargetKeyFromRun(run: SubagentRun): string | null {
    const metadata = recordFromUnknown(run.metadata);
    const concurrency = recordFromUnknown(metadata?.concurrency);
    const storedKey = concurrency ? stringFromRecord(concurrency, "workspaceTargetKey") : null;
    if (storedKey) return storedKey;
    const workspace = subagentWorkspaceFromRun(run);
    if (!workspace) return null;
    const target = stringFromRecord(workspace, "target");
    if (target === "local") {
      const parentRepoPath = stringFromRecord(workspace, "parentRepoPath");
      const workspaceRoot = stringFromRecord(workspace, "workspaceRoot");
      const repoPath = stringFromRecord(workspace, "repoPath");
      return `local:${parentRepoPath ?? workspaceRoot ?? repoPath ?? "unknown"}`;
    }
    if (target === "sandbox") {
      return `sandbox:${stringFromRecord(workspace, "sandboxId") ?? stringFromRecord(workspace, "workspaceId") ?? "unknown"}`;
    }
    return target ? `${target}:unknown` : null;
  }

  type PreparedSubagentWorkspaceIsolation = {
    cwd: string | null;
    effectiveIsolationMode: SubagentRoleSettings["isolationMode"];
    blocker: string | null;
    workspace: Record<string, unknown> | null;
    sessionWorkspace?: Partial<Pick<
      Session,
      | "workspaceKind"
      | "workspaceId"
      | "workspaceName"
      | "localProjectId"
      | "cloudProjectId"
      | "cloudTeamId"
      | "metadata"
    >> | null;
  };

  type LocalSubagentGitWorktree = Record<string, unknown> & {
    repoPath: string;
  };

  type LocalSubagentDependencyLink = {
    path: string;
    sourcePath: string;
    targetPath: string;
    status: "linked" | "missing" | "not_ignored" | "target_exists" | "failed";
    error?: string;
  };

  async function prepareSubagentWorkspaceIsolation(input: {
    parentSession: Session;
    role: SubagentRoleSettings;
    runId: string;
  }): Promise<PreparedSubagentWorkspaceIsolation> {
    if (input.role.toolPolicy === "read_only") {
      return {
        cwd: input.parentSession.cwd,
        effectiveIsolationMode: "none",
        blocker: null,
        workspace: null,
      };
    }
    const staticBlocker = subagentIsolationBlocker(input.role);
    if (staticBlocker && input.role.isolationMode === "none") {
      return {
        cwd: input.parentSession.cwd,
        effectiveIsolationMode: "none",
        blocker: staticBlocker,
        workspace: null,
      };
    }

    const target = resolveWorkspaceExecutionTarget({ session: input.parentSession });
    if (target.target === "sandbox") {
      return prepareSandboxSubagentWorkspaceIsolation({
        parentSession: input.parentSession,
        role: input.role,
        runId: input.runId,
        target,
      });
    }

    const parentCwd =
      input.parentSession.cwd ??
      (await resolveSessionWorkspaceCwd(input.parentSession, { ensureOpenPond: false })) ??
      null;
    if (!parentCwd) {
      return {
        cwd: null,
        effectiveIsolationMode: input.role.isolationMode,
        blocker: `${input.role.isolationMode} isolation requires a local git workspace, but this chat has no local workspace cwd.`,
        workspace: null,
      };
    }

    try {
      const workspace = await createLocalSubagentGitWorktree({
        parentCwd,
        role: input.role,
        runId: input.runId,
      });
      return {
        cwd: workspace.repoPath,
        effectiveIsolationMode: input.role.isolationMode,
        blocker: null,
        workspace,
      };
    } catch (error) {
      return {
        cwd: parentCwd,
        effectiveIsolationMode: input.role.isolationMode,
        blocker: `${input.role.isolationMode} isolation unavailable: ${textFromUnknown(error) || "Unable to create isolated worktree."}`,
        workspace: null,
      };
    }
  }

  async function prepareSandboxSubagentWorkspaceIsolation(input: {
    parentSession: Session;
    role: SubagentRoleSettings;
    runId: string;
    target: Extract<ReturnType<typeof resolveWorkspaceExecutionTarget>, { target: "sandbox" }>;
  }): Promise<PreparedSubagentWorkspaceIsolation> {
    const parentSandboxId = input.target.sandboxId ?? input.target.workspaceId;
    if (!parentSandboxId) {
      return {
        cwd: input.parentSession.cwd,
        effectiveIsolationMode: input.role.isolationMode,
        blocker: `${input.role.isolationMode} isolation requires a sandbox id, but this chat has no sandbox workspace id.`,
        workspace: {
          mode: input.role.isolationMode,
          target: "sandbox",
          unavailableReason: "missing_parent_sandbox_id",
        },
      };
    }
    if (!forkSandboxForSubagent) {
      return {
        cwd: input.parentSession.cwd,
        effectiveIsolationMode: input.role.isolationMode,
        blocker: [
          `${input.role.isolationMode} isolation requires sandbox fork support, but no sandbox fork executor is configured.`,
          "The child stayed on the sandbox target and did not fall back to local files.",
        ].join(" "),
        workspace: {
          mode: input.role.isolationMode,
          target: "sandbox",
          parentSandboxId,
          unavailableReason: "sandbox_fork_executor_unavailable",
        },
      };
    }

    const forkedAt = now();
    const forkPayload = {
      visibility: "private",
      metadata: {
        openpondPurpose: "subagent_copy_on_write",
        subagentRunId: input.runId,
        subagentRoleId: input.role.id,
        parentSessionId: input.parentSession.id,
        parentWorkspaceId: input.target.workspaceId,
        parentSandboxId,
        isolationMode: input.role.isolationMode,
        forkedAt,
      },
    };
    let forkResult: unknown;
    try {
      forkResult = await forkSandboxForSubagent({
        sandboxId: parentSandboxId,
        payload: forkPayload,
        parentSession: input.parentSession,
        role: input.role,
        runId: input.runId,
      });
    } catch (error) {
      const message = textFromUnknown(error) || "Sandbox fork failed.";
      return {
        cwd: input.parentSession.cwd,
        effectiveIsolationMode: input.role.isolationMode,
        blocker: `${input.role.isolationMode} isolation unavailable: ${message}`,
        workspace: {
          mode: input.role.isolationMode,
          target: "sandbox",
          parentSandboxId,
          unavailableReason: "sandbox_fork_failed",
          error: message,
        },
      };
    }

    const sandbox = sandboxRecordFromForkPayload(forkResult);
    const sandboxId = sandboxIdFromForkPayload(forkResult);
    if (!sandboxId) {
      return {
        cwd: input.parentSession.cwd,
        effectiveIsolationMode: input.role.isolationMode,
        blocker: `${input.role.isolationMode} isolation unavailable: sandbox fork response did not include a sandbox id.`,
        workspace: {
          mode: input.role.isolationMode,
          target: "sandbox",
          parentSandboxId,
          unavailableReason: "sandbox_fork_missing_id",
        },
      };
    }

    const workspaceName =
      (sandbox ? stringFromRecord(sandbox, "name") ?? stringFromRecord(sandbox, "title") : null) ??
      (input.parentSession.workspaceName ? `${input.parentSession.workspaceName} fork` : "Subagent sandbox fork");
    const workspace = {
      mode: input.role.isolationMode,
      implementation: "sandbox_fork",
      target: "sandbox",
      sandboxId,
      workspaceId: sandboxId,
      workspaceKind: input.target.workspaceKind,
      workspaceName,
      parentSandboxId,
      parentWorkspaceId: input.target.workspaceId,
      sourceSandboxId: sourceSandboxIdFromForkPayload(forkResult) ?? parentSandboxId,
      cloudProjectId: input.target.cloudProjectId,
      cloudTeamId: input.target.cloudTeamId,
      localProjectId: input.target.localProjectId,
      forkedAt,
      cleanup: "manual_after_handoff",
    };
    const sessionWorkspace: NonNullable<PreparedSubagentWorkspaceIsolation["sessionWorkspace"]> = {
      workspaceKind: input.target.workspaceKind as Session["workspaceKind"],
      workspaceId: sandboxId,
      workspaceName,
      localProjectId: input.target.localProjectId,
      cloudProjectId: input.target.cloudProjectId,
      cloudTeamId: input.target.cloudTeamId,
      ...(input.target.hybrid ? { metadata: { workspaceTarget: "hybrid" } } : {}),
    };
    return {
      cwd: input.parentSession.cwd,
      effectiveIsolationMode: input.role.isolationMode,
      blocker: null,
      workspace,
      sessionWorkspace,
    };
  }

  function sandboxRecordFromForkPayload(payload: unknown): Record<string, unknown> | null {
    const root = recordFromUnknown(payload);
    const data = recordFromUnknown(root?.data);
    return recordFromUnknown(root?.sandbox) ?? recordFromUnknown(data?.sandbox);
  }

  function sandboxIdFromForkPayload(payload: unknown): string | null {
    const root = recordFromUnknown(payload);
    const sandbox = sandboxRecordFromForkPayload(payload);
    return (
      (sandbox ? stringFromRecord(sandbox, "id") ?? stringFromRecord(sandbox, "sandboxId") : null) ??
      (root ? stringFromRecord(root, "sandboxId") ?? stringFromRecord(root, "id") : null)
    );
  }

  function sourceSandboxIdFromForkPayload(payload: unknown): string | null {
    const root = recordFromUnknown(payload);
    const data = recordFromUnknown(root?.data);
    const sourceSandbox = recordFromUnknown(root?.sourceSandbox) ?? recordFromUnknown(data?.sourceSandbox);
    return sourceSandbox ? stringFromRecord(sourceSandbox, "id") ?? stringFromRecord(sourceSandbox, "sandboxId") : null;
  }

  async function createLocalSubagentGitWorktree(input: {
    parentCwd: string;
    role: SubagentRoleSettings;
    runId: string;
  }): Promise<LocalSubagentGitWorktree> {
    const repoRootResult = await runWorkspaceCommand("git", ["rev-parse", "--show-toplevel"], input.parentCwd);
    const parentRepoPath = repoRootResult.stdout.trim();
    if (repoRootResult.code !== 0 || !parentRepoPath) {
      throw new Error(repoRootResult.stderr.trim() || repoRootResult.stdout.trim() || "Parent workspace is not a git repository.");
    }
    const headResult = await runWorkspaceCommand("git", ["rev-parse", "--verify", "HEAD"], parentRepoPath);
    const baseCommit = headResult.stdout.trim();
    if (headResult.code !== 0 || !baseCommit) {
      throw new Error(headResult.stderr.trim() || headResult.stdout.trim() || "Parent git repository has no HEAD commit.");
    }
    const statusResult = await runWorkspaceCommand("git", ["status", "--porcelain=v1"], parentRepoPath);
    if (statusResult.code !== 0) {
      throw new Error(statusResult.stderr.trim() || statusResult.stdout.trim() || "Unable to inspect parent git status.");
    }

    const safeRunId = safeSubagentPathSegment(input.runId);
    const safeRoleId = safeSubagentPathSegment(input.role.id);
    const workspaceRoot = path.join(
      os.tmpdir(),
      "openpond-subagents",
      safeSubagentPathSegment(path.basename(parentRepoPath) || "repo"),
      `${safeRoleId}-${safeRunId}`,
    );
    const worktreePath = path.join(workspaceRoot, "repo");
    const branch = `openpond/subagent/${safeRoleId}/${safeRunId.slice(0, 24)}`;
    await fs.rm(workspaceRoot, { recursive: true, force: true });
    await fs.mkdir(workspaceRoot, { recursive: true });
    const addResult = await runWorkspaceCommand(
      "git",
      ["worktree", "add", "-b", branch, worktreePath, baseCommit],
      parentRepoPath,
    );
    if (addResult.code !== 0) {
      await fs.rm(workspaceRoot, { recursive: true, force: true }).catch(() => undefined);
      throw new Error(addResult.stderr.trim() || addResult.stdout.trim() || "git worktree add failed");
    }
    const dependencyLinks = await linkLocalSubagentDependencyArtifacts({
      parentRepoPath,
      worktreePath,
    });

    return {
      mode: input.role.isolationMode,
      implementation: "git_worktree",
      target: "local",
      repoPath: worktreePath,
      worktreePath,
      workspaceRoot,
      parentRepoPath,
      branch,
      baseCommit,
      parentDirty: Boolean(statusResult.stdout.trim()),
      dependencyLinks,
      createdAt: now(),
      cleanup: "manual_after_handoff",
    };
  }

  async function linkLocalSubagentDependencyArtifacts(input: {
    parentRepoPath: string;
    worktreePath: string;
  }): Promise<LocalSubagentDependencyLink[]> {
    const links: LocalSubagentDependencyLink[] = [];
    const candidates = await localSubagentDependencyArtifactCandidates(input.parentRepoPath);
    for (const relativePath of candidates) {
      const sourcePath = path.join(input.parentRepoPath, ...relativePath.split("/"));
      const targetPath = path.join(input.worktreePath, ...relativePath.split("/"));
      const sourceStat = await safeLstat(sourcePath);
      if (!sourceStat) {
        links.push({ path: relativePath, sourcePath, targetPath, status: "missing" });
        continue;
      }
      if (!sourceStat.isDirectory()) {
        links.push({ path: relativePath, sourcePath, targetPath, status: "failed", error: "dependency artifact is not a directory" });
        continue;
      }
      if (!(await gitPathIgnored(input.parentRepoPath, relativePath))) {
        links.push({ path: relativePath, sourcePath, targetPath, status: "not_ignored" });
        continue;
      }
      if (await safeLstat(targetPath)) {
        links.push({ path: relativePath, sourcePath, targetPath, status: "target_exists" });
        continue;
      }
      try {
        await fs.mkdir(path.dirname(targetPath), { recursive: true });
        await fs.symlink(sourcePath, targetPath, process.platform === "win32" ? "junction" : "dir");
        links.push({ path: relativePath, sourcePath, targetPath, status: "linked" });
      } catch (error) {
        links.push({
          path: relativePath,
          sourcePath,
          targetPath,
          status: "failed",
          error: textFromUnknown(error) || "Unable to link dependency artifact.",
        });
      }
    }
    return links;
  }

  async function localSubagentDependencyArtifactCandidates(parentRepoPath: string): Promise<string[]> {
    const candidates = new Set<string>(["node_modules"]);
    for (const workspaceDir of await localWorkspacePackageDirs(parentRepoPath)) {
      const relativePath = path.posix.join(workspaceDir, "node_modules");
      const sourcePath = path.join(parentRepoPath, ...relativePath.split("/"));
      if (await safeLstat(sourcePath)) candidates.add(relativePath);
    }
    return [...candidates];
  }

  async function localWorkspacePackageDirs(parentRepoPath: string): Promise<string[]> {
    const packageJson = await readJsonFile(path.join(parentRepoPath, "package.json"));
    const workspaces = workspacePatternsFromPackageJson(packageJson);
    const dirs: string[] = [];
    for (const pattern of workspaces) {
      for (const dir of await expandSimpleWorkspacePattern(parentRepoPath, pattern)) {
        dirs.push(dir);
      }
    }
    return [...new Set(dirs)].slice(0, 80);
  }

  function workspacePatternsFromPackageJson(value: unknown): string[] {
    const record = recordFromUnknown(value);
    const workspaces = record?.workspaces;
    if (Array.isArray(workspaces)) {
      return workspaces.filter((item): item is string => typeof item === "string" && item.trim().length > 0);
    }
    const workspaceRecord = recordFromUnknown(workspaces);
    const packages = workspaceRecord?.packages;
    return Array.isArray(packages)
      ? packages.filter((item): item is string => typeof item === "string" && item.trim().length > 0)
      : [];
  }

  async function expandSimpleWorkspacePattern(parentRepoPath: string, pattern: string): Promise<string[]> {
    const normalized = pattern.trim().replace(/\\/g, "/").replace(/\/+$/g, "");
    if (!normalized || normalized.startsWith("!") || normalized.startsWith("/") || normalized.includes("..")) return [];
    const segments = normalized.split("/").filter(Boolean);
    let relDirs = [""];
    for (const segment of segments) {
      if (segment === "*") {
        const expanded: string[] = [];
        for (const relDir of relDirs) {
          const absoluteDir = path.join(parentRepoPath, ...relDir.split("/").filter(Boolean));
          const entries = await safeReaddir(absoluteDir);
          for (const entry of entries) {
            if (!entry.isDirectory() || entry.name === "node_modules" || entry.name === ".git") continue;
            expanded.push(path.posix.join(relDir, entry.name));
          }
        }
        relDirs = expanded;
        continue;
      }
      if (segment.includes("*")) return [];
      relDirs = relDirs.map((relDir) => path.posix.join(relDir, segment));
    }
    const existing: string[] = [];
    for (const relDir of relDirs) {
      const stat = await safeLstat(path.join(parentRepoPath, ...relDir.split("/").filter(Boolean)));
      if (stat?.isDirectory()) existing.push(relDir);
    }
    return existing;
  }

  async function gitPathIgnored(repoPath: string, relativePath: string): Promise<boolean> {
    const result = await runWorkspaceCommand("git", ["check-ignore", "-q", "--", relativePath], repoPath);
    return result.code === 0;
  }

  async function readJsonFile(filePath: string): Promise<unknown> {
    try {
      return JSON.parse(await fs.readFile(filePath, "utf8"));
    } catch {
      return null;
    }
  }

  async function safeLstat(filePath: string): Promise<import("node:fs").Stats | null> {
    try {
      return await fs.lstat(filePath);
    } catch {
      return null;
    }
  }

  async function safeReaddir(dirPath: string): Promise<import("node:fs").Dirent[]> {
    try {
      return await fs.readdir(dirPath, { withFileTypes: true });
    } catch {
      return [];
    }
  }

  function safeSubagentPathSegment(value: string): string {
    return value.replace(/[^a-zA-Z0-9._-]/g, "-").slice(0, 80) || "subagent";
  }

  function changedFilesFromGitPorcelain(statusText: string): string[] {
    return uniqueNonEmptyStrings(statusText
      .split(/\r?\n/)
      .map((line) => line.trimEnd())
      .filter((line) => line && !line.startsWith("##"))
      .map((line) => {
        const entry = line.slice(3).trim();
        const renamedPath = entry.includes(" -> ") ? entry.split(" -> ").at(-1) : entry;
        return renamedPath?.replace(/^"|"$/g, "") ?? "";
      }));
  }

  async function captureSubagentWorkspaceHandoff(run: SubagentRun): Promise<{
    changed: boolean;
    changedFiles: string[];
    artifacts: NonNullable<SubagentRun["report"]>["artifacts"];
    patchRef: NonNullable<SubagentRun["report"]>["patchRef"];
    diffRef: NonNullable<SubagentRun["report"]>["diffRef"];
    metadata: Record<string, unknown>;
  } | null> {
    const workspace = subagentWorkspaceFromRun(run);
    if (!workspace) return null;
    if (workspace.implementation === "sandbox_fork") {
      return captureSubagentSandboxForkHandoff(run, workspace);
    }
    if (workspace.implementation !== "git_worktree") return null;
    const repoPath = typeof workspace.repoPath === "string" ? workspace.repoPath : null;
    const parentRepoPath = typeof workspace.parentRepoPath === "string" ? workspace.parentRepoPath : null;
    const workspaceRoot = typeof workspace.workspaceRoot === "string" ? workspace.workspaceRoot : null;
    if (!repoPath || !workspaceRoot) return null;

    await runWorkspaceCommand("git", ["add", "-N", "."], repoPath).catch(() => null);
    const diffResult = await runWorkspaceCommand("git", ["diff", "--binary", "HEAD"], repoPath);
    if (diffResult.code !== 0) {
      return {
        changed: false,
        changedFiles: [],
        artifacts: [],
        patchRef: null,
        diffRef: null,
        metadata: {
          status: "failed",
          reason: diffResult.stderr.trim() || diffResult.stdout.trim() || "git diff failed",
          repoPath,
          parentRepoPath,
        },
      };
    }
    const statusResult = await runWorkspaceCommand("git", ["status", "--porcelain=v1", "-b"], repoPath);
    const changedFiles = statusResult.code === 0 ? changedFilesFromGitPorcelain(statusResult.stdout) : [];
    const patch = diffResult.stdout;
    const changed = Boolean(patch.trim());
    const patchArtifact = changed ? await durableSubagentPatchArtifact(run) : null;
    const patchPath = patchArtifact?.patchPath ?? path.join(workspaceRoot, "handoff.patch");
    if (changed) await fs.writeFile(patchPath, patch, "utf8");
    const patchPreview = truncatePatch(patch);
    const patchRef = changed
      ? { kind: "file" as const, id: patchPath, label: "Isolated child patch" }
      : null;
    const diffRef = changed
      ? { kind: "diff" as const, id: `subagent-run:${run.id}:diff`, label: "Isolated child diff" }
      : null;
    return {
      changed,
      changedFiles,
      artifacts: patchRef ? [patchRef] : [],
      patchRef,
      diffRef,
      metadata: {
        status: "captured",
        changed,
        repoPath,
        parentRepoPath,
        workspaceRoot,
        patchRootPath: patchArtifact?.rootPath ?? workspaceRoot,
        branch: workspace.branch ?? null,
        baseCommit: workspace.baseCommit ?? null,
        changedFiles,
        patchPath: changed ? patchPath : null,
        patchBytes: Buffer.byteLength(patch, "utf8"),
        patchPreview,
        patchTruncated: patchPreview !== patch,
        statusText: statusResult.code === 0 ? statusResult.stdout : null,
        apply: changed
          ? {
              command: "git",
              args: parentRepoPath ? ["-C", parentRepoPath, "apply", patchPath] : ["apply", patchPath],
              requiresUserReview: true,
            }
          : null,
      },
    };
  }

  async function durableSubagentPatchArtifact(run: SubagentRun): Promise<{
    rootPath: string;
    patchPath: string;
  }> {
    const rootPath = path.join(
      attachmentRootDir,
      "subagents",
      safeSubagentPathSegment(run.parentSessionId),
      safeSubagentPathSegment(run.id),
    );
    await fs.mkdir(rootPath, { recursive: true });
    return {
      rootPath,
      patchPath: path.join(rootPath, "handoff.patch"),
    };
  }

  function captureSubagentSandboxForkHandoff(
    run: SubagentRun,
    workspace: Record<string, unknown>,
  ): {
    changed: boolean;
    changedFiles: string[];
    artifacts: NonNullable<SubagentRun["report"]>["artifacts"];
    patchRef: NonNullable<SubagentRun["report"]>["patchRef"];
    diffRef: NonNullable<SubagentRun["report"]>["diffRef"];
    metadata: Record<string, unknown>;
  } | null {
    const sandboxId = stringFromRecord(workspace, "sandboxId") ?? stringFromRecord(workspace, "workspaceId");
    if (!sandboxId) return null;
    const label = stringFromRecord(workspace, "workspaceName") ?? `${run.roleId} sandbox fork`;
    const sandboxRef = {
      kind: "artifact" as const,
      id: `sandbox:${sandboxId}`,
      label: `Isolated sandbox: ${label}`,
    };
    return {
      changed: true,
      changedFiles: [],
      artifacts: [sandboxRef],
      patchRef: null,
      diffRef: null,
      metadata: {
        status: "captured",
        changed: true,
        changedFiles: [],
        implementation: "sandbox_fork",
        target: "sandbox",
        sandboxId,
        parentSandboxId: stringFromRecord(workspace, "parentSandboxId"),
        sourceSandboxId: stringFromRecord(workspace, "sourceSandboxId"),
        workspaceKind: stringFromRecord(workspace, "workspaceKind"),
        workspaceName: label,
        forkedAt: stringFromRecord(workspace, "forkedAt"),
        artifactRef: sandboxRef,
        merge: {
          strategy: "sandbox_review",
          requiresUserReview: true,
        },
      },
    };
  }

  function subagentWorkspaceFromRun(run: SubagentRun): Record<string, unknown> | null {
    const metadata = recordFromUnknown(run.metadata);
    return recordFromUnknown(metadata?.subagentWorkspace) ?? recordFromUnknown(metadata?.workspace);
  }

  async function cleanupSubagentWorkspace(run: SubagentRun): Promise<Record<string, unknown> | null> {
    const workspace = subagentWorkspaceFromRun(run);
    if (!workspace) return null;
    if (workspace.implementation === "sandbox_fork") return cleanupSubagentSandboxFork(run, workspace);
    if (workspace.implementation !== "git_worktree") return null;
    const workspaceRoot = stringFromRecord(workspace, "workspaceRoot");
    const worktreePath = stringFromRecord(workspace, "worktreePath") ?? stringFromRecord(workspace, "repoPath");
    const parentRepoPath = stringFromRecord(workspace, "parentRepoPath");
    const removedAt = now();
    const result: Record<string, unknown> = {
      status: "removed",
      removedAt,
      workspaceRoot,
      worktreePath,
      parentRepoPath,
    };
    if (parentRepoPath && worktreePath) {
      const removeResult = await runWorkspaceCommand(
        "git",
        ["worktree", "remove", "--force", worktreePath],
        parentRepoPath,
      ).catch((error) => ({
        code: 1,
        stdout: "",
        stderr: textFromUnknown(error) || "git worktree remove failed",
      }));
      result.gitWorktreeRemove = {
        code: removeResult.code,
        stdout: removeResult.stdout.trim() || null,
        stderr: removeResult.stderr.trim() || null,
      };
    }
    if (workspaceRoot) {
      await fs.rm(workspaceRoot, { recursive: true, force: true }).catch((error) => {
        result.status = "failed";
        result.rmError = textFromUnknown(error) || "Failed to remove isolated workspace root.";
      });
    } else {
      result.status = "skipped";
      result.reason = "workspaceRoot missing";
    }
    return result;
  }

  async function cleanupSubagentSandboxFork(
    run: SubagentRun,
    workspace: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    const sandboxId = stringFromRecord(workspace, "sandboxId") ?? stringFromRecord(workspace, "workspaceId");
    const deletedAt = now();
    const result: Record<string, unknown> = {
      status: "deleted",
      deletedAt,
      implementation: "sandbox_fork",
      target: "sandbox",
      sandboxId,
      parentSandboxId: stringFromRecord(workspace, "parentSandboxId"),
      sourceSandboxId: stringFromRecord(workspace, "sourceSandboxId"),
      workspaceName: stringFromRecord(workspace, "workspaceName"),
    };
    if (!sandboxId) {
      return {
        ...result,
        status: "skipped",
        reason: "sandboxId missing",
      };
    }
    if (!cleanupSandboxForSubagent) {
      return {
        ...result,
        status: "skipped",
        reason: "sandbox cleanup executor unavailable",
      };
    }
    try {
      const payload = await cleanupSandboxForSubagent({ sandboxId, run });
      return {
        ...result,
        payload: sandboxCleanupPayloadSummary(payload),
      };
    } catch (error) {
      return {
        ...result,
        status: "failed",
        failedAt: now(),
        error: textFromUnknown(error) || "Sandbox fork cleanup failed.",
      };
    }
  }

  function sandboxCleanupPayloadSummary(payload: unknown): Record<string, unknown> | null {
    const record = recordFromUnknown(payload);
    if (!record) return null;
    const sandbox = recordFromUnknown(record.sandbox);
    if (!sandbox) return null;
    return {
      sandboxId: stringFromRecord(sandbox, "id") ?? stringFromRecord(sandbox, "sandboxId"),
      state: stringFromRecord(sandbox, "state"),
      name: stringFromRecord(sandbox, "name") ?? stringFromRecord(sandbox, "title"),
    };
  }

  async function cleanupSubagentRun(input: {
    run: SubagentRun;
    parentSession: Session;
    parentTurnId?: string | null;
    reason: string;
    policy: SubagentCleanupPolicy;
  }): Promise<{ run: SubagentRun; workspaceCleanup: Record<string, unknown> }> {
    const deps = requireSubagentDeps();
    const existingCleanup = recordFromUnknown(input.run.metadata?.lifecycleCleanup);
    const existingWorkspaceCleanup = recordFromUnknown(existingCleanup?.workspaceCleanup);
    if (existingWorkspaceCleanup && subagentWorkspaceCleanupAlreadyDone(existingWorkspaceCleanup)) {
      return { run: input.run, workspaceCleanup: existingWorkspaceCleanup };
    }

    const requestedAt = now();
    await appendSubagentReceipt({
      parentSession: input.parentSession,
      parentTurnId: input.parentTurnId,
      run: input.run,
      eventName: "subagent.cleanup",
      status: "started",
      output: `${input.run.roleId} subagent cleanup started.`,
    });

    let workspaceCleanup: Record<string, unknown>;
    const retainReason = subagentCleanupRetainReason(input.run, input.policy);
    if (retainReason) {
      workspaceCleanup = subagentRetainedWorkspaceState({
        retainedAt: now(),
        reason: retainReason,
        trigger: subagentWorkspaceRetentionTriggerForCleanupPolicy(input.policy),
      });
    } else {
      workspaceCleanup = (await cleanupSubagentWorkspace(input.run)) ?? {
        status: "skipped",
        reason: "No cleanable isolated workspace.",
        skippedAt: now(),
      };
    }

    const completedAt = now();
    const nextRun = SubagentRunSchema.parse({
      ...input.run,
      metadata: {
        ...(input.run.metadata ?? {}),
        lifecycleCleanup: {
          reason: input.reason,
          policy: input.policy,
          requestedAt,
          completedAt,
          evidenceRetention: input.run.evidenceRetention,
          ...(existingWorkspaceCleanup ? { previousWorkspaceCleanup: existingWorkspaceCleanup } : {}),
          workspaceCleanup,
        },
      },
    });
    await deps.upsertRun(nextRun);
    const status = stringFromRecord(workspaceCleanup, "status");
    await appendSubagentReceipt({
      parentSession: input.parentSession,
      parentTurnId: input.parentTurnId,
      run: nextRun,
      eventName: "subagent.cleanup",
      status: status === "failed" ? "failed" : "completed",
      output: subagentCleanupOutput(nextRun, workspaceCleanup),
    });
    if (status === "retained") {
      await appendSubagentReceipt({
        parentSession: input.parentSession,
        parentTurnId: input.parentTurnId,
        run: nextRun,
        eventName: "subagent.workspace_retained",
        status: "completed",
        output: `${nextRun.roleId} subagent workspace retained for inspection.`,
      });
    }
    return { run: nextRun, workspaceCleanup };
  }


  return {
    captureSubagentWorkspaceHandoff,
    cleanupSubagentRun,
    prepareSubagentWorkspaceIsolation,
    subagentIsolationBlocker,
    subagentWorkspaceTargetKeyForSession,
    subagentWorkspaceTargetKeyFromRun,
  };
}

