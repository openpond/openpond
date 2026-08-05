import { describe, expect, test } from "vitest";
import type { RuntimeEvent } from "@openpond/contracts";
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
  command: string
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

describe("chat message command summaries", () => {
  test("surfaces apply and stop outcomes when mixed with read actions", () => {
    const messages = buildChatMessages([
      runtimeEvent({
        id: "sandbox_exec_completed",
        name: "workspace_action_result",
        action: "sandbox_exec",
        status: "completed",
        sessionId: "session_1",
        output: "Command succeeded",
      }),
      runtimeEvent({
        id: "sandbox_read_completed",
        name: "workspace_action_result",
        action: "sandbox_read_file",
        status: "completed",
        sessionId: "session_1",
        output: "README.md",
      }),
      runtimeEvent({
        id: "sandbox_git_status_completed",
        name: "workspace_action_result",
        action: "sandbox_git_status",
        status: "completed",
        sessionId: "session_1",
        output: "Sandbox git status has 1 changed file.",
      }),
      runtimeEvent({
        id: "sandbox_apply_completed",
        name: "workspace_action_result",
        action: "sandbox_git_apply_patch_local",
        status: "completed",
        sessionId: "session_1",
        output: "Applied sandbox patch to github-pr-tracker-9: 1 changed file.",
      }),
      runtimeEvent({
        id: "sandbox_preserve_completed",
        name: "workspace_action_result",
        action: "sandbox_preserve_source",
        status: "completed",
        sessionId: "session_1",
        output: "Preserved sandbox changes.",
      }),
      runtimeEvent({
        id: "sandbox_stop_completed",
        name: "workspace_action_result",
        action: "sandbox_stop",
        status: "completed",
        sessionId: "session_1",
        output: "Stopped sandbox.",
      }),
      runtimeEvent({
        id: "sandbox_status_with_receipt",
        name: "workspace_action",
        action: "sandbox_status",
        status: "started",
        sessionId: "session_1",
      }),
      runtimeEvent({
        id: "sandbox_status_with_receipt_result",
        name: "workspace_action_result",
        action: "sandbox_status",
        status: "completed",
        sessionId: "session_1",
        output: "Read sandbox status.",
        data: {
          workspaceExecutionTarget: {
            target: "sandbox",
            sandboxId: "sandbox_receipt_1234567890",
            hybrid: true,
          },
          sandbox: {
            receipts: [
              {
                id: "receipt_1234567890",
                status: "captured",
                totalUsd: "0.011696",
              },
            ],
          },
        },
      }),
    ]);

    const activities = messages[0]?.activities ?? [];
    expect(activityGroupSummary(activities)).toBe(
      "Read a file, applied locally, preserved sandbox source, stopped sandbox, and captured receipt receip...7890 $0.011696"
    );
    expect(activities.at(-1)).toMatchObject({
      label: "Checked sandbox",
      meta: "Hybrid sandbox sandbo...7890 · receipt receip...7890 · $0.011696 captured",
      receipt: {
        id: "receipt_1234567890",
        status: "captured",
        totalUsd: "0.011696",
      },
    });
  });

  test("summarizes mixed command groups with deterministic counts", () => {
    const messages = buildChatMessages([
      runtimeEvent({
        id: "turn_1",
        name: "turn.started",
        turnId: "turn_1",
        args: { prompt: "Inspect chat activity UI" },
      }),
      commandStarted(
        "read_1",
        "turn_1",
        "sed -n '1,160p' apps/web/src/components/chat/MessageActivityGroup.tsx"
      ),
      commandStarted(
        "read_2",
        "turn_1",
        "cat apps/web/src/lib/chat-activities.ts"
      ),
      commandStarted(
        "search_1",
        "turn_1",
        'rg "activity-summary" apps/web/src'
      ),
      commandStarted(
        "list_1",
        "turn_1",
        "rg --files apps/web/src/components/chat"
      ),
    ]);

    const activities = messages[1]?.activities ?? [];
    expect(activityGroupSummary(activities)).toBe(
      "Read 2 files, searched code, and listed files"
    );
  });

  test("summarizes edits and verification commands", () => {
    const messages = buildChatMessages([
      runtimeEvent({
        id: "turn_1",
        name: "turn.started",
        turnId: "turn_1",
        args: { prompt: "Patch and test" },
      }),
      commandStarted("edit_1", "turn_1", "apply_patch"),
      commandStarted(
        "check_1",
        "turn_1",
        "pnpm test tests/chat-messages.test.ts"
      ),
    ]);

    const activities = messages[1]?.activities ?? [];
    expect(activityGroupSummary(activities)).toBe("Made edits and ran checks");
  });
});
