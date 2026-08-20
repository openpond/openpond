import { describe, expect, test } from "vitest";
import type { RuntimeEvent } from "@openpond/contracts";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MessageRow } from "../apps/web/src/components/chat/Messages";
import { activityToolRowLabel } from "../apps/web/src/components/chat/MessageActivityGroup";
import {
  activityGroupSummary,
  buildChatMessages,
} from "../apps/web/src/lib/chat-messages";

function runtimeEvent(input: Omit<RuntimeEvent, "timestamp">): RuntimeEvent {
  return {
    timestamp: "2026-05-16T00:00:00.000Z",
    ...input,
  };
}

function commandStarted(
  id: string,
  turnId: string,
  command: string,
): RuntimeEvent {
  return runtimeEvent({
    id,
    name: "tool.started",
    turnId,
    action: "exec_command",
    status: "started",
    data: {
      callId: id,
      command,
    },
  });
}

describe("chat command activity projection", () => {
  test("merges Codex command lifecycle into one compact activity", () => {
    const rawOutput = [
      "Chunk ID: 6088d8",
      "Wall time: 0.7318 seconds",
      "Process exited with code 0",
      "Original token count: 19",
      "Output:",
      "To github.com:openpond/sandbox.git",
      "   0b0d5ad..38dc899  develop -> develop",
    ].join("\n");
    const messages = buildChatMessages([
      runtimeEvent({
        id: "turn_1",
        name: "turn.started",
        turnId: "turn_1",
        args: { prompt: "Push develop" },
      }),
      runtimeEvent({
        id: "tool_started",
        name: "tool.started",
        turnId: "turn_1",
        action: "exec_command",
        status: "started",
        data: {
          callId: "call_1",
          command: "git push origin develop",
        },
      }),
      runtimeEvent({
        id: "tool_completed",
        name: "tool.completed",
        turnId: "turn_1",
        action: "function_call_output",
        status: "completed",
        output: rawOutput,
        data: {
          callId: "call_1",
        },
      }),
      runtimeEvent({
        id: "command_output",
        name: "command.output",
        turnId: "turn_1",
        output: rawOutput,
        data: {
          callId: "call_1",
        },
      }),
    ]);

    const activities = messages[1]?.activities ?? [];
    expect(activities).toHaveLength(1);
    expect(activities[0]?.label).toBe("Ran");
    expect(activities[0]?.content).toBe("git push origin develop");
    expect(activities[0]?.detail).toBe(
      "To github.com:openpond/sandbox.git\n   0b0d5ad..38dc899  develop -> develop"
    );
    expect(activityGroupSummary(activities)).toBe("Pushed changes");
  });

  test("keeps failed exec details collapsed without transport JSON", () => {
    const result = JSON.stringify({
      ok: false,
      action: "exec_command",
      output: "Command exited with code 1.",
      data: {
        command: "./cli promote production",
        cwd: "/repo",
        exitCode: 1,
        stdout: "Fetching origin/develop\nPromotion refused",
        stderr: "",
      },
    });
    const messages = buildChatMessages([
      runtimeEvent({
        id: "turn_1",
        name: "turn.started",
        turnId: "turn_1",
        args: { prompt: "Promote production" },
      }),
      runtimeEvent({
        id: "tool_started",
        name: "tool.started",
        turnId: "turn_1",
        action: "exec_command",
        status: "started",
        data: {
          toolCallId: "call_1",
          tool: "exec_command",
          arguments: JSON.stringify({ cmd: "./cli promote production" }),
        },
      }),
      {
        ...runtimeEvent({
          id: "tool_completed",
          name: "tool.completed",
          turnId: "turn_1",
          action: "exec_command",
          status: "failed",
          output: result,
          data: {
            toolCallId: "call_1",
            tool: "exec_command",
          },
        }),
        timestamp: "2026-05-16T00:00:01.000Z",
      },
    ]);

    const activity = messages[1]?.activities?.[0];
    expect(activity).toMatchObject({
      content: "./cli promote production",
      detail: "Fetching origin/develop\nPromotion refused",
      state: "failed",
      terminal: { exitCode: 1, durationMs: 1000 },
    });

    const html = renderToStaticMarkup(
      createElement(MessageRow, { message: messages[1]! })
    );
    expect(html).toContain("Command failed");
    expect(html).toContain('aria-expanded="false"');
    expect(html).not.toContain("Ran command in 1s");
    expect(html).not.toContain("activity-command-terminal");
    expect(html).not.toContain("Fetching origin/develop");
    expect(html).not.toContain("&quot;action&quot;:&quot;exec_command&quot;");
  });

  test("unwraps sandbox command failure envelopes without inventing an exit code", () => {
    const messages = buildChatMessages([
      runtimeEvent({
        id: "turn_1",
        name: "turn.started",
        turnId: "turn_1",
        args: { prompt: "Run a sandbox command" },
      }),
      commandStarted("tool_started", "turn_1", "printf 'hello'"),
      runtimeEvent({
        id: "command_output",
        name: "command.output",
        turnId: "turn_1",
        status: "failed",
        output: JSON.stringify({
          ok: false,
          action: "work_environment",
          output: "Work sandbox entered error during startup.",
        }),
        data: { toolCallId: "tool_started" },
      }),
    ]);

    const activity = messages[1]?.activities?.[0];
    expect(activity?.detail).toBe("Work sandbox entered error during startup.");
    const html = renderToStaticMarkup(
      createElement(MessageRow, { message: messages[1]! })
    );
    expect(html).not.toContain("Work sandbox entered error during startup.");
    expect(html).not.toContain("activity-command-terminal");
    expect(html).not.toContain("&quot;action&quot;:&quot;work_environment&quot;");
  });

  test("summarizes one command by activity instead of raw command text", () => {
    const messages = buildChatMessages([
      runtimeEvent({
        id: "turn_1",
        name: "turn.started",
        turnId: "turn_1",
        args: { prompt: "Search the app" },
      }),
      commandStarted(
        "search_1",
        "turn_1",
        'rg "activityGroupSummary" apps/web/src'
      ),
    ]);

    const activities = messages[1]?.activities ?? [];
    expect(activityGroupSummary(activities)).toBe(
      'Searched for "activityGroupSummary" in apps/web/src'
    );

    const html = renderToStaticMarkup(
      createElement(MessageRow, {
        message: messages[1]!,
      })
    );
    expect(html).toContain(
      "Searching for &quot;activityGroupSummary&quot; in apps/web/src"
    );
    expect(html).toContain('aria-expanded="false"');
    expect(html).not.toContain("Running command");
    expect(html).not.toContain("activity-command-terminal");
    expect(html).not.toContain("Searched code");
  });

  test("uses semantic command labels with duration for activity rows", () => {
    expect(
      activityToolRowLabel({
        id: "read_command",
        label: "Ran",
        content: "sed -n '1,120p' app.ts",
        timestamp: "2026-05-16T00:00:01.000Z",
        kind: "command",
        state: "completed",
        terminal: { durationMs: 1_000 },
      })
    ).toBe("Read lines 1-120 of app.ts in 1s");
    expect(
      activityToolRowLabel({
        id: "search_command",
        label: "Running",
        content: 'rg "activity-summary" apps/web/src',
        timestamp: "2026-05-16T00:00:01.000Z",
        kind: "command",
        state: "running",
      })
    ).toBe('Searching for "activity-summary" in apps/web/src');
    expect(
      activityToolRowLabel({
        id: "failed_command",
        label: "Failed",
        content: "pnpm test",
        timestamp: "2026-05-16T00:00:01.000Z",
        kind: "command",
        state: "failed",
        terminal: { durationMs: 1_000 },
      })
    ).toBe("Command failed in 1s");
  });

  test("merges workspace action results into the started activity row", () => {
    const messages = buildChatMessages([
      runtimeEvent({
        id: "sandbox_create_started",
        name: "workspace_action",
        action: "sandbox_create",
        status: "started",
        sessionId: "session_1",
      }),
      runtimeEvent({
        id: "sandbox_create_completed",
        name: "workspace_action_result",
        action: "sandbox_create",
        status: "completed",
        sessionId: "session_1",
        output: "Sandbox workspace attached: sandbox_123 (creating)",
      }),
    ]);

    const activities = messages[0]?.activities ?? [];
    expect(activities).toHaveLength(1);
    expect(activities[0]?.label).toBe("Started sandbox");
    expect(activities[0]?.content).toBe(
      "Sandbox workspace attached: sandbox_123 (creating)"
    );
    expect(activities[0]?.state).toBe("completed");

    const html = renderToStaticMarkup(
      createElement(MessageRow, { message: messages[0]! })
    );
    expect(html).toContain("Started sandbox");
    expect(html).not.toContain("Starting sandbox");
  });

  test("merges failed workspace action results into the started activity row", () => {
    const messages = buildChatMessages([
      runtimeEvent({
        id: "sandbox_stop_started",
        name: "workspace_action",
        action: "sandbox_stop",
        status: "started",
        sessionId: "session_1",
      }),
      runtimeEvent({
        id: "sandbox_stop_failed",
        name: "workspace_action_result",
        action: "sandbox_stop",
        status: "failed",
        sessionId: "session_1",
        output: "Sandbox stop failed.",
      }),
    ]);

    const activities = messages[0]?.activities ?? [];
    expect(activities).toHaveLength(1);
    expect(activities[0]?.label).toBe("Sandbox stop failed");
    expect(activities[0]?.content).toBe("Sandbox stop failed.");
    expect(activities[0]?.state).toBe("failed");
  });

  test("summarizes mixed generic workspace actions instead of hiding later actions", () => {
    const messages = buildChatMessages([
      runtimeEvent({
        id: "sandbox_preserve_started",
        name: "workspace_action",
        action: "sandbox_preserve_source",
        status: "started",
        sessionId: "session_1",
      }),
      runtimeEvent({
        id: "sandbox_preserve_failed",
        name: "workspace_action_result",
        action: "sandbox_preserve_source",
        status: "failed",
        sessionId: "session_1",
        output: "placement_stale",
      }),
      runtimeEvent({
        id: "sandbox_stop_started",
        name: "workspace_action",
        action: "sandbox_stop",
        status: "started",
        sessionId: "session_1",
      }),
      runtimeEvent({
        id: "sandbox_stop_completed",
        name: "workspace_action_result",
        action: "sandbox_stop",
        status: "completed",
        sessionId: "session_1",
        output: "Stopped sandbox.",
      }),
    ]);

    const activities = messages[0]?.activities ?? [];
    expect(activities).toHaveLength(2);
    expect(activityGroupSummary(activities)).toBe(
      "Preserve failed and stopped sandbox"
    );
  });
});
