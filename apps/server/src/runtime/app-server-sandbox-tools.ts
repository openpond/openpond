import { Buffer } from "node:buffer";

import {
  WorkspaceToolResultSchema,
  type Session,
  type WorkspaceToolRequest,
  type WorkspaceToolResult,
} from "@openpond/contracts";

import type { SandboxRequestAction } from "../openpond/sandboxes.js";

export type AppServerSandboxRequest = (
  action: SandboxRequestAction,
) => Promise<unknown>;

const REMOTE_SANDBOX_ACTIONS = new Set<WorkspaceToolRequest["action"]>([
  "sandbox_create",
  "sandbox_status",
  "sandbox_start",
  "sandbox_list_files",
  "sandbox_read_file",
  "sandbox_search_files",
  "sandbox_upload_file",
  "sandbox_write_file",
  "sandbox_edit_file",
  "sandbox_delete_file",
  "sandbox_mkdir",
  "sandbox_move_file",
  "sandbox_exec",
  "sandbox_open_port",
  "sandbox_snapshot_create",
  "sandbox_stop",
]);

export async function executeAppServerSandboxTool(input: {
  session: Session;
  request: WorkspaceToolRequest;
  sandboxRequest: AppServerSandboxRequest;
  attachSandbox?: (input: {
    sandboxId: string;
    sandbox: Record<string, unknown>;
  }) => Promise<void>;
}): Promise<WorkspaceToolResult | null> {
  if (!REMOTE_SANDBOX_ACTIONS.has(input.request.action)) return null;
  const action = input.request.action;
  if (
    action !== "sandbox_create" &&
    (input.session.workspaceKind !== "sandbox" || !input.session.workspaceId)
  ) {
    throw new Error("The hosted Work task is not attached to a sandbox.");
  }

  const args = input.request.args ?? {};
  const sandboxId = input.session.workspaceId ?? "";
  const requestedSandboxId = optionalString(args.sandboxId);
  if (requestedSandboxId && requestedSandboxId !== sandboxId) {
    throw new Error("Hosted Work cannot target a different sandbox.");
  }

  let data: unknown;
  if (action === "sandbox_create") {
    data = await createRemoteSandbox({
      args,
      session: input.session,
      sandboxRequest: input.sandboxRequest,
    });
    const createdSandbox = asRecord(asRecord(data).sandbox);
    const createdSandboxId = optionalString(createdSandbox.id);
    if (!createdSandboxId) {
      throw new Error("Sandbox create response did not include a sandbox id.");
    }
    await input.attachSandbox?.({
      sandboxId: createdSandboxId,
      sandbox: createdSandbox,
    });
  } else if (action === "sandbox_status") {
    data = await input.sandboxRequest({ type: "get", sandboxId });
  } else if (action === "sandbox_start") {
    data = await input.sandboxRequest({ type: "start", sandboxId });
  } else if (action === "sandbox_list_files") {
    data = await input.sandboxRequest({
      type: "list_files",
      sandboxId,
      payload: {
        path: optionalString(args.path) || ".",
        recursive: args.recursive === true,
        ...(numberValue(args.maxEntries) === null
          ? {}
          : { maxEntries: numberValue(args.maxEntries) }),
      },
    });
  } else if (action === "sandbox_read_file") {
    data = withDecodedFileContent(
      await input.sandboxRequest({
        type: "download_file",
        sandboxId,
        payload: {
          path: requiredString(args.path, "path"),
          maxBytes: numberValue(args.maxBytes) ?? 512 * 1024,
        },
      }),
    );
  } else if (action === "sandbox_search_files") {
    data = await input.sandboxRequest({
      type: "search_files",
      sandboxId,
      payload: {
        query: requiredString(args.query, "query"),
        path: optionalString(args.path) || ".",
        ...(numberValue(args.maxResults) === null
          ? {}
          : { maxResults: numberValue(args.maxResults) }),
      },
    });
  } else if (action === "sandbox_upload_file") {
    data = await input.sandboxRequest({
      type: "upload_file",
      sandboxId,
      payload: {
        path: requiredString(args.path, "path"),
        contentsBase64: requiredString(args.contentsBase64, "contentsBase64"),
      },
    });
  } else if (action === "sandbox_write_file") {
    data = await input.sandboxRequest({
      type: "upload_file",
      sandboxId,
      payload: {
        path: requiredString(args.path, "path"),
        contents: stringValue(args.content),
      },
    });
  } else if (action === "sandbox_edit_file") {
    data = await editRemoteSandboxFile({
      sandboxId,
      args,
      sandboxRequest: input.sandboxRequest,
    });
  } else if (action === "sandbox_delete_file") {
    data = await input.sandboxRequest({
      type: "delete_file",
      sandboxId,
      payload: {
        path: requiredString(args.path, "path"),
        recursive: args.recursive === true,
      },
    });
  } else if (action === "sandbox_mkdir") {
    data = await input.sandboxRequest({
      type: "mkdir",
      sandboxId,
      payload: {
        path: requiredString(args.path, "path"),
        recursive: args.recursive !== false,
      },
    });
  } else if (action === "sandbox_move_file") {
    data = await input.sandboxRequest({
      type: "move_file",
      sandboxId,
      payload: {
        fromPath: requiredString(args.fromPath, "fromPath"),
        toPath: requiredString(args.toPath, "toPath"),
        overwrite: args.overwrite === true,
      },
    });
  } else if (action === "sandbox_exec") {
    data = await input.sandboxRequest({
      type: "exec",
      sandboxId,
      payload: {
        command: requiredString(args.command, "command"),
        timeoutSeconds: numberValue(args.timeoutSeconds) ?? 120,
      },
    });
  } else if (action === "sandbox_open_port") {
    data = await input.sandboxRequest({
      type: "open_port",
      sandboxId,
      payload: {
        port: requiredNumber(args.port, "port"),
        label: optionalString(args.label) || "Work preview",
        access: "private",
        autoStart: true,
      },
    });
  } else if (action === "sandbox_snapshot_create") {
    data = await input.sandboxRequest({
      type: "snapshot_create",
      sandboxId,
      payload: { name: requiredString(args.name, "name") },
    });
  } else {
    data = await input.sandboxRequest({
      type: "stop",
      sandboxId,
      failOnUnpreservedChanges: false,
    });
  }

  return WorkspaceToolResultSchema.parse({
    ok: true,
    action,
    output:
      action === "sandbox_create"
        ? `Active sandbox workspace: ${optionalString(asRecord(asRecord(data).sandbox).id)}`
        : `${action} completed in the attached Work sandbox.`,
    data,
  });
}

