import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { existsSync, promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  FileOutputRefSchema,
  WORK_OUTPUT_CONTENT_TYPES,
  WORK_OUTPUT_MAX_BYTES,
  type OutputValidationEvidence,
  type RuntimeEvent,
  type Session,
  type WorkspaceToolResult,
} from "@openpond/contracts";

import type { TasksetWorkAttemptRuntime } from "./taskset-work-attempt-runner.js";

type LocalTasksetWorkRuntimeDeps = {
  storeDir: string;
  deviceId: string;
  createSession(payload: unknown): Promise<Session>;
  getSession(sessionId: string): Promise<Session>;
  runtimeEventsForSession(sessionId: string): Promise<RuntimeEvent[]>;
};

export function createLocalTasksetWorkRuntime(
  deps: LocalTasksetWorkRuntimeDeps,
): TasksetWorkAttemptRuntime {
  return {
    createSession: async (payload) => {
      const input = record(payload);
      return deps.createSession({
        ...input,
        cwd: undefined,
        hiddenFromDefaultSidebar: false,
        title: benchmarkSessionTitle(input),
        metadata: {
          ...record(input.metadata),
          workspaceTarget: "local",
          benchmarkRuntime: "desktop_local_work",
        },
      });
    },
    getSession: deps.getSession,
    runtimeEventsForSession: deps.runtimeEventsForSession,
    executeWorkspaceTool: async (sessionId, payload, options) => {
      const session = await deps.getSession(sessionId);
      if (!session.cwd) {
        throw new Error("Local Taskset Work requires an isolated Desktop workspace.");
      }
      return executeLocalWorkspaceTool({
        deps,
        session,
        payload,
        turnId: options?.turnId ?? null,
      });
    },
    settleCostEvidence: async () => ({
      ok: true,
      action: "sandbox_receipts",
      output: "Local Desktop Work does not produce a sandbox billing receipt.",
      data: {
        settlementMode: "desktop_local",
        billableUsd: 0,
        simulatedUsd: 0,
      },
    }),
  };
}

function benchmarkSessionTitle(input: Record<string, unknown>): string {
  const metadata = record(input.metadata);
  const taskId = string(metadata.taskId);
  if (!taskId) return "Benchmark task";
  const label = taskId
    .replace(/^(?:adaptation|frozen)-/, "")
    .replaceAll("-", " ")
    .replace(/^./, (character) => character.toUpperCase());
  return `Benchmark · ${label}`;
}

