import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import type {
  Session,
  WorkspaceDiffSummary,
  WorkspaceToolRequest,
  WorkspaceToolResult,
} from "@openpond/contracts";

export const WORK_RUNTIME_PROFILE_ID = "openpond-work-v1";
export const WORK_LAYOUT_COMMAND = "mkdir -p inputs work outputs";
export const WORK_RESET_COMMAND =
  "find /workspace/inputs /workspace/work /workspace/outputs -mindepth 1 -maxdepth 1 -exec rm -rf -- {} +";
export const WORK_SANDBOX_STARTUP_TIMEOUT_MS = 180_000;
export const WORK_SANDBOX_STARTUP_POLL_MS = 1_000;
export const WORK_RECEIPT_SETTLEMENT_TIMEOUT_MS = 15_000;
export const WORK_RECEIPT_SETTLEMENT_POLL_MS = 250;
export const WORK_ENVIRONMENT_PROBE = [
  "cd /workspace/work &&",
  'printf "architecture="; uname -m;',
  'printf "kernel="; uname -sr;',
  'printf "cpu_count="; getconf _NPROCESSORS_ONLN 2>/dev/null || true;',
  "printf \"memory_kb=\"; awk '/MemTotal/ {print $2}' /proc/meminfo 2>/dev/null || true;",
  "printf \"workspace_bytes=\"; df -Pk .. 2>/dev/null | awk 'NR==2 {print $4 * 1024}' || true;",
  'printf "tools=";',
  'for tool in python3 pip node npm npx pnpm java gcc g++ make git ffmpeg convert magick pandoc pdftotext pdfinfo pdftoppm curl wget jq rg; do command -v "$tool" >/dev/null 2>&1 && printf "%s " "$tool"; done;',
  "printf '\\n'",
].join(" ");

const TERMINAL_WORK_SANDBOX_STATES = new Set([
  "archived",
  "deleted",
  "error",
]);

export type WorkRuntimeInput = {
  storageName?: string;
  localPath?: string;
  bytes?: Uint8Array;
  sha256?: string;
  sizeBytes?: number;
};

export type WorkRuntimeContext = {
  session: Session;
  turnId?: string;
  workspaceDiffBaseline?: WorkspaceDiffSummary | null;
};

export type WorkRuntimeService = ReturnType<typeof createWorkRuntimeService>;

