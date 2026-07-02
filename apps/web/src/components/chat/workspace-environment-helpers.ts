import type { OpenPondApp, WorkspaceState, WorkspaceToolResult } from "@openpond/contracts";
import { OPENPOND_MANIFEST_FILE_NAME } from "@openpond/contracts";
import type { SandboxProjectSourceType, SandboxRecord } from "../../lib/sandbox-types";
import type { SandboxScheduleSelection } from "../app-shell/SandboxCreateDialog";

export function starterManifestPreview(projectName: string, preset: string): string {
  const safeName = projectName.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "agent";
  if (preset === "cron") {
    return `name: ${safeName}\nversion: 0.1.0\nuseCase: scheduled_report\nstart:\n  command: bun run report\nschedules:\n  - name: daily-report\n    command: bun run report\n    cron: \"0 9 * * *\"`;
  }
  if (preset === "background") {
    return `name: ${safeName}\nversion: 0.1.0\nuseCase: background_worker\nstart:\n  command: bun run worker\nservices:\n  - name: worker\n    command: bun run worker`;
  }
  if (preset === "resources") {
    return `name: ${safeName}\nversion: 0.1.0\nuseCase: resource_profile\nresources:\n  cpu: 1\n  memoryGb: 2\n  diskGb: 16\nstart:\n  command: bun start`;
  }
  return `name: ${safeName}\nversion: 0.1.0\nuseCase: action\nstart:\n  command: bun start\nactions:\n  - name: hello\n    command: bun run hello`;
}

export function agentSetupStatusLabel(state: string, reason: string | null): string {
  if (reason) return reason;
  if (state === "missing_config") return `${OPENPOND_MANIFEST_FILE_NAME} missing`;
  if (state === "needs_project") return "Local config is ready";
  if (state === "needs_sync") return "Project needs manifest sync";
  if (state === "needs_agent") return "Project is synced";
  if (state === "ready") return "Agent is ready";
  return "Setup unavailable";
}

export function workspaceSourceLabel(workspaceState?: WorkspaceState | null): string {
  if (workspaceState?.source === "openpond") return "OpenPond Git";
  if (workspaceState?.source === "github") return "GitHub";
  if (workspaceState?.source === "local_git") return "Local Git";
  if (workspaceState?.source === "local_folder") return "Local folder";
  return "Workspace";
}

export function repoUrlFromPublishResult(result: WorkspaceToolResult): string | null {
  const data = asRecord(result.data);
  const remote = asRecord(data.remote);
  const remoteUrl = typeof remote.remoteUrl === "string" ? remote.remoteUrl.trim() : "";
  return remoteUrl || null;
}

export function sandboxIdFromWorkspaceToolResult(result: WorkspaceToolResult): string | null {
  const data = asRecord(result.data);
  const sandbox = asRecord(data.sandbox);
  const id = typeof sandbox.id === "string" ? sandbox.id.trim() : "";
  return id || null;
}

export function sandboxNameFromRecord(sandbox: SandboxRecord | null): string | null {
  if (!sandbox) return null;
  if (typeof sandbox.metadata?.name === "string" && sandbox.metadata.name.trim()) {
    return sandbox.metadata.name.trim();
  }
  if (sandbox.projectId) return `Project sandbox ${shortId(sandbox.id)}`;
  if (sandbox.agentId) return `Agent sandbox ${shortId(sandbox.id)}`;
  return `Sandbox ${shortId(sandbox.id)}`;
}

export function sandboxScheduleCreateArgs(
  schedule: SandboxScheduleSelection,
  sourceSandboxId: string,
): Record<string, unknown> {
  return {
    sourceSandboxId,
    name: schedule.name,
    ...(schedule.description ? { description: schedule.description } : {}),
    scheduleType: schedule.scheduleType,
    scheduleExpression: schedule.scheduleExpression,
    enabled: true,
    ...(schedule.timezone ? { timezone: schedule.timezone } : {}),
    ...(schedule.startAt ? { startAt: schedule.startAt } : {}),
    ...(schedule.endAt ? { endAt: schedule.endAt } : {}),
    ...(schedule.maxRuns !== undefined ? { maxRuns: schedule.maxRuns } : {}),
    ...(schedule.runtimePolicy ? { runtimePolicy: schedule.runtimePolicy } : {}),
    target: schedule.target,
    ...(schedule.budget ? { budget: schedule.budget } : {}),
    ...(schedule.resources ? { resources: schedule.resources } : {}),
    ...(schedule.quotas ? { quotas: schedule.quotas } : {}),
    ...(schedule.lifecycle ? { lifecycle: schedule.lifecycle } : {}),
    ...(schedule.retentionPolicy ? { retentionPolicy: schedule.retentionPolicy } : {}),
    ...(schedule.env ? { env: schedule.env } : {}),
    ...(schedule.integrationLeases ? { integrationLeases: schedule.integrationLeases } : {}),
    metadata: schedule.metadata ?? {},
    managementSource: "openpond.yaml",
    manifestPath: OPENPOND_MANIFEST_FILE_NAME,
  };
}