async function createRemoteSandbox(input: {
  args: Record<string, unknown>;
  session: Session;
  sandboxRequest: AppServerSandboxRequest;
}): Promise<Record<string, unknown>> {
  const requestedRuntime = asRecord(input.args.runtime);
  const requestedRuntimeId = optionalString(requestedRuntime.runtimeId);
  const teamId =
    optionalString(input.args.teamId) || optionalString(input.session.cloudTeamId);
  const projectId =
    optionalString(input.args.projectId) ||
    optionalString(input.session.cloudProjectId);
  const agentId = optionalString(input.args.agentId);
  const workflowMode =
    optionalString(input.args.workflowMode) ||
    optionalString(requestedRuntime.workflowMode) ||
    (projectId || agentId ? "feature" : "attempt");
  const promotionPolicy =
    optionalString(input.args.runtimePromotionPolicy) ||
    optionalString(requestedRuntime.promotionPolicy) ||
    (projectId || agentId ? "manual" : "none");
  const runtimeCreate = { ...requestedRuntime };
  delete runtimeCreate.runtimeId;

  let runtimePayload: Record<string, unknown> = {};
  let runtimeId = requestedRuntimeId;
  if (!runtimeId) {
    runtimePayload = asRecord(
      await input.sandboxRequest({
        type: "sandbox_runtime_create",
        payload: {
          ...runtimeCreate,
          ...(teamId ? { teamId } : {}),
          ...(projectId ? { projectId } : {}),
          ...(agentId ? { agentId } : {}),
          workflowMode,
          promotionPolicy,
          metadata: {
            source: "openpond-app-server-work",
            ...asRecord(requestedRuntime.metadata),
          },
        },
      }),
    );
    runtimeId = optionalString(asRecord(runtimePayload.runtime).id);
    if (!runtimeId) {
      throw new Error("Sandbox runtime create response did not include a runtime id.");
    }
  }

  const sandboxPayload = asRecord(
    await input.sandboxRequest(
      requestedRuntimeId
        ? {
            type: "sandbox_runtime_resume",
            runtimeId,
            payload: remoteSandboxCreatePayload(input.args, {
              teamId,
              projectId,
              agentId,
            }),
          }
        : {
            type: "sandbox_runtime_sandbox_create",
            runtimeId,
            payload: remoteSandboxCreatePayload(input.args, {
              teamId,
              projectId,
              agentId,
            }),
          },
    ),
  );
  return {
    ...runtimePayload,
    ...sandboxPayload,
    runtime: sandboxPayload.runtime ?? runtimePayload.runtime,
  };
}

