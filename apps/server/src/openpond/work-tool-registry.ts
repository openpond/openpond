import { randomUUID } from "node:crypto";
import type {
  OutputRef,
  WorkspaceToolRequest,
  WorkspaceToolResult,
} from "@openpond/contracts";
import {
  CreateHostedSavedWorkRequestSchema,
  WORK_FORMAT_CAPABILITIES,
  type CreateHostedSavedWorkRequest,
} from "@openpond/contracts";
import type {
  ModelToolDefinition,
  ModelToolExecutionContext,
} from "./model-tool-registry.js";
import {
  createWorkRuntimeService,
  WORK_ENVIRONMENT_PROBE,
  WORK_RUNTIME_PROFILE_ID,
  workPath,
  type WorkRuntimeInput,
} from "./work-runtime-service.js";

export { waitForWorkSandboxReady } from "./work-runtime-service.js";

export function createWorkModelToolDefinitions(deps: {
  executeWorkspaceTool: (
    sessionId: string,
    payload: unknown,
    options?: {
      turnId?: string;
      workspaceDiffBaseline?: ModelToolExecutionContext["workspaceDiffBaseline"];
    }
  ) => Promise<WorkspaceToolResult>;
  inputs?: ReadonlyArray<WorkRuntimeInput>;
  automaticLifecycle?: boolean;
  createScheduledWork?: (
    input: CreateHostedSavedWorkRequest
  ) => Promise<Record<string, unknown>>;
}): ModelToolDefinition[] {
  const runtime = createWorkRuntimeService(deps);

  async function execute(
    context: ModelToolExecutionContext,
    action: WorkspaceToolRequest["action"],
    args: Record<string, unknown>,
    toolName: string
  ) {
    const result = await runtime.execute(context, action, args);
    return workspaceToolResult(context.callId, toolName, result);
  }

  async function ensureSandbox(
    context: ModelToolExecutionContext
  ): Promise<void> {
    await runtime.ensureReady(context);
  }

  const withSandbox =
    (
      toolName: string,
      action: WorkspaceToolRequest["action"],
      args: (context: ModelToolExecutionContext) => Record<string, unknown>
    ) =>
    async (context: ModelToolExecutionContext) => {
      const resolvedArgs = args(context);
      await ensureSandbox(context);
      const result = await execute(context, action, resolvedArgs, toolName);
      return result;
    };

  const definitions: ModelToolDefinition[] = [
    ...(deps.createScheduledWork
      ? [
          {
            name: "schedule_work",
            description:
              "Create a durable recurring workflow attached to the current chat when the user directly asks to schedule the current or another task and provides an exact cadence, local date/time, and timezone. Every scheduled run is sent through the attached chat so its output appears in that conversation. Use the conversation context to preserve the task prompt and ask only for genuinely unavailable required scheduling details. The scheduled prompt must describe only the work to perform when the schedule fires, not the scheduling request itself.",
            parameters: savedWorkScheduleParameters(),
            execute: async (context: ModelToolExecutionContext) => {
              const input = CreateHostedSavedWorkRequestSchema.parse({
                ...context.args,
                clientRequestId: `${context.turnId}:${context.callId}`,
                sourceTurnId: context.turnId,
                targetSessionId: context.session.id,
                modelId:
                  context.provider === "openpond"
                    ? context.model
                    : "openpond-chat",
              });
              const data = await deps.createScheduledWork!(input);
              return {
                toolCallId: context.callId,
                name: "schedule_work",
                ok: true,
                contentText: JSON.stringify({
                  ok: true,
                  action: "schedule_work",
                  output: `Created scheduled Work: ${input.name}.`,
                  data,
                }),
                data,
              };
            },
          } satisfies ModelToolDefinition,
        ]
      : []),
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
        const status = await runtime.execute(context, "sandbox_status", {});
        if (!status.ok) {
          return workspaceToolResult(
            context.callId,
            "work_environment",
            status
          );
        }
        const probe = await runtime.execute(context, "sandbox_exec", {
          command: WORK_ENVIRONMENT_PROBE,
          timeoutSeconds: 30,
          autoPreserveSource: false,
        });
        const probeResult = probe;
        return {
          toolCallId: context.callId,
          name: "work_environment",
          ok: status.ok && probeResult.ok,
          contentText: JSON.stringify(
            {
              ok: status.ok && probeResult.ok,
              action: "work_environment",
              output: probeResult.ok
                ? "Work compute is ready. Environment facts were measured live."
                : probeResult.output,
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
                probe: probeResult.data ?? { output: probeResult.output },
                executionBacked: probeResult.ok,
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
            probe: probeResult.data ?? null,
            executionBacked: probeResult.ok,
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
        "Run a bounded shell command from /workspace/work. Write finished deliverables to ../outputs and inspect them; the runtime preserves output files automatically when the turn ends.",
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
        command: `cd /workspace/work && ${requiredString(context.args.command)}`,
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
      name: "work_prepare_agent",
      description:
        "Create a validated OpenPond Agent SDK project in Work scratch space. Use this when the requested deliverable is a new reusable Agent, not for ordinary documents, code snippets, or one-off scripts.",
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: {
          directory: {
            type: "string",
            minLength: 1,
            maxLength: 180,
            description:
              "Relative directory inside Work scratch space for the Agent source.",
          },
          template: {
            type: "string",
            enum: [
              "blank-agent",
              "customer-reply-agent",
              "integration-heavy-agent",
            ],
          },
        },
        required: ["directory", "template"],
      },
      execute: withSandbox(
        "work_prepare_agent",
        "sandbox_prepare_agent",
        (context) => ({
          directory: requiredString(context.args.directory),
          template: requiredString(context.args.template),
        })
      ),
    },
    {
      name: "work_save_agent_package",
      description:
        "Run the OpenPond Agent SDK build, validation, and eval publish gate in the Work sandbox, then save the complete source as an immutable content-addressed Agent-package output. Use this only after finishing and reviewing the Agent source.",
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: {
          directory: {
            type: "string",
            minLength: 1,
            maxLength: 180,
            description:
              "Relative Agent project directory inside Work scratch space.",
          },
          agentId: {
            type: "string",
            minLength: 1,
            maxLength: 191,
          },
          title: {
            type: "string",
            minLength: 1,
            maxLength: 240,
          },
        },
        required: ["directory"],
      },
      execute: withSandbox(
        "work_save_agent_package",
        "sandbox_save_agent_package",
        (context) => ({
          directory: requiredString(context.args.directory),
          agentId: optionalString(context.args.agentId) || undefined,
          title: optionalString(context.args.title) || undefined,
        })
      ),
    },
    {
      name: "work_save_output",
      description:
        "Explicitly copy one completed file from /workspace/outputs to durable OpenPond output storage before turn completion. Normal Work turns preserve output files automatically.",
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
                detail: { type: "string", maxLength: 4_000 },
                ref: { type: "string", maxLength: 4_096 },
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
                detail: { type: "string", maxLength: 4_000 },
                ref: { type: "string", maxLength: 4_096 },
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
        return workspaceToolResult(
          context.callId,
          "work_stop",
          await runtime.stop(context),
        );
      },
    },
  ];
  return deps.automaticLifecycle
    ? definitions.filter(
        (definition) =>
          definition.name !== "work_save_output" &&
          definition.name !== "work_stop"
      )
    : definitions;
}

