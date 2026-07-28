import path from "node:path";
import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import type {
  OutputRef,
  WorkspaceToolRequest,
  WorkspaceToolResult,
} from "@openpond/contracts";
import { WORK_FORMAT_CAPABILITIES } from "@openpond/contracts";
import type {
  ModelToolDefinition,
  ModelToolExecutionContext,
} from "./model-tool-registry.js";

const WORK_RUNTIME_PROFILE_ID = "openpond-work-v1";
const WORK_LAYOUT_COMMAND = "mkdir -p inputs work outputs";
const WORK_ENVIRONMENT_PROBE = [
  "cd work &&",
  'printf "architecture="; uname -m;',
  'printf "kernel="; uname -sr;',
  'printf "cpu_count="; getconf _NPROCESSORS_ONLN 2>/dev/null || true;',
  "printf \"memory_kb=\"; awk '/MemTotal/ {print $2}' /proc/meminfo 2>/dev/null || true;",
  "printf \"workspace_bytes=\"; df -Pk .. 2>/dev/null | awk 'NR==2 {print $4 * 1024}' || true;",
  'printf "tools=";',
  'for tool in python3 pip node npm npx pnpm java gcc g++ make git ffmpeg convert magick pandoc pdftotext pdfinfo pdftoppm curl wget jq rg; do command -v "$tool" >/dev/null 2>&1 && printf "%s " "$tool"; done;',
  "printf '\\n'",
].join(" ");