export function createWorkRuntimeService(deps: {
  executeWorkspaceTool: (
    sessionId: string,
    payload: unknown,
    options?: {
      turnId?: string;
      workspaceDiffBaseline?: WorkspaceDiffSummary | null;
    },
  ) => Promise<WorkspaceToolResult>;
  inputs?: readonly WorkRuntimeInput[];
}) {
  const pendingSandboxBySessionId = new Map<string, Promise<void>>();
  const sandboxReadySessionIds = new Set<string>();

  async function execute(
    context: WorkRuntimeContext,
    action: WorkspaceToolRequest["action"],
    args: Record<string, unknown>,
  ): Promise<WorkspaceToolResult> {
    return deps.executeWorkspaceTool(
      context.session.id,
      { action, args, source: "chat_action" },
      {
        turnId: context.turnId,
        workspaceDiffBaseline: context.workspaceDiffBaseline,
      },
    );
  }

  async function ensureReady(context: WorkRuntimeContext): Promise<void> {
    if (sandboxReadySessionIds.has(context.session.id)) return;
    const current = pendingSandboxBySessionId.get(context.session.id);
    if (current) return current;
    const pending = (async () => {
      const alreadyAttached =
        context.session.workspaceKind === "sandbox"
        && Boolean(context.session.workspaceId);
      let computeAttached = alreadyAttached;
      try {
        if (!alreadyAttached) {
          const result = await execute(context, "sandbox_create", {
            attachToSession: true,
            command: WORK_LAYOUT_COMMAND,
            visibility: "private",
            reuseDefaultRuntime: false,
            markDefaultRuntime: false,
            runtime: {
              runtimeProfileId: WORK_RUNTIME_PROFILE_ID,
              workflowMode: "attempt",
              promotionPolicy: "none",
              metadata: {
                source: "openpond-work",
                experience: "work",
              },
            },
            metadata: {
              source: "openpond-work",
              experience: "work",
            },
          });
          if (!result.ok) throw new Error(result.output);
          computeAttached = true;
        } else {
          const status = await execute(context, "sandbox_status", {});
          if (!status.ok) throw new Error(status.output);
          if (sandboxState(status.data) === "stopped") {
            const started = await execute(context, "sandbox_start", {});
            if (!started.ok) throw new Error(started.output);
          }
        }
        await waitForWorkSandboxReady(() =>
          execute(context, "sandbox_status", {})
        );
        await stageInputs(context);
        sandboxReadySessionIds.add(context.session.id);
      } catch (error) {
        sandboxReadySessionIds.delete(context.session.id);
        if (computeAttached) {
          await execute(context, "sandbox_stop", {}).catch(() => undefined);
        }
        throw error;
      }
    })();
    pendingSandboxBySessionId.set(context.session.id, pending);
    try {
      await pending;
    } finally {
      if (pendingSandboxBySessionId.get(context.session.id) === pending) {
        pendingSandboxBySessionId.delete(context.session.id);
      }
    }
  }

  async function reset(context: WorkRuntimeContext): Promise<void> {
    await ensureReady(context);
    const result = await execute(context, "sandbox_exec", {
      command: WORK_RESET_COMMAND,
      timeoutSeconds: 60,
      autoPreserveSource: false,
    });
    if (!result.ok) throw new Error(result.output);
    await stageInputs(context);
  }

  async function stageInputs(context: WorkRuntimeContext): Promise<void> {
    for (const workInput of deps.inputs ?? []) {
      if (!workInput.storageName) continue;
      const bytes = await workInputBytes(workInput);
      const result = await execute(context, "sandbox_upload_file", {
        path: workPath("inputs", workInput.storageName, ["inputs"]),
        contentsBase64: bytes.toString("base64"),
      });
      if (!result.ok) throw new Error(result.output);
    }
  }

  async function stop(
    context: WorkRuntimeContext,
  ): Promise<WorkspaceToolResult> {
    if (
      !sandboxReadySessionIds.has(context.session.id)
      && (
        context.session.workspaceKind !== "sandbox"
        || !context.session.workspaceId
      )
    ) {
      return {
        ok: true,
        action: "sandbox_stop",
        output: "No Work compute is attached to this task.",
        data: { stopped: false, reason: "not_attached" },
      };
    }
    const result = await execute(context, "sandbox_stop", {});
    if (result.ok) sandboxReadySessionIds.delete(context.session.id);
    return result;
  }

  return {
    ensureReady,
    execute,
    reset,
    stop,
  };
}

async function workInputBytes(input: WorkRuntimeInput): Promise<Buffer> {
  const storageName = input.storageName ?? "unnamed";
  if (!input.localPath && input.bytes === undefined) {
    throw new Error(`Work input ${storageName} has no readable content.`);
  }
  const bytes = input.bytes === undefined
    ? await fs.readFile(input.localPath!)
    : Buffer.from(input.bytes);
  if (
    input.sizeBytes !== undefined
    && bytes.byteLength !== input.sizeBytes
  ) {
    throw new Error(
      `Work input ${input.storageName} size does not match its manifest.`,
    );
  }
  if (
    input.sha256 !== undefined
    && createHash("sha256").update(bytes).digest("hex") !== input.sha256
  ) {
    throw new Error(
      `Work input ${input.storageName} hash does not match its manifest.`,
    );
  }
  return bytes;
}

export function workPath(
  rawArea: unknown,
  rawPath: string,
  allowedAreas: readonly string[] = ["inputs", "work", "outputs"],
): string {
  const area = requiredString(rawArea);
  if (!allowedAreas.includes(area)) {
    throw new Error(`Unknown Work area: ${area}`);
  }
  const value = rawPath.trim().replaceAll("\\", "/");
  if (!value || value === ".") return area;
  if (value.startsWith("/")) {
    throw new Error("Work paths must be relative to their selected area.");
  }
  const normalized = path.posix.normalize(value);
  if (
    normalized === ".."
    || normalized.startsWith("../")
    || normalized.includes("/../")
  ) {
    throw new Error("Work path escaped its selected area.");
  }
  return `${area}/${normalized}`;
}