function savedWorkScheduleParameters(): Record<string, unknown> {
  return {
    type: "object",
    additionalProperties: false,
    properties: {
      name: { type: "string", minLength: 1, maxLength: 180 },
      prompt: { type: "string", minLength: 1, maxLength: 20_000 },
      recurrence: {
        type: "object",
        additionalProperties: false,
        properties: {
          version: { type: "integer", enum: [1] },
          kind: {
            type: "string",
            enum: ["once", "daily", "weekdays", "weekly", "monthly"],
          },
          timeZone: { type: "string", minLength: 1, maxLength: 100 },
          startDate: { type: "string", pattern: "^\\d{4}-\\d{2}-\\d{2}$" },
          localTime: { type: "string", pattern: "^\\d{2}:\\d{2}$" },
          weekdays: {
            type: "array",
            minItems: 1,
            maxItems: 7,
            items: {
              type: "string",
              enum: [
                "sunday",
                "monday",
                "tuesday",
                "wednesday",
                "thursday",
                "friday",
                "saturday",
              ],
            },
          },
          dayOfMonth: { type: "integer", minimum: 1, maximum: 31 },
          end: {
            type: "object",
            additionalProperties: false,
            properties: {
              kind: {
                type: "string",
                enum: ["never", "on_date", "after_occurrences"],
              },
              date: { type: "string", pattern: "^\\d{4}-\\d{2}-\\d{2}$" },
              occurrences: { type: "integer", minimum: 1, maximum: 100_000 },
            },
            required: ["kind"],
          },
        },
        required: [
          "version",
          "kind",
          "timeZone",
          "startDate",
          "localTime",
          "end",
        ],
      },
    },
    required: ["name", "prompt", "recurrence"],
  };
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

function requiredString(value: unknown, allowEmpty = false): string {
  if (typeof value !== "string" || (!allowEmpty && !value.trim())) {
    throw new Error("A required string argument is missing.");
  }
  return allowEmpty ? value : value.trim();
}

function optionalString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function validHttpUrl(value: unknown): string {
  const text = requiredString(value);
  const url = new URL(text);
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("Work output URLs must use HTTP or HTTPS.");
  }
  return url.toString();
}
