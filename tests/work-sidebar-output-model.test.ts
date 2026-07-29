import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, test } from "vitest";
import type {
  AgentPackageOutputRef,
  FileOutputRef,
  OutputRef,
  RuntimeEvent,
} from "@openpond/contracts";
import {
  WorkSidebarPanel,
  visibleWorkActivities,
  workOutputsFromEvents,
} from "../apps/web/src/components/app-shell/WorkSidebarPanel";
import type { ChatMessage } from "../apps/web/src/lib/app-models";

describe("Work sidebar output model", () => {
  test("keeps revisions and removes explicitly deleted outputs", () => {
    const first = outputRef("output_1", 1, "2026-07-28T10:00:00.000Z");
    const second = outputRef("output_1", 2, "2026-07-28T11:00:00.000Z");
    const events = [
      outputEvent("event_1", "sandbox_save_output", first),
      outputEvent("event_2", "sandbox_save_output", second),
      outputEvent("event_3", "work_output_read", second),
      outputEvent("event_4", "work_output_delete", first),
    ];

    expect(workOutputsFromEvents(events)).toEqual([second]);
  });

  test("keeps model reasoning out of the Activity sidebar", () => {
    const messages = [
      {
        id: "activity_group_1",
        role: "activity_group",
        content: "",
        activities: [
          {
            id: "reasoning_1",
            label: "Reasoning",
            content: "Internal model narration.",
            timestamp: "2026-07-28T10:00:00.000Z",
            kind: "reasoning",
          },
          {
            id: "tool_1",
            label: "Wrote sandbox file",
            content: "work-sandbox-ready.md",
            timestamp: "2026-07-28T10:00:01.000Z",
            kind: "file",
          },
        ],
      },
    ] as ChatMessage[];

    expect(visibleWorkActivities(messages)).toMatchObject([
      {
        id: "tool_1",
        label: "Wrote sandbox file",
      },
    ]);
  });

  test("presents reviewed Agent packages as Agents instead of generic files", () => {
    const output = agentPackageOutputRef();
    const markup = renderToStaticMarkup(
      createElement(WorkSidebarPanel, {
        chatMessages: [],
        connection: null,
        contextWindowStatus: {
          summary: "Context available",
          tokensLabel: "0 tokens",
          usedTokens: 0,
          maxTokens: 128_000,
          percent: 0,
          detail: null,
          tooltip: "Context window: 0% full",
          tone: "low",
        },
        expanded: false,
        runtimeEvents: [
          outputEvent("event_agent", "sandbox_save_agent_package", output),
        ],
        sessionId: "session_work",
        showToast: () => undefined,
        onResizeStart: () => undefined,
        onToggleExpanded: () => undefined,
        onUseOutput: () => undefined,
        onHandoffOutput: async () => undefined,
        onReviseOutput: () => undefined,
      })
    );

    expect(markup).toContain("Phase Five Greeter");
    expect(markup).toContain("1 action");
    expect(markup).toContain("Add to Agents");
    expect(markup).not.toContain("Preview");
  });
});

function outputRef(
  id: string,
  revision: number,
  createdAt: string
): FileOutputRef {
  return {
    kind: "file",
    id,
    title: "report.md",
    contentType: "text/markdown",
    sizeBytes: 8,
    sha256: "a".repeat(64),
    sourceTaskId: "session_work",
    sourceTurnId: `turn_${revision}`,
    revision,
    createdAt,
    location: {
      kind: "local",
      path: `/tmp/${id}-report.md`,
      deviceId: "device_1",
    },
    validation: [],
  };
}

function outputEvent(
  id: string,
  action: RuntimeEvent["action"],
  outputRef: OutputRef
): RuntimeEvent {
  return {
    id,
    sessionId: "session_work",
    turnId: "turn_1",
    name: "workspace_action_result",
    timestamp: outputRef.createdAt,
    source: "ui_button",
    action,
    status: "completed",
    data: { outputRef },
  };
}

function agentPackageOutputRef(): AgentPackageOutputRef {
  return {
    kind: "agent_package",
    id: "agent_output_1",
    title: "Phase Five Greeter",
    sourceTaskId: "session_work",
    sourceTurnId: "turn_agent",
    revision: 1,
    createdAt: "2026-07-28T12:00:00.000Z",
    agentId: "phase-five-greeter",
    versionId: `agent-${"b".repeat(20)}`,
    digest: "b".repeat(64),
    packageFileId: "agent-package:file",
    manifestFileId: "agent-package:manifest",
    actions: [
      {
        id: "greet",
        label: "Greet",
        description: "Return a concise greeting.",
        inputSchema: { type: "object" },
        outputSchema: { type: "object" },
        schedulePolicy: null,
      },
    ],
    runtimeRequirements: {
      base: "node-bun-workspace",
      resources: {},
      modelPolicy: null,
      setup: null,
    },
    validationReceiptIds: ["validation_1"],
    evalReceiptIds: ["eval_1"],
    sourceFileCount: 4,
    sourceSizeBytes: 1_024,
    location: {
      kind: "local",
      path: "/tmp/phase-five-greeter.agent-package.json",
      deviceId: "device_1",
    },
    validation: [
      {
        kind: "test",
        status: "passed",
        label: "Agent SDK validation passed",
      },
    ],
  };
}