async function executeLocalWorkspaceTool(input: {
  deps: LocalTasksetWorkRuntimeDeps;
  session: Session;
  payload: unknown;
  turnId: string | null;
}): Promise<WorkspaceToolResult> {
  const request = record(input.payload);
  const action = string(request.action);
  const args = record(request.args);
  const root = path.resolve(input.session.cwd!);
  await ensureLayout(root);

  try {
    if (action === "sandbox_create" || action === "sandbox_start") {
      return ok(action, "Local Desktop Work is ready.", localStatus(root));
    }
    if (action === "sandbox_status") {
      return ok(action, "Local Desktop Work is running.", localStatus(root));
    }
    if (action === "sandbox_stop") {
      return ok(action, "Local Desktop Work stopped.", {
        ...localStatus(root, "stopped"),
        billableUsd: 0,
        simulatedUsd: 0,
        settlementMode: "desktop_local",
      });
    }
    if (action === "sandbox_receipts") {
      return ok(action, "Local Desktop Work has no sandbox billing receipt.", {
        billableUsd: 0,
        simulatedUsd: 0,
        settlementMode: "desktop_local",
      });
    }
    if (action === "sandbox_upload_file") {
      const target = localPath(root, string(args.path));
      const bytes = Buffer.from(string(args.contentsBase64), "base64");
      await fs.mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
      await fs.writeFile(target, bytes, { mode: 0o600 });
      return ok(action, `Uploaded ${relative(root, target)}.`, fileData(target, bytes));
    }
    if (action === "sandbox_list_files") {
      const target = localPath(root, string(args.path));
      const files = await listFiles(root, target, args.recursive !== false);
      return ok(action, files.length ? files.join("\n") : "No files found.", { files });
    }
    if (action === "sandbox_read_file") {
      const target = localPath(root, string(args.path));
      const maxBytes = integer(args.maxBytes, 512_000, 1, 1_000_000);
      const bytes = await fs.readFile(target);
      const bounded = bytes.subarray(0, maxBytes);
      return ok(action, bounded.toString("utf8"), {
        path: relative(root, target),
        contents: bounded.toString("utf8"),
        sizeBytes: bytes.byteLength,
        truncated: bounded.byteLength !== bytes.byteLength,
      });
    }
    if (action === "sandbox_write_file") {
      const target = localPath(root, string(args.path));
      const contents = string(args.content, true);
      await fs.mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
      await fs.writeFile(target, contents, { encoding: "utf8", mode: 0o600 });
      return ok(action, `Wrote ${relative(root, target)}.`, fileData(target, Buffer.from(contents)));
    }
    if (action === "sandbox_edit_file") {
      const target = localPath(root, string(args.path));
      const contents = await fs.readFile(target, "utf8");
      const oldText = string(args.oldText);
      if (!contents.includes(oldText)) {
        return fail(action, "The exact text to replace was not found.");
      }
      const next = args.replaceAll === true
        ? contents.replaceAll(oldText, string(args.newText, true))
        : contents.replace(oldText, string(args.newText, true));
      await fs.writeFile(target, next, { encoding: "utf8", mode: 0o600 });
      return ok(action, `Edited ${relative(root, target)}.`, fileData(target, Buffer.from(next)));
    }
    if (action === "sandbox_delete_file") {
      const target = localPath(root, string(args.path));
      await fs.rm(target, { recursive: args.recursive === true, force: true });
      return ok(action, `Deleted ${relative(root, target)}.`, { path: relative(root, target) });
    }
    if (action === "sandbox_exec") {
      const timeoutSeconds = integer(args.timeoutSeconds, 120, 1, 3_600);
      const command = string(args.command);
      const result = await runCommand(command, root, timeoutSeconds * 1_000);
      return {
        ok: result.code === 0,
        action,
        output: [result.stdout, result.stderr].filter(Boolean).join("\n").trim(),
        data: {
          command,
          cwd: path.join(root, "work"),
          exitCode: result.code,
          stdout: result.stdout,
          stderr: result.stderr,
        },
      };
    }
    if (action === "sandbox_save_output") {
      const source = localPath(root, string(args.path));
      const bytes = await fs.readFile(source);
      if (bytes.byteLength > WORK_OUTPUT_MAX_BYTES) {
        return fail(action, `Work output exceeds ${WORK_OUTPUT_MAX_BYTES.toLocaleString()} bytes.`);
      }
      const title = safeName(
        typeof args.suggestedName === "string" && args.suggestedName.trim()
          ? args.suggestedName
          : path.basename(source),
      );
      const contentType = WORK_OUTPUT_CONTENT_TYPES[path.extname(title).toLowerCase()];
      if (!contentType) return fail(action, `${title} is not a supported Work output format.`);
      const outputDir = path.join(
        input.deps.storeDir,
        "work",
        "outputs",
        safeName(input.session.id),
      );
      await fs.mkdir(outputDir, { recursive: true, mode: 0o700 });
      const destination = path.join(outputDir, `001-${randomUUID()}-${title}`);
      await fs.writeFile(destination, bytes, { mode: 0o600 });
      const outputRef = FileOutputRefSchema.parse({
        kind: "file",
        id: `output-${createHash("sha256").update(destination).digest("hex").slice(0, 24)}`,
        title,
        contentType,
        sizeBytes: bytes.byteLength,
        sha256: createHash("sha256").update(bytes).digest("hex"),
        sourceTaskId: input.session.id,
        sourceTurnId: input.turnId ?? `local-work-${input.session.id}`,
        revision: 1,
        createdAt: new Date().toISOString(),
        location: {
          kind: "local",
          path: destination,
          deviceId: input.deps.deviceId,
        },
        validation: validationEvidence(args.validation),
      });
      return ok(action, `Saved ${title}.`, {
        outputRef,
        artifact: {
          artifactRef: destination,
          path: destination,
          title,
          contentType,
          sizeBytes: bytes.byteLength,
        },
      });
    }
    return fail(action, `Local Taskset Work does not support ${action}.`);
  } catch (error) {
    return fail(action, error instanceof Error ? error.message : String(error));
  }
}

async function ensureLayout(root: string) {
  await Promise.all(["inputs", "work", "outputs"].map((area) =>
    fs.mkdir(path.join(root, area), { recursive: true, mode: 0o700 })
  ));
}

function localPath(root: string, value: string) {
  const normalized = value
    .replaceAll("\\", "/")
    .replace(/^\/+/, "")
    .replace(/^workspace(?:\/|$)/, "");
  const target = path.resolve(root, normalized);
  if (target !== root && !target.startsWith(`${root}${path.sep}`)) {
    throw new Error("Local Work path escaped its isolated workspace.");
  }
  return target;
}

