import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import type { BootstrapPayload, Session, Turn } from "@openpond/contracts";
import type { HostedChatTool } from "@openpond/cloud";
import type { HostedChatTurnDelta, HostedChatTurnInput } from "@openpond/runtime";

import { createOpenPondServer } from "../apps/server/src/index";
import {
  createScriptedOpenPondChatStream,
  OPENPOND_HARNESS_SCRIPTED_MODELS_ENV,
  scriptedOpenPondModelsEnabled,
  streamScriptedOpenPondChatTurn,
} from "../apps/server/src/openpond/scripted-chat-provider";

describe("scripted OpenPond chat provider", () => {
  test("only enables scripted models behind the explicit harness env flag", () => {
    expect(scriptedOpenPondModelsEnabled({ [OPENPOND_HARNESS_SCRIPTED_MODELS_ENV]: "1" })).toBe(true);
    expect(scriptedOpenPondModelsEnabled({ [OPENPOND_HARNESS_SCRIPTED_MODELS_ENV]: "true" })).toBe(true);
    expect(scriptedOpenPondModelsEnabled({ [OPENPOND_HARNESS_SCRIPTED_MODELS_ENV]: "on" })).toBe(true);
    expect(scriptedOpenPondModelsEnabled({ [OPENPOND_HARNESS_SCRIPTED_MODELS_ENV]: "0" })).toBe(false);
    expect(scriptedOpenPondModelsEnabled({})).toBe(false);
  });

  test("delegates scripted-looking models to the fallback when disabled", async () => {
    let fallbackCalled = false;
    const stream = createScriptedOpenPondChatStream(
      async function* fallback(input) {
        fallbackCalled = true;
        yield {
          type: "text_delta",
          text: `fallback ${input.model}`,
          raw: { fallback: true },
        };
      },
      { enabled: false },
    );

    const deltas = await collect(stream(inputFixture({ model: "openpond-scripted-chat-two-turns" })));

    expect(fallbackCalled).toBe(true);
    expect(textFromDeltas(deltas)).toBe("fallback openpond-scripted-chat-two-turns");
  });

  test("streams deterministic multi-turn chat responses", async () => {
    const deltas = await collect(streamScriptedOpenPondChatTurn(inputFixture({
      model: "openpond-scripted-chat-two-turns",
      messages: [
        { role: "user", content: "first" },
        { role: "assistant", content: "scripted turn 1 response for: first" },
        { role: "user", content: "second" },
      ],
    })));

    expect(textFromDeltas(deltas)).toBe("scripted turn 2 response for: second");
    expect(deltas.at(-1)).toMatchObject({ type: "finish", finishReason: "stop" });
  });

  test("returns a deterministic Agent plan for Lab Create/Improve tests", async () => {
    const deltas = await collect(streamScriptedOpenPondChatTurn(inputFixture({
      model: "openpond-scripted-chat-two-turns",
      messages: [
        {
          role: "system",
          content: "You are the OpenPond Create/Improve planner.",
        },
        {
          role: "user",
          content: JSON.stringify({
            run: {
              objective: "Review release changes and draft concise notes.",
              target: {
                kind: "agent",
                id: "release-notes-reviewer",
              },
            },
          }),
        },
      ],
    })));
    const decision = JSON.parse(textFromDeltas(deltas));

    expect(decision).toMatchObject({
      schemaVersion: "openpond.createImprove.plannerDecision.v1",
      decision: "plan",
      plan: {
        targetId: "release-notes-reviewer",
        actionShape: {
          mode: "chat",
          defaultActionKey: "release-notes-reviewer.chat",
        },
      },
    });
  });

  test("asks the native runtime to start and join a subagent lifecycle", async () => {
    const startDeltas = await collect(streamScriptedOpenPondChatTurn(inputFixture({
      model: "openpond-scripted-subagent-lifecycle",
      tools: [tool("openpond_subagent_start"), tool("openpond_subagent_join")],
    })));
    const startCall = onlyToolCall(startDeltas);
    expect(startCall.function?.name).toBe("openpond_subagent_start");
    expect(JSON.parse(startCall.function?.arguments ?? "{}")).toMatchObject({
      roleId: "research",
      required: true,
    });
    expect(startDeltas.at(-1)).toMatchObject({ type: "finish", finishReason: "tool_calls" });

    const joinDeltas = await collect(streamScriptedOpenPondChatTurn(inputFixture({
      model: "openpond-scripted-subagent-lifecycle",
      messages: [
        { role: "user", content: "prove the subagent path" },
        {
          role: "tool",
          tool_call_id: "call_openpond_subagent_start",
          content: JSON.stringify({
            ok: true,
            action: "openpond_subagent_start",
            output: "Started subagent.",
            data: { runId: "run_scripted_1" },
          }),
        },
      ],
      tools: [tool("openpond_subagent_start"), tool("openpond_subagent_join")],
    })));
    const joinCall = onlyToolCall(joinDeltas);
    expect(joinCall.function?.name).toBe("openpond_subagent_join");
    expect(JSON.parse(joinCall.function?.arguments ?? "{}")).toEqual({ runId: "run_scripted_1" });
  });

  test("scripts a write-capable blocker subagent start and blocked response", async () => {
    const startDeltas = await collect(streamScriptedOpenPondChatTurn(inputFixture({
      model: "openpond-scripted-subagent-blocker",
      tools: [tool("openpond_subagent_start"), tool("openpond_subagent_join")],
    })));
    const startCall = onlyToolCall(startDeltas);
    expect(startCall.function?.name).toBe("openpond_subagent_start");
    expect(JSON.parse(startCall.function?.arguments ?? "{}")).toMatchObject({
      roleId: "coding",
      required: true,
      objective: "Attempt write-capable work in a non-git workspace so the desktop harness can verify blocked subagent UI.",
    });

    const blockedDeltas = await collect(streamScriptedOpenPondChatTurn(inputFixture({
      model: "openpond-scripted-subagent-blocker",
      messages: [
        { role: "user", content: "start a blocker child" },
        toolResult("openpond_subagent_start", { runId: "run_blocked_1", status: "blocked" }),
      ],
      tools: [tool("openpond_subagent_start"), tool("openpond_subagent_join")],
    })));
    expect(textFromDeltas(blockedDeltas)).toBe("Coding subagent blocked for run_blocked_1.");
    expect(blockedDeltas.at(-1)).toMatchObject({ type: "finish", finishReason: "stop" });
  });

  test("scripts a bounded coding worker through real workspace and command tool steps", async () => {
    const writeCommand =
      "printf '%s\\n' 'bounded-worker-contract' 'copy-on-write child edit' > bounded-worker-contract-proof.txt";
    const validationCommand =
      "test -f bounded-worker-contract-proof.txt && grep -q bounded-worker-contract bounded-worker-contract-proof.txt";
    const startDeltas = await collect(streamScriptedOpenPondChatTurn(inputFixture({
      model: "openpond-scripted-subagent-bounded-worker",
      tools: [tool("openpond_subagent_start"), tool("openpond_subagent_join")],
    })));
    const startCall = onlyToolCall(startDeltas);
    expect(startCall.function?.name).toBe("openpond_subagent_start");
    expect(JSON.parse(startCall.function?.arguments ?? "{}")).toMatchObject({
      roleId: "coding",
      required: true,
      workerBrief: {
        plan: expect.arrayContaining(["Inspect workspace context."]),
        targetFiles: ["package.json", "bounded-worker-contract-proof.txt"],
        validationCommands: [validationCommand],
      },
    });

    const childSystem = {
      role: "system" as const,
      content: "You are an OpenPond coding subagent running in an addressable child conversation.",
    };
    const firstSearchDeltas = await collect(streamScriptedOpenPondChatTurn(inputFixture({
      model: "openpond-scripted-subagent-bounded-worker",
      messages: [childSystem],
      tools: [tool("resource_search"), tool("resource_read"), tool("exec_command")],
    })));
    expect(onlyToolCall(firstSearchDeltas).function?.name).toBe("resource_search");

    const secondSearchDeltas = await collect(streamScriptedOpenPondChatTurn(inputFixture({
      model: "openpond-scripted-subagent-bounded-worker",
      messages: [childSystem, toolResult("resource_search", { query: "package.json" })],
      tools: [tool("resource_search"), tool("resource_read"), tool("exec_command")],
    })));
    expect(onlyToolCall(secondSearchDeltas).function?.name).toBe("resource_search");

    const readDeltas = await collect(streamScriptedOpenPondChatTurn(inputFixture({
      model: "openpond-scripted-subagent-bounded-worker",
      messages: [
        childSystem,
        toolResult("resource_search", { query: "package.json" }),
        toolResult("resource_search", { query: "package.json" }),
      ],
      tools: [tool("resource_search"), tool("resource_read"), tool("exec_command")],
    })));
    expect(onlyToolCall(readDeltas).function?.name).toBe("resource_read");

    const writeDeltas = await collect(streamScriptedOpenPondChatTurn(inputFixture({
      model: "openpond-scripted-subagent-bounded-worker",
      messages: [
        childSystem,
        toolResult("resource_search", { query: "package.json" }),
        toolResult("resource_search", { query: "package.json" }),
        toolResult("resource_read", { ref: "workspace:file:package.json" }),
      ],
      tools: [tool("resource_search"), tool("resource_read"), tool("exec_command")],
    })));
    const writeCall = onlyToolCall(writeDeltas);
    expect(writeCall.function?.name).toBe("exec_command");
    expect(JSON.parse(writeCall.function?.arguments ?? "{}")).toMatchObject({
      command: writeCommand,
      timeoutSeconds: 30,
    });

    const validationDeltas = await collect(streamScriptedOpenPondChatTurn(inputFixture({
      model: "openpond-scripted-subagent-bounded-worker",
      messages: [
        childSystem,
        toolResult("resource_search", { query: "package.json" }),
        toolResult("resource_search", { query: "package.json" }),
        toolResult("resource_read", { ref: "workspace:file:package.json" }),
        toolResult("exec_command", { command: writeCommand, exitCode: 0 }),
      ],
      tools: [tool("resource_search"), tool("resource_read"), tool("exec_command")],
    })));
    const validationCall = onlyToolCall(validationDeltas);
    expect(validationCall.function?.name).toBe("exec_command");
    expect(validationCall.id).not.toBe(writeCall.id);
    expect(JSON.parse(validationCall.function?.arguments ?? "{}")).toMatchObject({
      command: validationCommand,
      timeoutSeconds: 30,
    });

    const finalDeltas = await collect(streamScriptedOpenPondChatTurn(inputFixture({
      model: "openpond-scripted-subagent-bounded-worker",
      messages: [
        childSystem,
        toolResult("resource_search", { query: "package.json" }),
        toolResult("resource_search", { query: "package.json" }),
        toolResult("resource_read", { ref: "workspace:file:package.json" }),
        toolResult("exec_command", { command: writeCommand, exitCode: 0 }),
        toolResult("exec_command", {
          command: validationCommand,
          exitCode: 0,
        }),
      ],
      tools: [tool("resource_search"), tool("resource_read"), tool("exec_command")],
    })));
    expect(textFromDeltas(finalDeltas)).toBe(
      "Coding subagent submitted the bounded worker contract packet after editing and validation.",
    );
  });

  test("polls subagent status until the native run reports submitted for review", async () => {
    const statusDeltas = await collect(streamScriptedOpenPondChatTurn(inputFixture({
      model: "openpond-scripted-subagent-lifecycle",
      messages: [
        { role: "user", content: "prove status polling" },
        toolResult("openpond_subagent_start", { runId: "run_scripted_2", status: "queued" }),
        toolResult("openpond_subagent_join", { runId: "run_scripted_2", status: "running" }),
      ],
      tools: [
        tool("openpond_subagent_start"),
        tool("openpond_subagent_join"),
        tool("openpond_subagent_status"),
      ],
    })));
    const statusCall = onlyToolCall(statusDeltas);
    expect(statusCall.function?.name).toBe("openpond_subagent_status");
    expect(JSON.parse(statusCall.function?.arguments ?? "{}")).toEqual({ runId: "run_scripted_2" });

    const submittedDeltas = await collect(streamScriptedOpenPondChatTurn(inputFixture({
      model: "openpond-scripted-subagent-lifecycle",
      messages: [
        { role: "user", content: "prove status polling" },
        toolResult("openpond_subagent_start", { runId: "run_scripted_2", status: "queued" }),
        toolResult("openpond_subagent_join", { runId: "run_scripted_2", status: "running" }),
        toolResult("openpond_subagent_status", {
          runs: [{ runId: "run_scripted_2", status: "submitted_for_review" }],
        }),
      ],
      tools: [
        tool("openpond_subagent_start"),
        tool("openpond_subagent_join"),
        tool("openpond_subagent_status"),
      ],
    })));
    expect(textFromDeltas(submittedDeltas)).toBe("Research subagent lifecycle submitted for review for run_scripted_2.");
  });

  test("lets scripted handoff parent turns idle before the queued wake joins", async () => {
    const initialParentDeltas = await collect(streamScriptedOpenPondChatTurn(inputFixture({
      model: "openpond-scripted-subagent-handoff",
      messages: [
        { role: "user", content: "start a child that will hand off" },
        toolResult("openpond_subagent_start", { runId: "run_handoff_1", status: "running" }),
      ],
      tools: [tool("openpond_subagent_start"), tool("openpond_subagent_join")],
    })));
    expect(textFromDeltas(initialParentDeltas)).toBe("Research subagent handoff child started for run_handoff_1.");
    expect(initialParentDeltas.at(-1)).toMatchObject({ type: "finish", finishReason: "stop" });

    const wakeDeltas = await collect(streamScriptedOpenPondChatTurn(inputFixture({
      model: "openpond-scripted-subagent-handoff",
      messages: [
        { role: "user", content: "start a child that will hand off" },
        toolResult("openpond_subagent_start", { runId: "run_handoff_1", status: "running" }),
        {
          role: "user",
          content: [
            "A research subagent sent a handoff handoff to this main chat.",
            "Message:",
            "Scripted child handoff from the desktop harness.",
          ].join("\n"),
        },
      ],
      tools: [tool("openpond_subagent_start"), tool("openpond_subagent_join")],
    })));
    const joinCall = onlyToolCall(wakeDeltas);
    expect(joinCall.function?.name).toBe("openpond_subagent_join");
    expect(JSON.parse(joinCall.function?.arguments ?? "{}")).toEqual({ runId: "run_handoff_1" });

    const contextLightWakeDeltas = await collect(streamScriptedOpenPondChatTurn(inputFixture({
      model: "openpond-scripted-subagent-handoff",
      messages: [
        {
          role: "user",
          content: [
            "A research subagent sent a handoff handoff to this main chat.",
            "Child run: run_handoff_2",
            "Message:",
            "Scripted child handoff from the desktop harness.",
          ].join("\n"),
        },
      ],
      tools: [tool("openpond_subagent_start"), tool("openpond_subagent_join")],
    })));
    const contextLightJoinCall = onlyToolCall(contextLightWakeDeltas);
    expect(contextLightJoinCall.function?.name).toBe("openpond_subagent_join");
    expect(JSON.parse(contextLightJoinCall.function?.arguments ?? "{}")).toEqual({ runId: "run_handoff_2" });

    const contextLightSubmittedDeltas = await collect(streamScriptedOpenPondChatTurn(inputFixture({
      model: "openpond-scripted-subagent-handoff",
      messages: [
        {
          role: "user",
          content: [
            "A research subagent sent a handoff handoff to this main chat.",
            "Child run: run_handoff_2",
            "Message:",
            "Scripted child handoff from the desktop harness.",
          ].join("\n"),
        },
        toolResult("openpond_subagent_join", { runId: "run_handoff_2", status: "submitted_for_review" }),
      ],
      tools: [tool("openpond_subagent_start"), tool("openpond_subagent_join")],
    })));
    expect(textFromDeltas(contextLightSubmittedDeltas)).toBe("Research subagent lifecycle submitted for review for run_handoff_2.");
  });

  test("scripts child handoff messages through the native subagent message tool", async () => {
    const handoffDeltas = await collect(streamScriptedOpenPondChatTurn(inputFixture({
      model: "openpond-scripted-subagent-handoff",
      tools: [tool("openpond_subagent_send_message")],
    })));
    const handoffCall = onlyToolCall(handoffDeltas);
    expect(handoffCall.function?.name).toBe("openpond_subagent_send_message");
    expect(JSON.parse(handoffCall.function?.arguments ?? "{}")).toMatchObject({
      toRole: "parent",
      kind: "handoff",
      body: "Scripted child handoff from the desktop harness.",
    });

    const finalDeltas = await collect(streamScriptedOpenPondChatTurn(inputFixture({
      model: "openpond-scripted-subagent-handoff",
      messages: [
        { role: "user", content: "handoff" },
        toolResult("openpond_subagent_send_message", {
          messageId: "message_1",
          delivery: { status: "delivered", deliveredRunIds: [] },
        }),
      ],
      tools: [tool("openpond_subagent_send_message")],
    })));
    expect(textFromDeltas(finalDeltas)).toBe("Research subagent submitted after sending the scripted parent handoff.");
  });

  test("scripts watcher-submission parent wakes without starting duplicate children", async () => {
    const initialParentDeltas = await collect(streamScriptedOpenPondChatTurn(inputFixture({
      model: "openpond-scripted-subagent-watch-submission",
      messages: [
        { role: "user", content: "start a child for watcher review" },
        toolResult("openpond_subagent_start", { runId: "run_watch_1", status: "running" }),
      ],
      tools: [tool("openpond_subagent_start"), tool("openpond_subagent_join")],
    })));
    expect(textFromDeltas(initialParentDeltas)).toBe("Research subagent submitted for watcher review for run_watch_1.");
    expect(initialParentDeltas.at(-1)).toMatchObject({ type: "finish", finishReason: "stop" });

    const wakeDeltas = await collect(streamScriptedOpenPondChatTurn(inputFixture({
      model: "openpond-scripted-subagent-watch-submission",
      messages: [
        {
          role: "user",
          content: [
            "The subagent lifecycle watcher found required child work that needs main-agent attention.",
            "Wake reasons: required_submitted_for_review",
            "Review packets:",
            "Run run_watch_1 (research)",
          ].join("\n"),
        },
      ],
      tools: [tool("openpond_subagent_start"), tool("openpond_subagent_join")],
    })));
    expect(textFromDeltas(wakeDeltas)).toBe("Watcher lifecycle review wake received for run_watch_1.");
    expect(wakeDeltas.some((delta) => delta.type === "tool_call_delta")).toBe(false);

    const childDeltas = await collect(streamScriptedOpenPondChatTurn(inputFixture({
      model: "openpond-scripted-subagent-watch-submission",
      messages: [
        {
          role: "system",
          content: "You are an OpenPond research subagent running in an addressable child conversation.",
        },
        { role: "user", content: "submit watcher packet" },
      ],
      tools: [tool("openpond_subagent_send_message")],
    })));
    expect(textFromDeltas(childDeltas)).toBe("Research subagent submitted the scripted watcher review packet.");
  });

  test("scripts a parent review revision loop across lifecycle watcher wakes", async () => {
    const firstWakeDeltas = await collect(streamScriptedOpenPondChatTurn(inputFixture({
      model: "openpond-scripted-subagent-review-revision",
      messages: [
        {
          role: "user",
          content: [
            "The subagent lifecycle watcher found required child work that needs main-agent attention.",
            "Wake reasons: required_submitted_for_review",
            "Review packets:",
            "Run run_revision_1 (research)",
            "Status: submitted_for_review",
          ].join("\n"),
        },
      ],
      tools: [tool("openpond_subagent_start"), tool("openpond_subagent_review")],
    })));
    const revisionCall = onlyToolCall(firstWakeDeltas);
    expect(revisionCall.function?.name).toBe("openpond_subagent_review");
    expect(JSON.parse(revisionCall.function?.arguments ?? "{}")).toMatchObject({
      runId: "run_revision_1",
      decision: "needs_revision",
      requiredCorrections: ["Add the focused unchanged-insight regression proof and submit a revised packet."],
    });

    const revisionTextDeltas = await collect(streamScriptedOpenPondChatTurn(inputFixture({
      model: "openpond-scripted-subagent-review-revision",
      messages: [
        {
          role: "user",
          content: [
            "The subagent lifecycle watcher found required child work that needs main-agent attention.",
            "Run run_revision_1 (research)",
            "Status: submitted_for_review",
          ].join("\n"),
        },
        toolResult("openpond_subagent_review", { runId: "run_revision_1", status: "needs_revision" }),
        { role: "assistant", content: "Parent requested child revision for run_revision_1." },
      ],
      tools: [tool("openpond_subagent_start"), tool("openpond_subagent_review")],
    })));
    expect(textFromDeltas(revisionTextDeltas)).toBe("Parent requested child revision for run_revision_1.");

    const secondWakeDeltas = await collect(streamScriptedOpenPondChatTurn(inputFixture({
      model: "openpond-scripted-subagent-review-revision",
      messages: [
        {
          role: "user",
          content: [
            "The subagent lifecycle watcher found required child work that needs main-agent attention.",
            "Run run_revision_1 (research)",
            "Status: submitted_for_review",
          ].join("\n"),
        },
        toolResult("openpond_subagent_review", { runId: "run_revision_1", status: "needs_revision" }),
        {
          role: "user",
          content: [
            "The subagent lifecycle watcher found required child work that needs main-agent attention.",
            "Wake reasons: required_submitted_for_review",
            "Review packets:",
            "Run run_revision_1 (research)",
            "Status: submitted_for_review",
          ].join("\n"),
        },
      ],
      tools: [tool("openpond_subagent_start"), tool("openpond_subagent_review")],
    })));
    const acceptCall = onlyToolCall(secondWakeDeltas);
    expect(acceptCall.function?.name).toBe("openpond_subagent_review");
    expect(JSON.parse(acceptCall.function?.arguments ?? "{}")).toMatchObject({
      runId: "run_revision_1",
      decision: "accept",
    });

    const sparseRevisedWakeDeltas = await collect(streamScriptedOpenPondChatTurn(inputFixture({
      model: "openpond-scripted-subagent-review-revision",
      messages: [
        {
          role: "user",
          content: [
            "The subagent lifecycle watcher found required child work that needs main-agent attention.",
            "Wake reasons: required_submitted_for_review",
            "Review packets:",
            "Run run_revision_1 (research)",
            "Status: submitted_for_review",
            "Final report:",
            "  Summary: Research subagent submitted the revised review packet with the requested regression proof.",
          ].join("\n"),
        },
      ],
      tools: [tool("openpond_subagent_start"), tool("openpond_subagent_review")],
    })));
    const sparseAcceptCall = onlyToolCall(sparseRevisedWakeDeltas);
    expect(sparseAcceptCall.function?.name).toBe("openpond_subagent_review");
    expect(JSON.parse(sparseAcceptCall.function?.arguments ?? "{}")).toMatchObject({
      runId: "run_revision_1",
      decision: "accept",
    });

    const acceptedWakeDeltas = await collect(streamScriptedOpenPondChatTurn(inputFixture({
      model: "openpond-scripted-subagent-review-revision",
      messages: [
        toolResult("openpond_subagent_review", { runId: "run_revision_1", status: "needs_revision" }),
        toolResult("openpond_subagent_review", { runId: "run_revision_1", status: "accepted" }),
        {
          role: "user",
          content: [
            "The subagent lifecycle watcher found required child work that needs main-agent attention.",
            "Wake reasons: required_all_accepted",
            "Review packets:",
            "Run run_revision_1 (research)",
            "Status: accepted",
          ].join("\n"),
        },
      ],
      tools: [tool("openpond_subagent_start"), tool("openpond_subagent_review")],
    })));
    expect(acceptedWakeDeltas.some((delta) => delta.type === "tool_call_delta")).toBe(false);
    expect(textFromDeltas(acceptedWakeDeltas)).toBe("Parent noted lifecycle status accepted for run_revision_1.");

    const revisedChildDeltas = await collect(streamScriptedOpenPondChatTurn(inputFixture({
      model: "openpond-scripted-subagent-review-revision",
      messages: [
        {
          role: "system",
          content: "You are an OpenPond research subagent running in an addressable child conversation.",
        },
        {
          role: "user",
          content: "Review decision: needs_revision\n\nRequired corrections:\n- Add the focused unchanged-insight regression proof.",
        },
      ],
      tools: [tool("openpond_subagent_send_message")],
    })));
    expect(textFromDeltas(revisedChildDeltas)).toBe(
      "Research subagent submitted the revised review packet with the requested regression proof.",
    );
  });

  test("scripts lifecycle watcher wakes for other subagent models without starting duplicate children", async () => {
    const wakeDeltas = await collect(streamScriptedOpenPondChatTurn(inputFixture({
      model: "openpond-scripted-goal-subagent-running",
      messages: [
        {
          role: "user",
          content: [
            "The subagent lifecycle watcher found required child work that needs main-agent attention.",
            "Parent session: session_goal",
            "Goal: goal_scripted",
            "Wake reasons:",
            "required_submitted_for_review",
            "Review packets:",
            "Run run_goal_1 (research)",
            "Status: submitted_for_review",
          ].join("\n"),
        },
      ],
      tools: [tool("openpond_subagent_start"), tool("openpond_subagent_join")],
    })));

    expect(wakeDeltas.some((delta) =>
      delta.type === "tool_call_delta" &&
      delta.toolCalls.some((call) => call.function?.name === "openpond_subagent_start")
    )).toBe(false);
    expect(textFromDeltas(wakeDeltas)).toBe("Watcher lifecycle review wake received for run_goal_1.");
  });

  test("treats subagent system-context turns as child turns even when parent-only tools are listed", async () => {
    const deltas = await collect(streamScriptedOpenPondChatTurn(inputFixture({
      model: "openpond-scripted-subagent-lifecycle",
      messages: [
        {
          role: "system",
          content: [
            "You are an OpenPond research subagent running in an addressable child conversation.",
            "Work only on the assignment below. Do not start additional subagents.",
          ].join("\n"),
        },
        { role: "user", content: "Inspect the scripted desktop harness lifecycle." },
      ],
      tools: [
        tool("openpond_subagent_start"),
        tool("openpond_subagent_join"),
        tool("openpond_subagent_send_message"),
      ],
    })));

    expect(deltas.some((delta) =>
      delta.type === "tool_call_delta" && delta.toolCalls.some((call) => call.function?.name === "openpond_subagent_start")
    )).toBe(false);
    expect(textFromDeltas(deltas)).toBe("Research subagent submitted the scripted lifecycle check.");
  });

  test("scripts parent cancellation through the native cancel tool", async () => {
    const cancelDeltas = await collect(streamScriptedOpenPondChatTurn(inputFixture({
      model: "openpond-scripted-subagent-cancel",
      messages: [
        { role: "user", content: "cancel child" },
        toolResult("openpond_subagent_start", { runId: "run_cancel_1", status: "running" }),
      ],
      tools: [tool("openpond_subagent_start"), tool("openpond_subagent_cancel")],
    })));
    const cancelCall = onlyToolCall(cancelDeltas);
    expect(cancelCall.function?.name).toBe("openpond_subagent_cancel");
    expect(JSON.parse(cancelCall.function?.arguments ?? "{}")).toMatchObject({
      runId: "run_cancel_1",
      cleanupWorkspace: true,
    });

    const finalDeltas = await collect(streamScriptedOpenPondChatTurn(inputFixture({
      model: "openpond-scripted-subagent-cancel",
      messages: [
        { role: "user", content: "cancel child" },
        toolResult("openpond_subagent_start", { runId: "run_cancel_1", status: "running" }),
        toolResult("openpond_subagent_cancel", { runId: "run_cancel_1", status: "cancelled" }),
      ],
      tools: [tool("openpond_subagent_start"), tool("openpond_subagent_cancel")],
    })));
    expect(textFromDeltas(finalDeltas)).toBe("Research subagent cancellation finished with cancelled status for run_cancel_1.");
  });

  test("server routes scripted OpenPond turns through the real turn runner", async () => {
    const storeDir = await mkdtemp(join(tmpdir(), "openpond-scripted-provider-"));
    const priorEnv = process.env[OPENPOND_HARNESS_SCRIPTED_MODELS_ENV];
    process.env[OPENPOND_HARNESS_SCRIPTED_MODELS_ENV] = "1";
    const server = await createOpenPondServer({
      port: 0,
      storeDir,
      silent: true,
      version: "scripted-openpond-provider-test",
    });
    const modelRef = { providerId: "openpond" as const, modelId: "openpond-scripted-chat-two-turns" };

    try {
      const session = await api<Session>(server.url, server.token, "/v1/sessions", {
        method: "POST",
        body: JSON.stringify({
          provider: "openpond",
          modelRef,
          cwd: process.cwd(),
          title: "scripted provider test",
        }),
      });
      const turn = await api<Turn>(server.url, server.token, `/v1/sessions/${encodeURIComponent(session.id)}/turns`, {
        method: "POST",
        body: JSON.stringify({
          prompt: "hello harness",
          modelRef,
        }),
      });
      const bootstrap = await api<BootstrapPayload>(server.url, server.token, "/v1/bootstrap?ensureProfile=0");
      const assistantText = bootstrap.events
        .filter((event) => event.sessionId === session.id && event.turnId === turn.id && event.name === "assistant.delta")
        .map((event) => event.output ?? "")
        .join("");

      expect(turn.status).toBe("completed");
      expect(turn.modelRef).toEqual(modelRef);
      expect(assistantText).toBe("scripted turn 1 response for: hello harness");
      expect(bootstrap.events.some((event) =>
        event.sessionId === session.id &&
        event.turnId === turn.id &&
        event.name === "turn.completed" &&
        event.status === "completed"
      )).toBe(true);
    } finally {
      await server.close();
      await rm(storeDir, { recursive: true, force: true });
      if (priorEnv === undefined) {
        delete process.env[OPENPOND_HARNESS_SCRIPTED_MODELS_ENV];
      } else {
        process.env[OPENPOND_HARNESS_SCRIPTED_MODELS_ENV] = priorEnv;
      }
    }
  }, 15_000);

  test("server routes scripted subagent lifecycle through native tools and child submission", async () => {
    const storeDir = await mkdtemp(join(tmpdir(), "openpond-scripted-subagent-provider-"));
    const priorEnv = process.env[OPENPOND_HARNESS_SCRIPTED_MODELS_ENV];
    process.env[OPENPOND_HARNESS_SCRIPTED_MODELS_ENV] = "1";
    const server = await createOpenPondServer({
      port: 0,
      storeDir,
      silent: true,
      version: "scripted-openpond-subagent-provider-test",
    });
    const modelRef = { providerId: "openpond" as const, modelId: "openpond-scripted-subagent-lifecycle" };

    try {
      const session = await api<Session>(server.url, server.token, "/v1/sessions", {
        method: "POST",
        body: JSON.stringify({
          provider: "openpond",
          modelRef,
          cwd: process.cwd(),
          title: "scripted subagent provider test",
        }),
      });
      const turn = await api<Turn>(server.url, server.token, `/v1/sessions/${encodeURIComponent(session.id)}/turns`, {
        method: "POST",
        body: JSON.stringify({
          prompt: "start the scripted research subagent",
          modelRef,
        }),
      });
      const bootstrap = await waitForBootstrap(server.url, server.token, (candidate) =>
        candidate.events.some((event) => event.sessionId === session.id && event.name === "subagent.submitted"),
      );
      const sessionEvents = bootstrap.events.filter((event) => event.sessionId === session.id);
      const startEvent = sessionEvents.find((event) =>
        event.name === "tool.completed" && event.action === "openpond_subagent_start"
      );
      const joinEvent = sessionEvents.find((event) =>
        event.name === "tool.completed" && event.action === "openpond_subagent_join"
      );
      const submittedEvent = sessionEvents.find((event) => event.name === "subagent.submitted");
      const run = submittedEvent?.data && typeof submittedEvent.data === "object" && !Array.isArray(submittedEvent.data)
        ? (submittedEvent.data as { run?: { childSessionId?: string; status?: string; modelRef?: unknown; review?: { status?: string } } }).run
        : null;

      expect(turn.status).toBe("completed");
      expect(startEvent).toBeTruthy();
      expect(joinEvent).toBeTruthy();
      expect(run?.status).toBe("submitted_for_review");
      expect(run?.review?.status).toBe("submitted_for_review");
      expect(run?.modelRef).toEqual(modelRef);
      expect(bootstrap.sessions.some((item) =>
        item.id === run?.childSessionId &&
        item.parentSessionId === session.id &&
        item.hiddenFromDefaultSidebar === true
      )).toBe(true);
    } finally {
      await server.close();
      await rm(storeDir, { recursive: true, force: true });
      if (priorEnv === undefined) {
        delete process.env[OPENPOND_HARNESS_SCRIPTED_MODELS_ENV];
      } else {
        process.env[OPENPOND_HARNESS_SCRIPTED_MODELS_ENV] = priorEnv;
      }
    }
  }, 20_000);
});