export async function waitForWorkSandboxReady(
  readStatus: () => Promise<WorkspaceToolResult>,
  options: {
    timeoutMs?: number;
    pollMs?: number;
    now?: () => number;
    sleep?: (milliseconds: number) => Promise<void>;
  } = {},
): Promise<WorkspaceToolResult> {
  const timeoutMs = options.timeoutMs ?? WORK_SANDBOX_STARTUP_TIMEOUT_MS;
  const pollMs = options.pollMs ?? WORK_SANDBOX_STARTUP_POLL_MS;
  const now = options.now ?? Date.now;
  const sleep =
    options.sleep
    ?? ((milliseconds: number) =>
      new Promise<void>((resolve) => setTimeout(resolve, milliseconds)));
  const startedAt = now();
  let lastState = "";

  while (now() - startedAt <= timeoutMs) {
    const status = await readStatus();
    if (!status.ok) throw new Error(status.output);
    lastState = sandboxState(status.data);
    if (lastState === "running") return status;
    if (TERMINAL_WORK_SANDBOX_STATES.has(lastState)) {
      throw new Error(`Work sandbox entered ${lastState} during startup.`);
    }
    await sleep(pollMs);
  }

  throw new Error(
    `Work sandbox did not become ready within ${timeoutMs}ms${
      lastState ? ` (last state: ${lastState})` : ""
    }.`,
  );
}

export async function waitForWorkReceiptSettlement(
  readReceipts: () => Promise<WorkspaceToolResult>,
  options: {
    timeoutMs?: number;
    pollMs?: number;
    now?: () => number;
    sleep?: (milliseconds: number) => Promise<void>;
  } = {},
): Promise<WorkspaceToolResult> {
  const timeoutMs =
    options.timeoutMs ?? WORK_RECEIPT_SETTLEMENT_TIMEOUT_MS;
  const pollMs = options.pollMs ?? WORK_RECEIPT_SETTLEMENT_POLL_MS;
  const now = options.now ?? Date.now;
  const sleep =
    options.sleep
    ?? ((milliseconds: number) =>
      new Promise<void>((resolve) => setTimeout(resolve, milliseconds)));
  const startedAt = now();
  let lastResult: WorkspaceToolResult | null = null;

  while (now() - startedAt <= timeoutMs) {
    lastResult = await readReceipts();
    if (!lastResult.ok || receiptSettlementComplete(lastResult.data)) {
      return lastResult;
    }
    await sleep(pollMs);
  }

  return lastResult ?? readReceipts();
}

function requiredString(value: unknown): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error("A required string argument is missing.");
  }
  return value.trim();
}

function sandboxState(value: unknown): string {
  if (!value || typeof value !== "object" || Array.isArray(value)) return "";
  const sandbox = (value as Record<string, unknown>).sandbox;
  if (!sandbox || typeof sandbox !== "object" || Array.isArray(sandbox)) {
    return "";
  }
  const state = (sandbox as Record<string, unknown>).state;
  return typeof state === "string" ? state : "";
}

function receiptSettlementComplete(value: unknown): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const record = value as Record<string, unknown>;
  const sandbox =
    record.sandbox
    && typeof record.sandbox === "object"
    && !Array.isArray(record.sandbox)
      ? record.sandbox as Record<string, unknown>
      : {};
  const receipts = Array.isArray(record.receipts)
    ? record.receipts
    : Array.isArray(sandbox.receipts)
      ? sandbox.receipts
      : [];
  return receipts.some((receipt) => (
    receipt
    && typeof receipt === "object"
    && !Array.isArray(receipt)
    && (receipt as Record<string, unknown>).status === "captured"
  ));
}
