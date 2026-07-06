import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, test } from "bun:test";
import type { LocalProject, Session } from "@openpond/contracts";
import {
  codexHistorySessionId,
  loadCodexHistoryThreads,
  parseCodexSessionRecords,
  readCodexHistoryThreadPayload,
} from "../apps/server/src/codex-history";
import {
  applyCodexHistorySidebarPreference,
  loadCodexHistorySidebarPreferences,
  patchCodexHistorySidebarPreference,
} from "../apps/server/src/codex-history-sidebar-preferences";
import { SqliteStore } from "../apps/server/src/store/store";
import { latestGoalRuntimeFromEvents } from "../apps/web/src/lib/goal-runtime";
import {
  buildSidebarProjectPathIndex,
  sidebarProjectIdForSession,
} from "../apps/web/src/lib/sidebar-session-projects";

describe("codex history", () => {
  test("projects Codex JSONL records into chat events", () => {
    const sessionId = codexHistorySessionId("019e7138-5da2-7671-8837-202a36e0fff1");
    const parsed = parseCodexSessionRecords(
      [
        {
          type: "response_item",
          timestamp: "2026-05-29T00:01:00.000Z",
          payload: {
            type: "message",
            role: "user",
            content: [{ type: "input_text", text: "show this thread" }],
          },
        },
        {
          type: "response_item",
          timestamp: "2026-05-29T00:02:00.000Z",
          payload: {
            type: "message",
            role: "assistant",
            phase: "final_answer",
            content: [{ type: "output_text", text: "thread loaded" }],
          },
        },
      ],
      {
        fallbackTimestamp: "2026-05-29T00:00:00.000Z",
        sessionId,
        threadId: "019e7138-5da2-7671-8837-202a36e0fff1",
      },
    );

    expect(parsed.status).toBe("idle");
    expect(parsed.events.map((event) => event.name)).toEqual([
      "session.started",
      "turn.started",
      "assistant.delta",
      "turn.completed",
    ]);
    expect(parsed.events[1]?.args?.prompt).toBe("show this thread");
    expect(parsed.events[2]?.output).toBe("thread loaded");
  });

  test("hides Codex attachment context from visible user prompts", () => {
    const sessionId = codexHistorySessionId("019e7138-5da2-7671-8837-202a36e0fff1");
    const parsed = parseCodexSessionRecords(
      [
        {
          type: "response_item",
          timestamp: "2026-07-02T19:40:00.000Z",
          payload: {
            type: "message",
            role: "user",
            content: [
              {
                type: "input_text",
                text:
                  "testin image\n\n" +
                  "<attachments>\n" +
                  "The user attached 1 file with this message.\n" +
                  "1. Screenshot from 2026-07-02 15.20.18.png (image/png, 31 KB, image).\n" +
                  "</attachments>",
              },
            ],
          },
        },
      ],
      {
        fallbackTimestamp: "2026-07-02T19:39:00.000Z",
        sessionId,
        threadId: "019e7138-5da2-7671-8837-202a36e0fff1",
      },
    );

    const turnStarted = parsed.events.find((event) => event.name === "turn.started");
    expect(turnStarted?.args?.prompt).toBe("testin image");
    expect(turnStarted?.args?.attachments).toEqual([
      {
        id: `${sessionId}_turn_1_attachment_1_1`,
        name: "Screenshot from 2026-07-02 15.20.18.png",
        mediaType: "image/png",
        sizeBytes: 31 * 1024,
        kind: "image",
      },
    ]);
    expect(JSON.stringify(turnStarted?.args)).not.toContain("<attachments>");
  });

  test("projects OpenPond-saved Codex history image attachments as previews", () => {
    const threadId = "019e7138-5da2-7671-8837-202a36e0fff1";
    const sessionId = codexHistorySessionId(threadId);
    const turnId = `${sessionId}_turn_1`;
    const attachmentRootDir = path.join(os.tmpdir(), "openpond-codex-history-attachments");
    const storageName = "Screenshot from 2026-07-02 15.20.18.png";
    const localPath = path.join(attachmentRootDir, sessionId, turnId, storageName);
    const parsed = parseCodexSessionRecords(
      [
        {
          type: "response_item",
          timestamp: "2026-07-02T19:40:00.000Z",
          payload: {
            type: "message",
            role: "user",
            content: [
              {
                type: "input_text",
                text:
                  "testin image\n\n" +
                  "<attachments>\n" +
                  "The user attached 1 file with this message.\n" +
                  `1. ${storageName} (image/png, 31 KB, image). Saved locally at: ${localPath}\n` +
                  "</attachments>",
              },
            ],
          },
        },
      ],
      {
        attachmentRootDir,
        fallbackTimestamp: "2026-07-02T19:39:00.000Z",
        sessionId,
        threadId,
      },
    );

    const turnStarted = parsed.events.find((event) => event.name === "turn.started");
    expect(turnStarted?.args?.attachments).toEqual([
      {
        id: `${turnId}_attachment_1_1`,
        name: storageName,
        mediaType: "image/png",
        sizeBytes: 31 * 1024,
        kind: "image",
        imagePreview: {
          sessionId,
          turnId,
          attachmentId: `${turnId}_attachment_1_1`,
          storageName,
          contentType: "image/png",
        },
      },
    ]);
  });

  test("projects native Codex input images as user attachment previews", async () => {
    const attachmentRootDir = await mkdtemp(path.join(os.tmpdir(), "openpond-codex-history-input-image-"));
    try {
      const threadId = "019e7138-5da2-7671-8837-202a36e0fff1";
      const sessionId = codexHistorySessionId(threadId);
      const turnId = `${sessionId}_turn_1`;
      const parsed = parseCodexSessionRecords(
        [
          {
            type: "response_item",
            timestamp: "2026-07-02T19:54:00.000Z",
            payload: {
              type: "message",
              role: "user",
              content: [
                { type: "input_text", text: "testing this image" },
                {
                  type: "input_text",
                  text: '<image name=[Image #1] path="/home/glu/Pictures/Screenshots/Screenshot from 2026-07-02 15.54.41.png">',
                },
                {
                  type: "input_image",
                  image_url:
                    "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
                },
              ],
            },
          },
        ],
        {
          attachmentRootDir,
          fallbackTimestamp: "2026-07-02T19:53:00.000Z",
          sessionId,
          threadId,
        },
      );

      const turnStarted = parsed.events.find((event) => event.name === "turn.started");
      const attachment = Array.isArray(turnStarted?.args?.attachments)
        ? turnStarted.args.attachments[0] as {
            imagePreview?: { storageName: string };
            name?: string;
          }
        : null;
      expect(turnStarted?.args?.prompt).toBe("testing this image");
      expect(attachment?.name).toBe("Screenshot from 2026-07-02 15.54.41.png");
      expect(attachment?.imagePreview?.storageName).toContain("Screenshot from 2026-07-02 15.54.41.png");
      expect(
        existsSync(path.join(attachmentRootDir, sessionId, turnId, attachment!.imagePreview!.storageName)),
      ).toBe(true);
    } finally {
      await rm(attachmentRootDir, { recursive: true, force: true });
    }
  });

  test("projects legacy Codex top-level message records into chat events", () => {
    const sessionId = codexHistorySessionId("a9d2378a-0bd7-4b79-adb7-13a60a7fd671");
    const parsed = parseCodexSessionRecords(
      [
        {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: "open an old thread" }],
        },
        {
          type: "function_call",
          name: "shell",
          call_id: "call_1",
          arguments: JSON.stringify({ command: "pwd" }),
        },
        {
          type: "function_call_output",
          call_id: "call_1",
          output: "/workspace/project",
        },
        {
          type: "message",
          role: "assistant",
          content: [{ type: "output_text", text: "old thread loaded" }],
        },
      ],
      {
        fallbackTimestamp: "2025-09-08T18:58:30.000Z",
        sessionId,
        threadId: "a9d2378a-0bd7-4b79-adb7-13a60a7fd671",
      },
    );

    expect(parsed.status).toBe("idle");
    expect(parsed.events.map((event) => event.name)).toEqual([
      "session.started",
      "turn.started",
      "tool.started",
      "tool.completed",
      "command.output",
      "assistant.delta",
      "turn.completed",
    ]);
    expect(parsed.events[1]?.args?.prompt).toBe("open an old thread");
    expect(parsed.events[2]?.output).toBe("pwd");
    expect(parsed.events[4]?.output).toBe("/workspace/project");
    expect(parsed.events[5]?.output).toBe("old thread loaded");
  });

  test("projects Codex control messages as assistant-side events", () => {
    const sessionId = codexHistorySessionId("019e7138-5da2-7671-8837-202a36e0fff1");
    const parsed = parseCodexSessionRecords(
      [
        {
          type: "response_item",
          timestamp: "2026-05-29T00:01:00.000Z",
          payload: {
            type: "message",
            role: "user",
            content: [{ type: "input_text", text: "real prompt" }],
          },
        },
        {
          type: "response_item",
          timestamp: "2026-05-29T00:02:00.000Z",
          payload: {
            type: "message",
            role: "user",
            content: [{ type: "input_text", text: "<goal_context>\nKeep shipping the sidebar work.\n</goal_context>" }],
          },
        },
        {
          type: "response_item",
          timestamp: "2026-05-29T00:03:00.000Z",
          payload: {
            type: "message",
            role: "user",
            content: [{ type: "input_text", text: "<turn_aborted>\nThe user interrupted the previous turn.\n</turn_aborted>" }],
          },
        },
      ],
      {
        fallbackTimestamp: "2026-05-29T00:00:00.000Z",
        sessionId,
        threadId: "019e7138-5da2-7671-8837-202a36e0fff1",
      },
    );

    expect(parsed.status).toBe("idle");
    expect(parsed.events.map((event) => event.name)).toEqual([
      "session.started",
      "turn.started",
      "diagnostic",
      "turn.interrupted",
    ]);
    expect(parsed.events[2]?.output).toBe("Keep shipping the sidebar work.");
    expect(parsed.events[2]?.data).toMatchObject({ kind: "goal_context" });
    expect(parsed.events[3]?.output).toBe("The user interrupted the previous turn.");
    expect(parsed.events[3]?.data).toMatchObject({ kind: "turn_aborted" });
  });

  test("projects Codex goal update events with runtime fields", () => {
    const sessionId = codexHistorySessionId("019e7138-5da2-7671-8837-202a36e0fff1");
    const parsed = parseCodexSessionRecords(
      [
        {
          type: "event_msg",
          timestamp: "2026-05-29T00:02:00.000Z",
          payload: {
            type: "thread_goal_updated",
            threadId: "019e7138-5da2-7671-8837-202a36e0fff1",
            turnId: "turn_provider",
            goal: {
              threadId: "019e7138-5da2-7671-8837-202a36e0fff1",
              objective: "Ship sidebar polish",
              status: "complete",
              tokensUsed: 2386734,
              timeUsedSeconds: 6363,
              createdAt: 1779318378,
              updatedAt: 1779324741,
            },
          },
        },
      ],
      {
        fallbackTimestamp: "2026-05-29T00:00:00.000Z",
        sessionId,
        threadId: "019e7138-5da2-7671-8837-202a36e0fff1",
      },
    );

    expect(parsed.status).toBe("idle");
    expect(parsed.events.map((event) => event.name)).toEqual(["session.started", "diagnostic"]);
    expect(parsed.events[1]?.output).toBe("Ship sidebar polish");
    expect(parsed.events[1]?.data).toMatchObject({
      kind: "thread_goal",
      provider: "codex",
      goal: {
        status: "complete",
        tokensUsed: 2386734,
        timeUsedSeconds: 6363,
      },
    });
  });

  test("marks active Codex goal updates as running session state", async () => {
    const threadId = "019e7138-5da2-7671-8837-202a36e0fff1";
    const sessionId = codexHistorySessionId(threadId);
    const activeGoalRecord = {
      type: "event_msg",
      timestamp: "2026-05-29T00:02:00.000Z",
      payload: {
        type: "thread_goal_updated",
        threadId,
        goal: {
          threadId,
          objective: "Keep polishing goal mode",
          status: "active",
          tokensUsed: 4000,
          timeUsedSeconds: 120,
        },
      },
    };

    const parsed = parseCodexSessionRecords(
      [activeGoalRecord],
      {
        fallbackTimestamp: "2026-05-29T00:00:00.000Z",
        sessionId,
        threadId,
      },
    );

    expect(parsed.status).toBe("active");

    const cleared = parseCodexSessionRecords(
      [
        activeGoalRecord,
        {
          type: "event_msg",
          timestamp: "2026-05-29T00:03:00.000Z",
          payload: {
            type: "thread_goal_cleared",
            threadId,
          },
        },
      ],
      {
        fallbackTimestamp: "2026-05-29T00:00:00.000Z",
        sessionId,
        threadId,
      },
    );

    expect(cleared.status).toBe("idle");
  });

  test("clears active Codex goal state after task_complete lifecycle events", () => {
    const threadId = "019e7138-5da2-7671-8837-202a36e0fff1";
    const sessionId = codexHistorySessionId(threadId);
    const parsed = parseCodexSessionRecords(
      [
        {
          type: "event_msg",
          timestamp: "2026-05-29T00:02:00.000Z",
          payload: {
            type: "thread_goal_updated",
            threadId,
            goal: {
              threadId,
              objective: "Keep polishing goal mode",
              status: "active",
              tokensUsed: 4000,
              timeUsedSeconds: 120,
            },
          },
        },
        {
          type: "event_msg",
          timestamp: "2026-05-29T00:04:00.000Z",
          payload: {
            type: "task_complete",
            turn_id: "turn_provider",
            completed_at: 1779321840,
            duration_ms: 120000,
          },
        },
      ],
      {
        fallbackTimestamp: "2026-05-29T00:00:00.000Z",
        sessionId,
        threadId,
      },
    );

    expect(parsed.status).toBe("idle");
    expect(parsed.events.map((event) => event.name)).toEqual([
      "session.started",
      "diagnostic",
      "turn.completed",
      "diagnostic",
    ]);
    expect(parsed.events.at(-1)?.data).toMatchObject({ kind: "thread_goal_cleared", synthetic: true });
    expect(latestGoalRuntimeFromEvents(parsed.events)).toBeNull();
  });

  test("clears active Codex goal state and projects interruption after turn_aborted lifecycle events", () => {
    const threadId = "019e7138-5da2-7671-8837-202a36e0fff1";
    const sessionId = codexHistorySessionId(threadId);
    const parsed = parseCodexSessionRecords(
      [
        {
          type: "event_msg",
          timestamp: "2026-05-29T00:02:00.000Z",
          payload: {
            type: "thread_goal_updated",
            threadId,
            goal: {
              threadId,
              objective: "Keep polishing goal mode",
              status: "active",
              tokensUsed: 4000,
              timeUsedSeconds: 120,
            },
          },
        },
        {
          type: "event_msg",
          timestamp: "2026-05-29T00:04:00.000Z",
          payload: {
            type: "turn_aborted",
            turn_id: "turn_provider",
            reason: "interrupted",
            completed_at: 1779321840,
            duration_ms: 120000,
          },
        },
      ],
      {
        fallbackTimestamp: "2026-05-29T00:00:00.000Z",
        sessionId,
        threadId,
      },
    );

    expect(parsed.status).toBe("idle");
    expect(parsed.events.map((event) => event.name)).toEqual([
      "session.started",
      "diagnostic",
      "turn.interrupted",
      "diagnostic",
    ]);
    expect(parsed.events[2]?.output).toBe("Turn interrupted: interrupted");
    expect(parsed.events.at(-1)?.data).toMatchObject({ kind: "thread_goal_cleared", synthetic: true });
    expect(latestGoalRuntimeFromEvents(parsed.events)).toBeNull();
  });

  test("lists threads from history and session files without requiring session_index", async () => {
    const codexHome = await mkdtemp(path.join(os.tmpdir(), "openpond-codex-history-"));
    try {
      const threadId = "019e7138-5da2-7671-8837-202a36e0fff1";
      const sessionDir = path.join(codexHome, "sessions", "2026", "05", "28");
      await mkdir(sessionDir, { recursive: true });
      await writeFile(
        path.join(sessionDir, `rollout-2026-05-28T20-52-59-${threadId}.jsonl`),
        `${JSON.stringify({
          type: "session_meta",
          timestamp: "2026-05-29T00:53:17.784Z",
          payload: {
            id: threadId,
            cwd: "/home/glu/Projects/all/openpond-app",
            timestamp: "2026-05-29T00:53:17.784Z",
          },
        })}\n`,
      );
      await writeFile(
        path.join(codexHome, "history.jsonl"),
        `${JSON.stringify({
          session_id: threadId,
          ts: 1780015997,
          text: "how can i get my codex chats to show up in the sidebar under the project?",
        })}\n`,
      );

      const threads = await loadCodexHistoryThreads({ codexHome, metadataLimit: 10 });

      expect(threads).toHaveLength(1);
      expect(threads[0]?.session.id).toBe(codexHistorySessionId(threadId));
      expect(threads[0]?.session.title).toContain("how can i get my codex chats");
      expect(threads[0]?.session.cwd).toBe("/home/glu/Projects/all/openpond-app");
    } finally {
      await rm(codexHome, { recursive: true, force: true });
    }
  });

  test("reads expanded Codex history beyond the initial tail window", async () => {
    const codexHome = await mkdtemp(path.join(os.tmpdir(), "openpond-codex-history-expanded-"));
    try {
      const threadId = "019e7138-5da2-7671-8837-202a36e0fff2";
      const sessionId = codexHistorySessionId(threadId);
      const sessionDir = path.join(codexHome, "sessions", "2026", "05", "28");
      await mkdir(sessionDir, { recursive: true });
      const records = [
        {
          type: "session_meta",
          timestamp: "2026-05-29T00:00:00.000Z",
          payload: {
            id: threadId,
            cwd: "/home/glu/Projects/all/openpond-app",
            timestamp: "2026-05-29T00:00:00.000Z",
          },
        },
      ];
      for (let index = 0; index < 2_200; index += 1) {
        records.push({
          type: "response_item",
          timestamp: `2026-05-29T00:${String(Math.floor(index / 60)).padStart(2, "0")}:${String(index % 60).padStart(2, "0")}.000Z`,
          payload: {
            type: "message",
            role: "user",
            content: [{ type: "input_text", text: `prompt-${String(index).padStart(4, "0")}` }],
          },
        });
      }
      await writeFile(
        path.join(sessionDir, `rollout-2026-05-28T20-52-59-${threadId}.jsonl`),
        `${records.map((record) => JSON.stringify(record)).join("\n")}\n`,
      );

      const tailPayload = await readCodexHistoryThreadPayload(sessionId, { codexHome, maxEvents: 800 });
      const expandedPayload = await readCodexHistoryThreadPayload(sessionId, { codexHome, maxEvents: 2_500 });

      expect(tailPayload.events.some((event) => event.args?.prompt === "prompt-0000")).toBe(false);
      expect(expandedPayload.events.some((event) => event.args?.prompt === "prompt-0000")).toBe(true);
      expect(expandedPayload.events.length).toBeGreaterThan(2_000);
    } finally {
      await rm(codexHome, { recursive: true, force: true });
    }
  });

  test("lists Codex history thread with active goal as active", async () => {
    const codexHome = await mkdtemp(path.join(os.tmpdir(), "openpond-codex-history-active-goal-"));
    try {
      const threadId = "019e7138-5da2-7671-8837-202a36e0fff1";
      const sessionDir = path.join(codexHome, "sessions", "2026", "05", "28");
      await mkdir(sessionDir, { recursive: true });
      await writeFile(
        path.join(sessionDir, `rollout-2026-05-28T20-52-59-${threadId}.jsonl`),
        `${JSON.stringify({
          type: "session_meta",
          timestamp: "2026-05-29T00:53:17.784Z",
          payload: {
            id: threadId,
            cwd: "/home/glu/Projects/all/openpond-app",
            timestamp: "2026-05-29T00:53:17.784Z",
          },
        })}\n${JSON.stringify({
          type: "event_msg",
          timestamp: new Date().toISOString(),
          payload: {
            type: "thread_goal_updated",
            threadId,
            goal: {
              threadId,
              objective: "Keep running in goal mode",
              status: "active",
              timeUsedSeconds: 45,
            },
          },
        })}\n`,
      );

      const threads = await loadCodexHistoryThreads({ codexHome, metadataLimit: 10 });

      expect(threads).toHaveLength(1);
      expect(threads[0]?.session.status).toBe("active");
      expect(threads[0]?.session.metadata?.codexGoalRuntime).toMatchObject({
        provider: "codex",
        objective: "Keep running in goal mode",
        status: "active",
        timeUsedSeconds: 45,
      });
    } finally {
      await rm(codexHome, { recursive: true, force: true });
    }
  });

  test("lists active Codex goal metadata from injected goal context when the goal update is outside the tail", async () => {
    const codexHome = await mkdtemp(path.join(os.tmpdir(), "openpond-codex-history-tail-goal-"));
    try {
      const threadId = "019e7138-5da2-7671-8837-202a36e0fff9";
      const objective = "Continue tail-visible goal";
      const sessionDir = path.join(codexHome, "sessions", "2026", "05", "28");
      await mkdir(sessionDir, { recursive: true });
      await writeFile(
        path.join(sessionDir, `rollout-2026-05-28T20-52-59-${threadId}.jsonl`),
        `${[
          {
            type: "session_meta",
            timestamp: "2026-05-29T00:53:17.784Z",
            payload: {
              id: threadId,
              cwd: "/home/glu/Projects/all/openpond-app",
              timestamp: "2026-05-29T00:53:17.784Z",
            },
          },
          {
            type: "event_msg",
            timestamp: new Date(Date.now() - 60_000).toISOString(),
            payload: {
              type: "thread_goal_updated",
              threadId,
              goal: {
                threadId,
                objective,
                status: "active",
                timeUsedSeconds: 45,
              },
            },
          },
          {
            type: "response_item",
            timestamp: new Date(Date.now() - 30_000).toISOString(),
            payload: {
              type: "message",
              role: "assistant",
              content: [{ type: "output_text", text: "x".repeat(600 * 1024) }],
            },
          },
          {
            type: "response_item",
            timestamp: new Date().toISOString(),
            payload: {
              type: "message",
              role: "user",
              content: [
                {
                  type: "input_text",
                  text: `<codex_internal_context source="goal">\n<objective>\n${objective}\n</objective>\n\nBudget:\n- Tokens used: 1,200\n- Token budget: none\n</codex_internal_context>`,
                },
              ],
            },
          },
        ].map((record) => JSON.stringify(record)).join("\n")}\n`,
      );

      const threads = await loadCodexHistoryThreads({ codexHome, metadataLimit: 10 });

      expect(threads).toHaveLength(1);
      expect(threads[0]?.session.status).toBe("active");
      expect(threads[0]?.session.metadata?.codexGoalRuntime).toMatchObject({
        provider: "codex",
        objective,
        status: "active",
        tokensUsed: 1200,
        tokenBudget: null,
      });
    } finally {
      await rm(codexHome, { recursive: true, force: true });
    }
  });

  test("lists Codex history thread with terminal lifecycle event as idle", async () => {
    const codexHome = await mkdtemp(path.join(os.tmpdir(), "openpond-codex-history-terminal-goal-"));
    try {
      const threadId = "019e7138-5da2-7671-8837-202a36e0fff1";
      const sessionDir = path.join(codexHome, "sessions", "2026", "05", "28");
      await mkdir(sessionDir, { recursive: true });
      await writeFile(
        path.join(sessionDir, `rollout-2026-05-28T20-52-59-${threadId}.jsonl`),
        `${JSON.stringify({
          type: "session_meta",
          timestamp: "2026-05-29T00:53:17.784Z",
          payload: {
            id: threadId,
            cwd: "/home/glu/Projects/all/openpond-app",
            timestamp: "2026-05-29T00:53:17.784Z",
          },
        })}\n${JSON.stringify({
          type: "event_msg",
          timestamp: new Date(Date.now() - 1000).toISOString(),
          payload: {
            type: "thread_goal_updated",
            threadId,
            goal: {
              threadId,
              objective: "Keep running in goal mode",
              status: "active",
              timeUsedSeconds: 45,
            },
          },
        })}\n${JSON.stringify({
          type: "event_msg",
          timestamp: new Date().toISOString(),
          payload: {
            type: "task_complete",
            turn_id: "turn_provider",
            completed_at: 1779321840,
            duration_ms: 120000,
          },
        })}\n`,
      );

      const threads = await loadCodexHistoryThreads({ codexHome, metadataLimit: 10 });

      expect(threads).toHaveLength(1);
      expect(threads[0]?.session.status).toBe("idle");
    } finally {
      await rm(codexHome, { recursive: true, force: true });
    }
  });

  test("uses turn_context cwd as Codex history project grouping fallback", async () => {
    const codexHome = await mkdtemp(path.join(os.tmpdir(), "openpond-codex-history-turn-context-"));
    try {
      const threadId = "019e7138-5da2-7671-8837-202a36e0fff1";
      const sessionDir = path.join(codexHome, "sessions", "2026", "05", "28");
      await mkdir(sessionDir, { recursive: true });
      await writeFile(
        path.join(sessionDir, `rollout-2026-05-28T20-52-59-${threadId}.jsonl`),
        `${JSON.stringify({
          type: "session_meta",
          timestamp: "2026-05-29T00:53:17.784Z",
          payload: {
            id: threadId,
            timestamp: "2026-05-29T00:53:17.784Z",
          },
        })}\n${JSON.stringify({
          type: "turn_context",
          timestamp: "2026-05-29T00:53:18.784Z",
          payload: {
            turn_id: "turn_provider",
            cwd: "/home/glu/Projects/all/openpond-app/apps/web",
          },
        })}\n`,
      );

      const threads = await loadCodexHistoryThreads({ codexHome, metadataLimit: 10 });
      const project: LocalProject = {
        id: "project_1",
        name: "OpenPond App",
        path: "/home/glu/Projects/all/openpond-app",
        workspacePath: "/home/glu/Projects/all/openpond-app",
        repoPath: "/home/glu/Projects/all/openpond-app",
        source: "git",
        sandboxTemplate: null,
        linkedOpenPondApp: null,
        createdAt: "2026-05-29T00:00:00.000Z",
        updatedAt: "2026-05-29T00:00:00.000Z",
      };

      expect(threads[0]?.session.cwd).toBe("/home/glu/Projects/all/openpond-app/apps/web");
      expect(
        sidebarProjectIdForSession(
          threads[0]!.session,
          new Set([project.id]),
          buildSidebarProjectPathIndex([project]),
        ),
      ).toBe("project_1");
    } finally {
      await rm(codexHome, { recursive: true, force: true });
    }
  });

  test("persists app-local sidebar preferences for Codex history sessions", async () => {
    const storeDir = await mkdtemp(path.join(os.tmpdir(), "openpond-codex-history-preferences-"));
    const store = new SqliteStore(storeDir);
    const threadId = "019e7138-5da2-7671-8837-202a36e0fff1";
    const sessionId = codexHistorySessionId(threadId);
    const baseSession: Session = {
      id: sessionId,
      provider: "codex",
      title: "Codex chat",
      appId: null,
      appName: null,
      workspaceId: null,
      workspaceName: null,
      cwd: "/tmp/project",
      codexThreadId: threadId,
      createdAt: "2026-05-29T00:00:00.000Z",
      updatedAt: "2026-05-29T00:00:00.000Z",
      status: "active",
      pinned: false,
      archived: false,
      order: 10,
    };

    try {
      await patchCodexHistorySidebarPreference(store, sessionId, { pinned: true, archived: false, order: 2 });

      let preferences = await loadCodexHistorySidebarPreferences(store);
      let applied = applyCodexHistorySidebarPreference(baseSession, preferences);
      expect(applied.pinned).toBe(true);
      expect(applied.archived).toBe(false);
      expect(applied.order).toBe(2);
      expect(applied.status).toBe("active");
      expect(applied.updatedAt).toBe(baseSession.updatedAt);

      await patchCodexHistorySidebarPreference(store, sessionId, { pinned: false, archived: true });
      preferences = await loadCodexHistorySidebarPreferences(store);
      applied = applyCodexHistorySidebarPreference(baseSession, preferences);
      expect(applied.pinned).toBe(false);
      expect(applied.archived).toBe(true);
      expect(applied.order).toBe(2);
      expect(applied.updatedAt).toBe(baseSession.updatedAt);
    } finally {
      await store.close();
      await rm(storeDir, { recursive: true, force: true });
    }
  });
});