export function repoUrlFromApp(app: OpenPondApp | null): string | null {
  const owner = app?.gitOwner?.trim() ?? "";
  const repo = app?.gitRepo?.trim() ?? "";
  const host = app?.gitHost?.trim() ?? "";
  if (!owner || !repo || !host) return null;
  const normalizedRepo = repo.endsWith(".git") ? repo : `${repo}.git`;
  if (/^https?:\/\//i.test(host)) {
    return `${host.replace(/\/+$/, "")}/${owner}/${normalizedRepo}`;
  }
  return `https://${host.replace(/\/+$/, "")}/${owner}/${normalizedRepo}`;
}

export function parseProjectSourceValue(
  sourceType: SandboxProjectSourceType,
  value: string,
): {
  gitHost: string | null;
  gitOwner: string | null;
  gitRepo: string | null;
  internalRepoPath: string | null;
  templateRepoUrl: string | null;
} {
  const trimmed = value.trim();
  if (sourceType === "github_repo") {
    const normalized = trimmed
      .replace(/^https:\/\/github\.com\//i, "")
      .replace(/^git@github\.com:/i, "")
      .replace(/\.git$/i, "");
    const [owner, repo] = normalized.split("/").filter(Boolean);
    return {
      gitHost: "github.com",
      gitOwner: owner ?? null,
      gitRepo: repo ?? null,
      internalRepoPath: null,
      templateRepoUrl: null,
    };
  }
  if (sourceType === "internal_repo") {
    return {
      gitHost: "openpond.ai",
      gitOwner: null,
      gitRepo: trimmed.split("/").filter(Boolean).at(-1) ?? null,
      internalRepoPath: trimmed || null,
      templateRepoUrl: null,
    };
  }
  if (sourceType === "template") {
    return {
      gitHost: null,
      gitOwner: null,
      gitRepo: null,
      internalRepoPath: null,
      templateRepoUrl: trimmed || null,
    };
  }
  return {
    gitHost: null,
    gitOwner: null,
    gitRepo: null,
    internalRepoPath: null,
    templateRepoUrl: null,
  };
}

export function sandboxUploadPath(targetPath: string, fileName: string): string {
  const basePath = targetPath
    .trim()
    .replace(/^\/+/, "")
    .replace(/^workspace\//, "")
    .replace(/\/+$/, "");
  const safeName =
    fileName
      .trim()
      .replace(/[/\\]+/g, "-")
      .replace(/[^A-Za-z0-9._-]+/g, "-")
      .replace(/^-+|-+$/g, "") || "upload";
  return `${basePath || "uploads"}/${safeName}`;
}

export function commandWithReplayParams(command: string, params: Record<string, unknown>): string {
  const encoded = base64Json({ input: params });
  return `OPENPOND_REPLAY_PARAMS_BASE64='${encoded}' ${command}`;
}

export function sandboxTemplateTerminalCommand(rootPath: string, subcommand: "dev", target: string): string {
  return [
    "cd",
    quoteShellArg(rootPath),
    "&&",
    "openpond",
    "sandbox-template",
    subcommand,
    "--file",
    OPENPOND_MANIFEST_FILE_NAME,
    "--target",
    quoteShellArg(target),
  ].join(" ");
}

export function quoteShellArg(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

export function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = typeof reader.result === "string" ? reader.result : "";
      const [, base64 = ""] = result.split(",", 2);
      resolve(base64);
    };
    reader.onerror = () => reject(reader.error ?? new Error("Failed to read file"));
    reader.readAsDataURL(file);
  });
}

export function base64Json(value: unknown): string {
  const json = JSON.stringify(value);
  const bytes = new TextEncoder().encode(json);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return window.btoa(binary);
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function shortId(value: string): string {
  return value.length <= 10 ? value : `${value.slice(0, 6)}...${value.slice(-4)}`;
}