async function listFiles(root: string, target: string, recursive: boolean): Promise<string[]> {
  const stat = await fs.stat(target).catch(() => null);
  if (!stat) return [];
  if (!stat.isDirectory()) return [relative(root, target)];
  const entries = await fs.readdir(target, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    const item = path.join(target, entry.name);
    files.push(relative(root, item));
    if (recursive && entry.isDirectory()) files.push(...await listFiles(root, item, true));
    if (files.length >= 1_000) break;
  }
  return files.slice(0, 1_000);
}

function runCommand(command: string, cwd: string, timeoutMs: number): Promise<{
  code: number;
  stdout: string;
  stderr: string;
}> {
  return new Promise((resolve) => {
    const nodeRuntimeRoot = path.dirname(path.dirname(process.execPath));
    const localPythonRoot = path.join(os.homedir(), ".local", "lib");
    const sandboxArgs = [
      "--tmpfs", "/",
      "--ro-bind", "/usr", "/usr",
      "--ro-bind", "/bin", "/bin",
      "--ro-bind", "/lib", "/lib",
      "--ro-bind", "/lib64", "/lib64",
      "--ro-bind", "/etc", "/etc",
      "--ro-bind", "/var", "/var",
      "--ro-bind", nodeRuntimeRoot, nodeRuntimeRoot,
      ...(existsSync(localPythonRoot)
        ? ["--ro-bind", localPythonRoot, localPythonRoot]
        : []),
      "--proc", "/proc",
      "--dev", "/dev",
      "--tmpfs", "/tmp",
      "--bind", cwd, "/workspace",
      "--chdir", "/workspace/work",
      "--unshare-all",
      "--share-net",
      "--setenv", "HOME", os.homedir(),
      "--setenv", "XDG_CACHE_HOME", "/tmp/cache",
      "--setenv", "MPLCONFIGDIR", "/tmp/matplotlib",
      "/bin/bash", "-lc", command,
    ];
    execFile(
      "/bin/bwrap",
      sandboxArgs,
      { cwd, timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024 },
      (error, stdout, stderr) => resolve({
        code: typeof (error as NodeJS.ErrnoException | null)?.code === "number"
          ? (error as unknown as { code: number }).code
          : error
            ? 1
            : 0,
        stdout: String(stdout ?? ""),
        stderr: String(stderr ?? ""),
      }),
    );
  });
}

function localStatus(root: string, state = "running") {
  return {
    sandbox: {
      id: `desktop-local:${createHash("sha256").update(root).digest("hex").slice(0, 16)}`,
      state,
      provider: "desktop-local",
    },
    workspaceRoot: root,
    executionBacked: true,
  };
}

function fileData(target: string, bytes: Buffer) {
  return {
    path: target,
    sizeBytes: bytes.byteLength,
    sha256: createHash("sha256").update(bytes).digest("hex"),
  };
}

function validationEvidence(value: unknown): OutputValidationEvidence[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => {
    if (!entry || typeof entry !== "object") return [];
    const candidate = entry as Record<string, unknown>;
    const kind = candidate.kind;
    const status = candidate.status;
    const label = candidate.label;
    if (
      !["structural", "visual", "test", "user_review"].includes(String(kind))
      || !["passed", "failed", "not_run"].includes(String(status))
      || typeof label !== "string"
      || !label.trim()
    ) return [];
    return [{
      kind: kind as OutputValidationEvidence["kind"],
      status: status as OutputValidationEvidence["status"],
      label: label.trim(),
      detail: typeof candidate.detail === "string" ? candidate.detail : null,
      ref: typeof candidate.ref === "string" ? candidate.ref : null,
    }];
  }).slice(0, 32);
}

function ok(action: string, output: string, data?: unknown): WorkspaceToolResult {
  return { ok: true, action: action as WorkspaceToolResult["action"], output, data };
}

function fail(action: string, output: string): WorkspaceToolResult {
  return { ok: false, action: action as WorkspaceToolResult["action"], output };
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function string(value: unknown, allowEmpty = false): string {
  if (typeof value !== "string" || (!allowEmpty && !value.trim())) {
    throw new Error("A non-empty string value is required.");
  }
  return value;
}

function integer(value: unknown, fallback: number, minimum: number, maximum: number) {
  return typeof value === "number" && Number.isInteger(value)
    ? Math.min(maximum, Math.max(minimum, value))
    : fallback;
}

function relative(root: string, target: string) {
  return path.relative(root, target).replaceAll(path.sep, "/");
}

function safeName(value: string) {
  return value.replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "output";
}
