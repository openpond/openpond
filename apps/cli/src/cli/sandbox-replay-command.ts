import type { OpenPondSandboxClient } from "../sandbox/client";
import { parseBooleanOption, parseIntegerOption } from "./common";
import {
  buildSandboxReplayInput,
  formatReplayLine,
  summarizeReplayArtifact,
} from "./sandbox-helpers";

export async function handleSandboxReplayCommand(
  client: OpenPondSandboxClient,
  subcommand: string,
  options: Record<string, string | boolean>,
  rest: string[]
): Promise<boolean> {
  if (subcommand === "replays" || subcommand === "replay-list") {
    const teamId =
      typeof options.teamId === "string" ? options.teamId.trim() : "";
    const projectId =
      typeof options.projectId === "string" ? options.projectId.trim() : "";
    const result = await client.listReplays({
      ...(teamId ? { teamId } : {}),
      ...(projectId ? { projectId } : {}),
    });
    if (parseBooleanOption(options.json)) {
      console.log(JSON.stringify(result, null, 2));
      return true;
    }
    if (result.replays.length === 0) {
      console.log("no sandbox replays found");
      return true;
    }
    for (const replay of result.replays) {
      console.log(formatReplayLine(replay));
    }
    return true;
  }

  if (subcommand === "replay-start" || subcommand === "start-replay") {
    const result = await client.startReplay(buildSandboxReplayInput(options));
    console.log(JSON.stringify(result, null, 2));
    return true;
  }

  if (subcommand === "replay-get" || subcommand === "get-replay") {
    const replayId = rest[1];
    if (!replayId) {
      throw new Error("usage: sandbox replay-get <replayId> [--team-id <id>]");
    }
    const teamId =
      typeof options.teamId === "string" ? options.teamId.trim() : "";
    const projectId =
      typeof options.projectId === "string" ? options.projectId.trim() : "";
    const result = await client.getReplay(replayId, {
      ...(teamId ? { teamId } : {}),
      ...(projectId ? { projectId } : {}),
    });
    console.log(JSON.stringify(result, null, 2));
    return true;
  }

  if (subcommand === "replay-logs" || subcommand === "logs-replay") {
    const replayId = rest[1];
    if (!replayId) {
      throw new Error("usage: sandbox replay-logs <replayId> [--team-id <id>]");
    }
    const teamId =
      typeof options.teamId === "string" ? options.teamId.trim() : "";
    const projectId =
      typeof options.projectId === "string" ? options.projectId.trim() : "";
    const result = await client.getReplayLogs(replayId, {
      ...(teamId ? { teamId } : {}),
      ...(projectId ? { projectId } : {}),
    });
    for (const line of result.logs) {
      console.log(line);
    }
    return true;
  }

  if (subcommand === "replay-artifacts" || subcommand === "artifacts-replay") {
    const replayId = rest[1];
    if (!replayId) {
      throw new Error(
        "usage: sandbox replay-artifacts <replayId> [--team-id <id>]"
      );
    }
    const teamId =
      typeof options.teamId === "string" ? options.teamId.trim() : "";
    const projectId =
      typeof options.projectId === "string" ? options.projectId.trim() : "";
    const result = await client.getReplayArtifacts(replayId, {
      ...(teamId ? { teamId } : {}),
      ...(projectId ? { projectId } : {}),
    });
    console.log(
      JSON.stringify(
        {
          replayId: result.replayId,
          artifacts: result.artifacts.map(summarizeReplayArtifact),
        },
        null,
        2
      )
    );
    return true;
  }

  if (subcommand === "replay-cancel" || subcommand === "cancel-replay") {
    const replayId = rest[1];
    if (!replayId) {
      throw new Error(
        "usage: sandbox replay-cancel <replayId> [--team-id <id>]"
      );
    }
    const teamId =
      typeof options.teamId === "string" ? options.teamId.trim() : "";
    const projectId =
      typeof options.projectId === "string" ? options.projectId.trim() : "";
    const result = await client.cancelReplay(replayId, {
      ...(teamId ? { teamId } : {}),
      ...(projectId ? { projectId } : {}),
    });
    console.log(JSON.stringify(result, null, 2));
    return true;
  }

  if (subcommand === "replay-watch" || subcommand === "watch-replay") {
    const replayId = rest[1];
    if (!replayId) {
      throw new Error(
        "usage: sandbox replay-watch <replayId> [--team-id <id>]"
      );
    }
    const teamId =
      typeof options.teamId === "string" ? options.teamId.trim() : "";
    const projectId =
      typeof options.projectId === "string" ? options.projectId.trim() : "";
    const intervalMs =
      parseIntegerOption(options.intervalMs, "interval-ms") ?? 5000;
    const timeoutMs =
      parseIntegerOption(options.timeoutMs, "timeout-ms") ?? 15 * 60 * 1000;
    const startedAt = Date.now();
    const seenLogs = new Set<string>();
    while (Date.now() - startedAt <= timeoutMs) {
      const result = await client.getReplay(replayId, {
        ...(teamId ? { teamId } : {}),
        ...(projectId ? { projectId } : {}),
      });
      for (const line of result.replay.logs) {
        if (!seenLogs.has(line)) {
          seenLogs.add(line);
          console.log(line);
        }
      }
      if (
        result.replay.state === "succeeded" ||
        result.replay.state === "failed" ||
        result.replay.state === "canceled"
      ) {
        console.log(formatReplayLine(result.replay));
        if (result.replay.state !== "succeeded") {
          throw new Error(
            `sandbox replay ${result.replay.state}: ${
              result.replay.error ?? "no error"
            }`
          );
        }
        return true;
      }
      await new Promise((resolve) => setTimeout(resolve, intervalMs));
    }
    throw new Error(`sandbox replay did not finish within ${timeoutMs}ms`);
  }

  return false;
}