function remoteSandboxCreatePayload(
  args: Record<string, unknown>,
  scope: { teamId: string; projectId: string; agentId: string },
): Record<string, unknown> {
  return {
    ...(scope.teamId ? { teamId: scope.teamId } : {}),
    ...(scope.projectId ? { projectId: scope.projectId } : {}),
    ...(scope.agentId ? { agentId: scope.agentId } : {}),
    ...(optionalString(args.repo) ? { repo: optionalString(args.repo) } : {}),
    ...(optionalString(args.command)
      ? { command: optionalString(args.command) }
      : {}),
    visibility: optionalString(args.visibility) || "private",
    resources: asRecord(args.resources),
    budget: asRecord(args.budget),
    quotas: asRecord(args.quotas),
    networkPolicy: asRecord(args.networkPolicy),
    ...(Array.isArray(args.volumes) ? { volumes: args.volumes } : {}),
    metadata: {
      source: "openpond-app-server-work",
      ...asRecord(args.metadata),
    },
  };
}

async function editRemoteSandboxFile(input: {
  sandboxId: string;
  args: Record<string, unknown>;
  sandboxRequest: AppServerSandboxRequest;
}): Promise<unknown> {
  const path = requiredString(input.args.path, "path");
  const oldText = requiredString(input.args.oldText, "oldText");
  const newText = stringValue(input.args.newText);
  const downloaded = asRecord(
    await input.sandboxRequest({
      type: "download_file",
      sandboxId: input.sandboxId,
      payload: { path, maxBytes: 1024 * 1024 },
    }),
  );
  const file = asRecord(downloaded.file);
  const content =
    optionalString(downloaded.contents) ||
    optionalString(downloaded.content) ||
    optionalString(file.contents) ||
    optionalString(file.content) ||
    decodeBase64(optionalString(file.contentsBase64));
  if (!content.includes(oldText)) {
    throw new Error(`Text to replace was not found in ${path}.`);
  }
  if (input.args.replaceAll !== true && content.indexOf(oldText) !== content.lastIndexOf(oldText)) {
    throw new Error(`Text to replace is not unique in ${path}.`);
  }
  const nextContent =
    input.args.replaceAll === true
      ? content.split(oldText).join(newText)
      : content.replace(oldText, newText);
  return input.sandboxRequest({
    type: "upload_file",
    sandboxId: input.sandboxId,
    payload: { path, contents: nextContent },
  });
}

function withDecodedFileContent(value: unknown): unknown {
  const result = asRecord(value);
  const file = asRecord(result.file);
  const contentsBase64 = optionalString(file.contentsBase64);
  if (!contentsBase64) return value;
  return {
    ...result,
    file: {
      ...file,
      content: decodeBase64(contentsBase64),
    },
  };
}

function decodeBase64(value: string): string {
  if (!value) return "";
  return Buffer.from(value, "base64").toString("utf8");
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function optionalString(value: unknown): string {
  return stringValue(value).trim();
}

function requiredString(value: unknown, name: string): string {
  const result = stringValue(value);
  if (!result.trim()) throw new Error(`${name} is required.`);
  return result;
}

function numberValue(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function requiredNumber(value: unknown, name: string): number {
  const result = numberValue(value);
  if (result === null) throw new Error(`${name} is required.`);
  return result;
}