export function createWorkModelToolDefinitions(deps: {
  executeWorkspaceTool: (
    sessionId: string,
    payload: unknown,
    options?: {
      turnId?: string;
      workspaceDiffBaseline?: ModelToolExecutionContext["workspaceDiffBaseline"];
    }
  ) => Promise<WorkspaceToolResult>;
  inputs?: ReadonlyArray<{
    localPath?: string;
    storageName?: string;
  }>;
}): ModelToolDefinition[] {
  const pendingSandboxBySessionId = new Map<string, Promise<void>>();
  const sandboxReadySessionIds = new Set<string>();

  async function execute(
    context: ModelToolExecutionContext,
    action: WorkspaceToolRequest["action"],
    args: Record<string, unknown>,
    toolName: string
  ) {
    const result = await deps.executeWorkspaceTool(
      context.session.id,
      { action, args, source: "chat_action" },
      {
        turnId: context.turnId,
        workspaceDiffBaseline: context.workspaceDiffBaseline,
      }
    );
    return workspaceToolResult(context.callId, toolName, result);
  }

  async function ensureSandbox(
    context: ModelToolExecutionContext
  ): Promise<void> {
    if (sandboxReadySessionIds.has(context.session.id)) return;
    const alreadyAttached =
      context.session.workspaceKind === "sandbox" &&
      Boolean(context.session.workspaceId);
    const current = pendingSandboxBySessionId.get(context.session.id);
    if (current) return current;
    const pending = (async () => {
      if (!alreadyAttached) {
        const result = await deps.executeWorkspaceTool(
          context.session.id,
          {
            action: "sandbox_create",
            source: "chat_action",
            args: {
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
            },
          },
          {
            turnId: context.turnId,
            workspaceDiffBaseline: context.workspaceDiffBaseline,
          }
        );
        if (!result.ok) throw new Error(result.output);
      } else {
        const status = await deps.executeWorkspaceTool(
          context.session.id,
          {
            action: "sandbox_status",
            source: "chat_action",
            args: {},
          },
          {
            turnId: context.turnId,
            workspaceDiffBaseline: context.workspaceDiffBaseline,
          }
        );
        if (!status.ok) throw new Error(status.output);
        if (sandboxState(status.data) === "stopped") {
          const started = await deps.executeWorkspaceTool(
            context.session.id,
            {
              action: "sandbox_start",
              source: "chat_action",
              args: {},
            },
            {
              turnId: context.turnId,
              workspaceDiffBaseline: context.workspaceDiffBaseline,
            }
          );
          if (!started.ok) throw new Error(started.output);
        }
      }
      for (const input of deps.inputs ?? []) {
        if (!input.localPath || !input.storageName) continue;
        const bytes = await fs.readFile(input.localPath);
        const result = await deps.executeWorkspaceTool(
          context.session.id,
          {
            action: "sandbox_upload_file",
            source: "chat_action",
            args: {
              path: workPath("inputs", input.storageName, ["inputs"]),
              contentsBase64: bytes.toString("base64"),
            },
          },
          {
            turnId: context.turnId,
            workspaceDiffBaseline: context.workspaceDiffBaseline,
          }
        );
        if (!result.ok) throw new Error(result.output);
      }
      sandboxReadySessionIds.add(context.session.id);
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

  const withSandbox =
    (
      toolName: string,
      action: WorkspaceToolRequest["action"],
      args: (context: ModelToolExecutionContext) => Record<string, unknown>
    ) =>
    async (context: ModelToolExecutionContext) => {
      await ensureSandbox(context);
      const result = await execute(context, action, args(context), toolName);
      if (action === "sandbox_stop" && result.ok) {
        sandboxReadySessionIds.delete(context.session.id);
      }
      return result;
    };

  return [
    {
      name: "work_capabilities",
      description:
        "Return the truthful Work output, preview, validation, and destination matrix without starting sandbox compute.",
      parameters: emptyObjectParameters(),
      execute: async (context) => ({
        toolCallId: context.callId,
        name: "work_capabilities",
        ok: true,
        contentText: JSON.stringify(
          {
            ok: true,
            action: "work_capabilities",
            output:
              "Returned the supported Work formats and durable destinations. Sandbox compute was not started.",
            data: {
              compute: "lazy",
              formats: WORK_FORMAT_CAPABILITIES,
              destinations: [
                "managed_local_file",
                "approved_connected_resource",
                "deployment_url",
              ],
              constraints: {
                maxLocalOutputBytes: 10_000_000,
                repositoryChangesRequireDevelopment: true,
                browserAndLocalAppControl: {
                  location: "host",
                  requiresTurnPermission: true,
                  guestCredentials: false,
                },
              },
            },
          },
          null,
          2
        ),
        data: {
          compute: "lazy",
          formats: WORK_FORMAT_CAPABILITIES,
          destinations: [
            "managed_local_file",
            "approved_connected_resource",
            "deployment_url",
          ],
        },
      }),
    },
    {
      name: "work_environment",
      description:
        "Start Work compute only when it is needed, then return live sandbox status and the stable /workspace/inputs, /workspace/work, and /workspace/outputs layout.",
      parameters: emptyObjectParameters(),
      execute: async (context) => {
        await ensureSandbox(context);
        const status = await deps.executeWorkspaceTool(
          context.session.id,
          {
            action: "sandbox_status",
            source: "chat_action",
            args: {},
          },
          {
            turnId: context.turnId,
            workspaceDiffBaseline: context.workspaceDiffBaseline,
          }
        );
        if (!status.ok) {
          return workspaceToolResult(
            context.callId,
            "work_environment",
            status
          );
        }
        const probe = await deps.executeWorkspaceTool(
          context.session.id,
          {
            action: "sandbox_exec",
            source: "chat_action",
            args: {
              command: WORK_ENVIRONMENT_PROBE,
              timeoutSeconds: 30,
              autoPreserveSource: false,
            },
          },
          {
            turnId: context.turnId,
            workspaceDiffBaseline: context.workspaceDiffBaseline,
          }
        );
        return {
          toolCallId: context.callId,
          name: "work_environment",
          ok: status.ok && probe.ok,
          contentText: JSON.stringify(
            {
              ok: status.ok && probe.ok,
              action: "work_environment",
              output: probe.ok
                ? "Work compute is ready. Environment facts were measured live."
                : probe.output,
              data: {
                runtimeProfileId: WORK_RUNTIME_PROFILE_ID,
                workspaceRoot: "/workspace",
                cwd: "/workspace/work",
                layout: {
                  inputs: "/workspace/inputs",
                  work: "/workspace/work",
                  outputs: "/workspace/outputs",
                },
                status: status.data ?? null,
                probe: probe.data ?? { output: probe.output },
              },
            },
            null,
            2
          ),
          data: {
            runtimeProfileId: WORK_RUNTIME_PROFILE_ID,
            workspaceRoot: "/workspace",
            cwd: "/workspace/work",
            status: status.data ?? null,
            probe: probe.data ?? null,
          },
        };
      },
    },
    {
      name: "work_list_files",
      description:
        "List files in the Work scratch, input, or completed-output area. This lazily starts Work compute.",
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: {
          area: workAreaProperty(),
          path: {
            type: "string",
            description: "Optional relative path inside the selected area.",
          },
          recursive: { type: "boolean" },
        },
        required: ["area"],
      },
      execute: withSandbox(
        "work_list_files",
        "sandbox_list_files",
        (context) => ({
          path: workPath(context.args.area, optionalString(context.args.path)),
          recursive:
            typeof context.args.recursive === "boolean"
              ? context.args.recursive
              : true,
        })
      ),
    },
    {
      name: "work_read_file",
      description:
        "Read a bounded file from Work inputs, scratch space, or completed-output candidates.",
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: {
          area: workAreaProperty(),
          path: { type: "string", minLength: 1 },
          maxBytes: {
            type: "integer",
            minimum: 1,
            maximum: 1_000_000,
          },
        },
        required: ["area", "path"],
      },
      execute: withSandbox(
        "work_read_file",
        "sandbox_read_file",
        (context) => ({
          path: workPath(context.args.area, requiredString(context.args.path)),
          maxBytes:
            typeof context.args.maxBytes === "number"
              ? Math.min(
                  Math.max(Math.floor(context.args.maxBytes), 1),
                  1_000_000
                )
              : 512_000,
        })
      ),
    },
    {
      name: "work_write_file",
      description:
        "Write a UTF-8 Work scratch file or completed-output candidate. Use area=outputs only for a finished result that is ready to validate and save.",
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: {
          area: {
            type: "string",
            enum: ["work", "outputs"],
          },
          path: { type: "string", minLength: 1 },
          content: { type: "string" },
        },
        required: ["area", "path", "content"],
      },
      execute: withSandbox(
        "work_write_file",
        "sandbox_write_file",
        (context) => ({
          path: workPath(context.args.area, requiredString(context.args.path), [
            "work",
            "outputs",
          ]),
          content: requiredString(context.args.content, true),
          autoPreserveSource: false,
        })
      ),
    },
    {
      name: "work_edit_file",
      description:
        "Edit a Work scratch file or output candidate by exact text replacement after reading it.",
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: {
          area: {
            type: "string",
            enum: ["work", "outputs"],
          },
          path: { type: "string", minLength: 1 },
          oldText: { type: "string", minLength: 1 },
          newText: { type: "string" },
          replaceAll: { type: "boolean" },
        },
        required: ["area", "path", "oldText", "newText"],
      },
      execute: withSandbox(
        "work_edit_file",
        "sandbox_edit_file",
        (context) => ({
          path: workPath(context.args.area, requiredString(context.args.path), [
            "work",
            "outputs",
          ]),
          oldText: requiredString(context.args.oldText),
          newText: requiredString(context.args.newText, true),
          replaceAll: context.args.replaceAll === true,
          autoPreserveSource: false,
        })
      ),
    },
    {
      name: "work_delete_file",
      description:
        "Delete a Work scratch file or an output candidate. Saved outputs outside the sandbox are unaffected.",
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: {
          area: {
            type: "string",
            enum: ["work", "outputs"],
          },
          path: { type: "string", minLength: 1 },
          recursive: { type: "boolean" },
        },
        required: ["area", "path"],
      },
      execute: withSandbox(
        "work_delete_file",
        "sandbox_delete_file",
        (context) => ({
          path: workPath(context.args.area, requiredString(context.args.path), [
            "work",
            "outputs",
          ]),
          recursive: context.args.recursive === true,
          autoPreserveSource: false,
        })
      ),
    },
    {
      name: "work_exec",
      description:
        "Run a bounded shell command from /workspace/work. Write finished deliverables to ../outputs, inspect them, then call work_save_output.",
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: {
          command: { type: "string", minLength: 1 },
          timeoutSeconds: {
            type: "integer",
            minimum: 1,
            maximum: 3_600,
          },
        },
        required: ["command"],
      },
      execute: withSandbox("work_exec", "sandbox_exec", (context) => ({
        command: `cd work && ${requiredString(context.args.command)}`,
        timeoutSeconds:
          typeof context.args.timeoutSeconds === "number"
            ? Math.min(
                Math.max(Math.floor(context.args.timeoutSeconds), 1),
                3_600
              )
            : 120,
        autoPreserveSource: false,
      })),
    },
    {
      name: "work_open_port",
      description:
        "Open a bounded Work sandbox port for a temporary preview. This is not a production deployment.",
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: {
          port: { type: "integer", minimum: 1, maximum: 65_535 },
          label: { type: "string" },
        },
        required: ["port"],
      },
      execute: withSandbox(
        "work_open_port",
        "sandbox_open_port",
        (context) => ({
          port: context.args.port,
          label: optionalString(context.args.label) || "Work preview",
          access: "private",
          autoStart: true,
        })
      ),
    },
    {
      name: "work_checkpoint",
      description:
        "Create a resumable checkpoint of the current Work sandbox before a substantial revision.",
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: {
          name: { type: "string", minLength: 1, maxLength: 120 },
        },
        required: ["name"],
      },
      execute: withSandbox(
        "work_checkpoint",
        "sandbox_snapshot_create",
        (context) => ({
          name: requiredString(context.args.name),
        })
      ),
    },
    {
      name: "work_save_output",
      description:
        "Copy one completed file from /workspace/outputs to durable OpenPond output storage and return its OutputRef. Use only after inspecting or validating the file.",
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: {
          path: {
            type: "string",
            minLength: 1,
            description:
              "Path relative to /workspace/outputs, for example report.md.",
          },
          suggestedName: {
            type: "string",
            minLength: 1,
            maxLength: 180,
          },
          validation: {
            type: "array",
            maxItems: 32,
            items: {
              type: "object",
              additionalProperties: false,
              properties: {
                kind: {
                  type: "string",
                  enum: ["structural", "visual", "test", "user_review"],
                },
                status: {
                  type: "string",
                  enum: ["passed", "failed", "not_run"],
                },
                label: { type: "string", minLength: 1, maxLength: 240 },
                detail: { type: ["string", "null"], maxLength: 4_000 },
                ref: { type: ["string", "null"], maxLength: 4_096 },
              },
              required: ["kind", "status", "label"],
            },
          },
        },
        required: ["path"],
      },
      execute: withSandbox(
        "work_save_output",
        "sandbox_save_output",
        (context) => ({
          path: workPath("outputs", requiredString(context.args.path), [
            "outputs",
          ]),
          suggestedName:
            optionalString(context.args.suggestedName) || undefined,
          validation: Array.isArray(context.args.validation)
            ? context.args.validation
            : [],
        })
      ),
    },
    {
      name: "work_register_external_output",
      description:
        "Register a completed result that already lives in an approved connected service or at a production deployment URL. Use only after the provider write or deployment succeeded and returned a stable resource id or URL.",
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: {
          kind: {
            type: "string",
            enum: ["external_file", "deployment"],
          },
          title: { type: "string", minLength: 1, maxLength: 240 },
          provider: { type: "string", minLength: 1, maxLength: 120 },
          resourceId: { type: "string", minLength: 1, maxLength: 500 },
          url: { type: "string", minLength: 1, maxLength: 4_096 },
          contentType: { type: "string", minLength: 1, maxLength: 200 },
          validation: {
            type: "array",
            maxItems: 32,
            items: {
              type: "object",
              additionalProperties: false,
              properties: {
                kind: {
                  type: "string",
                  enum: ["structural", "visual", "test", "user_review"],
                },
                status: {
                  type: "string",
                  enum: ["passed", "failed", "not_run"],
                },
                label: { type: "string", minLength: 1, maxLength: 240 },
                detail: { type: ["string", "null"], maxLength: 4_000 },
                ref: { type: ["string", "null"], maxLength: 4_096 },
              },
              required: ["kind", "status", "label"],
            },
          },
        },
        required: ["kind", "title", "resourceId", "url"],
      },
      execute: async (context) => {
        const kind = requiredString(context.args.kind);
        const title = requiredString(context.args.title);
        const resourceId = requiredString(context.args.resourceId);
        const url = validHttpUrl(context.args.url);
        const validation = Array.isArray(context.args.validation)
          ? context.args.validation
          : [];
        const identity = {
          id: randomUUID(),
          title,
          sourceTaskId: context.session.id,
          sourceTurnId: context.turnId,
          revision: 1,
          createdAt: new Date().toISOString(),
          validation,
        };
        const outputRef: OutputRef =
          kind === "deployment"
            ? {
                ...identity,
                kind: "deployment",
                deploymentId: resourceId,
                url,
              }
            : {
                ...identity,
                kind: "external_resource",
                provider: optionalString(context.args.provider) || "external",
                resourceId,
                url,
                contentType: optionalString(context.args.contentType) || null,
              };
        return {
          toolCallId: context.callId,
          name: "work_register_external_output",
          ok: true,
          contentText: JSON.stringify(
            {
              ok: true,
              action: "work_register_external_output",
              output: `Registered ${title} as a Work output.`,
              data: { outputRef },
            },
            null,
            2
          ),
          data: { outputRef },
        };
      },
    },
    {
      name: "work_stop",
      description:
        "Stop Work compute after durable outputs have been saved. Saved OutputRefs remain available.",
      parameters: emptyObjectParameters(),
      execute: async (context) => {
        if (
          context.session.workspaceKind !== "sandbox" ||
          !context.session.workspaceId
        ) {
          return workspaceToolResult(context.callId, "work_stop", {
            ok: true,
            action: "sandbox_stop",
            output: "No Work compute is attached to this task.",
            data: { stopped: false, reason: "not_attached" },
          });
        }
        const result = await execute(context, "sandbox_stop", {}, "work_stop");
        if (result.ok) sandboxReadySessionIds.delete(context.session.id);
        return result;
      },
    },
  ];
}

