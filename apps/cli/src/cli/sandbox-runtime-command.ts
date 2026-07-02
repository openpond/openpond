import type { OpenPondSandboxClient } from "../sandbox/client";
import type { SandboxRuntimeStatus } from "../sandbox/types/index";
import { parseJsonObjectOption } from "./common";

export async function handleSandboxRuntimeCommand(
  client: OpenPondSandboxClient,
  subcommand: string,
  options: Record<string, string | boolean>,
  rest: string[]
): Promise<boolean> {
  if (subcommand === "runtime-list") {
    const teamId =
      typeof options.teamId === "string" ? options.teamId.trim() : "";
    const projectId =
      typeof options.projectId === "string" ? options.projectId.trim() : "";
    const agentId =
      typeof options.agentId === "string" ? options.agentId.trim() : "";
    const runtimes = await client.listSandboxRuntimes({
      ...(teamId ? { teamId } : {}),
      ...(projectId ? { projectId } : {}),
      ...(agentId ? { agentId } : {}),
    });
    console.log(JSON.stringify({ runtimes }, null, 2));
    return true;
  }

  if (subcommand === "runtime-get") {
    const runtimeId = rest[1]?.trim();
    if (!runtimeId) {
      throw new Error("usage: sandbox runtime-get <runtimeId>");
    }
    const runtime = await client.getSandboxRuntime(runtimeId);
    console.log(JSON.stringify({ runtime }, null, 2));
    return true;
  }

  if (subcommand === "runtime-events") {
    const runtimeId = rest[1]?.trim();
    if (!runtimeId) {
      throw new Error("usage: sandbox runtime-events <runtimeId>");
    }
    console.log(
      JSON.stringify(await client.listSandboxRuntimeEvents(runtimeId), null, 2)
    );
    return true;
  }

  if (subcommand === "runtime-status") {
    const runtimeId = rest[1]?.trim();
    const status =
      typeof options.status === "string" && options.status.trim()
        ? (options.status.trim() as SandboxRuntimeStatus)
        : "";
    const expectedVersion = Number(options.expectedVersion);
    const summary =
      typeof options.summary === "string" && options.summary.trim()
        ? options.summary.trim()
        : undefined;
    if (!runtimeId || !status || !Number.isInteger(expectedVersion)) {
      throw new Error(
        "usage: sandbox runtime-status <runtimeId> --status <status> --expected-version <n>"
      );
    }
    const runtime = await client.updateSandboxRuntimeStatus(runtimeId, {
      status,
      expectedVersion,
      ...(summary ? { summary } : {}),
    });
    console.log(JSON.stringify({ runtime }, null, 2));
    return true;
  }

  if (subcommand === "runtime-event") {
    const runtimeId = rest[1]?.trim();
    const type =
      typeof options.type === "string" && options.type.trim()
        ? options.type.trim()
        : "";
    const summary =
      typeof options.summary === "string" && options.summary.trim()
        ? options.summary.trim()
        : undefined;
    const payload =
      typeof options.payload === "string" && options.payload.trim()
        ? parseJsonObjectOption(options.payload, "payload")
        : undefined;
    const lifecycleHint =
      typeof options.lifecycleHint === "string" && options.lifecycleHint.trim()
        ? parseJsonObjectOption(options.lifecycleHint, "lifecycle-hint")
        : undefined;
    if (!runtimeId || !type) {
      throw new Error(
        "usage: sandbox runtime-event <runtimeId> --type <eventType> [--summary <text>] [--payload <json>] [--lifecycle-hint <json>]"
      );
    }
    console.log(
      JSON.stringify(
        await client.emitSandboxRuntimeEvent(runtimeId, {
          type,
          ...(summary ? { summary } : {}),
          ...(payload ? { payload } : {}),
          ...(lifecycleHint ? { lifecycleHint } : {}),
        }),
        null,
        2
      )
    );
    return true;
  }

  if (
    subcommand === "runtime-preserve-source" ||
    subcommand === "runtime-preserve"
  ) {
    const runtimeId = rest[1]?.trim();
    const teamId =
      typeof options.teamId === "string" && options.teamId.trim()
        ? options.teamId.trim()
        : "";
    const sandboxId =
      typeof options.sandboxId === "string" && options.sandboxId.trim()
        ? options.sandboxId.trim()
        : "";
    const message =
      typeof options.message === "string" && options.message.trim()
        ? options.message.trim()
        : "";
    if (!runtimeId) {
      throw new Error(
        "usage: sandbox runtime-preserve-source <runtimeId> [--team-id <id>] [--sandbox-id <id>] [--message <text>]"
      );
    }
    console.log(
      JSON.stringify(
        await client.runtimes.preserveSource(
          runtimeId,
          {
            ...(sandboxId ? { sandboxId } : {}),
            ...(message ? { message } : {}),
          },
          {
            ...(teamId ? { teamId } : {}),
          }
        ),
        null,
        2
      )
    );
    return true;
  }

  return false;
}