function inputFixture(overrides: Partial<HostedChatTurnInput> = {}): HostedChatTurnInput {
  return {
    model: "openpond-scripted-chat-two-turns",
    messages: [{ role: "user", content: "hello" }],
    ...overrides,
  };
}

function tool(name: string): HostedChatTool {
  return {
    type: "function",
    function: {
      name,
      parameters: { type: "object", properties: {} },
    },
  };
}

function toolResult(action: string, data: Record<string, unknown>) {
  return {
    role: "tool" as const,
    tool_call_id: `call_${action}`,
    content: JSON.stringify({
      ok: true,
      action,
      output: `${action} completed.`,
      data,
    }),
  };
}

async function collect(stream: AsyncGenerator<HostedChatTurnDelta, void, unknown>): Promise<HostedChatTurnDelta[]> {
  const deltas: HostedChatTurnDelta[] = [];
  for await (const delta of stream) deltas.push(delta);
  return deltas;
}

function textFromDeltas(deltas: HostedChatTurnDelta[]): string {
  return deltas
    .filter((delta): delta is Extract<HostedChatTurnDelta, { type: "text_delta" }> => delta.type === "text_delta")
    .map((delta) => delta.text)
    .join("");
}

function onlyToolCall(deltas: HostedChatTurnDelta[]) {
  const toolDeltas = deltas.filter((delta): delta is Extract<HostedChatTurnDelta, { type: "tool_call_delta" }> =>
    delta.type === "tool_call_delta"
  );
  expect(toolDeltas).toHaveLength(1);
  expect(toolDeltas[0]?.toolCalls).toHaveLength(1);
  return toolDeltas[0]!.toolCalls[0]!;
}

async function api<T>(
  serverUrl: string,
  token: string,
  route: string,
  init: RequestInit = {},
): Promise<T> {
  const headers = new Headers(init.headers);
  headers.set("Authorization", `Bearer ${token}`);
  if (init.body && !headers.has("Content-Type")) headers.set("Content-Type", "application/json");
  const response = await fetch(`${serverUrl}${route}`, { ...init, headers });
  if (!response.ok) throw new Error(`${route} failed: ${response.status} ${await response.text()}`);
  return await response.json() as T;
}

async function waitForBootstrap(
  serverUrl: string,
  token: string,
  predicate: (bootstrap: BootstrapPayload) => boolean,
  timeoutMs = 10_000,
): Promise<BootstrapPayload> {
  const started = Date.now();
  let last: BootstrapPayload | null = null;
  while (Date.now() - started < timeoutMs) {
    last = await api<BootstrapPayload>(serverUrl, token, "/v1/bootstrap?ensureProfile=0");
    if (predicate(last)) return last;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Timed out waiting for bootstrap predicate. Last events: ${last?.events.map((event) => event.name).join(", ") ?? "none"}`);
}