function workspaceToolResult(
  callId: string,
  toolName: string,
  result: WorkspaceToolResult
) {
  return {
    toolCallId: callId,
    name: toolName,
    ok: result.ok,
    contentText: JSON.stringify(result, null, 2),
    data: result.data,
  };
}

function emptyObjectParameters() {
  return {
    type: "object",
    additionalProperties: false,
    properties: {},
  };
}

function workAreaProperty() {
  return {
    type: "string",
    enum: ["inputs", "work", "outputs"],
  };
}

function workPath(
  rawArea: unknown,
  rawPath: string,
  allowedAreas: readonly string[] = ["inputs", "work", "outputs"]
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
    normalized === ".." ||
    normalized.startsWith("../") ||
    normalized.includes("/../")
  ) {
    throw new Error("Work path escaped its selected area.");
  }
  return `${area}/${normalized}`;
}

function requiredString(value: unknown, allowEmpty = false): string {
  if (typeof value !== "string" || (!allowEmpty && !value.trim())) {
    throw new Error("A required string argument is missing.");
  }
  return allowEmpty ? value : value.trim();
}

function optionalString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
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

function validHttpUrl(value: unknown): string {
  const text = requiredString(value);
  const url = new URL(text);
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("Work output URLs must use HTTP or HTTPS.");
  }
  return url.toString();
}
